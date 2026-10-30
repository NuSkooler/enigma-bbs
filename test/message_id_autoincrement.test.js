'use strict';

//
//  #958: message IDs must never be reused. The message table is rebuilt once
//  with INTEGER PRIMARY KEY AUTOINCREMENT; these tests run that migration
//  against a database laid out the way every install before #958 has it.
//

const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const paths = require('path');
const Database = require('better-sqlite3');

const Logger = require('../core/logger.js');
const {
    initMessageDatabase,
    openDatabase,
    migrateMessageIdAutoincrement,
    migrateMessageFtsRebuild,
} = require('../core/database.js');

//  The message database exactly as core/database.js created it before #958.
const PRE_958_SCHEMA = `
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
`;

//  Like core/database.js openDatabase(), in memory.
function openMemoryDb() {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    return db;
}

let uuidSeq = 0;
function insertMessage(db, { id, area = 'general', subject, body }) {
    const uuid = `00000000-0000-4000-8000-${String(++uuidSeq).padStart(12, '0')}`;
    const info = db
        .prepare(
            `INSERT INTO message (message_id, area_tag, message_uuid, reply_to_message_id,
                to_user_name, from_user_name, subject, message, modified_timestamp)
            VALUES (?, ?, ?, 0, 'All', 'Tester', ?, ?, '2026-10-28T12:00:00.000-06:00');`
        )
        .run(id === undefined ? null : id, area, uuid, subject, body);
    return Number(info.lastInsertRowid);
}

function addMeta(db, messageId, name, value) {
    db.prepare(
        `INSERT INTO message_meta (message_id, meta_category, meta_name, meta_value)
        VALUES (?, 1, ?, ?);`
    ).run(messageId, name, value);
}

//  A pre-#958 board: IDs with gaps (old messages trimmed), meta on each, and a
//  caller's last read pointer.
function buildPre958Db(db = openMemoryDb()) {
    db.exec(PRE_958_SCHEMA);
    const bodies = [
        [3, 'Welcome', 'Welcome to the board, enjoy the amiga doors'],
        [7, 'FidoNet', 'binkp mailer polling the hub'],
        [8, 'Re: FidoNet', 'my binkp mailer is binkd'],
        [15, 'Amiga', 'amiga demos and trackers'],
        [42, 'Newest', 'the newest message on the board, quux'],
    ];
    for (const [id, subject, body] of bodies) {
        insertMessage(db, { id, subject, body });
        addMeta(db, id, 'ftn_msg_id', `1:2/3 ${id.toString(16)}`);
        addMeta(db, id, 'local_from_user_id', '1');
    }
    db.prepare(
        `INSERT INTO user_message_area_last_read (user_id, area_tag, message_id)
        VALUES (1, 'general', 15);`
    ).run();
    return db;
}

function snapshot(db) {
    return {
        messages: db.prepare('SELECT * FROM message ORDER BY message_id;').raw().all(),
        meta: db
            .prepare(
                'SELECT * FROM message_meta ORDER BY message_id, meta_category, meta_name, meta_value;'
            )
            .raw()
            .all(),
        lastRead: db
            .prepare('SELECT * FROM user_message_area_last_read ORDER BY user_id;')
            .raw()
            .all(),
    };
}

//  the same form core/message.js uses for a search
function ftsSearch(db, terms) {
    return db
        .prepare(
            `SELECT m.message_id FROM message m
            WHERE m.message_id IN (SELECT rowid FROM message_fts WHERE message_fts MATCH ?)
            ORDER BY m.message_id;`
        )
        .raw()
        .all(`:${terms}`)
        .map(r => r[0]);
}

function messageTableSql(db) {
    return db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='message';`)
        .get().sql;
}

//  Runs |fn| right after |db| executes the pragma |statement|, which lets a
//  test act at that exact point of the migration.
function afterPragma(db, statement, fn) {
    const pragma = db.pragma.bind(db);
    db.pragma = (source, options) => {
        const result = pragma(source, options);
        if (source === statement) {
            fn();
        }
        return result;
    };
}

function sequenceOf(db) {
    const row = db
        .prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'message';`)
        .get();
    return row ? row.seq : undefined;
}

