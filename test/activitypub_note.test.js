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
//  util holds Endpoints, which builds URLs from the config mock above
delete require.cache[require.resolve('../core/activitypub/util.js')];
delete require.cache[require.resolve('../core/activitypub/object.js')];
delete require.cache[require.resolve('../core/activitypub/collection.js')];
delete require.cache[require.resolve('../core/message.js')];
delete require.cache[require.resolve('../core/activitypub/actor.js')];
delete require.cache[require.resolve('../core/activitypub/note.js')];
delete require.cache[require.resolve('../core/activitypub/boost_util.js')];
delete require.cache[require.resolve('../core/activitypub/follow_util.js')];
delete require.cache[require.resolve('../core/scanner_tossers/activitypub.js')];
delete require.cache[
    require.resolve('../core/servers/content/web_handlers/activitypub.js')
];

const Message = require('../core/message.js');
const Note = require('../core/activitypub/note.js');
const Actor = require('../core/activitypub/actor.js');
const Collection = require('../core/activitypub/collection.js');
const ActivityPubWebHandler =
    require('../core/servers/content/web_handlers/activitypub.js').getModule;

//  the real ones; beforeEach below stubs them
const realFindMessages = Message.findMessages;
const realActorFromId = Actor.fromId;

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
        assert.equal(msg.meta.ActivityPub[Message.ActivityPubPropertyNames.Context], ctx);
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
        const ctx = 'https://remote.example.com/notes/real-context';
        const conv = 'https://remote.example.com/notes/legacy-conv';
        const msg = await toMessage(makeNote({ context: ctx, conversation: conv }));
        assert.equal(msg.meta.ActivityPub[Message.ActivityPubPropertyNames.Context], ctx);
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

// ─── Update{Note}: Note.toUpdatedMessage() + Message.update() (#964) ──────────

describe('Note.toUpdatedMessage() + Message.update() — an edited Note (#964)', function () {
    const NOTE_ID = 'https://remote.example.com/notes/edit-1';
    const CREATE_ID = 'https://remote.example.com/activities/create-1';

    function cbToPromise(fn) {
        return new Promise((resolve, reject) =>
            fn((err, result) => (err ? reject(err) : resolve(result)))
        );
    }

    function metaValues(messageId, category, name) {
        return _msgDb
            .prepare(
                `SELECT meta_value FROM message_meta
                WHERE message_id = ? AND meta_category = ? AND meta_name = ?;`
            )
            .raw()
            .all(messageId, category, name)
            .map(r => r[0]);
    }

    //  what the inbox does for Create{Note}, then Update{Note}
    async function createThenEdit() {
        const created = await toMessage(
            makeNote({ id: NOTE_ID, content: '<p>Original walrus text</p>' }),
            { activityId: CREATE_ID }
        );
        const messageId = await cbToPromise(cb => created.persist(cb));
        //  later posts, so a re-insert would get a different ID
        await cbToPromise(cb =>
            makeNote({ id: 'https://remote.example.com/notes/later' }).toMessage(
                { toUser: 'All', areaTag: AREA_TAG },
                (err, msg) => (err ? cb(err) : msg.persist(cb))
            )
        );
        //  set after import, never part of the Note
        await cbToPromise(cb =>
            created.persistMetaValue(
                Message.WellKnownMetaCategories.System,
                Message.SystemMetaNames.StateFlags0,
                '2',
                cb
            )
        );

        const edited = makeNote({ id: NOTE_ID, content: '<p>Edited zebra text</p>' });
        const updated = await cbToPromise(cb =>
            edited.toUpdatedMessage({ messageUuid: created.messageUuid }, cb)
        );
        const updatedId = await cbToPromise(cb => updated.update(cb));
        return { created, messageId, updated, updatedId };
    }

    it('keeps the message ID and replaces the text', async () => {
        const { created, messageId, updated, updatedId } = await createThenEdit();

        assert.equal(updatedId, messageId);
        assert.equal(updated.messageId, messageId);
        const rows = _msgDb
            .prepare('SELECT message_id, message FROM message WHERE message_uuid = ?;')
            .all(created.messageUuid);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].message_id, messageId);
        assert.match(rows[0].message, /Edited zebra text/);

        const fts = term =>
            _msgDb
                .prepare('SELECT docid FROM message_fts WHERE message_fts MATCH ?;')
                .raw()
                .all(term)
                .map(r => r[0]);
        assert.deepEqual(fts('zebra'), [messageId]);
        assert.deepEqual(fts('walrus'), []);
        _msgDb.exec(`INSERT INTO message_fts(message_fts) VALUES('integrity-check');`);
    });

    it('keeps the Create activity ID and meta set after import', async () => {
        const { messageId } = await createThenEdit();

        const AP = Message.WellKnownMetaCategories.ActivityPub;
        assert.deepEqual(
            metaValues(messageId, AP, Message.ActivityPubPropertyNames.ActivityId),
            [CREATE_ID]
        );
        assert.deepEqual(
            metaValues(messageId, AP, Message.ActivityPubPropertyNames.NoteId),
            [NOTE_ID]
        );
        assert.deepEqual(
            metaValues(
                messageId,
                Message.WellKnownMetaCategories.System,
                Message.SystemMetaNames.StateFlags0
            ),
            ['2']
        );
    });
});

// ─── Inbox Update / Delete: only the object's owner (#964 review) ─────────────
//
//  The signature itself is checked earlier, in _inboxPostHandler; these call
//  the handlers it dispatches to with the verified signer it passes along.

