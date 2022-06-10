/* jslint node: true */
'use strict';

const Config = require('./config.js').get;
const Address = require('./ftn_address.js');
const FNV1a = require('./fnv1a.js');
const getCleanEnigmaVersion = require('./misc_util.js').getCleanEnigmaVersion;

const _ = require('lodash');
const iconv = require('iconv-lite');
const moment = require('moment');
const os = require('os');

const packageJson = require('../package.json');

//  :TODO: Remove "Ftn" from most of these -- it's implied in the module
exports.stringToNullPaddedBuffer = stringToNullPaddedBuffer;
exports.getMessageSerialNumber = getMessageSerialNumber;
exports.getDateFromFtnDateTime = getDateFromFtnDateTime;
exports.getDateTimeString = getDateTimeString;

exports.getMessageIdentifier = getMessageIdentifier;
exports.getProductIdentifier = getProductIdentifier;
exports.getUTCTimeZoneOffset = getUTCTimeZoneOffset;
exports.getOrigin = getOrigin;
exports.getTearLine = getTearLine;
exports.getVia = getVia;
exports.getIntl = getIntl;
exports.getAbbreviatedNetNodeList = getAbbreviatedNetNodeList;
exports.parseAbbreviatedNetNodeList = parseAbbreviatedNetNodeList;
exports.getUpdatedSeenByEntries = getUpdatedSeenByEntries;
exports.getUpdatedPathEntries = getUpdatedPathEntries;

exports.getCharacterSetIdentifierByEncoding = getCharacterSetIdentifierByEncoding;
exports.getEncodingFromCharacterSetIdentifier = getEncodingFromCharacterSetIdentifier;

exports.getQuotePrefix = getQuotePrefix;

//
//  Namespace for RFC-4122 name based UUIDs generated from
//  FTN kludges MSGID + AREA
//
//const ENIGMA_FTN_MSGID_NAMESPACE  = uuid.parse('a5c7ae11-420c-4469-a116-0e9a6d8d2654');

//  See list here: https://github.com/Mithgol/node-fidonet-jam

function stringToNullPaddedBuffer(s, bufLen) {
    let buffer = Buffer.alloc(bufLen);
    let enc = iconv.encode(s, 'CP437').slice(0, bufLen);
    for (let i = 0; i < enc.length; ++i) {
        buffer[i] = enc[i];
    }
    return buffer;
}

//
//  Convert a FTN style DateTime string to a Date object
//
//  :TODO: Name the next couple methods better - for FTN *packets* e.g. parsePacketDateTime()
function getDateFromFtnDateTime(dateTime) {
    //
    //  Examples seen in the wild (Working):
    //      "12 Sep 88 18:17:59"
    //      "Tue 01 Jan 80 00:00"
    //      "27 Feb 15  00:00:03"
    //
    //  :TODO: Use moment.js here
    return moment(Date.parse(dateTime)); //  Date.parse() allows funky formats
}

function getDateTimeString(m) {
    //
    //  From http://ftsc.org/docs/fts-0001.016:
    //  DateTime   = (* a character string 20 characters long *)
    //      (* 01 Jan 86  02:34:56 *)
    //      DayOfMonth " " Month " " Year " "
    //      " " HH ":" MM ":" SS
    //      Null
    //
    //  DayOfMonth = "01" | "02" | "03" | ... | "31"   (* Fido 0 fills *)
    //  Month      = "Jan" | "Feb" | "Mar" | "Apr" | "May" | "Jun" |
    //             "Jul" | "Aug" | "Sep" | "Oct" | "Nov" | "Dec"
    //  Year       = "01" | "02" | .. | "85" | "86" | ... | "99" | "00"
    //  HH         = "00" | .. | "23"
    //  MM         = "00" | .. | "59"
    //  SS         = "00" | .. | "59"
    //
    if (!moment.isMoment(m)) {
        m = moment(m);
    }

    return m.format('DD MMM YY  HH:mm:ss');
}

function getMessageSerialNumber(messageId) {
    const msSinceEnigmaEpoc = Date.now() - Date.UTC(2016, 1, 1);
    const hash = Math.abs(new FNV1a(msSinceEnigmaEpoc + messageId).value).toString(16);
    return `00000000${hash}`.substr(-8);
}

