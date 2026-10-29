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
delete require.cache[
    require.resolve('../core/servers/content/web_handlers/activitypub.js')
];

const Message = require('../core/message.js');
const Note = require('../core/activitypub/note.js');
const Actor = require('../core/activitypub/actor.js');
const Collection = require('../core/activitypub/collection.js');
const ActivityPubWebHandler =
    require('../core/servers/content/web_handlers/activitypub.js').getModule;

//  the real one; beforeEach below stubs it
const realFindMessages = Message.findMessages;

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
        //  actor fetches and the signature check stubbed, and returns the
        //  auth the Update handler was given.
        function dispatch(activity, keyId, signatureActorId) {
            const { handler } = makeHandler();
            handler._getAssociatedActors = (objectActorId, sigActorId, cb) =>
                cb(null, { id: objectActorId }, { id: signatureActorId });
            handler._validateActorSignature = () => true;
            return new Promise(resolve => {
                handler._inboxUpdateExistingObject = (inboxType, resp, act, auth) =>
                    resolve(auth);
                const req = Readable.from([Buffer.from(JSON.stringify(activity))]);
                req.headers = {};
                req.url = '/_enig/ap/sharedInbox';
                req.method = 'POST';
                handler._inboxPostHandler(req, {}, { keyId }, SHARED);
            });
        }

        it('passes the signing actor on, not activity.actor', async () => {
            const auth = await dispatch(
                updateActivity({ actor: OWNER }),
                `${OTHER}#main-key`,
                OTHER
            );
            assert.equal(auth.httpSigValidated, true);
            assert.equal(auth.signerId, OTHER);
        });

        it("passes no signer when the signing actor's id is off the keyId's host", async () => {
            const auth = await dispatch(
                updateActivity({ actor: OWNER }),
                `${OWNER}#main-key`,
                'https://elsewhere.example/users/alice'
            );
            assert.equal(auth.signerId, null);
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

        it('still accepts the domain-bound path for an actor that cannot be fetched', async () => {
            //  verifyObjectOwner permits this path for objects of type
            //  'Actor' only, and has no signer to compare
            await storeActor('Actor');
            const responses = await deleteActor(
                { httpSigValidated: false, domainVerifiedOnly: true, signerId: null },
                VICTIM
            );
            assert.deepEqual(responses, ['accepted']);
            assert.equal(actorRow(), undefined);
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
