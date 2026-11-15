'use strict';

//
//  Shared by ftn_export_equivalence.test.js and ftn_export_load_once.test.js:
//  an in-memory message base with the real schema, an ftn_bso module bound to
//  it, and one fixture run through all three EchoMail export callers. See the
//  top of ftn_export_equivalence.test.js for what is stubbed and why.
//

const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const configModule = require('../core/config.js');
const loggerModule = require('../core/logger.js');

const LOCAL = '1:218/700';
const U1 = '1:218/701';
const U2 = '1:218/702';
const U3 = '1:218/703';
const PEER2 = '1:218/704';
const POINT = '1:218/700.1';

const NODES = {
    [U1]: { packetType: '2+', encoding: 'cp437' },
    [U2]: { packetType: '2', encoding: 'utf8', exportType: 'hold' },
    [U3]: { packetType: '2+', fileCase: 'upper' },
    [PEER2]: { packetType: '2+', encoding: 'cp437' },
    [POINT]: { packetType: '2+' },
};

const AREAS = {
    local_a: { network: 'testnet', tag: 'LOCAL_A', uplinks: [U1, U2, U3] },
    relay_a: {
        network: 'testnet',
        tag: 'RELAY_A',
        uplinks: [U1, U2, POINT],
        relay: true,
    },
    relay_b: {
        network: 'testnet',
        tag: 'RELAY_B',
        uplinks: [U1, U3, PEER2],
        relay: true,
    },
};

//  Small enough that most packets hold two messages and the large one
//  overflows on its own (the exporter's carry-over path).
const PACKET_TARGET_BYTE_SIZE = 1000;

const RELOADED = ['../core/message.js', '../core/scanner_tossers/ftn_bso.js'];

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
                packetTargetByteSize: PACKET_TARGET_BYTE_SIZE,
                nodes: NODES,
            },
        },
        messageNetworks: {
            ftn: {
                networks: { testnet: { localAddress: LOCAL, defaultZone: 1 } },
                areas: AREAS,
            },
        },
    };
}