//
//  Return a FTS-0009.001 compliant MSGID value given a message
//  See http://ftsc.org/docs/fts-0009.001
//
//  "A MSGID line consists of the string "^AMSGID:" (where ^A is a
//  control-A (hex 01) and the double-quotes are not part of the
//  string),  followed by a space,  the address of the originating
//  system,  and a serial number unique to that message on the
//  originating system,  i.e.:
//
//      ^AMSGID: origaddr serialno
//
//  The originating address should be specified in a form that
//  constitutes a valid return address for the originating network.
//  If the originating address is enclosed in double-quotes,  the
//  entire string between the beginning and ending double-quotes is
//  considered to be the orginating address.  A double-quote character
//  within a quoted address is represented by by two consecutive
//  double-quote characters.  The serial number may be any eight
//  character hexadecimal number,  as long as it is unique - no two
//  messages from a given system may have the same serial number
//  within a three years.  The manner in which this serial number is
//  generated is left to the implementor."
//
//
//  Examples & Implementations
//
//  Synchronet: <msgNum>.<conf+area>@<ftnAddr> <serial>
//      2606.agora-agn_tst@46:1/142 19609217
//
//  Mystic: <ftnAddress> <serial>
//      46:3/102 46686263
//
//  ENiGMA½: <messageId>.<areaTag>@<5dFtnAddress> <serial>
//
//  0.0.8-alpha:
//  Made compliant with FTN spec *when exporting NetMail* due to
//  Mystic rejecting messages with the true-unique version.
//  Strangely, Synchronet uses the unique format and Mystic does
//  OK with it. Will need to research further. Note also that
//  g00r00 was kind enough to fix Mystic to allow for the Sync/Enig
//  format, but that will only help when using newer Mystic versions.
//
function getMessageIdentifier(message, address, isNetMail = false) {
    const addrStr = new Address(address).toString('5D');
    return isNetMail
        ? `${addrStr} ${getMessageSerialNumber(message.messageId)}`
        : `${
              message.messageId
          }.${message.areaTag.toLowerCase()}@${addrStr} ${getMessageSerialNumber(
              message.messageId
          )}`;
}

//
//  Return a FSC-0046.005 Product Identifier or "PID"
//  http://ftsc.org/docs/fsc-0046.005
//
//  Note that we use a variant on the spec for <serial>
//  in which (<os>; <arch>; <nodeVer>) is used instead
//
function getProductIdentifier() {
    const version = getCleanEnigmaVersion();
    const nodeVer = process.version.substr(1); //  remove 'v' prefix

    return `ENiGMA1/2 ${version} (${os.platform()}; ${os.arch()}; ${nodeVer})`;
}

//
//  Return a FRL-1004 style time zone offset for a
//  'TZUTC' kludge line
//
//  http://ftsc.org/docs/frl-1004.002
//
function getUTCTimeZoneOffset() {
    return moment().format('ZZ').replace(/\+/, '');
}

//
//  Get a FSC-0032 style quote prefix
//  http://ftsc.org/docs/fsc-0032.001
//
function getQuotePrefix(name) {
    let initials;

    const parts = name.split(' ');
    if (parts.length > 1) {
        //  First & Last initials - (Bryan Ashby -> BA)
        initials = `${parts[0].slice(0, 1)}${parts[parts.length - 1].slice(
            0,
            1
        )}`.toUpperCase();
    } else {
        //  Just use the first two - (NuSkooler -> Nu)
        initials = _.capitalize(name.slice(0, 2));
    }

    return ` ${initials}> `;
}

//
//  Return a FTS-0004 Origin line
//  http://ftsc.org/docs/fts-0004.001
//
function getOrigin(address) {
    const config = Config();
    const origin = _.has(config, 'messageNetworks.originLine')
        ? config.messageNetworks.originLine
        : config.general.boardName;

    const addrStr = new Address(address).toString('5D');
    return ` * Origin: ${origin} (${addrStr})`;
}

