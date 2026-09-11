/* jslint node: true */
'use strict';

//  ENiGMA½
const Config = require('./config.js').get;
const StatLog = require('./stat_log.js');
const UserProps = require('./user_property.js');
const { Errors } = require('./enig_error.js');
const SysProps = require('./system_property.js');

//  deps
const fs = require('graceful-fs');
const paths = require('path');
const _ = require('lodash');
const moment = require('moment');
const iconv = require('iconv-lite');
const { mkdirs } = require('fs-extra');
const packageJson = require('../package.json');

//
//  Resources
//  * https://github.com/NuSkooler/ansi-bbs/tree/master/docs/dropfile_formats
//  * http://goldfndr.home.mindspring.com/dropfile/
//  * https://en.wikipedia.org/wiki/Talk%3ADropfile
//  * http://thoughtproject.com/libraries/bbs/Sysop/Doors/DropFiles/index.htm
//  * http://thebbs.org/bbsfaq/ch06.02.htm
//  * http://lord.lordlegacy.com/dosemu/
//

//
//  IANA preferred MIME names for the character sets a session can be set to.
//  Keys are spelled without punctuation and looked up that way, because the
//  same encoding reaches us under several spellings: iconv-lite's own, a
//  sysop's |forceOutputEncoding|, and whatever a menu's setClientEncoding
//  passes (e.g. 'utf-8'). BBSDEV.DRP line 12 names the character set of the
//  terminal data, not of the drop file, which is always UTF-8 -- and the
//  terminal data is what Door decodes with the door's own |encoding|, so that
//  is the value written there.
//
const BbsDevEncodingNames = {
    ascii: 'US-ASCII',
    usascii: 'US-ASCII',
    cp437: 'IBM437',
    ibm437: 'IBM437',
    cp850: 'IBM850',
    ibm850: 'IBM850',
    cp852: 'IBM852',
    ibm852: 'IBM852',
    cp865: 'IBM865',
    ibm865: 'IBM865',
    cp866: 'IBM866',
    ibm866: 'IBM866',
    cp1250: 'windows-1250',
    windows1250: 'windows-1250',
    cp1251: 'windows-1251',
    windows1251: 'windows-1251',
    cp1252: 'windows-1252',
    windows1252: 'windows-1252',
    latin1: 'ISO-8859-1',
    iso88591: 'ISO-8859-1',
    iso88592: 'ISO-8859-2',
    iso885915: 'ISO-8859-15',
    koi8r: 'KOI8-R',
    utf8: 'UTF-8',
};

//
//  The allowlist is keyed on a punctuation-free spelling, but iconv accepts
//  more of them than that covers and |forceOutputEncoding| takes whatever the
//  sysop wrote -- a bare '437', a 'cs' prefixed registry alias, 'win1252'.
//  Those reach the same encoding, so they are folded onto the same key rather
//  than refusing to launch a door over a spelling.
//
const bbsDevEncodingKey = encoding => {
    const key = String(encoding || '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .replace(/^cs/, '')
        .replace(/^win(?=[0-9])/, 'windows');

    if (/^[0-9]{3}$/.test(key)) {
        return `cp${key}`;
    }
    if (/^12[0-9]{2}$/.test(key)) {
        return `windows${key}`;
    }
    return key;
};

const bbsDevEncodingName = encoding => BbsDevEncodingNames[bbsDevEncodingKey(encoding)];

//
//  BBSDEV.DRP has no quoting or escaping, so a field cannot carry a line
//  ending, a control character, or outer whitespace. Names reach us from the
//  user and from the sysop's config, so they are cleaned rather than trusted.
//
/* eslint-disable-next-line no-control-regex */
const RE_BBSDEV_UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f]/g;

const bbsDevField = (value, fallback = '') => {
    const clean = _.isString(value)
        ? value.replace(RE_BBSDEV_UNPRINTABLE, '').trim()
        : '';
    return clean || fallback;
};

