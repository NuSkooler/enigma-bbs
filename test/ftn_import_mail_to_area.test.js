'use strict';

//
//  importMailToArea, for real.
//
//  The two suites that reach it -- ftn_bso_packet_import.test.js and
//  ftn_auto_area_scan.test.js -- stub it out, so the decisions it makes about
//  every imported FTN message had no test: refusing a MSGID already in the
//  base, resolving REPLY to the message it answers, and where a NetMail is
//  delivered. These run packets through importMessagesFromPacketFile into an
//  in-memory message base with the real schema, and read back what landed.
//
//  The packet password is checked one step earlier, against the packet
//  header (validatePacketHeader), before any message reaches
//  importMailToArea; it is tested here because it gates this path.
//

const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const paths = require('path');
const Database = require('better-sqlite3');

const configModule = require('../core/config.js');
const loggerModule = require('../core/logger.js');

const LOCAL = { zone: 21, net: 1, node: 121, point: 0 };
const HUB = { zone: 21, net: 1, node: 100, point: 0 };
const ELSEWHERE = { zone: 21, net: 1, node: 999, point: 0 };
const HUB_PASSWORD = 'SeCrEt';

const Attr = { Private: 0x0001 };

const RELOADED = [
    '../core/message.js',
    '../core/ftn_mail_packet.js',
    '../core/scanner_tossers/ftn_bso.js',
];

function makeConfig() {
    return {
        debug: { assertsEnabled: false },
        menus: { cls: false },
        general: { boardName: 'Test BBS' },
        scannerTossers: {
            ftn_bso: {
                nodes: {
                    '21:1/100': { packetType: '2+', packetPassword: HUB_PASSWORD },
                },
            },
        },
        messageNetworks: {
            ftn: {
                networks: { fsxnet: { localAddress: '21:1/121', defaultZone: 21 } },
                areas: {
                    fsx_gen: { network: 'fsxnet', tag: 'FSX_GEN', uplinks: ['21:1/100'] },
                },
            },
        },
    };
}

//  One packed message (FTS-0001 "packed message"): header, date, the three
//  NUL-terminated strings, then the body with its kludges.
function packedMessage({ to = 'All', from = 'Someone', subject, body, attr = 0 }) {
    const head = Buffer.alloc(14);
    head.writeUInt16LE(2, 0); //  messageType
    head.writeUInt16LE(HUB.node, 2);
    head.writeUInt16LE(LOCAL.node, 4);
    head.writeUInt16LE(HUB.net, 6);
    head.writeUInt16LE(LOCAL.net, 8);
    head.writeUInt16LE(attr, 10);

    const date = Buffer.alloc(20);
    date.write('07 Oct 26  02:30:00\x00', 'ascii');

    const strings = Buffer.from(
        `${to}\x00${from}\x00${subject}\x00${body}\x00`,
        'latin1'
    );
    return Buffer.concat([head, date, strings]);
}

