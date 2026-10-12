'use strict';

//
//  A packet the tosser rejects must leave nothing behind in the message base.
//
//  The packet is parsed one message at a time, and the import used to store
//  each message as it went. A packet that failed part way through was then
//  rejected -- archived to the reject directory -- with the messages ahead of
//  the failure already imported. In the case that prompted this, the first
//  message's header fields held fragments of message text and it imported as
//  a garbage message in fsxNet General before the next one failed to parse.
//

const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const paths = require('path');

const { PacketHeader, Packet } = require('../core/ftn_mail_packet.js');

let FtnBso;

function packedMessage(toUserName) {
    const head = Buffer.alloc(14);
    head.writeUInt16LE(2, 0); //  messageType
    head.writeUInt16LE(100, 2);
    head.writeUInt16LE(121, 4);
    head.writeUInt16LE(1, 6);
    head.writeUInt16LE(1, 8);

    const date = Buffer.alloc(20);
    date.write('07 Oct 26  02:30:00\x00', 'ascii');

    const strings = Buffer.from(
        `${toUserName}\x00Someone\x00Subject\x00AREA:FSX_GEN\rBody\r\x00`,
        'ascii'
    );
    return Buffer.concat([head, date, strings]);
}

function writePacket(dir, toUserNames, trailer = Buffer.alloc(0)) {
    const ph = new PacketHeader();
    ph.origAddress = { zone: 21, net: 1, node: 100, point: 0 };
    ph.destAddress = { zone: 21, net: 1, node: 121, point: 0 };

    const packetPath = paths.join(dir, 'test.pkt');
    fs.writeFileSync(
        packetPath,
        Buffer.concat([
            new Packet().getPacketHeaderBuffer(ph),
            ...toUserNames.map(packedMessage),
            Buffer.from([0x00, 0x00]),
            trailer,
        ])
    );
    return packetPath;
}

describe('FTN BSO packet import — rejected packets import nothing', () => {
    before(() => {
        FtnBso = require('../core/scanner_tossers/ftn_bso.js');
    });

    let dir;
    let imported;
    let inst;

    beforeEach(() => {
        dir = fs.mkdtempSync(paths.join(os.tmpdir(), 'ftn-pkt-import-'));
        imported = [];

        inst = new FtnBso.getModule();
        inst.getNetworkNameByAddress = () => 'fsxnet';
        inst.getNodeConfigByAddress = () => null;
        inst.getLocalAreaTagByFtnAreaTag = () => 'fsx_gen';
        inst.appendTearAndOrigin = () => {};
        inst.importMailToArea = (config, header, message, cb) => {
            imported.push(message);
            return cb(null);
        };
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    function importPacket(packetPath) {
        return new Promise(resolve => {
            inst.importMessagesFromPacketFile(packetPath, '', err => resolve(err));
        });
    }

    it('imports every message of a well formed packet', async () => {
        const err = await importPacket(writePacket(dir, ['All', 'Nigel Reed']));
        assert.ok(!err, err && err.message);
        assert.deepEqual(
            imported.map(m => m.toUserName),
            ['All', 'Nigel Reed']
        );
    });

    it('imports every message of a packet padded after its end marker', async () => {
        const err = await importPacket(
            writePacket(dir, ['All', 'Nigel Reed'], Buffer.alloc(32, 0x1a))
        );
        assert.ok(!err, err && err.message);
        assert.equal(imported.length, 2);
    });

    it('imports nothing when a later message is malformed', async () => {
        const err = await importPacket(writePacket(dir, ['All', '77\r\nTo: Richard H']));
        assert.match(err.message, /line break/);
        assert.equal(imported.length, 0);
    });

    it('imports nothing when the packet is truncated mid-message', async () => {
        const packetPath = writePacket(dir, ['All', 'Nigel Reed']);
        const full = fs.readFileSync(packetPath);
        fs.writeFileSync(packetPath, full.subarray(0, full.length - 30));

        const err = await importPacket(packetPath);
        assert.ok(err, 'expected the truncated packet to be rejected');
        assert.equal(imported.length, 0);
    });
});
