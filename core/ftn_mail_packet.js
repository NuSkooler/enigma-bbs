/* jslint node: true */
'use strict';

const ftn = require('./ftn_util.js');
const Message = require('./message.js');
const sauce = require('./sauce.js');
const Address = require('./ftn_address.js');
const strUtil = require('./string_util.js');
const Log = require('./logger.js').log;
const ansiPrep = require('./ansi_prep.js');
const Errors = require('./enig_error.js').Errors;

const _ = require('lodash');
const assert = require('assert');
const { Parser } = require('binary-parser');
const fs = require('graceful-fs');
const async = require('async');
const iconv = require('iconv-lite');
const moment = require('moment');

exports.Packet = Packet;

const FTN_PACKET_HEADER_SIZE = 58; //  fixed header size
const FTN_PACKET_HEADER_TYPE = 2;
const FTN_PACKET_MESSAGE_TYPE = 2;
const FTN_PACKET_BAUD_TYPE_2_2 = 2;

//  SAUCE magic header + version ("00")
const FTN_MESSAGE_SAUCE_HEADER = Buffer.from('SAUCE00');

const FTN_MESSAGE_KLUDGE_PREFIX = '\x01';

class PacketHeader {
    constructor(origAddr, destAddr, version, createdMoment) {
        const EMPTY_ADDRESS = {
            node: 0,
            net: 0,
            zone: 0,
            point: 0,
        };

        this.version = version || '2+';
        this.origAddress = origAddr || EMPTY_ADDRESS;
        this.destAddress = destAddr || EMPTY_ADDRESS;
        this.created = createdMoment || moment();

        //  uncommon to set the following explicitly
        this.prodCodeLo = 0xfe; //  http://ftsc.org/docs/fta-1005.003
        this.prodRevLo = 0;
        this.baud = 0;
        this.packetType = FTN_PACKET_HEADER_TYPE;
        this.password = '';
        this.prodData = 0x47694e45; //  "ENiG"

        this.capWord = 0x0001;
        this.capWordValidate =
            ((this.capWord & 0xff) << 8) | ((this.capWord >> 8) & 0xff); //  swap

        this.prodCodeHi = 0xfe; //  see above
        this.prodRevHi = 0;
    }

    get origAddress() {
        let addr = new Address({
            node: this.origNode,
            zone: this.origZone,
        });

        if (this.origPoint) {
            addr.point = this.origPoint;
            addr.net = this.auxNet;
        } else {
            addr.net = this.origNet;
        }

        return addr;
    }

    set origAddress(address) {
        if (_.isString(address)) {
            address = Address.fromString(address);
        }

        this.origNode = address.node;

        //  See FSC-48
        //  :TODO: disabled for now until we have separate packet writers for 2, 2+, 2+48, and 2.2
        /*if(address.point) {
            this.auxNet     = address.origNet;
            this.origNet    = -1;
        } else {
            this.origNet    = address.net;
            this.auxNet     = 0;
        }
        */
        this.origNet = address.net;
        this.auxNet = 0;

        this.origZone = address.zone;
        this.origZone2 = address.zone;
        this.origPoint = address.point || 0;
    }

    get destAddress() {
        let addr = new Address({
            node: this.destNode,
            net: this.destNet,
            zone: this.destZone,
        });

        if (this.destPoint) {
            addr.point = this.destPoint;
        }

        return addr;
    }

    set destAddress(address) {
        if (_.isString(address)) {
            address = Address.fromString(address);
        }

        this.destNode = address.node;
        this.destNet = address.net;
        this.destZone = address.zone;
        this.destZone2 = address.zone;
        this.destPoint = address.point || 0;
    }

    get created() {
        return moment({
            year: this.year,
            month: this.month - 1, //  moment uses 0 indexed months
            date: this.day,
            hour: this.hour,
            minute: this.minute,
            second: this.second,
        });
    }

    set created(momentCreated) {
        if (!moment.isMoment(momentCreated)) {
            momentCreated = moment(momentCreated);
        }

        this.year = momentCreated.year();
        this.month = momentCreated.month() + 1; //  moment uses 0 indexed months
        this.day = momentCreated.date(); //  day of month
        this.hour = momentCreated.hour();
        this.minute = momentCreated.minute();
        this.second = momentCreated.second();
    }
}

exports.PacketHeader = PacketHeader;

//
//  Read/Write FTN packets with support for the following formats:
//
//  *   Type 2 FTS-0001 @ http://ftsc.org/docs/fts-0001.016 (Obsolete)
//  *   Type 2.2 FSC-0045   @ http://ftsc.org/docs/fsc-0045.001
//  *   Type 2+ FSC-0039 and FSC-0048 @ http://ftsc.org/docs/fsc-0039.004
//      and http://ftsc.org/docs/fsc-0048.002
//
//  Additional resources:
//  *   Writeup on differences between type 2, 2.2, and 2+:
//      http://walon.org/pub/fidonet/FTSC-nodelists-etc./pkt-types.txt
//
const PacketHeaderParser = new Parser()
    .uint16le('origNode')
    .uint16le('destNode')
    .uint16le('year')
    .uint16le('month')
    .uint16le('day')
    .uint16le('hour')
    .uint16le('minute')
    .uint16le('second')
    .uint16le('baud')
    .uint16le('packetType')
    .uint16le('origNet')
    .uint16le('destNet')
    .int8('prodCodeLo')
    .int8('prodRevLo') //  aka serialNo
    .buffer('password', { length: 8 }) //  can't use string; need CP437 - see https://github.com/keichi/binary-parser/issues/33
    .uint16le('origZone')
    .uint16le('destZone')
    //
    //  The following is "filler" in FTS-0001, specifics in
    //  FSC-0045 and FSC-0048
    //
    .uint16le('auxNet')
    .uint16le('capWordValidate')
    .int8('prodCodeHi')
    .int8('prodRevHi')
    .uint16le('capWord')
    .uint16le('origZone2')
    .uint16le('destZone2')
    .uint16le('origPoint')
    .uint16le('destPoint')
    .uint32le('prodData');

