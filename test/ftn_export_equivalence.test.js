'use strict';

//
//  What every EchoMail destination receives, byte for byte.
//
//  The exporter's three callers -- the export scan of locally written mail,
//  EchoMail relay, and the live export of one new message -- run here over one
//  fixture: an area with three uplinks that differ in packet type, encoding,
//  export type and file case, and a relay batch whose per-destination groups
//  overlap. Every packet each destination was given is read back through its
//  flow file, in order, and compared with test/fixtures/ftn_export_equivalence
//  /expected.json, which was captured from the exporter as it was before it
//  was reworked to load and flag each message once (WP4). Nothing about what
//  a destination receives was meant to change; this is the proof.
//
//  Ignored, because they are time-derived by nature:
//    * packet header creation date and time (bytes 4-15 of every packet);
//    * each packed message's DateTime field, which renders the message's
//      timestamp in the local time zone of the machine running the test;
//    * packet file names (a serial number hashed from the current
//      millisecond); and the order of packet references within a flow
//      file, which the exporter has always left to whichever parallel move
//      finished first -- so each destination's packets are compared as a
//      sorted list;
//    * the serial number of a MSGID minted during the run, and of a REPLY
//      naming one: "<id>.<area>@<addr> ########". That every destination got
//      the SAME minted MSGID, and that it is the one stored, is asserted
//      separately.
//
//  Packet file names come from ftnUtil.getMessageSerialNumber, a hash of the
//  current millisecond and the message ID. The exporter as it was could pick
//  the same name for two destinations sharing an outbound directory when
//  both packetised the same first message within one millisecond, and the
//  second move then failed ("dest already exists"); a fast test machine does
//  exactly that. Here the names come from a counter instead, so this suite
//  compares content; ftn_export_load_once.test.js covers the collision.
//
//  Fixed rather than ignored, because they depend on the machine rather than
//  on the exporter: the TID kludge and tear line (version, platform, Node.js
//  version), TZUTC (local time zone) and the origin line's board name (read
//  through a config accessor captured at first require, so it depends on
//  test file load order) are stubbed to constants, which also
//  keeps message sizes -- and so where packets split -- the same everywhere.
//
//  To recapture (only when a change to the output is intended):
//      UPDATE_FTN_EXPORT_EXPECTED=1 npx mocha --require test/setup.js \
//          test/ftn_export_equivalence.test.js
//

const { strict: assert } = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { createHarness } = require('./ftn_export_harness.js');

const EXPECTED_PATH = path.join(
    __dirname,
    'fixtures',
    'ftn_export_equivalence',
    'expected.json'
);

describe('ftn_bso — EchoMail export output per destination (WP4 equivalence)', function () {
    this.timeout(20000);

    const h = createHarness();
    before(() => h.setup('ftnequiv'));
    after(() => h.teardown());

    let messages;
    let delivered;

    before(async () => {
        messages = await h.runAllCallers();
        delivered = await h.collectDelivered();
    });

    it('every caller reports success', () => {
        for (const caller of ['exportScan', 'relay', 'live']) {
            assert.ok(
                !messages[caller].err,
                `${caller}: ${messages[caller].err && messages[caller].err.message}`
            );
        }
        assert.deepEqual(h.logged, [], 'nothing logged as a problem');
    });

    it('gives each destination exactly what the pre-WP4 exporter gave it', () => {
        const actual = {
            delivered,
            stored: h.collectStored(messages),
        };

        if (process.env.UPDATE_FTN_EXPORT_EXPECTED) {
            fs.mkdirSync(path.dirname(EXPECTED_PATH), { recursive: true });
            fs.writeFileSync(EXPECTED_PATH, JSON.stringify(actual, null, 2) + '\n');
        }

        const expected = JSON.parse(fs.readFileSync(EXPECTED_PATH, 'utf8'));
        assert.deepEqual(Object.keys(actual.delivered), Object.keys(expected.delivered));
        for (const flowFile of Object.keys(expected.delivered)) {
            assert.deepEqual(
                actual.delivered[flowFile],
                expected.delivered[flowFile],
                `packets for ${flowFile}`
            );
        }
        assert.deepEqual(actual.stored, expected.stored);
    });

    it('gives every destination the same MSGID for a message, and stores that one', async () => {
        //  Read unmasked: every MSGID line in every delivered packet.
        const seen = {};
        const base = path.join(h.root, 'outbound');
        async function walk(dir) {
            for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) {
                    await walk(p);
                } else if (/\.pkt$/i.test(e.name)) {
                    const text = (await fsp.readFile(p)).toString('latin1');
                    for (const [, subject, msgId] of text.matchAll(
                        /\x00([^\x00]+)\x00(?:AREA:[^\r]*\r)?[^\x00]*?\x01MSGID: ([^\r]+)\r/g
                    )) {
                        (seen[subject] = seen[subject] || new Set()).add(msgId);
                    }
                }
            }
        }
        await walk(base);

        for (const [name, message] of Object.entries(messages)) {
            if (!message || !message.messageId || !seen[message.subject]) {
                continue;
            }
            const values = Array.from(seen[message.subject]);
            assert.equal(values.length, 1, `${name}: ${values.join(' | ')}`);
            assert.deepEqual(h.storedMsgId(message), values, `${name}: stored`);
        }
        //  and the fixture really exercises a minted MSGID going several ways
        assert.ok(seen[messages.L1.subject], 'L1 delivered');
        assert.ok(seen[messages.R4.subject], 'R4 delivered');
    });
});
