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

// ─── findMessages: FTS terms search ───────────────────────────────────────────
//
//  Regression guard for the SQLITE_DQS=0 bug: better-sqlite3 v12 ships SQLite
//  with double-quoted strings parsed as identifiers, so any FTS MATCH operand
//  built with double quotes ("…") fails with "no such column: …". These tests
//  exercise the live SQL through findMessages() with a `terms` filter to
//  catch a re-introduction of double-quoted MATCH operands.

describe('Message.findMessages() — FTS terms search', function () {
    before(done => applySchema(_testDb, done));

    beforeEach(done => {
        _testDb.exec('DELETE FROM message;');
        done();
    });

    it('returns ids matching a term in subject', done => {
        const msg = makeMessage({
            areaTag: 'general',
            subject: 'Doom shareware notes',
            message: 'unrelated body',
        });
        msg.persist(err => {
            assert.ifError(err);
            Message.findMessages(
                { resultType: 'id', areaTag: 'general', terms: 'doom' },
                (findErr, ids) => {
                    assert.ifError(findErr);
                    assert.ok(Array.isArray(ids));
                    assert.ok(ids.includes(msg.messageId));
                    done();
                }
            );
        });
    });

    it('returns ids matching a term in message body', done => {
        const msg = makeMessage({
            areaTag: 'general',
            subject: 'unrelated subject',
            message: 'Discussion of zmachine internals.',
        });
        msg.persist(err => {
            assert.ifError(err);
            Message.findMessages(
                { resultType: 'id', areaTag: 'general', terms: 'zmachine' },
                (findErr, ids) => {
                    assert.ifError(findErr);
                    assert.ok(ids.includes(msg.messageId));
                    done();
                }
            );
        });
    });

    it('returns empty array when no row matches (not an error)', done => {
        const msg = makeMessage({
            areaTag: 'general',
            subject: 'something',
            message: 'something',
        });
        msg.persist(err => {
            assert.ifError(err);
            Message.findMessages(
                { resultType: 'id', areaTag: 'general', terms: 'unicorn-no-such-term' },
                (findErr, ids) => {
                    assert.ifError(findErr);
                    assert.deepEqual(ids, []);
                    done();
                }
            );
        });
    });

    it('rejects DQS=0 regression: terms search must not raise SqliteError', done => {
        //  Two records both containing the term in different fields. A DQS=0
        //  regression in the MATCH clause would surface as "no such column: …"
        //  rather than returning these rows.
        const a = makeMessage({
            areaTag: 'general',
            subject: 'doom subject',
            message: 'unrelated',
        });
        const b = makeMessage({
            areaTag: 'general',
            subject: 'unrelated',
            message: 'doom in the body',
        });
        a.persist(e1 => {
            assert.ifError(e1);
            b.persist(e2 => {
                assert.ifError(e2);
                Message.findMessages(
                    { resultType: 'id', areaTag: 'general', terms: 'doom' },
                    (findErr, ids) => {
                        assert.ifError(findErr);
                        assert.ok(ids.includes(a.messageId));
                        assert.ok(ids.includes(b.messageId));
                        done();
                    }
                );
            });
        });
    });
});

//
//  Values reach SQLite as bound parameters. They used to go through
//  sanitizeString(), whose MySQL-style escaping SQLite reads as literal extra
//  characters -- so a value could not match itself.
//
//  The sharpest case is ActivityPub: a Note id is a URL, percent-encoding in
//  one is ordinary, and all three callers look a Note up in order to *update or
//  delete* it. A miss there is a delete that silently does not delete.
//
describe('Message.findMessages() — values are bound, not escaped', function () {
    before(done => applySchema(_testDb, done));

    beforeEach(done => {
        _testDb.exec('DELETE FROM message_meta; DELETE FROM message;');
        done();
    });

    //
    //  Two hazards, so two kinds of value. A '%' catches the old escaping,
    //  which mangled it; an apostrophe catches raw interpolation, which the old
    //  code handled correctly. A set with only one of them passes under the
    //  other mistake.
    //
    const NOTE_IDS = [
        ['plain', 'https://example.social/users/bob/statuses/123'],
        ['percent-encoded path', 'https://example.social/users/bob/notes/caf%C3%A9'],
        ['percent-encoded query', 'https://example.social/n?q=a%20b'],
        ['literal apostrophe', "https://example.social/users/o'brien/1"],
        ['backslash', 'https://example.social/n/a\\b'],
    ];

    NOTE_IDS.forEach(([label, noteId]) => {
        it(`finds a message by a Note id with a ${label}`, done => {
            const m = makeMessage({ areaTag: 'general' });
            m.meta = { ActivityPub: { ActivityPubNoteId: noteId } };
            m.persist(err => {
                assert.ifError(err);
                Message.findMessages(
                    {
                        resultType: 'id',
                        metaTuples: [
                            {
                                category: 'ActivityPub',
                                name: 'ActivityPubNoteId',
                                value: noteId,
                            },
                        ],
                        limit: 1,
                    },
                    (findErr, ids) => {
                        assert.ifError(findErr);
                        assert.equal(
                            ids.length,
                            1,
                            `${noteId} could not be looked up by its own id`
                        );
                        done();
                    }
                );
            });
        });
    });

    //  toUserName/fromUserName are matched with LIKE.
    [
        ['percent', '100%Kid'],
        ['apostrophe', "O'Brien"],
        ['double quote', 'The "Kid"'],
    ].forEach(([label, userName]) => {
        it(`matches a user name containing a ${label}`, done => {
            const m = makeMessage({ areaTag: 'general', toUserName: userName });
            m.persist(err => {
                assert.ifError(err);
                Message.findMessages(
                    { areaTag: 'general', toUserName: userName },
                    (findErr, ids) => {
                        assert.ifError(findErr);
                        assert.equal(ids.length, 1, userName);
                        done();
                    }
                );
            });
        });
    });

    it('does not let a value act as SQL', done => {
        const m = makeMessage({ areaTag: 'general' });
        m.persist(err => {
            assert.ifError(err);
            Message.findMessages({ areaTag: "general' OR '1'='1" }, (findErr, ids) => {
                assert.ifError(findErr);
                assert.deepEqual(ids, [], 'a quote must not end the literal');
                const rows = _testDb
                    .prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name='message'")
                    .get();
                assert.equal(rows.c, 1, 'the table must still exist');
                done();
            });
        });
    });

    it('ignores an extraField that is not a column', done => {
        //  Column names cannot be bound; this is the allow-list.
        const m = makeMessage({ areaTag: 'general' });
        m.persist(err => {
            assert.ifError(err);
            Message.findMessages(
                {
                    areaTag: 'general',
                    resultType: 'id',
                    extraFields: ['subject', '(SELECT 1) AS x'],
                },
                (findErr, ids) => {
                    assert.ifError(findErr, 'an unknown field must not reach the SELECT');
                    assert.equal(ids.length, 1);
                    done();
                }
            );
        });
    });

    it('accepts only AND or OR as the operator', done => {
        const m = makeMessage({ areaTag: 'general', toUserName: 'Bob' });
        m.persist(err => {
            assert.ifError(err);
            Message.findMessages(
                { areaTag: 'general', toUserName: 'Bob', operator: 'OR 1=1 --' },
                (findErr, ids) => {
                    assert.ifError(findErr);
                    assert.equal(ids.length, 1, 'it falls back to AND');
                    done();
                }
            );
        });
    });
});