function getTearLine() {
    const nodeVer = process.version.substr(1); //  remove 'v' prefix
    return `--- ENiGMA 1/2 v${
        packageJson.version
    } (${os.platform()}; ${os.arch()}; ${nodeVer})`;
}

//
//  Return a FRL-1005.001 "Via" line
//  http://ftsc.org/docs/frl-1005.001
//
function getVia(address) {
    /*
        FRL-1005.001 states teh following format:

        ^AVia: <FTN Address> @YYYYMMDD.HHMMSS[.Precise][.Time Zone]
        <Program Name> <Version> [Serial Number]<CR>
    */
    const addrStr = new Address(address).toString('5D');
    const dateTime = moment().utc().format('YYYYMMDD.HHmmSS.SSSS.UTC');
    const version = getCleanEnigmaVersion();

    return `${addrStr} @${dateTime} ENiGMA1/2 ${version}`;
}

//
//  Creates a INTL kludge value as per FTS-4001
//  http://retro.fidoweb.ru/docs/index=ftsc&doc=FTS-4001&enc=mac
//
function getIntl(toAddress, fromAddress) {
    //
    //  INTL differs from 'standard' kludges in that there is no ':' after "INTL"
    //
    //  "<SOH>"INTL "<destination address>" "<origin address><CR>"
    //  "...These addresses shall be given on the form <zone>:<net>/<node>"
    //
    return `${toAddress.toString('3D')} ${fromAddress.toString('3D')}`;
}

function getAbbreviatedNetNodeList(netNodes) {
    let abbrList = '';
    let currNet;
    netNodes.forEach(netNode => {
        if (_.isString(netNode)) {
            netNode = Address.fromString(netNode);
        }
        if (currNet !== netNode.net) {
            abbrList += `${netNode.net}/`;
            currNet = netNode.net;
        }
        abbrList += `${netNode.node} `;
    });

    return abbrList.trim(); //  remove trailing space
}

//
//  Parse an abbreviated net/node list commonly used for SEEN-BY and PATH
//
function parseAbbreviatedNetNodeList(netNodes) {
    const re = /([0-9]+)\/([0-9]+)\s?|([0-9]+)\s?/g;
    let net;
    let m;
    let results = [];
    while (null !== (m = re.exec(netNodes))) {
        if (m[1] && m[2]) {
            net = parseInt(m[1]);
            results.push(new Address({ net: net, node: parseInt(m[2]) }));
        } else if (net) {
            results.push(new Address({ net: net, node: parseInt(m[3]) }));
        }
    }

    return results;
}

//
//  Return a FTS-0004.001 SEEN-BY entry(s) that include
//  all pre-existing SEEN-BY entries with the addition
//  of |additions|.
//
//  See http://ftsc.org/docs/fts-0004.001
//  and notes at http://ftsc.org/docs/fsc-0043.002.
//
//  For a great write up, see http://www.skepticfiles.org/aj/basics03.htm
//
//  This method returns an sorted array of values, but
//  not the "SEEN-BY" prefix itself
//
function getUpdatedSeenByEntries(existingEntries, additions) {
    /*
        From FTS-0004:

        "There can  be many  seen-by lines  at the  end of Conference
        Mail messages,  and they  are the real "meat" of the control
        information. They  are used  to  determine  the  systems  to
        receive the exported messages. The format of the line is:

                   SEEN-BY: 132/101 113 136/601 1014/1

        The net/node  numbers correspond  to the net/node numbers of
        the systems having already received the message. In this way
        a message  is never  sent to a system twice. In a conference
        with many  participants the  number of  seen-by lines can be
        very large.   This line is added if it is not already a part
        of the  message, or added to if it already exists, each time
        a message  is exported  to other systems. This is a REQUIRED
        field, and  Conference Mail  will not  function correctly if
        this field  is not put in place by other Echomail compatible
        programs."
    */
    existingEntries = existingEntries || [];
    if (!_.isArray(existingEntries)) {
        existingEntries = [existingEntries];
    }

    if (!_.isString(additions)) {
        additions = parseAbbreviatedNetNodeList(getAbbreviatedNetNodeList(additions));
    }

    additions = additions.sort(Address.getComparator());

    //
    //  For now, we'll just append a new SEEN-BY entry
    //
    //  :TODO: we should at least try and update what is already there in a smart way
    existingEntries.push(getAbbreviatedNetNodeList(additions));
    return existingEntries;
}

