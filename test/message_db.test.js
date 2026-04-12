'use strict';

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');

//
//  Config mock — must be in place before requiring any module that captures
//  Config.get at load time.
//
const configModule = require('../core/config.js');
const TEST_CONFIG = {
    debug: { assertsEnabled: false },
    general: { boardName: 'TestBoard' },
};
configModule.get = () => TEST_CONFIG;

//
//  In-memory DB injection — must happen before requiring message.js, which
//  captures `msgDb = require('./database.js').dbs.message` at load time.
//
const dbModule = require('../core/database.js');
const _testDb = new Database(':memory:');
_testDb.pragma('foreign_keys = ON');
dbModule.dbs.message = _testDb;

//
//  Force a fresh load of message.js so it captures the in-memory DB above.
//  message.js is loaded transitively by earlier test files (via
//  stat_log.js → message.js) before we had a chance to inject dbs.message.
//
delete require.cache[require.resolve('../core/message.js')];

//  Module under test
const Message = require('../core/message.js');

// ─── schema ──────────────────────────────────────────────────────────────────

function applySchema(db, done) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS message (
            message_id              INTEGER PRIMARY KEY,
            area_tag                VARCHAR NOT NULL,
            message_uuid            VARCHAR(36) NOT NULL,
            reply_to_message_id     INTEGER,
            to_user_name            VARCHAR NOT NULL,
            from_user_name          VARCHAR NOT NULL,
            subject,
            message,
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
    return done(null);
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeMessage(overrides = {}) {
    return new Message(
        Object.assign(
            {
                areaTag: 'test_general',
                toUserName: 'TestUser',
                fromUserName: 'SenderUser',
                subject: 'Hello world',
                message: 'This is a test message body.',
            },
            overrides
        )
    );
}

// ─── persist / load round-trip ────────────────────────────────────────────────

describe('Message persist() / load() round-trip', function () {
    before(done => applySchema(_testDb, done));

    beforeEach(done => {
        _testDb.exec('DELETE FROM message;');
        done();
    });

    it('assigns messageId after persist', done => {
        const msg = makeMessage();
        msg.persist(err => {
            assert.ifError(err);
            assert.ok(msg.messageId > 0, 'messageId must be set after persist');
            done();
        });
    });

    it('assigns a messageUuid after persist', done => {
        const msg = makeMessage();
        msg.persist(err => {
            assert.ifError(err);
            assert.ok(msg.messageUuid, 'messageUuid must be set');
            assert.equal(typeof msg.messageUuid, 'string');
            done();
        });
    });

    it('load() retrieves persisted subject, to/from, areaTag', done => {
        const msg = makeMessage({
            subject: 'Round-trip subject',
            toUserName: 'Alice',
            fromUserName: 'Bob',
        });
        msg.persist(err => {
            assert.ifError(err);

            const loaded = new Message();
            loaded.load({ messageId: msg.messageId }, loadErr => {
                assert.ifError(loadErr);
                assert.equal(loaded.subject, 'Round-trip subject');
                assert.equal(loaded.toUserName, 'Alice');
                assert.equal(loaded.fromUserName, 'Bob');
                assert.equal(loaded.areaTag, 'test_general');
                done();
            });
        });
    });

    it('load() retrieves the full message body', done => {
        const body = 'A longer message body with multiple words.';
        const msg = makeMessage({ message: body });
        msg.persist(err => {
            assert.ifError(err);

            const loaded = new Message();
            loaded.load({ messageId: msg.messageId }, loadErr => {
                assert.ifError(loadErr);
                assert.equal(loaded.message, body);
                done();
            });
        });
    });

    it('rejects persist() when message body is empty/whitespace', done => {
        const msg = makeMessage({ message: '   ' });
        msg.persist(err => {
            assert.ok(err, 'expected an error for empty body');
            done();
        });
    });

    it('two messages get distinct IDs', done => {
        const a = makeMessage({ subject: 'First' });
        const b = makeMessage({ subject: 'Second' });
        a.persist(err1 => {
            assert.ifError(err1);
            b.persist(err2 => {
                assert.ifError(err2);
                assert.notEqual(a.messageId, b.messageId);
                done();
            });
        });
    });
});

// ─── meta round-trip ─────────────────────────────────────────────────────────

describe('Message meta round-trip', function () {
    before(done => applySchema(_testDb, done));

    beforeEach(done => {
        _testDb.exec('DELETE FROM message;');
        done();
    });

    it('persists and loads System meta values', done => {
        const msg = makeMessage({
            meta: { System: { local_to_user_id: 42 } },
        });
        msg.persist(err => {
            assert.ifError(err);

            const loaded = new Message();
            loaded.load({ messageId: msg.messageId }, loadErr => {
                assert.ifError(loadErr);
                assert.equal(
                    parseInt(loaded.meta.System.local_to_user_id, 10),
                    42,
                    'meta value should round-trip as a number'
                );
                done();
            });
        });
    });

    it('persistMetaValue() adds a meta entry after persist', done => {
        const msg = makeMessage();
        msg.persist(err => {
            assert.ifError(err);

            msg.persistMetaValue('System', 'local_from_user_id', 7, metaErr => {
                assert.ifError(metaErr);

                const row = _testDb
                    .prepare(
                        `SELECT meta_value FROM message_meta
                        WHERE message_id=? AND meta_category='System' AND meta_name='local_from_user_id'`
                    )
                    .get(msg.messageId);
                assert.ok(row, 'meta row should exist');
                assert.equal(parseInt(row.meta_value, 10), 7);
                done();
            });
        });
    });
});

// ─── findMessages ────────────────────────────────────────────────────────────

describe('Message.findMessages()', function () {
    before(done => applySchema(_testDb, done));

    beforeEach(done => {
        _testDb.exec('DELETE FROM message;');
        done();
    });

    it('count=0 when table is empty (excludes private area)', done => {
        Message.findMessages({ resultType: 'count' }, (err, count) => {
            assert.ifError(err);
            assert.equal(count, 0);
            done();
        });
    });

    it('count reflects inserted non-private messages', done => {
        const a = makeMessage({ areaTag: 'general', subject: 'First' });
        const b = makeMessage({ areaTag: 'general', subject: 'Second' });
        a.persist(e1 => {
            assert.ifError(e1);
            b.persist(e2 => {
                assert.ifError(e2);
                Message.findMessages(
                    { resultType: 'count', areaTag: 'general' },
                    (err, count) => {
                        assert.ifError(err);
                        assert.equal(count, 2);
                        done();
                    }
                );
            });
        });
    });

    it('filters by areaTag correctly', done => {
        const g = makeMessage({ areaTag: 'general' });
        const o = makeMessage({ areaTag: 'other' });
        g.persist(e1 => {
            assert.ifError(e1);
            o.persist(e2 => {
                assert.ifError(e2);
                Message.findMessages(
                    { resultType: 'count', areaTag: 'general' },
                    (err, count) => {
                        assert.ifError(err);
                        assert.equal(count, 1);
                        done();
                    }
                );
            });
        });
    });

    it('resultType=id returns array of message IDs', done => {
        const msg = makeMessage({ areaTag: 'general' });
        msg.persist(err => {
            assert.ifError(err);
            Message.findMessages(
                { resultType: 'id', areaTag: 'general' },
                (err2, ids) => {
                    assert.ifError(err2);
                    assert.ok(Array.isArray(ids));
                    assert.ok(ids.includes(msg.messageId));
                    done();
                }
            );
        });
    });

    it('newerThanMessageId filters correctly', done => {
        const a = makeMessage({ areaTag: 'general', subject: 'First' });
        const b = makeMessage({ areaTag: 'general', subject: 'Second' });
        a.persist(e1 => {
            assert.ifError(e1);
            b.persist(e2 => {
                assert.ifError(e2);
                Message.findMessages(
                    {
                        resultType: 'id',
                        areaTag: 'general',
                        newerThanMessageId: a.messageId,
                    },
                    (err, ids) => {
                        assert.ifError(err);
                        assert.ok(
                            ids.includes(b.messageId),
                            'should include second message'
                        );
                        assert.ok(
                            !ids.includes(a.messageId),
                            'should not include first message'
                        );
                        done();
                    }
                );
            });
        });
    });

    it('getMessageIdByUuid returns correct ID', done => {
        const msg = makeMessage({ areaTag: 'general' });
        msg.persist(err => {
            assert.ifError(err);
            Message.getMessageIdByUuid(msg.messageUuid, (err2, id) => {
                assert.ifError(err2);
                assert.equal(id, msg.messageId);
                done();
            });
        });
    });
});
