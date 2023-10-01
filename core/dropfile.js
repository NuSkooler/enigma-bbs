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
const iconv = require('iconv-lite');
const { mkdirs } = require('fs-extra');
const { stripMciColorCodes } = require('./color_codes.js');

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
        const fileName = this.fileName();
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
        return handler();
    }

    getDropfile() {
        // Get the filename to read
        const fileName = paths.join(this.dropFileFormatDirectory, this.fileName());

        // Read file, or return empty string if it doesn't exist
        fs.readFile(fileName, (err, data) => {
            if (err) {
                Log.warn({filename: fileName}, 'Error reading dropfile format file.');
                return '';
            }
            let text = data;
            // Format the data with string_format and predefined_mci
            const formatObj = getPredefinedMCIFormatObject(this.client, data);
            if (formatObj) {
                // Expand the text
                text = stringFormat(text, formatObj, true);
            }
            return text;
        });
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
            return fs.writeFile(this.fullPath, this.getContents(), cb);
        });
    }
};
