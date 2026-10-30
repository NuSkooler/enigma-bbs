/* jslint node: true */
'use strict';

//  ENiGMA½
const conf = require('./config');
const Logger = require('./logger.js');

//  deps
const Database = require('better-sqlite3');
const paths = require('path');
const fse = require('fs-extra');
const _ = require('lodash');
const assert = require('assert');
const moment = require('moment');

//  database handles
const dbs = {};

exports.getDatabasePath = getDatabasePath;
exports.getModDatabasePath = getModDatabasePath;
exports.loadDatabaseForMod = loadDatabaseForMod;
exports.openDatabase = openDatabase;
exports.getISOTimestampString = getISOTimestampString;
exports.coerceToText = coerceToText;
exports.initializeDatabases = initializeDatabases;
exports.scheduledEventOptimizeDatabases = scheduledEventOptimizeDatabases;
exports.scheduledEventCheckpointDatabases = scheduledEventCheckpointDatabases;
exports.scheduledEventBackupDatabases = scheduledEventBackupDatabases;
exports.checkpointDatabases = checkpointDatabases;
exports.backupDatabases = backupDatabases;
exports.initMessageDatabase = initMessageDatabase;
exports.migrateMessageIdAutoincrement = migrateMessageIdAutoincrement;
exports.migrateMessageFtsRebuild = migrateMessageFtsRebuild;
exports.migrateActivityPubActorCachePurge = migrateActivityPubActorCachePurge;

exports.dbs = dbs;

//
//  better-sqlite3 binds a JavaScript Number as REAL, so SQLite writes '1.0'
//  (not '1') into TEXT-affinity columns. Call this on any value that may be a
//  Number before binding to a text column so the stored form is the plain
//  integer/decimal representation.
//
function coerceToText(v) {
    return typeof v === 'number' ? String(v) : v;
}

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
    const originalTs = ts;
    ts = ts || moment();
    if (!moment.isMoment(ts)) {
        if (_.isString(ts)) {
            ts = ts.replace(/\//g, '-');
        }
        ts = moment(ts);
    }
    //  Never persist the literal string "Invalid date": moment.format() on an
    //  invalid moment returns that, which silently corrupts the DB column.
    if (!ts.isValid()) {
        //  Logger.log is set by logger.init() during startup; may be undefined
        //  if this is called before init (shouldn't happen in normal flow).
        if (Logger.log) {
            Logger.log.warn(
                { input: originalTs },
                'Invalid timestamp passed to getISOTimestampString; falling back to now'
            );
        }
        ts = moment();
    }
    return ts.format('YYYY-MM-DDTHH:mm:ss.SSSZ');
}

function initializeDatabases(cb) {
    try {
        for (const dbName of ['system', 'user', 'message', 'file', 'activitypub']) {
            dbs[dbName] = openDatabase(getDatabasePath(dbName));
            DB_INIT_TABLE[dbName]();
        }
        repairNumberTextValuesV1();
        return cb(null);
    } catch (err) {
        return cb(err);
    }
}

//
//  One-shot repair for rows written while better-sqlite3 was binding Numbers
//  as REAL into TEXT columns (landed with the node-sqlite3 → better-sqlite3
//  migration). Rewrites values of the form '<integer>.0' back to '<integer>'
//  in columns known to hold integer identifiers. Non-integer decimals and
//  strings that merely end in '.0' are preserved by the round-trip guard.
//
//  Gated via system_stat so each installation only pays the cost once.
//
const NUMBER_TEXT_REPAIR_FLAG = 'db_number_text_repair_v1';
//  keyColumns mirror each table's UNIQUE constraint minus the value column —
//  used to drop duplicate '<int>.0' rows that would otherwise clash with their
//  canonical '<int>' sibling on UPDATE.
const NUMBER_TEXT_REPAIR_TARGETS = [
    {
        db: 'message',
        table: 'message_meta',
        column: 'meta_value',
        keyColumns: ['message_id', 'meta_category', 'meta_name'],
    },
    {
        db: 'user',
        table: 'user_property',
        column: 'prop_value',
        keyColumns: ['user_id', 'prop_name'],
    },
    {
        db: 'user',
        table: 'user_achievement',
        column: 'match',
        keyColumns: ['user_id', 'achievement_tag'],
    },
    {
        db: 'system',
        table: 'user_event_log',
        column: 'log_value',
        keyColumns: ['timestamp', 'user_id', 'session_id', 'log_name'],
    },
    {
        db: 'system',
        table: 'system_event_log',
        column: 'log_value',
        keyColumns: ['timestamp', 'log_name'],
    },
    {
        db: 'system',
        table: 'system_stat',
        column: 'stat_value',
        keyColumns: ['stat_name'],
    },
    {
        db: 'file',
        table: 'file_meta',
        column: 'meta_value',
        keyColumns: ['file_id', 'meta_name'],
    },
];