describe('ActivityPub inbox: Update and Delete only from the object owner', function () {
    const OWNER = REMOTE_ACTOR_ID;
    const OTHER = 'https://remote.example.com/users/mallory';
    const NOTE_ID = 'https://remote.example.com/notes/owned-1';
    const CREATE_ID = 'https://remote.example.com/activities/owned-create-1';
    const SHARED = 'sharedInbox';

    before(() => {
        _apDb.exec(`
            CREATE TABLE IF NOT EXISTS note_reactions (
                note_id         VARCHAR NOT NULL,
                actor_id        VARCHAR NOT NULL,
                reaction_type   VARCHAR NOT NULL,
                activity_id     VARCHAR NOT NULL,
                timestamp       DATETIME NOT NULL,
                UNIQUE(note_id, actor_id, reaction_type)
            );
        `);
    });

    beforeEach(() => {
        Message.findMessages = realFindMessages;
        _apDb.exec('DELETE FROM note_reactions;');
    });

    const signedBy = signerId => ({
        httpSigValidated: true,
        domainVerifiedOnly: false,
        signerId,
    });

    function makeHandler() {
        const handler = new ActivityPubWebHandler();
        const responses = [];
        const warnings = [];
        const respond = name => () => responses.push(name);
        handler.webServer = {
            accepted: respond('accepted'),
            accessDenied: respond('accessDenied'),
            resourceNotFound: respond('resourceNotFound'),
            badRequest: respond('badRequest'),
            notImplemented: respond('notImplemented'),
            internalServerError: respond('internalServerError'),
        };
        const noop = () => {};
        handler.log = {
            trace: noop,
            debug: noop,
            info: noop,
            warn: (obj, msg) => warnings.push({ obj, msg }),
            error: noop,
        };
        handler.sysLog = handler.log;
        return { handler, responses, warnings };
    }

    function noteJson(overrides = {}) {
        return Object.assign(
            {
                id: NOTE_ID,
                type: 'Note',
                attributedTo: OWNER,
                content: '<p>Original walrus post</p>',
                summary: 'Owned',
                published: '2026-04-12T12:00:00Z',
                to: ['https://www.w3.org/ns/activitystreams#Public'],
            },
            overrides
        );
    }

    //  what Create{Note} to the shared inbox leaves behind: the stored
    //  activity and its message
    async function storeOwnedNote() {
        const create = {
            id: CREATE_ID,
            type: 'Create',
            actor: OWNER,
            object: noteJson(),
        };
        await new Promise((resolve, reject) =>
            Collection.addSharedInboxItem(create, true, err =>
                err ? reject(err) : resolve()
            )
        );
        const msg = await toMessage(new Note(noteJson()), { activityId: CREATE_ID });
        const messageId = await new Promise((resolve, reject) =>
            msg.persist((err, id) => (err ? reject(err) : resolve(id)))
        );
        return { messageId, uuid: msg.messageUuid };
    }

    function storedMessage(uuid) {
        return _msgDb
            .prepare('SELECT message_id, message FROM message WHERE message_uuid = ?;')
            .get(uuid);
    }

    function storedCreateJson() {
        const row = _apDb
            .prepare('SELECT object_json FROM collection WHERE object_id = ?;')
            .get(CREATE_ID);
        return row && row.object_json;
    }

    function updateActivity({ actor = OWNER, object = {} } = {}) {
        return {
            id: 'https://remote.example.com/activities/update-1',
            type: 'Update',
            actor,
            object: noteJson(
                Object.assign({ content: '<p>Edited zebra post</p>' }, object)
            ),
        };
    }

    function deleteActivity({ actor = OWNER, object } = {}) {
        return {
            id: 'https://remote.example.com/activities/delete-1',
            type: 'Delete',
            actor,
            object: object || { id: NOTE_ID, type: 'Tombstone' },
        };
    }

    //  the message rewrite runs after the response; give it time to land
    async function settle(check) {
        for (let i = 0; i < 50; ++i) {
            if (check && check()) {
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 5));
        }
    }

    it('refuses an Update signed by someone other than the owner', async () => {
        const { uuid, messageId } = await storeOwnedNote();
        const before = storedCreateJson();
        const { handler, responses, warnings } = makeHandler();

        handler._inboxUpdateExistingObject(
            SHARED,
            {},
            updateActivity({ actor: OTHER }),
            signedBy(OTHER)
        );
        await settle();

        assert.deepEqual(responses, ['accessDenied']);
        assert.deepEqual(storedMessage(uuid), {
            message_id: messageId,
            message: storedMessage(uuid).message,
        });
        assert.match(storedMessage(uuid).message, /Original walrus post/);
        assert.equal(storedCreateJson(), before);
        const warning = warnings.find(w => /not from its owner/.test(w.msg));
        assert.ok(warning, 'a warning is logged');
        assert.equal(warning.obj.objectId, NOTE_ID);
        assert.deepEqual(warning.obj.ownerIds, [OWNER]);
        assert.equal(warning.obj.signerId, OTHER);
    });

    it('refuses an Update whose actor is not the signer', async () => {
        const { uuid } = await storeOwnedNote();
        const { handler, responses } = makeHandler();

        handler._inboxUpdateExistingObject(
            SHARED,
            {},
            updateActivity({ actor: OTHER }),
            signedBy(OWNER)
        );
        await settle();

        assert.deepEqual(responses, ['accessDenied']);
        assert.match(storedMessage(uuid).message, /Original walrus post/);
    });

    it('refuses an Update that hands the Note to someone else', async () => {
        const { uuid } = await storeOwnedNote();
        const before = storedCreateJson();
        const { handler, responses } = makeHandler();

        handler._inboxUpdateExistingObject(
            SHARED,
            {},
            updateActivity({ object: { attributedTo: OTHER } }),
            signedBy(OWNER)
        );
        await settle();

        assert.deepEqual(responses, ['accessDenied']);
        assert.match(storedMessage(uuid).message, /Original walrus post/);
        assert.equal(storedCreateJson(), before);
    });

    it('accepts an Update from the owner, keeping the message ID', async () => {
        const { uuid, messageId } = await storeOwnedNote();
        const { handler, responses } = makeHandler();

        handler._inboxUpdateExistingObject(SHARED, {}, updateActivity(), signedBy(OWNER));
        await settle(() => /zebra/.test(storedMessage(uuid).message));

        assert.deepEqual(responses, ['accepted']);
        const row = storedMessage(uuid);
        assert.equal(row.message_id, messageId);
        assert.match(row.message, /Edited zebra post/);
    });

    it('refuses a Delete of a Note by someone other than the owner', async () => {
        const { uuid, messageId } = await storeOwnedNote();
        const { handler, responses, warnings } = makeHandler();

        await new Promise(resolve => {
            handler.webServer.accessDenied = () =>
                resolve(responses.push('accessDenied'));
            handler.webServer.accepted = () => resolve(responses.push('accepted'));
            handler._inboxDeleteActivity(
                SHARED,
                {},
                deleteActivity({ actor: OTHER }),
                signedBy(OTHER)
            );
        });

        assert.deepEqual(responses, ['accessDenied']);
        assert.equal(storedMessage(uuid).message_id, messageId);
        assert.ok(storedCreateJson(), 'the stored Create is still there');
        const warning = warnings.find(w => /not from its owner/.test(w.msg));
        assert.ok(warning);
        assert.deepEqual(warning.obj.ownerIds, [OWNER]);
        assert.equal(warning.obj.signerId, OTHER);
    });

    it('accepts a Delete of a Note by its owner', async () => {
        const { uuid } = await storeOwnedNote();
        const { handler, responses } = makeHandler();

        await new Promise(resolve => {
            handler.webServer.accessDenied = () =>
                resolve(responses.push('accessDenied'));
            handler.webServer.accepted = () => resolve(responses.push('accepted'));
            handler._inboxDeleteActivity(SHARED, {}, deleteActivity(), signedBy(OWNER));
        });

        assert.deepEqual(responses, ['accepted']);
        assert.equal(storedMessage(uuid), undefined, 'the message is gone');
        assert.equal(storedCreateJson(), undefined, 'the stored Create is gone');
    });

    describe('the inbox dispatcher', function () {
        const { Readable } = require('stream');

        //  Runs _inboxPostHandler for |activity| signed with |keyId|, with the
        //  actor fetches and the signature check stubbed. Resolves with the
        //  handler it dispatched to and the auth it passed, or the response.
        function dispatch(activity, keyId, signatureActorId) {
            const { handler } = makeHandler();
            handler._getAssociatedActors = (objectActorId, sigKeyId, cb) =>
                cb(null, { id: objectActorId }, { id: signatureActorId });
            handler._validateActorSignature = () => true;
            return new Promise(resolve => {
                for (const name of Object.keys(handler.webServer)) {
                    handler.webServer[name] = () => resolve({ response: name });
                }
                handler._inboxUpdateExistingObject = (inboxType, resp, act, auth) =>
                    resolve({ handled: 'Update', auth });
                handler._inboxLikeActivity = () => resolve({ handled: 'Like' });
                handler._inboxFollowActivity = () => resolve({ handled: 'Follow' });
                handler._inboxAnnounceActivity = () => resolve({ handled: 'Announce' });
                handler._inboxCreateActivity = () => resolve({ handled: 'Create' });
                const req = Readable.from([Buffer.from(JSON.stringify(activity))]);
                req.headers = {};
                req.url = '/_enig/ap/sharedInbox';
                req.method = 'POST';
                handler._inboxPostHandler(req, {}, { keyId }, SHARED);
            });
        }

        const activityBy = (type, actor, object) => ({
            id: `https://remote.example.com/activities/${type.toLowerCase()}-x`,
            type,
            actor,
            object,
        });

        it('passes the signing actor on to the handler', async () => {
            const result = await dispatch(
                updateActivity({ actor: OTHER }),
                `${OTHER}#main-key`,
                OTHER
            );
            assert.equal(result.handled, 'Update');
            assert.equal(result.auth.httpSigValidated, true);
            assert.equal(result.auth.signerId, OTHER);
        });

        it('refuses an activity whose actor is not the signer', async () => {
            const result = await dispatch(
                updateActivity({ actor: OWNER }),
                `${OTHER}#main-key`,
                OTHER
            );
            assert.deepEqual(result, { response: 'accessDenied' });
        });

        it("refuses when the signing actor's id is off the keyId's host", async () => {
            const result = await dispatch(
                updateActivity({ actor: OWNER }),
                `${OWNER}#main-key`,
                'https://elsewhere.example/users/alice'
            );
            assert.deepEqual(result, { response: 'accessDenied' });
        });

        it("takes no signer off the keyId's host, even one the activity names", async () => {
            //  the actor resolved for the keyId claims an id on another host,
            //  and the activity names that id as its actor
            const elsewhere = 'https://elsewhere.example/users/alice';
            const result = await dispatch(
                Object.assign(activityBy('Like', elsewhere, NOTE_ID), {
                    id: 'https://elsewhere.example/activities/like-x',
                }),
                `${OWNER}#main-key`,
                elsewhere
            );
            assert.deepEqual(result, { response: 'accessDenied' });
        });

        for (const [type, object] of [
            ['Like', NOTE_ID],
            ['Follow', 'https://test.example.com/_enig/ap/users/bob'],
            ['Announce', NOTE_ID],
        ]) {
            it(`refuses a ${type} whose actor is not the signer`, async () => {
                const result = await dispatch(
                    activityBy(type, OWNER, object),
                    `${OTHER}#main-key`,
                    OTHER
                );
                assert.deepEqual(result, { response: 'accessDenied' });
            });

            it(`passes a ${type} signed by its actor`, async () => {
                const result = await dispatch(
                    activityBy(type, OWNER, object),
                    `${OWNER}#main-key`,
                    OWNER
                );
                assert.deepEqual(result, { handled: type });
            });
        }

        it('still passes a Create whose actor is not the signer (a forwarded reply)', async () => {
            const result = await dispatch(
                activityBy('Create', OWNER, noteJson()),
                `${OTHER}#main-key`,
                OTHER
            );
            assert.deepEqual(result, { handled: 'Create' });
        });
    });

    describe('Delete of an Actor', function () {
        const VICTIM = 'https://remote.example.com/users/victim';

        function storeActor(type = 'Person') {
            return new Promise((resolve, reject) =>
                Collection.addActor(
                    { id: VICTIM, type, inbox: `${VICTIM}/inbox` },
                    '@victim@remote.example.com',
                    err => (err ? reject(err) : resolve())
                )
            );
        }

        const actorRow = () =>
            _apDb
                .prepare(
                    'SELECT object_id FROM collection WHERE name = ? AND object_id = ?;'
                )
                .get('actors', VICTIM);

        function deleteActor(auth, actor) {
            const { handler, responses } = makeHandler();
            return new Promise(resolve => {
                handler.webServer.accessDenied = () =>
                    resolve(responses.push('accessDenied'));
                handler.webServer.accepted = () => resolve(responses.push('accepted'));
                handler._inboxDeleteActivity(
                    SHARED,
                    {},
                    deleteActivity({ actor, object: VICTIM }),
                    auth
                );
            }).then(() => responses);
        }

        it('refuses one signed by a different actor', async () => {
            await storeActor();
            assert.deepEqual(await deleteActor(signedBy(OTHER), OTHER), ['accessDenied']);
            assert.ok(actorRow(), 'the actor is still cached');
        });

        it('accepts one signed by the actor itself', async () => {
            await storeActor();
            assert.deepEqual(await deleteActor(signedBy(VICTIM), VICTIM), ['accepted']);
            assert.equal(actorRow(), undefined);
        });

        it('refuses one without a verified signature', async () => {
            //  what the domain-bound path used to accept; an actor that cannot
            //  be fetched is now checked with its origin (see below)
            await storeActor();
            const responses = await deleteActor(
                { httpSigValidated: false, domainVerifiedOnly: true, signerId: null },
                VICTIM
            );
            assert.deepEqual(responses, ['accessDenied']);
            assert.ok(actorRow());
        });
    });

    describe('other activities on existing state', function () {
        const LIKE_ID = 'https://remote.example.com/activities/like-1';

        function addLike() {
            return new Promise((resolve, reject) =>
                Collection.addReaction(NOTE_ID, OWNER, 'Like', LIKE_ID, err =>
                    err ? reject(err) : resolve()
                )
            );
        }
        const likeCount = () =>
            _apDb.prepare('SELECT COUNT(*) AS n FROM note_reactions;').get().n;

        function undoLike(signerId) {
            const { handler, responses } = makeHandler();
            handler._inboxUndoLikeActivity(
                {},
                {
                    id: 'https://remote.example.com/activities/undo-like-1',
                    type: 'Undo',
                    actor: signerId,
                    object: { id: LIKE_ID, type: 'Like', actor: OWNER, object: NOTE_ID },
                },
                signedBy(signerId)
            );
            return responses;
        }

        it("Undo{Like} cannot take back another actor's Like", async () => {
            await addLike();
            undoLike(OTHER);
            assert.equal(likeCount(), 1);
        });

        it('Undo{Like} by the actor who liked removes it', async () => {
            await addLike();
            undoLike(OWNER);
            assert.equal(likeCount(), 0);
        });

        it('Undo{Follow} is refused unless signed by the follower', () => {
            const { handler, responses } = makeHandler();
            handler._inboxUndoActivity(
                {},
                { id: OWNER },
                {
                    id: 'https://remote.example.com/activities/undo-follow-1',
                    type: 'Undo',
                    actor: OWNER,
                    object: {
                        type: 'Follow',
                        actor: OWNER,
                        object: 'https://test.example.com/_enig/ap/users/bob',
                    },
                },
                signedBy(OTHER)
            );
            assert.deepEqual(responses, ['accessDenied']);
        });

        it('Reject{Follow} is refused unless signed by the rejecting actor', () => {
            const { handler, responses } = makeHandler();
            handler._inboxRejectActivity(
                {},
                {
                    id: 'https://remote.example.com/activities/reject-1',
                    type: 'Reject',
                    actor: OWNER,
                    object: {
                        type: 'Follow',
                        actor: 'https://test.example.com/_enig/ap/users/bob',
                        object: OWNER,
                    },
                },
                signedBy(OTHER)
            );
            assert.deepEqual(responses, ['accessDenied']);
        });
    });
});

// ─── Fetched actors must be the actor at the URL fetched (#964 review) ────────
//
//  An actor is cached under the id inside the fetched document. A document
//  that names an actor it was not fetched from must be refused, or its key
//  replaces the real actor's in the cache.

