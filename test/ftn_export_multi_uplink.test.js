'use strict';

//
//  EchoMail export to an area carrying more than one uplink — issue #746.
//
//  exportEchoMailMessagesToUplinks loops the area's uplinks and hands the
//  SAME message UUIDs to exportMessagesByUuid once per uplink. That function
//  records two pieces of meta per message as it goes: a System/state_flags0
//  of Exported, and the FtnKludge/MSGID it either generated or read back.
//
//  message_meta is UNIQUE across (message_id, category, name, value), so on
//  the second uplink both writes are the tuple the first uplink already
//  wrote. A plain INSERT raises SQLITE_CONSTRAINT there, which aborted that
//  uplink's export on its very first message — and the failure was logged as
//  a bare, unattributed message and then reported as success, so the caller
//  advanced the area's last scan ID and the mail was never offered again.
//
//  The result on stock configuration: the first uplink in the array got the
//  mail and every uplink after it silently got nothing.
//

const { strict: assert } = require('assert');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const configModule = require('../core/config.js');
const loggerModule = require('../core/logger.js');

// ─── schema ──────────────────────────────────────────────────────────────────

//  Only what the export path touches; see test/message_db.test.js, which
//  carries the same subset for the same reason.
function applySchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS message (
            message_id              INTEGER PRIMARY KEY,
            area_tag                VARCHAR NOT NULL,
            message_uuid            VARCHAR(36) NOT NULL,
            reply_to_message_id     INTEGER,
            to_user_name            VARCHAR NOT NULL,
            from_user_name          VARCHAR NOT NULL,
            subject,
            message,
            modified_timestamp      DATETIME NOT NULL,
            view_count              INTEGER NOT NULL DEFAULT 0,
            UNIQUE(message_uuid)
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts4 (
            content="message",
            subject,
            message
        );

        CREATE TRIGGER IF NOT EXISTS message_after_insert AFTER INSERT ON message BEGIN
            INSERT INTO message_fts(docid, subject, message) VALUES(new.rowid, new.subject, new.message);
        END;

        CREATE TABLE IF NOT EXISTS message_meta (
            message_id      INTEGER NOT NULL,
            meta_category   INTEGER NOT NULL,
            meta_name       VARCHAR NOT NULL,
            meta_value      VARCHAR NOT NULL,
            UNIQUE(message_id, meta_category, meta_name, meta_value),
            FOREIGN KEY(message_id) REFERENCES message(message_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS message_area_last_scan (
            scan_toss       VARCHAR NOT NULL,
            area_tag        VARCHAR NOT NULL,
            message_id      INTEGER NOT NULL,
            UNIQUE(scan_toss, area_tag)
        );
    `);
}

describe('ftn_bso — EchoMail export to multiple uplinks (issue #746)', function () {
    this.timeout(10000);

    const UPLINKS = ['1:218/701', '1:218/702', '1:218/703'];
    const AREA = { network: 'testnet', tag: 'TEST', uplinks: UPLINKS };

    let tmpDir;
    let testDb;
    let prevConfig;
    let prevMessageDb;
    let Message;
    let getModule;
    let warnings;
    let prevLog;

    function makeConfig(root) {
        return {
            debug: { assertsEnabled: false },
            menus: { cls: false },
            general: { boardName: 'Test BBS' },
            scannerTossers: {
                ftn_bso: {
                    paths: {
                        outbound: path.join(root, 'outbound'),
                        inbound: path.join(root, 'ftn_in'),
                        secInbound: path.join(root, 'ftn_secin'),
                    },
                    packetTargetByteSize: 256000,
                    nodes: Object.fromEntries(
                        UPLINKS.map(u => [u, { packetType: '2+' }])
                    ),
                },
            },
            messageNetworks: {
                ftn: {
                    networks: { testnet: { localAddress: '1:218/700', defaultZone: 1 } },
                    areas: { test_area: AREA },
                },
            },
        };
    }

    before(async () => {
        tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'enigma_ftnexp_'));
        for (const d of ['outbound', 'ftn_in', 'ftn_secin', 'temp']) {
            await fsp.mkdir(path.join(tmpDir, d), { recursive: true });
        }

        prevConfig = configModule._pushTestConfig(makeConfig(tmpDir));

        //  message.js captures dbs.message at load, and ftn_bso.js captures
        //  the Message class at load — so the database has to be in place
        //  before either is (re)loaded, and they have to be reloaded in that
        //  order or the module under test builds messages bound to a
        //  different database than the one asserted against here.
        const dbModule = require('../core/database.js');
        prevMessageDb = dbModule.dbs.message;
        testDb = new Database(':memory:');
        testDb.pragma('foreign_keys = ON');
        applySchema(testDb);
        dbModule.dbs.message = testDb;

        //  ftn_bso captures logger.js's |log| at load too, so the collector
        //  has to be in place before the require below or nothing lands in it
        //  and every assertion about what was logged passes vacuously.
        warnings = [];
        prevLog = loggerModule.log;
        loggerModule.log = Object.assign({}, prevLog, {
            warn: (...a) => warnings.push(a),
            error: (...a) => warnings.push(a),
        });

        delete require.cache[require.resolve('../core/message.js')];
        delete require.cache[require.resolve('../core/scanner_tossers/ftn_bso.js')];
        Message = require('../core/message.js');
        ({ getModule } = require('../core/scanner_tossers/ftn_bso.js'));
    });

    after(async () => {
        configModule._popTestConfig(prevConfig);
        loggerModule.log = prevLog;
        //  Put the module cache and the database back the way they were: the
        //  copies loaded above are bound to an in-memory database that is
        //  about to go away.
        delete require.cache[require.resolve('../core/message.js')];
        delete require.cache[require.resolve('../core/scanner_tossers/ftn_bso.js')];
        require('../core/database.js').dbs.message = prevMessageDb;
        if (testDb) {
            testDb.close();
        }
        await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    function makeModule(root) {
        const mod = new getModule();
        //  ftn_bso reads these through moduleConfig rather than Config(), and
        //  the module freezes Config() at first require anyway.
        mod.moduleConfig = makeConfig(root).scannerTossers.ftn_bso;
        mod.exportTempDir = path.join(root, 'temp');
        return mod;
    }

    //  Flow files are named for their destination, so the set of them is the
    //  set of uplinks that actually got mail.
    async function flowFilesIn(root) {
        const dir = path.join(root, 'outbound', 'outbound');
        const entries = await fsp.readdir(dir).catch(() => []);
        return entries.filter(e => e.endsWith('.clo')).sort();
    }

    function flowFileNameFor(address) {
        const [, net, node] = /^\d+:(\d+)\/(\d+)$/.exec(address);
        return (
            Number(net).toString(16).padStart(4, '0') +
            Number(node).toString(16).padStart(4, '0') +
            '.clo'
        );
    }

    it('delivers to every uplink, not just the first', async () => {
        const root = path.join(tmpDir, 'multi');
        await fsp.mkdir(path.join(root, 'temp'), { recursive: true });

        const message = new Message({
            areaTag: 'test_area',
            toUserName: 'All',
            fromUserName: 'Tester',
            subject: 'multi-uplink',
            message: 'body',
        });
        await new Promise((resolve, reject) =>
            message.persist(err => (err ? reject(err) : resolve()))
        );

        const mod = makeModule(root);
        const err = await new Promise(resolve =>
            mod.exportEchoMailMessagesToUplinks([message.messageUuid], AREA, resolve)
        );

        assert.equal(err, null, err && err.message);
        assert.deepEqual(
            await flowFilesIn(root),
            UPLINKS.map(flowFileNameFor).sort(),
            'every uplink should have been given the message'
        );
        assert.deepEqual(warnings, [], 'nothing should have been logged as a problem');
    });

    it('records the exported state and MSGID exactly once', async () => {
        const root = path.join(tmpDir, 'meta');
        await fsp.mkdir(path.join(root, 'temp'), { recursive: true });

        const message = new Message({
            areaTag: 'test_area',
            toUserName: 'All',
            fromUserName: 'Tester',
            subject: 'meta once',
            message: 'body',
        });
        await new Promise((resolve, reject) =>
            message.persist(err => (err ? reject(err) : resolve()))
        );

        const mod = makeModule(root);
        await new Promise(resolve =>
            mod.exportEchoMailMessagesToUplinks([message.messageUuid], AREA, resolve)
        );

        //  Three uplinks, one row each: the writes are per-uplink but the
        //  facts they record are about the message.
        const rows = testDb
            .prepare(
                `SELECT meta_category, meta_name, COUNT(*) AS n
                 FROM message_meta WHERE message_id = ?
                 GROUP BY meta_category, meta_name
                 ORDER BY meta_name`
            )
            .all(message.messageId);

        assert.deepEqual(rows, [
            { meta_category: 'FtnKludge', meta_name: 'MSGID', n: 1 },
            { meta_category: 'System', meta_name: 'state_flags0', n: 1 },
        ]);
    });

    it('packetises for one uplink at a time', async () => {
        //  An outgoing packet's name is a hash of the current millisecond and
        //  the message ID, with nothing in it about the destination, and every
        //  uplink of an area packetises the same messages through the same
        //  temp directory into the same outbound directory. Overlap two
        //  uplinks and they can choose the same name, and one quietly takes
        //  the other's mail with it.
        //
        //  Asserted as non-overlap rather than by racing for a collision:
        //  the window is a single millisecond, so a timing-based test would
        //  only fail some of the time -- which is exactly how this got past
        //  the first version of the suite.
        const root = path.join(tmpDir, 'serial');
        await fsp.mkdir(path.join(root, 'temp'), { recursive: true });

        const mod = makeModule(root);
        let inFlight = 0;
        const overlaps = [];
        mod.exportMessagesByUuid = (uuids, exportOpts, cb) => {
            if (inFlight > 0) {
                overlaps.push(exportOpts.destAddress.node);
            }
            ++inFlight;
            //  Yield, so an overlapping caller would be let in here.
            setImmediate(() => {
                const p = path.join(root, 'temp', `u_${exportOpts.destAddress.node}.pkt`);
                fsp.writeFile(p, 'PKT')
                    .then(() => {
                        --inFlight;
                        cb(null, [p]);
                    })
                    .catch(err => {
                        --inFlight;
                        cb(err);
                    });
            });
        };

        const err = await new Promise(resolve =>
            mod.exportEchoMailMessagesToUplinks(['uuid-1'], AREA, resolve)
        );

        assert.equal(err, null, err && err.message);
        assert.deepEqual(overlaps, [], 'uplink exports must not overlap');
        assert.deepEqual(
            await flowFilesIn(root),
            UPLINKS.map(flowFileNameFor).sort(),
            'and every uplink should still get its mail'
        );
    });

    it('reports a failed uplink instead of passing it off as success', async () => {
        //  Any failure, not just the constraint one: reporting success here
        //  is what lets performEchoMailExport advance the area's last scan ID
        //  past mail that was never written.
        const root = path.join(tmpDir, 'failing');
        await fsp.mkdir(path.join(root, 'temp'), { recursive: true });

        const mod = makeModule(root);
        const attempted = [];
        mod.exportMessagesByUuid = (uuids, exportOpts, cb) => {
            attempted.push(exportOpts.destAddress.node);
            if (702 === exportOpts.destAddress.node) {
                return cb(new Error('disk on fire'));
            }
            const p = path.join(root, 'temp', `ok_${exportOpts.destAddress.node}.pkt`);
            return fsp
                .writeFile(p, 'PKT')
                .then(() => cb(null, [p]))
                .catch(cb);
        };

        warnings.length = 0;
        const err = await new Promise(resolve =>
            mod.exportEchoMailMessagesToUplinks(['uuid-1'], AREA, resolve)
        );

        assert.ok(err, 'a failed uplink must not be reported as success');
        assert.match(err.message, /1:218\/702/, 'and must say which uplink');
        assert.deepEqual(
            attempted.sort(),
            [701, 702, 703],
            'the other uplinks still get their turn'
        );

        const logged = warnings.map(a => JSON.stringify(a)).join(' ');
        assert.match(logged, /1:218\/702/, 'the log should name the uplink');
        assert.match(logged, /TEST/, 'and the area');
    });
});
