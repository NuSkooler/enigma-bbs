/* jslint node: true */
'use strict';

//  ENiGMA½
const Config = require('./config.js').get;
const StatLog = require('./stat_log.js');
const UserProps = require('./user_property.js');
const SysProps = require('./system_property.js');
const paths = require('path');
const Log = require('./logger.js').log;
const getPredefinedMCIFormatObject =
    require('./predefined_mci').getPredefinedMCIFormatObject;
const stringFormat = require('./string_format');

//  deps
const fs = require('graceful-fs');
const _ = require('lodash');
const moment = require('moment');
const { mkdirs } = require('fs-extra');

const parseFullName = require('parse-full-name').parseFullName;

//
//  Resources
//  * https://github.com/NuSkooler/ansi-bbs/tree/master/docs/dropfile_formats
//  * http://goldfndr.home.mindspring.com/dropfile/
//  * https://en.wikipedia.org/wiki/Talk%3ADropfile
//  * http://thoughtproject.com/libraries/bbs/Sysop/Doors/DropFiles/index.htm
//  * http://thebbs.org/bbsfaq/ch06.02.htm
//  * http://lord.lordlegacy.com/dosemu/
//
module.exports = class DropFile {
    constructor(
        client,
        { fileType = 'DORINFO', baseDir = Config().paths.dropFiles } = {}
    ) {
        this.client = client;
        this.fileType = fileType.toUpperCase();
        this.baseDir = baseDir;


        this.dropFileFormatDirectory = paths.join(
            __dirname,
            '..',
            'dropfile_formats'
        );
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
            SOLARREALMS: 'DOORFILE.SR',
            XTRN: 'XTRN.DAT',
        }[this.fileType];
    }

    isSupported() {
        return this.getHandler() ? true : false;
    }

    getHandler() {
        // TODO: Replace with a switch statement once we have binary handlers as well

        // Read the directory containing the dropfile formats, and return undefined if we don't have the format
        const fileName = this.fileName;
        if (!fileName) {
            Log.info({fileType: this.fileType}, 'Dropfile format not supported.');
            return undefined;
        }
        const filePath = paths.join(this.dropFileFormatDirectory, fileName);
        fs.access(filePath, fs.constants.R_OK, err => {
            if (err) {
                Log.info({filename: fileName}, 'Dropfile format not found.');
                return undefined;
            }
        });

        // Return the handler to get the dropfile, because in the future we may have additional handlers
        return this.getDropfile;
    }

    getContents() {
        const handler = this.getHandler().bind(this);
        const contents = handler();
        return contents;
    }

    getDropfile() {
        // Get the filename to read
        const fileName = paths.join(this.dropFileFormatDirectory, this.fileName);

        let text = fs.readFileSync(fileName);

        // Format the data with string_format and predefined_mci
        let formatObj = getPredefinedMCIFormatObject(this.client, text);

        const additionalFormatObj = {
            'getSysopFirstName': this.getSysopFirstName(),
            'getSysopLastName': this.getSysopLastName(),
            'getUserFirstName': this.getUserFirstName(),
            'getUserLastName': this.getUserLastName(),
            'getUserTotalDownloadK': this.getUserTotalDownloadK(),
            'getUserTotalUploadK': this.getUserTotalUploadK(),
            'getCurrentDateMMDDYY': this.getCurrentDateMMDDYY(),
            'getSystemDailyDownloadK': this.getSystemDailyDownloadK(),
            'getUserBirthDateMMDDYY': this.getUserBirthDateMMDDYY(),
        };

        // Add additional format objects to the format object
        formatObj = _.merge(formatObj, additionalFormatObj);

        if (formatObj) {
            // Expand the text
            text = stringFormat(text, formatObj, true);
        }
        return text;
    }


    _getFirstName(fullname) {
        return parseFullName(fullname).first;
    }

    _getLastName(fullname) {
        return parseFullName(fullname).last;
    }

    getSysopFirstName() {
        return this._getFirstName(StatLog.getSystemStat(SysProps.SysOpRealName));
    }

    getSysopLastName() {
        return this._getLastName(StatLog.getSystemStat(SysProps.SysOpRealName));
    }

    _userStatAsString(statName, defaultValue) {
        return (StatLog.getUserStat(this.client.user, statName) || defaultValue).toLocaleString();
    }

    _getUserRealName() {
        return this._userStatAsString(UserProps.RealName, 'Unknown Unknown');
    }

    getUserFirstName() {
        return this._getFirstName(this._getUserRealName);
    }

    getUserLastName() {
        return this._getLastName(this._getUserRealName);
    }

    getUserTotalDownloadK() {
        return StatLog.getUserStatNum(this.client.user, UserProps.FileDlTotalBytes) / 1024;
    }

    getSystemDailyDownloadK() {
        return StatLog.getSystemStatNum(SysProps.getSystemDailyDownloadK) / 1024;
    }

    getUserTotalUploadK() {
        return StatLog.getUserStatNum(this.client.user, UserProps.FileUlTotalBytes) / 1024;
    }

    getCurrentDateMMDDYY() {
        // Return current date in MM/DD/YY format
        return moment().format('MM/DD/YY');
    }

    getUserBirthDateMMDDYY() {
        // Return user's birthdate in MM/DD/YY format
        return moment(this.client.user.properties[UserProps.Birthdate]).format('MM/DD/YY');
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

    createFile(cb) {
        mkdirs(paths.dirname(this.fullPath), err => {
            if (err) {
                return cb(err);
            }
            const fullPath = this.fullPath;
            const contents = this.getContents();
            return fs.writeFile(fullPath, contents, cb);
        });
    }
};
