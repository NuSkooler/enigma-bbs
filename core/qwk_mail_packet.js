

const ArchiveUtil = require('./archive_util');
const { Errors } = require('./enig_error');
const Message = require('./message');
const { splitTextAtTerms } = require('./string_util');

const { EventEmitter } = require('events');
const temptmp = require('temptmp').createTrackedSession('qwk_packet');
const async = require('async');
const fs = require('graceful-fs');
const paths = require('path');
const { Parser } = require('binary-parser');
const iconv = require('iconv-lite');
const moment = require('moment');
const _ = require('lodash');

const SMBTZToUTCOffset = (smbTZ) => {
    //  convert a Synchronet smblib TZ to a UTC offset
    //  see https://github.com/kvadevack/synchronet/blob/master/src/smblib/smbdefs.h
    return {
        //  US Standard
        '40F0'  : '-04:00', //  Atlantic
        '412C'  : '-05:00', //  Eastern
        '4168'  : '-06:00', //  Central
        '41A4'  : '-07:00', //  Mountain
        '41E0'  : '-08:00', //  Pacific
        '421C'  : '-09:00', //  Yukon
        '4258'  : '-10:00', //  Hawaii/Alaska
        '4294'  : '-11:00', //  Bering

        //  US Daylight

    }[smbTZ];
};

const QWKMessageBlockSize = 128;

const MessageHeaderParser = new Parser()
    .endianess('little')
    .string('status', {
        encoding    : 'ascii',
        length      : 1,
    })
    .string('num', {    //  message num or conf num for REP's
        encoding    : 'ascii',
        length      : 7,
        formatter   : n => {
            return parseInt(n);
        }
    })
    .string('timestamp', {
        encoding    : 'ascii',
        length      : 13,
    })
    //  these fields may be encoded in something other than ascii/CP437
    .array('toName', {
        type    : 'uint8',
        length  : 25,
    })
    .array('fromName', {
        type    : 'uint8',
        length  : 25,
    })
    .array('subject', {
        type    : 'uint8',
        length  : 25,
    })
    .string('password', {
        encoding    : 'ascii',
        length      : 12,
    })
    .string('replyToNum', {
        encoding    : 'ascii',
        length      : 8,
        formatter   : n => {
            return parseInt(n);
        }
    })
    .string('numBlocks', {
        encoding    : 'ascii',
        length      : 6,
        formatter   : n => {
            return parseInt(n);
        }
    })
    .uint8('status2')
    .uint16('confNum')
    .uint16('relNum')
    .uint8('netTag');


class QWKPacketReader extends EventEmitter {
    constructor(packetPath, mode=QWKPacketReader.Modes.Guess, options = { keepTearAndOrigin : true } ) {
        super();

        this.packetPath = packetPath;
        this.mode       = mode;
        this.options    = options;
    }

