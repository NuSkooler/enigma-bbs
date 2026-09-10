'use strict';

const { strict: assert } = require('assert');
const fs = require('fs');
const paths = require('path');
const iconv = require('iconv-lite');

const StatLog = require('../core/stat_log.js');
const configModule = require('../core/config.js');
const { WellKnownAreaTags } = require('../core/message_const.js');
const {
    BlueWavePacketWriter,
    RecordLength,
    echoTagFor,
} = require('../core/bluewave_mail_packet.js');

//
//  Blue Wave packet structures, revision 2 (January 18 1994) and the level 3
//  header of November 30 1995. Offsets are from the structure kit; see
//  https://www.moon-soft.com/program/FORMAT/internet/bluewave.htm
//
const Inf = {
    Ver: 0,
    LoginName: 76,
    AliasName: 119,
    SysOp: 192,
    SystemName: 235,
    HeaderLen: 976,
    AreaLen: 978,
    MixLen: 980,
    FtiLen: 982,
    UsesUplFile: 984,
    FromToLen: 985,
    SubjectLen: 986,
    PacketId: 987,
};

const InfArea = { AreaNum: 0, EchoTag: 6, Title: 27, Flags: 77, NetworkType: 79 };
const Mix = { AreaNum: 0, TotMsgs: 6, NumPers: 8, MsgHPtr: 10 };
const Fti = {
    From: 0,
    To: 36,
    Subject: 72,
    Date: 144,
    MsgNum: 164,
    ReplyTo: 166,
    ReplyAt: 168,
    MsgPtr: 170,
    MsgLength: 174,
    Flags: 178,
};

//  a field is a NUL terminated CP437 string in a fixed slot
const str = (buf, offset, length) => {
    const slice = buf.slice(offset, offset + length);
    const end = slice.indexOf(0);
    return iconv.decode(slice.slice(0, -1 === end ? slice.length : end), 'cp437');
};

function makeMessage(areaTag, overrides = {}) {
    return Object.assign(
        {
            areaTag,
            fromUserName: 'Sender',
            toUserName: 'Recipient',
            subject: 'A subject',
            message: 'First line\nSecond line',
            //  local, not UTC: the .FTI date is written in the board's own
            //  time, so a UTC fixture would assert differently per contributor
            modTimestamp: new Date(2026, 8, 9, 12, 34, 56),
            isPrivate: () => false,
        },
        overrides
    );
}

const user = {
    username: 'testuser',
    realName: () => 'Test User',
};

function buildPacket(build, cb) {
    //  StatLog wants a database, and none of this reads a stat
    const realInit = StatLog.init;
    const realGetSystemStat = StatLog.getSystemStat;
    StatLog.init = callback => callback(null);
    StatLog.getSystemStat = () => 'SysOp Name';

    //  named here rather than read from config: another suite may have
    //  pushed a config of its own by the time this one runs
    const writer = new BlueWavePacketWriter({
        bbsID: 'ENIGMA',
        user,
        systemName: 'Test Board',
        sysOpName: 'SysOp Name',
    });

    writer.once('error', err => {
        throw err;
    });

    writer.once('ready', () => {
        build(writer);
        writer.writePacketFiles(err => {
            StatLog.init = realInit;
            StatLog.getSystemStat = realGetSystemStat;
            assert.equal(err, null);

            const read = ext =>
                fs.readFileSync(paths.join(writer.workDir, `ENIGMA.${ext}`));

            cb({
                inf: read('INF'),
                mix: read('MIX'),
                fti: read('FTI'),
                dat: read('DAT'),
                writer,
            });
        });
    });

    writer.init();
}

