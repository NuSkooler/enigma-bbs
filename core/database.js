/* jslint node: true */
'use strict';

//  ENiGMA½
const conf = require('./config');

//  deps
const sqlite3 = require('sqlite3');
const sqlite3Trans = require('sqlite3-trans');
const paths = require('path');
const async = require('async');
const _ = require('lodash');
const assert = require('assert');
const moment = require('moment');

//  database handles
const dbs = {};

exports.getTransactionDatabase = getTransactionDatabase;
exports.getModDatabasePath = getModDatabasePath;
exports.loadDatabaseForMod = loadDatabaseForMod;
exports.getISOTimestampString = getISOTimestampString;
exports.sanitizeString = sanitizeString;
exports.initializeDatabases = initializeDatabases;

exports.dbs = dbs;

function getTransactionDatabase(db) {
    return sqlite3Trans.wrap(db);
}

function getDatabasePath(name) {
    const Config = conf.get();
    return paths.join(Config.paths.db, `${name}.sqlite3`);
}

function getModDatabasePath(moduleInfo, suffix) {
    //
    //  Mods that use a database are stored in Config.paths.modsDb (e.g. enigma-bbs/db/mods)
    //  We expect that moduleInfo defines packageName which will be the base of the modules
    //  filename. An optional suffix may be supplied as well.
    //
    const HOST_RE =
        /^(([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])\.)*([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9])$/;

    assert(_.isObject(moduleInfo));
    assert(_.isString(moduleInfo.packageName), 'moduleInfo must define "packageName"!');

    let full = moduleInfo.packageName;
    if (suffix) {
        full += `.${suffix}`;
    }

    assert(
        full.split('.').length > 1 && HOST_RE.test(full),
        'packageName must follow Reverse Domain Name Notation - https://en.wikipedia.org/wiki/Reverse_domain_name_notation'
    );

    const Config = conf.get();
    return paths.join(Config.paths.modsDb, `${full}.sqlite3`);
}

function loadDatabaseForMod(modInfo, cb) {
    const db = getTransactionDatabase(
        new sqlite3.Database(getModDatabasePath(modInfo), err => {
            return cb(err, db);
        })
    );
}