describe('Actor fetch: the id must belong to the URL fetched', function () {
    const crypto = require('crypto');
    const { Readable } = require('stream');
    const HttpUtil = require('../core/http_util.js');
    const WebFinger = require('../core/webfinger.js');

    const GOOD = 'https://good.example';
    const VICTIM = `${GOOD}/users/alice`;
    const EVIL = 'https://evil.example/actor';
    const NOTE = `${GOOD}/notes/1`;
    const CREATE = `${GOOD}/activities/create-1`;

    const pem = key => key.export({ type: 'spki', format: 'pem' });
    const realKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const attackerKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

    const actorDoc = (id, publicKey, overrides = {}) =>
        Object.assign(
            {
                '@context': 'https://www.w3.org/ns/activitystreams',
                id,
                type: 'Person',
                inbox: `${id}/inbox`,
                publicKey: Object.assign(
                    {
                        id: `${id}#main-key`,
                        owner: id,
                        publicKeyPem: pem(realKey.publicKey),
                    },
                    publicKey
                ),
            },
            overrides
        );

    //  url -> { doc, responseUrl } served by the stand-in network
    let served;
    let fetched;
    let savedGetJson;
    let savedWebFinger;

    beforeEach(() => {
        Actor.fromId = realActorFromId;
        Message.findMessages = realFindMessages;
        served = new Map();
        fetched = [];

        savedGetJson = HttpUtil.getJson;
        HttpUtil.getJson = (url, opts, cb) => {
            fetched.push(url);
            //  a URL is a string on the wire, whatever it was given as
            const hit = served.get(String(url));
            if (!hit) {
                return cb(new Error(`not found: ${url}`));
            }
            if (hit.hang) {
                return; // never answers
            }
            return cb(null, JSON.parse(JSON.stringify(hit.doc)), {
                statusCode: 200,
                headers: { 'content-type': 'application/activity+json' },
                responseUrl: hit.responseUrl || url,
            });
        };

        //  WebFinger on a URL answers with that URL, from the URL's host,
        //  unless a test sets its own answer
        savedWebFinger = WebFinger.queryWebFinger;
        WebFinger.queryWebFinger = (query, cb) => {
            const answer = served.get(`webfinger:${query}`);
            if (answer) {
                return cb(null, answer.json, answer.answeredBy);
            }
            let host;
            try {
                host = new URL(query).origin;
            } catch {
                return cb(new Error(`no WebFinger for ${query}`));
            }
            return cb(
                null,
                {
                    subject: String(query),
                    links: [
                        {
                            rel: 'self',
                            type: 'application/activity+json',
                            href: String(query),
                        },
                    ],
                },
                `${host}/.well-known/webfinger?resource=${encodeURIComponent(query)}`
            );
        };
    });

    afterEach(() => {
        HttpUtil.getJson = savedGetJson;
        WebFinger.queryWebFinger = savedWebFinger;
    });

    const fromId = id =>
        new Promise(resolve => Actor.fromId(id, (err, actor) => resolve({ err, actor })));
    const fromKeyId = keyId =>
        new Promise(resolve =>
            Actor.fromKeyId(keyId, (err, actor) => resolve({ err, actor }))
        );
    const cachedJson = id => {
        const row = _apDb
            .prepare(
                `SELECT object_json FROM collection WHERE name = 'actors' AND object_id = ?;`
            )
            .get(id);
        return row && JSON.parse(row.object_json);
    };

    it('refuses a document whose id is not the URL fetched, and does not cache it', async () => {
        served.set(EVIL, {
            doc: actorDoc(VICTIM, { publicKeyPem: pem(attackerKey.publicKey) }),
        });

        const { err } = await fromId(EVIL);

        assert.ok(err, 'refused');
        assert.equal(cachedJson(VICTIM), undefined);
    });

    it('fetches and caches a genuine actor', async () => {
        const bob = `${GOOD}/users/bob`;
        served.set(bob, { doc: actorDoc(bob) });

        const { err, actor } = await fromId(bob);

        assert.ifError(err);
        assert.equal(actor.id, bob);
        assert.equal(cachedJson(bob).id, bob);
    });

    it('resolves a #main-key keyId', async () => {
        const carol = `${GOOD}/users/carol`;
        served.set(carol, { doc: actorDoc(carol) });
        const { err, actor } = await fromKeyId(`${carol}#main-key`);
        assert.ifError(err);
        assert.equal(actor.id, carol);
    });

    it('resolves a /main-key keyId', async () => {
        const dave = `${GOOD}/users/dave`;
        served.set(dave, { doc: actorDoc(dave, { id: `${dave}/main-key` }) });
        const { err, actor } = await fromKeyId(`${dave}/main-key`);
        assert.ifError(err);
        assert.equal(actor.id, dave);
    });

    it('accepts a key URL answered with its owning actor on the same host', async () => {
        const erin = `${GOOD}/users/erin`;
        const keyId = `${GOOD}/ap/key/erin`;
        served.set(keyId, { doc: actorDoc(erin, { id: keyId }) });
        served.set(erin, { doc: actorDoc(erin, { id: keyId }) });

        const { err, actor } = await fromKeyId(keyId);

        assert.ifError(err);
        assert.equal(actor.id, erin);
        assert.equal(cachedJson(erin).publicKey.id, keyId, 'cached under its own id');
        assert.ok(fetched.includes(erin), "fetched from the actor's own URL");
    });

    it('refuses a key URL pointing at an actor whose own document lists another key (T5)', async () => {
        //  any JSON served from the victim's host, naming the victim
        const keyUrl = `${GOOD}/media/attacker.json`;
        const keyId = `${keyUrl}#k`;
        served.set(keyUrl, {
            doc: actorDoc(VICTIM, {
                id: keyId,
                publicKeyPem: pem(attackerKey.publicKey),
            }),
        });
        served.set(VICTIM, { doc: actorDoc(VICTIM) });

        const { err } = await fromKeyId(keyId);

        assert.ok(err, 'refused');
        assert.ok(fetched.includes(VICTIM), "the victim's own document was asked");
        const cached = cachedJson(VICTIM);
        assert.ok(!cached || cached.publicKey.publicKeyPem === pem(realKey.publicKey));
    });

    it('refuses a key URL answered with an actor whose key is another key', async () => {
        const keyId = `${GOOD}/ap/key/frank`;
        served.set(keyId, { doc: actorDoc(`${GOOD}/users/frank`) });
        const { err } = await fromKeyId(keyId);
        assert.ok(err);
        assert.equal(cachedJson(`${GOOD}/users/frank`), undefined);
    });

    it('refuses a key URL answered with an actor on another host', async () => {
        const keyId = 'https://evil.example/ap/key/x';
        served.set(keyId, { doc: actorDoc(VICTIM, { id: keyId }) });
        const { err } = await fromKeyId(keyId);
        assert.ok(err);
        assert.equal(cachedJson(VICTIM), undefined);
    });

    it('refuses an actor fetch redirected to another host', async () => {
        const gina = `${GOOD}/users/gina`;
        served.set(gina, {
            doc: actorDoc(gina),
            responseUrl: 'https://evil.example/gina',
        });
        const { err } = await fromId(gina);
        assert.ok(err);
        assert.equal(cachedJson(gina), undefined);
    });

    it('refuses a WebFinger link from an actor URL to another host', async () => {
        const bob = `${GOOD}/users/bob`;
        served.set(`webfinger:${bob}`, {
            json: {
                subject: 'acct:bob@good.example',
                links: [{ rel: 'self', type: 'application/activity+json', href: EVIL }],
            },
            answeredBy: `${GOOD}/.well-known/webfinger?resource=${encodeURIComponent(bob)}`,
        });
        served.set(EVIL, { doc: actorDoc(EVIL) });

        const { err } = await fromId(bob);

        assert.ok(err);
        assert.ok(!fetched.includes(EVIL), 'the off-host actor is never fetched');
    });

    it("follows a handle's static WebFinger link to another host (split domain)", async () => {
        const social = 'https://social.good.example/users/hana';
        //  answered by good.example itself, with no redirect
        served.set('webfinger:@hana@good.example', {
            json: {
                subject: 'acct:hana@good.example',
                links: [{ rel: 'self', type: 'application/activity+json', href: social }],
            },
            answeredBy: `${GOOD}/.well-known/webfinger?resource=acct%3Ahana%40good.example`,
        });
        served.set(social, { doc: actorDoc(social) });

        const { err, actor } = await fromId('@hana@good.example');

        assert.ifError(err);
        assert.equal(actor.id, social);
    });

    it('follows a WebFinger link on the host the query was redirected to', async () => {
        const social = 'https://social.good.example/users/hana';
        served.set('webfinger:@hana@good.example', {
            json: {
                subject: 'acct:hana@good.example',
                links: [{ rel: 'self', type: 'application/activity+json', href: social }],
            },
            answeredBy:
                'https://social.good.example/.well-known/webfinger?resource=acct%3Ahana%40good.example',
        });
        served.set(social, { doc: actorDoc(social) });

        const { err, actor } = await fromId('@hana@good.example');

        assert.ifError(err);
        assert.equal(actor.id, social);
    });

    describe('WebFinger subjects (handles)', function () {
        const MALLORY = 'https://evil.example/users/mallory';
        const fromIdSubject = id =>
            new Promise(resolve =>
                Actor.fromId(id, (err, actor, subject) =>
                    resolve({ err, actor, subject })
                )
            );
        //  answered by the queried host
        const finger = (query, subject, href) =>
            served.set(`webfinger:${query}`, {
                json: {
                    subject,
                    links: [{ rel: 'self', type: 'application/activity+json', href }],
                },
                answeredBy: /^https:/.test(query)
                    ? `${new URL(query).origin}/.well-known/webfinger`
                    : `https://${query.replace(/^@[^@]*@/, '')}/.well-known/webfinger`,
            });
        const cachedSubject = id => {
            const row = _apDb
                .prepare(
                    `SELECT meta_value FROM collection_object_meta
                    WHERE name = 'actors' AND object_id = ? AND meta_name = 'actor_subject';`
                )
                .get(id);
            return row && row.meta_value;
        };

        function serveAlice() {
            served.set(VICTIM, {
                doc: actorDoc(VICTIM, {}, { preferredUsername: 'alice' }),
            });
            finger('@alice@good.example', 'acct:alice@good.example', VICTIM);
        }

        //  evil.example claims alice@good.example for its own actor, at
        //  every WebFinger lookup it answers
        function serveMallory() {
            served.set(MALLORY, {
                doc: actorDoc(
                    MALLORY,
                    { publicKeyPem: pem(attackerKey.publicKey) },
                    { preferredUsername: 'mallory' }
                ),
            });
            finger(MALLORY, 'acct:alice@good.example', MALLORY);
            finger('@mallory@evil.example', 'acct:alice@good.example', MALLORY);
        }

        it('does not take a subject its host does not confirm', async () => {
            serveAlice();
            serveMallory();

            const { err, subject } = await fromIdSubject(MALLORY);

            assert.ifError(err);
            assert.equal(subject, MALLORY, 'falls back to the actor id');
            assert.equal(cachedSubject(MALLORY), MALLORY);
            assert.ok(fetched.length > 0);
        });

        it('leaves the real actor with its handle', async () => {
            serveAlice();
            serveMallory();

            const alice = await fromIdSubject(VICTIM);
            assert.ifError(alice.err);
            assert.equal(alice.subject, '@alice@good.example');

            await fromIdSubject(MALLORY);

            const byHandle = await fromIdSubject('@alice@good.example');
            assert.equal(byHandle.actor.id, VICTIM);
            assert.equal(byHandle.subject, '@alice@good.example');
            assert.equal(cachedSubject(VICTIM), '@alice@good.example');
        });

        it('takes a split domain subject the handle host confirms', async () => {
            const social = 'https://social.good.example/users/hana';
            served.set(social, {
                doc: actorDoc(social, {}, { preferredUsername: 'hana' }),
            });
            //  the actor's host names the handle on the main domain, whose
            //  static WebFinger points back at the actor
            finger('@hana@social.good.example', 'acct:hana@good.example', social);
            finger('@hana@good.example', 'acct:hana@good.example', social);

            const { err, subject } = await fromIdSubject(social);

            assert.ifError(err);
            assert.equal(subject, '@hana@good.example');
            assert.equal((await fromIdSubject('@hana@good.example')).actor.id, social);
        });

        it('strips control codes from a subject, and refuses an overlong one', async () => {
            served.set(MALLORY, {
                doc: actorDoc(MALLORY, {}, { preferredUsername: 'mallory' }),
            });
            finger(
                '@mallory@evil.example',
                'acct:\u001b[2J\u001b[31mmall\u0007ory|07@evil.example',
                MALLORY
            );

            const { subject } = await fromIdSubject(MALLORY);
            assert.equal(subject, '@mallory@evil.example');

            const msg = await toMessage(
                new Note({
                    id: 'https://evil.example/notes/9',
                    type: 'Note',
                    attributedTo: MALLORY,
                    content: 'x',
                })
            );
            assert.equal(msg.fromUserName, '@mallory@evil.example');

            const long = 'a'.repeat(300);
            const loud = 'https://evil.example/users/loud';
            served.set(loud, { doc: actorDoc(loud, {}, { preferredUsername: long }) });
            finger(`@${long}@evil.example`, `acct:${long}@evil.example`, loud);
            assert.equal((await fromIdSubject(loud)).subject, loud);
        });

        it('prefers an exact id over a handle, and the latest actor confirmed for a handle', async () => {
            const add = (doc, subject) =>
                new Promise((resolve, reject) =>
                    Collection.addActor(doc, subject, err =>
                        err ? reject(err) : resolve()
                    )
                );
            const lookup = q =>
                new Promise(resolve =>
                    Collection.actor(q, (err, a) => resolve(a && a.id))
                );

            //  a row whose subject is another actor's id, stored first
            await add(actorDoc(MALLORY), VICTIM);
            await add(actorDoc(VICTIM), '@alice@good.example');
            assert.equal(await lookup(VICTIM), VICTIM);

            //  alice moved: her new actor is confirmed for the handle
            const moved = 'https://good.example/users/alice2';
            await add(actorDoc(moved), '@alice@good.example');
            assert.equal(await lookup('@alice@good.example'), moved);
            assert.equal(cachedSubject(VICTIM), VICTIM, 'the old actor gives it up');
        });
    });

    describe('delivery to followers', function () {
        const {
            collectFollowerInboxes,
            resetFollowerFailures,
        } = require('../core/activitypub/follow_util.js');
        const { migrateActivityPubActorCachePurge } = require('../core/database.js');
        const bob = { userId: 2, username: 'bob', getProperty: () => null };
        const FOLLOWERS = 'https://test.example.com/_enig/ap/users/bob/followers';

        beforeEach(() => resetFollowerFailures());

        const addFollower = id =>
            new Promise((resolve, reject) =>
                Collection.addToCollection(
                    'followers',
                    null,
                    FOLLOWERS,
                    id,
                    //  the follower row's own copy, which is not trusted
                    {
                        id,
                        type: 'Person',
                        endpoints: { sharedInbox: 'https://stale.example/inbox' },
                    },
                    false,
                    true,
                    err => (err ? reject(err) : resolve())
                )
            );
        const addCached = (id, sharedInbox) =>
            new Promise((resolve, reject) =>
                Collection.addActor(
                    actorDoc(id, {}, { endpoints: { sharedInbox } }),
                    id,
                    err => (err ? reject(err) : resolve())
                )
            );

        //  { now: inboxes given at once, late: () => inboxes found after }
        const collect = () =>
            new Promise((resolve, reject) =>
                collectFollowerInboxes(bob, (err, now, late) => {
                    if (err) {
                        return reject(err);
                    }
                    const later = [];
                    late(inbox => later.push(inbox));
                    resolve({ now: now.sort(), late: () => later.sort() });
                })
            );
        const settle = () => new Promise(resolve => setTimeout(resolve, 20));

        it('reaches a follower purged from the actor cache, and caches it again', async () => {
            const withShared = actorDoc(
                VICTIM,
                {},
                {
                    endpoints: { sharedInbox: `${GOOD}/inbox` },
                }
            );
            await addFollower(VICTIM);
            await addCached(VICTIM, `${GOOD}/inbox`);
            _apDb.pragma('user_version = 1');
            migrateActivityPubActorCachePurge(_apDb);
            assert.equal(cachedJson(VICTIM), undefined, 'purged');
            served.set(VICTIM, { doc: withShared });

            //  the fan-out a new public post uses
            const scanner = require('../core/scanner_tossers/activitypub.js').getModule;
            const lateInboxes = [];
            const fanOut = await new Promise((resolve, reject) =>
                scanner.prototype._collectFollowersSharedInboxEndpoints.call(
                    {},
                    bob,
                    (err, list, followers, late) => {
                        if (err) {
                            return reject(err);
                        }
                        late(inbox => lateInboxes.push(inbox));
                        resolve(list);
                    }
                )
            );
            await settle();

            assert.deepEqual(fanOut, [], 'nothing cached to send to at once');
            assert.deepEqual(lateInboxes, [`${GOOD}/inbox`], 'delivered once resolved');
            assert.ok(fetched.includes(VICTIM), 'fetched again');
            assert.equal(cachedJson(VICTIM).id, VICTIM, 'and cached again');
        });

        it("uses a follower's own inbox when it has no sharedInbox", async () => {
            const solo = 'https://solo.example/users/sam';
            await addFollower(solo);
            served.set(solo, { doc: actorDoc(solo) });
            const got = await collect();
            await settle();
            assert.deepEqual(got.late(), [`${solo}/inbox`]);
        });

        it('takes a cached follower from the cache, and skips one that cannot be resolved', async () => {
            await addFollower(VICTIM);
            await addFollower('https://gone.example/users/zed');
            await addCached(VICTIM, `${GOOD}/inbox`);
            const got = await collect();
            await settle();
            assert.deepEqual(got.now, [`${GOOD}/inbox`]);
            assert.deepEqual(got.late(), []);
            assert.ok(!fetched.includes(VICTIM), 'no fetch for a cached follower');
        });

        it('gives cached followers at once while the others hang', async () => {
            await addFollower(VICTIM);
            await addCached(VICTIM, `${GOOD}/inbox`);
            const slow = 'https://slow.example/users/sid';
            await addFollower(slow);
            served.set(slow, { hang: true });
            served.set(`webfinger:${slow}`, { hang: true });

            const got = await Promise.race([
                collect(),
                new Promise(resolve => setTimeout(() => resolve('TIMEOUT'), 500)),
            ]);
            assert.notEqual(got, 'TIMEOUT');
            assert.deepEqual(got.now, [`${GOOD}/inbox`]);
        });

        it('does not try a follower that failed again within the retry time', async () => {
            const dead = 'https://dead.example/users/dan';
            await addFollower(dead);
            await collect();
            await settle();
            const tries = () => fetched.filter(u => String(u) === dead).length;
            assert.equal(tries(), 1);

            await collect();
            await settle();
            assert.equal(tries(), 1, 'not fetched again');

            resetFollowerFailures();
            await collect();
            await settle();
            assert.equal(tries(), 2, 'tried again once it has expired');
        });

        it('reads a follower list longer than SQLite allows in one statement', async () => {
            const count = 33000;
            const insert = _apDb.prepare(
                `INSERT INTO collection (collection_id, name, timestamp, owner_actor_id, object_id, object_json, is_private)
                VALUES (?, ?, '2026-10-29T12:00:00Z', ?, ?, ?, 0);`
            );
            _apDb.transaction(() => {
                for (let i = 0; i < count; ++i) {
                    const id = `https://h${i}.example/users/u`;
                    insert.run(
                        FOLLOWERS,
                        'followers',
                        'owner',
                        id,
                        JSON.stringify({ id })
                    );
                    insert.run(
                        'https://www.w3.org/ns/activitystreams#PublicActors',
                        'actors',
                        'https://www.w3.org/ns/activitystreams#Public',
                        id,
                        JSON.stringify({ id, type: 'Person', inbox: `${id}/inbox` })
                    );
                }
            })();

            const got = await collect();
            assert.equal(got.now.length, count);
            assert.deepEqual(fetched, []);
        });
    });

    describe('the inbox, end to end', function () {
        const noteJson = content => ({
            id: NOTE,
            type: 'Note',
            attributedTo: VICTIM,
            content,
            published: '2026-04-12T12:00:00Z',
            to: ['https://www.w3.org/ns/activitystreams#Public'],
        });

        function signedRequest(activity, keyId, privateKey) {
            const body = Buffer.from(JSON.stringify(activity));
            const date = new Date().toUTCString();
            const digest =
                'SHA-256=' + crypto.createHash('sha256').update(body).digest('base64');
            const host = 'test.example.com';
            const path = '/_enig/ap/sharedInbox';
            const signingString = `(request-target): post ${path}\nhost: ${host}\ndate: ${date}\ndigest: ${digest}`;
            const sig = crypto
                .sign('sha256', Buffer.from(signingString), privateKey)
                .toString('base64');
            const req = Readable.from([body]);
            req.headers = {
                host,
                date,
                digest,
                authorization: `Signature keyId="${keyId}",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="${sig}"`,
            };
            req.url = path;
            req.method = 'POST';
            return req;
        }

        function post(activity, keyId, privateKey, warnings = []) {
            const handler = new ActivityPubWebHandler();
            const noop = () => {};
            handler.log = {
                trace: noop,
                debug: noop,
                info: noop,
                warn: (obj, msg) => warnings.push({ obj, msg }),
                error: noop,
            };
            handler.sysLog = handler.log;
            return new Promise(resolve => {
                const respond = name => () => resolve(name);
                handler.webServer = {
                    accepted: respond('accepted'),
                    accessDenied: respond('accessDenied'),
                    resourceNotFound: respond('resourceNotFound'),
                    badRequest: respond('badRequest'),
                    notImplemented: respond('notImplemented'),
                    internalServerError: respond('internalServerError'),
                };
                const req = signedRequest(activity, keyId, privateKey);
                const signature = handler._parseAndValidateSignature(req);
                assert.ok(signature, 'the test request parses');
                handler._inboxPostHandler(req, {}, signature, 'sharedInbox');
            });
        }

        describe('Create, through the real signer derivation', function () {
            const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
            const createOf = (actor, object, id) => ({
                id: id || `${new URL(actor).origin}/activities/c-${Math.random()}`,
                type: 'Create',
                actor,
                to: [PUBLIC],
                object,
            });
            const storedFrom = () =>
                _msgDb
                    .prepare(
                        `SELECT meta_value FROM message_meta WHERE meta_name = 'remote_from_user';`
                    )
                    .all()
                    .map(r => r.meta_value);

            beforeEach(() => {
                served.set(VICTIM, { doc: actorDoc(VICTIM) });
                served.set(EVIL, {
                    doc: actorDoc(EVIL, { publicKeyPem: pem(attackerKey.publicKey) }),
                });
            });

            it("stores the author's own Create, signed with the author's key", async () => {
                const result = await post(
                    createOf(VICTIM, noteJson('<p>by alice</p>')),
                    `${VICTIM}#main-key`,
                    realKey.privateKey
                );
                assert.equal(result, 'accepted');
                assert.deepEqual(storedFrom(), [VICTIM]);
            });

            it("refuses a Create signed with another key under the author's keyId", async () => {
                const result = await post(
                    createOf(VICTIM, noteJson('<p>forged</p>')),
                    `${VICTIM}#main-key`,
                    attackerKey.privateKey
                );
                assert.equal(result, 'accessDenied');
                assert.deepEqual(storedFrom(), []);
            });

            it("refuses another actor's Create naming the author, which the origin does not confirm", async () => {
                const result = await post(
                    createOf(VICTIM, noteJson('<p>forged</p>'), `${GOOD}/activities/c-x`),
                    `${EVIL}#main-key`,
                    attackerKey.privateKey
                );
                assert.equal(result, 'accessDenied');
                assert.ok(fetched.includes(NOTE), 'the origin was asked');
                assert.deepEqual(storedFrom(), []);
            });

            it("refuses the author's Create of a Note attributed to someone else", async () => {
                //  signer, actor and the Note's host are alice's; the author
                //  is carol, and the origin does not serve the Note
                const carols = Object.assign(noteJson('<p>as carol</p>'), {
                    attributedTo: `${GOOD}/users/carol`,
                });
                const result = await post(
                    createOf(VICTIM, carols),
                    `${VICTIM}#main-key`,
                    realKey.privateKey
                );
                assert.equal(result, 'accessDenied');
                assert.deepEqual(storedFrom(), []);
            });
        });

        it('refuses an actor whose WebFinger lookup by URL is sent to another host', async () => {
            //  evil.example's WebFinger for its actor X is redirected to
            //  good.example's answer for the victim; an attacker actor Y
            //  forwards a Note by X
            const X = 'https://evil.example/users/x';
            const Y = 'https://evil.example/users/y';
            const evilNote = 'https://evil.example/notes/1';
            served.set(VICTIM, {
                doc: actorDoc(VICTIM, {}, { preferredUsername: 'alice' }),
            });
            served.set(`webfinger:${X}`, {
                json: {
                    subject: 'acct:alice@good.example',
                    links: [
                        { rel: 'self', type: 'application/activity+json', href: VICTIM },
                    ],
                },
                answeredBy: `${GOOD}/.well-known/webfinger?resource=${encodeURIComponent(VICTIM)}`,
            });
            served.set(Y, {
                doc: actorDoc(Y, { publicKeyPem: pem(attackerKey.publicKey) }),
            });
            const xNote = {
                id: evilNote,
                type: 'Note',
                attributedTo: X,
                content: '<p>i am alice</p>',
                published: '2026-04-12T12:00:00Z',
                to: ['https://www.w3.org/ns/activitystreams#Public'],
            };
            served.set(evilNote, { doc: xNote });

            const { err, actor } = await fromId(X);
            assert.ok(err, 'no actor for X');
            assert.equal(actor, undefined);
            assert.equal(cachedJson(VICTIM), undefined, 'the victim is not cached for X');

            await post(
                {
                    id: 'https://evil.example/activities/c-1',
                    type: 'Create',
                    actor: X,
                    to: ['https://www.w3.org/ns/activitystreams#Public'],
                    object: xNote,
                },
                `${Y}#main-key`,
                attackerKey.privateKey
            );
            const names = _msgDb
                .prepare('SELECT from_user_name FROM message;')
                .all()
                .map(r => r.from_user_name);
            assert.ok(!names.includes('@alice@good.example'), 'not shown as alice');
        });

        it('refuses another actor than the one at the URL, even on its host', async () => {
            const x = `${GOOD}/users/x`;
            served.set(VICTIM, { doc: actorDoc(VICTIM) });
            served.set(`webfinger:${x}`, {
                json: {
                    subject: 'acct:alice@good.example',
                    links: [
                        { rel: 'self', type: 'application/activity+json', href: VICTIM },
                    ],
                },
                answeredBy: `${GOOD}/.well-known/webfinger?resource=${encodeURIComponent(x)}`,
            });
            const { err } = await fromId(x);
            assert.ok(err);
            assert.equal(cachedJson(VICTIM), undefined);
        });

        it('refuses a WebFinger answer for an actor URL from another host', async () => {
            const X = 'https://evil.example/users/x';
            served.set(X, { doc: actorDoc(X) });
            served.set(`webfinger:${X}`, {
                json: {
                    subject: X,
                    links: [{ rel: 'self', type: 'application/activity+json', href: X }],
                },
                answeredBy: `${GOOD}/.well-known/webfinger?resource=${encodeURIComponent(X)}`,
            });
            assert.ok((await fromId(X)).err);
            assert.ok(!fetched.includes(X), 'not fetched on that answer');
        });

        it('does not fetch a WebFinger link for an actor URL to another host', async () => {
            const X = 'https://evil.example/users/x';
            served.set(VICTIM, { doc: actorDoc(VICTIM) });
            served.set(`webfinger:${X}`, {
                json: {
                    subject: X,
                    links: [
                        { rel: 'self', type: 'application/activity+json', href: VICTIM },
                    ],
                },
                answeredBy: `https://evil.example/.well-known/webfinger?resource=${encodeURIComponent(X)}`,
            });
            assert.ok((await fromId(X)).err);
            assert.ok(!fetched.includes(VICTIM), 'the other host is not asked');
        });

        it("refuses a signature whose keyId is not the signing actor's key (M20)", async () => {
            //  the actor's document is fetched for the keyId, but lists
            //  another key id, with the key that made the signature
            const keyId = `${VICTIM}#other-key`;
            served.set(VICTIM, {
                doc: actorDoc(VICTIM, {
                    id: `${VICTIM}#main-key`,
                    publicKeyPem: pem(attackerKey.publicKey),
                }),
            });
            const result = await post(
                {
                    id: `${GOOD}/activities/like-m20`,
                    type: 'Like',
                    actor: VICTIM,
                    object: NOTE,
                },
                keyId,
                attackerKey.privateKey
            );
            assert.equal(result, 'accessDenied');
        });

        it("finds a searched profile URL's actor on the same host, not by fromId", async () => {
            const profile = `${GOOD}/@alice`;
            served.set(VICTIM, { doc: actorDoc(VICTIM) });
            served.set(`webfinger:${profile}`, {
                json: {
                    subject: 'acct:alice@good.example',
                    links: [
                        { rel: 'self', type: 'application/activity+json', href: VICTIM },
                    ],
                },
                answeredBy: `${GOOD}/.well-known/webfinger?resource=${encodeURIComponent(profile)}`,
            });
            const found = await new Promise(resolve =>
                Actor.fromSearch(profile, null, (err, actor) => resolve({ err, actor }))
            );
            assert.ifError(found.err);
            assert.equal(found.actor.id, VICTIM);
            assert.ok(
                (await fromId(profile)).err,
                'fromId takes only the actor at the URL'
            );
        });

        it('fetches a genuine actor by URL, and caches it under that URL', async () => {
            const bob = `${GOOD}/users/bob`;
            served.set(bob, { doc: actorDoc(bob) });
            const { err, actor } = await fromId(bob);
            assert.ifError(err);
            assert.equal(actor.id, bob);
            assert.equal(cachedJson(bob).id, bob);
            fetched.length = 0;
            assert.equal((await fromId(bob)).actor.id, bob);
            assert.deepEqual(fetched, [], 'from the cache');
        });

        it('answers activities of malformed shapes, without hanging or throwing', async () => {
            served.set(VICTIM, {
                doc: actorDoc(VICTIM, {}, { preferredUsername: 'alice' }),
            });
            const noteObject = {
                id: `${GOOD}/notes/fuzz`,
                type: 'Note',
                attributedTo: VICTIM,
            };
            const shapes = [
                { actor: [VICTIM] },
                { actor: {} },
                { actor: { id: VICTIM } },
                { actor: null },
                { actor: 42 },
                { object: null },
                { object: [] },
                { object: { id: {} } },
                { object: { id: 42, type: 'Note' } },
                {
                    object: {
                        id: `${GOOD}/notes/fuzz-fields`,
                        type: 'Note',
                        attributedTo: VICTIM,
                        content: 42,
                        summary: {},
                        to: ['https://www.w3.org/ns/activitystreams#Public'],
                    },
                },
            ];
            const types = ['Create', 'Update', 'Delete', 'Like', 'Announce', 'Undo'];
            const hung = [];
            for (const type of types) {
                for (const shape of shapes) {
                    const activity = Object.assign(
                        {
                            id: `${GOOD}/activities/fuzz-${Math.random()}`,
                            type,
                            actor: VICTIM,
                            object: noteObject,
                        },
                        shape
                    );
                    const result = await Promise.race([
                        post(activity, `${VICTIM}#main-key`, realKey.privateKey),
                        new Promise(resolve => setTimeout(() => resolve('TIMEOUT'), 500)),
                    ]);
                    if (result === 'TIMEOUT') {
                        hung.push(`${type} ${JSON.stringify(shape)}`);
                    }
                }
            }
            assert.deepEqual(hung, []);
        });

        for (const actor of [[VICTIM], { type: 'Person' }, 42]) {
            it(`refuses an activity whose actor is ${JSON.stringify(actor)} as malformed`, async () => {
                const result = await post(
                    { id: `${GOOD}/activities/odd`, type: 'Like', actor, object: NOTE },
                    `${VICTIM}#main-key`,
                    realKey.privateKey
                );
                assert.equal(result, 'badRequest');
            });
        }

        it('a planted actor document cannot take over a cached actor', async () => {
            //  Alice's post, and Alice cached with her real key
            await new Promise((resolve, reject) =>
                Collection.addSharedInboxItem(
                    {
                        id: CREATE,
                        type: 'Create',
                        actor: VICTIM,
                        object: noteJson('<p>victim original</p>'),
                    },
                    true,
                    err => (err ? reject(err) : resolve())
                )
            );
            await new Promise((resolve, reject) =>
                Collection.addActor(actorDoc(VICTIM), '@alice@good.example', err =>
                    err ? reject(err) : resolve()
                )
            );
            const msg = await toMessage(new Note(noteJson('<p>victim original</p>')), {
                activityId: CREATE,
            });
            await new Promise((resolve, reject) =>
                msg.persist(err => (err ? reject(err) : resolve()))
            );

            //  a document served from another host claims to be Alice
            served.set(EVIL, {
                doc: actorDoc(VICTIM, { publicKeyPem: pem(attackerKey.publicKey) }),
            });
            await post(
                {
                    id: 'https://evil.example/activities/1',
                    type: 'Update',
                    actor: EVIL,
                    object: noteJson('<p>x</p>'),
                },
                `${EVIL}#main-key`,
                attackerKey.privateKey
            );
            assert.equal(
                cachedJson(VICTIM).publicKey.publicKeyPem,
                pem(realKey.publicKey),
                'the cache keeps the real key'
            );

            //  so requests signed with the planted key do not pass as Alice's
            const update = await post(
                {
                    id: `${GOOD}/activities/u1`,
                    type: 'Update',
                    actor: VICTIM,
                    object: noteJson('<p>HIJACKED</p>'),
                },
                `${VICTIM}#main-key`,
                attackerKey.privateKey
            );
            const del = await post(
                {
                    id: `${GOOD}/activities/d1`,
                    type: 'Delete',
                    actor: VICTIM,
                    object: { id: NOTE, type: 'Tombstone' },
                },
                `${VICTIM}#main-key`,
                attackerKey.privateKey
            );
            await new Promise(resolve => setTimeout(resolve, 50));

            assert.equal(update, 'accessDenied');
            assert.equal(del, 'accessDenied');
            const rows = _msgDb.prepare('SELECT message FROM message;').all();
            assert.equal(rows.length, 1, 'the message survives');
            assert.match(rows[0].message, /victim original/);
        });
    });
});

