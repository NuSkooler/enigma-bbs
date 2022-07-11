const ArchiveUtil = require('./archive_util');
const { Errors } = require('./enig_error');
const Message = require('./message');
const { splitTextAtTerms } = require('./string_util');
const {
    getMessageConfTagByAreaTag,
    getMessageAreaByTag,
    getMessageConferenceByTag,
    getAllAvailableMessageAreaTags,
} = require('./message_area');
const StatLog = require('./stat_log');
const Config = require('./config').get;
const SysProps = require('./system_property');
const UserProps = require('./user_property');
const { numToMbf32 } = require('./mbf');
const { getEncodingFromCharacterSetIdentifier } = require('./ftn_util');

const { EventEmitter } = require('events');
const temptmp = require('temptmp');
const async = require('async');
const fs = require('graceful-fs');
const paths = require('path');
const { Parser } = require('binary-parser');
const iconv = require('iconv-lite');
const moment = require('moment');
const _ = require('lodash');
const IniConfigParser = require('ini-config-parser');

const enigmaVersion = require('../package.json').version;

//  Synchronet smblib TZ to a UTC offset
//  see https://github.com/kvadevack/synchronet/blob/master/src/smblib/smbdefs.h
const SMBTZToUTCOffset = {
    //  US Standard
    '40F0': '-04:00', //  Atlantic
    '412C': '-05:00', //  Eastern
    4168: '-06:00', //  Central
    '41A4': '-07:00', //  Mountain
    '41E0': '-08:00', //  Pacific
    '421C': '-09:00', //  Yukon
    4258: '-10:00', //  Hawaii/Alaska
    4294: '-11:00', //  Bering

    //  US Daylight
    C0F0: '-03:00', //  Atlantic
    C12C: '-04:00', //  Eastern
    C168: '-05:00', //  Central
    C1A4: '-06:00', //  Mountain
    C1E0: '-07:00', //  Pacific
    C21C: '-08:00', //  Yukon
    C258: '-09:00', //  Hawaii/Alaska
    C294: '-10:00', //  Bering

    //  "Non-Standard"
    2294: '-11:00', //  Midway
    '21E0': '-08:00', //  Vancouver
    '21A4': '-07:00', //  Edmonton
    2168: '-06:00', //  Winnipeg
    '212C': '-05:00', //  Bogota
    '20F0': '-04:00', //  Caracas
    '20B4': '-03:00', //  Rio de Janeiro
    2078: '-02:00', //  Fernando de Noronha
    '203C': '-01:00', //  Azores
    1000: '+00:00', //  London
    '103C': '+01:00', //  Berlin
    1078: '+02:00', //  Athens
    '10B4': '+03:00', //  Moscow
    '10F0': '+04:00', //  Dubai
    '110E': '+04:30', //  Kabul
    '112C': '+05:00', //  Karachi
    '114A': '+05:30', //  Bombay
    1159: '+05:45', //  Kathmandu
    1168: '+06:00', //  Dhaka
    '11A4': '+07:00', //  Bangkok
    '11E0': '+08:00', //  Hong Kong
    '121C': '+09:00', //  Tokyo
    1258: '+10:00', //  Sydney
    1294: '+11:00', //  Noumea
    '12D0': '+12:00', //  Wellington
};

const UTCOffsetToSMBTZ = _.invert(SMBTZToUTCOffset);

const QWKMessageBlockSize = 128;
const QWKHeaderTimestampFormat = 'MM-DD-YYHH:mm';
const QWKLF = 0xe3;

const QWKMessageStatusCodes = {
    UnreadPublic: ' ',
    ReadPublic: '-',
    UnreadPrivate: '+',
    ReadPrivate: '*',
    UnreadCommentToSysOp: '~',
    ReadCommentToSysOp: '`',
    UnreadSenderPWProtected: '%',
    ReadSenderPWProtected: '^',
    UnreadGroupPWProtected: '!',
    ReadGroupPWProtected: '#',
    PWProtectedToAll: '$',
    Vote: 'V',
};

const QWKMessageActiveStatus = {
    Active: 255,
    Deleted: 226,
};

const QWKNetworkTagIndicator = {
    Present: '*',
    NotPresent: ' ',
};

//  See the following:
//  -   http://fileformats.archiveteam.org/wiki/QWK
//  -   http://wiki.synchro.net/ref:qwk
//
const MessageHeaderParser = new Parser()
    .endianess('little')
    .string('status', {
        encoding: 'ascii',
        length: 1,
    })
    .string('num', {
        //  message num or conf num for REP's
        encoding: 'ascii',
        length: 7,
        formatter: n => {
            return parseInt(n);
        },
    })
    .string('timestamp', {
        encoding: 'ascii',
        length: 13,
    })
    //  these fields may be encoded in something other than ascii/CP437
    .array('toName', {
        type: 'uint8',
        length: 25,
    })
    .array('fromName', {
        type: 'uint8',
        length: 25,
    })
    .array('subject', {
        type: 'uint8',
        length: 25,
    })
    .string('password', {
        encoding: 'ascii',
        length: 12,
    })
    .string('replyToNum', {
        encoding: 'ascii',
        length: 8,
        formatter: n => {
            return parseInt(n);
        },
    })
    .string('numBlocks', {
        encoding: 'ascii',
        length: 6,
        formatter: n => {
            return parseInt(n);
        },
    })
    .uint8('status2')
    .uint16('confNum')
    .uint16('relNum')
    .uint8('netTag');

const replaceCharInBuffer = (buffer, search, replace) => {
    let i = 0;
    search = Buffer.from([search]);
    while (i < buffer.length) {
        i = buffer.indexOf(search, i);
        if (-1 === i) {
            break;
        }
        buffer[i] = replace;
        ++i;
    }
};

class QWKPacketReader extends EventEmitter {
    constructor(
        packetPath,
        { mode = QWKPacketReader.Modes.Guess, keepTearAndOrigin = true } = {
            mode: QWKPacketReader.Modes.Guess,
            keepTearAndOrigin: true,
        }
    ) {
        super();

        this.packetPath = packetPath;
        this.options = { mode, keepTearAndOrigin };
        this.temptmp = temptmp.createTrackedSession('qwkpacketreader');
    }

    static get Modes() {
        return {
            Guess: 'guess', //  try to guess
            QWK: 'qwk', //  standard incoming packet
            REP: 'rep', //  a reply packet
        };
    }

