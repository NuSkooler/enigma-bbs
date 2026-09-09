/* jslint node: true */
'use strict';

//  ENiGMA½
const Config = require('./config.js').get;
const { Errors } = require('./enig_error.js');
const { getMessageAreaByTag, getMessageConferenceByTag } = require('./message_area.js');
const StatLog = require('./stat_log.js');
const SysProps = require('./system_property.js');
const ArchiveUtil = require('./archive_util.js');

//  deps
const fs = require('graceful-fs');
const paths = require('path');
const _ = require('lodash');
const moment = require('moment');
const iconv = require('iconv-lite');
const temptmp = require('temptmp');
const async = require('async');
const { EventEmitter } = require('events');

//
//  Blue Wave offline mail packets
//
//  A packet is an archive of four members sharing one 1-8 character root
//  name: .INF (the header and the area list), .MIX (per area, where that
//  area's messages start), .FTI (one record per message) and .DAT (the
//  message text). Each file indexes the next.
//
//  Resources:
//  * bluewave.h, "Version 3 - November 30, 1995", the structure kit
//    published by Cutting Edge Computing
//  * https://www.moon-soft.com/program/FORMAT/internet/bluewave.htm, the
//    revision 2 document, January 18 1994
//
const PacketLevel = 3;

//  on-disk record sizes, written into the .INF header so a reader can seek
//  past fields it does not know
const RecordLength = {
    InfHeader: 1230,
    InfArea: 80,
    Mix: 14,
    Fti: 186,
};

//  INF_AREA_INFO.area_flags
const AreaFlags = {
    Scanning: 0x0001,
    AliasName: 0x0002,
    AnyName: 0x0004,
    Echo: 0x0008,
    NetMail: 0x0010,
    Post: 0x0020,
    NoPrivate: 0x0040,
    NoPublic: 0x0080,
};

//  FTI_REC.flags
const MessageFlags = {
    Private: 0x0001,
    Read: 0x0004,
    Local: 0x0100,
};

//  the fields a reader may not truncate past, per INF_HEADER.from_to_len
//  and .subject_len; the records themselves stay 36/36/72 either way
//  MIX_REC.totmsgs is 16 bits, so an area cannot carry more than this
const MaxMessagesPerArea = 65535;

const HostFieldLimit = {
    FromTo: 35,
    Subject: 71,
};

//
//  A field is a C string inside a fixed-length slot: NUL terminated, and the
//  kit is explicit that the remainder is NUL as well. Text is CP437; a byte
//  that will not encode becomes '?' rather than failing the packet.
//
const writeFixed = (buf, offset, value, length) => {
    buf.fill(0, offset, offset + length);
    const encoded = iconv.encode(_.toString(value), 'cp437', {
        defaultEncoding: 'ascii',
    });
    encoded.copy(buf, offset, 0, Math.min(encoded.length, length - 1));
};

//
//  Message text is CP437 with bare CR line endings -- no LF -- and cannot
//  carry a NUL, which would end the string for any reader written in C.
//
const encodeText = text => {
    const encoded = iconv.encode(_.toString(text).replace(/\r?\n/g, '\r'), 'cp437', {
        defaultEncoding: 'ascii',
    });
    for (let i = 0; i < encoded.length; ++i) {
        if (0 === encoded[i]) {
            encoded[i] = 0x20;
        }
    }
    return encoded;
};

//
//  An echotag is 20 characters and it is what a reply is routed by, so the
//  kit requires it to be unique within the packet. Two area tags that differ
//  only past the twentieth character would collide, so a digit replaces the
//  tail until one is free.
//
const echoTagFor = (areaTag, taken = new Set()) => {
    const base = _.toString(areaTag)
        .toUpperCase()
        .replace(/[^A-Z0-9_.-]/g, '_')
        .substr(0, 20);

    if (!taken.has(base)) {
        return base;
    }

    for (let n = 2; n < 1000; ++n) {
        const suffix = n.toString();
        const candidate = `${base.substr(0, 20 - suffix.length)}${suffix}`;
        if (!taken.has(candidate)) {
            return candidate;
        }
    }

    return base;
};

