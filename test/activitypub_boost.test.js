'use strict';

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');

//
//  Config mock — must be in place before any transitive require touches Config.
//
const configModule = require('../core/config.js');
const TEST_CONFIG = {
    debug: { assertsEnabled: false },
    general: { boardName: 'TestBoard' },
    contentServers: {
        web: {
            domain: 'test.example.com',
            https: { enabled: true, port: 443 },
        },
    },
};
configModule.get = () => TEST_CONFIG;

//
//  Logger stub — prevents crashes when modules capture Log.log at load time.
//
const LogModule = require('../core/logger.js');
LogModule.log = {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    trace: () => {},
};

//
//  In-memory message DB — injected before requiring message.js.
//
const dbModule = require('../core/database.js');
const _msgDb = new Database(':memory:');
_msgDb.pragma('foreign_keys = ON');
dbModule.dbs.message = _msgDb;

delete require.cache[require.resolve('../core/message.js')];
const Message = require('../core/message.js');

//
//  In-memory activitypub DB — injected before requiring collection.js / boost_util.js.
//
const _apDb = new Database(':memory:');
_apDb.pragma('foreign_keys = ON');
dbModule.dbs.activitypub = _apDb;

//  Force a fresh load of web_util.js and endpoint.js so their module-level
//  `Config = require('./config').get` captures our mock rather than whatever
//  a previously-loaded test file left behind.
delete require.cache[require.resolve('../core/web_util.js')];
delete require.cache[require.resolve('../core/activitypub/endpoint.js')];
delete require.cache[require.resolve('../core/activitypub/object.js')];
delete require.cache[require.resolve('../core/activitypub/activity.js')];
delete require.cache[require.resolve('../core/activitypub/collection.js')];
delete require.cache[require.resolve('../core/activitypub/boost_util.js')];
const {
    fetchAnnouncedNote,
    recordInboundLike,
    sendBoost,
    sendLike,
    getBoostCount,
    getLikeCount,
    messageForNoteId,
} = require('../core/activitypub/boost_util.js');
const Collection = require('../core/activitypub/collection.js');
const Activity = require('../core/activitypub/activity.js');
const UserProps = require('../core/user_property.js');

// ─── config restore ───────────────────────────────────────────────────────────
//
//  Mocha loads all test files before executing any suite. Other test files may
//  overwrite configModule.get between load time and test execution. Re-apply
//  our config in a root-level before hook so it is active for all suites here.
//
before(() => {
    configModule.get = () => TEST_CONFIG;
});

// ─── schema ───────────────────────────────────────────────────────────────────

