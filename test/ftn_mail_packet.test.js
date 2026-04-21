'use strict';

const { strict: assert } = require('assert');
const moment = require('moment');
const iconv = require('iconv-lite');

//  Mock the logger before loading any module that uses it
const loggerModule = require('../core/logger.js');
if (!loggerModule.log) {
    loggerModule.log = { warn() {}, info() {}, debug() {}, trace() {}, error() {} };
}

const { PacketHeader, Packet } = require('../core/ftn_mail_packet.js');

// -------------------------------------------------------------------------
// PacketHeader — month field (Bug 1)
// -------------------------------------------------------------------------

describe('PacketHeader.created — month is 0-based on wire (FTS-0001.016)', () => {
    it('stores month 0-based when setting created (January = 0)', () => {
        const ph = new PacketHeader();
        ph.created = moment({ year: 2024, month: 0, date: 1 }); // January
        assert.equal(
            ph.month,
            0,
            `expected month=0 on wire for January, got ${ph.month}`
        );
    });

    it('stores month 0-based when setting created (December = 11)', () => {
        const ph = new PacketHeader();
        ph.created = moment({ year: 2024, month: 11, date: 15 }); // December
        assert.equal(
            ph.month,
            11,
            `expected month=11 on wire for December, got ${ph.month}`
        );
    });

    it('round-trips: setting then reading created preserves month', () => {
        for (let m = 0; m < 12; m++) {
            const ph = new PacketHeader();
            const original = moment({
                year: 2024,
                month: m,
                date: 1,
                hour: 12,
                minute: 0,
                second: 0,
            });
            ph.created = original;
            const readBack = ph.created;
            assert.equal(
                readBack.month(),
                m,
                `month ${m} round-trip failed: got ${readBack.month()}`
            );
        }
    });

    it('packet reader preserves month: wire value 3 → April (month 3)', () => {
        const ph = new PacketHeader();
        //  Simulate what the binary parser populates (raw wire values)
        ph.year = 2024;
        ph.month = 3; //  April on wire (0-based)
        ph.day = 15;
        ph.hour = 10;
        ph.minute = 30;
        ph.second = 0;
        const created = ph.created;
        assert.equal(created.month(), 3, `expected April (3), got ${created.month()}`);
    });
});

// -------------------------------------------------------------------------
// PacketHeader.origAddress — FSC-0048 point encoding (Issue 4)
// -------------------------------------------------------------------------

describe('PacketHeader.origAddress — FSC-0048 point encoding', () => {
    it('non-point address: origNet = net, auxNet = 0', () => {
        const ph = new PacketHeader();
        ph.origAddress = { node: 1, net: 104, zone: 1, point: 0 };
        assert.equal(ph.origNet, 104);
        assert.equal(ph.auxNet, 0);
    });

    it('point address: origNet = 0xFFFF, auxNet = real net', () => {
        const ph = new PacketHeader();
        ph.origAddress = { node: 1, net: 104, zone: 1, point: 5 };
        assert.equal(ph.origNet, 0xffff, `expected 0xFFFF for point, got ${ph.origNet}`);
        assert.equal(ph.auxNet, 104, `expected auxNet=104, got ${ph.auxNet}`);
    });

    it('origAddress getter restores real net from auxNet when point is set', () => {
        const ph = new PacketHeader();
        ph.origAddress = { node: 1, net: 104, zone: 1, point: 5 };
        const readBack = ph.origAddress;
        assert.equal(readBack.net, 104);
        assert.equal(readBack.node, 1);
    });
});

// -------------------------------------------------------------------------
// Packet.getPacketHeaderBuffer — prodRevLo/Hi byte order (Bug 2)
// -------------------------------------------------------------------------