// ─── Collection.actor(): an exact match (#964 review) ─────────────────────────

describe('Collection.actor() matches an id exactly', function () {
    const ID = 'https://good.example/users/a_b';

    beforeEach(
        () =>
            new Promise((resolve, reject) =>
                Collection.addActor(
                    { id: ID, type: 'Person', inbox: `${ID}/inbox` },
                    '@a_b@good.example',
                    err => (err ? reject(err) : resolve())
                )
            )
    );

    const lookup = q =>
        new Promise(resolve =>
            Collection.actor(q, (err, actor) => resolve({ err, actor }))
        );

    it('finds the actor by its id and by its subject, in any case', async () => {
        assert.equal((await lookup(ID)).actor.id, ID);
        assert.equal((await lookup('@a_b@good.example')).actor.id, ID);
        assert.equal((await lookup('@A_B@Good.Example')).actor.id, ID);
    });

    it('does not treat _ or % as wildcards', async () => {
        assert.ok((await lookup('https://good.example/users/aXb')).err);
        assert.ok((await lookup('https://good.example/users/%')).err);
        assert.ok((await lookup('@aXb@good.example')).err);
    });
});

// ─── Create bound to its author; every stored row checked (#964 review) ──────
//
//  The signer is stubbed (the signature path is covered above); the network
//  is a stand-in, so a refusal cannot come from a failed real fetch.