function applyMessageSchema(db) {
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
            scan_toss   VARCHAR NOT NULL,
            area_tag    VARCHAR NOT NULL,
            message_id  INTEGER NOT NULL,
            UNIQUE(scan_toss, area_tag)
        );

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
    `);
}

function applyApSchema(db) {
    db.exec(`
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

        CREATE INDEX IF NOT EXISTS collection_entry_by_object_id_index0
            ON collection (object_id);

        CREATE TABLE IF NOT EXISTS collection_object_meta (
            collection_id   VARCHAR NOT NULL,
            name            VARCHAR NOT NULL,
            object_id       VARCHAR NOT NULL,
            meta_name       VARCHAR NOT NULL,
            meta_value      VARCHAR NOT NULL,
            UNIQUE(collection_id, object_id, meta_name),
            FOREIGN KEY(name, collection_id, object_id)
                REFERENCES collection(name, collection_id, object_id)
                ON DELETE CASCADE
        );

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
    `);
}

before(() => {
    applyMessageSchema(_msgDb);
    applyApSchema(_apDb);
});

beforeEach(() => {
    _msgDb.exec('DELETE FROM message_meta; DELETE FROM message;');
    _apDb.exec(
        'DELETE FROM note_reactions; DELETE FROM collection_object_meta; DELETE FROM collection;'
    );
});

// ─── Message.addMetaValue ─────────────────────────────────────────────────────

describe('Message.addMetaValue()', function () {
    function insertMessage() {
        const info = _msgDb
            .prepare(
                `INSERT INTO message
                    (area_tag, message_uuid, to_user_name, from_user_name, subject, message, modified_timestamp)
                 VALUES ('activitypub_shared', 'uuid-add-meta-1', 'All', 'alice@remote', 'Test', 'Body text here.', datetime('now'))`
            )
            .run();
        return info.lastInsertRowid;
    }

    it('inserts a meta row on an existing message', done => {
        const msgId = insertMessage();
        Message.addMetaValue(
            msgId,
            'ActivityPub',
            'activitypub_note_id',
            'https://remote.example.com/notes/1',
            err => {
                assert.ifError(err);
                const row = _msgDb
                    .prepare(
                        'SELECT meta_value FROM message_meta WHERE message_id = ? AND meta_name = ?'
                    )
                    .get(msgId, 'activitypub_note_id');
                assert.ok(row, 'meta row should exist');
                assert.equal(row.meta_value, 'https://remote.example.com/notes/1');
                done();
            }
        );
    });

    it('is idempotent — calling twice with the same args does not error', done => {
        const msgId = insertMessage();
        const val = 'https://remote.example.com/notes/2';
        Message.addMetaValue(msgId, 'ActivityPub', 'activitypub_note_id', val, err => {
            assert.ifError(err);
            Message.addMetaValue(
                msgId,
                'ActivityPub',
                'activitypub_note_id',
                val,
                err2 => {
                    assert.ifError(err2);
                    const count = _msgDb
                        .prepare(
                            'SELECT COUNT(*) AS n FROM message_meta WHERE message_id = ? AND meta_name = ?'
                        )
                        .get(msgId, 'activitypub_note_id').n;
                    assert.equal(count, 1, 'OR IGNORE should keep exactly one row');
                    done();
                }
            );
        });
    });

    it('multiple distinct meta_name values can be added to the same message', done => {
        const msgId = insertMessage();
        Message.addMetaValue(
            msgId,
            'ActivityPub',
            'activitypub_activity_id',
            'https://remote.example.com/activities/1',
            err => {
                assert.ifError(err);
                Message.addMetaValue(
                    msgId,
                    'ActivityPub',
                    'activitypub_note_id',
                    'https://remote.example.com/notes/3',
                    err2 => {
                        assert.ifError(err2);
                        const rows = _msgDb
                            .prepare(
                                'SELECT meta_name FROM message_meta WHERE message_id = ?'
                            )
                            .all(msgId);
                        assert.equal(rows.length, 2);
                        const names = rows.map(r => r.meta_name);
                        assert.ok(names.includes('activitypub_activity_id'));
                        assert.ok(names.includes('activitypub_note_id'));
                        done();
                    }
                );
            }
        );
    });

    it('does not affect meta on other messages', done => {
        const msgId1 = insertMessage();
        _msgDb
            .prepare(
                `INSERT INTO message (area_tag, message_uuid, to_user_name, from_user_name, subject, message, modified_timestamp)
             VALUES ('activitypub_shared', 'uuid-add-meta-2', 'All', 'bob@remote', 'Other', 'Other body text.', datetime('now'))`
            )
            .run();

        Message.addMetaValue(
            msgId1,
            'ActivityPub',
            'activitypub_note_id',
            'https://remote.example.com/notes/4',
            err => {
                assert.ifError(err);
                const total = _msgDb
                    .prepare('SELECT COUNT(*) AS n FROM message_meta')
                    .get().n;
                assert.equal(
                    total,
                    1,
                    'only one meta row should exist across all messages'
                );
                done();
            }
        );
    });
});

// ─── Activity.makeAnnounce ────────────────────────────────────────────────────

describe('Activity.makeAnnounce()', function () {
    const ACTOR_ID = 'https://test.example.com/_enig/ap/users/testuser';
    const NOTE_ID = 'https://mastodon.social/users/alice/statuses/12345';
    const FOLLOWERS = 'https://test.example.com/_enig/ap/users/testuser/followers';

    it('returns an Activity with type Announce', () => {
        const a = Activity.makeAnnounce(ACTOR_ID, NOTE_ID, FOLLOWERS);
        assert.equal(a.type, 'Announce');
    });

    it('has the correct actor', () => {
        const a = Activity.makeAnnounce(ACTOR_ID, NOTE_ID, FOLLOWERS);
        assert.equal(a.actor, ACTOR_ID);
    });

    it('has the correct object (Note ID)', () => {
        const a = Activity.makeAnnounce(ACTOR_ID, NOTE_ID, FOLLOWERS);
        assert.equal(a.object, NOTE_ID);
    });

    it('to contains the public collection ID', () => {
        const a = Activity.makeAnnounce(ACTOR_ID, NOTE_ID, FOLLOWERS);
        assert.ok(Array.isArray(a.to));
        assert.ok(
            a.to.includes('https://www.w3.org/ns/activitystreams#Public'),
            'to should include the public collection'
        );
    });

    it('cc contains the followers endpoint', () => {
        const a = Activity.makeAnnounce(ACTOR_ID, NOTE_ID, FOLLOWERS);
        assert.ok(Array.isArray(a.cc));
        assert.ok(a.cc.some(x => x === FOLLOWERS), 'cc should include the followers endpoint');
    });

    it('has a unique id each time', () => {
        const a1 = Activity.makeAnnounce(ACTOR_ID, NOTE_ID, FOLLOWERS);
        const a2 = Activity.makeAnnounce(ACTOR_ID, NOTE_ID, FOLLOWERS);
        assert.notEqual(a1.id, a2.id, 'each Announce should get a unique ID');
    });

    it('id is a valid https URL', () => {
        const a = Activity.makeAnnounce(ACTOR_ID, NOTE_ID, FOLLOWERS);
        assert.ok(typeof a.id === 'string');
        assert.ok(a.id.startsWith('https://'), 'id should be an https URL');
    });
});

// ─── fetchAnnouncedNote — embedded object cases (no network) ──────────────────

describe('fetchAnnouncedNote() — embedded object (no network)', function () {
    it('returns a Note when given a valid embedded Note object', done => {
        const embedded = {
            id: 'https://remote.example.com/notes/embedded1',
            type: 'Note',
            content: '<p>Hello from remote</p>',
            attributedTo: 'https://remote.example.com/users/alice',
        };

        fetchAnnouncedNote(embedded, (err, note) => {
            assert.ifError(err);
            assert.ok(note, 'should return a note');
            assert.equal(note.type, 'Note');
            assert.equal(note.id, embedded.id);
            done();
        });
    });

    it('accepts an embedded Article object', done => {
        const embedded = {
            id: 'https://remote.example.com/articles/1',
            type: 'Article',
            name: 'An Article Title',
            content: '<p>An article</p>',
            attributedTo: 'https://remote.example.com/users/alice',
        };

        fetchAnnouncedNote(embedded, (err, note) => {
            assert.ifError(err);
            assert.ok(note, 'should return a note');
            assert.equal(note.type, 'Article');
            assert.equal(note.id, embedded.id);
            done();
        });
    });

    it('errors when given an embedded object with an unsupported type', done => {
        const embedded = {
            id: 'https://remote.example.com/videos/1',
            type: 'Video',
            content: '<p>A video</p>',
        };

        fetchAnnouncedNote(embedded, err => {
            assert.ok(err, 'should error for unsupported type');
            done();
        });
    });

    it('errors when given a null embedded object', done => {
        fetchAnnouncedNote(null, err => {
            assert.ok(err, 'should error for null');
            done();
        });
    });

    it('errors when given an empty object (no type)', done => {
        fetchAnnouncedNote({}, err => {
            assert.ok(err, 'should error for object with no type');
            done();
        });
    });
});

// ─── fetchAnnouncedNote — local collection lookup ─────────────────────────────

describe('fetchAnnouncedNote() — local collection lookup (no network)', function () {
    const COLL_ID = 'https://www.w3.org/ns/activitystreams#Public';

    function seedActivity(noteId) {
        //  Mirrors how _inboxCreateNoteActivity stores a Create{Note} in sharedInbox.
        const activity = {
            id: `https://remote.example.com/activities/${Date.now()}`,
            type: 'Create',
            actor: 'https://remote.example.com/users/alice',
            object: {
                id: noteId,
                type: 'Note',
                content: '<p>Seeded content</p>',
                attributedTo: 'https://remote.example.com/users/alice',
            },
        };
        _apDb
            .prepare(
                `INSERT OR IGNORE INTO collection
                    (collection_id, name, timestamp, owner_actor_id, object_id, object_json, is_private)
                 VALUES (?, 'sharedInbox', datetime('now'), ?, ?, ?, 0)`
            )
            .run(COLL_ID, COLL_ID, activity.id, JSON.stringify(activity));
    }

    it('finds a Note that is already in the local collection (covers boost-of-local)', done => {
        const noteId = 'https://remote.example.com/notes/local-lookup-1';
        seedActivity(noteId);

        fetchAnnouncedNote(noteId, (err, note) => {
            assert.ifError(err);
            assert.ok(note, 'should return a note');
            assert.equal(note.type, 'Note');
            assert.equal(note.id, noteId);
            done();
        });
    });

    //  When the note is NOT in the local collection and no network is available,
    //  fetchAnnouncedNote will attempt an HTTP fetch which will fail.
    //  We verify it propagates the error rather than silently succeeding.
    it('errors (not silently succeeds) when note is unknown and network is unavailable', done => {
        const unknownId = 'https://192.0.2.1/notes/unreachable'; // TEST-NET, guaranteed unreachable

        fetchAnnouncedNote(unknownId, err => {
            assert.ok(err, 'should propagate fetch error for unknown note');
            done();
        });
    }).timeout(5000);
});