describe('Blue Wave packet', () => {
    it('writes the four members a mail packet needs', done => {
        buildPacket(
            writer => {
                writer.addArea('general');
                writer.appendMessage(makeMessage('general'));
            },
            ({ inf, mix, fti, dat }) => {
                assert.equal(inf.length, RecordLength.InfHeader + RecordLength.InfArea);
                assert.equal(mix.length, RecordLength.Mix);
                assert.equal(fti.length, RecordLength.Fti);
                assert.ok(dat.length > 0);
                done();
            }
        );
    });

    //
    //  The header carries the size of every other record so a reader can seek
    //  past fields it does not know. A zero there means "assume the originals".
    //
    it('states the record lengths and identifies the host', done => {
        buildPacket(
            writer => {
                writer.addArea('general');
                writer.appendMessage(makeMessage('general'));
            },
            ({ inf }) => {
                assert.equal(inf.readUInt8(Inf.Ver), 3);
                assert.equal(inf.readUInt16LE(Inf.HeaderLen), RecordLength.InfHeader);
                assert.equal(inf.readUInt16LE(Inf.AreaLen), RecordLength.InfArea);
                assert.equal(inf.readUInt16LE(Inf.MixLen), RecordLength.Mix);
                assert.equal(inf.readUInt16LE(Inf.FtiLen), RecordLength.Fti);
                assert.equal(inf.readUInt8(Inf.FromToLen), 35);
                assert.equal(inf.readUInt8(Inf.SubjectLen), 71);

                assert.equal(str(inf, Inf.PacketId, 9), 'ENIGMA');
                assert.equal(str(inf, Inf.LoginName, 43), 'testuser');
                assert.equal(str(inf, Inf.AliasName, 43), 'Test User');
                assert.equal(str(inf, Inf.SysOp, 41), 'SysOp Name');
                assert.equal(str(inf, Inf.SystemName, 65), 'Test Board');
                done();
            }
        );
    });

    //  nothing here processes an uploaded reply packet yet
    it('does not claim it can read .UPL replies', done => {
        buildPacket(
            writer => {
                writer.addArea('general');
                writer.appendMessage(makeMessage('general'));
            },
            ({ inf }) => {
                assert.equal(inf.readUInt8(Inf.UsesUplFile), 0);
                done();
            }
        );
    });

    //
    //  Every area the caller can reach is listed in the .INF, so a reader can
    //  post into one that had no new mail; only areas that took messages get
    //  a .MIX record.
    //
    it('lists every area, and indexes only the ones with messages', done => {
        buildPacket(
            writer => {
                writer.addArea('general');
                writer.addArea('quiet_area');
                writer.appendMessage(makeMessage('general'));
                writer.appendMessage(makeMessage('general'));
            },
            ({ inf, mix }) => {
                const areaCount =
                    (inf.length - RecordLength.InfHeader) / RecordLength.InfArea;
                assert.equal(areaCount, 2);
                assert.equal(mix.length / RecordLength.Mix, 1);

                const first = inf.slice(RecordLength.InfHeader);
                assert.equal(str(first, InfArea.AreaNum, 6), '1');
                assert.equal(str(first, InfArea.EchoTag, 21), 'GENERAL');
                assert.equal(mix.readUInt16LE(Mix.TotMsgs), 2);
                assert.equal(
                    str(mix, Mix.AreaNum, 6),
                    str(first, InfArea.AreaNum, 6),
                    'the .MIX joins to the .INF by area number'
                );
                done();
            }
        );
    });

    //
    //  .MIX points at the first .FTI record for its area, as a byte offset,
    //  and the records for an area are contiguous and in area order.
    //
    it('points each area at its own run of message records', done => {
        buildPacket(
            writer => {
                writer.appendMessage(makeMessage('general'));
                writer.appendMessage(makeMessage('other'));
                writer.appendMessage(makeMessage('other'));
            },
            ({ mix, fti }) => {
                assert.equal(mix.length / RecordLength.Mix, 2);
                assert.equal(fti.length / RecordLength.Fti, 3);

                const second = mix.slice(RecordLength.Mix);
                assert.equal(mix.readUInt32LE(Mix.MsgHPtr), 0);
                assert.equal(mix.readUInt16LE(Mix.TotMsgs), 1);
                assert.equal(second.readUInt32LE(Mix.MsgHPtr), RecordLength.Fti);
                assert.equal(second.readUInt16LE(Mix.TotMsgs), 2);
                done();
            }
        );
    });

    it('counts the messages addressed to the caller', done => {
        buildPacket(
            writer => {
                writer.appendMessage(makeMessage('general', { toUserName: 'testuser' }));
                writer.appendMessage(makeMessage('general', { toUserName: 'TESTUSER' }));
                writer.appendMessage(makeMessage('general', { toUserName: 'All' }));
            },
            ({ mix }) => {
                assert.equal(mix.readUInt16LE(Mix.TotMsgs), 3);
                assert.equal(mix.readUInt16LE(Mix.NumPers), 2);
                done();
            }
        );
    });

    it('writes the header fields of a message', done => {
        buildPacket(
            writer => {
                writer.appendMessage(
                    makeMessage('general', {
                        fromUserName: 'Alice',
                        toUserName: 'Bob',
                        subject: 'Hello there',
                    })
                );
            },
            ({ fti }) => {
                assert.equal(str(fti, Fti.From, 36), 'Alice');
                assert.equal(str(fti, Fti.To, 36), 'Bob');
                assert.equal(str(fti, Fti.Subject, 72), 'Hello there');
                assert.equal(str(fti, Fti.Date, 20), '09 Sep 26  12:34:56');
                assert.equal(str(fti, Fti.Date, 20).length, 19);
                assert.equal(fti.readUInt16LE(Fti.MsgNum), 1);
                assert.equal(fti.readUInt16LE(Fti.ReplyTo), 0);
                assert.equal(fti.readUInt16LE(Fti.ReplyAt), 0);
                done();
            }
        );
    });

    //
    //  Each message in the .DAT begins with a space that is not part of the
    //  text, and msglength counts it. Lines end with a bare CR.
    //
    it('marks each message with the leading space the format requires', done => {
        buildPacket(
            writer => {
                writer.appendMessage(makeMessage('general', { message: 'one\ntwo' }));
                writer.appendMessage(makeMessage('general', { message: 'three' }));
            },
            ({ fti, dat }) => {
                const second = fti.slice(RecordLength.Fti);

                assert.equal(fti.readUInt32LE(Fti.MsgPtr), 0);
                assert.equal(fti.readUInt32LE(Fti.MsgLength), 'one\rtwo'.length + 1);
                assert.equal(dat[0], 0x20);

                const start = second.readUInt32LE(Fti.MsgPtr);
                const length = second.readUInt32LE(Fti.MsgLength);
                assert.equal(dat[start], 0x20, 'the second message starts with a space');
                assert.equal(
                    dat.slice(start + 1, start + length).toString('ascii'),
                    'three'
                );

                assert.equal(dat.indexOf(0x0a), -1, 'no line feeds');
                assert.ok(dat.indexOf(0x0d) > 0, 'lines end with a bare CR');
                assert.equal(dat.length, start + length);
                done();
            }
        );
    });

    //  a NUL would end the text for any reader written in C
    it('keeps NUL out of the message text', done => {
        buildPacket(
            writer => {
                writer.appendMessage(makeMessage('general', { message: 'be fore' }));
            },
            ({ dat }) => {
                assert.equal(dat.indexOf(0x00), -1);
                assert.equal(dat.slice(1).toString('ascii'), 'be fore');
                done();
            }
        );
    });

    it('encodes message text as CP437', done => {
        buildPacket(
            writer => {
                writer.appendMessage(makeMessage('general', { message: 'café ½' }));
            },
            ({ dat }) => {
                //  é is 0x82 and ½ is 0xAB in CP437
                assert.deepEqual(
                    Array.from(dat.slice(1)),
                    [0x63, 0x61, 0x66, 0x82, 0x20, 0xab]
                );
                done();
            }
        );
    });

    //
    //  MIX_REC.totmsgs is 16 bits. Writing past it threw a RangeError from a
    //  stream callback, which took the process down rather than failing the
    //  export.
    //
    it('stops at the messages an area can hold, and says so', done => {
        const warnings = [];
        buildPacket(
            writer => {
                writer.on('warning', warning => warnings.push(warning.message));
                for (let i = 0; i < 65_537; ++i) {
                    writer.appendMessage(makeMessage('general', { message: 'x' }));
                }
            },
            ({ mix, fti }) => {
                assert.equal(mix.readUInt16LE(Mix.TotMsgs), 65535);
                assert.equal(fti.length / RecordLength.Fti, 65535);
                assert.equal(warnings.length, 1, 'warned once, not once per message');
                assert.match(warnings[0], /65535/);
                done();
            }
        );
    });

    it('flags a private message', done => {
        buildPacket(
            writer => {
                writer.appendMessage(makeMessage('general', { isPrivate: () => true }));
            },
            ({ fti }) => {
                assert.equal(fti.readUInt16LE(Fti.Flags) & 0x0001, 0x0001);
                done();
            }
        );
    });
});