function schemaObjectsOn(db, type) {
    return db
        .prepare(
            `SELECT name FROM sqlite_master WHERE type = ? AND tbl_name = 'message' ORDER BY name;`
        )
        .raw()
        .all(type)
        .map(r => r[0]);
}

//  What Message#update() did before #964: REPLACE deletes the row without
//  firing message_before_delete (recursive_triggers is off), so the old docid
//  stays in message_fts. Returns the new message ID.
function replaceLikeOldUpdate(db, messageId, body) {
    const { message_uuid: uuid } = db
        .prepare('SELECT message_uuid FROM message WHERE message_id = ?;')
        .get(messageId);
    const info = db
        .prepare(
            `REPLACE INTO message (area_tag, message_uuid, reply_to_message_id, to_user_name,
                from_user_name, subject, message, modified_timestamp)
            VALUES ('general', ?, 0, 'All', 'Tester', 'Edited', ?, '2026-10-28T12:00:00.000-06:00');`
        )
        .run(uuid, body);
    return Number(info.lastInsertRowid);
}

function staleFtsDocids(db) {
    return db
        .prepare(
            `SELECT docid FROM message_fts_docsize
            WHERE docid NOT IN (SELECT message_id FROM message) ORDER BY docid;`
        )
        .raw()
        .all()
        .map(r => r[0]);
}

function ftsIntegrityCheck(db) {
    db.exec(`INSERT INTO message_fts(message_fts) VALUES('integrity-check');`);
}

