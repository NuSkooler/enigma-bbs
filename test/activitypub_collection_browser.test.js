'use strict';

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');

//
//  Config mock
//
const configModule = require('../core/config.js');
configModule.get = () => ({
    debug: { assertsEnabled: false },
    general: { boardName: 'TestBoard' },
    contentServers: {
        web: {
            domain: 'test.example.com',
            https: { enabled: true, port: 443 },
        },
    },
});

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
//  In-memory activitypub DB injected before requiring collection.js
//
const dbModule = require('../core/database.js');
const _apDb = new Database(':memory:');
_apDb.pragma('foreign_keys = ON');
dbModule.dbs.activitypub = _apDb;

delete require.cache[require.resolve('../core/web_util.js')];
delete require.cache[require.resolve('../core/activitypub/endpoint.js')];
delete require.cache[require.resolve('../core/activitypub/object.js')];
delete require.cache[require.resolve('../core/activitypub/collection.js')];

const Collection = require('../core/activitypub/collection.js');

// ─── schema ───────────────────────────────────────────────────────────────────

before(() => {
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
    _apDb.exec(
        'DELETE FROM note_reactions; DELETE FROM collection_object_meta; DELETE FROM collection;'
    );
});

// ─── helpers ─────────────────────────────────────────────────────────────────

const PUBLIC_COLL_ID = 'https://www.w3.org/ns/activitystreams#Public';
const SHARED_INBOX = 'sharedInbox';

let _seq = 0;

//  Insert a Create{Note} activity into a named collection at an explicit timestamp.
//  noteExtra overrides/augments the Note object fields.
//  Returns the note ID string.
function insertNote(collName, ts, noteExtra = {}) {
    const n = ++_seq;
    const noteId = `https://remote.example.com/notes/${n}`;
    const actorId = noteExtra.attributedTo || `https://remote.example.com/users/user${n}`;

    const note = Object.assign(
        {
            id: noteId,
            type: 'Note',
            attributedTo: actorId,
            content: `Content ${n}`,
            summary: `Subject ${n}`,
            published: ts,
            to: [PUBLIC_COLL_ID],
            cc: [],
            tag: [],
        },
        noteExtra
    );

    const activity = { type: 'Create', actor: actorId, object: note };

    _apDb
        .prepare(
            `INSERT INTO collection
            (collection_id, name, timestamp, owner_actor_id, object_id, object_json, is_private)
         VALUES (?, ?, ?, ?, ?, ?, 0)`
        )
        .run(
            PUBLIC_COLL_ID,
            collName,
            ts,
            PUBLIC_COLL_ID,
            noteId,
            JSON.stringify(activity)
        );

    return noteId;
}

function insertReaction(noteId, actorId, type, activityId = null, ts = null) {
    _apDb
        .prepare(
            `INSERT INTO note_reactions (note_id, actor_id, reaction_type, activity_id, timestamp)
         VALUES (?, ?, ?, ?, ?)`
        )
        .run(
            noteId,
            actorId,
            type,
            activityId || `https://remote.example.com/activities/${_seq++}`,
            ts || new Date().toISOString()
        );
}

function page(collName, options) {
    return new Promise((resolve, reject) =>
        Collection.getCollectionPage(collName, options, (err, r) =>
            err ? reject(err) : resolve(r)
        )
    );
}

function byContext(collName, contextId) {
    return new Promise((resolve, reject) =>
        Collection.getCollectionByContext(collName, contextId, (err, r) =>
            err ? reject(err) : resolve(r)
        )
    );
}

function batchCounts(noteIds) {
    return new Promise((resolve, reject) =>
        Collection.getReactionCountsBatch(noteIds, (err, r) =>
            err ? reject(err) : resolve(r)
        )
    );
}

// ─── getCollectionPage ────────────────────────────────────────────────────────