    read() {
        //
        //  A general overview:
        //
        //  - Find out what kind of archive we're dealing with
        //  - Extract to temporary location
        //  - Process various files
        //  - Emit messages we find, information about the packet, so on
        //
        async.waterfall(
            [
                //  determine packet archive type
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
                //  create a temporary location to do processing
                (archiveType, callback) => {
                    this.temptmp.mkdir({ prefix: 'enigqwkreader-' }, (err, tempDir) => {
                        if (err) {
                            return callback(err);
                        }

                        return callback(null, archiveType, tempDir);
                    });
                },
                //  extract it
                (archiveType, tempDir, callback) => {
                    const archiveUtil = ArchiveUtil.getInstance();
                    archiveUtil.extractTo(this.packetPath, tempDir, archiveType, err => {
                        if (err) {
                            return callback(err);
                        }

                        return callback(null, tempDir);
                    });
                },
                //  gather extracted file list
                (tempDir, callback) => {
                    fs.readdir(tempDir, (err, files) => {
                        if (err) {
                            return callback(err);
                        }

                        //  Discover basic information about well known files
                        async.reduce(
                            files,
                            {},
                            (out, filename, next) => {
                                const key = filename.toUpperCase();

                                switch (key) {
                                    case 'MESSAGES.DAT': //  QWK
                                        if (
                                            this.options.mode ===
                                            QWKPacketReader.Modes.Guess
                                        ) {
                                            this.options.mode = QWKPacketReader.Modes.QWK;
                                        }
                                        if (
                                            this.options.mode ===
                                            QWKPacketReader.Modes.QWK
                                        ) {
                                            out.messages = { filename };
                                        }
                                        break;

                                    case 'ID.MSG':
                                        if (
                                            this.options.mode ===
                                            QWKPacketReader.Modes.Guess
                                        ) {
                                            this.options.mode = QWKPacketReader.Modes.REP;
                                        }

                                        if (
                                            this.options.mode ===
                                            QWKPacketReader.Modes.REP
                                        ) {
                                            out.messages = { filename };
                                        }
                                        break;

                                    case 'HEADERS.DAT': //  Synchronet
                                        out.headers = { filename };
                                        break;

                                    case 'VOTING.DAT': //  Synchronet
                                        out.voting = { filename };
                                        break;

                                    case 'CONTROL.DAT': //  QWK
                                        out.control = { filename };
                                        break;

                                    case 'DOOR.ID': //  QWK
                                        out.door = { filename };
                                        break;

                                    case 'NETFLAGS.DAT': //  QWK
                                        out.netflags = { filename };
                                        break;

                                    case 'NEWFILES.DAT': //  QWK
                                        out.newfiles = { filename };
                                        break;

                                    case 'PERSONAL.NDX': //    QWK
                                        out.personal = { filename };
                                        break;

                                    case '000.NDX': // QWK
                                        out.inbox = { filename };
                                        break;

                                    case 'TOREADER.EXT': //  QWKE
                                        out.toreader = { filename };
                                        break;

                                    case 'QLR.DAT':
                                        out.qlr = { filename };
                                        break;

                                    default:
                                        if (/[0-9]+\.NDX/.test(key)) {
                                            //  QWK
                                            out.pointers = out.pointers || {
                                                filenames: [],
                                            };
                                            out.pointers.filenames.push(filename);
                                        } else {
                                            out[key] = { filename };
                                        }
                                        break;
                                }

                                return next(null, out);
                            },
                            (err, packetFileInfo) => {
                                this.packetInfo = Object.assign({}, packetFileInfo, {
                                    tempDir,
                                });
                                return callback(null);
                            }
                        );
                    });
                },
                callback => {
                    return this.processPacketFiles(callback);
                },
            ],
            err => {
                this.temptmp.cleanup();

                if (err) {
                    return this.emit('error', err);
                }

                this.emit('done');
            }
        );
    }

    processPacketFiles(cb) {
        async.series(
            [
                callback => {
                    return this.readControl(callback);
                },
                callback => {
                    return this.readHeadersExtension(callback);
                },
                callback => {
                    return this.readMessages(callback);
                },
            ],
            err => {
                return cb(err);
            }
        );
    }

    readControl(cb) {
        //
        //  CONTROL.DAT is a CRLF text file containing information about
        //  the originating BBS, conf number <> name mapping, etc.
        //
        //  References:
        //  -   http://fileformats.archiveteam.org/wiki/QWK
        //
        if (!this.packetInfo.control) {
            return cb(Errors.DoesNotExist('No control file found within QWK packet'));
        }

        const path = paths.join(
            this.packetInfo.tempDir,
            this.packetInfo.control.filename
        );

        //  note that we read as UTF-8. Legacy says it should be CP437/ASCII
        //  but this seems safer for now so conference names and the like
        //  can be non-English for example.
        fs.readFile(path, { encoding: 'utf8' }, (err, controlLines) => {
            if (err) {
                return cb(err);
            }

            controlLines = splitTextAtTerms(controlLines);

            let state = 'header';
            const control = { confMap: {} };
            let currConfNumber;
            for (let lineNumber = 0; lineNumber < controlLines.length; ++lineNumber) {
                const line = controlLines[lineNumber].trim();
                switch (lineNumber) {
                    //  first set of lines is header info
                    case 0:
                        control.bbsName = line;
                        break;
                    case 1:
                        control.bbsLocation = line;
                        break;
                    case 2:
                        control.bbsPhone = line;
                        break;
                    case 3:
                        control.bbsSysOp = line;
                        break;
                    case 4:
                        control.doorRegAndBoardID = line;
                        break;
                    case 5:
                        control.packetCreationTime = line;
                        break;
                    case 6:
                        control.toUser = line;
                        break;
                    case 7:
                        break; //  Qmail menu
                    case 8:
                        break; //  unknown, always 0?
                    case 9:
                        break; //  total messages in packet (often set to 0)
                    case 10:
                        control.totalMessages = parseInt(line) + 1;
                        state = 'confNumber';
                        break;

                    default:
                        switch (state) {
                            case 'confNumber':
                                currConfNumber = parseInt(line);
                                if (isNaN(currConfNumber)) {
                                    state = 'news';

                                    control.welcomeFile = line;
                                } else {
                                    state = 'confName';
                                }
                                break;

                            case 'confName':
                                control.confMap[currConfNumber] = line;
                                state = 'confNumber';
                                break;

                            case 'news':
                                control.newsFile = line;
                                state = 'logoff';
                                break;

                            case 'logoff':
                                control.logoffFile = line;
                                state = 'footer';
                                break;

                            case 'footer':
                                //  some systems append additional info; we don't care.
                                break;
                        }
                }
            }

            return cb(null);
        });
    }