function repairNumberTextValuesV1() {
    const flagRow = dbs.system
        .prepare('SELECT stat_value FROM system_stat WHERE stat_name = ?;')
        .get(NUMBER_TEXT_REPAIR_FLAG);
    if (flagRow) {
        return;
    }

    let totalRepaired = 0;
    let totalDeleted = 0;
    for (const { db, table, column, keyColumns } of NUMBER_TEXT_REPAIR_TARGETS) {
        //  Drop any '<int>.0' row whose canonical '<int>' sibling already exists
        //  for the same unique-key tuple (e.g. an achievement re-recorded under
        //  '50.0' alongside the original '50' earn).
        const keyCond = keyColumns.map(c => `a."${c}" = b."${c}"`).join(' AND ');
        const deleteSql = `DELETE FROM "${table}" WHERE rowid IN (
            SELECT a.rowid FROM "${table}" a
            JOIN "${table}" b ON ${keyCond}
            WHERE a."${column}" LIKE '%.0'
              AND b."${column}" = CAST(CAST(a."${column}" AS INTEGER) AS TEXT)
              AND CAST(CAST(a."${column}" AS INTEGER) AS TEXT) || '.0' = a."${column}"
        );`;
        totalDeleted += dbs[db].prepare(deleteSql).run().changes;

        //  Round-trip guard: only rewrite when CAST(value AS INTEGER) + '.0' === value.
        //  Preserves literal strings that merely end in '.0' (e.g. '1.5', 'v2.0',
        //  FTN tosser version banners).
        const updateSql = `UPDATE "${table}" SET "${column}" = CAST(CAST("${column}" AS INTEGER) AS TEXT)
            WHERE "${column}" LIKE '%.0'
              AND CAST(CAST("${column}" AS INTEGER) AS TEXT) || '.0' = "${column}";`;
        totalRepaired += dbs[db].prepare(updateSql).run().changes;
    }

    dbs.system
        .prepare('REPLACE INTO system_stat (stat_name, stat_value) VALUES (?, ?);')
        .run(NUMBER_TEXT_REPAIR_FLAG, `${totalRepaired}/${totalDeleted}`);
}

//
//  message.sqlite3 schema versions, kept in PRAGMA user_version:
//    0: message.message_id INTEGER PRIMARY KEY (an ID could be handed out again)
//    1: message.message_id INTEGER PRIMARY KEY AUTOINCREMENT (#958)
//    2: message_fts rebuilt once, dropping stale rows left by edits (#964)
//
const MESSAGE_DB_VERSION_AUTOINCREMENT = 1;
const MESSAGE_DB_VERSION_FTS_REBUILD = 2;
const MESSAGE_DB_VERSION_LATEST = MESSAGE_DB_VERSION_FTS_REBUILD;

//  Columns in declaration order; the rebuild copies them by name.
const MESSAGE_TABLE_COLUMNS = [
    'message_id',
    'area_tag',
    'message_uuid',
    'reply_to_message_id',
    'to_user_name',
    'from_user_name',
    'subject',
    'message',
    'modified_timestamp',
    'view_count',
];