// ─── recordInboundLike ────────────────────────────────────────────────────────

describe('recordInboundLike()', function () {
    const ACTOR_ID = 'https://remote.example.com/users/alice';
    const NOTE_ID = 'https://local.example.com/notes/42';

    let seq = 0;
    function makeLikeActivity(overrides = {}) {
        return Object.assign(
            {
                id: `https://remote.example.com/likes/${++seq}`,
                type: 'Like',
                actor: ACTOR_ID,
                object: NOTE_ID,
            },
            overrides
        );
    }

    function getReaction(noteId, actorId) {
        return _apDb
            .prepare(
                `SELECT * FROM note_reactions
                 WHERE note_id = ? AND actor_id = ? AND reaction_type = 'Like'`
            )
            .get(noteId, actorId);
    }

    it('records a reaction row in note_reactions', done => {
        const activity = makeLikeActivity();
        recordInboundLike(activity, err => {
            assert.ifError(err);
            const row = getReaction(NOTE_ID, ACTOR_ID);
            assert.ok(row, 'note_reactions row should exist');
            assert.equal(row.reaction_type, 'Like');
            assert.equal(row.activity_id, activity.id);
            done();
        });
    });

    it('does NOT store the Like in the sharedInbox collection', done => {
        const activity = makeLikeActivity();
        recordInboundLike(activity, err => {
            assert.ifError(err);
            const row = _apDb
                .prepare(
                    `SELECT object_id FROM collection
                     WHERE name = 'sharedInbox' AND object_id = ?`
                )
                .get(activity.id);
            assert.ok(!row, 'Like should not appear in sharedInbox');
            done();
        });
    });

    it('resolves note_id from an embedded object with .id', done => {
        const embeddedObjectId = 'https://local.example.com/notes/embedded';
        const activity = makeLikeActivity({
            object: { id: embeddedObjectId, type: 'Note' },
        });
        recordInboundLike(activity, err => {
            assert.ifError(err);
            const row = getReaction(embeddedObjectId, ACTOR_ID);
            assert.ok(row, 'reaction row should use embedded object id as note_id');
            done();
        });
    });

    it('resolves actor_id from an embedded actor object with .id', done => {
        const embeddedActorId = 'https://remote.example.com/users/bob';
        const activity = makeLikeActivity({
            actor: { id: embeddedActorId, type: 'Person' },
        });
        recordInboundLike(activity, err => {
            assert.ifError(err);
            const row = getReaction(NOTE_ID, embeddedActorId);
            assert.ok(row, 'reaction row should use embedded actor id');
            done();
        });
    });

    it('is idempotent — calling twice with the same activity does not error', done => {
        const activity = makeLikeActivity();
        recordInboundLike(activity, err => {
            assert.ifError(err);
            recordInboundLike(activity, err2 => {
                assert.ifError(err2);
                const count = _apDb
                    .prepare(
                        `SELECT COUNT(*) AS n FROM note_reactions
                         WHERE note_id = ? AND actor_id = ? AND reaction_type = 'Like'`
                    )
                    .get(NOTE_ID, ACTOR_ID).n;
                assert.equal(count, 1, 'should have exactly one reaction row');
                done();
            });
        });
    });

    it('stores distinct Like reactions from different actors independently', done => {
        const a1 = makeLikeActivity({ actor: 'https://remote.example.com/users/alice' });
        const a2 = makeLikeActivity({ actor: 'https://remote.example.com/users/bob' });
        recordInboundLike(a1, err => {
            assert.ifError(err);
            recordInboundLike(a2, err2 => {
                assert.ifError(err2);
                const count = _apDb
                    .prepare(
                        `SELECT COUNT(*) AS n FROM note_reactions
                         WHERE note_id = ? AND reaction_type = 'Like'`
                    )
                    .get(NOTE_ID).n;
                assert.equal(count, 2, 'should have two distinct reaction rows');
                done();
            });
        });
    });
});