describe('getPacketHeaderBuffer — prodRevLo at offset 25, prodRevHi at offset 43', () => {
    it('writes prodRevLo at offset 25 and prodRevHi at offset 43', () => {
        const ph = new PacketHeader();
        ph.prodRevLo = 0xab;
        ph.prodRevHi = 0xcd;
        const buf = new Packet().getPacketHeaderBuffer(ph);
        assert.equal(
            buf[25],
            0xab,
            `offset 25 should be prodRevLo (0xAB), got 0x${buf[25].toString(16)}`
        );
        assert.equal(
            buf[43],
            0xcd,
            `offset 43 should be prodRevHi (0xCD), got 0x${buf[43].toString(16)}`
        );
    });

    it('writePacketHeader produces the same buffer as getPacketHeaderBuffer', () => {
        const ph = new PacketHeader();
        ph.prodRevLo = 0x12;
        ph.prodRevHi = 0x34;
        const pkt = new Packet();
        const directBuf = pkt.getPacketHeaderBuffer(ph);
        const chunks = [];
        const fakeWs = { write: chunk => chunks.push(chunk) };
        pkt.writePacketHeader(ph, fakeWs);
        assert.equal(chunks.length, 1);
        assert.ok(
            directBuf.equals(chunks[0]),
            'writePacketHeader should produce same buffer as getPacketHeaderBuffer'
        );
    });
});

// -------------------------------------------------------------------------
// processMessageBody — kludge line parsing
// -------------------------------------------------------------------------

function makeMessageBody(lines) {
    //  FTN message body: lines joined by CR (0x0D), null-terminated, encoded CP437
    const text = lines.join('\r') + '\r\0';
    return iconv.encode(text, 'CP437');
}

function processBody(buf) {
    return new Promise((resolve, reject) => {
        new Packet().processMessageBody(buf, data => {
            resolve(data);
        });
    });
}

describe('processMessageBody — kludge line parsing', () => {
    it('parses a standard Via kludge (mixed case)', async () => {
        const buf = makeMessageBody(['\x01Via 2:123/456.0 19960101.120000 ENiGMA 0.0']);
        const data = await processBody(buf);
        assert.ok(data.kludgeLines['Via'], 'Via kludge should be stored under "Via" key');
    });

    it('parses Via kludge regardless of input case (VIA, via)', async () => {
        for (const prefix of ['Via', 'VIA', 'via']) {
            const buf = makeMessageBody([`\x01${prefix} 2:123/456.0 testval`]);
            const data = await processBody(buf);
            assert.ok(
                data.kludgeLines['Via'],
                `"${prefix}" should be normalized to "Via" key, got keys: ${Object.keys(data.kludgeLines).join(', ')}`
            );
        }
    });

    it('parses AREA: line without ^A prefix', async () => {
        const buf = makeMessageBody(['AREA:MYECHO', 'Hello World']);
        const data = await processBody(buf);
        assert.equal(data.area, 'MYECHO');
    });

    it('parses AREA: line WITH ^A prefix (some implementations use this)', async () => {
        const buf = makeMessageBody(['\x01AREA:MYECHO', 'Hello World']);
        const data = await processBody(buf);
        assert.equal(
            data.area,
            'MYECHO',
            `^AAREA: should populate area, got: "${data.area}"`
        );
    });

    it('^AAREA: does not leak into kludgeLines', async () => {
        const buf = makeMessageBody(['\x01AREA:MYECHO', 'Hello World']);
        const data = await processBody(buf);
        assert.ok(!data.kludgeLines['AREA'], 'AREA should not appear in kludgeLines');
    });

    it('parses INTL kludge (no colon separator)', async () => {
        const buf = makeMessageBody(['\x01INTL 1:200/7 1:104/1']);
        const data = await processBody(buf);
        assert.ok(data.kludgeLines['INTL'], 'INTL kludge should be parsed');
    });

    it('parses regular colon-separated kludge', async () => {
        const buf = makeMessageBody(['\x01MSGID: 1:104/1 abcdef12']);
        const data = await processBody(buf);
        assert.equal(data.kludgeLines['MSGID'], '1:104/1 abcdef12');
    });

    it('parses SEEN-BY lines', async () => {
        const buf = makeMessageBody([
            'AREA:TEST',
            'Hello',
            'SEEN-BY: 104/1 501',
            'SEEN-BY: 200/7',
        ]);
        const data = await processBody(buf);
        assert.equal(data.seenBy.length, 2);
        assert.equal(data.seenBy[0], '104/1 501');
        assert.equal(data.seenBy[1], '200/7');
    });

    it('preserves regular message lines', async () => {
        const buf = makeMessageBody(['Hello World', 'Line two']);
        const data = await processBody(buf);
        assert.ok(data.message.includes('Hello World'));
        assert.ok(data.message.includes('Line two'));
    });
});