//
//  AUTOINCREMENT: a deleted message's ID is never given to a later one.
//  Last read pointers, FTN export pointers (message_area_last_scan) and
//  offline mail all mean "everything up to this ID", and plain INTEGER
//  PRIMARY KEY reuses max(rowid) once the newest message is deleted (#958).
//
function messageTableSql(tableName) {
    return `CREATE TABLE IF NOT EXISTS ${tableName} (
                message_id              INTEGER PRIMARY KEY AUTOINCREMENT,
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
            );`;
}

//
//  message_fts is an external content FTS4 table (content="message"): it keeps
//  only the index, keyed by docid = message rowid (= message_id), and reads
//  the text from whatever table is called "message". The triggers below keep
//  it in step, and are dropped with the table they are on.
//
const MESSAGE_INDEX_AND_TRIGGERS_SQL = `
            CREATE INDEX IF NOT EXISTS message_by_area_tag_index
                ON message (area_tag);

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
`;

function initMessageDatabase(db) {
    //  a new database has nothing to migrate
    const isNew = !db
        .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'message';`)
        .get();

    db.exec(`
            ${messageTableSql('message')}

            CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts4 (
                content="message",
                subject,
                message
            );

            ${MESSAGE_INDEX_AND_TRIGGERS_SQL}

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

    if (isNew) {
        db.pragma(`user_version = ${MESSAGE_DB_VERSION_LATEST}`);
        return;
    }

    //  in order: each one runs only from the version before it
    migrateMessageIdAutoincrement(db);
    migrateMessageFtsRebuild(db);
}

//  A failed or refused migration leaves startup going on the old schema, so a
//  sysop who never reads the log would not know: say it on the console too.
//  (Used for the activitypub database's migrations as well.)
function reportMessageDbFailure(fields, message) {
    if (Logger.log) {
        Logger.log.error(fields, message);
    }
    console.error(`${message}${fields.error ? ` (${fields.error})` : ''}`); //  eslint-disable-line no-console
}

function isAutoincrementTable(db, tableName) {
    const row = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?;`)
        .get(tableName);
    return !!row && /\bAUTOINCREMENT\b/i.test(row.sql);
}

//
//  The highest message ID this database has ever handed out, as far as it can
//  tell. The newest message may have been deleted before the upgrade, and its
//  ID can still be held by a last read pointer, an FTN export pointer, orphaned
//  meta or the FTS index, so all of them count: starting the sequence at the
//  surviving MAX(message_id) would give that ID out once more.
//
function highestMessageIdSeen(db) {
    const sources = [
        ['message', 'message_id'],
        ['message_meta', 'message_id'],
        ['user_message_area_last_read', 'message_id'],
        ['message_area_last_scan', 'message_id'],
        ['message_fts_docsize', 'docid'],
    ];
    const tableExists = db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?;`
    );
    let highest = 0;
    for (const [table, column] of sources) {
        if (!tableExists.get(table)) {
            continue;
        }
        //  integers only: SQLite sorts text above every integer, so one stray
        //  text value would win MAX() and hide the real highest ID
        const { id } = db
            .prepare(
                `SELECT MAX("${column}") AS id FROM "${table}" WHERE typeof("${column}") = 'integer';`
            )
            .get();
        //  a pointer is only ever written from a real message ID; anything
        //  else is ignored rather than allowed to push the sequence to its end
        if (Number.isSafeInteger(id) && id > highest) {
            highest = id;
        }
    }
    return highest;
}

