'use strict';

//
//  EchoMail export loads and flags each message once (WP4).
//
//  Before, the exporter ran once per destination: an area with N uplinks
//  loaded every message N times and wrote its Exported bit and MSGID N times,
//  in 2N commits, and relay did the same across its per-destination groups.
//  It now goes message by message, preparing a copy of each for every
//  destination it goes to. ftn_export_equivalence.test.js shows that what
//  each destination receives is unchanged; this covers what changed and the
//  hazards that come with it:
//
//    * the counts themselves;
//    * one MSGID for a message, minted once and stored before any packet
//      carrying it reaches outbound, and reused by a retry;
//    * packet names: destinations are now fed in the same millisecond;
//    * the per-destination copies share nothing;
//    * a failing destination is skipped, the rest carry on, and the call
//      fails.
//

const { strict: assert } = require('assert');
const fsp = require('fs/promises');
const path = require('path');

const { createHarness, AREAS, U1, U2, U3 } = require('./ftn_export_harness.js');

describe('ftn_bso — EchoMail export loads and flags each message once', function () {
    this.timeout(20000);

    const h = createHarness();
    before(() => h.setup('ftnloadonce'));
    after(() => h.teardown());

    let counts;
    let restore;

    beforeEach(async () => {
        h.logged.length = 0;
        h.db.exec(
            'DELETE FROM message_area_last_scan; DELETE FROM message_meta; DELETE FROM message;'
        );
        for (const d of ['outbound', 'temp']) {
            await fsp.rm(path.join(h.root, d), { recursive: true, force: true });
            await fsp.mkdir(path.join(h.root, d), { recursive: true });
        }
    });

    afterEach(() => {
        if (restore) {
            restore();
            restore = null;
        }
    });

    //  Count message loads, database transactions and the old per-uplink
    //  meta writes, from here on.
    function startCounting() {
        counts = { load: 0, transaction: 0, setStateFlags0Bit: 0, updateMetaValue: 0 };
        const proto = h.Message.prototype;
        const saved = {
            load: proto.load,
            setStateFlags0Bit: proto.setStateFlags0Bit,
            updateMetaValue: proto.updateMetaValue,
            transaction: h.db.transaction,
        };
        proto.load = function (...args) {
            ++counts.load;
            return saved.load.apply(this, args);
        };
        proto.setStateFlags0Bit = function (...args) {
            ++counts.setStateFlags0Bit;
            return saved.setStateFlags0Bit.apply(this, args);
        };
        proto.updateMetaValue = function (...args) {
            ++counts.updateMetaValue;
            return saved.updateMetaValue.apply(this, args);
        };
        h.db.transaction = function (fn) {
            const txn = saved.transaction.call(h.db, fn);
            return (...args) => {
                ++counts.transaction;
                return txn(...args);
            };
        };
        restore = () => {
            Object.assign(proto, {
                load: saved.load,
                setStateFlags0Bit: saved.setStateFlags0Bit,
                updateMetaValue: saved.updateMetaValue,
            });
            h.db.transaction = saved.transaction;
        };
    }

    function zeroCounts() {
        Object.keys(counts).forEach(k => {
            counts[k] = 0;
        });
    }

    async function packetsReferencedBy(flowFile) {
        const text = await fsp.readFile(flowFile, 'utf8');
        return text
            .split('\n')
            .filter(Boolean)
            .map(line => line.replace(/^[\^#~!@-]/, ''));
    }

    async function flowFiles() {
        const dir = path.join(h.root, 'outbound', 'outbound');
        return (await fsp.readdir(dir).catch(() => []))
            .filter(e => /\.[a-z]lo$/i.test(e))
            .map(e => path.join(dir, e));
    }

    function exportedFlag(message) {
        const row = h.db
            .prepare(
                `SELECT meta_value FROM message_meta
                WHERE message_id = ? AND meta_category = 'System' AND meta_name = 'state_flags0';`
            )
            .get(message.messageId);
        return row ? parseInt(row.meta_value, 10) : 0;
    }

    // ─── the counts ──────────────────────────────────────────────────────────

    it('loads each message once and records it in one transaction, for every caller', async () => {
        startCounting();
        const perCaller = {};
        const messages = await h.runAllCallers({
            beforeEachCaller: async () => zeroCounts(),
            afterEachCaller: async name => {
                perCaller[name] = Object.assign({}, counts);
            },
        });

        for (const caller of ['exportScan', 'relay', 'live']) {
            assert.ok(
                !messages[caller].err,
                messages[caller].err && messages[caller].err.message
            );
        }

        //  export scan: 7 messages to 3 uplinks -- was 21 loads, 21 + 21 commits
        assert.deepEqual(perCaller.exportScan, {
            load: 7,
            transaction: 7,
            setStateFlags0Bit: 0,
            updateMetaValue: 0,
        });
        //  relay: 5 messages in 8 (message, destination) pairs over 5 groups
        assert.deepEqual(perCaller.relay, {
            load: 5,
            transaction: 5,
            setStateFlags0Bit: 0,
            updateMetaValue: 0,
        });
        //  live export: 1 message to 3 uplinks
        assert.deepEqual(perCaller.live, {
            load: 1,
            transaction: 1,
            setStateFlags0Bit: 0,
            updateMetaValue: 0,
        });
    });

    // ─── MSGID ───────────────────────────────────────────────────────────────

    it('mints one MSGID for a new message, however many destinations it goes to', async () => {
        //  The serial number in a minted MSGID comes from the clock. Make
        //  every reading of it different, so a MSGID minted per destination
        //  could not pass for one minted once.
        const realNow = Date.now;
        let tick = realNow();
        Date.now = () => (tick += 7);
        let result;
        let message;
        try {
            message = await h.addLocal({ subject: 'minted once' });
            result = await h.runLiveExport(h.makeModule(), message);
        } finally {
            Date.now = realNow;
        }
        assert.ok(!result.err, result.err && result.err.message);

        const stored = h.storedMsgId(message);
        assert.equal(stored.length, 1);

        const seen = new Set();
        for (const flow of await flowFiles()) {
            for (const pkt of await packetsReferencedBy(flow)) {
                const text = (await fsp.readFile(pkt)).toString('latin1');
                for (const [, msgId] of text.matchAll(/\x01MSGID: ([^\r]+)\r/g)) {
                    seen.add(msgId);
                }
            }
        }
        assert.deepEqual(Array.from(seen), stored, 'every destination, the stored MSGID');
    });

    it('stores the MSGID before any packet carrying it reaches outbound', async () => {
        const mod = h.makeModule();
        const a = await h.addLocal({ subject: 'stored first a' });
        const b = await h.addLocal({ subject: 'stored first b' });

        const atDelivery = [];
        const deliver = mod.deliverEchoMailPackets;
        mod.deliverEchoMailPackets = function (dest, files, cb) {
            atDelivery.push([h.storedMsgId(a).length, h.storedMsgId(b).length]);
            return deliver.call(this, dest, files, cb);
        };

        const err = await new Promise(resolve =>
            mod.exportEchoMailMessagesToUplinks(
                [a.messageUuid, b.messageUuid],
                AREAS.local_a,
                AREAS.local_a.uplinks,
                resolve
            )
        );
        assert.ok(!err, err && err.message);
        assert.deepEqual(atDelivery, [
            [1, 1],
            [1, 1],
            [1, 1],
        ]);
    });

    it('reuses the stored MSGID when a failed export is retried', async () => {
        const message = await h.addLocal({ subject: 'retry me' });
        const outboundDir = path.join(h.root, 'outbound', 'outbound');
        await fsp.mkdir(outboundDir, { recursive: true });

        //  Packets are written and the message recorded, then the move into
        //  outbound fails for every uplink.
        await fsp.chmod(outboundDir, 0o500);
        let first;
        try {
            first = await h.runLiveExport(h.makeModule(), message);
        } finally {
            await fsp.chmod(outboundDir, 0o700);
        }
        assert.ok(first.err, 'the first attempt should fail');
        const minted = h.storedMsgId(message);
        assert.equal(minted.length, 1);

        const retry = await h.runLiveExport(h.makeModule(), message);
        assert.ok(!retry.err, retry.err && retry.err.message);
        assert.deepEqual(h.storedMsgId(message), minted, 'still the one MSGID');

        for (const flow of await flowFiles()) {
            for (const pkt of await packetsReferencedBy(flow)) {
                const text = (await fsp.readFile(pkt)).toString('latin1');
                assert.ok(text.includes(`\x01MSGID: ${minted[0]}\r`), pkt);
            }
        }
    });

    // ─── packet names ────────────────────────────────────────────────────────

    it('never lets two destinations sharing an outbound directory overwrite each other', async () => {
        //  All three uplinks are in zone 1, so share one outbound directory,
        //  and here every packet is offered the same name -- what happens for
        //  real when destinations open packets for the same message within
        //  one millisecond. A file of that name already waiting in outbound
        //  must not be touched either.
        const ftnUtil = require('../core/ftn_util.js');
        const savedSerial = ftnUtil.getMessageSerialNumber;
        ftnUtil.getMessageSerialNumber = () => '0000beef';

        const outboundDir = path.join(h.root, 'outbound', 'outbound');
        await fsp.mkdir(outboundDir, { recursive: true });
        const waiting = path.join(outboundDir, '0000beef.pkt');
        await fsp.writeFile(waiting, 'SOMEONE ELSE');

        const subjects = ['same name 1', 'same name 2', 'same name 3'];
        const messages = [];
        let err;
        try {
            for (const subject of subjects) {
                messages.push(await h.addLocal({ subject }));
            }
            err = await new Promise(resolve =>
                h.makeModule().exportEchoMailMessagesToUplinks(
                    messages.map(m => m.messageUuid),
                    AREAS.local_a,
                    AREAS.local_a.uplinks,
                    resolve
                )
            );
        } finally {
            ftnUtil.getMessageSerialNumber = savedSerial;
        }
        assert.ok(!err, err && err.message);
        assert.equal(await fsp.readFile(waiting, 'utf8'), 'SOMEONE ELSE');

        const flows = await flowFiles();
        assert.equal(flows.length, 3);
        const allRefs = [];
        for (const flow of flows) {
            const destNode = parseInt(path.basename(flow).slice(4, 8), 16);
            let delivered = '';
            for (const pkt of await packetsReferencedBy(flow)) {
                allRefs.push(pkt.toLowerCase());
                const data = await fsp.readFile(pkt);
                assert.equal(
                    data.readUInt16LE(2),
                    destNode,
                    `${pkt} is addressed to ${destNode}`
                );
                delivered += data.toString('latin1');
            }
            for (const subject of subjects) {
                assert.equal(
                    delivered.split(subject).length - 1,
                    1,
                    `${path.basename(flow)} gets "${subject}" once`
                );
            }
        }
        assert.equal(new Set(allRefs).size, allRefs.length, 'no packet is shared');
        assert.ok(!allRefs.includes(waiting.toLowerCase()));
    });

    // ─── copies ──────────────────────────────────────────────────────────────

    it('gives each destination a copy of the loaded message that shares nothing with it or the others', async () => {
        const {
            _cloneLoadedMessage: cloneLoadedMessage,
        } = require('../core/scanner_tossers/ftn_bso.js');
        const imported = await h.addImported({
            areaTag: 'relay_a',
            seenBy: ['218/701', '218/999'],
            path: ['218/701', '218/999'],
            msgId: '1:218/701 0000c0c0',
            kludges: { Via: ['a', 'b'] },
        });

        const load = () =>
            new Promise((resolve, reject) => {
                const m = new h.Message();
                m.load({ uuid: imported.messageUuid }, err =>
                    err ? reject(err) : resolve(m)
                );
            });
        const base = await load();
        const fresh = await load();

        const one = cloneLoadedMessage(base);
        const two = cloneLoadedMessage(base);
        assert.deepEqual(one, fresh, 'a copy is what a fresh load gives');
        assert.ok(one instanceof h.Message);
        assert.equal(one.isPrivate(), false);

        //  what prepareMessage() does to a copy, and worse
        h.makeModule().prepareMessage(one, {
            network: { localAddress: '1:218/700' },
            destAddress: require('../core/ftn_address.js').fromString(U2),
            nodeConfig: {},
        });
        one.meta.FtnProperty.ftn_seen_by.push('1/1');
        one.meta.FtnKludge.Via.push('c');
        one.meta.System.extra = 'x';
        one.modTimestamp.add(1, 'day');

        assert.deepEqual(base, fresh, 'the loaded message is untouched');
        assert.deepEqual(two, fresh, 'and so is every other copy');
    });

    // ─── failures ────────────────────────────────────────────────────────────

    it('skips a failing destination for the rest of the call, delivers to the rest, and fails', async () => {
        const mod = h.makeModule();
        const messages = [];
        for (const n of [1, 2, 3]) {
            messages.push(await h.addLocal({ subject: `partial ${n}` }));
        }

        //  U2 fails on the second message
        const prepare = mod.prepareMessage;
        const preparedFor = [];
        mod.prepareMessage = function (message, exportOpts) {
            const node = exportOpts.destAddress.node;
            preparedFor.push(`${message.subject}->${node}`);
            if (702 === node && 'partial 2' === message.subject) {
                throw new Error('U2 is broken');
            }
            return prepare.call(this, message, exportOpts);
        };

        const err = await new Promise(resolve =>
            mod.exportEchoMailMessagesToUplinks(
                messages.map(m => m.messageUuid),
                AREAS.local_a,
                AREAS.local_a.uplinks,
                resolve
            )
        );

        assert.ok(err, 'the call fails');
        assert.match(err.message, /1:218\/702/);
        assert.doesNotMatch(err.message, /1:218\/70[13]/);
        assert.ok(!preparedFor.includes('partial 3->702'), 'U2 is not tried again');
        assert.deepEqual(
            (await flowFiles()).map(f => path.basename(f)).sort(),
            ['00da02bd.clo', '00DA02BF.CLO'].sort(),
            'U1 and U3 got their mail; U2 got nothing'
        );
        for (const message of messages) {
            assert.equal(exportedFlag(message) & h.Message.StateFlags0.Exported, 2);
        }
        assert.ok(
            h.logged.some(
                l =>
                    /Failed exporting EchoMail to uplink/.test(l.a[1]) &&
                    '1:218/702' === l.a[0].uplink
            )
        );
    });

    it('fails every destination of a message that cannot be loaded, and loads nothing after it', async () => {
        startCounting();
        const mod = h.makeModule();
        const a = await h.addLocal({ subject: 'before gone' });
        const gone = await h.addLocal({ subject: 'gone' });
        const c = await h.addLocal({ subject: 'after gone' });
        h.db.prepare('DELETE FROM message WHERE message_id = ?;').run(gone.messageId);
        zeroCounts();

        const err = await new Promise(resolve =>
            mod.exportEchoMailMessagesToUplinks(
                [a.messageUuid, gone.messageUuid, c.messageUuid],
                AREAS.local_a,
                [U1, U2, U3],
                resolve
            )
        );

        assert.ok(err);
        assert.equal(counts.load, 2, 'the third message is never loaded');
        assert.deepEqual(await flowFiles(), [], 'nobody got a partial export');
        assert.equal(
            exportedFlag(a),
            h.Message.StateFlags0.Exported,
            'handed out, so flagged'
        );
        assert.equal(exportedFlag(c), 0);
    });

    it('delivers nothing for a message whose record cannot be written', async () => {
        const mod = h.makeModule();
        const message = await h.addLocal({ subject: 'unrecorded' });

        const proto = h.Message.prototype;
        const saved = proto.setStateFlags0BitAndMeta;
        proto.setStateFlags0BitAndMeta = (bit, values, cb) => cb(new Error('disk full'));
        let result;
        try {
            result = await h.runLiveExport(mod, message);
        } finally {
            proto.setStateFlags0BitAndMeta = saved;
        }

        assert.ok(result.err);
        assert.deepEqual(await flowFiles(), []);
        assert.deepEqual(h.storedMsgId(message), []);
    });
});