    readHeadersExtension(cb) {
        if (!this.packetInfo.headers) {
            return cb(null); //  nothing to do
        }

        const path = paths.join(
            this.packetInfo.tempDir,
            this.packetInfo.headers.filename
        );
        fs.readFile(path, { encoding: 'utf8' }, (err, iniData) => {
            if (err) {
                this.emit(
                    'warning',
                    Errors.Invalid(`Problem reading HEADERS.DAT: ${err.message}`)
                );
                return cb(null); //  non-fatal
            }

            try {
                const parserOptions = {
                    lineComment: false, //  no line comments; consume full lines
                    nativeType: false, //  just keep everything as strings
                    dotKey: false, //  'a.b.c = value' stays 'a.b.c = value'
                };
                this.packetInfo.headers.ini = IniConfigParser.parse(
                    iniData,
                    parserOptions
                );
            } catch (e) {
                this.emit(
                    'warning',
                    Errors.Invalid(`HEADERS.DAT file appears to be invalid: ${e.message}`)
                );
            }

            return cb(null);
        });
    }

    readMessages(cb) {
        if (!this.packetInfo.messages) {
            return cb(Errors.DoesNotExist('No messages file found within QWK packet'));
        }

        const encodingToSpec = 'cp437';
        let encoding;

        const path = paths.join(
            this.packetInfo.tempDir,
            this.packetInfo.messages.filename
        );
        fs.open(path, 'r', (err, fd) => {
            if (err) {
                return cb(err);
            }

            //  Some mappings/etc. used in loops below....
            //  Sync sets these in HEADERS.DAT: http://wiki.synchro.net/ref:qwk
            const FTNPropertyMapping = {
                'X-FTN-AREA': Message.FtnPropertyNames.FtnArea,
                'X-FTN-SEEN-BY': Message.FtnPropertyNames.FtnSeenBy,
            };

            const FTNKludgeMapping = {
                'X-FTN-PATH': 'PATH',
                'X-FTN-MSGID': 'MSGID',
                'X-FTN-REPLY': 'REPLY',
                'X-FTN-PID': 'PID',
                'X-FTN-FLAGS': 'FLAGS',
                'X-FTN-TID': 'TID',
                'X-FTN-CHRS': 'CHRS',
                //  :TODO: X-FTN-KLUDGE - not sure what this is?
            };

            //
            //  Various kludge tags defined by QWKE, etc.
            //  See the following:
            //  - ftp://vert.synchro.net/main/BBS/qwke.txt
            //  - http://wiki.synchro.net/ref:qwk
            //
            const Kludges = {
                //  QWKE
                To: 'To:',
                From: 'From:',
                Subject: 'Subject:',

                //  Synchronet
                Via: '@VIA:',
                MsgID: '@MSGID:',
                Reply: '@REPLY:',
                TZ: '@TZ:', //  https://github.com/kvadevack/synchronet/blob/master/src/smblib/smbdefs.h
                ReplyTo: '@REPLYTO:',

                //  :TODO: Look into other non-standards
                //  https://github.com/wmcbrine/MultiMail/blob/master/mmail/qwk.cc
                //  title, @subject, etc.
            };

            let blockCount = 0;
            let currMessage = {};
            let state;
            let messageBlocksRemain;
            const buffer = Buffer.alloc(QWKMessageBlockSize);

            const readNextBlock = () => {
                fs.read(fd, buffer, 0, QWKMessageBlockSize, null, (err, read) => {
                    if (err) {
                        return cb(err);
                    }

                    if (0 == read) {
                        //  we're done consuming all blocks
                        return fs.close(fd, err => {
                            return cb(err);
                        });
                    }

                    if (QWKMessageBlockSize !== read) {
                        return cb(
                            Errors.Invalid(
                                `Invalid QWK message block size. Expected ${QWKMessageBlockSize} got ${read}`
                            )
                        );
                    }

                    if (0 === blockCount) {
                        //  first 128 bytes is a space padded ID
                        const id = buffer.toString('ascii').trim();
                        this.emit('creator', id);
                        state = 'header';
                    } else {
                        switch (state) {
                            case 'header':
                                {
                                    const header = MessageHeaderParser.parse(buffer);
                                    encoding = encodingToSpec; //  reset per message

                                    //  massage into something a little more sane (things we can't quite do in the parser directly)
                                    ['toName', 'fromName', 'subject'].forEach(field => {
                                        //  note: always use to-spec encoding here
                                        header[field] = iconv
                                            .decode(header[field], encodingToSpec)
                                            .trim();
                                    });

                                    header.timestamp = moment(
                                        header.timestamp,
                                        QWKHeaderTimestampFormat
                                    );

                                    currMessage = {
                                        header,
                                        //  these may be overridden
                                        toName: header.toName,
                                        fromName: header.fromName,
                                        subject: header.subject,
                                    };

                                    if (_.has(this.packetInfo, 'headers.ini')) {
                                        //  Sections for a message in HEADERS.DAT are by current byte offset.
                                        //  128 = first message header = 0x80 = section [80]
                                        const headersSectionId = (
                                            blockCount * QWKMessageBlockSize
                                        ).toString(16);
                                        currMessage.headersExtension =
                                            this.packetInfo.headers.ini[headersSectionId];
                                    }

                                    //  if we have HEADERS.DAT with a 'Utf8' override for this message,
                                    //  the overridden to/from/subject/message fields are UTF-8
                                    if (
                                        currMessage.headersExtension &&
                                        'true' ===
                                            currMessage.headersExtension.Utf8.toLowerCase()
                                    ) {
                                        encoding = 'utf8';
                                    }

                                    //  remainder of blocks until the end of this message
                                    messageBlocksRemain = header.numBlocks - 1;
                                    state = 'message';
                                }
                                break;

                            case 'message':
                                if (!currMessage.body) {
                                    currMessage.body = Buffer.from(buffer);
                                } else {
                                    currMessage.body = Buffer.concat([
                                        currMessage.body,
                                        buffer,
                                    ]);
                                }
                                messageBlocksRemain -= 1;

                                if (0 === messageBlocksRemain) {
                                    //  1:n buffers to make up body. Decode:
                                    //  First, replace QWK style line feeds (0xe3) unless the message is UTF-8.
                                    //  If the message is UTF-8, we assume it's using standard line feeds.
                                    if (encoding !== 'utf8') {
                                        replaceCharInBuffer(
                                            currMessage.body,
                                            QWKLF,
                                            0x0a
                                        );
                                    }

                                    //
                                    //  Decode the message based on our final message encoding. Split the message
                                    //  into lines so we can extract various bits such as QWKE headers, origin, tear
                                    //  lines, etc.
                                    //
                                    const messageLines = splitTextAtTerms(
                                        iconv.decode(currMessage.body, encoding).trimEnd()
                                    );
                                    const bodyLines = [];

                                    let bodyState = 'kludge';

                                    const MessageTrailers = {
                                        //  While technically FTN oriented, these can come from any network
                                        //  (though we'll be processing a lot of messages that routed through FTN
                                        //  at some point)
                                        Origin: /^[ ]{1,2}\* Origin: /,
                                        Tear: /^--- /,
                                    };

                                    const qwkKludge = {};
                                    const ftnProperty = {};
                                    const ftnKludge = {};

                                    messageLines.forEach(line => {
                                        if (0 === line.length) {
                                            return bodyLines.push('');
                                        }

                                        switch (bodyState) {
                                            case 'kludge':
                                                //  :TODO: Update these to use the well known consts:
                                                if (line.startsWith(Kludges.To)) {
                                                    currMessage.toName = line
                                                        .substring(Kludges.To.length)
                                                        .trim();
                                                } else if (
                                                    line.startsWith(Kludges.From)
                                                ) {
                                                    currMessage.fromName = line
                                                        .substring(Kludges.From.length)
                                                        .trim();
                                                } else if (
                                                    line.startsWith(Kludges.Subject)
                                                ) {
                                                    currMessage.subject = line
                                                        .substring(Kludges.Subject.length)
                                                        .trim();
                                                } else if (line.startsWith(Kludges.Via)) {
                                                    qwkKludge['@VIA'] = line;
                                                } else if (
                                                    line.startsWith(Kludges.MsgID)
                                                ) {
                                                    qwkKludge['@MSGID'] = line
                                                        .substring(Kludges.MsgID.length)
                                                        .trim();
                                                } else if (
                                                    line.startsWith(Kludges.Reply)
                                                ) {
                                                    qwkKludge['@REPLY'] = line
                                                        .substring(Kludges.Reply.length)
                                                        .trim();
                                                } else if (line.startsWith(Kludges.TZ)) {
                                                    qwkKludge['@TZ'] = line
                                                        .substring(Kludges.TZ.length)
                                                        .trim();
                                                } else if (
                                                    line.startsWith(Kludges.ReplyTo)
                                                ) {
                                                    qwkKludge['@REPLYTO'] = line
                                                        .substring(Kludges.ReplyTo.length)
                                                        .trim();
                                                } else {
                                                    bodyState = 'body'; // past this point and up to any tear/origin/etc., is the real message body
                                                    bodyLines.push(line);
                                                }
                                                break;

                                            case 'body':
                                            case 'trailers':
                                                if (MessageTrailers.Origin.test(line)) {
                                                    ftnProperty.ftn_origin = line;
                                                    bodyState = 'trailers';
                                                } else if (
                                                    MessageTrailers.Tear.test(line)
                                                ) {
                                                    ftnProperty.ftn_tear_line = line;
                                                    bodyState = 'trailers';
                                                } else if ('body' === bodyState) {
                                                    bodyLines.push(line);
                                                }
                                        }
                                    });

                                    let messageTimestamp = currMessage.header.timestamp;

                                    //  HEADERS.DAT support.
                                    let useTZKludge = true;
                                    if (currMessage.headersExtension) {
                                        const ext = currMessage.headersExtension;

                                        //  to and subject can be overridden yet again if entries are present
                                        currMessage.toName = ext.To || currMessage.toName;
                                        currMessage.subject =
                                            ext.Subject || currMessage.subject;
                                        currMessage.from =
                                            ext.Sender || currMessage.fromName; //  why not From? Who the fuck knows.

                                        //  possibly override message ID kludge
                                        qwkKludge['@MSGID'] =
                                            ext['Message-ID'] || qwkKludge['@MSGID'];

                                        //  WhenWritten contains a ISO-8601-ish timestamp and a Synchronet/SMB style TZ offset:
                                        //  20180101174837-0600  4168
                                        //  We can use this to get a very slightly better precision on the timestamp (addition of seconds)
                                        //  over the headers value. Why not milliseconds? Who the fuck knows.
                                        if (ext.WhenWritten) {
                                            const whenWritten = moment(
                                                ext.WhenWritten,
                                                'YYYYMMDDHHmmssZ'
                                            );
                                            if (whenWritten.isValid()) {
                                                messageTimestamp = whenWritten;
                                                useTZKludge = false;
                                            }
                                        }

                                        if (ext.Tags) {
                                            currMessage.hashTags =
                                                ext.Tags.toString().split(' ');
                                        }

                                        //  FTN style properties/kludges represented as X-FTN-XXXX
                                        for (let [extName, propName] of Object.entries(
                                            FTNPropertyMapping
                                        )) {
                                            const v = ext[extName];
                                            if (v) {
                                                ftnProperty[propName] = v;
                                            }
                                        }

                                        for (let [extName, kludgeName] of Object.entries(
                                            FTNKludgeMapping
                                        )) {
                                            const v = ext[extName];
                                            if (v) {
                                                ftnKludge[kludgeName] = v;
                                            }
                                        }
                                    }

                                    const message = new Message({
                                        toUserName: currMessage.toName,
                                        fromUserName: currMessage.fromName,
                                        subject: currMessage.subject,
                                        modTimestamp: messageTimestamp,
                                        message: bodyLines.join('\n'),
                                        hashTags: currMessage.hashTags,
                                    });

                                    //  Indicate this message was imported from a QWK packet
                                    message.meta.System[
                                        Message.SystemMetaNames.ExternalFlavor
                                    ] = Message.AddressFlavor.QWK;

                                    if (!_.isEmpty(qwkKludge)) {
                                        message.meta.QwkKludge = qwkKludge;
                                    }

                                    if (!_.isEmpty(ftnProperty)) {
                                        message.meta.FtnProperty = ftnProperty;
                                    }

                                    if (!_.isEmpty(ftnKludge)) {
                                        message.meta.FtnKludge = ftnKludge;
                                    }

                                    //  Add in tear line and origin if requested
                                    if (this.options.keepTearAndOrigin) {
                                        if (ftnProperty.ftn_tear_line) {
                                            message.message += `\r\n${ftnProperty.ftn_tear_line}\r\n`;
                                        }

                                        if (ftnProperty.ftn_origin) {
                                            message.message += `${ftnProperty.ftn_origin}\r\n`;
                                        }
                                    }

                                    //  Update the timestamp if we have a valid TZ
                                    if (useTZKludge && qwkKludge['@TZ']) {
                                        const tzOffset =
                                            SMBTZToUTCOffset[qwkKludge['@TZ']];
                                        if (tzOffset) {
                                            message.modTimestamp.utcOffset(tzOffset);
                                        }
                                    }

                                    message.meta.QwkProperty = {
                                        qwk_msg_status: currMessage.header.status,
                                        qwk_in_reply_to_num:
                                            currMessage.header.replyToNum,
                                    };

                                    if (this.options.mode === QWKPacketReader.Modes.QWK) {
                                        message.meta.QwkProperty.qwk_msg_num =
                                            currMessage.header.num;
                                        message.meta.QwkProperty.qwk_conf_num =
                                            currMessage.header.confNum;
                                    } else {
                                        //  For REP's, prefer the larger field.
                                        message.meta.QwkProperty.qwk_conf_num =
                                            currMessage.header.num ||
                                            currMessage.header.confNum;
                                    }

                                    //  Another quick HEADERS.DAT fix-up
                                    if (currMessage.headersExtension) {
                                        message.meta.QwkProperty.qwk_conf_num =
                                            currMessage.headersExtension.Conference ||
                                            message.meta.QwkProperty.qwk_conf_num;
                                    }

                                    this.emit('message', message);
                                    state = 'header';
                                }
                                break;
                        }
                    }

                    ++blockCount;
                    readNextBlock();
                });
            };

            //  start reading blocks
            readNextBlock();
        });
    }
}

