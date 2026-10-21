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

            //  Remember the path we resolved: the value assigned above lives on
            //  the *current* config object, which a config.hjson hot-reload
            //  replaces wholesale -- taking the injected 'path' with it. Bunyan
            //  keeps writing to the stream created here either way, so this is
            //  the authoritative location of the active log file.
            this.rotatingFilePath = Config.logging.rotatingFile.path;

            logStreams.push(Config.logging.rotatingFile);
        }

        const serializers = Log.standardSerializers();

        this.log = bunyan.createLogger({
            name: 'ENiGMA½',
            streams: logStreams,
            serializers: serializers,
        });
    }

    //
    //  Call back once what has been logged so far has reached the log file,
    //  or after |timeoutMs|, whichever is first. process.exit() drops what a
    //  file stream still has queued, which used to cost the last lines before
    //  an exit -- the shutdown's own, among them. (A record logged while the
    //  rotating file is being rotated waits in bunyan's own queue and is not
    //  covered; that is a moment a day.)
    //
    static flush(cb, timeoutMs = 1000) {
        const pending = [];
        ((this.log && this.log.streams) || []).forEach(s => {
            //  a rotating-file stream wraps the fs.WriteStream doing the writes
            const w = s.stream && s.stream.stream ? s.stream.stream : s.stream;
            if (w && typeof w.write === 'function' && w.writableLength > 0) {
                pending.push(w);
            }
        });

        if (0 === pending.length) {
            return cb();
        }

        let left = pending.length;
        let called = false;
        const done = () => {
            if (!called) {
                called = true;
                clearTimeout(timer);
                return cb();
            }
        };
        const timer = setTimeout(done, timeoutMs);
        //  write callbacks run in order, so this one runs after the rest
        pending.forEach(w =>
            w.write('', () => {
                if (0 === --left) {
                    return done();
                }
            })
        );
    }

    //  Path of the active rotating log file, or undefined if not enabled.
    //  Prefer this over Config().logging.rotatingFile.path; see init().
    static getRotatingFilePath() {
        return this.rotatingFilePath;
    }

    static standardSerializers() {
        const serializers = {
            err: bunyan.stdSerializers.err, //  handle 'err' fields with stack/etc.
        };

        //  try to remove sensitive info by default, e.g. 'password' fields
        ['formData', 'formValue', 'user'].forEach(keyName => {
            serializers[keyName] = fd => Log.hideSensitive(fd);
        });

        return serializers;
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
                    // note that we match against key names here
                    /"(password|passwordConfirm|key|authCode)"\s?:\s?"([^"]+)"/g,
                    (match, keyName) => {
                        return `"${keyName}":"********"`;
                    }
                )
            );
        } catch (e) {
            //  be safe and return empty obj!
            return {};
        }
    }
};
