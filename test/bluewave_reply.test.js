'use strict';

const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const paths = require('path');
const iconv = require('iconv-lite');

const configModule = require('../core/config.js');
const { WellKnownAreaTags } = require('../core/message_const.js');
const {
    BlueWavePacketReader,
    ReplyRecordLength,
    buildEchoTagMap,
} = require('../core/bluewave_mail_packet.js');

//
//  Blue Wave reply structures, from bluewave.h "Version 3 - November 30,
//  1995". The offsets here are written out by hand rather than taken from
//  the module under test, so a field that moves fails the test instead of
//  moving with it.
//
const Upl = {
    HeaderLen: 112,
    RecLen: 114,
    LoginName: 116,
    AliasName: 160,
    ReaderName: 32,
    ReaderVersion: 10,
    TearName: 204,
    NotRegistered: 222,
};

const UplRec = {
    From: 0,
    To: 36,
    Subject: 72,
    DestZone: 144,
    DestNet: 146,
    DestNode: 148,
    DestPoint: 150,
    MsgAttr: 152,
    NetMailAttr: 154,
    UnixDate: 156,
    ReplyTo: 160,
    FileName: 164,
    EchoTag: 177,
    AreaFlags: 198,
    NetworkType: 219,
    NetDest: 220,
};

const UpiRec = {
    From: 0,
    To: 36,
    Subject: 72,
    UnixDate: 144,
    FileName: 148,
    EchoTag: 161,
    Flags: 182,
};

const NetRec = {
    From: 0,
    To: 36,
    Subject: 72,
    Node: 166,
    Net: 174,
    Reply: 184,
    Attr: 186,
    FileName: 190,
    EchoTag: 203,
    Zone: 224,
    Point: 226,
    UnixDate: 228,
};

const writeFixed = (buf, offset, value, length) => {
    buf.fill(0, offset, offset + length);
    const encoded = iconv.encode(value, 'cp437');
    encoded.copy(buf, offset, 0, Math.min(encoded.length, length - 1));
};

const makeTempDir = () => fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-bwreply-test-'));

//  the reply text a reader writes: CP437 with bare CR line endings
const writeText = (dir, fileName, text) =>
    fs.writeFileSync(
        paths.join(dir, fileName),
        iconv.encode(text.replace(/\n/g, '\r'), 'cp437')
    );

const uplHeader = ({ loginName = 'anne', aliasName = 'anne' } = {}) => {
    const header = Buffer.alloc(ReplyRecordLength.UplHeader);
    header.writeUInt16LE(ReplyRecordLength.UplHeader, Upl.HeaderLen);
    header.writeUInt16LE(ReplyRecordLength.UplRec, Upl.RecLen);
    writeFixed(header, Upl.LoginName, loginName, 44);
    writeFixed(header, Upl.AliasName, aliasName, 44);
    writeFixed(header, Upl.ReaderName, 'Test Offline Reader', 80);
    writeFixed(header, Upl.TearName, 'TestMail', 16);

    //  a reader writes each byte of the version ten lower than it is
    const version = Buffer.from('2.11', 'ascii');
    for (let i = 0; i < version.length; ++i) {
        header.writeUInt8((version[i] - 10) & 0xff, Upl.ReaderVersion + i);
    }

    return header;
};