const MessageHeaderParser = new Parser()
    .uint16le('messageType')
    .uint16le('ftn_msg_orig_node')
    .uint16le('ftn_msg_dest_node')
    .uint16le('ftn_msg_orig_net')
    .uint16le('ftn_msg_dest_net')
    .uint16le('ftn_attr_flags')
    .uint16le('ftn_cost')
    //
    //  It would be nice to just string() these, but we want CP437 which requires
    //  iconv. Another option would be to use a formatter, but until issue 33
    //  (https://github.com/keichi/binary-parser/issues/33) is fixed, this is cumbersome.
    //
    .array('modDateTime', {
        type: 'uint8',
        length: 20, //  FTS-0001.016: 20 bytes
    })
    .array('toUserName', {
        type: 'uint8',
        //  :TODO: array needs some soft of 'limit' field
        readUntil: b => 0x00 === b,
    })
    .array('fromUserName', {
        type: 'uint8',
        readUntil: b => 0x00 === b,
    })
    .array('subject', {
        type: 'uint8',
        readUntil: b => 0x00 === b,
    })
    .array('message', {
        type: 'uint8',
        readUntil: b => 0x00 === b,
    });

function Packet(options) {
    var self = this;

    this.options = options || {};

    this.parsePacketHeader = function (packetBuffer, cb) {
        assert(Buffer.isBuffer(packetBuffer));

        let packetHeader;
        try {
            packetHeader = PacketHeaderParser.parse(packetBuffer);
        } catch (e) {
            return Errors.Invalid(`Unable to parse FTN packet header: ${e.message}`);
        }

        //  Convert password from NULL padded array to string
        packetHeader.password = strUtil.stringFromNullTermBuffer(
            packetHeader.password,
            'CP437'
        );

        if (FTN_PACKET_HEADER_TYPE !== packetHeader.packetType) {
            return cb(
                Errors.Invalid(
                    `Unsupported FTN packet header type: ${packetHeader.packetType}`
                )
            );
        }

        //
        //  What kind of packet do we really have here?
        //
        //  :TODO: adjust values based on version discovered
        if (FTN_PACKET_BAUD_TYPE_2_2 === packetHeader.baud) {
            packetHeader.version = '2.2';

            //  See FSC-0045
            packetHeader.origPoint = packetHeader.year;
            packetHeader.destPoint = packetHeader.month;

            packetHeader.destDomain = packetHeader.origZone2;
            packetHeader.origDomain = packetHeader.auxNet;
        } else {
            //
            //  See heuristics described in FSC-0048, "Receiving Type-2+ bundles"
            //
            const capWordValidateSwapped =
                ((packetHeader.capWordValidate & 0xff) << 8) |
                ((packetHeader.capWordValidate >> 8) & 0xff);

            if (
                capWordValidateSwapped === packetHeader.capWord &&
                0 != packetHeader.capWord &&
                packetHeader.capWord & 0x0001
            ) {
                packetHeader.version = '2+';

                //  See FSC-0048
                if (-1 === packetHeader.origNet) {
                    packetHeader.origNet = packetHeader.auxNet;
                }
            } else {
                packetHeader.version = '2';

                //  :TODO: should fill bytes be 0?
            }
        }

        packetHeader.created = moment({
            year: packetHeader.year,
            month: packetHeader.month - 1, //  moment uses 0 indexed months
            date: packetHeader.day,
            hour: packetHeader.hour,
            minute: packetHeader.minute,
            second: packetHeader.second,
        });

        const ph = new PacketHeader();
        _.assign(ph, packetHeader);

        return cb(null, ph);
    };

    this.getPacketHeaderBuffer = function (packetHeader) {
        let buffer = Buffer.alloc(FTN_PACKET_HEADER_SIZE);

        buffer.writeUInt16LE(packetHeader.origNode, 0);
        buffer.writeUInt16LE(packetHeader.destNode, 2);
        buffer.writeUInt16LE(packetHeader.year, 4);
        buffer.writeUInt16LE(packetHeader.month, 6);
        buffer.writeUInt16LE(packetHeader.day, 8);
        buffer.writeUInt16LE(packetHeader.hour, 10);
        buffer.writeUInt16LE(packetHeader.minute, 12);
        buffer.writeUInt16LE(packetHeader.second, 14);

        buffer.writeUInt16LE(packetHeader.baud, 16);
        buffer.writeUInt16LE(FTN_PACKET_HEADER_TYPE, 18);
        buffer.writeUInt16LE(
            -1 === packetHeader.origNet ? 0xffff : packetHeader.origNet,
            20
        );
        buffer.writeUInt16LE(packetHeader.destNet, 22);
        buffer.writeUInt8(packetHeader.prodCodeLo, 24);
        buffer.writeUInt8(packetHeader.prodRevHi, 25);

        const pass = ftn.stringToNullPaddedBuffer(packetHeader.password, 8);
        pass.copy(buffer, 26);

        buffer.writeUInt16LE(packetHeader.origZone, 34);
        buffer.writeUInt16LE(packetHeader.destZone, 36);
        buffer.writeUInt16LE(packetHeader.auxNet, 38);
        buffer.writeUInt16LE(packetHeader.capWordValidate, 40);
        buffer.writeUInt8(packetHeader.prodCodeHi, 42);
        buffer.writeUInt8(packetHeader.prodRevLo, 43);
        buffer.writeUInt16LE(packetHeader.capWord, 44);
        buffer.writeUInt16LE(packetHeader.origZone2, 46);
        buffer.writeUInt16LE(packetHeader.destZone2, 48);
        buffer.writeUInt16LE(packetHeader.origPoint, 50);
        buffer.writeUInt16LE(packetHeader.destPoint, 52);
        buffer.writeUInt32LE(packetHeader.prodData, 54);

        return buffer;
    };

    this.writePacketHeader = function (packetHeader, ws) {
        let buffer = Buffer.alloc(FTN_PACKET_HEADER_SIZE);

        buffer.writeUInt16LE(packetHeader.origNode, 0);
        buffer.writeUInt16LE(packetHeader.destNode, 2);
        buffer.writeUInt16LE(packetHeader.year, 4);
        buffer.writeUInt16LE(packetHeader.month, 6);
        buffer.writeUInt16LE(packetHeader.day, 8);
        buffer.writeUInt16LE(packetHeader.hour, 10);
        buffer.writeUInt16LE(packetHeader.minute, 12);
        buffer.writeUInt16LE(packetHeader.second, 14);

        buffer.writeUInt16LE(packetHeader.baud, 16);
        buffer.writeUInt16LE(FTN_PACKET_HEADER_TYPE, 18);
        buffer.writeUInt16LE(
            -1 === packetHeader.origNet ? 0xffff : packetHeader.origNet,
            20
        );
        buffer.writeUInt16LE(packetHeader.destNet, 22);
        buffer.writeUInt8(packetHeader.prodCodeLo, 24);
        buffer.writeUInt8(packetHeader.prodRevHi, 25);

        const pass = ftn.stringToNullPaddedBuffer(packetHeader.password, 8);
        pass.copy(buffer, 26);

        buffer.writeUInt16LE(packetHeader.origZone, 34);
        buffer.writeUInt16LE(packetHeader.destZone, 36);
        buffer.writeUInt16LE(packetHeader.auxNet, 38);
        buffer.writeUInt16LE(packetHeader.capWordValidate, 40);
        buffer.writeUInt8(packetHeader.prodCodeHi, 42);
        buffer.writeUInt8(packetHeader.prodRevLo, 43);
        buffer.writeUInt16LE(packetHeader.capWord, 44);
        buffer.writeUInt16LE(packetHeader.origZone2, 46);
        buffer.writeUInt16LE(packetHeader.destZone2, 48);
        buffer.writeUInt16LE(packetHeader.origPoint, 50);
        buffer.writeUInt16LE(packetHeader.destPoint, 52);
        buffer.writeUInt32LE(packetHeader.prodData, 54);

        ws.write(buffer);

        return buffer.length;
    };

    this.processMessageBody = function (messageBodyBuffer, cb) {
        //
        //  From FTS-0001.16:
        //      "Message text is unbounded and null terminated (note exception below).
        //
        //      A 'hard' carriage return, 0DH,  marks the end of a paragraph, and must
        //      be preserved.
        //
        //      So   called  'soft'  carriage  returns,  8DH,  may  mark  a   previous
        //      processor's  automatic line wrap, and should be ignored.  Beware  that
        //      they may be followed by linefeeds, or may not.
        //
        //      All  linefeeds, 0AH, should be ignored.  Systems which display message
        //      text should wrap long lines to suit their application."
        //
        //  This can be a bit tricky:
        //  *   Decoding as CP437 converts 0x8d -> 0xec, so we'll need to correct for that
        //  *   Many kludge lines specify an encoding. If we find one of such lines, we'll
        //      likely need to re-decode as the specified encoding
        //  *   SAUCE is binary-ish data, so we need to inspect for it before any
        //      decoding occurs
        //
        let messageBodyData = {
            message: [],
            kludgeLines: {}, //  KLUDGE:[value1, value2, ...] map
            seenBy: [],
        };

        function addKludgeLine(line) {
            //
            //  We have to special case INTL/TOPT/FMPT as they don't contain
            //  a ':' name/value separator like the rest of the kludge lines... because stupdity.
            //
            let key = line.substr(0, 4).trim();
            let value;
            if (['INTL', 'TOPT', 'FMPT', 'Via'].includes(key)) {
                value = line.substr(key.length).trim();
            } else {
                const sepIndex = line.indexOf(':');
                key = line.substr(0, sepIndex).toUpperCase();
                value = line.substr(sepIndex + 1).trim();
            }

            //
            //  Allow mapped value to be either a key:value if there is only
            //  one entry, or key:[value1, value2,...] if there are more
            //
            if (messageBodyData.kludgeLines[key]) {
                if (!_.isArray(messageBodyData.kludgeLines[key])) {
                    messageBodyData.kludgeLines[key] = [messageBodyData.kludgeLines[key]];
                }
                messageBodyData.kludgeLines[key].push(value);
            } else {
                messageBodyData.kludgeLines[key] = value;
            }
        }

        let encoding = 'cp437';

        async.series(
            [
                function extractSauce(callback) {
                    //  :TODO: This is wrong: SAUCE may not have EOF marker for one, also if it's
                    //  present, we need to extract it but keep the rest of hte message intact as it likely
                    //  has SEEN-BY, PATH, and other kludge information *appended*
                    const sauceHeaderPosition = messageBodyBuffer.indexOf(
                        FTN_MESSAGE_SAUCE_HEADER
                    );
                    if (sauceHeaderPosition > -1) {
                        sauce.readSAUCE(
                            messageBodyBuffer.slice(
                                sauceHeaderPosition,
                                sauceHeaderPosition + sauce.SAUCE_SIZE
                            ),
                            (err, theSauce) => {
                                if (!err) {
                                    //  we read some SAUCE - don't re-process that portion into the body
                                    messageBodyBuffer =
                                        messageBodyBuffer.slice(0, sauceHeaderPosition) +
                                        messageBodyBuffer.slice(
                                            sauceHeaderPosition + sauce.SAUCE_SIZE
                                        );
                                    //                              messageBodyBuffer       = messageBodyBuffer.slice(0, sauceHeaderPosition);
                                    messageBodyData.sauce = theSauce;
                                } else {
                                    Log.warn(
                                        { error: err.message },
                                        'Found what looks like to be a SAUCE record, but failed to read'
                                    );
                                }
                                return callback(null); //  failure to read SAUCE is OK
                            }
                        );
                    } else {
                        callback(null);
                    }
                },
                function extractChrsAndDetermineEncoding(callback) {
                    //
                    //  From FTS-5003.001:
                    //  "The CHRS control line is formatted as follows:
                    //
                    //  ^ACHRS: <identifier> <level>
                    //
                    //  Where <identifier> is a character string of no more than eight (8)
                    //  ASCII characters identifying the character set or character encoding
                    //  scheme used, and level is a positive integer value describing what
                    //  level of CHRS the  message is written in."
                    //
                    //  Also according to the spec, the deprecated "CHARSET" value may be used
                    //  :TODO: Look into CHARSET more - should we bother supporting it?
                    //  :TODO: See encodingFromHeader() for CHRS/CHARSET support @ https://github.com/Mithgol/node-fidonet-jam
                    const FTN_CHRS_PREFIX = Buffer.from([
                        0x01, 0x43, 0x48, 0x52, 0x53, 0x3a, 0x20,
                    ]); //  "\x01CHRS:"
                    const FTN_CHRS_SUFFIX = Buffer.from([0x0d]);

                    let chrsPrefixIndex = messageBodyBuffer.indexOf(FTN_CHRS_PREFIX);
                    if (chrsPrefixIndex < 0) {
                        return callback(null);
                    }

                    chrsPrefixIndex += FTN_CHRS_PREFIX.length;

                    const chrsEndIndex = messageBodyBuffer.indexOf(
                        FTN_CHRS_SUFFIX,
                        chrsPrefixIndex
                    );
                    if (chrsEndIndex < 0) {
                        return callback(null);
                    }

                    let chrsContent = messageBodyBuffer.slice(
                        chrsPrefixIndex,
                        chrsEndIndex
                    );
                    if (0 === chrsContent.length) {
                        return callback(null);
                    }

                    chrsContent = iconv.decode(chrsContent, 'CP437');
                    const chrsEncoding =
                        ftn.getEncodingFromCharacterSetIdentifier(chrsContent);
                    if (chrsEncoding) {
                        encoding = chrsEncoding;
                    }
                    return callback(null);
                },
                function extractMessageData(callback) {
                    //
                    //  Decode |messageBodyBuffer| using |encoding| defaulted or detected above
                    //
                    //  :TODO: Look into \xec thing more - document
                    let decoded;
                    try {
                        decoded = iconv.decode(messageBodyBuffer, encoding);
                    } catch (e) {
                        Log.debug(
                            { encoding: encoding, error: e.toString() },
                            'Error decoding. Falling back to ASCII'
                        );
                        decoded = iconv.decode(messageBodyBuffer, 'ascii');
                    }

                    const messageLines = strUtil.splitTextAtTerms(
                        decoded.replace(/\xec/g, '')
                    );
                    let endOfMessage = false;

                    messageLines.forEach(line => {
                        if (0 === line.length) {
                            messageBodyData.message.push('');
                            return;
                        }

                        if (line.startsWith('AREA:')) {
                            messageBodyData.area = line
                                .substring(line.indexOf(':') + 1)
                                .trim();
                        } else if (line.startsWith('--- ')) {
                            //  Tear Lines are tracked allowing for specialized display/etc.
                            messageBodyData.tearLine = line;
                        } else if (/^[ ]{1,2}\* Origin: /.test(line)) {
                            //  To spec is " * Origin: ..."
                            messageBodyData.originLine = line;
                            endOfMessage = true; //  Anything past origin is not part of the message body
                        } else if (line.startsWith('SEEN-BY:')) {
                            endOfMessage = true; //  Anything past the first SEEN-BY is not part of the message body
                            messageBodyData.seenBy.push(
                                line.substring(line.indexOf(':') + 1).trim()
                            );
                        } else if (FTN_MESSAGE_KLUDGE_PREFIX === line.charAt(0)) {
                            if ('PATH:' === line.slice(1, 6)) {
                                endOfMessage = true; //  Anything pats the first PATH is not part of the message body
                            }
                            addKludgeLine(line.slice(1));
                        } else if (!endOfMessage) {
                            //  regular ol' message line
                            messageBodyData.message.push(line);
                        }
                    });

                    return callback(null);
                },
            ],
            () => {
                messageBodyData.message = messageBodyData.message.join('\n');
                return cb(messageBodyData);
            }
        );
    };

    this.parsePacketMessages = function (header, packetBuffer, iterator, cb) {
        //
        //  Check for end-of-messages marker up front before parse so we can easily
        //  tell the difference between end and bad header
        //
        if (packetBuffer.length < 3) {
            const peek = packetBuffer.slice(0, 2);
            if (
                peek.equals(Buffer.from([0x00])) ||
                peek.equals(Buffer.from([0x00, 0x00]))
            ) {
                //  end marker - no more messages
                return cb(null);
            }
            //  else fall through & hit exception below to log error
        }

        let msgData;
        try {
            msgData = MessageHeaderParser.parse(packetBuffer);
        } catch (e) {
            return cb(Errors.Invalid(`Failed to parse FTN message header: ${e.message}`));
        }

        if (FTN_PACKET_MESSAGE_TYPE != msgData.messageType) {
            return cb(
                Errors.Invalid(`Unsupported FTN message type: ${msgData.messageType}`)
            );
        }

        //
        //  Convert null terminated arrays to strings
        //
        //  From FTS-0001.016:
        //  * modDateTime: 20 bytes exactly (see above)
        //  * toUserName and fromUserName: *max* 36 bytes, aka "up to"; null terminated
        //  * subject: *max* 72 bytes, aka "up to"; null terminated
        //  * message: Unbounded & null terminated
        //
        //  For everything above but message, we can get away with assuming CP437
        //  and probably even just "ascii" for most cases. The message field is
        //  much more complex so we'll look for encoding kludges, detection, etc.
        //  later on.
        //
        if (msgData.modDateTime.length != 20) {
            return cb(
                Errors.Invalid(
                    `FTN packet DateTime field must be 20 bytes (got ${msgData.modDateTime.length})`
                )
            );
        }
        if (msgData.toUserName.length > 36) {
            return cb(
                Errors.Invalid(
                    `FTN packet toUserName field must be 36 bytes max (got ${msgData.toUserName.length})`
                )
            );
        }
        if (msgData.fromUserName.length > 36) {
            return cb(
                Errors.Invalid(
                    `FTN packet fromUserName field must be 36 bytes max (got ${msgData.fromUserName.length})`
                )
            );
        }
        if (msgData.subject.length > 72) {
            return cb(
                Errors.Invalid(
                    `FTN packet subject field must be 72 bytes max (got ${msgData.subject.length})`
                )
            );
        }

        //  Arrays of CP437 bytes -> String
        ['modDateTime', 'toUserName', 'fromUserName', 'subject'].forEach(k => {
            msgData[k] = strUtil.stringFromNullTermBuffer(msgData[k], 'CP437');
        });

        //
        //  The message body itself is a special beast as it may
        //  contain an origin line, kludges, SAUCE in the case
        //  of ANSI files, etc.
        //
        const msg = new Message({
            toUserName: msgData.toUserName,
            fromUserName: msgData.fromUserName,
            subject: msgData.subject,
            modTimestamp: ftn.getDateFromFtnDateTime(msgData.modDateTime),
        });

        //  :TODO: When non-private (e.g. EchoMail), attempt to extract SRC from MSGID vs headers, when avail (or Orgin line? research further)
        msg.meta.FtnProperty = {
            ftn_orig_node: header.origNode,
            ftn_dest_node: header.destNode,
            ftn_orig_network: header.origNet,
            ftn_dest_network: header.destNet,

            ftn_attr_flags: msgData.ftn_attr_flags,
            ftn_cost: msgData.ftn_cost,

            ftn_msg_orig_node: msgData.ftn_msg_orig_node,
            ftn_msg_dest_node: msgData.ftn_msg_dest_node,
            ftn_msg_orig_net: msgData.ftn_msg_orig_net,
            ftn_msg_dest_net: msgData.ftn_msg_dest_net,
        };

        self.processMessageBody(msgData.message, messageBodyData => {
            msg.message = messageBodyData.message;
            msg.meta.FtnKludge = messageBodyData.kludgeLines;

            if (messageBodyData.tearLine) {
                msg.meta.FtnProperty.ftn_tear_line = messageBodyData.tearLine;

                if (self.options.keepTearAndOrigin) {
                    msg.message += `\r\n${messageBodyData.tearLine}\r\n`;
                }
            }

            if (messageBodyData.seenBy.length > 0) {
                msg.meta.FtnProperty.ftn_seen_by = messageBodyData.seenBy;
            }

            if (messageBodyData.area) {
                msg.meta.FtnProperty.ftn_area = messageBodyData.area;
            }

            if (messageBodyData.originLine) {
                msg.meta.FtnProperty.ftn_origin = messageBodyData.originLine;

                if (self.options.keepTearAndOrigin) {
                    msg.message += `${messageBodyData.originLine}\r\n`;
                }
            }

            //
            //  Attempt to handle FTN time zone kludges of 'TZUTC' and
            //  'TZUTCINFO'.
            //
            //  See http://ftsc.org/docs/frl-1004.002
            //
            const tzKludge = msg.meta.FtnKludge.TZUTC || msg.meta.FtnKludge.TZUTCINFO;
            const tzMatch = /([+-]?)([0-9]{2})([0-9]{2})/.exec(tzKludge);
            if (tzMatch) {
                //
                //  - Both kludges should provide a offset in hhmm format
                //  - Negative offsets must proceed with '-'
                //  - Positive offsets must not (to spec) proceed with '+', but
                //    we'll allow it.
                //
                const [, sign, hours, minutes] = tzMatch;

                //  convert to a [+|-]hh:mm format.
                //  example: 1300 -> +13:00
                const utcOffset = `${sign || '+'}${hours}:${minutes}`;

                //  finally, update our modTimestamp
                msg.modTimestamp = msg.modTimestamp.utcOffset(utcOffset);
            }

            //  :TODO: Parser should give is this info:
            const bytesRead =
                14 + //  fixed header size
                msgData.modDateTime.length +
                1 + //  +1 = NULL
                msgData.toUserName.length +
                1 + //  +1 = NULL
                msgData.fromUserName.length +
                1 + //  +1 = NULL
                msgData.subject.length +
                1 + //  +1 = NULL
                msgData.message.length; //  includes NULL

            const nextBuf = packetBuffer.slice(bytesRead);
            if (nextBuf.length > 0) {
                const next = function (e) {
                    if (e) {
                        cb(e);
                    } else {
                        self.parsePacketMessages(header, nextBuf, iterator, cb);
                    }
                };

                iterator('message', msg, next);
            } else {
                cb(null);
            }
        });
    };

    this.sanatizeFtnProperties = function (message) {
        [
            Message.FtnPropertyNames.FtnOrigNode,
            Message.FtnPropertyNames.FtnDestNode,
            Message.FtnPropertyNames.FtnOrigNetwork,
            Message.FtnPropertyNames.FtnDestNetwork,
            Message.FtnPropertyNames.FtnAttrFlags,
            Message.FtnPropertyNames.FtnCost,
            Message.FtnPropertyNames.FtnOrigZone,
            Message.FtnPropertyNames.FtnDestZone,
            Message.FtnPropertyNames.FtnOrigPoint,
            Message.FtnPropertyNames.FtnDestPoint,
            Message.FtnPropertyNames.FtnAttribute,
            Message.FtnPropertyNames.FtnMsgOrigNode,
            Message.FtnPropertyNames.FtnMsgDestNode,
            Message.FtnPropertyNames.FtnMsgOrigNet,
            Message.FtnPropertyNames.FtnMsgDestNet,
        ].forEach(propName => {
            if (message.meta.FtnProperty[propName]) {
                message.meta.FtnProperty[propName] =
                    parseInt(message.meta.FtnProperty[propName]) || 0;
            }
        });
    };

    this.writeMessageHeader = function (message, buf) {
        //  ensure address FtnProperties are numbers
        self.sanatizeFtnProperties(message);

        const destNode =
            message.meta.FtnProperty.ftn_msg_dest_node ||
            message.meta.FtnProperty.ftn_dest_node;
        const destNet =
            message.meta.FtnProperty.ftn_msg_dest_net ||
            message.meta.FtnProperty.ftn_dest_network;

        buf.writeUInt16LE(FTN_PACKET_MESSAGE_TYPE, 0);
        buf.writeUInt16LE(message.meta.FtnProperty.ftn_orig_node, 2);
        buf.writeUInt16LE(destNode, 4);
        buf.writeUInt16LE(message.meta.FtnProperty.ftn_orig_network, 6);
        buf.writeUInt16LE(destNet, 8);
        buf.writeUInt16LE(message.meta.FtnProperty.ftn_attr_flags, 10);
        buf.writeUInt16LE(message.meta.FtnProperty.ftn_cost, 12);

        const dateTimeBuffer = Buffer.from(
            ftn.getDateTimeString(message.modTimestamp) + '\0'
        );
        dateTimeBuffer.copy(buf, 14);
    };

    this.getMessageEntryBuffer = function (message, options, cb) {
        function getAppendMeta(k, m, sepChar = ':') {
            let append = '';
            if (m) {
                let a = m;
                if (!_.isArray(a)) {
                    a = [a];
                }
                a.forEach(v => {
                    append += `${k}${sepChar} ${v}\r`;
                });
            }
            return append;
        }

        async.waterfall(
            [
                function prepareHeaderAndKludges(callback) {
                    const basicHeader = Buffer.alloc(34);
                    self.writeMessageHeader(message, basicHeader);

                    //
                    //  To, from, and subject must be NULL term'd and have max lengths as per spec.
                    //
                    const toUserNameBuf = strUtil.stringToNullTermBuffer(
                        message.toUserName,
                        { encoding: 'cp437', maxBufLen: 36 }
                    );
                    const fromUserNameBuf = strUtil.stringToNullTermBuffer(
                        message.fromUserName,
                        { encoding: 'cp437', maxBufLen: 36 }
                    );
                    const subjectBuf = strUtil.stringToNullTermBuffer(message.subject, {
                        encoding: 'cp437',
                        maxBufLen: 72,
                    });

                    //
                    //  message: unbound length, NULL term'd
                    //
                    //  We need to build in various special lines - kludges, area,
                    //  seen-by, etc.
                    //
                    let msgBody = '';

                    //
                    //  FTN-0004.001 @ http://ftsc.org/docs/fts-0004.001
                    //  AREA:CONFERENCE
                    //  Should be first line in a message
                    //
                    if (message.meta.FtnProperty.ftn_area) {
                        msgBody += `AREA:${message.meta.FtnProperty.ftn_area}\r`; //  note: no ^A (0x01)
                    }

                    //  :TODO: DRY with similar function in this file!
                    Object.keys(message.meta.FtnKludge).forEach(k => {
                        switch (k) {
                            case 'PATH':
                                break; //  skip & save for last

                            case 'Via':
                            case 'FMPT':
                            case 'TOPT':
                            case 'INTL':
                                msgBody += getAppendMeta(
                                    `\x01${k}`,
                                    message.meta.FtnKludge[k],
                                    ''
                                ); // no sepChar
                                break;

                            default:
                                msgBody += getAppendMeta(
                                    `\x01${k}`,
                                    message.meta.FtnKludge[k]
                                );
                                break;
                        }
                    });

                    return callback(
                        null,
                        basicHeader,
                        toUserNameBuf,
                        fromUserNameBuf,
                        subjectBuf,
                        msgBody
                    );
                },
                function prepareAnsiMessageBody(
                    basicHeader,
                    toUserNameBuf,
                    fromUserNameBuf,
                    subjectBuf,
                    msgBody,
                    callback
                ) {
                    if (!strUtil.isAnsi(message.message)) {
                        return callback(
                            null,
                            basicHeader,
                            toUserNameBuf,
                            fromUserNameBuf,
                            subjectBuf,
                            msgBody,
                            message.message
                        );
                    }

                    ansiPrep(
                        message.message,
                        {
                            cols: 80,
                            rows: 'auto',
                            forceLineTerm: true,
                            exportMode: true,
                        },
                        (err, preppedMsg) => {
                            return callback(
                                null,
                                basicHeader,
                                toUserNameBuf,
                                fromUserNameBuf,
                                subjectBuf,
                                msgBody,
                                preppedMsg || message.message
                            );
                        }
                    );
                },
                function addMessageBody(
                    basicHeader,
                    toUserNameBuf,
                    fromUserNameBuf,
                    subjectBuf,
                    msgBody,
                    preppedMsg,
                    callback
                ) {
                    msgBody += preppedMsg + '\r';

                    //
                    //  FTN-0004.001 @ http://ftsc.org/docs/fts-0004.001
                    //  Tear line should be near the bottom of a message
                    //
                    if (message.meta.FtnProperty.ftn_tear_line) {
                        msgBody += `${message.meta.FtnProperty.ftn_tear_line}\r`;
                    }

                    //
                    //  Origin line should be near the bottom of a message
                    //
                    if (message.meta.FtnProperty.ftn_origin) {
                        msgBody += `${message.meta.FtnProperty.ftn_origin}\r`;
                    }

                    //
                    //  FTN-0004.001 @ http://ftsc.org/docs/fts-0004.001
                    //  SEEN-BY and PATH should be the last lines of a message
                    //
                    msgBody += getAppendMeta(
                        'SEEN-BY',
                        message.meta.FtnProperty.ftn_seen_by
                    ); //  note: no ^A (0x01)
                    msgBody += getAppendMeta('\x01PATH', message.meta.FtnKludge['PATH']);

                    let msgBodyEncoded;
                    try {
                        msgBodyEncoded = iconv.encode(msgBody + '\0', options.encoding);
                    } catch (e) {
                        msgBodyEncoded = iconv.encode(msgBody + '\0', 'ascii');
                    }

                    return callback(
                        null,
                        Buffer.concat([
                            basicHeader,
                            toUserNameBuf,
                            fromUserNameBuf,
                            subjectBuf,
                            msgBodyEncoded,
                        ])
                    );
                },
            ],
            (err, msgEntryBuffer) => {
                return cb(err, msgEntryBuffer);
            }
        );
    };

    this.writeMessage = function (message, ws, options) {
        const basicHeader = Buffer.alloc(34);
        self.writeMessageHeader(message, basicHeader);

        ws.write(basicHeader);

        //  toUserName & fromUserName: up to 36 bytes in length, NULL term'd
        //  :TODO: DRY...
        let encBuf = iconv.encode(message.toUserName + '\0', 'CP437').slice(0, 36);
        encBuf[encBuf.length - 1] = '\0'; //  ensure it's null term'd
        ws.write(encBuf);

        encBuf = iconv.encode(message.fromUserName + '\0', 'CP437').slice(0, 36);
        encBuf[encBuf.length - 1] = '\0'; //  ensure it's null term'd
        ws.write(encBuf);

        //  subject: up to 72 bytes in length, NULL term'd
        encBuf = iconv.encode(message.subject + '\0', 'CP437').slice(0, 72);
        encBuf[encBuf.length - 1] = '\0'; //  ensure it's null term'd
        ws.write(encBuf);

        //
        //  message: unbound length, NULL term'd
        //
        //  We need to build in various special lines - kludges, area,
        //  seen-by, etc.
        //
        //  :TODO: Put this in it's own method
        let msgBody = '';

        function appendMeta(k, m, sepChar = ':') {
            if (m) {
                let a = m;
                if (!_.isArray(a)) {
                    a = [a];
                }
                a.forEach(v => {
                    msgBody += `${k}${sepChar} ${v}\r`;
                });
            }
        }

        //
        //  FTN-0004.001 @ http://ftsc.org/docs/fts-0004.001
        //  AREA:CONFERENCE
        //  Should be first line in a message
        //
        if (message.meta.FtnProperty.ftn_area) {
            msgBody += `AREA:${message.meta.FtnProperty.ftn_area}\r`; //  note: no ^A (0x01)
        }

        Object.keys(message.meta.FtnKludge).forEach(k => {
            switch (k) {
                case 'PATH':
                    break; //  skip & save for last

                case 'Via':
                case 'FMPT':
                case 'TOPT':
                case 'INTL':
                    appendMeta(`\x01${k}`, message.meta.FtnKludge[k], '');
                    break; //  no sepChar

                default:
                    appendMeta(`\x01${k}`, message.meta.FtnKludge[k]);
                    break;
            }
        });

        msgBody += message.message + '\r';

        //
        //  FTN-0004.001 @ http://ftsc.org/docs/fts-0004.001
        //  Tear line should be near the bottom of a message
        //
        if (message.meta.FtnProperty.ftn_tear_line) {
            msgBody += `${message.meta.FtnProperty.ftn_tear_line}\r`;
        }

        //
        //  Origin line should be near the bottom of a message
        //
        if (message.meta.FtnProperty.ftn_origin) {
            msgBody += `${message.meta.FtnProperty.ftn_origin}\r`;
        }

        //
        //  FTN-0004.001 @ http://ftsc.org/docs/fts-0004.001
        //  SEEN-BY and PATH should be the last lines of a message
        //
        appendMeta('SEEN-BY', message.meta.FtnProperty.ftn_seen_by); //  note: no ^A (0x01)

        appendMeta('\x01PATH', message.meta.FtnKludge['PATH']);

        //
        //  :TODO: We should encode based on config and add the proper kludge here!
        ws.write(iconv.encode(msgBody + '\0', options.encoding));
    };

    this.parsePacketBuffer = function (packetBuffer, iterator, cb) {
        async.waterfall(
            [
                function processHeader(callback) {
                    self.parsePacketHeader(packetBuffer, (err, header) => {
                        if (err) {
                            return callback(err);
                        }

                        const next = function (e) {
                            return callback(e, header);
                        };

                        iterator('header', header, next);
                    });
                },
                function processMessages(header, callback) {
                    self.parsePacketMessages(
                        header,
                        packetBuffer.slice(FTN_PACKET_HEADER_SIZE),
                        iterator,
                        callback
                    );
                },
            ],
            cb //  complete
        );
    };
}

