'use strict';

//
//  A kludge that appears more than once in a message.
//
//  The packet parser collects kludge lines into a name -> value map, and a
//  name seen twice becomes an array. That is right for PATH and Via, which
//  are lists by definition, and wrong for the single-valued kludges the
//  tosser reads as strings: INTL, MSGID, REPLY and friends. These tests pin
//  down that the parser hands the rest of the code one value for each of
//  those -- the first, as written by the originating system -- and that
//  the import treats a MSGID it could not look up as "do not import".
//

const { strict: assert } = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const paths = require('path');
const Database = require('better-sqlite3');

const configModule = require('../core/config.js');
const loggerModule = require('../core/logger.js');

const { PacketHeader, Packet } = require('../core/ftn_mail_packet.js');

const LOCAL = { zone: 21, net: 1, node: 121, point: 0 };
const REMOTE = { zone: 21, net: 1, node: 100, point: 0 };

const PRIVATE_ATTR = 0x0001;

let packetSeq = 0;

//  One packed (type 2) message. |body| is everything after the subject,
//  kludges included.
function packedMessage({ toUserName = 'All', subject = 'Subject', body, attr = 0 }) {
    const head = Buffer.alloc(14);
    head.writeUInt16LE(2, 0); //  messageType
    head.writeUInt16LE(REMOTE.node, 2);
    head.writeUInt16LE(LOCAL.node, 4);
    head.writeUInt16LE(REMOTE.net, 6);
    head.writeUInt16LE(LOCAL.net, 8);
    head.writeUInt16LE(attr, 10);

    const date = Buffer.alloc(20);
    date.write('07 Oct 26  02:30:00\x00', 'ascii');

    const strings = Buffer.from(
        `${toUserName}\x00Someone\x00${subject}\x00${body}\x00`,
        'binary'
    );
    return Buffer.concat([head, date, strings]);
}

function writePacket(dir, messages) {
    const ph = new PacketHeader();
    ph.origAddress = REMOTE;
    ph.destAddress = LOCAL;

    const packetPath = paths.join(dir, `test${++packetSeq}.pkt`);
    fs.writeFileSync(
        packetPath,
        Buffer.concat([
            new Packet().getPacketHeaderBuffer(ph),
            ...messages.map(packedMessage),
            Buffer.from([0x00, 0x00]),
        ])
    );
    return packetPath;
}

function readMessages(packetPath) {
    return new Promise((resolve, reject) => {
        const messages = [];
        new Packet().read(
            packetPath,
            (entryType, entryData, next) => {
                if ('message' === entryType) {
                    messages.push(entryData);
                }
                return next(null);
            },
            err => (err ? reject(err) : resolve(messages))
        );
    });
}

const echoBody = kludges =>
    `AREA:FSX_GEN\r${kludges.map(k => `\x01${k}\r`).join('')}Hello\r` +
    '--- test\r * Origin: test (21:1/100)\rSEEN-BY: 1/100 121\r\x01PATH: 1/100\r';

