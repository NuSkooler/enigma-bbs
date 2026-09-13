'use strict';

const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const paths = require('path');

const ArchiveUtil = require('../core/archive_util.js');
const configModule = require('../core/config.js');
const { QWKPacketReader, buildConferenceMap } = require('../core/qwk_mail_packet.js');

//
//  A QWK reply packet: a single file named for the BBS it is going to,
//  holding 128 byte blocks -- one packet ID block, then a header block and
//  its text blocks per message.
//
//  Reference: http://fileformats.archiveteam.org/wiki/QWK
//
const BlockSize = 128;
const QWKLF = 0xe3; //  what a line ending becomes inside a block

const pad = (value, length) => `${value}`.padEnd(length).substr(0, length);

const messageHeader = ({
    confNumber,
    to = 'SYSOP',
    from = 'ANNE',
    subject = 'Re: testing',
    blocks = 2,
    replyToNum = 0,
}) => {
    const b = Buffer.alloc(BlockSize, 0x20);
    b.write(' ', 0, 'ascii'); //  status: public
    b.write(pad(confNumber, 7), 1, 'ascii'); //  a reply names its conference here
    b.write(pad('01-01-2601:00', 13), 8, 'ascii');
    b.write(pad(to, 25), 21, 'ascii');
    b.write(pad(from, 25), 46, 'ascii');
    b.write(pad(subject, 25), 71, 'ascii');
    b.write(pad('', 12), 96, 'ascii'); //  password
    b.write(pad(replyToNum, 8), 108, 'ascii');
    b.write(pad(blocks, 6), 116, 'ascii'); //  counting this header
    b.writeUInt8(0xe1, 122); //  active
    b.writeUInt16LE(confNumber, 123);
    return b;
};

const textBlocks = text => {
    const encoded = Buffer.from(text.replace(/\n/g, String.fromCharCode(QWKLF)), 'ascii');
    const blocks = Math.ceil(encoded.length / BlockSize) || 1;
    const b = Buffer.alloc(blocks * BlockSize, 0x20);
    encoded.copy(b);
    return b;
};

//
//  The reader opens an archive; these tests hand it the members directly, so
//  what is under test is the parsing rather than the archiver.
//
const readReplyPacket = (members, cb) => {
    const sourceDir = fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-qwkrep-'));
    Object.keys(members).forEach(name =>
        fs.writeFileSync(paths.join(sourceDir, name), members[name])
    );

    const realGetInstance = ArchiveUtil.getInstance;
    ArchiveUtil.getInstance = () => ({
        detectType: (path, done) => done(null, 'application/zip'),
        extractTo: (path, destDir, type, done) => {
            fs.readdirSync(sourceDir).forEach(f =>
                fs.copyFileSync(paths.join(sourceDir, f), paths.join(destDir, f))
            );
            done(null);
        },
    });

    const reader = new QWKPacketReader(sourceDir, {
        mode: QWKPacketReader.Modes.REP,
    });

    const messages = [];
    reader.on('message', message => messages.push(message));
    reader.on('error', err => {
        ArchiveUtil.getInstance = realGetInstance;
        cb(err);
    });
    reader.on('done', () => {
        ArchiveUtil.getInstance = realGetInstance;
        cb(null, messages);
    });

    reader.read();
};

describe('QWK reply packets', () => {
    //
    //  A reply packet is written by the reader, which has nothing to say
    //  about the BBS it is going to, so it carries no CONTROL.DAT. Requiring
    //  one rejected every reply packet that has ever been written.
    //
    it('reads a reply packet, which carries no CONTROL.DAT', done => {
        readReplyPacket(
            {
                'ENIGMA.MSG': Buffer.concat([
                    Buffer.alloc(BlockSize, 0x20), //  packet ID block
                    messageHeader({ confNumber: 1000 }),
                    textBlocks('A reply typed offline.'),
                ]),
            },
            (err, messages) => {
                assert.equal(err, null);
                assert.equal(messages.length, 1);
                assert.equal(messages[0].fromUserName, 'ANNE');
                assert.equal(messages[0].toUserName, 'SYSOP');
                assert.equal(messages[0].subject, 'Re: testing');
                assert.match(messages[0].message, /A reply typed offline\./);
                assert.equal(messages[0].meta.QwkProperty.qwk_conf_num, 1000);
                done();
            }
        );
    });

    //
    //  The file is named for the host, so its name is whatever ID that board
    //  chose. Matching a fixed name found the messages in no real packet.
    //
    it('finds the messages file whatever the host is called', done => {
        readReplyPacket(
            {
                'SOMEBBS.MSG': Buffer.concat([
                    Buffer.alloc(BlockSize, 0x20),
                    messageHeader({ confNumber: 1007 }),
                    textBlocks('From a board with another name.'),
                ]),
            },
            (err, messages) => {
                assert.equal(err, null);
                assert.equal(messages.length, 1);
                assert.equal(messages[0].meta.QwkProperty.qwk_conf_num, 1007);
                done();
            }
        );
    });

    it('reads every message in the packet', done => {
        readReplyPacket(
            {
                'ENIGMA.MSG': Buffer.concat([
                    Buffer.alloc(BlockSize, 0x20),
                    messageHeader({ confNumber: 1000, subject: 'First' }),
                    textBlocks('One.'),
                    messageHeader({ confNumber: 1001, subject: 'Second' }),
                    textBlocks('Two.'),
                ]),
            },
            (err, messages) => {
                assert.equal(err, null);
                assert.deepEqual(
                    messages.map(m => m.subject),
                    ['First', 'Second']
                );
                assert.deepEqual(
                    messages.map(m => m.meta.QwkProperty.qwk_conf_num),
                    [1000, 1001]
                );
                done();
            }
        );
    });
});

//
//  A reply names a conference number and nothing else, so an import has to
//  reproduce the numbering the export used to find its way back to an area.
//
describe('QWK conference numbering', () => {
    let previousConfig;

    afterEach(() => configModule._popTestConfig(previousConfig));

    it('numbers unconfigured areas from 1000', () => {
        previousConfig = configModule._pushTestConfig({});

        const map = buildConferenceMap(['general', 'another_area']);
        assert.equal(map.general, 1000);
        assert.equal(map.another_area, 1001);
    });

    it('uses the conference the sysop pinned, and steps around it', () => {
        previousConfig = configModule._pushTestConfig({
            messageNetworks: {
                qwk: {
                    areas: {
                        another_area: { conference: 1000 },
                    },
                },
            },
        });

        const map = buildConferenceMap(['general', 'another_area']);
        assert.equal(map.another_area, 1000);
        assert.equal(map.general, 1001);
    });

    //  Network mode: an area with no conference configured is not exported
    it('maps only configured areas when not numbering automatically', () => {
        previousConfig = configModule._pushTestConfig({
            messageNetworks: {
                qwk: {
                    areas: {
                        general: { conference: 5 },
                    },
                },
            },
        });

        const map = buildConferenceMap(['general', 'another_area'], {
            autoNumber: false,
        });
        assert.deepEqual(map, { general: 5 });
    });
});
