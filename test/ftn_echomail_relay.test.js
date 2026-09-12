'use strict';

//
//  EchoMail relay to secondary uplinks -- issue #748.
//
//  performEchoMailExport() selects only messages with no System/state_flags0
//  row, and import always writes one. So a second uplink on an area -- a
//  downstream point, or a sub-hub -- only ever saw messages composed by a user
//  at a terminal on this system, never the echomail that flowed in from the
//  area's own source.
//
//  performEchoMailRelayExport() is the second pass that closes that. What is
//  worth testing is not that it moves bytes -- exportEchoMailMessagesToUplinks
//  is covered by ftn_export_multi_uplink.test.js -- but the three decisions
//  around it:
//
//    * where it starts from on an area it has never scanned (not the beginning
//      of time);
//    * which uplinks a given message is offered to;
//    * whether the watermark advances when an uplink fails.
//

const { strict: assert } = require('assert');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const configModule = require('../core/config.js');
const loggerModule = require('../core/logger.js');

// ─── schema ──────────────────────────────────────────────────────────────────

//  Only what the relay path touches; see ftn_export_multi_uplink.test.js,
//  which carries the same subset for the same reason.
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

describe('ftn_bso — EchoMail relay to secondary uplinks (issue #748)', function () {
    this.timeout(15000);

    const LOCAL = '1:218/700';
    const HUB = '1:218/701'; //  where our mail comes from
    const PEER = '1:218/702'; //  a genuine second peer
    const POINT = '1:218/700.1'; //  our own point -- same net/node as LOCAL

    let tmpDir;
    let testDb;
    let prevConfig;
    let prevMessageDb;
    let Message;
    let getModule;
    let logged;
    let prevLog;

    function makeConfig(root, areas) {
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
                        [HUB, PEER, POINT].map(u => [u, { packetType: '2+' }])
                    ),
                },
            },
            messageNetworks: {
                ftn: {
                    networks: {
                        testnet: { localAddress: LOCAL, defaultZone: 1 },
                    },
                    areas,
                },
            },
        };
    }

    //  Relay is opt-in; an area without `relay: true` is skipped entirely.
    const RELAY_AREA = {
        network: 'testnet',
        tag: 'TEST',
        uplinks: [HUB, PEER, POINT],
        relay: true,
    };
    const QUIET_AREA = {
        network: 'testnet',
        tag: 'QUIET',
        uplinks: [HUB, PEER],
    };
    //  Relay-enabled but with no point among its uplinks, so a message every
    //  uplink has seen really does leave nothing to send. RELAY_AREA cannot
    //  express that: its point is relayed to unconditionally, by design.
    const PEERS_AREA = {
        network: 'testnet',
        tag: 'PEERS',
        uplinks: [HUB, PEER],
        relay: true,
    };

    before(async () => {
        tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'enigma_ftnrelay_'));
        for (const d of ['outbound', 'ftn_in', 'ftn_secin', 'temp']) {
            await fsp.mkdir(path.join(tmpDir, d), { recursive: true });
        }

        prevConfig = configModule._pushTestConfig(
            makeConfig(tmpDir, {
                relay_area: RELAY_AREA,
                quiet_area: QUIET_AREA,
                peers_area: PEERS_AREA,
            })
        );

        //  Same load-order dance as ftn_export_multi_uplink.test.js: message.js
        //  captures dbs.message at load and ftn_bso.js captures the Message
        //  class at load, so the database has to be in place before either is
        //  reloaded, and in that order.
        const dbModule = require('../core/database.js');
        prevMessageDb = dbModule.dbs.message;
        testDb = new Database(':memory:');
        testDb.pragma('foreign_keys = ON');
        applySchema(testDb);
        dbModule.dbs.message = testDb;

        //  Object.assign copies own enumerable properties, and bunyan's
        //  methods live on the prototype -- so the stub has to supply every
        //  level the code under test calls, not just the ones asserted on.
        logged = [];
        prevLog = loggerModule.log;
        loggerModule.log = Object.assign({}, prevLog, {
            trace: () => {},
            debug: () => {},
            info: () => {},
            warn: (...a) => logged.push(a),
            error: (...a) => logged.push(a),
            child: () => loggerModule.log,
        });

        delete require.cache[require.resolve('../core/message.js')];
        delete require.cache[require.resolve('../core/scanner_tossers/ftn_bso.js')];
        Message = require('../core/message.js');
        ({ getModule } = require('../core/scanner_tossers/ftn_bso.js'));
    });

    after(async () => {
        configModule._popTestConfig(prevConfig);
        loggerModule.log = prevLog;
        delete require.cache[require.resolve('../core/message.js')];
        delete require.cache[require.resolve('../core/scanner_tossers/ftn_bso.js')];
        require('../core/database.js').dbs.message = prevMessageDb;
        if (testDb) {
            testDb.close();
        }
        await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    beforeEach(() => {
        logged.length = 0;
        testDb.exec('DELETE FROM message_area_last_scan;');
        testDb.exec('DELETE FROM message_meta;');
        testDb.exec('DELETE FROM message;');
        testDb.exec('DELETE FROM message_fts;');
    });

    function makeModule(root) {
        const mod = new getModule();
        mod.moduleConfig = makeConfig(root, {}).scannerTossers.ftn_bso;
        mod.exportTempDir = path.join(root, 'temp');
        return mod;
    }

    //
    //  Message UUIDs are derived from areaTag + modTimestamp (to the second) +
    //  subject + body, so fixtures written in the same second collide unless
    //  something in them differs. Hence the counter.
    //
    let fixtureSeq = 0;

    //
    //  An imported message: persisted, then given the meta the tosser writes on
    //  import -- the Imported state flag, the packet header origin, and SEEN-BY.
    //
    //  `ftn_mail_packet.js` writes ftn_orig_node and ftn_orig_network from the
    //  packet header and *nothing else about the origin*: no ftn_orig_zone and
    //  no ftn_orig_point, even for a type 2+ packet that carried them. So that
    //  is what this fixture writes by default. An earlier version supplied a
    //  zone, which no real import ever does, and the effect was that every test
    //  exercised isSameFtnSystem's strict-zone branch and none of them
    //  exercised the branch production actually takes.
    //
    //  Pass `withZone: true` for the rarer case of an origin that does carry
    //  one.
    //
    async function addImported({
        areaTag = 'relay_area',
        origin = HUB,
        seenBy,
        withZone = false,
    }) {
        const seq = ++fixtureSeq;
        const message = new Message({
            areaTag,
            toUserName: 'All',
            fromUserName: 'Upstream',
            subject: `relayed ${seq}`,
            message: `body ${seq}`,
        });
        await new Promise((resolve, reject) =>
            message.persist(err => (err ? reject(err) : resolve()))
        );

        const [, zone, net, node] = /^(\d+):(\d+)\/(\d+)/.exec(origin);
        const meta = [
            ['System', 'state_flags0', Message.StateFlags0.Imported.toString()],
            ['FtnProperty', 'ftn_orig_network', net],
            ['FtnProperty', 'ftn_orig_node', node],
        ];
        if (withZone) {
            meta.push(['FtnProperty', 'ftn_orig_zone', zone]);
        }
        if (undefined !== seenBy) {
            meta.push(['FtnProperty', 'ftn_seen_by', seenBy]);
        }
        const stmt = testDb.prepare(
            `INSERT INTO message_meta (message_id, meta_category, meta_name, meta_value)
             VALUES (?, ?, ?, ?);`
        );
        for (const [cat, name, value] of meta) {
            stmt.run(message.messageId, cat, name, String(value));
        }
        return message;
    }

    //  A locally composed message: no state_flags0 at all.
    async function addLocal(areaTag = 'relay_area') {
        const seq = ++fixtureSeq;
        const message = new Message({
            areaTag,
            toUserName: 'All',
            fromUserName: 'Local User',
            subject: `local post ${seq}`,
            message: `body ${seq}`,
        });
        await new Promise((resolve, reject) =>
            message.persist(err => (err ? reject(err) : resolve()))
        );
        return message;
    }

    function relayScanId(areaTag) {
        const row = testDb
            .prepare(
                `SELECT message_id FROM message_area_last_scan
                 WHERE scan_toss = 'ftn_bso_relay' AND area_tag = ?;`
            )
            .get(areaTag);
        return row ? row.message_id : undefined;
    }

    //  Flow files are named for their destination, so the set of them is the
    //  set of uplinks that actually got mail. A point's lands one level down in
    //  an NNNNnnnn.pnt directory (FTS-5005.003), which is exactly the case one
    //  of these tests is about -- so walk, do not just list.
    async function flowFilesIn(root) {
        const base = path.join(root, 'outbound', 'outbound');
        const found = [];
        async function walk(dir, prefix) {
            const entries = await fsp
                .readdir(dir, { withFileTypes: true })
                .catch(() => []);
            for (const entry of entries) {
                const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
                if (entry.isDirectory()) {
                    await walk(path.join(dir, entry.name), rel);
                } else if (entry.name.endsWith('.clo')) {
                    found.push(rel);
                }
            }
        }
        await walk(base, '');
        return found.sort();
    }

    async function runRelay(root) {
        const mod = makeModule(root);
        return new Promise(resolve =>
            mod.performEchoMailRelayExport(err => resolve(err))
        );
    }

    async function freshRoot(name) {
        const root = path.join(tmpDir, name);
        await fsp.mkdir(path.join(root, 'temp'), { recursive: true });
        return root;
    }

    // ─── where it starts ─────────────────────────────────────────────────────

    it('starts from current mail rather than relaying the whole history', async () => {
        //  The failure this guards against: getAreaLastScanId() returns 0 both
        //  for "never scanned" and "nothing seen yet". A relay watermark that
        //  starts at 0 selects every imported message in the area -- on an
        //  established board, years of mail shipped to a link that never asked
        //  for it, and enough bundles to exhaust a destination's 36 names for
        //  the day.
        const root = await freshRoot('seed');
        const older = await addImported({});
        await addImported({});
        const newest = await addImported({});
        assert.ok(newest.messageId > older.messageId);

        const err = await runRelay(root);

        assert.ok(!err, err && err.message);
        assert.deepEqual(
            await flowFilesIn(root),
            [],
            'the first scan of an area should export nothing'
        );
        assert.equal(
            relayScanId('relay_area'),
            newest.messageId,
            'the watermark should be seeded to where the area is now'
        );
    });

    it('relays mail imported after the seed', async () => {
        const root = await freshRoot('after-seed');
        await addImported({});

        //  First pass seeds and sends nothing.
        await runRelay(root);
        assert.deepEqual(await flowFilesIn(root), []);

        //  Now mail arrives.
        const fresh = await addImported({});
        const err = await runRelay(root);

        assert.ok(!err, err && err.message);
        assert.ok(
            (await flowFilesIn(root)).length > 0,
            'mail imported after the seed should be relayed'
        );
        assert.equal(relayScanId('relay_area'), fresh.messageId);
    });

    // ─── who it goes to ──────────────────────────────────────────────────────

    it('does not offer a message back to the node that sent it', async () => {
        //  A sender usually adds itself to SEEN-BY, but not always, and a
        //  malformed or absent line must not be the only thing standing between
        //  us and echoing mail straight back at its source. So this fixture
        //  deliberately carries *no* SEEN-BY: the decision has to come from the
        //  packet header origin recorded at import.
        //
        //  (Written the other way round -- SEEN-BY naming the hub -- this test
        //  passed with the origin check removed entirely, because the SEEN-BY
        //  rule covered it. It was proving nothing.)
        const root = await freshRoot('no-echo-back');
        await addImported({});
        await runRelay(root); //  seed

        await addImported({ origin: HUB });
        await runRelay(root);

        const files = await flowFilesIn(root);
        assert.ok(
            !files.includes(flowName(HUB)),
            `should not have queued anything for ${HUB}, got ${files.join(', ')}`
        );
        assert.ok(
            files.includes(flowName(PEER)),
            'the other peer should still have been relayed to'
        );
    });

    it('keeps the origin rule when the packet header carried no zone', async () => {
        //  The production shape: ftn_orig_network and ftn_orig_node only. This
        //  is the branch of isSameFtnSystem that every real message takes, and
        //  until this test existed none of them covered it.
        const root = await freshRoot('no-zone-origin');
        await addImported({});
        await runRelay(root); //  seed

        await addImported({ origin: HUB, withZone: false });
        await runRelay(root);

        const files = await flowFilesIn(root);
        assert.ok(
            !files.includes(flowName(HUB)),
            `a zoneless origin must still be recognised; got ${files.join(', ')}`
        );
        assert.ok(files.includes(flowName(PEER)), 'the other peer should still get it');
    });

    it('does send our own point back the mail it sent us (known gap)', async () => {
        //  A point's packet header carries origPoint, but the importer does not
        //  record it -- so a message from OUR point reads as coming from
        //  1:218/700, which is us, point 0. The origin rule therefore cannot
        //  see that the point sent it, and the point carve-out relays
        //  unconditionally.
        //
        //  The receiving tosser drops it on MSGID, so this is wasted traffic
        //  rather than a loop, but it is worth knowing about and worth a test
        //  that will notice if the importer ever starts recording the point.
        const root = await freshRoot('point-origin');
        await addImported({});
        await runRelay(root); //  seed

        await addImported({ origin: POINT });
        await runRelay(root);

        const files = await flowFilesIn(root);
        const wentToPoint = files.some(
            f => f.includes('.pnt/') && f.endsWith('00000001.clo')
        );
        assert.equal(
            wentToPoint,
            true,
            'documents current behaviour: see the comment above -- if this ' +
                'starts failing, the importer began recording ftn_orig_point ' +
                'and the origin rule can now catch this case'
        );
    });

    it('skips a peer already in SEEN-BY, and relays to one that is not', async () => {
        const root = await freshRoot('seen-by');
        await addImported({});
        await runRelay(root); //  seed

        //  PEER has seen it; the message came from HUB. Neither should be sent
        //  to -- HUB because it is the origin, PEER because of SEEN-BY.
        await addImported({ origin: HUB, seenBy: '218/701 702' });
        await runRelay(root);
        let files = await flowFilesIn(root);
        assert.ok(
            !files.includes(flowName(PEER)),
            'an uplink already in SEEN-BY should be skipped'
        );

        //  Same setup, but PEER has not seen it.
        await addImported({ origin: HUB, seenBy: '218/701' });
        await runRelay(root);
        files = await flowFilesIn(root);
        assert.ok(
            files.includes(flowName(PEER)),
            `a peer not in SEEN-BY should be relayed to; got ${files.join(', ')}`
        );
    });

    it('relays to our own point even though SEEN-BY names its net/node', async () => {
        //  FTS-1027: SEEN-BY has no point component, and a point's net/node are
        //  its boss's. An upstream sender adds the boss to SEEN-BY as ordinary
        //  routing courtesy, so a plain SEEN-BY test reads "I have already seen
        //  this" -- true by definition once imported -- and a point would never
        //  be relayed to at all.
        const root = await freshRoot('point');
        await addImported({});
        await runRelay(root); //  seed

        //  218/700 is us, and therefore also our point's net/node.
        await addImported({ origin: HUB, seenBy: '218/700 701 702' });
        const err = await runRelay(root);

        assert.ok(!err, err && err.message);
        const files = await flowFilesIn(root);
        assert.ok(
            files.some(f => f.includes('.pnt/') && f.endsWith('00000001.clo')),
            `our point should have been relayed to; got ${files.join(', ')}`
        );
    });

    it('leaves locally composed messages to the export scan', async () => {
        const root = await freshRoot('local-only');
        await addImported({});
        await runRelay(root); //  seed

        await addLocal();
        const err = await runRelay(root);

        assert.ok(!err, err && err.message);
        assert.deepEqual(
            await flowFilesIn(root),
            [],
            'a local post carries no Imported flag and is not ours to relay'
        );
    });

    it('ignores an area that has not opted in', async () => {
        const root = await freshRoot('opt-in');
        await addImported({ areaTag: 'quiet_area' });
        await addImported({ areaTag: 'quiet_area' });

        const err = await runRelay(root);

        assert.ok(!err, err && err.message);
        assert.deepEqual(await flowFilesIn(root), []);
        assert.equal(
            relayScanId('quiet_area'),
            undefined,
            'an area without relay:true should not even be watermarked'
        );
    });

    // ─── the watermark ───────────────────────────────────────────────────────

    it('advances past messages every uplink had already seen', async () => {
        //  Otherwise they are re-read and re-judged on every scan forever.
        //
        //  This has to run against an area with no point in it. An earlier
        //  version used relay_area, whose point is relayed to unconditionally,
        //  so mail was always going out and the assertion never saw the
        //  "filtered away entirely" case it names -- it passed with the SEEN-BY
        //  filter disabled outright.
        const root = await freshRoot('filtered-advance');
        await addImported({ areaTag: 'peers_area' });
        await runRelay(root); //  seed

        const filtered = await addImported({
            areaTag: 'peers_area',
            origin: HUB,
            seenBy: '218/701 702',
        });
        await runRelay(root);

        assert.deepEqual(
            await flowFilesIn(root),
            [],
            'origin plus SEEN-BY should account for every uplink of this area'
        );
        assert.equal(
            relayScanId('peers_area'),
            filtered.messageId,
            'the decision has been made for that message; do not weigh it again'
        );
    });

    it('holds the watermark back when an uplink fails', async () => {
        //  A destination with no node configuration is skipped by
        //  exportEchoMailMessagesToUplinks rather than failing, so provoke a
        //  real failure: make the outbound directory unwritable.
        const root = await freshRoot('fail-hold');
        await addImported({});
        await runRelay(root); //  seed

        const pending = await addImported({ origin: HUB, seenBy: '218/701' });
        const outbound = path.join(root, 'outbound');
        await fsp.mkdir(outbound, { recursive: true });
        await fsp.chmod(outbound, 0o500);

        let err;
        try {
            err = await runRelay(root);
        } finally {
            await fsp.chmod(outbound, 0o700);
        }

        assert.ok(!err, 'the pass itself should not throw');
        assert.notEqual(
            relayScanId('relay_area'),
            pending.messageId,
            'mail that did not get out must come round again'
        );
        assert.ok(
            logged.some(entry =>
                JSON.stringify(entry).includes('EchoMail relay incomplete')
            ),
            'the failure should be reported, not swallowed'
        );
    });

    function flowName(address) {
        const m = /^\d+:(\d+)\/(\d+)$/.exec(address);
        return (
            Number(m[1]).toString(16).padStart(4, '0') +
            Number(m[2]).toString(16).padStart(4, '0') +
            '.clo'
        );
    }
});