// ─── Activity.makeLike ────────────────────────────────────────────────────────

describe('Activity.makeLike()', function () {
    const ACTOR_ID = 'https://test.example.com/_enig/ap/users/testuser';
    const NOTE_ID = 'https://mastodon.social/users/alice/statuses/12345';
    const FOLLOWERS = 'https://test.example.com/_enig/ap/users/testuser/followers';

    it('returns an Activity with type Like', () => {
        const a = Activity.makeLike(ACTOR_ID, NOTE_ID, FOLLOWERS);
        assert.equal(a.type, 'Like');
    });

    it('has the correct actor', () => {
        const a = Activity.makeLike(ACTOR_ID, NOTE_ID, FOLLOWERS);
        assert.equal(a.actor, ACTOR_ID);
    });

    it('has the correct object (Note ID)', () => {
        const a = Activity.makeLike(ACTOR_ID, NOTE_ID, FOLLOWERS);
        assert.equal(a.object, NOTE_ID);
    });

    it('to contains the public collection ID', () => {
        const a = Activity.makeLike(ACTOR_ID, NOTE_ID, FOLLOWERS);
        assert.ok(Array.isArray(a.to));
        assert.ok(a.to.includes('https://www.w3.org/ns/activitystreams#Public'));
    });

    it('cc contains the followers endpoint', () => {
        const a = Activity.makeLike(ACTOR_ID, NOTE_ID, FOLLOWERS);
        assert.ok(Array.isArray(a.cc));
        assert.ok(a.cc.some(x => x === FOLLOWERS));
    });

    it('has a unique id each time', () => {
        const a1 = Activity.makeLike(ACTOR_ID, NOTE_ID, FOLLOWERS);
        const a2 = Activity.makeLike(ACTOR_ID, NOTE_ID, FOLLOWERS);
        assert.notEqual(a1.id, a2.id);
    });

    it('id is a valid https URL', () => {
        const a = Activity.makeLike(ACTOR_ID, NOTE_ID, FOLLOWERS);
        assert.ok(typeof a.id === 'string');
        assert.ok(a.id.startsWith('https://'));
    });
});