describe('Collection.getCollectionPage()', function () {
    it('returns empty rows when collection is empty', async () => {
        const r = await page(SHARED_INBOX, { pageSize: 5 });
        assert.equal(r.rows.length, 0);
        assert.equal(r.nextCursor, null);
    });

    it('returns items newest-first', async () => {
        insertNote(SHARED_INBOX, '2026-04-12T10:00:00Z');
        insertNote(SHARED_INBOX, '2026-04-12T12:00:00Z');
        insertNote(SHARED_INBOX, '2026-04-12T11:00:00Z');

        const r = await page(SHARED_INBOX, { pageSize: 10 });
        assert.equal(r.rows.length, 3);
        assert(r.rows[0].timestamp >= r.rows[1].timestamp, 'should be newest first');
        assert(r.rows[1].timestamp >= r.rows[2].timestamp);
    });

    it('nextCursor is null when all items fit in one page', async () => {
        insertNote(SHARED_INBOX, '2026-04-12T10:00:00Z');
        insertNote(SHARED_INBOX, '2026-04-12T11:00:00Z');

        const r = await page(SHARED_INBOX, { pageSize: 5 });
        assert.equal(r.rows.length, 2);
        assert.equal(r.nextCursor, null);
    });

    it('nextCursor is set and equals the last returned row timestamp when more items exist', async () => {
        insertNote(SHARED_INBOX, '2026-04-12T10:00:00Z');
        insertNote(SHARED_INBOX, '2026-04-12T11:00:00Z');
        insertNote(SHARED_INBOX, '2026-04-12T12:00:00Z');

        const r = await page(SHARED_INBOX, { pageSize: 2 });
        assert.equal(r.rows.length, 2);
        assert.notEqual(r.nextCursor, null);
        assert.equal(r.nextCursor, r.rows[1].timestamp);
    });

    it('cursor excludes items at or after the cursor timestamp', async () => {
        insertNote(SHARED_INBOX, '2026-04-12T10:00:00Z');
        insertNote(SHARED_INBOX, '2026-04-12T11:00:00Z');
        insertNote(SHARED_INBOX, '2026-04-12T12:00:00Z');

        //  First page returns top 2; use its nextCursor for page 2
        const page1 = await page(SHARED_INBOX, { pageSize: 2 });
        assert.equal(page1.rows.length, 2);

        const page2 = await page(SHARED_INBOX, { cursor: page1.nextCursor, pageSize: 2 });
        assert.equal(page2.rows.length, 1);
        assert.equal(page2.nextCursor, null);
        //  page2 item must be older than page1's last item
        assert(page2.rows[0].timestamp < page1.rows[1].timestamp);
    });

    it('returns all N items exactly when count equals pageSize', async () => {
        insertNote(SHARED_INBOX, '2026-04-12T10:00:00Z');
        insertNote(SHARED_INBOX, '2026-04-12T11:00:00Z');

        const r = await page(SHARED_INBOX, { pageSize: 2 });
        assert.equal(r.rows.length, 2);
        assert.equal(r.nextCursor, null);
    });

    it('filter.actorId returns only Notes attributed to that actor', async () => {
        const targetActor = 'https://remote.example.com/users/target';
        insertNote(SHARED_INBOX, '2026-04-12T10:00:00Z', { attributedTo: targetActor });
        insertNote(SHARED_INBOX, '2026-04-12T11:00:00Z'); // different actor
        insertNote(SHARED_INBOX, '2026-04-12T12:00:00Z', { attributedTo: targetActor });

        const r = await page(SHARED_INBOX, {
            pageSize: 10,
            filter: { actorId: targetActor },
        });
        assert.equal(r.rows.length, 2);
        for (const row of r.rows) {
            const act = JSON.parse(row.object_json);
            assert.equal(act.object.attributedTo, targetActor);
        }
    });

    it('filter.actorId returns empty when no Notes match', async () => {
        insertNote(SHARED_INBOX, '2026-04-12T10:00:00Z');
        const r = await page(SHARED_INBOX, {
            pageSize: 10,
            filter: { actorId: 'https://nobody.example.com/users/ghost' },
        });
        assert.equal(r.rows.length, 0);
    });

    it('filter.mentionsActorId matches Notes where actor appears in to field', async () => {
        const localActor = 'https://local.example.com/users/bob';
        insertNote(SHARED_INBOX, '2026-04-12T10:00:00Z', {
            to: [localActor, PUBLIC_COLL_ID],
        });
        insertNote(SHARED_INBOX, '2026-04-12T11:00:00Z'); // no mention

        const r = await page(SHARED_INBOX, {
            pageSize: 10,
            filter: { mentionsActorId: localActor },
        });
        assert.equal(r.rows.length, 1);
    });

    it('filter.mentionsActorId matches Notes where actor appears in cc field', async () => {
        const localActor = 'https://local.example.com/users/carol';
        insertNote(SHARED_INBOX, '2026-04-12T10:00:00Z', {
            cc: [localActor],
        });
        insertNote(SHARED_INBOX, '2026-04-12T11:00:00Z');

        const r = await page(SHARED_INBOX, {
            pageSize: 10,
            filter: { mentionsActorId: localActor },
        });
        assert.equal(r.rows.length, 1);
    });

    it('filter.mentionsActorId matches Notes where actor appears in tag field', async () => {
        const localActor = 'https://local.example.com/users/dave';
        insertNote(SHARED_INBOX, '2026-04-12T10:00:00Z', {
            tag: [{ type: 'Mention', href: localActor, name: '@dave@local.example.com' }],
        });
        insertNote(SHARED_INBOX, '2026-04-12T11:00:00Z');

        const r = await page(SHARED_INBOX, {
            pageSize: 10,
            filter: { mentionsActorId: localActor },
        });
        assert.equal(r.rows.length, 1);
    });

    it('does not cross-contaminate items from a different collection name', async () => {
        insertNote(SHARED_INBOX, '2026-04-12T10:00:00Z');
        insertNote('outbox', '2026-04-12T11:00:00Z');

        const r = await page(SHARED_INBOX, { pageSize: 10 });
        assert.equal(r.rows.length, 1);
        for (const row of r.rows) {
            assert.ok(row.object_json); // quick sanity: valid JSON row
        }
    });
});

