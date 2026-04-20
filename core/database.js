/* jslint node: true */
'use strict';

//  ENiGMA½
const conf = require('./config');

//  deps
const Database = require('better-sqlite3');
const paths = require('path');
const _ = require('lodash');
const assert = require('assert');
const moment = require('moment');

//  database handles
const dbs = {};

exports.getModDatabasePath = getModDatabasePath;
exports.loadDatabaseForMod = loadDatabaseForMod;
exports.openDatabase = openDatabase;
exports.getISOTimestampString = getISOTimestampString;
exports.sanitizeString = sanitizeString;
exports.initializeDatabases = initializeDatabases;
exports.scheduledEventOptimizeDatabases = scheduledEventOptimizeDatabases;

exports.dbs = dbs;

//
//  openDatabase — open (or create) a better-sqlite3 Database with standard
//  pragmas applied.  Returned synchronously; no callback needed.
//
function openDatabase(filePath) {
    const db = new Database(filePath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    return db;
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
    try {
        const db = openDatabase(getModDatabasePath(modInfo));
        return cb(null, db);
    } catch (err) {
        return cb(err);
    }
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
    return String(s).replace(/[\0\x08\x09\x1a\n\r"'\\%]/g, c => {
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
    try {
        for (const dbName of ['system', 'user', 'message', 'file', 'activitypub']) {
            dbs[dbName] = openDatabase(getDatabasePath(dbName));
            DB_INIT_TABLE[dbName]();
        }
        return cb(null);
    } catch (err) {
        return cb(err);
    }
}

const DB_INIT_TABLE = {
    system: () => {
        dbs.system.exec(`
            CREATE TABLE IF NOT EXISTS system_stat (
                stat_name       VARCHAR PRIMARY KEY NOT NULL,
                stat_value      VARCHAR NOT NULL
            );

            CREATE TABLE IF NOT EXISTS system_event_log (
                id              INTEGER PRIMARY KEY,
                timestamp       DATETIME NOT NULL,
                log_name        VARCHAR NOT NULL,
                log_value       VARCHAR NOT NULL,

                UNIQUE(timestamp, log_name)
            );

            CREATE TABLE IF NOT EXISTS user_event_log (
                id              INTEGER PRIMARY KEY,
                timestamp       DATETIME NOT NULL,
                user_id         INTEGER NOT NULL,
                session_id      VARCHAR NOT NULL,
                log_name        VARCHAR NOT NULL,
                log_value       VARCHAR NOT NULL,

                UNIQUE(timestamp, user_id, session_id, log_name)
            );
        `);
    },

    user: () => {
        dbs.user.exec(`
            CREATE TABLE IF NOT EXISTS user (
                id          INTEGER PRIMARY KEY,
                user_name   VARCHAR NOT NULL,
                UNIQUE(user_name)
            );

            CREATE TABLE IF NOT EXISTS user_property (
                user_id     INTEGER NOT NULL,
                prop_name   VARCHAR NOT NULL,
                prop_value  VARCHAR,
                UNIQUE(user_id, prop_name),
                FOREIGN KEY(user_id) REFERENCES user(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS user_property_id_and_name_index0
                ON user_property (user_id, prop_name);

            CREATE TABLE IF NOT EXISTS user_group_member (
                group_name  VARCHAR NOT NULL,
                user_id     INTEGER NOT NULL,
                UNIQUE(group_name, user_id)
            );

            CREATE TABLE IF NOT EXISTS user_achievement (
                user_id             INTEGER NOT NULL,
                achievement_tag     VARCHAR NOT NULL,
                timestamp           DATETIME NOT NULL,
                match               VARCHAR NOT NULL,
                title               VARCHAR NOT NULL,
                text                VARCHAR NOT NULL,
                points              INTEGER NOT NULL,
                UNIQUE(user_id, achievement_tag, match),
                FOREIGN KEY(user_id) REFERENCES user(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS user_temporary_token (
                user_id             INTEGER NOT NULL,
                token               VARCHAR NOT NULL,
                token_type          VARCHAR NOT NULL,
                timestamp           DATETIME NOT NULL,
                UNIQUE(user_id, token_type),
                FOREIGN KEY(user_id) REFERENCES user(id) ON DELETE CASCADE
            );
        `);
    },

    message: () => {
        dbs.message.exec(`
            CREATE TABLE IF NOT EXISTS message (
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
            );

            CREATE INDEX IF NOT EXISTS message_by_area_tag_index
                ON message (area_tag);

            CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts4 (
                content="message",
                subject,
                message
            );

            CREATE TRIGGER IF NOT EXISTS message_before_update BEFORE UPDATE ON message BEGIN
                DELETE FROM message_fts WHERE docid=old.rowid;
            END;

            CREATE TRIGGER IF NOT EXISTS message_before_delete BEFORE DELETE ON message BEGIN
                DELETE FROM message_fts WHERE docid=old.rowid;
            END;

            CREATE TRIGGER IF NOT EXISTS message_after_update AFTER UPDATE ON message BEGIN
                INSERT INTO message_fts(docid, subject, message) VALUES(new.rowid, new.subject, new.message);
            END;

            CREATE TRIGGER IF NOT EXISTS message_after_insert AFTER INSERT ON message BEGIN
                INSERT INTO message_fts(docid, subject, message) VALUES(new.rowid, new.subject, new.message);
            END;

            CREATE TABLE IF NOT EXISTS message_meta (
                message_id      INTEGER NOT NULL,
                meta_category   INTEGER NOT NULL,
                meta_name       VARCHAR NOT NULL,
                meta_value      VARCHAR NOT NULL,
                UNIQUE(message_id, meta_category, meta_name, meta_value),
                FOREIGN KEY(message_id) REFERENCES message(message_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS user_message_area_last_read (
                user_id     INTEGER NOT NULL,
                area_tag    VARCHAR NOT NULL,
                message_id  INTEGER NOT NULL,
                UNIQUE(user_id, area_tag)
            );

            CREATE TABLE IF NOT EXISTS message_area_last_scan (
                scan_toss       VARCHAR NOT NULL,
                area_tag        VARCHAR NOT NULL,
                message_id      INTEGER NOT NULL,
                UNIQUE(scan_toss, area_tag)
            );
        `);
    },

    file: () => {
        dbs.file.exec(`
            CREATE TABLE IF NOT EXISTS file (
                file_id                 INTEGER PRIMARY KEY,
                area_tag                VARCHAR NOT NULL,
                file_sha256             VARCHAR NOT NULL,
                file_name,              /* FTS @ file_fts */
                storage_tag             VARCHAR NOT NULL,
                storage_tag_rel_path    VARCHAR DEFAULT NULL,
                desc,                   /* FTS @ file_fts */
                desc_long,              /* FTS @ file_fts */
                upload_timestamp        DATETIME NOT NULL
            );

            CREATE INDEX IF NOT EXISTS file_by_area_tag_index
                ON file (area_tag);

            CREATE INDEX IF NOT EXISTS file_by_sha256_index
                ON file (file_sha256);

            CREATE INDEX IF NOT EXISTS file_by_storage_tag_index
                ON file (storage_tag);

            CREATE VIRTUAL TABLE IF NOT EXISTS file_fts USING fts4 (
                content="file",
                file_name,
                desc,
                desc_long
            );

            CREATE TRIGGER IF NOT EXISTS file_before_update BEFORE UPDATE ON file BEGIN
                DELETE FROM file_fts WHERE docid=old.rowid;
            END;

            CREATE TRIGGER IF NOT EXISTS file_before_delete BEFORE DELETE ON file BEGIN
                DELETE FROM file_fts WHERE docid=old.rowid;
            END;

            CREATE TRIGGER IF NOT EXISTS file_after_update AFTER UPDATE ON file BEGIN
                INSERT INTO file_fts(docid, file_name, desc, desc_long) VALUES(new.rowid, new.file_name, new.desc, new.desc_long);
            END;

            CREATE TRIGGER IF NOT EXISTS file_after_insert AFTER INSERT ON file BEGIN
                INSERT INTO file_fts(docid, file_name, desc, desc_long) VALUES(new.rowid, new.file_name, new.desc, new.desc_long);
            END;

            CREATE TABLE IF NOT EXISTS file_meta (
                file_id         INTEGER NOT NULL,
                meta_name       VARCHAR NOT NULL,
                meta_value      VARCHAR NOT NULL,
                UNIQUE(file_id, meta_name, meta_value),
                FOREIGN KEY(file_id) REFERENCES file(file_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS hash_tag (
                hash_tag_id     INTEGER PRIMARY KEY,
                hash_tag        VARCHAR NOT NULL,

                UNIQUE(hash_tag)
            );

            CREATE TABLE IF NOT EXISTS file_hash_tag (
                hash_tag_id     INTEGER NOT NULL,
                file_id         INTEGER NOT NULL,

                UNIQUE(hash_tag_id, file_id),
                FOREIGN KEY(file_id) REFERENCES file(file_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS file_user_rating (
                file_id         INTEGER NOT NULL,
                user_id         INTEGER NOT NULL,
                rating          INTEGER NOT NULL,

                UNIQUE(file_id, user_id),
                FOREIGN KEY(file_id) REFERENCES file(file_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS file_web_serve (
                hash_id             VARCHAR NOT NULL PRIMARY KEY,
                expire_timestamp    DATETIME NOT NULL
            );

            CREATE TABLE IF NOT EXISTS file_web_serve_batch (
                hash_id     VARCHAR NOT NULL,
                file_id     INTEGER NOT NULL,

                UNIQUE(hash_id, file_id),
                FOREIGN KEY(file_id) REFERENCES file(file_id) ON DELETE CASCADE
            );
        `);

        //  Inline migration: add storage_tag_rel_path to existing installations.
        //  ALTER TABLE ADD COLUMN is idempotent here: we check before altering.
        const row = dbs.file
            .prepare(
                `SELECT COUNT(*) AS cnt FROM pragma_table_info('file') WHERE name='storage_tag_rel_path'`
            )
            .get();
        if (row && row.cnt === 0) {
            dbs.file.exec(
                `ALTER TABLE file ADD COLUMN storage_tag_rel_path VARCHAR DEFAULT NULL`
            );
        }
    },

    activitypub: () => {
        dbs.activitypub.exec(`
            CREATE TABLE IF NOT EXISTS collection (
                collection_id       VARCHAR NOT NULL,
                name                VARCHAR NOT NULL,
                timestamp           DATETIME NOT NULL,
                owner_actor_id      VARCHAR NOT NULL,
                object_id           VARCHAR NOT NULL,
                object_json         VARCHAR NOT NULL,
                is_private          INTEGER NOT NULL,

                UNIQUE(name, collection_id, object_id)
            );

            CREATE INDEX IF NOT EXISTS collection_entry_by_name_actor_id_index0
                ON collection (name, owner_actor_id);

            CREATE INDEX IF NOT EXISTS collection_entry_by_name_collection_id_index0
                ON collection (name, collection_id);

            CREATE INDEX IF NOT EXISTS collection_entry_by_object_id_index0
                ON collection (object_id);

            CREATE INDEX IF NOT EXISTS collection_by_name_timestamp_index0
                ON collection (name, timestamp);

            CREATE INDEX IF NOT EXISTS collection_embedded_object_id_index0
                ON collection (json_extract(object_json, '$.object.id'));

            CREATE TABLE IF NOT EXISTS collection_object_meta (
                collection_id   VARCHAR NOT NULL,
                name            VARCHAR NOT NULL,
                object_id       VARCHAR NOT NULL,
                meta_name       VARCHAR NOT NULL,
                meta_value      VARCHAR NOT NULL,

                UNIQUE(collection_id, object_id, meta_name),
                FOREIGN KEY(name, collection_id, object_id) REFERENCES collection(name, collection_id, object_id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS collection_object_meta_by_name_and_meta_index0
                ON collection_object_meta (name, meta_name, meta_value);

            --
            --  Dedicated reactions table — stores inbound Like and Announce (boost)
            --  reactions against Notes.  One row per (note, actor, reaction_type) triple.
            --  The activity_id column enables idempotent Undo handling.
            --
            CREATE TABLE IF NOT EXISTS note_reactions (
                note_id         VARCHAR NOT NULL,
                actor_id        VARCHAR NOT NULL,
                reaction_type   VARCHAR NOT NULL,
                activity_id     VARCHAR NOT NULL,
                timestamp       DATETIME NOT NULL,
                UNIQUE(note_id, actor_id, reaction_type)
            );

            CREATE INDEX IF NOT EXISTS note_reactions_by_note_index0
                ON note_reactions (note_id, reaction_type);

            CREATE INDEX IF NOT EXISTS note_reactions_by_actor_index0
                ON note_reactions (actor_id, reaction_type);

            --
            --  FTS5 virtual table for full-text search of actors and sharedInbox notes.
            --
            --  coll_name   : 'actors' or 'sharedInbox' — UNINDEXED, used as a post-filter
            --  object_id   : AP object URL — UNINDEXED, used as a join key
            --  body        : searchable text:
            --                  actors    → preferredUsername + name + summary
            --                  notes     → summary + content (raw HTML; FTS tokenizer
            --                              treats angle brackets as word separators)
            --  tags        : actor subject (@user@host); empty for notes
            --
            CREATE VIRTUAL TABLE IF NOT EXISTS collection_fts USING fts5(
                coll_name   UNINDEXED,
                object_id   UNINDEXED,
                body,
                tags
            );

            -- Actor: index on insert
            CREATE TRIGGER IF NOT EXISTS collection_fts_actor_ai
            AFTER INSERT ON collection
            WHEN new.name = 'actors'
            BEGIN
                INSERT INTO collection_fts(rowid, coll_name, object_id, body, tags)
                VALUES (
                    new.rowid,
                    'actors',
                    new.object_id,
                    COALESCE(json_extract(new.object_json, '$.preferredUsername'), '') || ' ' ||
                    COALESCE(json_extract(new.object_json, '$.name'), '') || ' ' ||
                    COALESCE(json_extract(new.object_json, '$.summary'), ''),
                    ''
                );
            END;

            -- Actor: re-index on update (object_json changed — e.g. profile refresh)
            CREATE TRIGGER IF NOT EXISTS collection_fts_actor_au
            AFTER UPDATE OF object_json ON collection
            WHEN new.name = 'actors'
            BEGIN
                DELETE FROM collection_fts WHERE rowid = old.rowid;
                INSERT INTO collection_fts(rowid, coll_name, object_id, body, tags)
                VALUES (
                    new.rowid,
                    'actors',
                    new.object_id,
                    COALESCE(json_extract(new.object_json, '$.preferredUsername'), '') || ' ' ||
                    COALESCE(json_extract(new.object_json, '$.name'), '') || ' ' ||
                    COALESCE(json_extract(new.object_json, '$.summary'), ''),
                    COALESCE((
                        SELECT meta_value FROM collection_object_meta
                        WHERE object_id = new.object_id AND name = 'actors' AND meta_name = 'actor_subject'
                        LIMIT 1
                    ), '')
                );
            END;

            -- Actor: remove from index on delete
            CREATE TRIGGER IF NOT EXISTS collection_fts_actor_bd
            BEFORE DELETE ON collection
            WHEN old.name = 'actors'
            BEGIN
                DELETE FROM collection_fts WHERE rowid = old.rowid;
            END;

            -- Actor subject: update FTS tags when actor_subject meta is inserted
            CREATE TRIGGER IF NOT EXISTS collection_fts_subject_ai
            AFTER INSERT ON collection_object_meta
            WHEN new.name = 'actors' AND new.meta_name = 'actor_subject'
            BEGIN
                UPDATE collection_fts
                SET tags = new.meta_value
                WHERE rowid = (
                    SELECT rowid FROM collection
                    WHERE object_id = new.object_id AND name = 'actors'
                    LIMIT 1
                );
            END;

            -- Actor subject: update FTS tags when actor_subject meta is replaced
            CREATE TRIGGER IF NOT EXISTS collection_fts_subject_au
            AFTER UPDATE ON collection_object_meta
            WHEN new.name = 'actors' AND new.meta_name = 'actor_subject'
            BEGIN
                UPDATE collection_fts
                SET tags = new.meta_value
                WHERE rowid = (
                    SELECT rowid FROM collection
                    WHERE object_id = new.object_id AND name = 'actors'
                    LIMIT 1
                );
            END;

            -- Note (sharedInbox): index on insert.
            --   Body comes from the inner Note ($.object.*); the stored row is a
            --   Create{Note} activity, so content lives one level deeper than $.content.
            --   Tags are extracted from the Note's tag array (Hashtag entries only).
            DROP TRIGGER IF EXISTS collection_fts_note_ai;
            CREATE TRIGGER collection_fts_note_ai
            AFTER INSERT ON collection
            WHEN new.name = 'sharedInbox'
            BEGIN
                INSERT INTO collection_fts(rowid, coll_name, object_id, body, tags)
                VALUES (
                    new.rowid,
                    'sharedInbox',
                    new.object_id,
                    COALESCE(json_extract(new.object_json, '$.object.summary'), '') || ' ' ||
                    COALESCE(json_extract(new.object_json, '$.object.content'), ''),
                    COALESCE((
                        SELECT GROUP_CONCAT(json_extract(t.value, '$.name'), ' ')
                        FROM json_each(json_extract(new.object_json, '$.object.tag')) t
                        WHERE json_extract(t.value, '$.type') = 'Hashtag'
                    ), '')
                );
            END;

            -- Note: re-index on update (Update activity received for a Note)
            DROP TRIGGER IF EXISTS collection_fts_note_au;
            CREATE TRIGGER collection_fts_note_au
            AFTER UPDATE OF object_json ON collection
            WHEN new.name = 'sharedInbox'
            BEGIN
                DELETE FROM collection_fts WHERE rowid = old.rowid;
                INSERT INTO collection_fts(rowid, coll_name, object_id, body, tags)
                VALUES (
                    new.rowid,
                    'sharedInbox',
                    new.object_id,
                    COALESCE(json_extract(new.object_json, '$.object.summary'), '') || ' ' ||
                    COALESCE(json_extract(new.object_json, '$.object.content'), ''),
                    COALESCE((
                        SELECT GROUP_CONCAT(json_extract(t.value, '$.name'), ' ')
                        FROM json_each(json_extract(new.object_json, '$.object.tag')) t
                        WHERE json_extract(t.value, '$.type') = 'Hashtag'
                    ), '')
                );
            END;

            -- Note: remove from index on delete
            DROP TRIGGER IF EXISTS collection_fts_note_bd;
            CREATE TRIGGER collection_fts_note_bd
            BEFORE DELETE ON collection
            WHEN old.name = 'sharedInbox'
            BEGIN
                DELETE FROM collection_fts WHERE rowid = old.rowid;
            END;

            -- Outbox (local posts): same structure as sharedInbox triggers.
            --   Local Create{Note} activities are stored in the outbox collection.
            DROP TRIGGER IF EXISTS collection_fts_outbox_ai;
            CREATE TRIGGER collection_fts_outbox_ai
            AFTER INSERT ON collection
            WHEN new.name = 'outbox'
            BEGIN
                INSERT INTO collection_fts(rowid, coll_name, object_id, body, tags)
                VALUES (
                    new.rowid,
                    'outbox',
                    new.object_id,
                    COALESCE(json_extract(new.object_json, '$.object.summary'), '') || ' ' ||
                    COALESCE(json_extract(new.object_json, '$.object.content'), ''),
                    COALESCE((
                        SELECT GROUP_CONCAT(json_extract(t.value, '$.name'), ' ')
                        FROM json_each(json_extract(new.object_json, '$.object.tag')) t
                        WHERE json_extract(t.value, '$.type') = 'Hashtag'
                    ), '')
                );
            END;

            DROP TRIGGER IF EXISTS collection_fts_outbox_au;
            CREATE TRIGGER collection_fts_outbox_au
            AFTER UPDATE OF object_json ON collection
            WHEN new.name = 'outbox'
            BEGIN
                DELETE FROM collection_fts WHERE rowid = old.rowid;
                INSERT INTO collection_fts(rowid, coll_name, object_id, body, tags)
                VALUES (
                    new.rowid,
                    'outbox',
                    new.object_id,
                    COALESCE(json_extract(new.object_json, '$.object.summary'), '') || ' ' ||
                    COALESCE(json_extract(new.object_json, '$.object.content'), ''),
                    COALESCE((
                        SELECT GROUP_CONCAT(json_extract(t.value, '$.name'), ' ')
                        FROM json_each(json_extract(new.object_json, '$.object.tag')) t
                        WHERE json_extract(t.value, '$.type') = 'Hashtag'
                    ), '')
                );
            END;

            DROP TRIGGER IF EXISTS collection_fts_outbox_bd;
            CREATE TRIGGER collection_fts_outbox_bd
            BEFORE DELETE ON collection
            WHEN old.name = 'outbox'
            BEGIN
                DELETE FROM collection_fts WHERE rowid = old.rowid;
            END;
        `);

        //
        //  One-time backfill: populate collection_fts for pre-existing rows that
        //  were inserted before the FTS5 schema was added.  Safe to run on every
        //  start — the guard conditions make it a no-op once the index is populated.
        //
        const ftsCount = dbs.activitypub
            .prepare('SELECT COUNT(*) AS n FROM collection_fts')
            .get().n;

        if (ftsCount === 0) {
            const hasIndexable = dbs.activitypub
                .prepare(
                    `SELECT COUNT(*) AS n FROM collection WHERE name IN ('actors', 'sharedInbox')`
                )
                .get().n;

            if (hasIndexable > 0) {
                dbs.activitypub.exec(`
                    INSERT INTO collection_fts(rowid, coll_name, object_id, body, tags)
                    SELECT
                        c.rowid,
                        'actors',
                        c.object_id,
                        COALESCE(json_extract(c.object_json, '$.preferredUsername'), '') || ' ' ||
                        COALESCE(json_extract(c.object_json, '$.name'), '') || ' ' ||
                        COALESCE(json_extract(c.object_json, '$.summary'), ''),
                        COALESCE(m.meta_value, '')
                    FROM collection c
                    LEFT JOIN collection_object_meta m
                        ON  m.object_id  = c.object_id
                        AND m.name       = 'actors'
                        AND m.meta_name  = 'actor_subject'
                    WHERE c.name = 'actors';

                    INSERT INTO collection_fts(rowid, coll_name, object_id, body, tags)
                    SELECT
                        c.rowid,
                        'sharedInbox',
                        c.object_id,
                        COALESCE(json_extract(c.object_json, '$.object.summary'), '') || ' ' ||
                        COALESCE(json_extract(c.object_json, '$.object.content'), ''),
                        COALESCE((
                            SELECT GROUP_CONCAT(json_extract(t.value, '$.name'), ' ')
                            FROM json_each(json_extract(c.object_json, '$.object.tag')) t
                            WHERE json_extract(t.value, '$.type') = 'Hashtag'
                        ), '')
                    FROM collection c
                    WHERE c.name = 'sharedInbox';

                    INSERT INTO collection_fts(rowid, coll_name, object_id, body, tags)
                    SELECT
                        c.rowid,
                        'outbox',
                        c.object_id,
                        COALESCE(json_extract(c.object_json, '$.object.summary'), '') || ' ' ||
                        COALESCE(json_extract(c.object_json, '$.object.content'), ''),
                        COALESCE((
                            SELECT GROUP_CONCAT(json_extract(t.value, '$.name'), ' ')
                            FROM json_each(json_extract(c.object_json, '$.object.tag')) t
                            WHERE json_extract(t.value, '$.type') = 'Hashtag'
                        ), '')
                    FROM collection c
                    WHERE c.name = 'outbox';
                `);
            }
        }

        //
        //  Migration v1: fix sharedInbox FTS body/tags paths (were pointing at the
        //  Create activity root instead of $.object.*), and add outbox indexing for
        //  local posts.  Guarded by PRAGMA user_version so it runs exactly once.
        //
        const apDbVersion = dbs.activitypub.pragma('user_version', { simple: true });
        if (apDbVersion < 1) {
            dbs.activitypub.exec(`
                DELETE FROM collection_fts WHERE coll_name IN ('sharedInbox', 'outbox');

                INSERT INTO collection_fts(rowid, coll_name, object_id, body, tags)
                SELECT
                    c.rowid,
                    'sharedInbox',
                    c.object_id,
                    COALESCE(json_extract(c.object_json, '$.object.summary'), '') || ' ' ||
                    COALESCE(json_extract(c.object_json, '$.object.content'), ''),
                    COALESCE((
                        SELECT GROUP_CONCAT(json_extract(t.value, '$.name'), ' ')
                        FROM json_each(json_extract(c.object_json, '$.object.tag')) t
                        WHERE json_extract(t.value, '$.type') = 'Hashtag'
                    ), '')
                FROM collection c
                WHERE c.name = 'sharedInbox';

                INSERT INTO collection_fts(rowid, coll_name, object_id, body, tags)
                SELECT
                    c.rowid,
                    'outbox',
                    c.object_id,
                    COALESCE(json_extract(c.object_json, '$.object.summary'), '') || ' ' ||
                    COALESCE(json_extract(c.object_json, '$.object.content'), ''),
                    COALESCE((
                        SELECT GROUP_CONCAT(json_extract(t.value, '$.name'), ' ')
                        FROM json_each(json_extract(c.object_json, '$.object.tag')) t
                        WHERE json_extract(t.value, '$.type') = 'Hashtag'
                    ), '')
                FROM collection c
                WHERE c.name = 'outbox';
            `);
            dbs.activitypub.pragma('user_version = 1');
        }

        //
        //  One-time migration: backfill note_reactions from legacy meta-based storage.
        //  Guard: only runs when note_reactions is empty AND legacy reaction meta exists.
        //
        //  Legacy schema stored Like and Announce reactions as collection_object_meta rows
        //  with meta_name = 'activity_type' and meta_value IN ('Like', 'Announce').
        //  Each reaction also had corresponding 'liked_by'/'boosted_by' and
        //  'liked_object_id'/'original_note_id' rows tied to the same object_id.
        //
        const reactionsCount = dbs.activitypub
            .prepare('SELECT COUNT(*) AS n FROM note_reactions')
            .get().n;

        if (reactionsCount === 0) {
            const legacyCount = dbs.activitypub
                .prepare(
                    `SELECT COUNT(*) AS n FROM collection_object_meta
                     WHERE meta_name = 'activity_type'
                       AND meta_value IN ('Like', 'Announce')`
                )
                .get().n;

            if (legacyCount > 0) {
                dbs.activitypub.exec(`
                    -- Migrate legacy Like reactions
                    INSERT OR IGNORE INTO note_reactions
                        (note_id, actor_id, reaction_type, activity_id, timestamp)
                    SELECT
                        liked.meta_value    AS note_id,
                        by_.meta_value      AS actor_id,
                        'Like'              AS reaction_type,
                        c.object_id         AS activity_id,
                        c.timestamp         AS timestamp
                    FROM collection_object_meta typ
                    JOIN collection c
                        ON  c.name      = typ.name
                        AND c.object_id = typ.object_id
                    JOIN collection_object_meta liked
                        ON  liked.collection_id = typ.collection_id
                        AND liked.object_id     = typ.object_id
                        AND liked.meta_name     = 'liked_object_id'
                    JOIN collection_object_meta by_
                        ON  by_.collection_id   = typ.collection_id
                        AND by_.object_id       = typ.object_id
                        AND by_.meta_name       = 'liked_by'
                    WHERE typ.meta_name  = 'activity_type'
                      AND typ.meta_value = 'Like';

                    -- Migrate legacy Announce (boost) reactions
                    INSERT OR IGNORE INTO note_reactions
                        (note_id, actor_id, reaction_type, activity_id, timestamp)
                    SELECT
                        orig.meta_value     AS note_id,
                        by_.meta_value      AS actor_id,
                        'Announce'          AS reaction_type,
                        c.object_id         AS activity_id,
                        c.timestamp         AS timestamp
                    FROM collection_object_meta typ
                    JOIN collection c
                        ON  c.name      = typ.name
                        AND c.object_id = typ.object_id
                    JOIN collection_object_meta orig
                        ON  orig.collection_id  = typ.collection_id
                        AND orig.object_id      = typ.object_id
                        AND orig.meta_name      = 'original_note_id'
                    JOIN collection_object_meta by_
                        ON  by_.collection_id   = typ.collection_id
                        AND by_.object_id       = typ.object_id
                        AND by_.meta_name       = 'boosted_by'
                    WHERE typ.meta_name  = 'activity_type'
                      AND typ.meta_value = 'Announce';
                `);
            }
        }
    },
};

function scheduledEventOptimizeDatabases(args, cb) {
    try {
        for (const db of Object.values(dbs)) {
            db.pragma('optimize');
        }
        return cb(null);
    } catch (err) {
        return cb(err);
    }
}