const uplRec = ({
    from = 'Anne',
    to = 'Bob',
    subject = 'Re: testing',
    fileName = '00000001.MSG',
    echoTag = 'GENERAL',
    unixDate = 1700000000,
    msgAttr = 0,
    networkType = 0,
    netDest = '',
    replyTo = 0,
    destination = {},
} = {}) => {
    const rec = Buffer.alloc(ReplyRecordLength.UplRec);
    writeFixed(rec, UplRec.From, from, 36);
    writeFixed(rec, UplRec.To, to, 36);
    writeFixed(rec, UplRec.Subject, subject, 72);
    rec.writeUInt16LE(destination.zone || 0, UplRec.DestZone);
    rec.writeUInt16LE(destination.net || 0, UplRec.DestNet);
    rec.writeUInt16LE(destination.node || 0, UplRec.DestNode);
    rec.writeUInt16LE(destination.point || 0, UplRec.DestPoint);
    rec.writeUInt16LE(msgAttr, UplRec.MsgAttr);
    rec.writeUInt32LE(unixDate, UplRec.UnixDate);
    rec.writeUInt32LE(replyTo, UplRec.ReplyTo);
    writeFixed(rec, UplRec.FileName, fileName, 13);
    writeFixed(rec, UplRec.EchoTag, echoTag, 21);
    rec.writeUInt8(networkType, UplRec.NetworkType);
    writeFixed(rec, UplRec.NetDest, netDest, 100);
    return rec;
};

//  every echotag in these packets maps to an area of the same name
const areaTagForEchoTag = echoTag => {
    const known = {
        GENERAL: 'general',
        FIDO_ECHO: 'fido_echo',
        NEWSGROUP: 'newsgroup',
        PRIVATE_MAIL: WellKnownAreaTags.Private,
    };
    return known[echoTag.toUpperCase()];
};

const readPacket = (dir, options, cb) => {
    const reader = new BlueWavePacketReader(
        null,
        Object.assign({ areaTagForEchoTag }, options)
    );

    const messages = [];
    const warnings = [];
    const fileRequests = [];
    let readerInfo = null;
    let packetUser = null;

    reader.on('message', (message, info) => messages.push({ message, info }));
    reader.on('warning', warning => warnings.push(warning));
    reader.on('file request', fileName => fileRequests.push(fileName));
    reader.on('reader', info => (readerInfo = info));
    reader.on('packet user', user => (packetUser = user));

    reader.readExtracted(dir, err =>
        cb(err, { messages, warnings, fileRequests, readerInfo, packetUser })
    );
};