describe('ActivityPub inbox: Create comes from the Note author', function () {
    const { Readable } = require('stream');
    const HttpUtil = require('../core/http_util.js');
    const { fetchAnnouncedNote } = require('../core/activitypub/boost_util.js');

    const GOOD = 'https://good.example';
    const VICTIM = `${GOOD}/users/alice`;
    const ATTACKER = 'https://evil.example/users/mallory';
    const FORWARDER = 'https://third.example/users/fwd';
    const NOTE = `${GOOD}/users/alice/statuses/1`;
    const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

    //  url -> { doc } or { status }
    let served;
    let fetched;
    let requests;
    let savedGetJson;

    beforeEach(() => {
        served = new Map();
        fetched = [];
        requests = [];
        savedGetJson = HttpUtil.getJson;
        HttpUtil.getJson = (url, opts, cb) => {
            fetched.push(url);
            requests.push({ url, opts });
            const hit = served.get(url) || { status: 404 };
            if (hit.status) {
                const err = new Error(`URL ${url} HTTP error ${hit.status}`);
                err.statusCode = hit.status;
                err.responseUrl = hit.responseUrl || url;
                return cb(err);
            }
            return cb(null, JSON.parse(JSON.stringify(hit.doc)), {
                statusCode: 200,
                headers: { 'content-type': 'application/activity+json' },
                responseUrl: hit.responseUrl || url,
            });
        };
    });

    afterEach(() => {
        HttpUtil.getJson = savedGetJson;
    });

    const note = (overrides = {}) =>
        Object.assign(
            {
                id: NOTE,
                type: 'Note',
                attributedTo: VICTIM,
                content: '<p>the genuine post</p>',
                published: '2026-04-12T12:00:00Z',
                to: [PUBLIC],
            },
            overrides
        );

    const create = (actor, object, id) => ({
        id: id || `${new URL(actor).origin}/activities/create-${Math.random()}`,
        type: 'Create',
        actor,
        to: [PUBLIC],
        object,
    });

    //  Runs the inbox for |activity|, signed (as far as the handler knows)
    //  by |signerId|; resolves with the response name.
    //  options.inbox: a personal inbox path; options.users: actor id ->
    //  local user, standing in for the user database
    function post(activity, signerId, options = {}) {
        const handler = new ActivityPubWebHandler();
        const noop = () => {};
        handler.log = { trace: noop, debug: noop, info: noop, warn: noop, error: noop };
        handler.sysLog = handler.log;
        handler._getAssociatedActors = (objectActorId, keyId, cb) =>
            cb(null, { id: objectActorId }, { id: signerId });
        handler._validateActorSignature = () => true;
        handler._localUserByActorId = (id, cb) =>
            cb(null, (options.users || {})[id] || null);
        return new Promise(resolve => {
            const respond = name => () => resolve(name);
            handler.webServer = {
                accepted: respond('accepted'),
                accessDenied: respond('accessDenied'),
                resourceNotFound: respond('resourceNotFound'),
                badRequest: respond('badRequest'),
                notImplemented: respond('notImplemented'),
                internalServerError: respond('internalServerError'),
            };
            const req = Readable.from([Buffer.from(JSON.stringify(activity))]);
            req.headers = {};
            req.url = options.inbox || '/_enig/ap/sharedInbox';
            req.method = 'POST';
            handler._inboxPostHandler(
                req,
                {},
                { keyId: `${signerId}#main-key` },
                options.inbox ? 'inbox' : SHARED
            );
        });
    }

    const SHARED = 'sharedInbox';
    const messages = () =>
        _msgDb
            .prepare(
                `SELECT m.message_id, m.message, mm.meta_value AS from_actor
                FROM message m LEFT JOIN message_meta mm
                    ON mm.message_id = m.message_id AND mm.meta_name = 'remote_from_user'
                ORDER BY m.message_id;`
            )
            .all();
    const storedRows = () =>
        _apDb
            .prepare(`SELECT object_json FROM collection WHERE name = 'sharedInbox';`)
            .all()
            .map(r => JSON.parse(r.object_json));

    async function settle(check) {
        for (let i = 0; i < 50 && !(check && check()); ++i) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }
    }

    describe("squatting on another author's Note id", function () {
        it('is refused, and the genuine Create, Update and owner checks then work', async () => {
            served.set(NOTE, { doc: note() });

            //  a Note id on the victim's host, attributed to the attacker
            const squat = await post(
                create(
                    ATTACKER,
                    note({ attributedTo: ATTACKER, content: '<p>squat</p>' })
                ),
                ATTACKER
            );
            assert.equal(squat, 'accessDenied');
            assert.deepEqual(storedRows(), []);
            assert.deepEqual(messages(), []);

            //  the victim's own Create then goes through
            assert.equal(await post(create(VICTIM, note()), VICTIM), 'accepted');
            assert.equal(messages().length, 1);
            assert.match(messages()[0].message, /the genuine post/);
            assert.equal(messages()[0].from_actor, VICTIM);
            const messageId = messages()[0].message_id;

            //  the victim can edit it
            const edit = {
                id: `${GOOD}/activities/update-1`,
                type: 'Update',
                actor: VICTIM,
                object: note({ content: '<p>edited by alice</p>' }),
            };
            assert.equal(await post(edit, VICTIM), 'accepted');
            await settle(() => /edited by alice/.test(messages()[0].message));
            assert.match(messages()[0].message, /edited by alice/);
            assert.equal(messages()[0].message_id, messageId);

            //  and the attacker cannot
            const hijack = {
                id: 'https://evil.example/activities/update-2',
                type: 'Update',
                actor: ATTACKER,
                object: note({ attributedTo: ATTACKER, content: '<p>hijack</p>' }),
            };
            assert.equal(await post(hijack, ATTACKER), 'accessDenied');
            await settle();
            assert.match(messages()[0].message, /edited by alice/);
        });
    });

    describe('Create', function () {
        it('refuses a Note attributed to someone else when the origin does not confirm it', async () => {
            //  nothing served at the Note id: the origin cannot confirm it
            const result = await post(create(ATTACKER, note()), ATTACKER);
            assert.equal(result, 'accessDenied');
            //  a Note off the actor's host cannot be the actor's
            assert.ok(!fetched.includes(NOTE), 'nothing is fetched for it');
            assert.deepEqual(messages(), []);
        });

        it('stores a forwarded reply from the origin copy, not the forwarded one', async () => {
            served.set(NOTE, { doc: note({ content: '<p>as the origin has it</p>' }) });

            //  signed by a third party, actor and author are the victim
            const forwarded = create(
                VICTIM,
                note({ content: '<p>altered on the way</p>' }),
                `${GOOD}/activities/create-fwd`
            );
            assert.equal(await post(forwarded, FORWARDER), 'accepted');

            assert.equal(messages().length, 1);
            assert.match(messages()[0].message, /as the origin has it/);
            assert.equal(messages()[0].from_actor, VICTIM);
            assert.match(storedRows()[0].object.content, /as the origin has it/);
        });

        it('refuses a forwarded Create the origin answers with another id', async () => {
            served.set(NOTE, { doc: note({ id: `${GOOD}/users/alice/statuses/2` }) });
            assert.equal(await post(create(VICTIM, note()), FORWARDER), 'accessDenied');
            assert.deepEqual(messages(), []);
        });

        it('refuses a forwarded Create whose actor is not the origin author', async () => {
            served.set(NOTE, { doc: note({ attributedTo: `${GOOD}/users/carol` }) });
            assert.equal(await post(create(VICTIM, note()), FORWARDER), 'accessDenied');
            assert.deepEqual(messages(), []);
        });

        it('refuses a Note fetched through a redirect to another host', async () => {
            served.set(NOTE, { doc: note(), responseUrl: 'https://evil.example/n/1' });
            assert.equal(await post(create(VICTIM, note()), FORWARDER), 'accessDenied');
        });

        it("refuses a Note whose id is not on its author's host", async () => {
            const offHost = 'https://evil.example/notes/1';
            served.set(offHost, { doc: note({ id: offHost }) });
            const result = await post(create(VICTIM, note({ id: offHost })), VICTIM);
            assert.equal(result, 'accessDenied');
            assert.deepEqual(messages(), []);
        });

        it('takes a repeated genuine Create as a duplicate, not an error', async () => {
            const activity = create(VICTIM, note(), `${GOOD}/activities/create-dup`);
            assert.equal(await post(activity, VICTIM), 'accepted');
            assert.equal(await post(activity, VICTIM), 'accepted');
            //  re-sent under a new activity id, too
            assert.equal(await post(create(VICTIM, note()), VICTIM), 'accepted');
            assert.equal(messages().length, 1);
        });
    });

    describe('a forwarded Create', function () {
        const N2 = `${GOOD}/users/alice/statuses/2`;
        const objectIds = () =>
            _apDb
                .prepare(
                    `SELECT object_id FROM collection WHERE name = 'sharedInbox' ORDER BY rowid;`
                )
                .all()
                .map(r => r.object_id);
        const deleteNote = () => ({
            id: `${GOOD}/activities/delete-${Math.random()}`,
            type: 'Delete',
            actor: VICTIM,
            object: { id: NOTE, type: 'Tombstone' },
        });

        it("cannot plant a row under another Note's id (T2)", async () => {
            served.set(N2, { doc: note({ id: N2, content: '<p>genuine #2</p>' }) });
            //  the activity id is the victim's Note #1, with extra fields
            const plant = Object.assign(
                create(VICTIM, note({ id: N2, content: '<p>whatever</p>' }), NOTE),
                { attributedTo: ATTACKER }
            );
            assert.equal(await post(plant, ATTACKER), 'accepted');

            //  stored as the origin has it, under an id of its own
            const rows = storedRows();
            assert.equal(rows.length, 1);
            assert.deepEqual(Object.keys(rows[0]).sort(), [
                '@context',
                'actor',
                'id',
                'object',
                'published',
                'to',
                'type',
            ]);
            assert.equal(rows[0].id, `${N2}#create-from-origin`);
            assert.equal(rows[0].actor, VICTIM);
            assert.equal(rows[0].object.content, '<p>genuine #2</p>');
            assert.ok(!objectIds().includes(NOTE));

            //  the victim's Note #1, then its Update and Delete, all work
            served.set(NOTE, { doc: note() });
            assert.equal(await post(create(VICTIM, note()), VICTIM), 'accepted');
            const edit = {
                id: `${GOOD}/activities/update-t2`,
                type: 'Update',
                actor: VICTIM,
                object: note({ content: '<p>edited</p>' }),
            };
            assert.equal(await post(edit, VICTIM), 'accepted');
            assert.equal(await post(deleteNote(), VICTIM), 'accepted');
            assert.deepEqual(
                messages().map(m => m.message),
                ['genuine #2']
            );
        });

        it("cannot squat on the author's own activity id (T2b)", async () => {
            served.set(N2, { doc: note({ id: N2 }) });
            const id = `${NOTE}/activity`;
            assert.equal(
                await post(create(VICTIM, note({ id: N2 }), id), ATTACKER),
                'accepted'
            );

            //  the author's real Create under that id is still stored
            assert.equal(await post(create(VICTIM, note(), id), VICTIM), 'accepted');
            assert.ok(objectIds().includes(id));
            assert.equal(messages().length, 2);

            assert.equal(await post(deleteNote(), VICTIM), 'accepted');
            assert.equal(messages().length, 1, "Note #1's message is gone");
            assert.ok(!objectIds().includes(id));
        });

        for (const forwardedFirst of [true, false]) {
            it(`stores a Note once when it comes ${
                forwardedFirst ? 'forwarded, then direct' : 'direct, then forwarded'
            }`, async () => {
                served.set(NOTE, { doc: note() });
                const direct = () =>
                    post(create(VICTIM, note(), `${NOTE}/activity`), VICTIM);
                const forwarded = () => post(create(VICTIM, note()), FORWARDER);

                if (forwardedFirst) {
                    assert.equal(await forwarded(), 'accepted');
                    assert.equal(await direct(), 'accepted');
                } else {
                    assert.equal(await direct(), 'accepted');
                    assert.equal(await forwarded(), 'accepted');
                }

                assert.equal(storedRows().length, 1);
                assert.equal(messages().length, 1);
                assert.equal(await post(deleteNote(), VICTIM), 'accepted');
                assert.deepEqual(storedRows(), []);
                assert.deepEqual(messages(), []);
            });
        }

        it('Update and Delete check the same stored rows', async () => {
            served.set(NOTE, { doc: note() });
            assert.equal(await post(create(VICTIM, note()), VICTIM), 'accepted');
            //  a row stored under the Note id naming another owner (as a
            //  forwarded Create could plant before this fix)
            await new Promise((resolve, reject) =>
                Collection.addSharedInboxItem(
                    {
                        id: NOTE,
                        type: 'Create',
                        actor: VICTIM,
                        attributedTo: ATTACKER,
                        object: note({ id: N2 }),
                    },
                    true,
                    err => (err ? reject(err) : resolve())
                )
            );

            const edit = {
                id: `${GOOD}/activities/update-agree`,
                type: 'Update',
                actor: VICTIM,
                object: note({ content: '<p>edited</p>' }),
            };
            assert.equal(await post(edit, VICTIM), 'accessDenied');
            assert.equal(await post(deleteNote(), VICTIM), 'accessDenied');
        });
    });

    describe('a forwarded Delete', function () {
        const forwardedDelete = (actor = VICTIM) => ({
            id: `${NOTE}#delete`,
            type: 'Delete',
            actor,
            object: { id: NOTE, type: 'Tombstone' },
        });

        async function storeReply() {
            served.set(NOTE, { doc: note() });
            assert.equal(await post(create(VICTIM, note()), FORWARDER), 'accepted');
            assert.equal(messages().length, 1);
        }

        it('removes a Note its origin answers 410 for', async () => {
            await storeReply();
            served.set(NOTE, { status: 410 });
            assert.equal(await post(forwardedDelete(), FORWARDER), 'accepted');
            assert.deepEqual(messages(), []);
            assert.deepEqual(storedRows(), []);
        });

        it('removes a Note its origin answers with a Tombstone for', async () => {
            await storeReply();
            served.set(NOTE, { doc: { id: NOTE, type: 'Tombstone' } });
            assert.equal(await post(forwardedDelete(), FORWARDER), 'accepted');
            assert.deepEqual(messages(), []);
        });

        it('is refused while the origin still serves the Note', async () => {
            await storeReply();
            assert.equal(await post(forwardedDelete(), FORWARDER), 'accessDenied');
            assert.equal(messages().length, 1);
        });

        it("is refused when the actor is not the Note's owner", async () => {
            await storeReply();
            served.set(NOTE, { status: 410 });
            //  another actor on the same host
            const carol = `${GOOD}/users/carol`;
            assert.equal(await post(forwardedDelete(carol), FORWARDER), 'accessDenied');
            assert.equal(messages().length, 1);
        });

        it('is refused when the 410 comes from another host after a redirect', async () => {
            await storeReply();
            served.set(NOTE, { status: 410, responseUrl: 'https://evil.example/gone' });
            assert.equal(await post(forwardedDelete(), FORWARDER), 'accessDenied');
            assert.equal(messages().length, 1);
        });

        it('is refused for a Tombstone of another id', async () => {
            await storeReply();
            served.set(NOTE, { doc: { id: `${NOTE}/x`, type: 'Tombstone' } });
            assert.equal(await post(forwardedDelete(), FORWARDER), 'accessDenied');
            assert.equal(messages().length, 1);
        });
    });

    describe('Announce', function () {
        const fetchAnnounced = (objectOrId, announcer) =>
            new Promise(resolve =>
                fetchAnnouncedNote(objectOrId, announcer, (err, n) => resolve({ err, n }))
            );

        it('refuses a fetched Note whose id is not its URL', async () => {
            served.set(NOTE, { doc: note({ id: `${GOOD}/users/alice/statuses/9` }) });
            const { err } = await fetchAnnounced(NOTE, `${GOOD}/users/bob`);
            assert.ok(err);
        });

        it('refuses a fetched Note not attributed to an actor on its host', async () => {
            served.set(NOTE, { doc: note({ attributedTo: ATTACKER }) });
            const { err } = await fetchAnnounced(NOTE, `${GOOD}/users/bob`);
            assert.ok(err);
        });

        it('takes an embedded Note naming an author off its host from the origin', async () => {
            served.set(NOTE, { doc: note({ content: '<p>origin copy</p>' }) });
            const { err, n } = await fetchAnnounced(
                note({ attributedTo: ATTACKER, content: '<p>forged copy</p>' }),
                `${GOOD}/users/bob`
            );
            assert.ifError(err);
            assert.match(n.content, /origin copy/);
            assert.equal(n.attributedTo, VICTIM);
        });

        it('refuses an embedded Note from another host than the announcer', async () => {
            served.set(NOTE, { doc: note() });
            const { err } = await fetchAnnounced(note(), ATTACKER);
            //  looked up by its id, which an announcer may only do on its host
            assert.ok(err);
        });

        it("looks up an embedded Note whose id is not on the announcer's host", async () => {
            //  the author is the announcer, but the Note id is the victim's
            const { err } = await fetchAnnounced(
                note({ attributedTo: ATTACKER, content: '<p>squat</p>' }),
                ATTACKER
            );
            assert.ok(err, 'not taken as sent');
            assert.ok(!fetched.includes(NOTE), 'and not fetched from another host');
        });

        it("takes the announcer's own embedded Note as sent", async () => {
            const { err, n } = await fetchAnnounced(note(), VICTIM);
            assert.ifError(err);
            assert.equal(n.id, NOTE);
            assert.ok(!fetched.includes(NOTE), 'no fetch needed');
        });

        it("fetches an embedded Note by another actor on the announcer's host", async () => {
            served.set(NOTE, { doc: note({ content: '<p>origin copy</p>' }) });
            const { err, n } = await fetchAnnounced(
                note({ content: '<p>as announced</p>' }),
                `${GOOD}/users/bob`
            );
            assert.ifError(err);
            assert.ok(fetched.includes(NOTE), 'fetched from its origin');
            assert.match(n.content, /origin copy/);
        });
    });

    describe('Delete', function () {
        async function storeVictimNote() {
            served.set(NOTE, { doc: note() });
            assert.equal(await post(create(VICTIM, note()), VICTIM), 'accepted');
        }

        const deleteNote = actor => ({
            id: `${new URL(actor).origin}/activities/delete-${Math.random()}`,
            type: 'Delete',
            actor,
            object: { id: NOTE, type: 'Tombstone' },
        });

        it('is refused when stored rows name different owners', async () => {
            await storeVictimNote();
            //  a second row holding the same Note id under another author
            await new Promise((resolve, reject) =>
                Collection.addSharedInboxItem(
                    {
                        id: 'https://evil.example/activities/announce-1',
                        type: 'Announce',
                        actor: ATTACKER,
                        object: note({ attributedTo: ATTACKER }),
                    },
                    true,
                    err => (err ? reject(err) : resolve())
                )
            );

            assert.equal(await post(deleteNote(VICTIM), VICTIM), 'accessDenied');
            assert.equal(await post(deleteNote(ATTACKER), ATTACKER), 'accessDenied');
            assert.equal(messages().length, 1, 'the message survives');
        });

        it("leaves a message for the Note id that is not the author's", async () => {
            await storeVictimNote();
            //  a message stored for the same Note id by someone else (say,
            //  before this fix)
            const planted = await toMessage(
                new Note(note({ attributedTo: ATTACKER, content: '<p>planted</p>' })),
                {
                    toUser: { userId: 1, username: 'bob', getProperty: () => null },
                    areaTag: Message.WellKnownAreaTags.Private,
                }
            );
            await new Promise((resolve, reject) =>
                planted.persist(err => (err ? reject(err) : resolve()))
            );
            assert.equal(messages().length, 2);

            assert.equal(await post(deleteNote(VICTIM), VICTIM), 'accepted');
            assert.deepEqual(
                messages().map(m => m.from_actor),
                [ATTACKER]
            );
        });

        it("an Update leaves a message for the Note id that is not the author's", async () => {
            await storeVictimNote();
            //  a public message, so updating it needs no local user
            const planted = await toMessage(
                new Note(note({ attributedTo: ATTACKER, content: '<p>planted</p>' }))
            );
            planted.messageUuid = '00000000-0000-4000-8000-000000000964';
            await new Promise((resolve, reject) =>
                planted.persist(err => (err ? reject(err) : resolve()))
            );

            const edit = {
                id: `${GOOD}/activities/update-9`,
                type: 'Update',
                actor: VICTIM,
                object: note({ content: '<p>edited by alice</p>' }),
            };
            assert.equal(await post(edit, VICTIM), 'accepted');
            await settle(() => messages().some(m => /edited by alice/.test(m.message)));

            const byAuthor = Object.fromEntries(
                messages().map(m => [m.from_actor, m.message])
            );
            assert.match(byAuthor[VICTIM], /edited by alice/);
            assert.match(byAuthor[ATTACKER], /planted/);
        });

        it('an Update and a Delete are refused while another stored row cannot be read', async () => {
            await storeVictimNote();
            //  beside the genuine row, one whose JSON does not parse
            const savedById = Collection.objectsById;
            Collection.objectsById = (id, cb) =>
                cb(null, [{ info: { name: 'sharedInbox' }, object: null }]);
            const edit = {
                id: `${GOOD}/activities/update-unreadable`,
                type: 'Update',
                actor: VICTIM,
                object: note({ content: '<p>edited</p>' }),
            };
            try {
                assert.equal(await post(edit, VICTIM), 'accessDenied');
                assert.equal(await post(deleteNote(VICTIM), VICTIM), 'accessDenied');
            } finally {
                Collection.objectsById = savedById;
            }
            await settle();
            assert.equal(messages().length, 1);
            assert.match(messages()[0].message, /the genuine post/);
        });

        it('refuses a stored row that cannot be read', async () => {
            await storeVictimNote();
            //  a row whose JSON does not parse; SQLite's json_extract() would
            //  fail on it in the table, so the lookups stand in for one
            const savedById = Collection.objectsById;
            const savedEmbedded = Collection.objectsByEmbeddedId;
            Collection.objectsById = (id, cb) =>
                cb(null, [{ info: { name: 'sharedInbox' }, object: null }]);
            Collection.objectsByEmbeddedId = (id, cb) => cb(null, []);
            try {
                const result = await post(deleteNote(VICTIM), VICTIM);
                assert.equal(result, 'accessDenied');
            } finally {
                Collection.objectsById = savedById;
                Collection.objectsByEmbeddedId = savedEmbedded;
            }
            assert.equal(messages().length, 1);
            assert.equal(storedRows().length, 1);
        });
    });

    describe("the inbox's own fetches are signed", function () {
        const UserProps = require('../core/user_property.js');
        const BOB = 'https://test.example.com/_enig/ap/users/bob';
        const bobKey = require('crypto')
            .generateKeyPairSync('rsa', { modulusLength: 2048 })
            .privateKey.export({ type: 'pkcs8', format: 'pem' });
        const bob = {
            userId: 2,
            username: 'bob',
            getProperty: name =>
                ({
                    [UserProps.ActivityPubActorId]: BOB,
                    [UserProps.PrivateActivityPubSigningKey]: bobKey,
                })[name] || null,
        };
        const users = { [BOB]: bob };
        const signedAs = url => {
            const req = requests.find(r => r.url === url);
            assert.ok(req, `${url} was fetched`);
            return req.opts.sign ? req.opts.sign.keyId : null;
        };
        const bobFollows = actorId =>
            new Promise((resolve, reject) =>
                Collection.addFollowing(
                    bob,
                    { id: actorId, type: 'Person' },
                    true,
                    err => (err ? reject(err) : resolve())
                )
            );

        it('signs a forwarded reply refetch as a local follower of its author', async () => {
            await bobFollows(VICTIM);
            served.set(NOTE, { doc: note() });
            const result = await post(create(VICTIM, note()), FORWARDER, { users });
            assert.equal(result, 'accepted');
            assert.equal(signedAs(NOTE), `${BOB}#main-key`);
            assert.equal(requests.find(r => r.url === NOTE).opts.sign.key, bobKey);
        });

        it('fetches unsigned when no local user follows the author', async () => {
            served.set(NOTE, { doc: note() });
            assert.equal(
                await post(create(VICTIM, note()), FORWARDER, { users }),
                'accepted'
            );
            assert.equal(signedAs(NOTE), null);
        });

        it('signs as the personal inbox user', async () => {
            served.set(NOTE, { doc: note() });
            const result = await post(create(VICTIM, note()), FORWARDER, {
                users,
                inbox: '/_enig/ap/users/bob/inbox',
            });
            assert.equal(result, 'accepted');
            assert.equal(signedAs(NOTE), `${BOB}#main-key`);
        });

        it('signs an Announce fetch as a local follower of the announcer', async () => {
            await bobFollows(VICTIM);
            served.set(NOTE, { doc: note() });
            const announce = {
                id: `${GOOD}/activities/announce-1`,
                type: 'Announce',
                actor: VICTIM,
                object: NOTE,
            };
            //  (recording the boost needs a reactions table this database
            //  does not have; the fetch comes first)
            await post(announce, VICTIM, { users });
            assert.equal(signedAs(NOTE), `${BOB}#main-key`);
        });
    });

    describe('Delete of an actor that can no longer be fetched', function () {
        const GONE = `${GOOD}/users/gone`;

        function postUnfetchable(activity, options = {}) {
            const handler = new ActivityPubWebHandler();
            handler._localUserByActorId = (id, cb) =>
                cb(null, (options.users || {})[id] || null);
            const noop = () => {};
            handler.log = {
                trace: noop,
                debug: noop,
                info: noop,
                warn: noop,
                error: noop,
            };
            handler.sysLog = handler.log;
            handler._getAssociatedActors = (objectActorId, keyId, cb) =>
                cb(new Error('actor fetch failed'));
            return new Promise(resolve => {
                const respond = name => () => resolve(name);
                handler.webServer = {
                    accepted: respond('accepted'),
                    accessDenied: respond('accessDenied'),
                    resourceNotFound: respond('resourceNotFound'),
                    badRequest: respond('badRequest'),
                    notImplemented: respond('notImplemented'),
                    internalServerError: respond('internalServerError'),
                };
                const req = Readable.from([Buffer.from(JSON.stringify(activity))]);
                req.headers = {};
                req.url = '/_enig/ap/sharedInbox';
                req.method = 'POST';
                req.url = options.inbox || req.url;
                handler._inboxPostHandler(
                    req,
                    {},
                    { keyId: `${GONE}#main-key` },
                    options.inbox ? 'inbox' : SHARED
                );
            });
        }

        const selfDelete = (actor = GONE, object = GONE) => ({
            id: `${GOOD}/activities/delete-self`,
            type: 'Delete',
            actor,
            object,
        });

        async function storeGoneActor() {
            await new Promise((resolve, reject) =>
                Collection.addActor(
                    { id: GONE, type: 'Person', inbox: `${GONE}/inbox` },
                    '@gone@good.example',
                    err => (err ? reject(err) : resolve())
                )
            );
            await new Promise((resolve, reject) =>
                Collection.addToCollection(
                    'followers',
                    null,
                    'https://test.example.com/_enig/ap/users/bob/followers',
                    GONE,
                    { id: GONE, type: 'Person' },
                    false,
                    true,
                    err => (err ? reject(err) : resolve())
                )
            );
            //  someone else's state, which must stay
            await new Promise((resolve, reject) =>
                Collection.addSharedInboxItem(
                    {
                        id: `${GOOD}/activities/c9`,
                        type: 'Create',
                        actor: VICTIM,
                        object: note(),
                    },
                    true,
                    err => (err ? reject(err) : resolve())
                )
            );
        }

        const rowsFor = id =>
            _apDb
                .prepare('SELECT name FROM collection WHERE object_id = ? ORDER BY name;')
                .all(id)
                .map(r => r.name);

        it("is accepted when the origin answers 410, removing only that actor's state", async () => {
            await storeGoneActor();
            served.set(GONE, { status: 410 });

            assert.equal(await postUnfetchable(selfDelete()), 'accepted');
            assert.deepEqual(rowsFor(GONE), []);
            assert.equal(storedRows().length, 1, "others' rows are untouched");
        });

        it('signs the probe as the personal inbox user', async () => {
            const UserProps = require('../core/user_property.js');
            const BOB = 'https://test.example.com/_enig/ap/users/bob';
            const bob = {
                userId: 2,
                username: 'bob',
                getProperty: name =>
                    name === UserProps.PrivateActivityPubSigningKey ? 'a key' : null,
            };
            await storeGoneActor();
            served.set(GONE, { status: 410 });

            const result = await postUnfetchable(selfDelete(), {
                inbox: '/_enig/ap/users/bob/inbox',
                users: { [BOB]: bob },
            });

            assert.equal(result, 'accepted');
            const probe = requests.find(r => r.url === GONE);
            assert.equal(probe.opts.sign && probe.opts.sign.keyId, `${BOB}#main-key`);
        });

        it('is refused when the origin answers 404, which may be transient', async () => {
            await storeGoneActor();
            served.set(GONE, { status: 404 });
            assert.equal(await postUnfetchable(selfDelete()), 'accessDenied');
            assert.deepEqual(rowsFor(GONE), ['actors', 'followers']);
        });

        it('is refused when the 410 comes from another host after a redirect', async () => {
            await storeGoneActor();
            served.set(GONE, { status: 410, responseUrl: 'https://evil.example/gone' });
            assert.equal(await postUnfetchable(selfDelete()), 'accessDenied');
            assert.deepEqual(rowsFor(GONE), ['actors', 'followers']);
        });

        it('is refused when the origin still serves the actor', async () => {
            await storeGoneActor();
            served.set(GONE, {
                doc: { id: GONE, type: 'Person', inbox: `${GONE}/inbox` },
            });
            assert.equal(await postUnfetchable(selfDelete()), 'accessDenied');
            assert.deepEqual(rowsFor(GONE), ['actors', 'followers']);
        });

        it('is refused when the origin fails for another reason', async () => {
            await storeGoneActor();
            served.set(GONE, { status: 500 });
            assert.equal(await postUnfetchable(selfDelete()), 'accessDenied');
            assert.deepEqual(rowsFor(GONE), ['actors', 'followers']);
        });

        it('is refused for an object other than the actor itself', async () => {
            await storeGoneActor();
            served.set(GONE, { status: 410 });
            const forged = selfDelete(`${GOOD}/users/other`, GONE);
            assert.equal(await postUnfetchable(forged), 'accessDenied');
            assert.deepEqual(rowsFor(GONE), ['actors', 'followers']);
        });
    });
});