describe('Blue Wave area numbers', () => {
    //
    //  A reader joins .MIX to .INF by scanning for the first record with a
    //  given number, so a duplicate binds an area's messages to another area.
    //
    it('never gives two areas the same number', done => {
        buildPacket(
            writer => {
                writer.addArea('first');
                writer.addArea('second');
                writer.addArea('third');
                writer.appendMessage(makeMessage('third'));
            },
            ({ inf, mix }) => {
                const numbers = [];
                for (
                    let offset = RecordLength.InfHeader;
                    offset < inf.length;
                    offset += RecordLength.InfArea
                ) {
                    numbers.push(str(inf.slice(offset), InfArea.AreaNum, 6));
                }

                assert.deepEqual(numbers, ['1', '2', '3']);
                assert.equal(str(mix, Mix.AreaNum, 6), '3');
                done();
            }
        );
    });
});

describe('Blue Wave echotags', () => {
    it('keeps an area tag that fits', () => {
        assert.equal(echoTagFor('general'), 'GENERAL');
        assert.equal(echoTagFor('fsx_gen'), 'FSX_GEN');
    });

    it('replaces characters a DOS reader cannot show', () => {
        assert.equal(echoTagFor('area with spaces'), 'AREA_WITH_SPACES');
    });

    //  the tag is what a reply is routed by, so it has to be unique
    it('separates two tags that agree for twenty characters', () => {
        const first = echoTagFor('a_very_long_area_tag_one');
        const second = echoTagFor('a_very_long_area_tag_two', new Set([first]));

        assert.equal(first.length, 20);
        assert.notEqual(first, second);
        assert.ok(second.length <= 20);
    });
});