class QWKPacketWriter extends EventEmitter {
    constructor(
        {
            mode = QWKPacketWriter.Modes.User,
            enableQWKE = true,
            enableHeadersExtension = true,
            enableAtKludges = true,
            systemDomain = 'enigma-bbs',
            bbsID = 'ENIGMA',
            user = null,
            archiveFormat = 'application/zip',
            forceEncoding = null,
        } = QWKPacketWriter.DefaultOptions
    ) {
        super();

        this.options = {
            mode,
            enableQWKE,
            enableHeadersExtension,
            enableAtKludges,
            systemDomain,
            bbsID,
            user,
            archiveFormat,
            forceEncoding: forceEncoding ? forceEncoding.toLowerCase() : null,
        };

        this.temptmp = temptmp.createTrackedSession('qwkpacketwriter');

        this.areaTagConfMap = {};
    }

    static get DefaultOptions() {
        return {
            mode: QWKPacketWriter.Modes.User,
            enableQWKE: true,
            enableHeadersExtension: true,
            enableAtKludges: true,
            systemDomain: 'enigma-bbs',
            bbsID: 'ENIGMA',
            user: null,
            archiveFormat: 'application/zip',
            forceEncoding: null,
        };
    }

    static get Modes() {
        return {
            User: 'user', //  creation of a packet for a user (non-network); non-mapped confs allowed
            Network: 'network', //  creation of a packet for QWK network
        };
    }