describe('Blue Wave reply packets', () => {
    describe('level 3 (*.UPL)', () => {
        it('reads a reply back out of the packet', done => {
            const dir = makeTempDir();
            writeText(dir, '00000001.MSG', 'First line.\nSecond line.\n');
            fs.writeFileSync(
                paths.join(dir, 'ENIGMA.UPL'),
                Buffer.concat([uplHeader(), uplRec()])
            );

            readPacket(dir, {}, (err, result) => {
                assert.equal(err, null);
                assert.equal(result.messages.length, 1);

                const { message, info } = result.messages[0];
                assert.equal(message.areaTag, 'general');
                assert.equal(message.fromUserName, 'Anne');
                assert.equal(message.toUserName, 'Bob');
                assert.equal(message.subject, 'Re: testing');
                //  bare CRs become the line endings ENiGMA½ stores
                assert.equal(message.message, 'First line.\nSecond line.');
                assert.equal(message.modTimestamp.unix(), 1700000000);
                assert.equal(info.echoTag, 'GENERAL');
                assert.equal(info.private, false);
                assert.equal(info.netMail, false);
                assert.equal(message.meta.BlueWaveProperty.bw_echotag, 'GENERAL');
                done();
            });
        });

        it('reports the reader and the name the packet was built for', done => {
            const dir = makeTempDir();
            writeText(dir, '00000001.MSG', 'Body.');
            fs.writeFileSync(
                paths.join(dir, 'ENIGMA.UPL'),
                Buffer.concat([
                    uplHeader({ loginName: 'anne', aliasName: 'Anne Onymous' }),
                    uplRec(),
                ])
            );

            readPacket(dir, {}, (err, result) => {
                assert.equal(err, null);
                assert.equal(result.packetUser.loginName, 'anne');
                assert.equal(result.packetUser.aliasName, 'Anne Onymous');
                assert.equal(result.readerInfo.name, 'Test Offline Reader');
                assert.equal(result.readerInfo.tearName, 'TestMail');
                //  the version is stored with 10 added to every byte
                assert.equal(result.readerInfo.version, '2.11');
                done();
            });
        });

        //
        //  The four bytes below are what NoCarrierMail 0.55 wrote into a
        //  packet here: "&$++" for version 0.55. The kit describes this
        //  encoding the wrong way round, so reading it as the kit says
        //  produces control characters.
        //
        it('decodes a version the way a reader actually writes it', done => {
            const dir = makeTempDir();
            writeText(dir, '00000.MSG', 'Body.');

            const header = uplHeader();
            Buffer.from('&$++', 'ascii').copy(header, Upl.ReaderVersion);
            header.fill(0, Upl.ReaderVersion + 4, Upl.ReaderVersion + 20);

            fs.writeFileSync(
                paths.join(dir, 'ENIGMA.UPL'),
                Buffer.concat([header, uplRec({ fileName: '00000.MSG' })])
            );

            readPacket(dir, {}, (err, result) => {
                assert.equal(err, null);
                assert.equal(result.readerInfo.version, '0.55');
                done();
            });
        });

        it('does not import a record flagged inactive', done => {
            const dir = makeTempDir();
            writeText(dir, '00000001.MSG', 'Kept.');
            writeText(dir, '00000002.MSG', 'Discarded.');
            fs.writeFileSync(
                paths.join(dir, 'ENIGMA.UPL'),
                Buffer.concat([
                    uplHeader(),
                    uplRec({ fileName: '00000001.MSG' }),
                    uplRec({ fileName: '00000002.MSG', msgAttr: 0x0001 }),
                ])
            );

            readPacket(dir, {}, (err, result) => {
                assert.equal(err, null);
                assert.equal(result.messages.length, 1);
                assert.equal(result.messages[0].message.message, 'Kept.');
                done();
            });
        });

        it('carries the private flag', done => {
            const dir = makeTempDir();
            writeText(dir, '00000001.MSG', 'For your eyes only.');
            fs.writeFileSync(
                paths.join(dir, 'ENIGMA.UPL'),
                Buffer.concat([
                    uplHeader(),
                    uplRec({ echoTag: 'PRIVATE_MAIL', msgAttr: 0x0002 }),
                ])
            );

            readPacket(dir, {}, (err, result) => {
                assert.equal(err, null);
                assert.equal(result.messages[0].info.private, true);
                assert.equal(
                    result.messages[0].message.areaTag,
                    WellKnownAreaTags.Private
                );
                done();
            });
        });

        it('addresses FidoNet netmail from the destination fields', done => {
            const dir = makeTempDir();
            writeText(dir, '00000001.MSG', 'Netmail body.');
            fs.writeFileSync(
                paths.join(dir, 'ENIGMA.UPL'),
                Buffer.concat([
                    uplHeader(),
                    uplRec({
                        echoTag: 'FIDO_ECHO',
                        msgAttr: 0x0010,
                        destination: { zone: 1, net: 234, node: 56, point: 7 },
                    }),
                ])
            );

            readPacket(dir, {}, (err, result) => {
                assert.equal(err, null);
                const { message, info } = result.messages[0];
                assert.equal(info.netMail, true);
                assert.equal(message.getRemoteToUser(), '1:234/56.7');
                done();
            });
        });

        it('addresses Internet mail from net_dest', done => {
            const dir = makeTempDir();
            writeText(dir, '00000001.MSG', 'Email body.');
            fs.writeFileSync(
                paths.join(dir, 'ENIGMA.UPL'),
                Buffer.concat([
                    uplHeader(),
                    uplRec({
                        echoTag: 'NEWSGROUP',
                        msgAttr: 0x0010,
                        networkType: 1,
                        netDest: 'someone@example.com',
                    }),
                ])
            );

            readPacket(dir, {}, (err, result) => {
                assert.equal(err, null);
                const { message } = result.messages[0];
                assert.equal(message.getRemoteToUser(), 'someone@example.com');
                assert.equal(message.getAddressFlavor(), 'email');
                done();
            });
        });

        it('lifts the Internet kludges out of the body', done => {
            const dir = makeTempDir();
            writeText(
                dir,
                '00000001.MSG',
                '\u0001X-Mailreader: Test\n' +
                    '\u0001References: <abc@example.com>\n' +
                    '\u0001Newsgroups: comp.test\n' +
                    'The actual body.\n'
            );
            fs.writeFileSync(
                paths.join(dir, 'ENIGMA.UPL'),
                Buffer.concat([
                    uplHeader(),
                    uplRec({ echoTag: 'NEWSGROUP', networkType: 1 }),
                ])
            );

            readPacket(dir, {}, (err, result) => {
                assert.equal(err, null);
                const { message } = result.messages[0];
                assert.equal(message.message, 'The actual body.');
                assert.equal(message.meta.BlueWaveKludge.REFERENCES, '<abc@example.com>');
                assert.equal(message.meta.BlueWaveProperty.bw_newsgroups, 'comp.test');
                done();
            });
        });

        it('takes a subject too long for the record from the kludge', done => {
            const dir = makeTempDir();
            const longSubject = `A subject of ${'x'.repeat(90)} characters`;
            writeText(dir, '00000001.MSG', `\u0001Subject: ${longSubject}\nBody.\n`);
            fs.writeFileSync(
                paths.join(dir, 'ENIGMA.UPL'),
                Buffer.concat([
                    uplHeader(),
                    uplRec({
                        echoTag: 'NEWSGROUP',
                        networkType: 1,
                        subject: longSubject.substr(0, 71),
                    }),
                ])
            );

            readPacket(dir, {}, (err, result) => {
                assert.equal(err, null);
                assert.equal(result.messages[0].message.subject, longSubject);
                done();
            });
        });

        it('keeps the kludges in the body when asked', done => {
            const dir = makeTempDir();
            writeText(dir, '00000001.MSG', '\u0001Newsgroups: comp.test\nBody.\n');
            fs.writeFileSync(
                paths.join(dir, 'ENIGMA.UPL'),
                Buffer.concat([
                    uplHeader(),
                    uplRec({ echoTag: 'NEWSGROUP', networkType: 1 }),
                ])
            );

            readPacket(dir, { keepKludges: true }, (err, result) => {
                assert.equal(err, null);
                assert.match(result.messages[0].message.message, /Newsgroups/);
                done();
            });
        });

        it('warns rather than guessing when an echotag is unknown', done => {
            const dir = makeTempDir();
            writeText(dir, '00000001.MSG', 'Body.');
            fs.writeFileSync(
                paths.join(dir, 'ENIGMA.UPL'),
                Buffer.concat([uplHeader(), uplRec({ echoTag: 'NO_SUCH_AREA' })])
            );

            readPacket(dir, {}, (err, result) => {
                assert.equal(err, null);
                assert.equal(result.messages.length, 0);
                assert.equal(result.warnings.length, 1);
                assert.match(result.warnings[0].message, /NO_SUCH_AREA/);
                done();
            });
        });

        it('warns when the record names a file the packet does not carry', done => {
            const dir = makeTempDir();
            fs.writeFileSync(
                paths.join(dir, 'ENIGMA.UPL'),
                Buffer.concat([uplHeader(), uplRec({ fileName: 'MISSING.MSG' })])
            );

            readPacket(dir, {}, (err, result) => {
                assert.equal(err, null);
                assert.equal(result.messages.length, 0);
                assert.equal(result.warnings.length, 1);
                assert.match(result.warnings[0].message, /MISSING.MSG/);
                done();
            });
        });

        it('seeks by the lengths the header declares, not its own', done => {
            const dir = makeTempDir();
            writeText(dir, '00000001.MSG', 'Body.');

            //  a reader built against a later revision, with fields this
            //  build has never heard of on the end of both structures
            const header = Buffer.concat([uplHeader(), Buffer.alloc(16, 0xff)]);
            header.writeUInt16LE(ReplyRecordLength.UplHeader + 16, Upl.HeaderLen);
            header.writeUInt16LE(ReplyRecordLength.UplRec + 8, Upl.RecLen);

            const rec = Buffer.concat([uplRec(), Buffer.alloc(8, 0xff)]);

            fs.writeFileSync(paths.join(dir, 'ENIGMA.UPL'), Buffer.concat([header, rec]));

            readPacket(dir, {}, (err, result) => {
                assert.equal(err, null);
                assert.equal(result.messages.length, 1);
                assert.equal(result.messages[0].message.subject, 'Re: testing');
                done();
            });
        });

        it('refuses a packet with no reply member at all', done => {
            const dir = makeTempDir();
            fs.writeFileSync(paths.join(dir, 'READ.ME'), 'nothing to see');

            readPacket(dir, {}, err => {
                assert.ok(err);
                assert.match(err.message, /Not a Blue Wave reply packet/);
                done();
            });
        });
    });

    describe('level 2 (*.UPI and *.NET)', () => {
        const upiRec = ({
            fileName = '00000001.MSG',
            echoTag = 'GENERAL',
            flags = 0,
        } = {}) => {
            const rec = Buffer.alloc(ReplyRecordLength.UpiRec);
            writeFixed(rec, UpiRec.From, 'Anne', 36);
            writeFixed(rec, UpiRec.To, 'Bob', 36);
            writeFixed(rec, UpiRec.Subject, 'Older packet', 72);
            rec.writeUInt32LE(1700000000, UpiRec.UnixDate);
            writeFixed(rec, UpiRec.FileName, fileName, 13);
            writeFixed(rec, UpiRec.EchoTag, echoTag, 21);
            rec.writeUInt8(flags, UpiRec.Flags);
            return rec;
        };

        const netRec = () => {
            const rec = Buffer.alloc(ReplyRecordLength.NetRec);
            writeFixed(rec, NetRec.From, 'Anne', 36);
            writeFixed(rec, NetRec.To, 'Sysop', 36);
            writeFixed(rec, NetRec.Subject, 'Old netmail', 72);
            rec.writeUInt16LE(56, NetRec.Node);
            rec.writeUInt16LE(234, NetRec.Net);
            rec.writeUInt16LE(0x0001, NetRec.Attr);
            writeFixed(rec, NetRec.FileName, '00000002.MSG', 13);
            writeFixed(rec, NetRec.EchoTag, 'FIDO_ECHO', 21);
            rec.writeUInt16LE(1, NetRec.Zone);
            rec.writeUInt16LE(7, NetRec.Point);
            rec.writeUInt32LE(1700000000, NetRec.UnixDate);
            return rec;
        };

        it('reads a *.UPI when there is no *.UPL', done => {
            const dir = makeTempDir();
            writeText(dir, '00000001.MSG', 'Body from an older reader.');
            fs.writeFileSync(
                paths.join(dir, 'ENIGMA.UPI'),
                Buffer.concat([
                    Buffer.alloc(ReplyRecordLength.UpiHeader),
                    upiRec({ flags: 0x40 }),
                ])
            );

            readPacket(dir, {}, (err, result) => {
                assert.equal(err, null);
                assert.equal(result.messages.length, 1);
                const { message, info } = result.messages[0];
                assert.equal(message.areaTag, 'general');
                assert.equal(message.message, 'Body from an older reader.');
                assert.equal(info.private, true);
                done();
            });
        });

        it('reads netmail out of a *.NET', done => {
            const dir = makeTempDir();
            writeText(dir, '00000002.MSG', 'Old netmail body.');
            fs.writeFileSync(paths.join(dir, 'ENIGMA.NET'), netRec());

            readPacket(dir, {}, (err, result) => {
                assert.equal(err, null);
                assert.equal(result.messages.length, 1);
                const { message, info } = result.messages[0];
                assert.equal(info.netMail, true);
                assert.equal(info.private, true);
                assert.equal(message.getRemoteToUser(), '1:234/56.7');
                done();
            });
        });

        //
        //  The kit: a door processes the *.UPL whenever one is present. A
        //  reader that wrote both would otherwise have its replies imported
        //  twice.
        //
        it('ignores the older files when a *.UPL is present', done => {
            const dir = makeTempDir();
            writeText(dir, '00000001.MSG', 'From the UPL.');
            writeText(dir, '00000002.MSG', 'Old netmail body.');
            fs.writeFileSync(
                paths.join(dir, 'ENIGMA.UPL'),
                Buffer.concat([uplHeader(), uplRec()])
            );
            fs.writeFileSync(
                paths.join(dir, 'ENIGMA.UPI'),
                Buffer.concat([Buffer.alloc(ReplyRecordLength.UpiHeader), upiRec()])
            );
            fs.writeFileSync(paths.join(dir, 'ENIGMA.NET'), netRec());

            readPacket(dir, {}, (err, result) => {
                assert.equal(err, null);
                assert.equal(result.messages.length, 1);
                assert.equal(result.messages[0].message.message, 'From the UPL.');
                done();
            });
        });
    });

    describe('*.REQ', () => {
        it('reports each file the caller asked for', done => {
            const dir = makeTempDir();
            writeText(dir, '00000001.MSG', 'Body.');
            fs.writeFileSync(
                paths.join(dir, 'ENIGMA.UPL'),
                Buffer.concat([uplHeader(), uplRec()])
            );

            const req = Buffer.alloc(ReplyRecordLength.ReqRec * 2);
            writeFixed(req, 0, 'SOMEFILE.ZIP', 13);
            writeFixed(req, ReplyRecordLength.ReqRec, 'OTHER.LHA', 13);
            fs.writeFileSync(paths.join(dir, 'ENIGMA.REQ'), req);

            readPacket(dir, {}, (err, result) => {
                assert.equal(err, null);
                assert.deepEqual(result.fileRequests, ['SOMEFILE.ZIP', 'OTHER.LHA']);
                done();
            });
        });
    });

    describe('echotag routing', () => {
        let previousConfig;

        //  _popTestConfig() wants the getter it replaced: called with nothing
        //  it leaves Config.get undefined for every suite that runs after
        //  this one
        afterEach(() => configModule._popTestConfig(previousConfig));

        it('reaches the same tags the writer would have written', () => {
            previousConfig = configModule._pushTestConfig({
                messageNetworks: {
                    bluewave: {
                        areas: {
                            general: { echotag: 'GEN' },
                        },
                    },
                },
            });

            const map = buildEchoTagMap([
                'general',
                'another_area',
                WellKnownAreaTags.Private,
            ]);

            //  a pinned tag, one derived from the area tag, and personal mail
            assert.equal(map.get('GEN'), 'general');
            assert.equal(map.get('ANOTHER_AREA'), 'another_area');
            assert.equal(map.get('PRIVATE_MAIL'), WellKnownAreaTags.Private);
        });

        //
        //  Two area tags that differ only past the twentieth character are
        //  separated by the tail of a digest of each tag, so the map reaches
        //  the same answer without replaying the walk the export made.
        //
        it('separates two tags that agree for twenty characters', () => {
            previousConfig = configModule._pushTestConfig({});

            const both = buildEchoTagMap([
                'a_very_long_area_tag_one',
                'a_very_long_area_tag_two',
            ]);
            assert.equal(both.size, 2);

            //  and each resolves the same way out of a map that holds only it
            const one = buildEchoTagMap(['a_very_long_area_tag_one']);
            const two = buildEchoTagMap(['a_very_long_area_tag_two']);

            for (const [tag, areaTag] of both) {
                const alone = 'a_very_long_area_tag_one' === areaTag ? one : two;
                assert.equal(alone.get(tag), areaTag);
            }
        });
    });
});