describe('message ID AUTOINCREMENT migration (#958)', function () {
    let savedLog;
    let logged;
    let savedConsoleError;
    let consoleErrors;

    beforeEach(function () {
        savedLog = Logger.log;
        logged = [];

        //  a failed upgrade is also said on the console
        savedConsoleError = console.error; //  eslint-disable-line no-console
        consoleErrors = [];
        console.error = msg => consoleErrors.push(msg); //  eslint-disable-line no-console

        const record = level => (obj, msg) => logged.push({ level, obj, msg });
        Logger.log = {
            info: record('info'),
            warn: record('warn'),
            error: record('error'),
            debug() {},
            trace() {},
            child() {
                return this;
            },
        };
    });

    afterEach(function () {
        Logger.log = savedLog;
        console.error = savedConsoleError; //  eslint-disable-line no-console
    });

    it('keeps every message ID, UUID, column and meta row', function () {
        const db = buildPre958Db();
        const before = snapshot(db);

        initMessageDatabase(db);

        assert.match(
            messageTableSql(db),
            /message_id\s+INTEGER PRIMARY KEY AUTOINCREMENT/
        );
        assert.deepEqual(snapshot(db), before);
        assert.equal(db.pragma('user_version', { simple: true }), 2);
        assert.equal(
            db.pragma('foreign_keys', { simple: true }),
            1,
            'foreign keys back on'
        );
        assert.deepEqual(db.pragma('foreign_key_check'), []);
        assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');

        //  the index and all four FTS triggers are back on the new table
        assert.deepEqual(schemaObjectsOn(db, 'index'), [
            'message_by_area_tag_index',
            'sqlite_autoindex_message_1',
        ]);
        assert.deepEqual(schemaObjectsOn(db, 'trigger'), [
            'message_after_insert',
            'message_after_update',
            'message_before_delete',
            'message_before_update',
        ]);

        //  and message_meta still cascades from the new table
        db.prepare('DELETE FROM message WHERE message_id = 7;').run();
        assert.equal(
            db
                .prepare('SELECT COUNT(*) AS n FROM message_meta WHERE message_id = 7;')
                .get().n,
            0
        );
    });

    it('logs the start, the end and the row count', function () {
        const db = buildPre958Db();
        initMessageDatabase(db);

        //  the first two; the #964 search index rebuild follows
        const infos = logged.filter(l => l.level === 'info');
        assert.equal(infos.length, 4);
        assert.equal(infos[0].obj.rowCount, 5);
        assert.match(infos[0].msg, /may take a while/);
        assert.equal(infos[1].obj.rowCount, 5);
        assert.equal(infos[1].obj.sequence, 42);
        assert.equal(typeof infos[1].obj.durationMs, 'number');
    });

    it('full-text search still finds every message, old and new', function () {
        const db = buildPre958Db();
        const searches = ['binkp', 'amiga', 'quux', 'binkp AND binkd'];
        const before = searches.map(s => ftsSearch(db, s));
        assert.deepEqual(before, [[7, 8], [3, 15], [42], [8]]);

        initMessageDatabase(db);

        assert.deepEqual(
            searches.map(s => ftsSearch(db, s)),
            before
        );
        //  the external content index agrees with the rebuilt table
        db.exec(`INSERT INTO message_fts(message_fts) VALUES('integrity-check');`);

        //  the recreated triggers index new, edited and deleted messages
        const id = insertMessage(db, { subject: 'Hello', body: 'xyzzy plugh' });
        assert.deepEqual(ftsSearch(db, 'xyzzy'), [id]);
        db.prepare(`UPDATE message SET message = 'frobozz' WHERE message_id = ?;`).run(
            id
        );
        assert.deepEqual(ftsSearch(db, 'xyzzy'), []);
        assert.deepEqual(ftsSearch(db, 'frobozz'), [id]);
        db.prepare('DELETE FROM message WHERE message_id = 3;').run();
        assert.deepEqual(ftsSearch(db, 'amiga'), [15]);
        db.exec(`INSERT INTO message_fts(message_fts) VALUES('integrity-check');`);
    });

    it('never hands out a deleted newest message ID again', function () {
        const db = buildPre958Db();
        initMessageDatabase(db);

        db.prepare('DELETE FROM message WHERE message_id = 42;').run();
        const id = insertMessage(db, { subject: 'After delete', body: 'fresh' });
        assert.equal(id, 43);

        db.prepare('DELETE FROM message WHERE message_id = 43;').run();
        assert.equal(insertMessage(db, { subject: 'Again', body: 'fresher' }), 44);
    });

    it('does not reuse an ID freed before the upgrade that a last read pointer still holds', function () {
        const db = buildPre958Db();
        //  the scenario from #958, before upgrading: a caller read up to the
        //  newest message, 42, and then it was deleted
        db.prepare(
            `UPDATE user_message_area_last_read SET message_id = 42 WHERE user_id = 1;`
        ).run();
        db.prepare('DELETE FROM message WHERE message_id = 42;').run();
        db.prepare(
            `INSERT INTO message_area_last_scan (scan_toss, area_tag, message_id)
            VALUES ('ftn_bso', 'general', 15);`
        ).run();

        initMessageDatabase(db);

        assert.equal(sequenceOf(db), 42);
        assert.equal(insertMessage(db, { subject: 'New', body: 'must be new' }), 43);
    });

    it('seeds the sequence from an FTN export pointer, too', function () {
        const db = buildPre958Db();
        db.prepare(
            `INSERT INTO message_area_last_scan (scan_toss, area_tag, message_id)
            VALUES ('ftn_bso', 'general', 50);`
        ).run();
        initMessageDatabase(db);
        assert.equal(sequenceOf(db), 50);
        assert.equal(insertMessage(db, { subject: 'New', body: 'body' }), 51);
    });

    it('a stray text value in a pointer column does not hide the highest ID', function () {
        const db = buildPre958Db();
        db.prepare(
            `INSERT INTO message_area_last_scan (scan_toss, area_tag, message_id)
            VALUES ('ftn_bso', 'general', 60), ('ftn_bso', 'other', 'not-an-id');`
        ).run();
        initMessageDatabase(db);
        assert.equal(sequenceOf(db), 60);
        assert.equal(insertMessage(db, { subject: 'New', body: 'body' }), 61);
    });

    it('migrates an empty message table', function () {
        const db = openMemoryDb();
        db.exec(PRE_958_SCHEMA);
        initMessageDatabase(db);
        assert.match(messageTableSql(db), /AUTOINCREMENT/);
        assert.equal(sequenceOf(db), 0);
        assert.equal(insertMessage(db, { subject: 'First', body: 'first' }), 1);
    });

    it('running it again is a no-op', function () {
        const db = buildPre958Db();
        initMessageDatabase(db);
        const sql = messageTableSql(db);
        const after = snapshot(db);
        const seq = sequenceOf(db);
        logged.length = 0;

        initMessageDatabase(db);
        initMessageDatabase(db);

        assert.equal(messageTableSql(db), sql);
        assert.deepEqual(snapshot(db), after);
        assert.equal(sequenceOf(db), seq);
        assert.equal(db.pragma('user_version', { simple: true }), 2);
        assert.deepEqual(logged, [], 'nothing logged: the migration did not run');
    });

    it('a fresh install is created with AUTOINCREMENT and needs no migration', function () {
        const db = openMemoryDb();
        initMessageDatabase(db);

        assert.match(
            messageTableSql(db),
            /message_id\s+INTEGER PRIMARY KEY AUTOINCREMENT/
        );
        assert.equal(db.pragma('user_version', { simple: true }), 2);
        assert.deepEqual(logged, []);

        const first = insertMessage(db, { subject: 'One', body: 'one' });
        const second = insertMessage(db, { subject: 'Two', body: 'two' });
        db.prepare('DELETE FROM message WHERE message_id = ?;').run(second);
        assert.equal(insertMessage(db, { subject: 'Three', body: 'three' }), second + 1);
        assert.equal(first, 1);
    });

    it('a failure rolls everything back and leaves the old table in use', function () {
        const db = openMemoryDb();
        //  a message table without view_count: the copy cannot succeed
        db.exec(PRE_958_SCHEMA.replace(/view_count\s+INTEGER NOT NULL DEFAULT 0,/, ''));
        insertMessage(db, { id: 5, subject: 'Kept', body: 'kept body' });
        addMeta(db, 5, 'ftn_msg_id', 'x');
        const sql = messageTableSql(db);
        const before = snapshot(db);

        initMessageDatabase(db);

        assert.equal(messageTableSql(db), sql);
        assert.deepEqual(snapshot(db), before);
        assert.equal(
            db.pragma('user_version', { simple: true }),
            0,
            'tried again next start'
        );
        assert.equal(
            db.pragma('foreign_keys', { simple: true }),
            1,
            'foreign keys back on'
        );
        assert.equal(
            db
                .prepare(
                    `SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'message_new';`
                )
                .get().n,
            0
        );
        assert.equal(schemaObjectsOn(db, 'trigger').length, 4);
        assert.deepEqual(ftsSearch(db, 'kept'), [5]);
        assert.ok(logged.some(l => l.level === 'error'));
        assert.equal(consoleErrors.length, 1);
        assert.match(consoleErrors[0], /Upgrading the message table failed/);
    });

    it('does not migrate inside a transaction the caller opened', function () {
        //  PRAGMA foreign_keys is a no-op inside a transaction, so DROP TABLE
        //  message would cascade-delete every message_meta row
        const db = buildPre958Db();
        const sql = messageTableSql(db);
        const before = snapshot(db);

        db.transaction(() => initMessageDatabase(db))();

        assert.deepEqual(snapshot(db), before, 'every meta row is still there');
        assert.equal(messageTableSql(db), sql);
        assert.equal(db.pragma('user_version', { simple: true }), 0);
        const errors = logged.filter(l => l.level === 'error');
        assert.equal(errors.length, 1);
        assert.match(errors[0].msg, /inside an open transaction/);
        assert.equal(consoleErrors.length, 1);
        assert.match(consoleErrors[0], /inside an open transaction/);

        //  and outside one, it goes ahead
        initMessageDatabase(db);
        assert.match(messageTableSql(db), /AUTOINCREMENT/);
        assert.deepEqual(snapshot(db), before);
    });

    it('rolls back if any message_meta row goes missing', function () {
        const db = buildPre958Db();
        const sql = messageTableSql(db);
        const before = snapshot(db);

        //  as if turning foreign keys off had not taken (as inside a
        //  caller's transaction): DROP TABLE message then cascades
        db.pragma = (pragma => (source, options) =>
            source === 'foreign_keys = OFF' ? [] : pragma(source, options))(
            db.pragma.bind(db)
        );

        initMessageDatabase(db);

        assert.deepEqual(snapshot(db), before, 'every meta row is still there');
        assert.equal(messageTableSql(db), sql);
        assert.equal(db.pragma('user_version', { simple: true }), 0);
        assert.equal(schemaObjectsOn(db, 'trigger').length, 4);
        const errors = logged.filter(l => l.level === 'error');
        assert.equal(errors.length, 1);
        assert.match(errors[0].obj.error, /lost 10 of 10 message_meta rows/);
    });

    describe('with another process writing', function () {
        let dir;
        let db;
        let other;

        beforeEach(function () {
            dir = fs.mkdtempSync(paths.join(os.tmpdir(), 'enigma-958-'));
            const file = paths.join(dir, 'message.sqlite3');
            db = buildPre958Db(openDatabase(file));
            other = openDatabase(file);
        });

        afterEach(function () {
            other.close();
            db.close();
            fs.rmSync(dir, { recursive: true, force: true });
        });

        it('copies a message posted after the count it logs, before it takes the lock', function () {
            //  foreign_keys = OFF comes after the logged count and before the
            //  transaction: post a message from the other connection there
            let postedId;
            afterPragma(db, 'foreign_keys = OFF', () => {
                postedId = insertMessage(other, {
                    subject: 'Racing',
                    body: 'posted mid upgrade',
                });
            });

            initMessageDatabase(db);

            assert.equal(postedId, 43);
            assert.match(messageTableSql(db), /AUTOINCREMENT/);
            assert.equal(db.pragma('user_version', { simple: true }), 2);
            assert.deepEqual(
                db
                    .prepare('SELECT message_id FROM message ORDER BY message_id;')
                    .raw()
                    .all()
                    .map(r => r[0]),
                [3, 7, 8, 15, 42, 43]
            );
            assert.deepEqual(ftsSearch(db, 'upgrade'), [43]);
            assert.equal(sequenceOf(db), 43);
            assert.deepEqual(
                logged.filter(l => l.level === 'error'),
                []
            );
            const infos = logged.filter(l => l.level === 'info');
            assert.equal(infos[0].obj.rowCount, 5, 'counted before the post');
            assert.equal(infos[1].obj.rowCount, 6, 'copied the post as well');
        });
    });

    describe('then the search index rebuild (#964)', function () {
        //  a pre-#958 board where message 7 was edited the old way
        function buildDamagedDb() {
            const db = buildPre958Db();
            const edited = replaceLikeOldUpdate(db, 7, 'an edited post about gopher');
            assert.equal(edited, 43);
            assert.deepEqual(staleFtsDocids(db), [7]);
            assert.throws(() => ftsIntegrityCheck(db), /malformed|corrupt/i);
            return db;
        }

        it('runs after the #958 one from version 0, and drops the stale rows', function () {
            const db = buildDamagedDb();
            //  the stale docid still matches the text the edit replaced
            assert.equal(
                db
                    .prepare(
                        `SELECT COUNT(*) AS n FROM message_fts WHERE message_fts MATCH 'hub';`
                    )
                    .get().n,
                1
            );

            initMessageDatabase(db);

            assert.match(messageTableSql(db), /AUTOINCREMENT/);
            assert.equal(db.pragma('user_version', { simple: true }), 2);
            assert.deepEqual(staleFtsDocids(db), []);
            assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
            ftsIntegrityCheck(db);
            assert.equal(
                db
                    .prepare(
                        `SELECT COUNT(*) AS n FROM message_fts WHERE message_fts MATCH 'hub';`
                    )
                    .get().n,
                0,
                'the text the edit replaced is gone from the index'
            );
            assert.deepEqual(ftsSearch(db, 'binkp'), [8]);
            assert.deepEqual(ftsSearch(db, 'gopher'), [43]);
            assert.deepEqual(ftsSearch(db, 'amiga'), [3, 15]);

            const infos = logged.filter(l => l.level === 'info');
            assert.equal(infos.length, 4);
            assert.match(infos[0].msg, /#958/);
            assert.match(infos[1].msg, /Upgraded the message table/);
            assert.match(infos[2].msg, /#964/);
            assert.equal(infos[2].obj.rowCount, 5);
            assert.match(infos[3].msg, /Rebuilt the message search index/);
            assert.equal(infos[3].obj.rowCount, 5);
            assert.equal(typeof infos[3].obj.durationMs, 'number');
            assert.deepEqual(consoleErrors, []);
        });

        it('runs from version 1 by itself', function () {
            const db = buildPre958Db();
            migrateMessageIdAutoincrement(db);
            assert.equal(db.pragma('user_version', { simple: true }), 1);
            replaceLikeOldUpdate(db, 15, 'edited amiga post, now on gopher');
            assert.deepEqual(staleFtsDocids(db), [15]);

            migrateMessageFtsRebuild(db);

            assert.equal(db.pragma('user_version', { simple: true }), 2);
            assert.deepEqual(staleFtsDocids(db), []);
            assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
            ftsIntegrityCheck(db);
        });

        it('runs once, and is skipped at version 2', function () {
            const db = buildDamagedDb();
            initMessageDatabase(db);
            logged.length = 0;

            //  damage done after the rebuild is not its business
            replaceLikeOldUpdate(db, 3, 'edited again');
            initMessageDatabase(db);
            migrateMessageFtsRebuild(db);

            assert.deepEqual(staleFtsDocids(db), [3]);
            assert.equal(db.pragma('user_version', { simple: true }), 2);
            assert.deepEqual(logged, [], 'nothing logged: neither migration ran');
        });

        it('does not run before the #958 one, so that one is not skipped', function () {
            const db = buildDamagedDb();

            migrateMessageFtsRebuild(db);

            assert.equal(db.pragma('user_version', { simple: true }), 0);
            assert.deepEqual(staleFtsDocids(db), [7]);
            assert.deepEqual(logged, []);
        });

        it('does not run inside a transaction the caller opened', function () {
            const db = buildDamagedDb();
            migrateMessageIdAutoincrement(db);
            logged.length = 0;

            db.transaction(() => migrateMessageFtsRebuild(db))();

            assert.equal(db.pragma('user_version', { simple: true }), 1);
            assert.deepEqual(staleFtsDocids(db), [7]);
            const errors = logged.filter(l => l.level === 'error');
            assert.equal(errors.length, 1);
            assert.match(errors[0].msg, /search index inside an open transaction/);
            assert.equal(consoleErrors.length, 1);
            assert.match(consoleErrors[0], /search index inside an open transaction/);

            //  and outside one, it goes ahead
            migrateMessageFtsRebuild(db);
            assert.equal(db.pragma('user_version', { simple: true }), 2);
            assert.deepEqual(staleFtsDocids(db), []);
        });

        it('a failure leaves version 1 and is said on the console', function () {
            const db = buildDamagedDb();
            migrateMessageIdAutoincrement(db);
            logged.length = 0;

            const exec = db.exec.bind(db);
            db.exec = sql => {
                if (/'rebuild'/.test(sql)) {
                    throw new Error('disk I/O error');
                }
                return exec(sql);
            };

            migrateMessageFtsRebuild(db);

            assert.equal(db.pragma('user_version', { simple: true }), 1);
            assert.deepEqual(staleFtsDocids(db), [7]);
            assert.equal(consoleErrors.length, 1);
            assert.match(
                consoleErrors[0],
                /Rebuilding the message search index failed.*disk I\/O error/
            );
        });
    });
});