    init() {
        async.series(
            [
                callback => {
                    return StatLog.init(callback);
                },
                callback => {
                    this.temptmp.mkdir({ prefix: 'enigqwkwriter-' }, (err, workDir) => {
                        this.workDir = workDir;
                        return callback(err);
                    });
                },
                callback => {
                    //
                    //  Prepare areaTag -> conference number mapping:
                    //  - In User mode, areaTags's that are not explicitly configured
                    //    will have their conference number auto-generated.
                    //  - In Network mode areaTags's missing a configuration will not
                    //    be mapped, and thus skipped.
                    //
                    const configuredAreas = _.get(Config(), 'messageNetworks.qwk.areas');
                    if (configuredAreas) {
                        Object.keys(configuredAreas).forEach(areaTag => {
                            const confNumber = configuredAreas[areaTag].conference;
                            if (confNumber) {
                                this.areaTagConfMap[areaTag] = confNumber;
                            }
                        });
                    }

                    if (this.options.mode === QWKPacketWriter.Modes.User) {
                        //  All the rest
                        //  Start at 1000 to work around what seems to be a bug with some readers
                        let confNumber = 1000;
                        const usedConfNumbers = new Set(
                            Object.values(this.areaTagConfMap)
                        );
                        getAllAvailableMessageAreaTags().forEach(areaTag => {
                            if (this.areaTagConfMap[areaTag]) {
                                return;
                            }

                            while (
                                confNumber < 10001 &&
                                usedConfNumbers.has(confNumber)
                            ) {
                                ++confNumber;
                            }

                            //  we can go up to 65535 for some things, but NDX files are limited to 9999
                            if (confNumber === 10000) {
                                //  sanity...
                                this.emit(
                                    'warning',
                                    Errors.General('To many conferences (over 9999)')
                                );
                            } else {
                                this.areaTagConfMap[areaTag] = confNumber;
                                ++confNumber;
                            }
                        });
                    }

                    return callback(null);
                },
                callback => {
                    this.messagesStream = fs.createWriteStream(
                        paths.join(this.workDir, 'messages.dat')
                    );

                    if (this.options.enableHeadersExtension) {
                        this.headersDatStream = fs.createWriteStream(
                            paths.join(this.workDir, 'headers.dat')
                        );
                    }

                    //  First block is a space padded ID
                    const id = `Created with ENiGMA 1/2 BBS v${enigmaVersion} Copyright (c) 2015-2022 Bryan Ashby`;
                    this.messagesStream.write(
                        id.padEnd(QWKMessageBlockSize, ' '),
                        'ascii'
                    );
                    this.currentMessageOffset = QWKMessageBlockSize;

                    this.totalMessages = 0;
                    this.areaTagsSeen = new Set();
                    this.personalIndex = []; //  messages addressed to 'user'
                    this.inboxIndex = []; //  private messages for 'user'
                    this.publicIndex = new Map();

                    return callback(null);
                },
            ],
            err => {
                if (err) {
                    return this.emit('error', err);
                }

                this.emit('ready');
            }
        );
    }