module.exports = class DropFile {
    constructor(
        client,
        {
            fileType = 'DORINFO',
            baseDir = Config().paths.dropFiles,
            commType = 'local',
            commParams = '',
            encoding = 'cp437',
        } = {}
    ) {
        this.client = client;
        this.fileType = fileType.toUpperCase();
        this.baseDir = baseDir;
        //  What the *door* is handed, which is not ENiGMA's |io| type: Door
        //  accepts only stdio and socket. BBSDEV.DRP names more mechanisms
        //  than the legacy formats can, and gives some of them a parameter.
        const comm = DropFile.normalizeComm(this.fileType, commType, commParams);
        this.commType = comm.commType;
        this.commParams = comm.commParams;
        //  set when the channel cannot be named; createFile refuses rather
        //  than writing a line 2 the door will act on
        this.commError = comm.commError;
        //
        //  Line 12 states the character set of the door's terminal data, and
        //  Door decodes that data with the door's own |encoding| rather than
        //  the caller's terminal encoding (door.js:58). Sourcing the field
        //  from anything else makes the file describe bytes nobody produces.
        //
        this.doorEncoding = encoding || 'cp437';
    }

    static get ValidCommTypes() {
        return Object.keys(DropFile.CommTypes.DORINFO);
    }

    //
    //  What each format can say about the channel the door is handed, and --
    //  for BBSDEV.DRP alone -- what line 3 must carry with it. Parameters are
    //  validated against that format's ABNF; 255 is the FOSSIL port FSC-0015
    //  reserves.
    //
    static get CommTypes() {
        const uint = /^(?:0|[1-9][0-9]*)$/;
        const none = params => '' === params;
        return {
            DORINFO: { local: none, serial: none, socket: none },
            BBSDEV: {
                local: none,
                stdio: none,
                socket: params => uint.test(params),
                serial: params => uint.test(params),
                winserial: params => uint.test(params),
                uart: params => /^[0-9A-F]{4},(?:[0-9]|1[0-5])$/.test(params),
                fossil: params =>
                    /^[0-9]{1,3}$/.test(params) && parseInt(params, 10) < 255,
            },
        };
    }

    static commTypesFor(fileType) {
        return 'BBSDEV' === String(fileType).toUpperCase()
            ? DropFile.CommTypes.BBSDEV
            : DropFile.CommTypes.DORINFO;
    }

    static validCommTypes(fileType) {
        return Object.keys(DropFile.commTypesFor(fileType));
    }

    //  a value from HJSON arrives as a number when it is written as one
    static commParamsText(commParams) {
        if (_.isFinite(commParams)) {
            return commParams.toString();
        }
        return _.isString(commParams) ? commParams.trim() : '';
    }

    static isValidCommParams(commType, commParams, fileType = 'BBSDEV') {
        const valid = DropFile.commTypesFor(fileType)[commType];
        return valid ? valid(DropFile.commParamsText(commParams)) : false;
    }

    //
    //  The legacy formats coerce anything unrecognized to 'local' -- the one
    //  mode that asks nothing of us. BBSDEV.DRP gets no such coercion: its
    //  'local' claims the door uses its current local console, so a channel
    //  we cannot name sets |commError| and the file is refused instead. See
    //  website/src/content/docs/doors/scripts-and-binaries.md, BBSDEV.DRP.
    //
    static normalizeComm(fileType, commType, commParams) {
        commType = _.isString(commType) ? commType.toLowerCase() : '';
        const known = DropFile.validCommTypes(fileType).includes(commType);

        if ('BBSDEV' !== String(fileType).toUpperCase()) {
            return { commType: known ? commType : 'local', commParams: '' };
        }

        commParams = DropFile.commParamsText(commParams);

        if (!known) {
            return {
                commType,
                commParams,
                commError: `"${commType}" is not a BBSDEV.DRP communications type`,
            };
        }

        if (!DropFile.isValidCommParams(commType, commParams)) {
            return {
                commType,
                commParams,
                commError: `a "${commType}" door needs a "commParams" naming its channel, and "${commParams}" is not one`,
            };
        }

        return { commType, commParams };
    }

    static dropFileDirectory(baseDir, client) {
        return paths.join(baseDir, 'node' + client.node);
    }

    get fullPath() {
        return paths.join(
            DropFile.dropFileDirectory(this.baseDir, this.client),
            this.fileName
        );
    }

    get fileName() {
        return {
            DOOR: 'DOOR.SYS', //  GAP BBS, many others
            DOOR32: 'door32.sys', //  Mystic, EleBBS, Syncronet, Maximus, Telegard, AdeptXBBS (lowercase name as per spec)
            CALLINFO: 'CALLINFO.BBS', //  Citadel?
            DORINFO: this.getDoorInfoFileName(), //  RBBS, RemoteAccess, QBBS, ...
            CHAIN: 'CHAIN.TXT', //  WWIV
            CURRUSER: 'CURRUSER.BBS', //  RyBBS
            SFDOORS: 'SFDOORS.DAT', //  Spitfire
            PCBOARD: 'PCBOARD.SYS', //  PCBoard
            TRIBBS: 'TRIBBS.SYS', //  TriBBS
            USERINFO: 'USERINFO.DAT', //  Wildcat! 3.0+
            JUMPER: 'JUMPER.DAT', //  2AM BBS
            SXDOOR: 'SXDOOR.' + _.pad(this.client.node.toString(), 3, '0'), //  System/X, dESiRE
            INFO: 'INFO.BBS', //  Phoenix BBS
            BBSDEV: 'BBSDEV.DRP', //  https://github.com/RealDeuce/bbsdev.drp
        }[this.fileType];
    }

    //  DOOR.SYS line 1: "Comm Port - COM0: = LOCAL MODE"
    get doorSysCommPort() {
        return 'local' === this.commType ? 'COM0:' : 'COM1:';
    }

    //  DORINFO line 4: the serial port, or 0 when the caller is on the console
    get dorInfoCommPort() {
        return 'local' === this.commType ? '0' : 'COM1';
    }

    isSupported() {
        return this.getHandler() ? true : false;
    }

    getHandler() {
        return {
            DOOR: this.getDoorSysBuffer,
            DOOR32: this.getDoor32Buffer,
            DORINFO: this.getDoorInfoDefBuffer,
            BBSDEV: this.getBbsDevBuffer,
        }[this.fileType];
    }

    getContents() {
        const handler = this.getHandler().bind(this);
        return handler();
    }

    getDoorInfoFileName() {
        let x;
        const node = this.client.node;
        if (10 === node) {
            x = 0;
        } else if (node < 10) {
            x = node;
        } else {
            x = String.fromCharCode('a'.charCodeAt(0) + (node - 11));
        }
        return 'DORINFO' + x + '.DEF';
    }

    getDoorSysBuffer() {
        const prop = this.client.user.properties;
        const now = moment();
        const secLevel = this.client.user.getLegacySecurityLevel().toString();
        const fullName = this.client.user.getSanitizedName('real');
        const bd = moment(prop[UserProps.Birthdate]).format('MM/DD/YY');

        const upK = Math.floor((parseInt(prop[UserProps.FileUlTotalBytes]) || 0) / 1024);
        const downK = Math.floor(
            (parseInt(prop[UserProps.FileDlTotalBytes]) || 0) / 1024
        );

        const timeOfCall = moment(prop[UserProps.LastLoginTs] || moment()).format(
            'hh:mm'
        );

        //  :TODO: fix time remaining
        //  :TODO: fix default protocol -- user prop: transfer_protocol
        return iconv.encode(
            [
                this.doorSysCommPort, //  "Comm Port - COM0: = LOCAL MODE"
                '57600', //  "Baud Rate - 300 to 38400" (Note: set as 57600 instead!)
                '8', //  "Parity - 7 or 8"
                this.client.node.toString(), //  "Node Number - 1 to 99"
                '57600', //  "DTE Rate. Actual BPS rate to use. (kg)"
                'Y', //  "Screen Display - Y=On  N=Off             (Default to Y)"
                'Y', //  "Printer Toggle - Y=On  N=Off             (Default to Y)"
                'Y', //  "Page Bell      - Y=On  N=Off             (Default to Y)"
                'Y', //  "Caller Alarm   - Y=On  N=Off             (Default to Y)"
                fullName, //  "User Full Name"
                prop[UserProps.Location] || 'Anywhere', //  "Calling From"
                '123-456-7890', //  "Home Phone"
                '123-456-7890', //  "Work/Data Phone"
                'NOPE', //  "Password" (Note: this is never given out or even stored plaintext)
                secLevel, //  "Security Level"
                prop[UserProps.LoginCount].toString(), //  "Total Times On"
                now.format('MM/DD/YY'), //  "Last Date Called"
                '15360', //  "Seconds Remaining THIS call (for those that particular)"
                '256', //  "Minutes Remaining THIS call"
                'GR', //  "Graphics Mode - GR=Graph, NG=Non-Graph, 7E=7,E Caller"
                this.client.term.termHeight.toString(), //  "Page Length"
                'N', //  "User Mode - Y = Expert, N = Novice"
                '1,2,3,4,5,6,7', //  "Conferences/Forums Registered In  (ABCDEFG)"
                '1', //  "Conference Exited To DOOR From    (G)"
                '01/01/99', //  "User Expiration Date              (mm/dd/yy)"
                this.client.user.userId.toString(), //  "User File's Record Number"
                'Z', //  "Default Protocol - X, C, Y, G, I, N, Etc."
                //  :TODO: fix up, down, etc. form user properties
                '0', //  "Total Uploads"
                '0', //  "Total Downloads"
                '0', //  "Daily Download "K" Total"
                '999999', //  "Daily Download Max. "K" Limit"
                bd, //  "Caller's Birthdate"
                'X:\\MAIN\\', //  "Path to the MAIN directory (where User File is)"
                'X:\\GEN\\', //  "Path to the GEN directory"
                StatLog.getSystemStat(SysProps.SysOpUsername), //  "Sysop's Name (name BBS refers to Sysop as)"
                this.client.user.getSanitizedName(), //  "Alias name"
                '00:05', //  "Event time                        (hh:mm)" (note: wat?)
                'Y', //  "If its an error correcting connection (Y/N)"
                'Y', //  "ANSI supported & caller using NG mode (Y/N)"
                'Y', //  "Use Record Locking                    (Y/N)"
                '7', //  "BBS Default Color (Standard IBM color code, ie, 1-15)"
                //  :TODO: fix minutes here also:
                '256', //  "Time Credits In Minutes (positive/negative)"
                '07/07/90', //  "Last New Files Scan Date          (mm/dd/yy)"
                timeOfCall, //  "Time of This Call"
                timeOfCall, //  "Time of Last Call                 (hh:mm)"
                '9999', //  "Maximum daily files available"
                '0', //  "Files d/led so far today"
                upK.toString(), //  "Total "K" Bytes Uploaded"
                downK.toString(), //  "Total "K" Bytes Downloaded"
                prop[UserProps.UserComment] || 'None', //  "User Comment"
                '0', //  "Total Doors Opened"
                '0', //  "Total Messages Left"
            ].join('\r\n') + '\r\n',
            'cp437'
        );
    }

    getDoor32Buffer() {
        //
        //  Resources:
        //  * http://wiki.bbses.info/index.php/DOOR32.SYS
        //  * https://github.com/NuSkooler/ansi-bbs/blob/master/docs/dropfile_formats/door32_sys.txt
        //
        const commType = {
            local: 0,
            serial: 1,
            socket: 2, //  the spec's name for a shared socket is "telnet"
        }[this.commType];

        //
        //  Line 2 is the comm or socket handle. ENiGMA shares a socket
        //  server, not a descriptor, so 'socket' reports -1 and leaves the
        //  pair to bivrost!, which rewrites both lines with the real fd
        //  before the door ever reads them. 'serial' reports 0, which door
        //  libraries take as the first port -- COM1, what our emulators
        //  bridge the user to.
        //
        const commHandle = 'socket' === this.commType ? '-1' : '0';

        return iconv.encode(
            [
                commType.toString(),
                commHandle,
                '115200',
                Config().general.boardName,
                this.client.user.userId.toString(),
                this.client.user.getSanitizedName('real'),
                this.client.user.getSanitizedName(),
                this.client.user.getLegacySecurityLevel().toString(),
                '546', //  :TODO: Minutes left!
                '1', //  ANSI
                this.client.node.toString(),
            ].join('\r\n') + '\r\n',
            'cp437'
        );
    }

    getDoorInfoDefBuffer() {
        //  :TODO: fix time remaining

        //
        //  Resources:
        //  * http://goldfndr.home.mindspring.com/dropfile/dorinfo.htm
        //
        //  Note that usernames are just used for first/last names here
        //
        const opUserName = /[^\s]*/.exec(
            StatLog.getSystemStat(SysProps.SysOpUsername)
        )[0];
        const userName = /[^\s]*/.exec(this.client.user.getSanitizedName())[0];
        const secLevel = this.client.user.getLegacySecurityLevel().toString();
        const location = this.client.user.properties[UserProps.Location];

        return iconv.encode(
            [
                Config().general.boardName, //  "The name of the system."
                opUserName, //  "The sysop's name up to the first space."
                opUserName, //  "The sysop's name following the first space."
                this.dorInfoCommPort, //  "The serial port the modem is connected to, or 0 if logged in on console."
                '57600', //  "The current port (DTE) rate."
                '0', //  "The number "0""
                userName, //  "The current user's name, up to the first space."
                userName, //  "The current user's name, following the first space."
                location || '', //  "Where the user lives, or a blank line if unknown."
                '2', //  0=TTY, 1=IBM high-bit chars, 2=ANSI color (RBBS standard; TW2002 requires 2)
                secLevel, //  "The number 5 for problem users, 30 for regular users, 80 for Aides, and 100 for Sysops."
                '546', //  "The number of minutes left in the current user's account, limited to 546 to keep from overflowing other software."
                '-1', //  "The number "-1" if using an external serial driver or "0" if using internal serial routines."
            ].join('\r\n') + '\r\n',
            'cp437'
        );
    }

    //
    //  BBSDEV.DRP: 19 CRLF-terminated lines of UTF-8 with no byte-order mark.
    //  See https://github.com/RealDeuce/bbsdev.drp for the specification,
    //  its ABNF grammar, and an example of each communications mode.
    //
    //  The door finds this file through the BBSDEV_DRP environment variable
    //  rather than an argument; abracadabra sets it.
    //
    getBbsDevBuffer() {
        const user = this.client.user;
        const term = this.client.term;

        return Buffer.from(
            [
                '1.0', //  format version
                this.commType,
                this.commParams, //  empty for 'local' and 'stdio'
                bbsDevField(user.username, `user${user.userId}`),
                user.userId.toString(), //  opaque, stable, ours alone
                (term.termWidth || 80).toString(),
                (term.termHeight || 25).toString(),
                'Y', //  ANSI: every ENiGMA½ session is drawn with it
                'N', //  RIP: not supported
                term.ctermVersion || '', //  empty unless the caller answered DA as CTerm
                '', //  time of logoff: ENiGMA½ has no per-call time limit
                bbsDevEncodingName(this.doorEncoding),
                bbsDevField(Config().general.language, 'en-US'),
                `ENiGMA½ BBS ${packageJson.version}`,
                bbsDevField(Config().general.boardName, 'ENiGMA½ BBS'),
                bbsDevField(StatLog.getSystemStat(SysProps.SysOpUsername), 'sysop'),
                this.bbsDevAccessLevel,
                this.client.node.toString(),
                'N', //  no separate operator-side display to ask for
            ].join('\r\n') + '\r\n',
            'utf8'
        );
    }

    //
    //  The format's two portable role tokens where they apply, and the same
    //  ordinal the legacy drop files carry otherwise. A door is told a role,
    //  not given one: this file authenticates nothing.
    //
    get bbsDevAccessLevel() {
        const user = this.client.user;
        if (user.isSysOp()) {
            return 'sysop';
        }
        if (user.isGroupMember('sysops')) {
            return 'cosysop';
        }
        return user.getLegacySecurityLevel().toString();
    }

    //
    //  What would make us write a file no consumer may accept. The spec's own
    //  rule is that a door rejects a field it cannot use rather than guessing
    //  around it, so a producer that cannot fill one has nothing honest to
    //  write and says so here instead.
    //
    bbsDevError() {
        if (this.commError) {
            return this.commError;
        }
        if (!bbsDevEncodingName(this.doorEncoding)) {
            return `no IANA character set name is known for the door encoding "${this.doorEncoding}"`;
        }
    }

    createFile(cb) {
        const bbsDevError = 'BBSDEV' === this.fileType ? this.bbsDevError() : null;
        if (bbsDevError) {
            return cb(Errors.MissingConfig(`Cannot write BBSDEV.DRP: ${bbsDevError}`));
        }

        mkdirs(paths.dirname(this.fullPath), err => {
            if (err) {
                return cb(err);
            }
            return fs.writeFile(this.fullPath, this.getContents(), cb);
        });
    }
};