//
//  One-time migration (#958): rebuild |message| with message_id INTEGER PRIMARY
//  KEY AUTOINCREMENT, which ALTER TABLE cannot add. This is SQLite's documented
//  12-step procedure (https://www.sqlite.org/lang_altertable.html#otheralter):
//  foreign keys off outside the transaction, so DROP TABLE cascades nothing
//  into message_meta; then in one transaction: create, copy, drop, rename,
//  recreate the index and FTS triggers, seed sqlite_sequence, foreign key
//  check, bump user_version. Any failure rolls the whole thing back and the
//  old table is untouched; the next start tries again.
//
//  It must not run inside a transaction someone else opened: PRAGMA
//  foreign_keys is a no-op there, and DROP TABLE would then cascade-delete
//  every message_meta row.
//
//  Every message_id (= rowid = FTS docid) is copied as is, so the external
//  content FTS index stays valid and is not rebuilt.
//
function migrateMessageIdAutoincrement(db) {
    if (db.pragma('user_version', { simple: true }) >= MESSAGE_DB_VERSION_AUTOINCREMENT) {
        return;
    }

    //  a fresh install was just created with AUTOINCREMENT: only record that
    if (isAutoincrementTable(db, 'message')) {
        db.pragma(`user_version = ${MESSAGE_DB_VERSION_AUTOINCREMENT}`);
        return;
    }

    const log = Logger.log;

    if (db.inTransaction) {
        reportMessageDbFailure(
            {},
            'Not upgrading the message table inside an open transaction, where foreign keys cannot be turned off; it is unchanged, and the upgrade will be tried again at the next start'
        );
        return;
    }

    //  for the log only: another process may add messages before we lock
    const rowCount = db.prepare('SELECT COUNT(*) AS n FROM message;').get().n;
    if (log) {
        log.info(
            { rowCount },
            'Upgrading the message table so message IDs are never reused (#958); this runs once and may take a while on a large message base'
        );
    }

    const startedAt = Date.now();
    const columns = MESSAGE_TABLE_COLUMNS.join(', ');
    const metaViolations = () => db.pragma('foreign_key_check(message_meta)').length;
    const countRows = table => db.prepare(`SELECT COUNT(*) AS n FROM ${table};`).get().n;

    let result;
    const fkWasOn = db.pragma('foreign_keys', { simple: true }) === 1;
    db.pragma('foreign_keys = OFF');
    try {
        result = db
            .transaction(() => {
                //  another process (oputil, say) may have got here first
                if (
                    db.pragma('user_version', { simple: true }) >=
                    MESSAGE_DB_VERSION_AUTOINCREMENT
                ) {
                    return null;
                }

                const violationsBefore = metaViolations();
                const messagesBefore = countRows('message');
                const metaBefore = countRows('message_meta');

                db.exec(`
                    DROP TABLE IF EXISTS message_new;
                    ${messageTableSql('message_new')}
                    INSERT INTO message_new (${columns})
                        SELECT ${columns} FROM message ORDER BY message_id;
                `);
                const copied = countRows('message_new');
                if (copied !== messagesBefore) {
                    throw new Error(
                        `Message table rebuild copied ${copied} of ${messagesBefore} rows`
                    );
                }

                const sequence = highestMessageIdSeen(db);

                //  DROP TABLE also drops the index and the four FTS triggers
                db.exec(`
                    DROP TABLE message;
                    ALTER TABLE message_new RENAME TO message;
                    ${MESSAGE_INDEX_AND_TRIGGERS_SQL}
                `);

                //  foreign_key_check cannot see rows that are gone: had foreign
                //  keys still been on, DROP TABLE would have cascaded
                const metaAfter = countRows('message_meta');
                if (metaAfter !== metaBefore) {
                    throw new Error(
                        `Message table rebuild lost ${
                            metaBefore - metaAfter
                        } of ${metaBefore} message_meta rows`
                    );
                }

                //  RENAME carries the sqlite_sequence row along; it holds
                //  MAX(message_id) from the copy, or is missing if there was
                //  nothing to copy
                const seeded = db
                    .prepare(
                        `UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'message';`
                    )
                    .run(sequence).changes;
                if (!seeded) {
                    db.prepare(
                        `INSERT INTO sqlite_sequence (name, seq) VALUES ('message', ?);`
                    ).run(sequence);
                }

                const violationsAfter = metaViolations();
                if (violationsAfter > violationsBefore) {
                    throw new Error(
                        `Message table rebuild left ${
                            violationsAfter - violationsBefore
                        } message_meta rows without a message`
                    );
                }

                db.pragma(`user_version = ${MESSAGE_DB_VERSION_AUTOINCREMENT}`);
                return { rowCount: copied, sequence, metaOrphans: violationsBefore };
            })
            .immediate();
    } catch (err) {
        reportMessageDbFailure(
            { error: err.message, rowCount },
            'Upgrading the message table failed; it is unchanged, and the upgrade will be tried again at the next start'
        );
        return;
    } finally {
        if (fkWasOn) {
            db.pragma('foreign_keys = ON');
        }
    }

    if (result && log) {
        log.info(
            {
                rowCount: result.rowCount,
                sequence: result.sequence,
                metaOrphans: result.metaOrphans,
                durationMs: Date.now() - startedAt,
            },
            'Upgraded the message table: message IDs are no longer reused'
        );
    }
}