function getUpdatedPathEntries(existingEntries, localAddress) {
    //  :TODO: append to PATH in a smart way! We shoudl try to fit at least the last existing line

    existingEntries = existingEntries || [];
    if (!_.isArray(existingEntries)) {
        existingEntries = [existingEntries];
    }

    existingEntries.push(
        getAbbreviatedNetNodeList(parseAbbreviatedNetNodeList(localAddress))
    );

    return existingEntries;
}

//
//  Return FTS-5000.001 "CHRS" value
//  http://ftsc.org/docs/fts-5003.001
//
const ENCODING_TO_FTS_5003_001_CHARS = {
    //  level 1 - generally should not be used
    ascii: ['ASCII', 1],
    'us-ascii': ['ASCII', 1],

    //  level 2 - 8 bit, ASCII based
    cp437: ['CP437', 2],
    cp850: ['CP850', 2],

    //  level 3 - reserved

    //  level 4
    utf8: ['UTF-8', 4],
    'utf-8': ['UTF-8', 4],
};

function getCharacterSetIdentifierByEncoding(encodingName) {
    const value = ENCODING_TO_FTS_5003_001_CHARS[encodingName.toLowerCase()];
    return value ? `${value[0]} ${value[1]}` : encodingName.toUpperCase();
}

const CHRSToEncodingTable = {
    Level1: {
        ASCII: 'ascii', // ISO-646-1
        DUTCH: 'ascii', // ISO-646
        FINNISH: 'ascii', // ISO-646-10
        FRENCH: 'ascii', // ISO-646
        CANADIAN: 'ascii', // ISO-646
        GERMAN: 'ascii', // ISO-646
        ITALIAN: 'ascii', // ISO-646
        NORWEIG: 'ascii', // ISO-646
        PORTU: 'ascii', // ISO-646
        SPANISH: 'iso-656',
        SWEDISH: 'ascii', // ISO-646-10
        SWISS: 'ascii', // ISO-646
        UK: 'ascii', // ISO-646
        'ISO-10': 'ascii', // ISO-646-10
    },
    Level2: {
        CP437: 'cp437',
        CP850: 'cp850',
        CP852: 'cp852',
        CP866: 'cp866',
        CP848: 'cp848',
        CP1250: 'cp1250',
        CP1251: 'cp1251',
        CP1252: 'cp1252',
        CP10000: 'macroman',
        'LATIN-1': 'iso-8859-1',
        'LATIN-2': 'iso-8859-2',
        'LATIN-5': 'iso-8859-9',
        'LATIN-9': 'iso-8859-15',
    },

    Level4: {
        'UTF-8': 'utf8',
    },

    DeprecatedMisc: {
        IBMPC: 'cp1250', //  :TODO: validate
        '+7_FIDO': 'cp866',
        '+7': 'cp866',
        MAC: 'macroman', //  :TODO: validate
    },
};

//  Given 1:N CHRS kludge IDs, try to pick the best encoding we can
//  http://ftsc.org/docs/fts-5003.001
//  http://www.unicode.org/L2/L1999/99325-N.htm
function getEncodingFromCharacterSetIdentifier(chrs) {
    if (!Array.isArray(chrs)) {
        chrs = [chrs];
    }

    const encLevel = (ident, table, level) => {
        const enc = table[ident];
        if (enc) {
            return { enc, level };
        }
    };

    const mapping = [];
    chrs.forEach(c => {
        const ident = c.split(' ')[0].toUpperCase();
        const mapped =
            encLevel(ident, CHRSToEncodingTable.Level1, 2) ||
            encLevel(ident, CHRSToEncodingTable.Level2, 1) ||
            encLevel(ident, CHRSToEncodingTable.Level4, 0) ||
            encLevel(ident, CHRSToEncodingTable.DeprecatedMisc, 3);

        if (mapped) {
            mapping.push(mapped);
        }
    });

    mapping.sort((l, r) => {
        return l.level - r.level;
    });

    return mapping[0] && mapping[0].enc;
}