// ─── getCollectionByContext ───────────────────────────────────────────────────

describe('Collection.getCollectionByContext()', function () {
    const CTX = 'https://remote.example.com/notes/thread-root';

    it('returns empty when nothing matches the context', async () => {
        insertNote(SHARED_INBOX, '2026-04-12T10:00:00Z');
        const r = await byContext(SHARED_INBOX, CTX);
        assert.equal(r.rows.length, 0);
        assert.equal(r.nextCursor, null);
    });

    it('returns Notes whose $.object.context matches', async () => {
        insertNote(SHARED_INBOX, '2026-04-12T10:00:00Z', { context: CTX });
        insertNote(SHARED_INBOX, '2026-04-12T11:00:00Z', { context: CTX });
        insertNote(SHARED_INBOX, '2026-04-12T12:00:00Z'); // no context

        const r = await byContext(SHARED_INBOX, CTX);
        assert.equal(r.rows.length, 2);
    });

    it('returns Notes whose $.object.conversation matches (Mastodon legacy field)', async () => {
        insertNote(SHARED_INBOX, '2026-04-12T10:00:00Z', { conversation: CTX });
        insertNote(SHARED_INBOX, '2026-04-12T11:00:00Z'); // unrelated

        const r = await byContext(SHARED_INBOX, CTX);
        assert.equal(r.rows.length, 1);
    });

    it('matches either context or conversation on different Notes in same thread', async () => {
        insertNote(SHARED_INBOX, '2026-04-12T10:00:00Z', { context: CTX });
        insertNote(SHARED_INBOX, '2026-04-12T11:00:00Z', { conversation: CTX });

        const r = await byContext(SHARED_INBOX, CTX);
        assert.equal(r.rows.length, 2);
    });

    it('returns rows in chronological order (ASC)', async () => {
        insertNote(SHARED_INBOX, '2026-04-12T12:00:00Z', { context: CTX });
        insertNote(SHARED_INBOX, '2026-04-12T10:00:00Z', { context: CTX });
        insertNote(SHARED_INBOX, '2026-04-12T11:00:00Z', { context: CTX });

        const r = await byContext(SHARED_INBOX, CTX);
        assert.equal(r.rows.length, 3);
        assert(r.rows[0].timestamp <= r.rows[1].timestamp, 'should be chronological');
        assert(r.rows[1].timestamp <= r.rows[2].timestamp);
    });

    it('does not return Notes from a different context', async () => {
        insertNote(SHARED_INBOX, '2026-04-12T10:00:00Z', { context: CTX });
        insertNote(SHARED_INBOX, '2026-04-12T11:00:00Z', {
            context: 'https://remote.example.com/notes/other-thread',
        });

        const r = await byContext(SHARED_INBOX, CTX);
        assert.equal(r.rows.length, 1);
    });

    it('does not cross-contaminate from a different collection name', async () => {
        insertNote(SHARED_INBOX, '2026-04-12T10:00:00Z', { context: CTX });
        insertNote('outbox', '2026-04-12T11:00:00Z', { context: CTX });

        const r = await byContext(SHARED_INBOX, CTX);
        assert.equal(r.rows.length, 1);
    });
});