//
//  One-time migration (#964): rebuild the message_fts index from the message
//  table. Message#update() used to REPLACE an edited message, which deletes
//  the row without firing message_before_delete (recursive_triggers is off),
//  so every edited ActivityPub post left a stale docid behind and the FTS4
//  index fails PRAGMA integrity_check. 'rebuild' throws the index away and
//  builds it again from the external content table.
//
//  It runs only from version 1, after the #958 rebuild: at 0 that one has not
//  run yet (or failed), and jumping past it would skip it for good. Like the
//  #958 one it will not run inside a transaction someone else opened, who
//  could still roll it back after user_version says it is done.
//
function migrateMessageFtsRebuild(db) {
    if (
        db.pragma('user_version', { simple: true }) !== MESSAGE_DB_VERSION_AUTOINCREMENT
    ) {
        return;
    }

    const log = Logger.log;

    if (db.inTransaction) {
        reportMessageDbFailure(
            {},
            'Not rebuilding the message search index inside an open transaction; it is unchanged, and the rebuild will be tried again at the next start'
        );
        return;
    }

    const rowCount = db.prepare('SELECT COUNT(*) AS n FROM message;').get().n;
    if (log) {
        log.info(
            { rowCount },
            'Rebuilding the message search index to drop entries left by edited messages (#964); this runs once and may take a while on a large message base'
        );
    }

    const startedAt = Date.now();
    let result;
    try {
        result = db
            .transaction(() => {
                //  another process (oputil, say) may have got here first
                if (
                    db.pragma('user_version', { simple: true }) !==
                    MESSAGE_DB_VERSION_AUTOINCREMENT
                ) {
                    return null;
                }

                db.exec(`INSERT INTO message_fts(message_fts) VALUES('rebuild');`);
                db.pragma(`user_version = ${MESSAGE_DB_VERSION_FTS_REBUILD}`);
                return {
                    rowCount: db.prepare('SELECT COUNT(*) AS n FROM message;').get().n,
                };
            })
            .immediate();
    } catch (err) {
        reportMessageDbFailure(
            { error: err.message, rowCount },
            'Rebuilding the message search index failed; it is unchanged, and the rebuild will be tried again at the next start'
        );
        return;
    }

    if (result && log) {
        log.info(
            { rowCount: result.rowCount, durationMs: Date.now() - startedAt },
            'Rebuilt the message search index'
        );
    }
}

//
//  activitypub.sqlite3 schema versions, kept in PRAGMA user_version:
//    1: collection_fts reads sharedInbox/outbox text from $.object (above)
//    2: the actor cache was purged once
//
const AP_DB_VERSION_ACTOR_CACHE_PURGED = 2;