    makeMessageIdentifier(message) {
        return `<${message.messageId}.${message.messageUuid}@${this.options.systemDomain}>`;
    }

    _encodeWithFallback(s, encoding) {
        try {
            return iconv.encode(s, encoding);
        } catch (e) {
            this.emit(
                'warning',
                Errors.General(
                    `Failed to encode buffer using ${encoding}; Falling back to 'ascii'`
                )
            );
            return iconv.encode(s, 'ascii');
        }
    }

    appendMessage(message) {
        //
        //  Each message has to:
        //  - Append to MESSAGES.DAT
        //  - Append to HEADERS.DAT if enabled
        //
        //  If this is a personal (ie: non-network) packet:
        //  - Produce PERSONAL.NDX
        //  - Produce 000.NDX with pointers to the users personal "inbox" mail
        //  - Produce ####.NDX with pointers to the public/conference mail
        //  - Produce TOREADER.EXT if QWKE support is enabled
        //

        let fullMessageBody = '';

        //  Start of body is kludges if enabled
        if (this.options.enableQWKE) {
            if (message.toUserName.length > 25) {
                fullMessageBody += `To: ${message.toUserName}\n`;
            }
            if (message.fromUserName.length > 25) {
                fullMessageBody += `From: ${message.fromUserName}\n`;
            }
            if (message.subject.length > 25) {
                fullMessageBody += `Subject: ${message.subject}\n`;
            }
        }

        if (this.options.enableAtKludges) {
            //  Add in original kludges (perhaps in a different order) if
            //  they were originally imported
            if (
                Message.AddressFlavor.QWK ==
                message.meta.System[Message.SystemMetaNames.ExternalFlavor]
            ) {
                if (message.meta.QwkKludge) {
                    for (let [kludge, value] of Object.entries(message.meta.QwkKludge)) {
                        fullMessageBody += `${kludge}: ${value}\n`;
                    }
                }
            } else {
                fullMessageBody += `@MSGID: ${this.makeMessageIdentifier(message)}\n`;
                fullMessageBody += `@TZ: ${UTCOffsetToSMBTZ[moment().format('Z')]}\n`;
                //  :TODO: REPLY and REPLYTO
            }
        }

        //  Sanitize line feeds (e.g. CRLF -> LF, and possibly -> QWK style below)
        splitTextAtTerms(message.message).forEach(line => {
            fullMessageBody += `${line}\n`;
        });

        const encoding = this._getEncoding(message);

        const encodedMessage = this._encodeWithFallback(fullMessageBody, encoding);

        //
        //  QWK spec wants line feeds as 0xe3 for some reason, so we'll have
        //  to replace the \n's. If we're going against the spec and using UTF-8
        //  we can just leave them be.
        //
        if ('utf8' !== encoding) {
            replaceCharInBuffer(encodedMessage, 0x0a, QWKLF);
        }

        //  Messages must comprise of multiples of 128 bit blocks with the last
        //  block padded by spaces or nulls (we use nulls)
        const fullBlocks = Math.trunc(encodedMessage.length / QWKMessageBlockSize);
        const remainBytes =
            QWKMessageBlockSize - (encodedMessage.length % QWKMessageBlockSize);
        const totalBlocks = fullBlocks + 1 + (remainBytes ? 1 : 0);

        //  The first block is always a header
        if (!this._writeMessageHeader(message, totalBlocks)) {
            //  we can't write this message
            return;
        }

        this.messagesStream.write(encodedMessage);

        if (remainBytes) {
            this.messagesStream.write(Buffer.alloc(remainBytes, ' '));
        }

        this._updateIndexTracking(message);

        if (this.options.enableHeadersExtension) {
            this._appendHeadersExtensionData(message, encoding);
        }

        //  next message starts at this block
        this.currentMessageOffset += totalBlocks * QWKMessageBlockSize;

        this.totalMessages += 1;
        this.areaTagsSeen.add(message.areaTag);
    }

    _getEncoding(message) {
        if (this.options.forceEncoding) {
            return this.options.forceEncoding;
        }

        //  If the system has stored an explicit encoding, use that.
        let encoding = _.get(message.meta, 'System.explicit_encoding');
        if (encoding) {
            return encoding;
        }

        //  If the message is already tagged with a supported encoding
        //  indicator such as FTN-style CHRS, try to use that.
        encoding = _.get(message.meta, 'FtnKludge.CHRS');
        if (encoding) {
            //  Convert from CHRS to something standard
            encoding = getEncodingFromCharacterSetIdentifier(encoding);
            if (encoding) {
                return encoding;
            }
        }

        //  The to-spec default is CP437/ASCII. If it can be encoded as
        //  such then do so.
        if (message.isCP437Encodable()) {
            return 'cp437';
        }

        //  Something more modern...
        return 'utf8';
    }

    _messageAddressedToUser(message) {
        if (_.isUndefined(this.cachedCompareNames)) {
            if (this.options.user) {
                this.cachedCompareNames = [this.options.user.username.toLowerCase()];
                const realName = this.options.user.getProperty(UserProps.RealName);
                if (realName) {
                    this.cachedCompareNames.push(realName.toLowerCase());
                }
            } else {
                this.cachedCompareNames = [];
            }
        }

        return this.cachedCompareNames.includes(message.toUserName.toLowerCase());
    }

    _updateIndexTracking(message) {
        //  index points at start of *message* not the header for... reasons?
        const index = this.currentMessageOffset / QWKMessageBlockSize + 1;
        if (message.isPrivate()) {
            this.inboxIndex.push(index);
        } else {
            if (this._messageAddressedToUser(message)) {
                //  :TODO: add to both indexes???
                this.personalIndex.push(index);
            }

            const areaTag = message.areaTag;
            if (!this.publicIndex.has(areaTag)) {
                this.publicIndex.set(areaTag, [index]);
            } else {
                this.publicIndex.get(areaTag).push(index);
            }
        }
    }