//
//  Message attributes defined in FTS-0001.016
//  http://ftsc.org/docs/fts-0001.016
//
//  See also:
//  * http://www.skepticfiles.org/aj/basics03.htm
//
Packet.Attribute = {
    Private: 0x0001, //  Private message / NetMail
    Crash: 0x0002,
    Received: 0x0004,
    Sent: 0x0008,
    FileAttached: 0x0010,
    InTransit: 0x0020,
    Orphan: 0x0040,
    KillSent: 0x0080,
    Local: 0x0100, //  Message is from *this* system
    Hold: 0x0200,
    Reserved0: 0x0400,
    FileRequest: 0x0800,
    ReturnReceiptRequest: 0x1000,
    ReturnReceipt: 0x2000,
    AuditRequest: 0x4000,
    FileUpdateRequest: 0x8000,
};
Object.freeze(Packet.Attribute);

Packet.prototype.read = function (pathOrBuffer, iterator, cb) {
    var self = this;

    async.series(
        [
            function getBufferIfPath(callback) {
                if (_.isString(pathOrBuffer)) {
                    fs.readFile(pathOrBuffer, (err, data) => {
                        pathOrBuffer = data;
                        callback(err);
                    });
                } else {
                    callback(null);
                }
            },
            function parseBuffer(callback) {
                self.parsePacketBuffer(pathOrBuffer, iterator, err => {
                    callback(err);
                });
            },
        ],
        err => {
            cb(err);
        }
    );
};