//
//  One-time migration: empty the cache of remote actors (the 'actors'
//  collection). Until #964's review, a fetched actor was cached under the id
//  inside the fetched document, whatever URL it came from, so a cached
//  actor's key may have been planted by another server. Such an entry cannot
//  be told apart from a genuine one, so all of them go; Actor.fromId()
//  fetches each again when it is next needed, and the cache maintenance task
//  already drops entries by age.
//
//  Only the cache is removed. Followers and Following keep their own copy of
//  each actor, and note_reactions holds actor ids only.
//
function migrateActivityPubActorCachePurge(db) {
    if (db.pragma('user_version', { simple: true }) !== 1) {
        return;
    }

    const count = () =>
        db.prepare(`SELECT COUNT(*) AS n FROM collection WHERE name = 'actors';`).get().n;

    //  nothing cached (a new database): only record the version
    if (count() === 0) {
        db.pragma(`user_version = ${AP_DB_VERSION_ACTOR_CACHE_PURGED}`);
        return;
    }

    if (db.inTransaction) {
        reportMessageDbFailure(
            {},
            'Not purging the ActivityPub actor cache inside an open transaction; it will be tried again at the next start'
        );
        return;
    }

    const log = Logger.log;
    const rowCount = count();
    if (log) {
        log.info(
            { rowCount },
            'Purging the ActivityPub actor cache once; remote actors are fetched again when next needed'
        );
    }

    const startedAt = Date.now();
    let result;
    try {
        result = db
            .transaction(() => {
                //  another process may have got here first
                if (db.pragma('user_version', { simple: true }) !== 1) {
                    return null;
                }
                const meta = db
                    .prepare(`DELETE FROM collection_object_meta WHERE name = 'actors';`)
                    .run().changes;
                const actors = db
                    .prepare(`DELETE FROM collection WHERE name = 'actors';`)
                    .run().changes;
                db.pragma(`user_version = ${AP_DB_VERSION_ACTOR_CACHE_PURGED}`);
                return { actors, meta };
            })
            .immediate();
    } catch (err) {
        reportMessageDbFailure(
            { error: err.message, rowCount },
            'Purging the ActivityPub actor cache failed; it is unchanged, and the purge will be tried again at the next start'
        );
        return;
    }

    if (result && log) {
        log.info(
            {
                actors: result.actors,
                meta: result.meta,
                durationMs: Date.now() - startedAt,
            },
            'Purged the ActivityPub actor cache'
        );
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

            CREATE TABLE IF NOT EXISTS api_refresh_tokens (
                id              INTEGER PRIMARY KEY,
                user_id         INTEGER NOT NULL,
                token_hash      VARCHAR NOT NULL,
                issued_at       DATETIME NOT NULL,
                expires_at      DATETIME NOT NULL,
                revoked         INTEGER NOT NULL DEFAULT 0,
                UNIQUE(token_hash),
                FOREIGN KEY(user_id) REFERENCES user(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS api_refresh_tokens_user_idx
                ON api_refresh_tokens (user_id);

            CREATE TABLE IF NOT EXISTS api_keys (
                id              INTEGER PRIMARY KEY,
                user_id         INTEGER NOT NULL,
                key_hash        VARCHAR NOT NULL,
                label           VARCHAR NOT NULL DEFAULT '',
                scope           VARCHAR NOT NULL DEFAULT 'read',
                created_at      DATETIME NOT NULL,
                last_used_at    DATETIME,
                revoked         INTEGER NOT NULL DEFAULT 0,
                UNIQUE(key_hash),
                FOREIGN KEY(user_id) REFERENCES user(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS api_keys_user_idx
                ON api_keys (user_id);

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
        initMessageDatabase(dbs.message);
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

        migrateActivityPubActorCachePurge(dbs.activitypub);

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

//
//  Checkpoint the WAL of each database in |handles| ({ name: Database }),
//  truncating the -wal file to zero bytes. A checkpoint cannot finish while
//  a reader holds an older snapshot; SQLite then reports it busy and the
//  WAL simply keeps its contents until the next one. Synchronous, and short:
//  it copies only what is in the WAL.
//
//  Returns [ { database, busy, logFrames, checkpointedFrames } ]
//
function checkpointDatabases(handles) {
    return Object.entries(handles).map(([database, db]) => {
        const [row] = db.pragma('wal_checkpoint(TRUNCATE)');
        return {
            database,
            busy: 0 !== row.busy,
            logFrames: row.log,
            checkpointedFrames: row.checkpointed,
        };
    });
}

function scheduledEventCheckpointDatabases(args, cb) {
    let results;
    try {
        results = checkpointDatabases(dbs);
    } catch (err) {
        return cb(err);
    }

    const log = Logger.log;
    results.forEach(result => {
        log.info(result, 'Database WAL checkpoint');
    });

    const busy = results.filter(r => r.busy).map(r => r.database);
    if (busy.length > 0) {
        log.warn(
            { databases: busy },
            'Database WAL checkpoint could not complete (database busy); it will catch up next time'
        );
    }

    return cb(null);
}

//  A completed backup set: <paths.db>/backup/YYYYMMDD-HHmmss[-n]/
const BACKUP_SET_REGEXP = /^\d{8}-\d{6}(?:-\d+)?$/;
const BACKUP_PARTIAL_SUFFIX = '.partial';
const BACKUP_PARTIAL_REGEXP = /^\d{8}-\d{6}(?:-\d+)?\.partial$/;
const BACKUP_KEEP_DEFAULT = 3;

//
//  Back up each database in |handles| ({ name: Database }) into a new
//  timestamped directory under |dir|, then delete all but the newest |keep|
//  sets.
//
//  better-sqlite3's backup() copies a few pages at a time and yields to the
//  event loop between steps, so the BBS keeps running while it works, and
//  writes made meanwhile by this process are carried into the copy. The set
//  is written to "<stamp>.partial" and renamed once every database is in,
//  so a directory without the suffix is always complete.
//
//  Resolves to { dir: <set directory>, files: [ ... ], pruned: [ ... ] }
//
//  Only one backup runs at a time: the scheduler guards each event by name,
//  but two events can name this same action, and a second run would delete
//  the first one's .partial set out from under it.
//
let backupInProgress = false;

async function backupDatabases(handles, options) {
    if (backupInProgress) {
        throw new Error('A database backup is already running');
    }

    backupInProgress = true;
    try {
        return await runBackup(handles, options);
    } finally {
        backupInProgress = false;
    }
}

async function runBackup(handles, options) {
    const dir = options.dir;
    const keep = options.keep || BACKUP_KEEP_DEFAULT;

    await fse.ensureDir(dir);

    //  A crash mid-backup leaves its .partial set (a full copy) behind; only
    //  one backup runs at a time, so any found now is stale.
    for (const entry of await fse.readdir(dir)) {
        if (BACKUP_PARTIAL_REGEXP.test(entry)) {
            await fse.remove(paths.join(dir, entry));
        }
    }

    const stamp = moment().format('YYYYMMDD-HHmmss');
    let setName = stamp;
    for (let n = 2; await fse.pathExists(paths.join(dir, setName)); ++n) {
        setName = `${stamp}-${n}`;
    }

    const setDir = paths.join(dir, setName);
    const partialDir = setDir + BACKUP_PARTIAL_SUFFIX;
    await fse.ensureDir(partialDir);

    const files = [];
    try {
        for (const [name, db] of Object.entries(handles)) {
            const file = `${name}.sqlite3`;
            await db.backup(paths.join(partialDir, file));
            files.push(file);
        }
        await fse.rename(partialDir, setDir);
    } catch (err) {
        await fse.remove(partialDir).catch(() => {});
        throw err;
    }

    const sets = (await fse.readdir(dir))
        .filter(entry => BACKUP_SET_REGEXP.test(entry))
        .sort(); //  the names sort by time

    const pruned = sets.slice(0, Math.max(0, sets.length - keep));
    for (const entry of pruned) {
        await fse.remove(paths.join(dir, entry));
    }

    return { dir: setDir, files, pruned };
}

//
//  args[0]: how many backup sets to keep (default 3)
//
function scheduledEventBackupDatabases(args, cb) {
    const keepArg = parseInt(Array.isArray(args) ? args[0] : undefined, 10);
    const keep = keepArg > 0 ? keepArg : BACKUP_KEEP_DEFAULT;
    const dir = paths.join(conf.get().paths.db, 'backup');

    backupDatabases(dbs, { dir, keep }).then(
        result => {
            Logger.log.info(
                { dir: result.dir, files: result.files, pruned: result.pruned, keep },
                'Database backup complete'
            );
            return cb(null);
        },
        err => cb(err)
    );
}
