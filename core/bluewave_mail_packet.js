/* jslint node: true */
'use strict';

//  ENiGMA½
const configModule = require('./config.js');
//  Late bound for the same reason as message_area.js: configModule.get is
//  replaced by the Config bootstrapper, so capturing it here would freeze
//  whichever getter happened to be installed when this file was required.
const Config = (...args) => configModule.get(...args);
const { Errors } = require('./enig_error.js');
const {
    getMessageAreaByTag,
    getMessageConferenceByTag,
    getAllAvailableMessageAreaTags,
} = require('./message_area.js');
const Message = require('./message.js');
const { AddressFlavor, WellKnownAreaTags } = require('./message_const.js');
const StatLog = require('./stat_log.js');
const SysProps = require('./system_property.js');
const ArchiveUtil = require('./archive_util.js');
const { endWriteStream } = require('./file_util.js');
const Address = require('./ftn_address.js');

//  deps
const fs = require('graceful-fs');
const paths = require('path');
const _ = require('lodash');
const moment = require('moment');
const iconv = require('iconv-lite');
const temptmp = require('temptmp');
const async = require('async');
const { EventEmitter } = require('events');
const crypto = require('crypto');

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

//  INF_AREA_INFO.network_type
const NetworkType = {
    FidoNet: 0,
    Internet: 1,
};

//
//  network_type and the ECHO/NETMAIL flags name the area together, per the
//  kit's chart: neither flag is a local base, ECHO alone is an echo (a
//  newsgroup under INF_NET_INTERNET) and both together is netmail (e-mail).
//  It is not cosmetic -- MultiMail branches on INF_NET_INTERNET to stop
//  stripping soft CRs, to lift the \001From:, \001Message-ID: and
//  \001References: kludges out of the body, and to address a reply.
//
function areaKindFor(areaTag, area) {
    if (WellKnownAreaTags.Private === areaTag) {
        //  personal mail, which the chart calls NetMail
        return {
            flags: AreaFlags.Echo | AreaFlags.NetMail | AreaFlags.NoPublic,
            networkType: NetworkType.FidoNet,
        };
    }

    switch (area && area.addressFlavor) {
        case AddressFlavor.FTN:
        case AddressFlavor.QWK:
            return { flags: AreaFlags.Echo, networkType: NetworkType.FidoNet };

        case AddressFlavor.NNTP:
        case AddressFlavor.ActivityPub:
            return { flags: AreaFlags.Echo, networkType: NetworkType.Internet };

        case AddressFlavor.Email:
            return {
                flags: AreaFlags.Echo | AreaFlags.NetMail,
                networkType: NetworkType.Internet,
            };

        default:
            //  local, and an area the sysop has since removed
            return { flags: 0, networkType: NetworkType.FidoNet };
    }
}

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

//  INF_AREA_INFO.areanum is a six byte NUL terminated string
const MaxAreaNumberDigits = 5;

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
//  only past the twentieth character would collide, so a tag that had to be
//  truncated ends in three characters taken from a digest of the whole tag.
//
//  The digest rather than a counter because an import has to arrive at the
//  same tag as the export did, and the two do not walk the same list: an
//  export walks the areas stored against that caller, an import the areas
//  that exist now. A counter would hand the same tag to whichever area the
//  walk reached first, so a reply would land in the other one.
//
const MaxEchoTagLength = 20;
const EchoTagDigestLength = 3;

const echoTagFor = areaTag => {
    const full = _.toString(areaTag)
        .toUpperCase()
        .replace(/[^A-Z0-9_.-]/g, '_');

    if (full.length <= MaxEchoTagLength) {
        return full;
    }

    const digest = crypto
        .createHash('sha1')
        .update(_.toString(areaTag))
        .digest('hex')
        .substr(0, EchoTagDigestLength)
        .toUpperCase();

    return `${full.substr(0, MaxEchoTagLength - EchoTagDigestLength)}${digest}`;
};