class BlueWavePacketWriter extends EventEmitter {
    constructor({
        bbsID = 'ENIGMA',
        user = null,
        archiveFormat = 'application/zip',
        systemName = null,
        sysOpName = null,
    } = {}) {
        super();

        this.options = { bbsID, user, archiveFormat, systemName, sysOpName };

        this.temptmp = temptmp.createTrackedSession('bwpacketwriter');

        //  areaTag -> { number, echoTag, area, conf, messages: [] }
        this.areas = new Map();
        this.datOffset = 0;
        this.messageNumber = 0;
    }

    init() {
        async.series(
            [
                callback => {
                    return StatLog.init(callback);
                },
                callback => {
                    this.temptmp.mkdir({ prefix: 'enigbwwriter-' }, (err, workDir) => {
                        this.workDir = workDir;
                        return callback(err);
                    });
                },
                callback => {
                    this.datStream = fs.createWriteStream(
                        paths.join(this.workDir, `${this._rootName()}.DAT`)
                    );
                    //  unhandled, a write failure (a full temp dir, say) is
                    //  thrown at the process rather than failing the export
                    this.datStream.on('error', err => this.emit('error', err));
                    return callback(null);
                },
            ],
            err => {
                if (err) {
                    return this.emit('error', err);
                }
                return this.emit('ready');
            }
        );
    }

    //
    //  An area number is only an index within this packet; a reply is routed
    //  by echotag, since area numbers move when a sysop reorganizes.
    //
    _areaFor(areaTag) {
        let entry = this.areas.get(areaTag);
        if (entry) {
            return entry;
        }

        const configured = _.get(
            Config(),
            ['messageNetworks', 'bluewave', 'areas', areaTag],
            {}
        );
        const area = getMessageAreaByTag(areaTag);
        const conf = area ? getMessageConferenceByTag(area.confTag) : null;

        entry = {
            number: this._areaNumberFor(configured.number),
            echoTag:
                configured.echotag ||
                echoTagFor(
                    areaTag,
                    new Set(Array.from(this.areas.values()).map(a => a.echoTag))
                ),
            title: configured.title || (area ? area.name : areaTag),
            area,
            conf,
            messages: [],
        };

        this.areas.set(areaTag, entry);
        return entry;
    }

    //
    //  Two areas sharing a number is not a cosmetic problem: a reader joins
    //  .MIX to .INF by scanning forward for the first record carrying that
    //  number, so the duplicate's messages appear under the wrong area. A
    //  pinned number wins and the automatic ones step around it.
    //
    _areaNumberFor(pinned) {
        const taken = new Set(Array.from(this.areas.values()).map(a => a.number));

        if (pinned) {
            if (taken.has(pinned)) {
                this.emit(
                    'warning',
                    Errors.General(`Blue Wave area number ${pinned} is used twice`)
                );
            } else {
                return pinned;
            }
        }

        let number = 1;
        while (taken.has(number)) {
            number += 1;
        }
        return number;
    }

    //  an area the caller can reach, whether or not it has new mail
    addArea(areaTag) {
        this._areaFor(areaTag);
    }

    appendMessage(message) {
        const entry = this._areaFor(message.areaTag);

        if (entry.messages.length >= MaxMessagesPerArea) {
            if (!entry.overflowed) {
                entry.overflowed = true;
                this.emit(
                    'warning',
                    Errors.General(
                        `Blue Wave packet holds at most ${MaxMessagesPerArea} messages per area; the rest of "${message.areaTag}" is omitted`
                    )
                );
            }
            return;
        }

        const text = encodeText(message.message);

        //
        //  Every message in the .DAT begins with a space that is not part of
        //  the text. msgptr points at it and msglength counts it.
        //
        this.datStream.write(Buffer.from([0x20]));
        this.datStream.write(text);

        entry.messages.push({
            from: message.fromUserName,
            to: message.toUserName,
            subject: message.subject,
            //  'en' explicitly: the month name follows moment's global
            //  locale otherwise, and a non-ASCII one would reach CP437 as '?'
            date: moment(message.modTimestamp).locale('en').format('DD MMM YY  HH:mm:ss'),
            //  a packet-local number: the format has 16 bits for it, which is
            //  short of what an ENiGMA½ message ID can reach
            number: (this.messageNumber += 1) & 0xffff,
            offset: this.datOffset,
            length: text.length + 1,
            private: message.isPrivate(),
        });

        this.datOffset += text.length + 1;
    }