describe('FTN packets — a kludge that appears more than once', () => {
    let dir;

    beforeEach(() => {
        dir = fs.mkdtempSync(paths.join(os.tmpdir(), 'ftn-kludge-'));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('a packet with two INTL kludges keeps the first', async () => {
        const [message] = await readMessages(
            writePacket(dir, [
                {
                    attr: PRIVATE_ATTR,
                    body:
                        '\x01INTL 21:1/121 21:1/100\r\x01INTL 21:9/9 21:9/8\r' +
                        '\x01FMPT 3\r\x01FMPT 4\rHello\r',
                },
            ])
        );

        assert.equal(message.meta.FtnKludge.INTL, '21:1/121 21:1/100');
        assert.equal(message.meta.FtnKludge.FMPT, '3');
    });

    it('a packet with two MSGID kludges keeps the first', async () => {
        const [message] = await readMessages(
            writePacket(dir, [
                {
                    body: echoBody([
                        'MSGID: 21:1/100 aaaa0001',
                        'MSGID: 21:1/100 bbbb0002',
                        'REPLY: 21:1/50 cccc0003',
                        'REPLY: 21:1/50 dddd0004',
                        'TZUTC: 0100',
                        'TZUTC: -0500',
                    ]),
                },
            ])
        );

        const kludges = message.meta.FtnKludge;
        assert.equal(kludges.MSGID, '21:1/100 aaaa0001');
        assert.equal(kludges.REPLY, '21:1/50 cccc0003');
        assert.equal(kludges.TZUTC, '0100');
    });

    it('PATH and Via are always lists, even with a single line', async () => {
        const [message] = await readMessages(
            writePacket(dir, [
                {
                    attr: PRIVATE_ATTR,
                    body:
                        '\x01INTL 21:1/121 21:1/100\r\x01Via 21:1/100 @20261007.023000 test\r' +
                        'Hello\r\x01PATH: 1/100\r',
                },
            ])
        );

        assert.deepEqual(message.meta.FtnKludge.PATH, ['1/100']);
        assert.deepEqual(message.meta.FtnKludge.Via, ['21:1/100 @20261007.023000 test']);
    });

    it('a repeated kludge the tosser does not interpret is kept in full', async () => {
        const [message] = await readMessages(
            writePacket(dir, [{ body: echoBody(['NOTE: one', 'NOTE: two']) }])
        );

        assert.deepEqual(message.meta.FtnKludge.NOTE, ['one', 'two']);
    });

    it('re-exports the kludge lines it keeps byte for byte', async () => {
        const [message] = await readMessages(
            writePacket(dir, [
                {
                    body: echoBody([
                        'MSGID: 21:1/100 aaaa0001',
                        'NOTE: one',
                        'NOTE: two',
                    ]),
                },
            ])
        );

        //  The exporter writes a single-valued list exactly as it writes a
        //  string, so PATH arriving as a list changes nothing on the wire.
        const entry = await new Promise((resolve, reject) =>
            new Packet().getMessageEntryBuffer(message, { encoding: 'cp437' }, (e, b) =>
                e ? reject(e) : resolve(b)
            )
        );
        const body = entry.toString('binary').replace(/\0$/, '');
        assert.ok(body.includes('\x01MSGID: 21:1/100 aaaa0001\r'));
        assert.ok(body.includes('\x01NOTE: one\r\x01NOTE: two\r'));
        assert.ok(body.endsWith('SEEN-BY: 1/100 121\r\x01PATH: 1/100\r'));
    });
});

//  Only what the import path touches; ftn_echomail_relay.test.js carries the
//  same subset for the same reason.
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
    `);
}

describe('FTN import — repeated kludges against a real message base', function () {
    this.timeout(10000);

    let tmpDir;
    let testDb;
    let prevConfig;
    let prevMessageDb;
    let prevLog;
    let logged;
    let Message;
    let getModule;
    let User;
    let prevLookup;

    function makeConfig(root) {
        return {
            debug: { assertsEnabled: false },
            menus: { cls: false },
            general: { boardName: 'Test BBS' },
            scannerTossers: {
                ftn_bso: {
                    paths: {
                        outbound: paths.join(root, 'outbound'),
                        inbound: paths.join(root, 'ftn_in'),
                        secInbound: paths.join(root, 'ftn_secin'),
                    },
                    nodes: {},
                },
            },
            messageNetworks: {
                ftn: {
                    networks: {
                        fsxnet: { localAddress: '21:1/121', defaultZone: 21 },
                    },
                    areas: {
                        fsx_gen: { network: 'fsxnet', tag: 'FSX_GEN', uplinks: [] },
                    },
                },
            },
        };
    }

    before(async () => {
        tmpDir = await fsp.mkdtemp(paths.join(os.tmpdir(), 'enigma_ftnkludge_'));

        prevConfig = configModule._pushTestConfig(makeConfig(tmpDir));

        //  message.js captures dbs.message at load, and ftn_mail_packet.js
        //  (which builds the parsed messages) and ftn_bso.js capture the
        //  Message class at load, so the database goes in first and the
        //  three are reloaded in that order.
        const dbModule = require('../core/database.js');
        prevMessageDb = dbModule.dbs.message;
        testDb = new Database(':memory:');
        testDb.pragma('foreign_keys = ON');
        applySchema(testDb);
        dbModule.dbs.message = testDb;

        //  bunyan's methods live on the prototype, so the stub supplies every
        //  level the code under test may call.
        logged = [];
        prevLog = loggerModule.log;
        loggerModule.log = Object.assign({}, prevLog, {
            trace: () => {},
            debug: () => {},
            info: () => {},
            warn: (...a) => logged.push(a),
            error: (...a) => logged.push(a),
            fatal: (...a) => logged.push(a),
            child: () => loggerModule.log,
        });

        delete require.cache[require.resolve('../core/message.js')];
        delete require.cache[require.resolve('../core/ftn_mail_packet.js')];
        delete require.cache[require.resolve('../core/scanner_tossers/ftn_bso.js')];
        Message = require('../core/message.js');
        ({ getModule } = require('../core/scanner_tossers/ftn_bso.js'));

        //  NetMail import resolves the addressee to a local user; that is not
        //  what is under test here.
        User = require('../core/user.js');
        prevLookup = User.getUserIdAndNameByLookup;
        User.getUserIdAndNameByLookup = (name, cb) => cb(null, 1, 'sysop');
    });

    after(async () => {
        User.getUserIdAndNameByLookup = prevLookup;
        configModule._popTestConfig(prevConfig);
        loggerModule.log = prevLog;
        delete require.cache[require.resolve('../core/message.js')];
        delete require.cache[require.resolve('../core/ftn_mail_packet.js')];
        delete require.cache[require.resolve('../core/scanner_tossers/ftn_bso.js')];
        require('../core/database.js').dbs.message = prevMessageDb;
        if (testDb) {
            testDb.close();
        }
        await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    beforeEach(() => {
        logged.length = 0;
        testDb.exec('DELETE FROM message_meta;');
        testDb.exec('DELETE FROM message;');
        testDb.exec('DELETE FROM message_fts;');
    });

    function makeModule() {
        const mod = new getModule();
        mod.moduleConfig = makeConfig(tmpDir).scannerTossers.ftn_bso;
        return mod;
    }

    //  Resolves with the import's error, or rejects if it never calls back --
    //  which is the failure mode an uncaught throw inside the import produces.
    function importPacket(mod, packetPath) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error('import never completed')),
                3000
            );
            mod.importMessagesFromPacketFile(packetPath, '', err => {
                clearTimeout(timer);
                return resolve(err);
            });
        });
    }

    const messageCount = () =>
        testDb.prepare('SELECT COUNT(*) AS c FROM message').get().c;

    it('a packet with two MSGID kludges is recognised as a duplicate the second time', async () => {
        const mod = makeModule();
        const body = n =>
            echoBody(['MSGID: 21:1/100 aaaa0001', 'MSGID: 21:1/100 bbbb0002']).replace(
                'Hello',
                `Hello ${n}`
            );

        //  Different bodies, so the UUID cannot be what catches the dupe.
        let err = await importPacket(mod, writePacket(tmpDir, [{ body: body(1) }]));
        assert.ok(!err, err && err.message);
        assert.equal(messageCount(), 1);

        err = await importPacket(mod, writePacket(tmpDir, [{ body: body(2) }]));
        assert.ok(!err, err && err.message);
        assert.equal(messageCount(), 1);

        const stored = testDb
            .prepare(
                `SELECT meta_value FROM message_meta WHERE meta_category = 'FtnKludge' AND meta_name = 'MSGID'`
            )
            .all()
            .map(r => r.meta_value);
        assert.deepEqual(stored, ['21:1/100 aaaa0001']);
    });

    it('a MSGID that cannot be looked up is not imported', async () => {
        const mod = makeModule();
        const prev = Message.getMessageIdsByMetaValue;
        Message.getMessageIdsByMetaValue = (c, n, v, cb) =>
            cb(new Error('lookup failed'));
        try {
            const err = await importPacket(
                mod,
                writePacket(tmpDir, [{ body: echoBody(['MSGID: 21:1/100 eeee0005']) }])
            );
            assert.ok(err, 'expected the packet to be refused');
        } finally {
            Message.getMessageIdsByMetaValue = prev;
        }
        assert.equal(messageCount(), 0);
    });

    it('a NetMail with two INTL kludges imports, addressed by the first', async () => {
        const mod = makeModule();
        const err = await importPacket(
            mod,
            writePacket(tmpDir, [
                {
                    toUserName: 'sysop',
                    attr: PRIVATE_ATTR,
                    body:
                        '\x01INTL 21:1/121 21:1/100\r\x01INTL 21:9/9 21:9/8\r' +
                        '\x01MSGID: 21:1/100 ffff0006\rHello netmail\r',
                },
            ])
        );
        assert.ok(!err, err && err.message);
        assert.equal(messageCount(), 1);

        const from = testDb
            .prepare(
                `SELECT meta_value FROM message_meta WHERE meta_category = 'System' AND meta_name = ?`
            )
            .get(Message.SystemMetaNames.RemoteFromUser);
        assert.equal(from.meta_value, '21:1/100');
    });
});