class BlueWavePacketWriter extends EventEmitter {
    constructor({
        bbsID = 'ENIGMA',
        user = null,
        archiveFormat = 'application/zip',
        systemName = null,
        sysOpName = null,
        acceptsReplies = false,
    } = {}) {
        super();

        this.options = {
            bbsID,
            user,
            archiveFormat,
            systemName,
            sysOpName,
            acceptsReplies,
        };

        this.temptmp = temptmp.createTrackedSession('bwpacketwriter');

        //  areaTag -> { number, echoTag, area, conf, messages: [] }
        this.areas = new Map();
        this.datOffset = 0;
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
                    //  a write failure (a full temp dir, say) reaches the
                    //  export as an 'error' rather than at the process
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
            areaTag,
            number: this._areaNumberFor(configured.number),
            echoTag: configured.echotag || echoTagFor(areaTag),
            title: configured.title || (area ? area.name : areaTag),
            area,
            conf,
            messages: [],
        };

        //  a reply is routed by this, so two areas answering to one tag
        //  would post into whichever the reader reached first
        const clash = Array.from(this.areas.values()).find(
            a => a.echoTag === entry.echoTag
        );
        if (clash) {
            this.emit(
                'warning',
                Errors.General(
                    `Blue Wave echotag "${entry.echoTag}" is used by both "${clash.areaTag}" and "${areaTag}"`
                )
            );
        }

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
            } else if (_.toString(pinned).length > MaxAreaNumberDigits) {
                //  INF_AREA_INFO.areanum is six bytes and writeFixed reserves
                //  the NUL, so a longer number would be silently truncated --
                //  and a truncated number joins .MIX to the wrong area
                this.emit(
                    'warning',
                    Errors.General(
                        `Blue Wave area number ${pinned} is longer than ${MaxAreaNumberDigits} digits`
                    )
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

        const kind = areaKindFor(entry.areaTag, entry.area);
        const text = encodeText(this._bodyFor(message, kind));
        const isNetMail = 0 !== (kind.flags & AreaFlags.NetMail);

        //
        //  Every message in the .DAT begins with a space that is not part of
        //  the text. msgptr points at it and msglength counts it.
        //
        //  Counting it is a choice: the kit says to read msglength bytes from
        //  msgptr, and also that the space is not part of the message, which
        //  cannot both hold. Readers split on it -- BlueMail's getBody()
        //  counts the space, MultiMail's getblk() reads it for free -- so a
        //  length that omits it truncates the last character of every message
        //  in BlueMail, while counting it costs MultiMail one invisible
        //  trailing space. Do not "fix" the stray space away: NoCarrierMail
        //  inherits MultiMail's loop, so that is where it shows.
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
            number: this._messageNumberFor(message),
            offset: this.datOffset,
            length: text.length + 1,
            private: message.isPrivate(),
            origin: isNetMail ? this._originAddress(message) : null,
        });

        this.datOffset += text.length + 1;
    }

    //
    //  FTI_REC.msgnum is what a reply comes back naming, so it has to be a
    //  number this end can resolve: the message's own ID. The field is 16
    //  bits and an ENiGMA½ message ID is not, so an ID past that is written
    //  as zero -- which the kit already defines as "no number" -- rather than
    //  truncated into somebody else's. An import verifies the ID against the
    //  area before threading anything onto it, so a wrapped number could not
    //  quietly land on the wrong message either way.
    //
    _messageNumberFor(message) {
        const messageId = parseInt(message.messageId, 10);
        if (!messageId || messageId > 0xffff) {
            if (messageId > 0xffff && !this.warnedMessageNumber) {
                this.warnedMessageNumber = true;
                this.emit(
                    'warning',
                    Errors.General(
                        'Message IDs past 65535 do not fit the Blue Wave message number; replies to those messages arrive unthreaded'
                    )
                );
            }
            return 0;
        }
        return messageId;
    }

    //
    //  MultiMail lifts these three out of the body of a message in an
    //  Internet area and uses them to address and thread a reply; in a
    //  FidoNet area it would leave them sitting in the text, so they are
    //  written only where they are read.
    //
    _bodyFor(message, kind) {
        if (NetworkType.Internet !== kind.networkType) {
            return message.message;
        }

        const kludges = [];
        const from = message.getRemoteFromUser && message.getRemoteFromUser();
        if (from) {
            kludges.push(`\u0001From: ${from}`);
        }

        const msgId = _.get(message, 'meta.FtnKludge.MSGID');
        if (msgId) {
            kludges.push(`\u0001Message-ID: ${msgId}`);
        }

        const replyTo = _.get(message, 'meta.FtnKludge.REPLY');
        if (replyTo) {
            kludges.push(`\u0001References: ${replyTo}`);
        }

        if (!kludges.length) {
            return message.message;
        }

        return `${kludges.join('\n')}\n${message.message}`;
    }

    //
    //  Where a netmail message came from, so a reader can address the reply
    //  without the caller retyping the address. The kit expects zero outside
    //  a netmail base, and an echo message carries a remote sender too, so
    //  the caller checks the area rather than the message.
    //
    _originAddress(message) {
        const from = message.getRemoteFromUser && message.getRemoteFromUser();
        if (!from) {
            return null;
        }

        const address = Address.fromString(from);
        return address && address.isValid() ? address : null;
    }

    //  separate from finish() so the records can be read back without an
    //  archiver in the way
    writePacketFiles(cb) {
        async.series(
            [
                callback => endWriteStream(this.datStream, callback),
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
                if (msg.origin) {
                    rec.writeUInt16LE(msg.origin.zone || 0, 180);
                    rec.writeUInt16LE(msg.origin.net || 0, 182);
                    rec.writeUInt16LE(msg.origin.node || 0, 184);
                }
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
        //
        //  uses_upl_file tells a reader to write its replies into a *.UPL.
        //  Told that on a board with nowhere to upload them, a caller writes
        //  replies offline and then finds there is no way to send them, so
        //  the caller decides this rather than the format.
        //
        header.writeUInt8(this.options.acceptsReplies ? 1 : 0, 984);
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
            const kind = areaKindFor(entry.areaTag, entry.area);
            rec.writeUInt16LE(AreaFlags.Scanning | AreaFlags.Post | kind.flags, 77);
            rec.writeUInt8(kind.networkType, 79);
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

//
//  Reply packets
//
//  A reader writes its replies into an archive of its own rather than back
//  into the packet it was given. The members are one record per reply -- a
//  *.UPL at level 3, or a *.UPI and a *.NET at level 2 -- each naming the
//  file its message text lives in, plus an optional *.REQ list of files to
//  request from the BBS.
//
const ReplyRecordLength = {
    UplHeader: 256,
    UplRec: 320,
    //  written as sizeof(UPI_HEADER) - 1: the kit pads that struct to an
    //  even size and says not to write the pad byte
    UpiHeader: 55,
    UpiRec: 184,
    NetRec: 232,
    ReqRec: 13,
};

//  UPL_REC.msg_attr
const ReplyFlags = {
    Inactive: 0x0001,
    Private: 0x0002,
    NoEcho: 0x0004,
    HasFile: 0x0008,
    NetMail: 0x0010,
    IsReply: 0x0020,
};

//  UPI_REC.flags, a byte where UPL_REC.msg_attr is a word
const OldReplyFlags = {
    Private: 0x40,
    NoEcho: 0x80,
};

//  MSG_REC.attr, of which a NET_REC is mostly made
const NetMailFlags = {
    Private: 0x0001,
};

//
//  A kludge line opens with SOH and is not part of what the caller typed.
//  MultiMail writes these ahead of the body of an Internet reply, which is
//  where a newsgroup name and the message being followed up to arrive.
//
const KludgeIndicator = '\u0001';

//  a field is a C string in a fixed slot: NUL terminated, NUL padded, CP437
const readFixed = (buf, offset, length) => {
    const slice = buf.slice(offset, offset + length);
    const end = slice.indexOf(0);
    return iconv.decode(slice.slice(0, -1 === end ? slice.length : end), 'cp437').trim();
};

//  Every echotag a packet from this system would have carried. Each one
//  depends on its area tag alone, so the map does not have to reproduce the
//  walk the export made.
const buildEchoTagMap = areaTags => {
    const map = new Map();

    areaTags.forEach(areaTag => {
        const configured = _.get(
            Config(),
            ['messageNetworks', 'bluewave', 'areas', areaTag],
            {}
        );
        const echoTag = configured.echotag || echoTagFor(areaTag);

        //  a tag the sysop pinned onto two areas: the first wins, as it does
        //  in the packet itself
        const key = echoTag.toUpperCase();
        if (!map.has(key)) {
            map.set(key, areaTag);
        }
    });

    return map;
};

class BlueWavePacketReader extends EventEmitter {
    constructor(
        packetPath,
        {
            areaTagForEchoTag = null,
            keepKludges = false,
            maxMessages = 0,
            maxMessageLength = 0,
        } = {}
    ) {
        super();

        this.packetPath = packetPath;
        this.options = {
            areaTagForEchoTag,
            keepKludges,
            maxMessages,
            maxMessageLength,
        };
    }

    read() {
        //  only read() unpacks anything, and only read() cleans up after it
        this.temptmp = temptmp.createTrackedSession('bwpacketreader');

        async.waterfall(
            [
                callback => {
                    const archiveUtil = ArchiveUtil.getInstance();
                    archiveUtil.detectType(this.packetPath, (err, archiveType) => {
                        if (err) {
                            return callback(err);
                        }
                        this.emit('archive type', archiveType);
                        return callback(null, archiveType);
                    });
                },
                (archiveType, callback) => {
                    this.temptmp.mkdir({ prefix: 'enigbwreader-' }, (err, tempDir) => {
                        return callback(err, archiveType, tempDir);
                    });
                },
                (archiveType, tempDir, callback) => {
                    const archiveUtil = ArchiveUtil.getInstance();
                    archiveUtil.extractTo(this.packetPath, tempDir, archiveType, err => {
                        return callback(err, tempDir);
                    });
                },
                (tempDir, callback) => {
                    return this.readExtracted(tempDir, callback);
                },
            ],
            err => {
                this.temptmp.cleanup();

                if (err) {
                    return this.emit('error', err);
                }
                return this.emit('done');
            }
        );
    }

    //
    //  Separate from read() so an unpacked packet can be read without an
    //  archiver in the way.
    //
    readExtracted(packetDir, cb) {
        fs.readdir(packetDir, (err, files) => {
            if (err) {
                return cb(err);
            }

            //  DOS names, so what a reader wrote may reach us in either case
            const members = new Map(files.map(f => [f.toUpperCase(), f]));
            const pathOf = name => {
                const actual = members.get(_.toString(name).toUpperCase());
                return actual ? paths.join(packetDir, actual) : null;
            };

            const byExt = ext =>
                Array.from(members.keys())
                    .filter(name => name.endsWith(ext))
                    .sort();

            const upl = byExt('.UPL')[0];
            const upi = byExt('.UPI')[0];
            const net = byExt('.NET')[0];
            const req = byExt('.REQ')[0];

            if (!upl && !upi && !net) {
                return cb(
                    Errors.Invalid(
                        'Not a Blue Wave reply packet: no .UPL, .UPI or .NET member'
                    )
                );
            }

            async.series(
                [
                    //
                    //  The kit is explicit that a door processes the *.UPL
                    //  whenever one is present and the older pair only when
                    //  it is not, so a reader that wrote both does not get
                    //  its replies imported twice.
                    //
                    callback => {
                        if (!upl) {
                            return callback(null);
                        }
                        return this._readUpl(pathOf(upl), pathOf, callback);
                    },
                    callback => {
                        if (upl || !upi) {
                            return callback(null);
                        }
                        return this._readUpi(pathOf(upi), pathOf, callback);
                    },
                    callback => {
                        if (upl || !net) {
                            return callback(null);
                        }
                        return this._readNet(pathOf(net), pathOf, callback);
                    },
                    callback => {
                        if (!req) {
                            return callback(null);
                        }
                        return this._readReq(pathOf(req), callback);
                    },
                ],
                err => cb(err)
            );
        });
    }

    _readUpl(uplPath, pathOf, cb) {
        fs.readFile(uplPath, (err, buf) => {
            if (err) {
                return cb(err);
            }

            if (buf.length < ReplyRecordLength.UplHeader) {
                return cb(Errors.Invalid('Truncated Blue Wave .UPL header'));
            }

            //
            //  The header carries its own length and that of a record, so a
            //  reader built against a later revision can add fields to
            //  either without this having to know about them.
            //
            const headerLen = buf.readUInt16LE(112) || ReplyRecordLength.UplHeader;
            const recLen = buf.readUInt16LE(114) || ReplyRecordLength.UplRec;

            if (recLen < ReplyRecordLength.UplRec) {
                return cb(
                    Errors.Invalid(
                        `Blue Wave .UPL record length ${recLen} is shorter than the format's ${ReplyRecordLength.UplRec}`
                    )
                );
            }

            this.emit('reader', {
                //  obfuscated, which the kit concedes is "lame security"
                version: this._deobfuscate(buf.slice(10, 30)),
                name: readFixed(buf, 32, 80),
                tearName: readFixed(buf, 204, 16),
                registered: 0 === buf.readUInt8(222),
            });

            this.emit('packet user', {
                loginName: readFixed(buf, 116, 44),
                aliasName: readFixed(buf, 160, 44),
            });

            const count = Math.floor((buf.length - headerLen) / recLen);
            const records = [];

            for (let i = 0; i < count; ++i) {
                const rec = buf.slice(headerLen + i * recLen);
                const attr = rec.readUInt16LE(152);

                //  the kit: a door should not import an inactive record
                if (attr & ReplyFlags.Inactive) {
                    continue;
                }

                records.push({
                    from: readFixed(rec, 0, 36),
                    to: readFixed(rec, 36, 36),
                    subject: readFixed(rec, 72, 72),
                    unixDate: rec.readUInt32LE(156),
                    replyToNumber: rec.readUInt32LE(160),
                    fileName: readFixed(rec, 164, 13),
                    echoTag: readFixed(rec, 177, 21),
                    netDest: readFixed(rec, 220, 100),
                    networkType: rec.readUInt8(219),
                    private: 0 !== (attr & ReplyFlags.Private),
                    netMail: 0 !== (attr & ReplyFlags.NetMail),
                    destination: {
                        zone: rec.readUInt16LE(144),
                        net: rec.readUInt16LE(146),
                        node: rec.readUInt16LE(148),
                        point: rec.readUInt16LE(150),
                    },
                    pathOf,
                });
            }

            return this._emitReplies(records, cb);
        });
    }

    //
    //  Level 2 wrote everything but netmail into a *.UPI. Those records carry
    //  no addressing and no network type, so each one is an echo or local
    //  post.
    //
    _readUpi(upiPath, pathOf, cb) {
        fs.readFile(upiPath, (err, buf) => {
            if (err) {
                return cb(err);
            }

            if (buf.length < ReplyRecordLength.UpiHeader) {
                return cb(Errors.Invalid('Truncated Blue Wave .UPI header'));
            }

            const count = Math.floor(
                (buf.length - ReplyRecordLength.UpiHeader) / ReplyRecordLength.UpiRec
            );
            const records = [];

            for (let i = 0; i < count; ++i) {
                const rec = buf.slice(
                    ReplyRecordLength.UpiHeader + i * ReplyRecordLength.UpiRec
                );
                const flags = rec.readUInt8(182);

                records.push({
                    from: readFixed(rec, 0, 36),
                    to: readFixed(rec, 36, 36),
                    subject: readFixed(rec, 72, 72),
                    unixDate: rec.readUInt32LE(144),
                    replyToNumber: 0,
                    fileName: readFixed(rec, 148, 13),
                    echoTag: readFixed(rec, 161, 21),
                    netDest: '',
                    networkType: NetworkType.FidoNet,
                    private: 0 !== (flags & OldReplyFlags.Private),
                    netMail: false,
                    destination: {},
                    pathOf,
                });
            }

            return this._emitReplies(records, cb);
        });
    }

    //
    //  The netmail half of a level 2 reply packet: a Fido *.MSG header
    //  followed by the fields the door needs, and no header record of its
    //  own.
    //
    _readNet(netPath, pathOf, cb) {
        fs.readFile(netPath, (err, buf) => {
            if (err) {
                return cb(err);
            }

            const count = Math.floor(buf.length / ReplyRecordLength.NetRec);
            const records = [];

            for (let i = 0; i < count; ++i) {
                const rec = buf.slice(i * ReplyRecordLength.NetRec);
                const attr = rec.readUInt16LE(186);

                records.push({
                    from: readFixed(rec, 0, 36),
                    to: readFixed(rec, 36, 36),
                    subject: readFixed(rec, 72, 72),
                    unixDate: rec.readUInt32LE(228),
                    replyToNumber: rec.readUInt16LE(184),
                    fileName: readFixed(rec, 190, 13),
                    echoTag: readFixed(rec, 203, 21),
                    netDest: '',
                    networkType: NetworkType.FidoNet,
                    private: 0 !== (attr & NetMailFlags.Private),
                    netMail: true,
                    destination: {
                        zone: rec.readUInt16LE(224),
                        //  MSG_REC keeps the destination split across two
                        //  fields that are nowhere near each other
                        net: rec.readUInt16LE(174),
                        node: rec.readUInt16LE(166),
                        point: rec.readUInt16LE(226),
                    },
                    pathOf,
                });
            }

            return this._emitReplies(records, cb);
        });
    }

    _readReq(reqPath, cb) {
        fs.readFile(reqPath, (err, buf) => {
            if (err) {
                return cb(err);
            }

            const count = Math.floor(buf.length / ReplyRecordLength.ReqRec);
            for (let i = 0; i < count; ++i) {
                const fileName = readFixed(buf, i * ReplyRecordLength.ReqRec, 13);
                if (fileName) {
                    this.emit('file request', fileName);
                }
            }

            return cb(null);
        });
    }

    //
    //  The kit says each byte of the version is "the actually ASCII value
    //  plus 10", which is backwards: MultiMail writes vernum[c] -= 10 (bw.cc),
    //  and a packet from it holds "&$++" for 0.55. Ten is added back here,
    //  which is what the kit's own wording would have a reader do.
    //
    _deobfuscate(slice) {
        const end = slice.indexOf(0);
        const bytes = Buffer.from(slice.slice(0, -1 === end ? slice.length : end));
        for (let i = 0; i < bytes.length; ++i) {
            bytes[i] = (bytes[i] + 10) & 0xff;
        }
        return iconv.decode(bytes, 'cp437').trim();
    }

    //
    //  How many replies the packet holds is known from the records alone, so
    //  a packet over the limit is refused before a single message file is
    //  opened.
    //
    _emitReplies(records, cb) {
        const { maxMessages } = this.options;
        if (maxMessages && records.length > maxMessages) {
            return cb(
                Errors.Invalid(`A reply packet may carry at most ${maxMessages} messages`)
            );
        }

        return async.eachSeries(
            records,
            (rec, nextRecord) => this._emitReply(rec, nextRecord),
            err => cb(err)
        );
    }

    _emitReply(rec, cb) {
        const areaTag = this._areaTagFor(rec.echoTag);
        if (!areaTag) {
            this.emit(
                'warning',
                Errors.Invalid(
                    `No message area carries the Blue Wave echotag "${rec.echoTag}"`
                )
            );
            return cb(null);
        }

        //  the kit: a record whose file is not in the packet is invalid
        const textPath = rec.fileName ? rec.pathOf(rec.fileName) : null;
        if (!textPath) {
            this.emit(
                'warning',
                Errors.Invalid(
                    `Blue Wave reply names "${rec.fileName}", which the packet does not carry`
                )
            );
            return cb(null);
        }

        //
        //  Sized before it is read: the archive is the caller's, and this
        //  runs in their session on a board serving everybody else.
        //
        fs.stat(textPath, (err, stats) => {
            if (err) {
                this.emit('warning', err);
                return cb(null);
            }

            const { maxMessageLength } = this.options;
            if (maxMessageLength && stats.size > maxMessageLength) {
                this.emit(
                    'warning',
                    Errors.Invalid(
                        `Blue Wave reply "${rec.fileName}" is longer than ${maxMessageLength} bytes`
                    )
                );
                return cb(null);
            }

            fs.readFile(textPath, (err, raw) => {
                if (err) {
                    this.emit('warning', err);
                    return cb(null);
                }

                this._emitDecodedReply(rec, areaTag, raw);
                return cb(null);
            });
        });
    }

    _emitDecodedReply(rec, areaTag, raw) {
        const { body, kludges, newsgroups, extendedSubject } = this._decodeBody(raw);

        const message = new Message({
            areaTag,
            toUserName: rec.to,
            fromUserName: rec.from,
            subject: extendedSubject || rec.subject,
            message: body,
            //  a Unix timestamp the reader wrote from its own clock
            modTimestamp: moment.unix(rec.unixDate),
        });

        message.setExternalFlavor(
            NetworkType.Internet === rec.networkType
                ? Message.AddressFlavor.Email
                : Message.AddressFlavor.FTN
        );

        if (rec.netMail) {
            const remoteTo =
                NetworkType.Internet === rec.networkType
                    ? rec.netDest
                    : this._ftnAddress(rec.destination);
            if (remoteTo) {
                message.setRemoteToUser(remoteTo);
            }
        }

        const bwProperty = {
            bw_echotag: rec.echoTag,
            bw_reply_to_num: rec.replyToNumber,
        };
        if (newsgroups) {
            bwProperty.bw_newsgroups = newsgroups;
        }
        message.meta.BlueWaveProperty = bwProperty;

        if (!_.isEmpty(kludges)) {
            message.meta.BlueWaveKludge = kludges;
        }

        return this.emit('message', message, {
            echoTag: rec.echoTag,
            private: rec.private,
            netMail: rec.netMail,
        });
    }

    _ftnAddress(dest) {
        if (!dest.zone && !dest.net && !dest.node) {
            return null;
        }
        const base = `${dest.zone}:${dest.net}/${dest.node}`;
        return dest.point ? `${base}.${dest.point}` : base;
    }

    //
    //  Message text is CP437 with bare CR line endings, and a NUL -- or a
    //  CR/LF/NUL sequence -- may end it before the file does.
    //
    _decodeBody(raw) {
        const end = raw.indexOf(0);
        const text = iconv.decode(-1 === end ? raw : raw.slice(0, end), 'cp437');

        const kludges = {};
        const bodyLines = [];
        let newsgroups = null;
        let extendedSubject = null;

        text.replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .split('\n')
            .forEach(line => {
                if (!line.startsWith(KludgeIndicator)) {
                    return bodyLines.push(line);
                }

                const kludge = line.substr(1);
                const sep = kludge.indexOf(':');
                const name = (-1 === sep ? kludge : kludge.substr(0, sep)).toUpperCase();
                const value = -1 === sep ? '' : kludge.substr(sep + 1).trim();

                switch (name) {
                    case 'NEWSGROUPS':
                        newsgroups = value;
                        break;

                    //  a subject too long for the 72 byte field
                    case 'SUBJECT':
                        extendedSubject = value;
                        break;
                }

                kludges[name] = value;

                if (this.options.keepKludges) {
                    bodyLines.push(line);
                }
            });

        return {
            body: bodyLines.join('\n').trim(),
            kludges,
            newsgroups,
            extendedSubject,
        };
    }

    _areaTagFor(echoTag) {
        if (this.options.areaTagForEchoTag) {
            return this.options.areaTagForEchoTag(echoTag);
        }

        if (!this.echoTagMap) {
            this.echoTagMap = buildEchoTagMap(
                getAllAvailableMessageAreaTags().concat([WellKnownAreaTags.Private])
            );
        }

        return this.echoTagMap.get(_.toString(echoTag).toUpperCase());
    }
}

module.exports = {
    BlueWavePacketWriter,
    BlueWavePacketReader,
    RecordLength,
    ReplyRecordLength,
    echoTagFor,
    buildEchoTagMap,
};