    static get Modes() {
        return {
            Guess   : 'guess',  //  try to guess
            QWK     : 'qwk',    //  standard incoming packet
            REP     : 'rep',    //  a reply packet
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
                (callback) => {
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
                    temptmp.mkdir( { prefix : 'enigqwkpacket-'}, (err, tempDir) => {
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
                                    case 'MESSAGES.DAT' :   //  QWK
                                        if (this.mode === QWKPacketReader.Modes.Guess) {
                                            this.mode = QWKPacketReader.Modes.QWK;
                                        }
                                        if (this.mode === QWKPacketReader.Modes.QWK) {
                                            out.messages = { filename };
                                        }
                                        break;

                                    case 'ID.MSG' :
                                        if (this.mode === QWKPacketReader.Modes.Guess) {
                                            this.mode = Modes.REP;
                                        }

                                        if (this.mode === QWKPacketReader.Modes.REP) {
                                            out.messages = { filename };
                                        }
                                        break;

                                    case 'HEADERS.DAT' :    //  Synchronet
                                        out.headers = { filename };
                                        break;

                                    case 'VOTING.DAT' : //  Synchronet
                                        out.voting = { filename };
                                        break;

                                    case 'CONTROL.DAT' :    //  QWK
                                        out.control = { filename };
                                        break;

                                    case 'DOOR.ID' :    //  QWK
                                        out.door = { filename };
                                        break;

                                    case 'NETFLAGS.DAT' :   //  QWK
                                        out.netflags = { filename };
                                        break;

                                    case 'NEWFILES.DAT' :   //  QWK
                                        out.newfiles = { filename };
                                        break;

                                    case 'PERSONAL.NDX' : //    QWK
                                        out.personal = { filename };
                                        break;

                                    case '000.NDX' : // QWK
                                        out.inbox = { filename };
                                        break;

                                    case 'TOREADER.EXT' :   //  QWKE
                                        out.toreader = { filename };
                                        break;

                                    case 'QLR.DAT' :
                                        out.qlr = { filename };
                                        break;

                                    default :
                                        if (/[0-9]+\.NDX/.test(key)) {  //  QWK
                                            out.pointers = out.pointers || { filenames: [] };
                                            out.pointers.filenames.push(filename);
                                        } else {
                                            out[key] = { filename };
                                        }
                                        break;
                                }

                                return next(null, out);
                            },
                            (err, packetFileInfo) => {
                                this.packetInfo = Object.assign(
                                    {},
                                    packetFileInfo,
                                    {
                                        tempDir,
                                        defaultEncoding : 'CP437'
                                    }
                                );
                                return callback(null);
                            }
                        );
                    });
                },
                (callback) => {
                    return this.processPacketFiles(callback);
                },
                (tempDir, callback) => {
                    return callback(null);
                }
            ],
            err => {
                temptmp.cleanup();

                if (err) {
                    return this.emit('error', err);
                }

                this.emit('done');
            }
        );
    }

    processPacketFiles(cb) {
        return this.readMessages(cb);
    }

    readMessages(cb) {
        //  :TODO: update to use proper encoding: if headers.dat specifies UTF-8, use that, else CP437
        if (!this.packetInfo.messages) {
            return cb(Errors.DoesNotExist('No messages file found within QWK packet'));
        }

        const encoding = this.packetInfo.defaultEncoding;
        const path = paths.join(this.packetInfo.tempDir, this.packetInfo.messages.filename);
        fs.open(path, 'r', (err, fd) => {
            if (err) {
                return cb(err);
            }

            let blockCount = 0;
            let currMessage = { };
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
                        return cb(Errors.Invalid(`Invalid QWK message block size. Expected ${QWKMessageBlockSize} got ${read}`));
                    }

                    if (0 === blockCount) {
                        //  first 128 bytes is a space padded ID
                        const id = buffer.toString('ascii').trim();
                        this.emit('generator', id);
                        state = 'header';
                    } else {
                        switch (state) {
                            case 'header' :
                                const header = MessageHeaderParser.parse(buffer);

                                //  massage into something a little more sane (things we can't quite do in the parser directly)
                                ['toName', 'fromName', 'subject'].forEach(field => {
                                    header[field] = iconv.decode(header[field], encoding).trim();
                                });

                                header.timestamp = moment(header.timestamp, 'MM-DD-YYHH:mm');

                                currMessage = {
                                    header,
                                    //  these may be overridden
                                    toName      : header.toName,
                                    fromName    : header.fromName,
                                    subject     : header.subject,
                                };

                                //  remainder of blocks until the end of this message
                                messageBlocksRemain = header.numBlocks - 1;
                                state = 'message';
                                break;

                            case 'message' :
                                if (!currMessage.body) {
                                    currMessage.body = buffer;
                                } else {
                                    currMessage.body = Buffer.concat([currMessage.body, buffer]);
                                }
                                messageBlocksRemain -= 1;

                                if (0 === messageBlocksRemain) {
                                    //  1:n buffers to make up body. Decode:
                                    //  First, replace QWK style line feeds (0xe3) unless the message is UTF-8.
                                    //  If the message is UTF-8, we assume it's using standard line feeds.
                                    if (encoding !== 'utf8') {
                                        let i = 0;
                                        const QWKLF = Buffer.from([0xe3]);
                                        while (i < currMessage.body.length) {
                                            i = currMessage.body.indexOf(QWKLF, i);
                                            if (-1 === i) {
                                                break;
                                            }
                                            currMessage.body[i] = 0x0a;
                                            ++i;
                                        }
                                    }

                                    //
                                    //  Decode the message based on our final message encoding. Split the message
                                    //  into lines so we can extract various bits such as QWKE headers, origin, tear
                                    //  lines, etc.
                                    //
                                    const messageLines = splitTextAtTerms(iconv.decode(currMessage.body, encoding).trimEnd());
                                    const bodyLines = [];

                                    //
                                    //  Various kludge tags defined by QWKE, etc.
                                    //  See the following:
                                    //  - ftp://vert.synchro.net/main/BBS/qwke.txt
                                    //  - http://wiki.synchro.net/ref:qwk
                                    //
                                    const Kludges = {
                                        //  QWKE
                                        To      : 'To:',
                                        From    : 'From:',
                                        Subject : 'Subject:',

                                        //  Synchronet
                                        Via     : '@VIA:',
                                        MsgID   : '@MSGID:',
                                        Reply   : '@REPLY:',
                                        TZ      : '@TZ:',       //  https://github.com/kvadevack/synchronet/blob/master/src/smblib/smbdefs.h
                                        ReplyTo : '@REPLYTO:',
                                    };

                                    let bodyState = 'kludge';

                                    const MessageTrailers = {
                                        //  While technically FTN oriented, these can come from any network
                                        //  (though we'll be processing a lot of messages that routed through FTN
                                        //  at some point)
                                        Origin  : /^[ ]{1,2}\* Origin: /,
                                        Tear    : /^--- /,
                                    };

                                    const qwkKludge = {};
                                    const ftnProperty = {};

                                    messageLines.forEach(line => {
                                        if (0 === line.length) {
                                            return bodyLines.push('');
                                        }

                                        switch (bodyState) {
                                            case 'kludge' :
                                                //  :TODO: Update these to use the well known consts:
                                                if (line.startsWith(Kludges.To)) {
                                                    currMessage.toName = line.substring(Kludges.To.length).trim();
                                                } else if (line.startsWith(Kludges.From)) {
                                                    currMessage.fromName = line.substring(Kludges.From.length).trim();
                                                } else if (line.startsWith(Kludges.Subject)) {
                                                    currMessage.subject = line.substring(Kludges.Subject.length).trim();
                                                } else if (line.startsWith(Kludges.Via)) {
                                                    qwkKludge.via = line;
                                                } else if (line.startsWith(Kludges.MsgID)) {
                                                    qwkKludge.msg_id = line.substring(Kludges.MsgID.length).trim();
                                                } else if (line.startsWith(Kludges.Reply)) {
                                                    qwkKludge.in_reply_to_msg_id = line.substring(Kludges.Reply.length).trim();
                                                } else if (line.startsWith(Kludges.TZ)) {
                                                    qwkKludge.synchronet_timezone = line.substring(Kludges.TZ.length).trim();
                                                } else if (line.startsWith(Kludges.ReplyTo)) {
                                                    qwkKludge.reply_to = line.substring(Kludges.ReplyTo.length).trim();
                                                } else {
                                                    bodyState = 'body'; // past this point and up to any tear/origin/etc., is the real message body
                                                    bodyLines.push(line);
                                                }
                                                break;

                                            case 'body' :
                                            case 'trailers' :
                                                if (MessageTrailers.Origin.test(line)) {
                                                    ftnProperty.ftn_origin = line;
                                                    bodyState = 'trailers';
                                                } else if (MessageTrailers.Tear.test(line)) {
                                                    ftnProperty.ftn_tear_line = line;
                                                    bodyState = 'trailers';
                                                } else if ('body' === bodyState) {
                                                    bodyLines.push(line);
                                                }
                                        }
                                    });

                                    const message = new Message({
                                        toUserName      : currMessage.toName,
                                        fromUserName    : currMessage.fromName,
                                        subject         : currMessage.subject,
                                        modTimestamp    : currMessage.header.timestamp,
                                        message         : bodyLines.join('\n'),
                                    });

                                    if (!_.isEmpty(qwkKludge)) {
                                        message.meta.QwkKludge = qwkKludge;
                                    }

                                    if (!_.isEmpty(ftnProperty)) {
                                        message.meta.FtnProperty = ftnProperty;
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
                                    if (_.has(message, 'meta.QwkKludge.synchronet_timezone')) {
                                        const tzOffset = SMBTZToUTCOffset(message.meta.QwkKludge.synchronet_timezone);
                                        if (tzOffset) {
                                            message.modTimestamp.utcOffset(tzOffset);
                                        }
                                    }

                                    message.meta.QwkProperty = {
                                        qwk_msg_status          : currMessage.header.status,
                                        qwk_in_reply_to_num     : currMessage.header.replyToNum,
                                    };

                                    if (this.mode === QWKPacketReader.Modes.QWK) {
                                        message.meta.QwkProperty.qwk_msg_num = currMessage.header.num;
                                    } else {
                                        //  For REP's, prefer the larger field.
                                        message.meta.QwkProperty.qwk_conf_num = currMessage.header.num || currMessage.header.confNum;
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
};

module.exports = {
    QWKPacketReader,
//    QWKPacketWriter,
}