//
//  The kit pairs INF_AREA_INFO.network_type with the ECHO/NETMAIL flags to
//  say what an area is, and MultiMail branches on INF_NET_INTERNET to decide
//  soft CR handling, kludge lifting and reply addressing. These assert the
//  chart, not the writer's own constants.
//
describe('Blue Wave area kinds', () => {
    const AreaFlag = {
        Scanning: 0x0001,
        Echo: 0x0008,
        NetMail: 0x0010,
        Post: 0x0020,
        NoPublic: 0x0080,
    };
    const Base = AreaFlag.Scanning | AreaFlag.Post;

    const areaRecord = (inf, index) =>
        inf.slice(
            RecordLength.InfHeader + index * RecordLength.InfArea,
            RecordLength.InfHeader + (index + 1) * RecordLength.InfArea
        );

    function withAreas(build, cb) {
        const previousConfig = configModule._pushTestConfig({
            debug: { assertsEnabled: false },
            menus: { cls: false },
            general: { boardName: 'ENiGMA½ BBS' },
            messageConferences: {
                system_internal: {
                    name: 'System Internal',
                    areas: {
                        private_mail: { name: 'Private Mail' },
                    },
                },
                local: {
                    name: 'Local',
                    areas: {
                        chatter: { name: 'Chatter' },
                        fido_general: { name: 'Fido General', addressFlavor: 'ftn' },
                        list_mail: { name: 'List Mail', addressFlavor: 'email' },
                        a_newsgroup: { name: 'A Newsgroup', addressFlavor: 'nntp' },
                    },
                },
            },
        });

        buildPacket(build, result => {
            configModule._popTestConfig(previousConfig);
            cb(result);
        });
    }

    it('calls a local base local: neither ECHO nor NETMAIL', done => {
        withAreas(
            writer => writer.addArea('chatter'),
            ({ inf }) => {
                const rec = areaRecord(inf, 0);
                assert.equal(rec.readUInt16LE(InfArea.Flags), Base);
                assert.equal(rec.readUInt8(InfArea.NetworkType), 0);
                done();
            }
        );
    });

    it('calls an FTN area an echo under INF_NET_FIDONET', done => {
        withAreas(
            writer => writer.addArea('fido_general'),
            ({ inf }) => {
                const rec = areaRecord(inf, 0);
                assert.equal(rec.readUInt16LE(InfArea.Flags), Base | AreaFlag.Echo);
                assert.equal(rec.readUInt8(InfArea.NetworkType), 0);
                done();
            }
        );
    });

    it('calls a newsgroup an echo under INF_NET_INTERNET', done => {
        withAreas(
            writer => writer.addArea('a_newsgroup'),
            ({ inf }) => {
                const rec = areaRecord(inf, 0);
                assert.equal(rec.readUInt16LE(InfArea.Flags), Base | AreaFlag.Echo);
                assert.equal(rec.readUInt8(InfArea.NetworkType), 1);
                done();
            }
        );
    });

    it('calls an email area e-mail: ECHO and NETMAIL under INF_NET_INTERNET', done => {
        withAreas(
            writer => writer.addArea('list_mail'),
            ({ inf }) => {
                const rec = areaRecord(inf, 0);
                assert.equal(
                    rec.readUInt16LE(InfArea.Flags),
                    Base | AreaFlag.Echo | AreaFlag.NetMail
                );
                assert.equal(rec.readUInt8(InfArea.NetworkType), 1);
                done();
            }
        );
    });

    //  the caller's own mail, which the chart calls NetMail; nothing public
    //  can be posted into it
    it('calls private mail netmail', done => {
        withAreas(
            writer => writer.addArea(WellKnownAreaTags.Private),
            ({ inf }) => {
                const rec = areaRecord(inf, 0);
                assert.equal(
                    rec.readUInt16LE(InfArea.Flags),
                    Base | AreaFlag.Echo | AreaFlag.NetMail | AreaFlag.NoPublic
                );
                assert.equal(rec.readUInt8(InfArea.NetworkType), 0);
                done();
            }
        );
    });
});