describe('ftn_bso — importMailToArea', function () {
    this.timeout(10000);

    let FtnPacket;
    let tmpDir;
    let testDb;
    let prevConfig;
    let prevMessageDb;
    let prevLog;
    let Message;
    let User;
    let getModule;
    let logged;
    let savedUser;
    let users; //  user_name (lower case) -> { id, name }

    before(() => {
        tmpDir = fs.mkdtempSync(paths.join(os.tmpdir(), 'enigma_ftnimport_'));
        prevConfig = configModule._pushTestConfig(makeConfig());

        //  message.js captures dbs.message at load, and ftn_mail_packet.js
        //  (which builds the parsed messages) and ftn_bso.js capture the
        //  Message class: the database goes in first, then all three are
        //  reloaded in that order (and dropped again in after()).
        const dbModule = require('../core/database.js');
        prevMessageDb = dbModule.dbs.message;
        testDb = new Database(':memory:');
        testDb.pragma('foreign_keys = ON');
        dbModule.initMessageDatabase(testDb);
        dbModule.dbs.message = testDb;

        //  every level: bunyan's live on the prototype, which Object.assign
        //  does not copy
        logged = [];
        prevLog = loggerModule.log;
        const collect =
            level =>
            (...a) =>
                logged.push({ level, a });
        loggerModule.log = Object.assign({}, prevLog, {
            trace: () => {},
            debug: () => {},
            info: collect('info'),
            warn: collect('warn'),
            error: collect('error'),
            child: () => loggerModule.log,
        });

        RELOADED.forEach(m => delete require.cache[require.resolve(m)]);
        Message = require('../core/message.js');
        FtnPacket = require('../core/ftn_mail_packet.js');
        ({ getModule } = require('../core/scanner_tossers/ftn_bso.js'));

        //  The user database is not what is under test: answer the two
        //  lookups NetMail delivery makes from a table here.
        User = require('../core/user.js');
        savedUser = {
            getUserIdAndNameByLookup: User.getUserIdAndNameByLookup,
            getUserName: User.getUserName,
        };
        User.getUserIdAndNameByLookup = (lookup, cb) => {
            const u = users[String(lookup).toLowerCase()];
            return u ? cb(null, u.id, u.name) : cb(new Error(`No user "${lookup}"`));
        };
        User.getUserName = (userId, cb) => {
            const u = Object.values(users).find(x => x.id === userId);
            return u ? cb(null, u.name) : cb(new Error('No matching user ID'));
        };
    });

    after(() => {
        Object.assign(User, savedUser);
        configModule._popTestConfig(prevConfig);
        loggerModule.log = prevLog;
        RELOADED.forEach(m => delete require.cache[require.resolve(m)]);
        require('../core/database.js').dbs.message = prevMessageDb;
        testDb.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    let mod;
    let seq = 0;

    beforeEach(() => {
        logged.length = 0;
        testDb.exec('DELETE FROM message_meta; DELETE FROM message;');
        users = {
            sysop: { id: User.RootUserID, name: 'SysOp' },
            'nigel reed': { id: 7, name: 'Nigel Reed' },
        };
        mod = new getModule();
        mod.moduleConfig = makeConfig().scannerTossers.ftn_bso;
    });

    //  Subjects double as identities: the message UUID is derived from area,
    //  timestamp, subject and body, so fixtures must differ in one of them.
    function subject(label) {
        return `${label} ${++seq}`;
    }

    function writePacket(messages, { password = HUB_PASSWORD, dest = LOCAL } = {}) {
        const ph = new FtnPacket.PacketHeader(HUB, dest, '2+');
        ph.password = password;
        const packetPath = paths.join(tmpDir, `p${++seq}.pkt`);
        fs.writeFileSync(
            packetPath,
            Buffer.concat([
                new FtnPacket.Packet().getPacketHeaderBuffer(ph),
                ...messages.map(packedMessage),
                Buffer.from([0x00, 0x00]),
            ])
        );
        return packetPath;
    }

    function importPacket(packetPath) {
        return new Promise(resolve =>
            mod.importMessagesFromPacketFile(packetPath, '', err => resolve(err))
        );
    }

    function echo(label, kludges = '') {
        const s = subject(label);
        return { subject: s, body: `AREA:FSX_GEN\r${kludges}Body of ${s}\r` };
    }

    function netmail(label, { to = 'Nigel Reed', intl = true, kludges = '' } = {}) {
        const s = subject(label);
        const intlLine = intl ? '\x01INTL 21:1/121 21:1/100\r' : '';
        return {
            to,
            subject: s,
            attr: Attr.Private,
            body: `${intlLine}${kludges}Body of ${s}\r`,
        };
    }

    function stored(subjectText) {
        const row = testDb
            .prepare('SELECT * FROM message WHERE subject = ?;')
            .get(subjectText);
        if (!row) {
            return undefined;
        }
        const meta = {};
        testDb
            .prepare(
                'SELECT meta_category, meta_name, meta_value FROM message_meta WHERE message_id = ?;'
            )
            .all(row.message_id)
            .forEach(m => {
                meta[`${m.meta_category}.${m.meta_name}`] = m.meta_value;
            });
        return Object.assign(row, { meta });
    }

    function messageCount() {
        return testDb.prepare('SELECT COUNT(*) AS n FROM message;').get().n;
    }

    // ─── EchoMail ────────────────────────────────────────────────────────────

    it('imports EchoMail into the mapped area, flagged Imported', async () => {
        const m = echo('echo', '\x01MSGID: 21:1/100 0000aaaa\r');
        const err = await importPacket(writePacket([m]));
        assert.ok(!err, err && err.message);

        const row = stored(m.subject);
        assert.ok(row, 'the message should be in the base');
        assert.equal(row.area_tag, 'fsx_gen');
        assert.equal(row.meta['FtnKludge.MSGID'], '21:1/100 0000aaaa');
        assert.equal(
            row.meta['System.state_flags0'],
            String(Message.StateFlags0.Imported)
        );
        assert.equal(row.meta['System.external_flavor'], Message.AddressFlavor.FTN);
    });

    it('refuses a MSGID already in the base (DUPE_MSGID)', async () => {
        const first = echo('original', '\x01MSGID: 21:1/100 0000bbbb\r');
        assert.ok(!(await importPacket(writePacket([first]))));

        //  Different subject and body, so not a UUID collision: only the
        //  MSGID says it is the same message.
        const again = echo('resent', '\x01MSGID: 21:1/100 0000bbbb\r');
        const err = await importPacket(writePacket([again]));

        assert.ok(!err, 'a duplicate is skipped, not a packet failure');
        assert.ok(stored(first.subject));
        assert.equal(
            stored(again.subject),
            undefined,
            'the duplicate must not be stored'
        );
        assert.equal(messageCount(), 1);
        assert.ok(
            logged.some(
                l => 'info' === l.level && /Skipping duplicate message/.test(l.a[1])
            ),
            'and it is counted as a duplicate'
        );
    });

    it('reports a duplicate MSGID with the DUPE_MSGID code', async () => {
        //  importPacketEntries treats DUPE_MSGID and a UUID constraint alike;
        //  call importMailToArea directly to see which one it was.
        const first = echo('code original', '\x01MSGID: 21:1/100 0000cccc\r');
        assert.ok(!(await importPacket(writePacket([first]))));

        const message = new Message({
            toUserName: 'All',
            fromUserName: 'Someone',
            subject: subject('code dupe'),
            message: 'a different body',
        });
        message.meta.FtnProperty = {
            ftn_dest_network: LOCAL.net,
            ftn_dest_node: LOCAL.node,
            ftn_area: 'FSX_GEN',
        };
        message.meta.FtnKludge = { MSGID: '21:1/100 0000cccc' };

        const err = await new Promise(resolve =>
            mod.importMailToArea({ localAreaTag: 'fsx_gen' }, {}, message, resolve)
        );
        assert.ok(err);
        assert.equal(err.code, 'DUPE_MSGID');
    });

    it('imports a message with no MSGID without a dupe check', async () => {
        const a = echo('no msgid a');
        const b = echo('no msgid b');
        assert.ok(!(await importPacket(writePacket([a, b]))));
        assert.equal(messageCount(), 2);
    });

    it('resolves a REPLY kludge to the message it answers', async () => {
        const original = echo('question', '\x01MSGID: 21:1/100 0000dddd\r');
        const reply = echo(
            'answer',
            '\x01MSGID: 21:1/100 0000eeee\r\x01REPLY: 21:1/100 0000dddd\r'
        );
        //  separate packets in order, and in one packet: both must resolve
        assert.ok(!(await importPacket(writePacket([original]))));
        assert.ok(!(await importPacket(writePacket([reply]))));

        assert.equal(
            stored(reply.subject).reply_to_message_id,
            stored(original.subject).message_id
        );
    });

    it('resolves a REPLY to a message earlier in the same packet', async () => {
        const original = echo('same packet q', '\x01MSGID: 21:1/100 0000f001\r');
        const reply = echo('same packet a', '\x01REPLY: 21:1/100 0000f001\r');
        assert.ok(!(await importPacket(writePacket([original, reply]))));

        assert.equal(
            stored(reply.subject).reply_to_message_id,
            stored(original.subject).message_id
        );
    });

    it('leaves a REPLY it cannot resolve as no reply', async () => {
        const reply = echo('orphan', '\x01REPLY: 21:1/100 0badf00d\r');
        assert.ok(!(await importPacket(writePacket([reply]))));
        assert.equal(stored(reply.subject).reply_to_message_id, 0);
        assert.equal(stored(reply.subject).meta['FtnKludge.REPLY'], '21:1/100 0badf00d');
    });

    it('does not guess when a REPLY matches more than one message', async () => {
        //  Two messages already carrying the same MSGID (allowDupes, or an
        //  older import): the reply is stored but linked to neither.
        for (const label of ['twin 1', 'twin 2']) {
            const message = new Message({
                areaTag: 'fsx_gen',
                toUserName: 'All',
                fromUserName: 'x',
                subject: subject(label),
                message: 'twin',
            });
            message.meta.FtnKludge = { MSGID: '21:1/100 00007777' };
            await new Promise((resolve, reject) =>
                message.persist(err => (err ? reject(err) : resolve()))
            );
        }

        const reply = echo('ambiguous', '\x01REPLY: 21:1/100 00007777\r');
        assert.ok(!(await importPacket(writePacket([reply]))));
        assert.equal(stored(reply.subject).reply_to_message_id, 0);
        assert.ok(
            logged.some(l => 'warn' === l.level && /2:n MSGIDs/.test(l.a[1])),
            'and says why'
        );
    });

    // ─── where it is addressed ──────────────────────────────────────────────

    it('refuses a packet that is not addressed to us', async () => {
        const m = echo('misrouted');
        const err = await importPacket(writePacket([m], { dest: ELSEWHERE }));
        assert.ok(err);
        assert.match(err.message, /No local configuration for packet addressed to/);
        assert.equal(messageCount(), 0);
    });

    it('refuses a message whose destination is not one of ours', async () => {
        //  The packet header check above runs first on the packet path; this
        //  is importMailToArea's own check, which reads the same address as
        //  recorded on the message.
        const message = new Message({
            toUserName: 'Nigel Reed',
            fromUserName: 'Someone',
            subject: subject('not for us'),
            message: 'body',
        });
        message.meta.FtnProperty = {
            ftn_dest_network: ELSEWHERE.net,
            ftn_dest_node: ELSEWHERE.node,
            ftn_attr_flags: Attr.Private,
        };
        message.meta.FtnKludge = { INTL: '21:1/999 21:1/100' };

        const err = await new Promise(resolve =>
            mod.importMailToArea(
                { localAreaTag: Message.WellKnownAreaTags.Private },
                {},
                message,
                resolve
            )
        );
        assert.ok(err);
        assert.match(err.message, /destination is not us/);
        assert.equal(messageCount(), 0);
    });

    // ─── NetMail delivery ───────────────────────────────────────────────────

    it('delivers NetMail to the local user it names', async () => {
        const m = netmail('for nigel', { to: 'nigel reed' });
        const err = await importPacket(writePacket([m]));
        assert.ok(!err, err && err.message);

        const row = stored(m.subject);
        assert.equal(row.area_tag, Message.WellKnownAreaTags.Private);
        assert.equal(row.meta['System.local_to_user_id'], '7');
        assert.equal(row.meta['System.remote_from_user'], '21:1/100');
        assert.equal(row.to_user_name, 'nigel reed', 'the name is kept as addressed');
    });

    it('records a point origin from FMPT', async () => {
        const m = netmail('from a point', { kludges: '\x01FMPT 3\r' });
        assert.ok(!(await importPacket(writePacket([m]))));
        assert.equal(stored(m.subject).meta['System.remote_from_user'], '21:1/100.3');
    });

    it('refuses NetMail without an INTL line', async () => {
        const m = netmail('no intl', { intl: false });
        const err = await importPacket(writePacket([m]));
        assert.ok(err);
        assert.match(err.message, /without valid INTL/);
        assert.equal(messageCount(), 0);
    });

    it('refuses NetMail for a user that does not exist', async () => {
        const m = netmail('nobody', { to: 'No Such Person' });
        const err = await importPacket(writePacket([m]));
        assert.ok(err);
        assert.match(err.message, /Could not get local user ID/);
        assert.equal(messageCount(), 0);
    });

    // ─── packet password ────────────────────────────────────────────────────

    it('refuses a packet without the password configured for its sender', async () => {
        const m = echo('bad password');
        const err = await importPacket(writePacket([m], { password: 'WRONG' }));
        assert.ok(err);
        assert.match(err.message, /password mismatch/);
        assert.equal(messageCount(), 0);
        assert.ok(
            logged.some(l => 'warn' === l.level && /password mismatch/.test(l.a[1]))
        );
    });

    it('refuses a packet with no password when one is configured', async () => {
        const err = await importPacket(
            writePacket([echo('no password')], { password: '' })
        );
        assert.ok(err);
        assert.equal(messageCount(), 0);
    });

    it('compares the packet password without regard to case', async () => {
        const m = echo('case password');
        const err = await importPacket(
            writePacket([m], { password: HUB_PASSWORD.toLowerCase() })
        );
        assert.ok(!err, err && err.message);
        assert.ok(stored(m.subject));
    });
});