// ─── getBoostCount / getLikeCount ────────────────────────────────────────────

describe('getBoostCount() / getLikeCount()', function () {
    const NOTE_ID = 'https://remote.example.com/notes/count-test-1';

    it('getBoostCount returns 0 with no reactions', done => {
        getBoostCount(NOTE_ID, (err, n) => {
            assert.ifError(err);
            assert.equal(n, 0);
            done();
        });
    });

    it('getLikeCount returns 0 with no reactions', done => {
        getLikeCount(NOTE_ID, (err, n) => {
            assert.ifError(err);
            assert.equal(n, 0);
            done();
        });
    });

    it('getLikeCount reflects recordInboundLike', done => {
        const activity = {
            id: 'https://remote.example.com/likes/count-1',
            type: 'Like',
            actor: 'https://remote.example.com/users/counter',
            object: NOTE_ID,
        };
        recordInboundLike(activity, err => {
            assert.ifError(err);
            getLikeCount(NOTE_ID, (err2, n) => {
                assert.ifError(err2);
                assert.equal(n, 1);
                done();
            });
        });
    });

    it('getBoostCount reflects a direct addReaction(Announce)', done => {
        Collection.addReaction(
            NOTE_ID,
            'https://remote.example.com/users/booster',
            'Announce',
            'https://remote.example.com/announces/count-1',
            err => {
                assert.ifError(err);
                getBoostCount(NOTE_ID, (err2, n) => {
                    assert.ifError(err2);
                    assert.equal(n, 1);
                    done();
                });
            }
        );
    });
});

