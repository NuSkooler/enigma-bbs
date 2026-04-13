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
//  In-memory AP DB
//
const dbModule = require('../core/database.js');
const _apDb = new Database(':memory:');
_apDb.pragma('foreign_keys = ON');
dbModule.dbs.activitypub = _apDb;

//
//  Force fresh loads so AP modules see our in-memory DB.
//
[
    '../core/web_util.js',
    '../core/activitypub/endpoint.js',
    '../core/activitypub/object.js',
    '../core/activitypub/collection.js',
    '../core/activitypub/actor.js',
].forEach(m => delete require.cache[require.resolve(m)]);

const Collection = require('../core/activitypub/collection.js');
const Actor = require('../core/activitypub/actor.js');

// ─── schema (full activitypub schema including FTS5) ─────────────────────────

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

        CREATE VIRTUAL TABLE IF NOT EXISTS collection_fts USING fts5(
            coll_name   UNINDEXED,
            object_id   UNINDEXED,
            body,
            tags
        );

        CREATE TRIGGER IF NOT EXISTS collection_fts_actor_ai
        AFTER INSERT ON collection WHEN new.name = 'actors'
        BEGIN
            INSERT INTO collection_fts(rowid, coll_name, object_id, body, tags)
            VALUES (
                new.rowid, 'actors', new.object_id,
                COALESCE(json_extract(new.object_json, '$.preferredUsername'), '') || ' ' ||
                COALESCE(json_extract(new.object_json, '$.name'), '') || ' ' ||
                COALESCE(json_extract(new.object_json, '$.summary'), ''),
                ''
            );
        END;

        CREATE TRIGGER IF NOT EXISTS collection_fts_actor_au
        AFTER UPDATE OF object_json ON collection WHEN new.name = 'actors'
        BEGIN
            DELETE FROM collection_fts WHERE rowid = old.rowid;
            INSERT INTO collection_fts(rowid, coll_name, object_id, body, tags)
            VALUES (
                new.rowid, 'actors', new.object_id,
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

        CREATE TRIGGER IF NOT EXISTS collection_fts_actor_bd
        BEFORE DELETE ON collection WHEN old.name = 'actors'
        BEGIN
            DELETE FROM collection_fts WHERE rowid = old.rowid;
        END;

        CREATE TRIGGER IF NOT EXISTS collection_fts_subject_ai
        AFTER INSERT ON collection_object_meta
        WHEN new.name = 'actors' AND new.meta_name = 'actor_subject'
        BEGIN
            UPDATE collection_fts SET tags = new.meta_value
            WHERE rowid = (
                SELECT rowid FROM collection
                WHERE object_id = new.object_id AND name = 'actors' LIMIT 1
            );
        END;

        CREATE TRIGGER IF NOT EXISTS collection_fts_subject_au
        AFTER UPDATE ON collection_object_meta
        WHEN new.name = 'actors' AND new.meta_name = 'actor_subject'
        BEGIN
            UPDATE collection_fts SET tags = new.meta_value
            WHERE rowid = (
                SELECT rowid FROM collection
                WHERE object_id = new.object_id AND name = 'actors' LIMIT 1
            );
        END;

        CREATE TRIGGER IF NOT EXISTS collection_fts_note_ai
        AFTER INSERT ON collection WHEN new.name = 'sharedInbox'
        BEGIN
            INSERT INTO collection_fts(rowid, coll_name, object_id, body, tags)
            VALUES (
                new.rowid, 'sharedInbox', new.object_id,
                COALESCE(json_extract(new.object_json, '$.summary'), '') || ' ' ||
                COALESCE(json_extract(new.object_json, '$.content'), ''),
                ''
            );
        END;

        CREATE TRIGGER IF NOT EXISTS collection_fts_note_au
        AFTER UPDATE OF object_json ON collection WHEN new.name = 'sharedInbox'
        BEGIN
            DELETE FROM collection_fts WHERE rowid = old.rowid;
            INSERT INTO collection_fts(rowid, coll_name, object_id, body, tags)
            VALUES (
                new.rowid, 'sharedInbox', new.object_id,
                COALESCE(json_extract(new.object_json, '$.summary'), '') || ' ' ||
                COALESCE(json_extract(new.object_json, '$.content'), ''),
                ''
            );
        END;

        CREATE TRIGGER IF NOT EXISTS collection_fts_note_bd
        BEFORE DELETE ON collection WHEN old.name = 'sharedInbox'
        BEGIN
            DELETE FROM collection_fts WHERE rowid = old.rowid;
        END;
    `);
});

beforeEach(() => {
    _apDb.exec('DELETE FROM collection_object_meta; DELETE FROM collection;');
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeActor(id, preferredUsername, name, summary = '') {
    return new Actor({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id,
        type: 'Person',
        preferredUsername,
        name,
        summary,
        inbox: `${id}/inbox`,
        outbox: `${id}/outbox`,
        followers: `${id}/followers`,
        following: `${id}/following`,
    });
}

function addNote(id, summary, content) {
    const note = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id,
        type: 'Note',
        summary: summary || '',
        content: content || '',
        attributedTo: 'https://remote.example.com/users/alice',
        to: ['https://www.w3.org/ns/activitystreams#Public'],
    };
    _apDb
        .prepare(
            `INSERT INTO collection (collection_id, name, timestamp, owner_actor_id, object_id, object_json, is_private)
             VALUES (?, 'sharedInbox', datetime('now'), 'https://www.w3.org/ns/activitystreams#Public', ?, ?, 0)`
        )
        .run('https://www.w3.org/ns/activitystreams#Public', id, JSON.stringify(note));
}

function search(fn, term) {
    return new Promise((resolve, reject) =>
        fn(term, (err, results) => (err ? reject(err) : resolve(results)))
    );
}

// ─── Actor FTS — basic search ─────────────────────────────────────────────────

describe('Collection.searchActors() — basic body search', function () {
    it('finds an actor by preferredUsername', async () => {
        const actor = makeActor(
            'https://remote.example.com/users/alice',
            'alice',
            'Alice Smith'
        );
        await new Promise((res, rej) =>
            Collection.addActor(actor, '@alice@remote.example.com', err =>
                err ? rej(err) : res()
            )
        );

        const results = await search(Collection.searchActors.bind(Collection), 'alice');
        assert.equal(results.length, 1);
        assert.equal(results[0].actor.id, 'https://remote.example.com/users/alice');
    });

    it('finds an actor by display name', async () => {
        const actor = makeActor(
            'https://remote.example.com/users/bob',
            'bob',
            'Bob Jones'
        );
        await new Promise((res, rej) =>
            Collection.addActor(actor, '@bob@remote.example.com', err =>
                err ? rej(err) : res()
            )
        );

        const results = await search(Collection.searchActors.bind(Collection), 'Jones');
        assert.equal(results.length, 1);
        assert.equal(results[0].actor.preferredUsername, 'bob');
    });

    it('finds an actor by summary text', async () => {
        const actor = makeActor(
            'https://remote.example.com/users/carol',
            'carol',
            'Carol White',
            'Retro BBS enthusiast'
        );
        await new Promise((res, rej) =>
            Collection.addActor(actor, '@carol@remote.example.com', err =>
                err ? rej(err) : res()
            )
        );

        const results = await search(
            Collection.searchActors.bind(Collection),
            'enthusiast'
        );
        assert.equal(results.length, 1);
        assert.equal(results[0].actor.preferredUsername, 'carol');
    });

    it('returns empty array when no actor matches', async () => {
        const actor = makeActor(
            'https://remote.example.com/users/dave',
            'dave',
            'Dave Brown'
        );
        await new Promise((res, rej) =>
            Collection.addActor(actor, '@dave@remote.example.com', err =>
                err ? rej(err) : res()
            )
        );

        const results = await search(
            Collection.searchActors.bind(Collection),
            'zzznomatch'
        );
        assert.equal(results.length, 0);
    });

    it('returns the actor subject alongside the actor object', async () => {
        const actor = makeActor(
            'https://remote.example.com/users/eve',
            'eve',
            'Eve Green'
        );
        await new Promise((res, rej) =>
            Collection.addActor(actor, '@eve@remote.example.com', err =>
                err ? rej(err) : res()
            )
        );

        const results = await search(Collection.searchActors.bind(Collection), 'eve');
        assert.equal(results.length, 1);
        assert.equal(results[0].subject, '@eve@remote.example.com');
    });

    it('actor search does not return sharedInbox notes', async () => {
        addNote('https://remote.example.com/notes/1', '', '<p>alice in wonderland</p>');

        //  'alice' is in the note content — should NOT appear in actor search
        const results = await search(Collection.searchActors.bind(Collection), 'alice');
        assert.equal(results.length, 0);
    });
});

// ─── Actor FTS — subject (tags) search ───────────────────────────────────────

describe('Collection.searchActors() — subject (tags) search', function () {
    it('finds an actor by @user@host subject via tags column', async () => {
        const actor = makeActor('https://mastodon.social/users/frank', 'frank', 'Frank');
        await new Promise((res, rej) =>
            Collection.addActor(actor, '@frank@mastodon.social', err =>
                err ? rej(err) : res()
            )
        );

        //  Search specifically in the tags column
        const results = await search(
            Collection.searchActors.bind(Collection),
            'tags:frank'
        );
        assert.equal(results.length, 1);
        assert.equal(results[0].subject, '@frank@mastodon.social');
    });

    it('subject tag is updated when actor is refreshed via addActor (REPLACE INTO)', async () => {
        const id = 'https://remote.example.com/users/gina';
        const actor = makeActor(id, 'gina', 'Gina Old');
        await new Promise((res, rej) =>
            Collection.addActor(actor, '@gina@remote.example.com', err =>
                err ? rej(err) : res()
            )
        );

        //  Update the actor (REPLACE INTO fires delete + insert)
        const updated = makeActor(id, 'gina', 'Gina Updated');
        await new Promise((res, rej) =>
            Collection.addActor(updated, '@gina@remote.example.com', err =>
                err ? rej(err) : res()
            )
        );

        const results = await search(Collection.searchActors.bind(Collection), 'Updated');
        assert.equal(results.length, 1, 'updated display name should be indexed');
    });
});

// ─── Actor FTS — delete removes from index ───────────────────────────────────

describe('Collection.searchActors() — delete removes from index', function () {
    it('deleted actor no longer appears in search results', async () => {
        const actor = makeActor(
            'https://remote.example.com/users/hank',
            'hank',
            'Hank Taylor'
        );
        await new Promise((res, rej) =>
            Collection.addActor(actor, '@hank@remote.example.com', err =>
                err ? rej(err) : res()
            )
        );

        // Verify it's findable before delete
        const before = await search(Collection.searchActors.bind(Collection), 'hank');
        assert.equal(before.length, 1);

        // Delete via Collection (triggers BEFORE DELETE on collection)
        _apDb
            .prepare(`DELETE FROM collection WHERE name = 'actors' AND object_id = ?`)
            .run('https://remote.example.com/users/hank');

        const after = await search(Collection.searchActors.bind(Collection), 'hank');
        assert.equal(after.length, 0, 'deleted actor should not appear in FTS');
    });
});

// ─── Note FTS — basic search ──────────────────────────────────────────────────

describe('Collection.searchNotes() — basic content search', function () {
    it('finds a note by content keyword', async () => {
        addNote(
            'https://remote.example.com/notes/1',
            '',
            '<p>Hello from the retroverse</p>'
        );

        const results = await search(
            Collection.searchNotes.bind(Collection),
            'retroverse'
        );
        assert.equal(results.length, 1);
        assert.equal(results[0].id, 'https://remote.example.com/notes/1');
    });

    it('finds a note by summary text', async () => {
        addNote(
            'https://remote.example.com/notes/2',
            'BBS culture weekly',
            '<p>Some content</p>'
        );

        const results = await search(Collection.searchNotes.bind(Collection), 'weekly');
        assert.equal(results.length, 1);
        assert.equal(results[0].id, 'https://remote.example.com/notes/2');
    });

    it('finds notes containing hashtag words', async () => {
        addNote(
            'https://remote.example.com/notes/3',
            '',
            '<p>Check out <a href="#">#fidonet</a> today</p>'
        );

        //  FTS tokenizer strips # so searching 'fidonet' matches
        const results = await search(Collection.searchNotes.bind(Collection), 'fidonet');
        assert.equal(results.length, 1);
    });

    it('returns empty array when no note matches', async () => {
        addNote(
            'https://remote.example.com/notes/4',
            '',
            '<p>Completely unrelated content</p>'
        );

        const results = await search(
            Collection.searchNotes.bind(Collection),
            'zzznomatch'
        );
        assert.equal(results.length, 0);
    });

    it('note search does not return actors', async () => {
        const actor = makeActor(
            'https://remote.example.com/users/ivan',
            'ivan',
            'Ivan Petrov'
        );
        await new Promise((res, rej) =>
            Collection.addActor(actor, '@ivan@remote.example.com', err =>
                err ? rej(err) : res()
            )
        );

        //  'ivan' is in an actor, not a note
        const results = await search(Collection.searchNotes.bind(Collection), 'ivan');
        assert.equal(results.length, 0);
    });

    it('multiple notes are ranked by relevance', async () => {
        addNote(
            'https://remote.example.com/notes/5',
            'bbs bbs bbs',
            '<p>bbs content</p>'
        );
        addNote('https://remote.example.com/notes/6', '', '<p>mentions bbs once</p>');

        const results = await search(Collection.searchNotes.bind(Collection), 'bbs');
        assert.equal(results.length, 2);
        //  The note with 'bbs' in both summary and content should rank higher
        assert.equal(results[0].id, 'https://remote.example.com/notes/5');
    });
});

// ─── Note FTS — delete and update ────────────────────────────────────────────

describe('Collection.searchNotes() — delete and update', function () {
    it('deleted note no longer appears in search', async () => {
        const id = 'https://remote.example.com/notes/del-1';
        addNote(id, '', '<p>unique keyword xyzplugh</p>');

        const before = await search(Collection.searchNotes.bind(Collection), 'xyzplugh');
        assert.equal(before.length, 1);

        _apDb
            .prepare(
                `DELETE FROM collection WHERE name = 'sharedInbox' AND object_id = ?`
            )
            .run(id);

        const after = await search(Collection.searchNotes.bind(Collection), 'xyzplugh');
        assert.equal(after.length, 0);
    });

    it('updated note content is re-indexed', async () => {
        const id = 'https://remote.example.com/notes/upd-1';
        addNote(id, '', '<p>original xylophone content</p>');

        //  Update the object_json (simulates Update activity)
        const updatedNote = {
            '@context': 'https://www.w3.org/ns/activitystreams',
            id,
            type: 'Note',
            summary: '',
            content: '<p>completely different banjo content</p>',
            attributedTo: 'https://remote.example.com/users/alice',
        };
        _apDb
            .prepare(
                `UPDATE collection SET object_json = ? WHERE name = 'sharedInbox' AND object_id = ?`
            )
            .run(JSON.stringify(updatedNote), id);

        const oldTerm = await search(
            Collection.searchNotes.bind(Collection),
            'xylophone'
        );
        assert.equal(oldTerm.length, 0, 'old content should no longer match');

        const newTerm = await search(Collection.searchNotes.bind(Collection), 'banjo');
        assert.equal(newTerm.length, 1, 'new content should be indexed');
    });
});

// ─── maxResults parameter ─────────────────────────────────────────────────────

describe('Collection.searchActors() / searchNotes() — maxResults', function () {
    it('searchActors respects maxResults limit', async () => {
        for (let i = 0; i < 5; i++) {
            const actor = makeActor(
                `https://remote.example.com/users/user${i}`,
                `user${i}`,
                `User Number${i}`
            );
            await new Promise((res, rej) =>
                Collection.addActor(actor, `@user${i}@remote.example.com`, err =>
                    err ? rej(err) : res()
                )
            );
        }

        const results = await new Promise((res, rej) =>
            Collection.searchActors('User', 3, (err, r) => (err ? rej(err) : res(r)))
        );
        assert.equal(results.length, 3);
    });

    it('searchNotes respects maxResults limit', async () => {
        for (let i = 0; i < 5; i++) {
            addNote(
                `https://remote.example.com/notes/limit${i}`,
                '',
                `<p>common keyword spork note number ${i}</p>`
            );
        }

        const results = await new Promise((res, rej) =>
            Collection.searchNotes('spork', 2, (err, r) => (err ? rej(err) : res(r)))
        );
        assert.equal(results.length, 2);
    });
});