function getISOTimestampString(ts) {
    ts = ts || moment();
    if (!moment.isMoment(ts)) {
        if (_.isString(ts)) {
            ts = ts.replace(/\//g, '-');
        }
        ts = moment(ts);
    }
    return ts.format('YYYY-MM-DDTHH:mm:ss.SSSZ');
}

function sanitizeString(s) {
    return s.replace(/[\0\x08\x09\x1a\n\r"'\\%]/g, c => {
        //  eslint-disable-line no-control-regex
        switch (c) {
            case '\0':
                return '\\0';
            case '\x08':
                return '\\b';
            case '\x09':
                return '\\t';
            case '\x1a':
                return '\\z';
            case '\n':
                return '\\n';
            case '\r':
                return '\\r';

            case '"':
            case "'":
                return `${c}${c}`;

            case '\\':
            case '%':
                return `\\${c}`;
        }
    });
}

function initializeDatabases(cb) {
    async.eachSeries(
        ['system', 'user', 'message', 'file'],
        (dbName, next) => {
            dbs[dbName] = sqlite3Trans.wrap(
                new sqlite3.Database(getDatabasePath(dbName), err => {
                    if (err) {
                        return cb(err);
                    }

                    dbs[dbName].serialize(() => {
                        DB_INIT_TABLE[dbName](() => {
                            return next(null);
                        });
                    });
                })
            );
        },
        err => {
            return cb(err);
        }
    );
}

function enableForeignKeys(db) {
    db.run('PRAGMA foreign_keys = ON;');
}

const DB_INIT_TABLE = {
    system: cb => {
        enableForeignKeys(dbs.system);

        //  Various stat/event logging - see stat_log.js
        dbs.system.run(
            `CREATE TABLE IF NOT EXISTS system_stat (
                stat_name       VARCHAR PRIMARY KEY NOT NULL,
                stat_value      VARCHAR NOT NULL
            );`
        );

        dbs.system.run(
            `CREATE TABLE IF NOT EXISTS system_event_log (
                id              INTEGER PRIMARY KEY,
                timestamp       DATETIME NOT NULL,
                log_name        VARCHAR NOT NULL,
                log_value       VARCHAR NOT NULL,

                UNIQUE(timestamp, log_name)
            );`
        );

        dbs.system.run(
            `CREATE TABLE IF NOT EXISTS user_event_log (
                id              INTEGER PRIMARY KEY,
                timestamp       DATETIME NOT NULL,
                user_id         INTEGER NOT NULL,
                session_id      VARCHAR NOT NULL,
                log_name        VARCHAR NOT NULL,
                log_value       VARCHAR NOT NULL,

                UNIQUE(timestamp, user_id, session_id, log_name)
            );`
        );

        return cb(null);
    },

    user: cb => {
        enableForeignKeys(dbs.user);

        dbs.user.run(
            `CREATE TABLE IF NOT EXISTS user (
                id          INTEGER PRIMARY KEY,
                user_name   VARCHAR NOT NULL,
                UNIQUE(user_name)
            );`
        );

        //  :TODO: create FK on delete/etc.

        dbs.user.run(
            `CREATE TABLE IF NOT EXISTS user_property (
                user_id     INTEGER NOT NULL,
                prop_name   VARCHAR NOT NULL,
                prop_value  VARCHAR,
                UNIQUE(user_id, prop_name),
                FOREIGN KEY(user_id) REFERENCES user(id) ON DELETE CASCADE
            );`
        );

        dbs.user.run(
            `CREATE INDEX IF NOT EXISTS user_property_id_and_name_index0
            ON user_property (user_id, prop_name);`
        );

        dbs.user.run(
            `CREATE TABLE IF NOT EXISTS user_group_member (
                group_name  VARCHAR NOT NULL,
                user_id     INTEGER NOT NULL,
                UNIQUE(group_name, user_id)
            );`
        );

        dbs.user.run(
            `CREATE TABLE IF NOT EXISTS user_achievement (
                user_id             INTEGER NOT NULL,
                achievement_tag     VARCHAR NOT NULL,
                timestamp           DATETIME NOT NULL,
                match               VARCHAR NOT NULL,
                title               VARCHAR NOT NULL,
                text                VARCHAR NOT NULL,
                points              INTEGER NOT NULL,
                UNIQUE(user_id, achievement_tag, match),
                FOREIGN KEY(user_id) REFERENCES user(id) ON DELETE CASCADE
            );`
        );

        //
        //  Table for temporary tokens, generally used for e.g. 'outside'
        //  access such as email links.
        //  Examples: PW reset, enabling of 2FA/OTP, etc.
        //
        dbs.user.run(
            `CREATE TABLE IF NOT EXISTS user_temporary_token (
                user_id             INTEGER NOT NULL,
                token               VARCHAR NOT NULL,
                token_type          VARCHAR NOT NULL,
                timestamp           DATETIME NOT NULL,
                UNIQUE(user_id, token_type),
                FOREIGN KEY(user_id) REFERENCES user(id) ON DELETE CASCADE
            );`
        );

        return cb(null);
    },

    message: cb => {
        enableForeignKeys(dbs.message);

        dbs.message.run(
            `CREATE TABLE IF NOT EXISTS message (
                message_id              INTEGER PRIMARY KEY,
                area_tag                VARCHAR NOT NULL,
                message_uuid            VARCHAR(36) NOT NULL,
                reply_to_message_id     INTEGER,
                to_user_name            VARCHAR NOT NULL,
                from_user_name          VARCHAR NOT NULL,
                subject, /* FTS @ message_fts */
                message, /* FTS @ message_fts */
                modified_timestamp      DATETIME NOT NULL,
                view_count              INTEGER NOT NULL DEFAULT 0,
                UNIQUE(message_uuid)
            );`
        );

        dbs.message.run(
            `CREATE INDEX IF NOT EXISTS message_by_area_tag_index
            ON message (area_tag);`
        );

        dbs.message.run(
            `CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts4 (
                content="message",
                subject,
                message
            );`
        );

        dbs.message.run(
            `CREATE TRIGGER IF NOT EXISTS message_before_update BEFORE UPDATE ON message BEGIN
                DELETE FROM message_fts WHERE docid=old.rowid;
            END;`
        );

        dbs.message.run(
            `CREATE TRIGGER IF NOT EXISTS message_before_delete BEFORE DELETE ON message BEGIN
                DELETE FROM message_fts WHERE docid=old.rowid;
            END;`
        );

        dbs.message.run(
            `CREATE TRIGGER IF NOT EXISTS message_after_update AFTER UPDATE ON message BEGIN
                INSERT INTO message_fts(docid, subject, message) VALUES(new.rowid, new.subject, new.message);
            END;`
        );

        dbs.message.run(
            `CREATE TRIGGER IF NOT EXISTS message_after_insert AFTER INSERT ON message BEGIN
                INSERT INTO message_fts(docid, subject, message) VALUES(new.rowid, new.subject, new.message);
            END;`
        );

        dbs.message.run(
            `CREATE TABLE IF NOT EXISTS message_meta (
                message_id      INTEGER NOT NULL,
                meta_category   INTEGER NOT NULL,
                meta_name       VARCHAR NOT NULL,
                meta_value      VARCHAR NOT NULL,
                UNIQUE(message_id, meta_category, meta_name, meta_value),
                FOREIGN KEY(message_id) REFERENCES message(message_id) ON DELETE CASCADE
            );`
        );

        //  :TODO: need SQL to ensure cleaned up if delete from message?
        /*
        dbs.message.run(
            `CREATE TABLE IF NOT EXISTS hash_tag (
                hash_tag_id     INTEGER PRIMARY KEY,
                hash_tag_name   VARCHAR NOT NULL,
                UNIQUE(hash_tag_name)
            );`
        );

        //  :TODO: need SQL to ensure cleaned up if delete from message?
        dbs.message.run(
            `CREATE TABLE IF NOT EXISTS message_hash_tag (
                hash_tag_id INTEGER NOT NULL,
                message_id  INTEGER NOT NULL,
            );`
        );
        */

        dbs.message.run(
            `CREATE TABLE IF NOT EXISTS user_message_area_last_read (
                user_id     INTEGER NOT NULL,
                area_tag    VARCHAR NOT NULL,
                message_id  INTEGER NOT NULL,
                UNIQUE(user_id, area_tag)
            );`
        );

        dbs.message.run(
            `CREATE TABLE IF NOT EXISTS message_area_last_scan (
                scan_toss       VARCHAR NOT NULL,
                area_tag        VARCHAR NOT NULL,
                message_id      INTEGER NOT NULL,
                UNIQUE(scan_toss, area_tag)
            );`
        );

        return cb(null);
    },

    file: cb => {
        enableForeignKeys(dbs.file);

        dbs.file.run(
            //  :TODO: should any of this be unique -- file_sha256 unless dupes are allowed on the system
            `CREATE TABLE IF NOT EXISTS file (
                file_id             INTEGER PRIMARY KEY,
                area_tag            VARCHAR NOT NULL,
                file_sha256         VARCHAR NOT NULL,
                file_name,          /* FTS @ file_fts */
                storage_tag         VARCHAR NOT NULL,
                desc,               /* FTS @ file_fts */
                desc_long,          /* FTS @ file_fts */
                upload_timestamp    DATETIME NOT NULL
            );`
        );

        dbs.file.run(
            `CREATE INDEX IF NOT EXISTS file_by_area_tag_index
            ON file (area_tag);`
        );

        dbs.file.run(
            `CREATE INDEX IF NOT EXISTS file_by_sha256_index
            ON file (file_sha256);`
        );

        dbs.file.run(
            `CREATE VIRTUAL TABLE IF NOT EXISTS file_fts USING fts4 (
                content="file",
                file_name,
                desc,
                desc_long
            );`
        );

        dbs.file.run(
            `CREATE TRIGGER IF NOT EXISTS file_before_update BEFORE UPDATE ON file BEGIN
                DELETE FROM file_fts WHERE docid=old.rowid;
            END;`
        );

        dbs.file.run(
            `CREATE TRIGGER IF NOT EXISTS file_before_delete BEFORE DELETE ON file BEGIN
                DELETE FROM file_fts WHERE docid=old.rowid;
            END;`
        );

        dbs.file.run(
            `CREATE TRIGGER IF NOT EXISTS file_after_update AFTER UPDATE ON file BEGIN
                INSERT INTO file_fts(docid, file_name, desc, desc_long) VALUES(new.rowid, new.file_name, new.desc, new.desc_long);
            END;`
        );

        dbs.file.run(
            `CREATE TRIGGER IF NOT EXISTS file_after_insert AFTER INSERT ON file BEGIN
                INSERT INTO file_fts(docid, file_name, desc, desc_long) VALUES(new.rowid, new.file_name, new.desc, new.desc_long);
            END;`
        );

        dbs.file.run(
            `CREATE TABLE IF NOT EXISTS file_meta (
                file_id         INTEGER NOT NULL,
                meta_name       VARCHAR NOT NULL,
                meta_value      VARCHAR NOT NULL,
                UNIQUE(file_id, meta_name, meta_value),
                FOREIGN KEY(file_id) REFERENCES file(file_id) ON DELETE CASCADE
            );`
        );

        dbs.file.run(
            `CREATE TABLE IF NOT EXISTS hash_tag (
                hash_tag_id     INTEGER PRIMARY KEY,
                hash_tag        VARCHAR NOT NULL,

                UNIQUE(hash_tag)
            );`
        );

        dbs.file.run(
            `CREATE TABLE IF NOT EXISTS file_hash_tag (
                hash_tag_id     INTEGER NOT NULL,
                file_id         INTEGER NOT NULL,

                UNIQUE(hash_tag_id, file_id),
                FOREIGN KEY(file_id) REFERENCES file(file_id) ON DELETE CASCADE
            );`
        );

        dbs.file.run(
            `CREATE TABLE IF NOT EXISTS file_user_rating (
                file_id         INTEGER NOT NULL,
                user_id         INTEGER NOT NULL,
                rating          INTEGER NOT NULL,

                UNIQUE(file_id, user_id),
                FOREIGN KEY(file_id) REFERENCES file(file_id) ON DELETE CASCADE
                -- Note that we cannot CASCADE if user_id is removed from user.db
                -- See processing in oputil's removeUser()
            );`
        );

        dbs.file.run(
            `CREATE TABLE IF NOT EXISTS file_web_serve (
                hash_id             VARCHAR NOT NULL PRIMARY KEY,
                expire_timestamp    DATETIME NOT NULL
            );`
        );

        dbs.file.run(
            `CREATE TABLE IF NOT EXISTS file_web_serve_batch (
                hash_id     VARCHAR NOT NULL,
                file_id     INTEGER NOT NULL,

                UNIQUE(hash_id, file_id),
                FOREIGN KEY(file_id) REFERENCES file(file_id) ON DELETE CASCADE
            );`
        );

        return cb(null);
    },
};
