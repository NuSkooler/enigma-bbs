'use strict';

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');

//
//  Config mock
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
//  Logger stub
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
//  In-memory DBs — both message and activitypub are needed because note.js
//  transitively requires Collection (which captures apDb at load time).
//
const dbModule = require('../core/database.js');

const _msgDb = new Database(':memory:');
_msgDb.pragma('foreign_keys = ON');
dbModule.dbs.message = _msgDb;

const _apDb = new Database(':memory:');
_apDb.pragma('foreign_keys = ON');
dbModule.dbs.activitypub = _apDb;

//
//  Force fresh loads so web_util / endpoint capture our config mock,
//  and note.js sees the correct DB references.
//
delete require.cache[require.resolve('../core/web_util.js')];
delete require.cache[require.resolve('../core/activitypub/endpoint.js')];
delete require.cache[require.resolve('../core/activitypub/object.js')];
delete require.cache[require.resolve('../core/activitypub/collection.js')];
delete require.cache[require.resolve('../core/message.js')];
delete require.cache[require.resolve('../core/activitypub/note.js')];

const Message = require('../core/message.js');
const Note = require('../core/activitypub/note.js');
const Actor = require('../core/activitypub/actor.js');

// ─── schema ───────────────────────────────────────────────────────────────────

before(() => {
    _msgDb.exec(`
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
            content="message", subject, message
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

    _apDb.exec(`
        CREATE TABLE IF NOT EXISTS collection (
            collection_id   VARCHAR NOT NULL,
            name            VARCHAR NOT NULL,
            timestamp       DATETIME NOT NULL,
            owner_actor_id  VARCHAR NOT NULL,
            object_id       VARCHAR NOT NULL,
            object_json     VARCHAR NOT NULL,
            is_private      INTEGER NOT NULL,
            UNIQUE(name, collection_id, object_id)
        );
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
    `);
});

beforeEach(() => {
    _msgDb.exec('DELETE FROM message_meta; DELETE FROM message;');
    _apDb.exec('DELETE FROM collection_object_meta; DELETE FROM collection;');

    //  Stub Actor.fromId so toMessage() never touches the network or actor cache.
    //  Note.js uses Actor via module reference — monkey-patching reaches it directly.
    Actor.fromId = (id, cb) => cb(null, { id }, '@alice@remote.example.com');

    //  Stub Message.findMessages for reply-to lookup (only hit when inReplyTo set).
    Message.findMessages = (filter, cb) => cb(null, []);
});

// ─── helpers ─────────────────────────────────────────────────────────────────

const REMOTE_ACTOR_ID = 'https://remote.example.com/users/alice';
const AREA_TAG = Message.WellKnownAreaTags.ActivityPubShared;

function makeNote(overrides = {}) {
    return new Note(
        Object.assign(
            {
                id: 'https://remote.example.com/notes/1',
                type: 'Note',
                attributedTo: REMOTE_ACTOR_ID,
                content: '<p>Hello from remote</p>',
                summary: 'Test subject',
                published: '2026-04-12T12:00:00Z',
            },
            overrides
        )
    );
}

function toMessage(note, opts = {}) {
    return new Promise((resolve, reject) => {
        note.toMessage(
            Object.assign({ toUser: 'All', areaTag: AREA_TAG }, opts),
            (err, msg) => (err ? reject(err) : resolve(msg))
        );
    });
}

// ─── Note.toMessage() — UUID stability ───────────────────────────────────────

describe('Note.toMessage() — UUID stability (duplicate delivery prevention)', function () {
    it('generates the same UUID for the same public Note id', async () => {
        const id = 'https://remote.example.com/notes/stable-uuid-1';
        const msg1 = await toMessage(makeNote({ id }));
        const msg2 = await toMessage(makeNote({ id }));
        assert.equal(msg1.uuid, msg2.uuid, 'same note id must yield identical UUID');
    });

    it('generates different UUIDs for different Note ids', async () => {
        const msg1 = await toMessage(
            makeNote({ id: 'https://remote.example.com/notes/uuid-a' })
        );
        const msg2 = await toMessage(
            makeNote({ id: 'https://remote.example.com/notes/uuid-b' })
        );
        assert.notEqual(msg1.uuid, msg2.uuid);
    });

    it('private delivery to different users yields different UUIDs (same note)', async () => {
        const note = makeNote({ id: 'https://remote.example.com/notes/private-1' });
        const user1 = { userId: 1, username: 'bob', getProperty: () => null };
        const user2 = { userId: 2, username: 'carol', getProperty: () => null };

        const msg1 = await toMessage(note, {
            toUser: user1,
            areaTag: Message.WellKnownAreaTags.Private,
        });
        const msg2 = await toMessage(note, {
            toUser: user2,
            areaTag: Message.WellKnownAreaTags.Private,
        });
        assert.notEqual(
            msg1.uuid,
            msg2.uuid,
            'same note delivered to different users must have distinct UUIDs'
        );
    });

    it('private delivery to the same user always produces the same UUID', async () => {
        const note = makeNote({ id: 'https://remote.example.com/notes/private-2' });
        const user = { userId: 42, username: 'bob', getProperty: () => null };
        const opts = { toUser: user, areaTag: Message.WellKnownAreaTags.Private };

        const msg1 = await toMessage(note, opts);
        const msg2 = await toMessage(note, opts);
        assert.equal(msg1.uuid, msg2.uuid);
    });
});

// ─── Note.toMessage() — message field population ──────────────────────────────

describe('Note.toMessage() — message field population', function () {
    it('sets fromUserName from the actor subject returned by Actor.fromId', async () => {
        const msg = await toMessage(makeNote());
        assert.equal(msg.fromUserName, '@alice@remote.example.com');
    });

    it('falls back to attributedTo URL when actor subject is absent', async () => {
        Actor.fromId = (id, cb) => cb(null, { id }, null); // no subject
        const msg = await toMessage(makeNote());
        assert.equal(msg.fromUserName, REMOTE_ACTOR_ID);
    });

    it('strips HTML from content and uses it as message body', async () => {
        const msg = await toMessage(makeNote({ content: '<p>Hello <b>world</b></p>' }));
        assert.ok(msg.message.includes('Hello'));
        assert.ok(msg.message.includes('world'));
        assert.ok(!msg.message.includes('<p>'), 'HTML tags should be stripped');
        assert.ok(!msg.message.includes('<b>'), 'HTML tags should be stripped');
    });

    it('uses summary as message subject', async () => {
        const msg = await toMessage(makeNote({ summary: 'My subject line' }));
        assert.ok(msg.subject.includes('My subject line'));
    });

    it('prefixes subject with [NSFW] when Note is marked sensitive', async () => {
        const msg = await toMessage(makeNote({ sensitive: true, summary: 'Secret' }));
        assert.ok(msg.subject.startsWith('[NSFW]'), `subject: "${msg.subject}"`);
    });

    it('sets areaTag from options', async () => {
        const msg = await toMessage(makeNote(), { toUser: 'All', areaTag: AREA_TAG });
        assert.equal(msg.areaTag, AREA_TAG);
    });

    it('stores the Note id in ActivityPub meta', async () => {
        const noteId = 'https://remote.example.com/notes/meta-test';
        const msg = await toMessage(makeNote({ id: noteId }));
        assert.equal(
            msg.meta.ActivityPub[Message.ActivityPubPropertyNames.NoteId],
            noteId
        );
    });

    it('resolves inReplyTo when Message.findMessages returns a matching id', done => {
        const parentMsgId = 99;
        Message.findMessages = (filter, cb) => cb(null, [parentMsgId]);

        const note = makeNote({
            inReplyTo: 'https://remote.example.com/notes/parent',
        });

        note.toMessage({ toUser: 'All', areaTag: AREA_TAG }, (err, msg) => {
            assert.ifError(err);
            assert.equal(msg.replyToMsgId, parentMsgId);
            done();
        });
    });

    it('errors when required options are missing', done => {
        makeNote().toMessage({}, err => {
            assert.ok(err, 'should error when toUser/areaTag missing');
            done();
        });
    });

    it('stores context field in ActivityPub meta', async () => {
        const ctx = 'https://remote.example.com/notes/thread-root';
        const msg = await toMessage(makeNote({ context: ctx }));
        assert.equal(
            msg.meta.ActivityPub[Message.ActivityPubPropertyNames.Context],
            ctx
        );
    });

    it('falls back to conversation field when context is absent', async () => {
        const conv = 'https://remote.example.com/notes/conv-root';
        const msg = await toMessage(makeNote({ conversation: conv }));
        assert.equal(
            msg.meta.ActivityPub[Message.ActivityPubPropertyNames.Context],
            conv
        );
    });

    it('prefers context over conversation when both are present', async () => {
        const ctx  = 'https://remote.example.com/notes/real-context';
        const conv = 'https://remote.example.com/notes/legacy-conv';
        const msg = await toMessage(makeNote({ context: ctx, conversation: conv }));
        assert.equal(
            msg.meta.ActivityPub[Message.ActivityPubPropertyNames.Context],
            ctx
        );
    });
});

// ─── Duplicate delivery — SQLITE_CONSTRAINT dedup ────────────────────────────

describe('Note.toMessage() + Message.persist() — duplicate delivery dedup', function () {
    function persistMessage(msg) {
        return new Promise((resolve, reject) => {
            msg.persist((err, msgId) => (err ? reject(err) : resolve(msgId)));
        });
    }

    it('persists a Note-derived message successfully on first delivery', async () => {
        const msg = await toMessage(
            makeNote({ id: 'https://remote.example.com/notes/dup-1' })
        );
        const msgId = await persistMessage(msg);
        assert.ok(msgId > 0, 'should return a valid message id');
    });

    it('second persist of the same Note UUID throws SQLITE_CONSTRAINT', async () => {
        const note = makeNote({ id: 'https://remote.example.com/notes/dup-2' });

        const msg1 = await toMessage(note);
        await persistMessage(msg1);

        //  Second delivery: same note → same deterministic UUID → constraint violation
        const msg2 = await toMessage(note);
        await assert.rejects(
            () => persistMessage(msg2),
            err => {
                assert.ok(
                    err.code === 'SQLITE_CONSTRAINT' || err.message.includes('UNIQUE'),
                    `expected constraint error, got: ${err.message}`
                );
                return true;
            }
        );
    });

    it('persisting same note to two different users succeeds (distinct UUIDs)', async () => {
        const note = makeNote({ id: 'https://remote.example.com/notes/dup-3' });
        const user1 = { userId: 1, username: 'bob', getProperty: () => null };
        const user2 = { userId: 2, username: 'carol', getProperty: () => null };
        const privateTag = Message.WellKnownAreaTags.Private;

        const msg1 = await toMessage(note, { toUser: user1, areaTag: privateTag });
        const msg2 = await toMessage(note, { toUser: user2, areaTag: privateTag });

        const id1 = await persistMessage(msg1);
        const id2 = await persistMessage(msg2);

        assert.ok(id1 > 0);
        assert.ok(id2 > 0);
        assert.notEqual(id1, id2, 'two separate rows should be created');

        const count = _msgDb.prepare('SELECT COUNT(*) AS n FROM message').get().n;
        assert.equal(count, 2, 'exactly two rows in message table');
    });
});