    appendNewFile() {}

    finish(packetDirectory) {
        async.series(
            [
                callback => {
                    this.messagesStream.on('close', () => {
                        return callback(null);
                    });
                    this.messagesStream.end();
                },
                callback => {
                    if (!this.headersDatStream) {
                        return callback(null);
                    }
                    this.headersDatStream.on('close', () => {
                        return callback(null);
                    });
                    this.headersDatStream.end();
                },
                callback => {
                    return this._createControlData(callback);
                },
                callback => {
                    return this._createIndexes(callback);
                },
                callback => {
                    return this._producePacketArchive(packetDirectory, callback);
                },
            ],
            err => {
                this.temptmp.cleanup();

                if (err) {
                    return this.emit('error', err);
                }

                this.emit('finished');
            }
        );
    }

    _getNextAvailPacketFileName(packetDirectory, cb) {
        //
        //  According to http://wiki.synchro.net/ref:qwk filenames should
        //  start with .QWK -> .QW1 ... .QW9 -> .Q10 ... .Q99
        //
        let digits = 0;
        async.doWhilst(
            callback => {
                let ext;
                if (0 === digits) {
                    ext = 'QWK';
                } else if (digits < 10) {
                    ext = `QW${digits}`;
                } else if (digits < 100) {
                    ext = `Q${digits}`;
                } else {
                    return callback(
                        Errors.UnexpectedState(
                            'Unable to choose a valid QWK output filename'
                        )
                    );
                }

                ++digits;

                const filename = `${this.options.bbsID}.${ext}`;
                fs.stat(paths.join(packetDirectory, filename), err => {
                    if (err && 'ENOENT' === err.code) {
                        return callback(null, filename);
                    } else {
                        return callback(null, null);
                    }
                });
            },
            (filename, callback) => {
                return callback(null, filename ? false : true);
            },
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

    _qwkMessageStatus(message) {
        //  - Public vs Private
        //  - Look at message pointers for read status
        //  - If +op is exporting and this message is to +op
        //  -
        //  :TODO: this needs addressed - handle unread vs read, +op, etc.
        //  ....see getNewMessagesInAreaForUser(); Variant with just IDs, or just a way to get first new message ID per area?

        if (message.isPrivate()) {
            return QWKMessageStatusCodes.UnreadPrivate;
        }
        return QWKMessageStatusCodes.UnreadPublic;
    }

    _writeMessageHeader(message, totalBlocks) {
        const asciiNum = (n, l) => {
            if (isNaN(n)) {
                return '';
            }
            return n.toString().substr(0, l);
        };

        const asciiTotalBlocks = asciiNum(totalBlocks, 6);
        if (asciiTotalBlocks.length > 6) {
            this.emit('warning', Errors.General('Message too large for packet'), message);
            return false;
        }

        const conferenceNumber = this._getMessageConferenceNumberByAreaTag(
            message.areaTag
        );
        if (isNaN(conferenceNumber)) {
            this.emit(
                'warning',
                Errors.MissingConfig(
                    `No QWK conference mapping for areaTag ${message.areaTag}`
                )
            );
            return false;
        }

        const header = Buffer.alloc(QWKMessageBlockSize, ' ');
        header.write(this._qwkMessageStatus(message), 0, 1, 'ascii');
        header.write(asciiNum(message.messageId), 1, 'ascii');
        header.write(
            message.modTimestamp.format(QWKHeaderTimestampFormat),
            8,
            13,
            'ascii'
        );
        header.write(message.toUserName.substr(0, 25), 21, 'ascii');
        header.write(message.fromUserName.substr(0, 25), 46, 'ascii');
        header.write(message.subject.substr(0, 25), 71, 'ascii');
        header.write(' '.repeat(12), 96, 'ascii'); //  we don't use the password field
        header.write(asciiNum(message.replyToMsgId), 108, 'ascii');
        header.write(asciiTotalBlocks, 116, 'ascii');
        header.writeUInt8(QWKMessageActiveStatus.Active, 122);
        header.writeUInt16LE(conferenceNumber, 123);
        header.writeUInt16LE(this.totalMessages + 1, 125);
        header.write(QWKNetworkTagIndicator.NotPresent, 127, 1, 'ascii'); //  :TODO: Present if for network output?

        this.messagesStream.write(header);

        return true;
    }

    _getMessageConferenceNumberByAreaTag(areaTag) {
        if (Message.isPrivateAreaTag(areaTag)) {
            return 0;
        }

        return this.areaTagConfMap[areaTag];
    }

    _getExportForUsername() {
        return _.get(this.options, 'user.username', 'Any');
    }

    _getExportSysOpUsername() {
        return StatLog.getSystemStat(SysProps.SysOpUsername) || 'SysOp';
    }

    _createControlData(cb) {
        const areas = Array.from(this.areaTagsSeen).map(areaTag => {
            if (Message.isPrivateAreaTag(areaTag)) {
                return {
                    areaTag: Message.WellKnownAreaTags.Private,
                    name: 'Private',
                    desc: 'Private Messages',
                };
            }
            return getMessageAreaByTag(areaTag);
        });

        const controlStream = fs.createWriteStream(
            paths.join(this.workDir, 'control.dat')
        );
        controlStream.setDefaultEncoding('ascii');

        controlStream.on('close', () => {
            return cb(null);
        });

        controlStream.on('error', err => {
            return cb(err);
        });

        const initialControlData = [
            Config().general.boardName,
            'Earth',
            'XXX-XXX-XXX',
            `${this._getExportSysOpUsername()}, Sysop`,
            `0000,${this.options.bbsID}`,
            moment().format('MM-DD-YYYY,HH:mm:ss'),
            this._getExportForUsername(),
            '', // name of Qmail menu
            '0', // uh, OK
            this.totalMessages.toString(),
            //  this next line is total conferences - 1:
            //  We have areaTag <> conference mapping, so the number should work out
            (this.areaTagsSeen.size - 1).toString(),
        ];

        initialControlData.forEach(line => {
            controlStream.write(`${line}\r\n`);
        });

        //  map areas as conf #\r\nDescription\r\n pairs
        areas.forEach(area => {
            const conferenceNumber = this._getMessageConferenceNumberByAreaTag(
                area.areaTag
            );
            const conf = getMessageConferenceByTag(area.confTag);
            const desc = `${conf.name} - ${area.name}`;

            controlStream.write(`${conferenceNumber}\r\n`);
            controlStream.write(`${desc}\r\n`);
        });

        //  :TODO: do we ever care here?!
        ['HELLO', 'BBSNEWS', 'GOODBYE'].forEach(trailer => {
            controlStream.write(`${trailer}\r\n`);
        });

        controlStream.end();
    }

    _createIndexes(cb) {
        const appendIndexData = (stream, offset) => {
            const msb = numToMbf32(offset);
            stream.write(msb);

            //  technically, the conference #, but only as a byte, so pretty much useless
            //  AND the filename itself is the conference number... dafuq.
            stream.write(Buffer.from([0x00]));
        };

        async.series(
            [
                callback => {
                    //  Create PERSONAL.NDX
                    if (!this.personalIndex.length) {
                        return callback(null);
                    }

                    const indexStream = fs.createWriteStream(
                        paths.join(this.workDir, 'personal.ndx')
                    );
                    this.personalIndex.forEach(offset =>
                        appendIndexData(indexStream, offset)
                    );

                    indexStream.on('close', err => {
                        return callback(err);
                    });

                    indexStream.end();
                },
                callback => {
                    //  000.NDX of private mails
                    if (!this.inboxIndex.length) {
                        return callback(null);
                    }

                    const indexStream = fs.createWriteStream(
                        paths.join(this.workDir, '000.ndx')
                    );
                    this.inboxIndex.forEach(offset =>
                        appendIndexData(indexStream, offset)
                    );

                    indexStream.on('close', err => {
                        return callback(err);
                    });

                    indexStream.end();
                },
                callback => {
                    //  ####.NDX
                    async.eachSeries(
                        this.publicIndex.keys(),
                        (areaTag, nextArea) => {
                            const offsets = this.publicIndex.get(areaTag);
                            const conferenceNumber =
                                this._getMessageConferenceNumberByAreaTag(areaTag);
                            const indexStream = fs.createWriteStream(
                                paths.join(
                                    this.workDir,
                                    `${conferenceNumber.toString().padStart(4, '0')}.ndx`
                                )
                            );
                            offsets.forEach(offset =>
                                appendIndexData(indexStream, offset)
                            );

                            indexStream.on('close', err => {
                                return nextArea(err);
                            });

                            indexStream.end();
                        },
                        err => {
                            return callback(err);
                        }
                    );
                },
            ],
            err => {
                return cb(err);
            }
        );
    }

    _makeSynchronetTimestamp(ts) {
        const syncTimestamp = ts.format('YYYYMMDDHHmmssZZ');
        const syncTZ = UTCOffsetToSMBTZ[ts.format('Z')] || '0000'; //  :TODO: what if we don't have a map?
        return `${syncTimestamp} ${syncTZ}`;
    }

    _appendHeadersExtensionData(message, encoding) {
        const messageData = {
            //  Synchronet style
            Utf8: 'utf8' === encoding ? 'true' : 'false',
            'Message-ID': this.makeMessageIdentifier(message),

            WhenWritten: this._makeSynchronetTimestamp(message.modTimestamp),
            // WhenImported    : '',   //  :TODO: only if we have a imported time from another external system?
            ExportedFrom: `${this.options.systemID} ${message.areaTag} ${message.messageId}`,
            Sender: message.fromUserName,

            //  :TODO: if exporting for QWK-Net style/etc.
            //SenderNetAddr

            SenderIpAddr: '127.0.0.1', //  no sir, that's private.
            SenderHostName: this.options.systemDomain,
            //  :TODO: if exported:
            //SenderProtocol
            Organization: 'BBS',

            //'Reply-To'      : :TODO: "address to direct replies".... ?!
            Subject: message.subject,
            To: message.toUserName,
            //ToNetAddr     : :TODO: net addr to?!

            //  :TODO: Only set if not imported:
            Tags: message.hashTags.join(' '),

            //  :TODO: Needs tested with Sync/etc.; Sync wants Conference *numbers*
            Conference: message.isPrivate()
                ? '0'
                : getMessageConfTagByAreaTag(message.areaTag),

            //  ENiGMA Headers
            MessageUUID: message.messageUuid,
            ModTimestamp: message.modTimestamp.format('YYYY-MM-DDTHH:mm:ss.SSSZ'),
            AreaTag: message.areaTag,
        };

        const externalFlavor =
            message.meta.System[Message.SystemMetaNames.ExternalFlavor];
        if (externalFlavor === Message.AddressFlavor.FTN) {
            //  Add FTN properties if it came from such an origin
            if (message.meta.FtnProperty) {
                const ftnProp = message.meta.FtnProperty;
                messageData['X-FTN-AREA'] = ftnProp[Message.FtnPropertyNames.FtnArea];
                messageData['X-FTN-SEEN-BY'] =
                    ftnProp[Message.FtnPropertyNames.FtnSeenBy];
            }

            if (message.meta.FtnKludge) {
                const ftnKludge = message.meta.FtnKludge;
                messageData['X-FTN-PATH'] = ftnKludge.PATH;
                messageData['X-FTN-MSGID'] = ftnKludge.MSGID;
                messageData['X-FTN-REPLY'] = ftnKludge.REPLY;
                messageData['X-FTN-PID'] = ftnKludge.PID;
                messageData['X-FTN-FLAGS'] = ftnKludge.FLAGS;
                messageData['X-FTN-TID'] = ftnKludge.TID;
                messageData['X-FTN-CHRS'] = ftnKludge.CHRS;
            }
        } else {
            messageData.WhenExported = this._makeSynchronetTimestamp(moment());
            messageData.Editor = `ENiGMA 1/2 BBS FSE v${enigmaVersion}`;
        }

        this.headersDatStream.write(
            this._encodeWithFallback(
                `[${this.currentMessageOffset.toString(16)}]\r\n`,
                encoding
            )
        );

        for (let [name, value] of Object.entries(messageData)) {
            if (value) {
                this.headersDatStream.write(
                    this._encodeWithFallback(`${name}: ${value}\r\n`, encoding)
                );
            }
        }

        this.headersDatStream.write('\r\n');
    }
}

module.exports = {
    QWKPacketReader,
    QWKPacketWriter,
};