// ─── sendBoost / sendLike outbound reaction tracking ─────────────────────────
//
//  These tests verify that sendBoost and sendLike record outbound reactions in
//  note_reactions (so that getBoostCount/getLikeCount reflect local actions),
//  and that the setImmediate in the final callback breaks the synchronous chain.
//
//  Delivery to remote inboxes is skipped because the test user has no followers
//  in the DB (Collection.followers returns an empty list).
//
describe('sendBoost() outbound reaction tracking', function () {
    const NOTE_ID = 'https://remote.example.com/notes/outbound-boost-1';
    const ACTOR_ID = 'https://test.example.com/_enig/ap/users/testuser';

    const _boostUserProps = {};
    const mockUser = {
        username: 'testuser',
        getProperty: prop => {
            if (prop === UserProps.ActivityPubActorId) return ACTOR_ID;
            return _boostUserProps[prop] || null;
        },
        getPropertyAsNumber: prop => parseInt(_boostUserProps[prop] || 0) || 0,
        persistProperty: (prop, val, cb) => {
            _boostUserProps[prop] = String(val);
            if (cb) cb(null);
        },
    };

    it('records an Announce in note_reactions on success', done => {
        sendBoost(mockUser, NOTE_ID, err => {
            assert.ifError(err);
            getBoostCount(NOTE_ID, (err2, n) => {
                assert.ifError(err2);
                assert.equal(n, 1, 'boost count should be 1 after outbound sendBoost');
                done();
            });
        });
    });

    it('stores the Announce activity in the Outbox collection', done => {
        sendBoost(mockUser, NOTE_ID + '-outbox', err => {
            assert.ifError(err);
            const outboxId = `https://test.example.com/_enig/ap/users/testuser/outbox`;
            const rows = _apDb
                .prepare(
                    `SELECT object_json FROM collection
                     WHERE name = 'outbox' AND collection_id = ?`
                )
                .all(outboxId);
            assert.ok(rows.length > 0, 'Announce should be in the outbox collection');
            const activities = rows.map(r => JSON.parse(r.object_json));
            assert.ok(activities.some(a => a.type === 'Announce'));
            done();
        });
    });

    it('callback fires asynchronously (setImmediate break)', done => {
        let afterCall = false;
        sendBoost(mockUser, NOTE_ID + '-async', err => {
            assert.ifError(err);
            assert.ok(
                afterCall,
                'sendBoost callback must fire asynchronously via setImmediate'
            );
            done();
        });
        afterCall = true;
    });

    it('fails when called twice for the same note (no duplicate outbox entry)', done => {
        const n = NOTE_ID + '-dup';
        sendBoost(mockUser, n, err => {
            assert.ifError(err);
            sendBoost(mockUser, n, err2 => {
                assert.ok(err2, 'second sendBoost of same note should return an error');
                done();
            });
        });
    });
});