    //  separate from finish() so the records can be read back without an
    //  archiver in the way
    writePacketFiles(cb) {
        async.series(
            [
                callback => {
                    this.datStream.on('close', () => callback(null));
                    this.datStream.end();
                },
                callback => this._writeIndexes(callback),
                callback => this._writeInf(callback),
            ],
            err => cb(err)
        );
    }

    finish(packetDirectory) {
        async.series(
            [
                callback => this.writePacketFiles(callback),
                callback => this._producePacketArchive(packetDirectory, callback),
            ],
            err => {
                this.temptmp.cleanup();

                if (err) {
                    return this.emit('error', err);
                }
                return this.emit('finished');
            }
        );
    }

    //
    //  .FTI holds every message record, and .MIX says where each area's run
    //  of them begins. MultiMail walks the two lists together rather than
    //  searching, so the areas must appear in the same order in both.
    //
    _writeIndexes(cb) {
        const fti = [];
        const mix = [];
        let ftiOffset = 0;

        this.areas.forEach(entry => {
            if (!entry.messages.length) {
                return;
            }

            const mixRec = Buffer.alloc(RecordLength.Mix);
            writeFixed(mixRec, 0, entry.number.toString(), 6);
            mixRec.writeUInt16LE(entry.messages.length, 6);
            mixRec.writeUInt16LE(this._personalCount(entry), 8);
            mixRec.writeUInt32LE(ftiOffset, 10);
            mix.push(mixRec);

            entry.messages.forEach(msg => {
                const rec = Buffer.alloc(RecordLength.Fti);
                writeFixed(rec, 0, msg.from, 36);
                writeFixed(rec, 36, msg.to, 36);
                writeFixed(rec, 72, msg.subject, 72);
                writeFixed(rec, 144, msg.date, 20);
                rec.writeUInt16LE(msg.number, 164);
                rec.writeUInt16LE(0, 166); //  replyto: no chain is exported
                rec.writeUInt16LE(0, 168); //  replyat
                rec.writeUInt32LE(msg.offset, 170);
                rec.writeUInt32LE(msg.length, 174);
                rec.writeUInt16LE(
                    MessageFlags.Local | (msg.private ? MessageFlags.Private : 0),
                    178
                );
                fti.push(rec);
                ftiOffset += RecordLength.Fti;
            });
        });

        const root = this._rootName();
        async.series(
            [
                cb =>
                    fs.writeFile(
                        paths.join(this.workDir, `${root}.FTI`),
                        Buffer.concat(fti),
                        cb
                    ),
                cb =>
                    fs.writeFile(
                        paths.join(this.workDir, `${root}.MIX`),
                        Buffer.concat(mix),
                        cb
                    ),
            ],
            err => cb(err)
        );
    }

    //
    //  Mail addressed to the caller. The format has no personal area: a
    //  reader gathers one itself, and this count is what tells it how many
    //  to expect.
    //
    _personalCount(entry) {
        const user = this.options.user;
        if (!user) {
            return 0;
        }

        const names = [user.username, user.realName && user.realName(false)]
            .filter(name => name)
            .map(name => name.toLowerCase());

        return entry.messages.filter(msg =>
            names.includes(_.toString(msg.to).toLowerCase())
        ).length;
    }