// ─── getReactionCountsBatch ───────────────────────────────────────────────────

describe('Collection.getReactionCountsBatch()', function () {
    it('returns empty Map for empty noteIds array', async () => {
        const m = await batchCounts([]);
        assert.equal(m.size, 0);
    });

    it('returns empty Map when no reactions exist for the given note IDs', async () => {
        const m = await batchCounts(['https://remote.example.com/notes/ghost']);
        assert.equal(m.size, 0);
    });

    it('returns correct Like count for a single note', async () => {
        const noteId = 'https://remote.example.com/notes/single-like';
        insertReaction(noteId, 'https://a.example.com/users/alice', 'Like');
        insertReaction(noteId, 'https://b.example.com/users/bob', 'Like');

        const m = await batchCounts([noteId]);
        assert.equal(m.get(noteId).likes, 2);
        assert.equal(m.get(noteId).boosts, 0);
    });

    it('returns correct Announce (boost) count for a single note', async () => {
        const noteId = 'https://remote.example.com/notes/single-boost';
        insertReaction(noteId, 'https://a.example.com/users/alice', 'Announce');

        const m = await batchCounts([noteId]);
        assert.equal(m.get(noteId).likes, 0);
        assert.equal(m.get(noteId).boosts, 1);
    });

    it('returns both Like and Announce counts for the same note', async () => {
        const noteId = 'https://remote.example.com/notes/both';
        insertReaction(noteId, 'https://a.example.com/users/alice', 'Like');
        insertReaction(noteId, 'https://b.example.com/users/bob', 'Like');
        insertReaction(noteId, 'https://c.example.com/users/carol', 'Announce');

        const m = await batchCounts([noteId]);
        assert.equal(m.get(noteId).likes, 2);
        assert.equal(m.get(noteId).boosts, 1);
    });

    it('handles multiple note IDs in a single call', async () => {
        const note1 = 'https://remote.example.com/notes/batch-1';
        const note2 = 'https://remote.example.com/notes/batch-2';
        const note3 = 'https://remote.example.com/notes/batch-3'; // no reactions

        insertReaction(note1, 'https://a.example.com/users/alice', 'Like');
        insertReaction(note2, 'https://b.example.com/users/bob', 'Like');
        insertReaction(note2, 'https://c.example.com/users/carol', 'Announce');

        const m = await batchCounts([note1, note2, note3]);

        assert.equal(m.get(note1).likes, 1);
        assert.equal(m.get(note1).boosts, 0);

        assert.equal(m.get(note2).likes, 1);
        assert.equal(m.get(note2).boosts, 1);

        //  note3 has no reactions — absent from map
        assert.equal(m.has(note3), false);
    });

    it('does not include counts for note IDs not in the query', async () => {
        const queried = 'https://remote.example.com/notes/queried';
        const unrelated = 'https://remote.example.com/notes/unrelated';

        insertReaction(queried, 'https://a.example.com/users/alice', 'Like');
        insertReaction(unrelated, 'https://b.example.com/users/bob', 'Like');

        const m = await batchCounts([queried]);
        assert.equal(m.size, 1);
        assert.equal(m.get(queried).likes, 1);
        assert.equal(m.has(unrelated), false);
    });
});