// ─── formatAttachmentBlock — pure function ────────────────────────────────────
//
//  Shared formatter used by Note.toMessage() (importer) AND the dedicated AP
//  viewer (_displayNote). Both must produce the same text so attachments look
//  identical across the standard message-base view and the AP browser.

const { formatAttachmentBlock } = require('../core/activitypub/note');

describe('formatAttachmentBlock()', function () {
    it('returns "" for missing/non-array input', () => {
        assert.equal(formatAttachmentBlock(undefined), '');
        assert.equal(formatAttachmentBlock(null), '');
        assert.equal(formatAttachmentBlock([]), '');
        assert.equal(formatAttachmentBlock('not an array'), '');
    });

    it('renders an image with width/height', () => {
        const out = formatAttachmentBlock([
            {
                mediaType: 'image/jpeg',
                width: 800,
                height: 600,
                name: 'A picture',
                url: 'https://example.com/p.jpg',
            },
        ]);
        assert.ok(out.startsWith('--[Attachments]--'));
        assert.ok(out.includes('Image (800x600)'));
        assert.ok(out.includes('A picture'));
        assert.ok(out.includes('https://example.com/p.jpg'));
    });

    it('renders an image without dimensions as bare "Image"', () => {
        const out = formatAttachmentBlock([
            { mediaType: 'image/png', url: 'https://example.com/q.png' },
        ]);
        assert.ok(out.includes('Image'));
        assert.ok(!out.includes('Image ('));
    });

    it('renders audio and video by type label', () => {
        const audio = formatAttachmentBlock([
            { mediaType: 'audio/mpeg', url: 'https://example.com/a.mp3' },
        ]);
        const video = formatAttachmentBlock([
            { mediaType: 'video/mp4', url: 'https://example.com/v.mp4' },
        ]);
        assert.ok(audio.includes('Audio'));
        assert.ok(video.includes('Video'));
    });

    it('falls back to the raw mediaType for other types', () => {
        const out = formatAttachmentBlock([
            { mediaType: 'application/pdf', url: 'https://example.com/d.pdf' },
        ]);
        assert.ok(out.includes('application/pdf'));
    });

    it('uses generic "Attachment" label when mediaType is missing', () => {
        const out = formatAttachmentBlock([{ url: 'https://example.com/x' }]);
        assert.ok(out.includes('Attachment'));
        assert.ok(out.includes('https://example.com/x'));
    });

    it('omits the url line when url is absent', () => {
        const out = formatAttachmentBlock([
            { mediaType: 'image/png', width: 1, height: 1, name: 'just a label' },
        ]);
        assert.ok(out.includes('just a label'));
        assert.ok(!out.includes('http'));
    });

    it('renders multiple attachments separated by blank lines', () => {
        const out = formatAttachmentBlock([
            { mediaType: 'image/png', url: 'https://example.com/1.png' },
            { mediaType: 'image/jpeg', url: 'https://example.com/2.jpg' },
        ]);
        assert.ok(out.includes('https://example.com/1.png'));
        assert.ok(out.includes('https://example.com/2.jpg'));
        //  Header appears exactly once
        assert.equal(out.split('--[Attachments]--').length - 1, 1);
    });

    it('uses CRLF line endings to match toMessage() output', () => {
        const out = formatAttachmentBlock([
            { mediaType: 'image/png', url: 'https://example.com/x.png' },
        ]);
        assert.ok(out.includes('\r\n'), 'output must use CRLF');
    });
});

// ─── Note.toMessage — attachment footer ──────────────────────────────────────

describe('Note.toMessage() — attachment footer', function () {
    it('appends the attachment block to the message body', async () => {
        const msg = await toMessage(
            makeNote({
                content: '<p>Hello body</p>',
                attachment: [
                    {
                        mediaType: 'image/png',
                        width: 320,
                        height: 200,
                        name: 'My alt text',
                        url: 'https://example.com/img.png',
                    },
                ],
            })
        );
        assert.ok(msg.message.includes('Hello body'));
        assert.ok(msg.message.includes('--[Attachments]--'));
        assert.ok(msg.message.includes('Image (320x200)'));
        assert.ok(msg.message.includes('My alt text'));
        assert.ok(msg.message.includes('https://example.com/img.png'));
    });

    it('does not append the block when attachment is missing/empty', async () => {
        const msg = await toMessage(makeNote({ content: '<p>just text</p>' }));
        assert.ok(!msg.message.includes('--[Attachments]--'));
    });
});