    _writeInf(cb) {
        const config = Config();
        const user = this.options.user;
        const header = Buffer.alloc(RecordLength.InfHeader);

        header.writeUInt8(PacketLevel, 0);
        header.writeUInt8(0, 75); //  mashtype: the reader fills this in
        writeFixed(header, 76, user ? user.username : '', 43); //  loginname
        writeFixed(header, 119, user ? user.realName(true) : '', 43); //  aliasname
        writeFixed(
            header,
            192,
            this.options.sysOpName || StatLog.getSystemStat(SysProps.SysOpUsername),
            41
        );
        writeFixed(
            header,
            235,
            this.options.systemName || _.get(config, 'general.boardName'),
            65
        );
        header.writeUInt16LE(RecordLength.InfHeader, 976);
        header.writeUInt16LE(RecordLength.InfArea, 978);
        header.writeUInt16LE(RecordLength.Mix, 980);
        header.writeUInt16LE(RecordLength.Fti, 982);
        //  uses_upl_file says the door can PROCESS .UPL replies, which
        //  nothing here does yet; a level 3 reader writes them regardless
        header.writeUInt8(0, 984);
        header.writeUInt8(HostFieldLimit.FromTo, 985);
        header.writeUInt8(HostFieldLimit.Subject, 986);
        writeFixed(header, 987, this._rootName(), 9);
        header.writeUInt8(1, 975); //  can_forward

        const areas = [];
        this.areas.forEach(entry => {
            const rec = Buffer.alloc(RecordLength.InfArea);
            writeFixed(rec, 0, entry.number.toString(), 6);
            writeFixed(rec, 6, entry.echoTag, 21);
            writeFixed(rec, 27, entry.title, 50);
            rec.writeUInt16LE(
                AreaFlags.Scanning |
                    AreaFlags.Post |
                    (entry.area ? AreaFlags.Echo : AreaFlags.NoPublic),
                77
            );
            rec.writeUInt8(0, 79); //  network_type: FidoNet
            areas.push(rec);
        });

        return fs.writeFile(
            paths.join(this.workDir, `${this._rootName()}.INF`),
            Buffer.concat([header, ...areas]),
            cb
        );
    }

    _rootName() {
        return (
            _.toString(this.options.bbsID)
                .toUpperCase()
                .replace(/[^A-Z0-9]/g, '')
                .substr(0, 8) || 'ENIGMA'
        );
    }

    //
    //  Blue Wave names the archive for the day it was made -- the first two
    //  letters of the weekday and a digit, so a caller can keep a week of
    //  them without collisions.
    //
    _getNextAvailPacketFileName(packetDirectory, cb) {
        const day = moment().format('dd').toUpperCase();
        let digit = 0;

        async.doWhilst(
            callback => {
                if (digit > 9) {
                    return callback(
                        Errors.UnexpectedState(
                            'Unable to choose a valid Blue Wave output filename'
                        )
                    );
                }

                const filename = `${this._rootName()}.${day}${digit}`;
                fs.access(
                    paths.join(packetDirectory, filename),
                    fs.constants.F_OK,
                    err => {
                        if (err) {
                            return callback(null, filename);
                        }
                        digit += 1;
                        return callback(null, null);
                    }
                );
            },
            (filename, callback) => callback(null, null === filename),
            (err, filename) => {
                return cb(err, filename);
            }
        );
    }

    _producePacketArchive(packetDirectory, cb) {
        const archiveUtil = ArchiveUtil.getInstance();

        fs.readdir(this.workDir, (err, files) => {
            if (err) {
                return cb(err);
            }

            this._getNextAvailPacketFileName(packetDirectory, (err, filename) => {
                if (err) {
                    return cb(err);
                }

                const packetPath = paths.join(packetDirectory, filename);
                archiveUtil.compressTo(
                    this.options.archiveFormat,
                    packetPath,
                    files,
                    this.workDir,
                    () => {
                        fs.stat(packetPath, (err, stats) => {
                            if (stats) {
                                this.emit('packet', { stats, path: packetPath });
                            }
                            return cb(err);
                        });
                    }
                );
            });
        });
    }
}

module.exports = {
    BlueWavePacketWriter,
    RecordLength,
    echoTagFor,
};