describe('sendLike() outbound reaction tracking', function () {
    const NOTE_ID = 'https://remote.example.com/notes/outbound-like-1';
    const ACTOR_ID = 'https://test.example.com/_enig/ap/users/testuser';

    const _likeUserProps = {};
    const mockUser = {
        username: 'testuser',
        getProperty: prop => {
            if (prop === UserProps.ActivityPubActorId) return ACTOR_ID;
            return _likeUserProps[prop] || null;
        },
        getPropertyAsNumber: prop => parseInt(_likeUserProps[prop] || 0) || 0,
        persistProperty: (prop, val, cb) => {
            _likeUserProps[prop] = String(val);
            if (cb) cb(null);
        },
    };

    it('records a Like in note_reactions on success', done => {
        sendLike(mockUser, NOTE_ID, err => {
            assert.ifError(err);
            getLikeCount(NOTE_ID, (err2, n) => {
                assert.ifError(err2);
                assert.equal(n, 1, 'like count should be 1 after outbound sendLike');
                done();
            });
        });
    });

    it('stores the Like activity in the Outbox collection', done => {
        sendLike(mockUser, NOTE_ID + '-outbox', err => {
            assert.ifError(err);
            const outboxId = `https://test.example.com/_enig/ap/users/testuser/outbox`;
            const rows = _apDb
                .prepare(
                    `SELECT object_json FROM collection
                     WHERE name = 'outbox' AND collection_id = ?`
                )
                .all(outboxId);
            assert.ok(rows.length > 0, 'Like should be in the outbox collection');
            const activities = rows.map(r => JSON.parse(r.object_json));
            assert.ok(activities.some(a => a.type === 'Like'));
            done();
        });
    });

    it('callback fires asynchronously (setImmediate break)', done => {
        let afterCall = false;
        sendLike(mockUser, NOTE_ID + '-async', err => {
            assert.ifError(err);
            assert.ok(
                afterCall,
                'sendLike callback must fire asynchronously via setImmediate'
            );
            done();
        });
        afterCall = true;
    });

    it('fails when called twice for the same note (no duplicate outbox entry)', done => {
        const n = NOTE_ID + '-dup';
        sendLike(mockUser, n, err => {
            assert.ifError(err);
            sendLike(mockUser, n, err2 => {
                assert.ok(err2, 'second sendLike of same note should return an error');
                done();
            });
        });
    });
});

// ─── messageForNoteId() ───────────────────────────────────────────────────────
//
//  Verifies that the reply helper correctly resolves a Note's AP URL to its
//  local BBS Message object, and returns null cleanly when not found.
//
describe('messageForNoteId()', function () {
    const NOTE_ID = 'https://remote.example.com/notes/reply-lookup-1';

    //  Insert a message + its activitypub_note_id meta directly so we can
    //  test the lookup without going through the full Note.toMessage() path.
    function insertMessageWithNoteId(noteId) {
        const info = _msgDb
            .prepare(
                `INSERT INTO message
                    (area_tag, message_uuid, to_user_name, from_user_name, subject, message, modified_timestamp)
                 VALUES ('activitypub_shared', ?, 'All', 'alice@remote.example.com', 'Hello', 'Body text.', datetime('now'))`
            )
            .run(require('crypto').randomUUID());
        const msgId = info.lastInsertRowid;
        _msgDb
            .prepare(
                `INSERT INTO message_meta (message_id, meta_category, meta_name, meta_value)
                 VALUES (?, 'ActivityPub', 'activitypub_note_id', ?)`
            )
            .run(msgId, noteId);
        return msgId;
    }

    it('returns a Message when the noteId is found in the local DB', done => {
        const msgId = insertMessageWithNoteId(NOTE_ID);
        messageForNoteId(NOTE_ID, (err, msg) => {
            assert.ifError(err);
            assert.ok(msg, 'should return a Message object');
            assert.equal(msg.messageId, msgId);
            assert.equal(msg.areaTag, 'activitypub_shared');
            done();
        });
    });

    it('returns null (no error) when noteId is not in the local DB', done => {
        messageForNoteId('https://remote.example.com/notes/nonexistent', (err, msg) => {
            assert.ifError(err);
            assert.equal(msg, null, 'should return null for unknown noteId');
            done();
        });
    });

    it('returns the first matching Message when multiple meta rows exist for the same noteId', done => {
        //  Insert two messages with the same note_id (degenerate but possible after a storage glitch).
        const first = insertMessageWithNoteId(NOTE_ID + '-multi');
        insertMessageWithNoteId(NOTE_ID + '-multi');
        messageForNoteId(NOTE_ID + '-multi', (err, msg) => {
            assert.ifError(err);
            assert.ok(msg, 'should return a Message');
            assert.equal(
                msg.messageId,
                first,
                'should return the first (lowest) message_id'
            );
            done();
        });
    });

    it('returned Message has the correct fromUserName', done => {
        insertMessageWithNoteId(NOTE_ID + '-from');
        messageForNoteId(NOTE_ID + '-from', (err, msg) => {
            assert.ifError(err);
            assert.ok(msg);
            assert.equal(msg.fromUserName, 'alice@remote.example.com');
            done();
        });
    });
});