Packet.prototype.writeHeader = function (ws, packetHeader) {
    return this.writePacketHeader(packetHeader, ws);
};

Packet.prototype.writeMessageEntry = function (ws, msgEntry) {
    ws.write(msgEntry);
    return msgEntry.length;
};

Packet.prototype.writeTerminator = function (ws) {
    //
    //  From FTS-0001.016:
    //  "A  pseudo-message beginning with the word 0000H signifies the end of the packet."
    //
    ws.write(Buffer.from([0x00, 0x00])); //  final extra null term
    return 2;
};

Packet.prototype.writeStream = function (ws, messages, options) {
    if (!_.isBoolean(options.terminatePacket)) {
        options.terminatePacket = true;
    }

    if (_.isObject(options.packetHeader)) {
        this.writePacketHeader(options.packetHeader, ws);
    }

    options.encoding = options.encoding || 'utf8';

    messages.forEach(msg => {
        this.writeMessage(msg, ws, options);
    });

    if (true === options.terminatePacket) {
        ws.write(Buffer.from([0])); //  final extra null term
    }
};

Packet.prototype.write = function (path, packetHeader, messages, options) {
    if (!_.isArray(messages)) {
        messages = [messages];
    }

    options = options || { encoding: 'utf8' }; //  utf-8 = 'CHRS UTF-8 4'

    this.writeStream(
        fs.createWriteStream(path), //  :TODO: specify mode/etc.
        messages,
        Object.assign({ packetHeader: packetHeader, terminatePacket: true }, options)
    );
};
