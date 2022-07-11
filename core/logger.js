/* jslint node: true */
'use strict';

//  deps
const bunyan = require('bunyan');
const paths = require('path');
const fs = require('graceful-fs');
const _ = require('lodash');

module.exports = class Log {
    static init() {
        const Config = require('./config.js').get();
        const logPath = Config.paths.logs;

        const err = this.checkLogPath(logPath);
        if (err) {
            console.error(err.message); //  eslint-disable-line no-console
            return process.exit();
        }

        const logStreams = [];
        if (_.isObject(Config.logging.rotatingFile)) {
            Config.logging.rotatingFile.path = paths.join(
                logPath,
                Config.logging.rotatingFile.fileName
            );
            logStreams.push(Config.logging.rotatingFile);
        }

        const serializers = {
            err: bunyan.stdSerializers.err, //  handle 'err' fields with stack/etc.
        };

        //  try to remove sensitive info by default, e.g. 'password' fields
        ['formData', 'formValue'].forEach(keyName => {
            serializers[keyName] = fd => Log.hideSensitive(fd);
        });

        this.log = bunyan.createLogger({
            name: 'ENiGMA½ BBS',
            streams: logStreams,
            serializers: serializers,
        });
    }

    static checkLogPath(logPath) {
        try {
            if (!fs.statSync(logPath).isDirectory()) {
                return new Error(`${logPath} is not a directory`);
            }

            return null;
        } catch (e) {
            if ('ENOENT' === e.code) {
                return new Error(`${logPath} does not exist`);
            }
            return e;
        }
    }

    static hideSensitive(obj) {
        try {
            //
            //  Use a regexp -- we don't know how nested fields we want to seek and destroy may be
            //
            return JSON.parse(
                JSON.stringify(obj).replace(
                    /"(password|passwordConfirm|key|authCode)"\s?:\s?"([^"]+)"/,
                    (match, valueName) => {
                        return `"${valueName}":"********"`;
                    }
                )
            );
        } catch (e) {
            //  be safe and return empty obj!
            return {};
        }
    }
};