function createHarness() {
    const h = {
        root: null,
        db: null,
        Message: null,
        getModule: null,
        logged: [],
    };

    let prevConfig;
    let prevMessageDb;
    let prevLog;
    let ftnUtil;
    let savedFtnUtil;

    h.setup = async label => {
        h.root = await fsp.mkdtemp(path.join(os.tmpdir(), `enigma_${label}_`));
        for (const d of ['outbound', 'ftn_in', 'ftn_secin', 'temp']) {
            await fsp.mkdir(path.join(h.root, d), { recursive: true });
        }
        prevConfig = configModule._pushTestConfig(makeConfig(h.root));

        const dbModule = require('../core/database.js');
        prevMessageDb = dbModule.dbs.message;
        h.db = new Database(':memory:');
        h.db.pragma('foreign_keys = ON');
        dbModule.initMessageDatabase(h.db);
        dbModule.dbs.message = h.db;

        prevLog = loggerModule.log;
        const collect =
            level =>
            (...a) =>
                h.logged.push({ level, a });
        loggerModule.log = Object.assign({}, prevLog, {
            trace: () => {},
            debug: () => {},
            info: () => {},
            warn: collect('warn'),
            error: collect('error'),
            child: () => loggerModule.log,
        });

        //  Machine-dependent kludges, fixed (see ftn_export_equivalence.test.js).
        ftnUtil = require('../core/ftn_util.js');
        savedFtnUtil = {
            getProductIdentifier: ftnUtil.getProductIdentifier,
            getTearLine: ftnUtil.getTearLine,
            getUTCTimeZoneOffset: ftnUtil.getUTCTimeZoneOffset,
            getMessageSerialNumber: ftnUtil.getMessageSerialNumber,
            getOrigin: ftnUtil.getOrigin,
        };
        ftnUtil.getProductIdentifier = () => 'ENiGMA1/2 TEST (test; test; test)';
        ftnUtil.getTearLine = () => '--- ENiGMA 1/2 TEST';
        ftnUtil.getUTCTimeZoneOffset = () => '-0500';
        //  ftn_util reads the board name through whichever config accessor
        //  was installed when it was first required, which depends on the
        //  order test files load in
        const Address = require('../core/ftn_address.js');
        ftnUtil.getOrigin = address =>
            ` * Origin: Test BBS (${new Address(address).toString('5D')})`;
        //  Packet file names only (MSGIDs reach the real one directly): a
        //  counter, so that names cannot collide (see ftn_export_equivalence.test.js).
        let packetSerial = 0;
        ftnUtil.getMessageSerialNumber = () =>
            (++packetSerial).toString(16).padStart(8, '0');

        RELOADED.forEach(m => delete require.cache[require.resolve(m)]);
        h.Message = require('../core/message.js');
        ({ getModule: h.getModule } = require('../core/scanner_tossers/ftn_bso.js'));
    };

    h.teardown = async () => {
        Object.assign(ftnUtil, savedFtnUtil);
        configModule._popTestConfig(prevConfig);
        loggerModule.log = prevLog;
        RELOADED.forEach(m => delete require.cache[require.resolve(m)]);
        require('../core/database.js').dbs.message = prevMessageDb;
        h.db.close();
        await fsp.rm(h.root, { recursive: true, force: true });
    };

    h.makeModule = () => {
        const mod = new h.getModule();
        mod.moduleConfig = makeConfig(h.root).scannerTossers.ftn_bso;
        mod.exportTempDir = path.join(h.root, 'temp');
        return mod;
    };

    const persist = message =>
        new Promise((resolve, reject) =>
            message.persist(err => (err ? reject(err) : resolve(message)))
        );

    let seq = 0;
    const timestamp = () =>
        `2026-10-01T12:${String(Math.floor(seq / 60) % 60).padStart(2, '0')}:${String(
            seq % 60
        ).padStart(2, '0')}.000-05:00`;

    //  A message written on this system: no state flags at all.
    h.addLocal = async ({ areaTag = 'local_a', subject, body, replyTo, kludges }) => {
        ++seq;
        const message = new h.Message({
            areaTag,
            toUserName: 'All',
            fromUserName: 'Local User',
            subject: subject || `local ${seq}`,
            message: body || `Local body ${seq}.\r\nSecond line.`,
            modTimestamp: timestamp(),
            replyToMsgId: replyTo ? replyTo.messageId : 0,
        });
        if (kludges) {
            message.meta.FtnKludge = kludges;
        }
        return persist(message);
    };

    //  A message the tosser imported: Imported, origin, SEEN-BY, PATH.
    h.addImported = async ({
        areaTag,
        origin = U1,
        seenBy,
        path: pathLines,
        msgId,
        kludges = {},
        subject,
        body,
    }) => {
        ++seq;
        const message = new h.Message({
            areaTag,
            toUserName: 'All',
            fromUserName: 'Upstream',
            subject: subject || `relayed ${seq}`,
            message: body || `Relayed body ${seq}.`,
            modTimestamp: timestamp(),
        });
        const [, , net, node] = /^(\d+):(\d+)\/(\d+)/.exec(origin);
        message.meta.System.state_flags0 = h.Message.StateFlags0.Imported.toString();
        message.meta.FtnProperty = {
            ftn_orig_network: net,
            ftn_orig_node: node,
            ftn_area: AREAS[areaTag].tag,
        };
        if (seenBy) {
            message.meta.FtnProperty.ftn_seen_by = seenBy;
        }
        message.meta.FtnKludge = Object.assign({}, kludges);
        if (msgId) {
            message.meta.FtnKludge.MSGID = msgId;
        }
        if (pathLines) {
            message.meta.FtnKludge.PATH = pathLines;
        }
        return persist(message);
    };

    const run = (mod, method, ...args) =>
        new Promise(resolve => mod[method](...args, (err, res) => resolve({ err, res })));

    h.runExportScan = mod => run(mod, 'performEchoMailExport');
    h.runRelay = mod => run(mod, 'performEchoMailRelayExport');
    h.runLiveExport = (mod, message) =>
        run(
            mod,
            'exportEchoMailMessagesToUplinks',
            [message.messageUuid],
            AREAS[message.areaTag],
            AREAS[message.areaTag].uplinks
        );

    //
    //  The whole fixture, through all three callers. Returns the messages by
    //  name.
    //
    h.runAllCallers = async ({ beforeEachCaller, afterEachCaller } = {}) => {
        const m = {};
        const mod = h.makeModule();
        const step = async name => {
            if (beforeEachCaller) {
                await beforeEachCaller(name);
            }
        };
        const done = async name => {
            if (afterEachCaller) {
                await afterEachCaller(name);
            }
        };

        //  Relay starts from where an area is when first seen.
        await h.addImported({ areaTag: 'relay_a', msgId: '1:218/701 00000001' });
        await h.addImported({ areaTag: 'relay_b', msgId: '1:218/701 00000002' });
        await h.runRelay(mod);

        //  (a) export scan: local mail in one area with three uplinks
        m.L1 = await h.addLocal({ subject: 'plain' });
        //  a QWK reply can carry FTN kludges of its own, but no MSGID
        m.L2 = await h.addLocal({
            subject: 'qwk reply',
            kludges: { PID: 'QWKREADER 1.0', CHRS: 'CP437 2' },
        });
        //  answers L1, whose MSGID does not exist until this run mints it
        m.L3 = await h.addLocal({ subject: 'Re: plain', replyTo: m.L1 });
        //  kept from an earlier, failed export
        m.L4 = await h.addLocal({
            subject: 'retried',
            kludges: { MSGID: '1:218/700 deadbeef' },
        });
        m.L5 = await h.addLocal({
            subject: 'accents',
            body: 'Café, naïve, über ░▒▓ — and £ sign.',
        });
        m.L6 = await h.addLocal({
            subject: 'large',
            body: Array.from(
                { length: 30 },
                (_, i) => `Line ${i} of a message larger than a whole packet.`
            ).join('\r\n'),
        });
        m.L7 = await h.addLocal({ subject: 'after large' });
        await step('exportScan');
        m.exportScan = await h.runExportScan(mod);
        await done('exportScan');

        //  (b) relay: groups per destination overlap
        //  larger than a packet, and the first thing U2 and our point get:
        //  the exporter writes an empty packet ahead of it
        m.R1 = await h.addImported({
            areaTag: 'relay_a',
            seenBy: '218/701',
            msgId: '1:218/701 0000aa01',
            body: Array.from(
                { length: 30 },
                (_, i) => `Relayed line ${i}, more than a packet's worth in all.`
            ).join('\r'),
        });
        m.R2 = await h.addImported({
            areaTag: 'relay_a',
            seenBy: '218/701 702',
            msgId: '1:218/701 0000aa02',
        });
        m.R3 = await h.addImported({
            areaTag: 'relay_b',
            seenBy: '218/701',
            msgId: '1:218/701 0000aa03',
            path: '218/701',
        });
        //  arrived without a MSGID, so relay mints one; goes to U1 and U3
        m.R4 = await h.addImported({
            areaTag: 'relay_b',
            origin: PEER2,
            seenBy: '218/704',
            kludges: { PID: 'OTHER 1.0', TZUTC: '0100', CHRS: 'UTF-8 4' },
        });
        //  several SEEN-BY and PATH lines: each destination appends to them
        m.R5 = await h.addImported({
            areaTag: 'relay_a',
            seenBy: ['218/701', '218/999'],
            path: ['218/701', '218/999'],
            msgId: '1:218/701 0000aa05',
        });
        await step('relay');
        m.relay = await h.runRelay(mod);
        await done('relay');

        //  (c) live export of one new message
        m.L8 = await h.addLocal({ subject: 'live' });
        await step('live');
        m.live = await h.runLiveExport(mod, m.L8);
        await done('live');

        return m;
    };

    //
    //  Everything each destination was given, in the order it was given:
    //  { "<flow file>": [ "<masked packet>", ... ] }.
    //
    h.collectDelivered = async () => {
        const base = path.join(h.root, 'outbound');
        const out = {};
        async function walk(dir) {
            const entries = await fsp
                .readdir(dir, { withFileTypes: true })
                .catch(() => []);
            for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) {
                    await walk(p);
                } else if (/\.[a-z]lo$/i.test(e.name)) {
                    const refs = (await fsp.readFile(p, 'utf8'))
                        .split('\n')
                        .filter(Boolean);
                    const packets = [];
                    for (const ref of refs) {
                        const file = ref.replace(/^[\^#~!@-]/, '');
                        packets.push({
                            directive: ref[0],
                            name: path
                                .basename(file)
                                .replace(/^[0-9a-f]{8}/i, '########'),
                            dir: path.relative(base, path.dirname(file)),
                            data: maskPacket(await fsp.readFile(file)),
                        });
                    }
                    //  Sorted: within one export the exporter moves its
                    //  packets into outbound in parallel, so the order of
                    //  their references in the flow file is whichever move
                    //  finished first, before WP4 as after it.
                    out[path.relative(base, p)] = packets.sort((a, b) =>
                        a.data < b.data ? -1 : a.data > b.data ? 1 : 0
                    );
                }
            }
        }
        await walk(base);
        return out;
    };

    //  What the run left in the base for each message, minted serials masked.
    h.collectStored = messages => {
        const out = {};
        for (const [name, message] of Object.entries(messages)) {
            if (!message || !message.messageId) {
                continue;
            }
            out[name] = h.db
                .prepare(
                    `SELECT meta_category, meta_name, meta_value FROM message_meta
                    WHERE message_id = ? AND (meta_category = 'System' OR meta_name = 'MSGID')
                    ORDER BY meta_category, meta_name, meta_value;`
                )
                .all(message.messageId)
                .map(
                    r => `${r.meta_category}.${r.meta_name}=${maskSerials(r.meta_value)}`
                );
        }
        return out;
    };

    h.storedMsgId = message => {
        const rows = h.db
            .prepare(
                `SELECT meta_value FROM message_meta
                WHERE message_id = ? AND meta_category = 'FtnKludge' AND meta_name = 'MSGID';`
            )
            .all(message.messageId);
        return rows.map(r => r.meta_value);
    };

    return h;
}

function maskSerials(s) {
    return s.replace(/(\S+@\S+ )[0-9a-f]{8}/g, '$1########');
}

//  A packed message's DateTime field ("01 Oct 26  12:00:03"): the message's
//  own timestamp, rendered in the local time zone of whoever runs the test.
const FTN_DATE_TIME_RE = /\d{2} [A-Z][a-z]{2} \d{2} {2}\d{2}:\d{2}:\d{2}/g;

function maskDateTimes(s) {
    return s.replace(FTN_DATE_TIME_RE, '## ### ##  ##:##:##');
}

function maskPacket(buf) {
    const b = Buffer.from(buf);
    b.fill(0, 4, 16); //  packet header creation date/time
    return maskDateTimes(maskSerials(b.toString('latin1')));
}

module.exports = {
    createHarness,
    maskPacket,
    NODES,
    AREAS,
    U1,
    U2,
    U3,
    PEER2,
    POINT,
    LOCAL,
};
