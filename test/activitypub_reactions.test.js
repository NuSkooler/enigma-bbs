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
//  Logger stub.
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
//  In-memory activitypub DB injected before requiring collection.js.
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

before(() => {
    configModule.get = () => TEST_CONFIG;
});

// ─── schema ───────────────────────────────────────────────────────────────────

before(() => {
    _apDb.exec(`
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
});

beforeEach(() => {
    _apDb.exec(
        'DELETE FROM note_reactions; DELETE FROM collection_object_meta; DELETE FROM collection;'
    );
});

// ─── helpers ──────────────────────────────────────────────────────────────────

let seq = 0;
function makeIds() {
    const n = ++seq;
    return {
        noteId: `https://local.example.com/notes/${n}`,
        actorId: `https://remote.example.com/users/actor${n}`,
        activityId: `https://remote.example.com/activities/${n}`,
    };
}

function addReaction(noteId, actorId, type, activityId) {
    return new Promise((resolve, reject) => {
        Collection.addReaction(noteId, actorId, type, activityId, err =>
            err ? reject(err) : resolve()
        );
    });
}

function removeReaction(activityId) {
    return new Promise((resolve, reject) => {
        Collection.removeReactionByActivityId(activityId, err =>
            err ? reject(err) : resolve()
        );
    });
}

function getActors(noteId, type) {
    return new Promise((resolve, reject) => {
        Collection.getReactionActors(noteId, type, (err, actors) =>
            err ? reject(err) : resolve(actors)
        );
    });
}

function getCount(noteId, type) {
    return new Promise((resolve, reject) => {
        Collection.getReactionCount(noteId, type, (err, n) =>
            err ? reject(err) : resolve(n)
        );
    });
}

// ─── Collection.addReaction ───────────────────────────────────────────────────

describe('Collection.addReaction()', function () {
    it('inserts a Like reaction row', async () => {
        const { noteId, actorId, activityId } = makeIds();
        await addReaction(noteId, actorId, 'Like', activityId);
        const row = _apDb
            .prepare('SELECT * FROM note_reactions WHERE note_id = ? AND actor_id = ?')
            .get(noteId, actorId);
        assert.ok(row);
        assert.equal(row.reaction_type, 'Like');
        assert.equal(row.activity_id, activityId);
    });

    it('inserts an Announce reaction row', async () => {
        const { noteId, actorId, activityId } = makeIds();
        await addReaction(noteId, actorId, 'Announce', activityId);
        const row = _apDb
            .prepare('SELECT * FROM note_reactions WHERE note_id = ? AND actor_id = ?')
            .get(noteId, actorId);
        assert.ok(row);
        assert.equal(row.reaction_type, 'Announce');
    });

    it('is idempotent — duplicate call updates activity_id', async () => {
        const { noteId, actorId, activityId } = makeIds();
        const activityId2 = activityId + '-redo';
        await addReaction(noteId, actorId, 'Like', activityId);
        await addReaction(noteId, actorId, 'Like', activityId2);
        const count = _apDb
            .prepare(
                `SELECT COUNT(*) AS n FROM note_reactions
                 WHERE note_id = ? AND actor_id = ? AND reaction_type = 'Like'`
            )
            .get(noteId, actorId).n;
        assert.equal(count, 1, 'should remain one row');
        const row = _apDb
            .prepare(
                'SELECT activity_id FROM note_reactions WHERE note_id = ? AND actor_id = ?'
            )
            .get(noteId, actorId);
        assert.equal(row.activity_id, activityId2, 'activity_id should be updated');
    });

    it('allows the same actor to react with both Like and Announce', async () => {
        const { noteId, actorId } = makeIds();
        await addReaction(noteId, actorId, 'Like', 'like-act-1');
        await addReaction(noteId, actorId, 'Announce', 'ann-act-1');
        const count = _apDb
            .prepare(
                'SELECT COUNT(*) AS n FROM note_reactions WHERE note_id = ? AND actor_id = ?'
            )
            .get(noteId, actorId).n;
        assert.equal(count, 2, 'Like and Announce are distinct reaction types');
    });

    it('allows different actors to react to the same note', async () => {
        const { noteId } = makeIds();
        const { actorId: a1, activityId: act1 } = makeIds();
        const { actorId: a2, activityId: act2 } = makeIds();
        await addReaction(noteId, a1, 'Like', act1);
        await addReaction(noteId, a2, 'Like', act2);
        const count = _apDb
            .prepare(
                `SELECT COUNT(*) AS n FROM note_reactions WHERE note_id = ? AND reaction_type = 'Like'`
            )
            .get(noteId).n;
        assert.equal(count, 2);
    });
});

// ─── Collection.removeReactionByActivityId ────────────────────────────────────

describe('Collection.removeReactionByActivityId()', function () {
    it('removes the reaction row for the given activity_id', async () => {
        const { noteId, actorId, activityId } = makeIds();
        await addReaction(noteId, actorId, 'Like', activityId);
        await removeReaction(activityId);
        const row = _apDb
            .prepare('SELECT * FROM note_reactions WHERE activity_id = ?')
            .get(activityId);
        assert.ok(!row, 'reaction row should be gone');
    });

    it('no-ops silently when the activity_id is not found', async () => {
        await removeReaction('https://remote.example.com/activities/nonexistent');
        // no error = pass
    });

    it('only removes the matching reaction, not others on the same note', async () => {
        const { noteId } = makeIds();
        const { actorId: a1, activityId: act1 } = makeIds();
        const { actorId: a2, activityId: act2 } = makeIds();
        await addReaction(noteId, a1, 'Like', act1);
        await addReaction(noteId, a2, 'Like', act2);
        await removeReaction(act1);
        const count = _apDb
            .prepare(
                `SELECT COUNT(*) AS n FROM note_reactions WHERE note_id = ? AND reaction_type = 'Like'`
            )
            .get(noteId).n;
        assert.equal(count, 1, 'only one reaction should remain');
    });
});

// ─── Collection.getReactionActors ─────────────────────────────────────────────

describe('Collection.getReactionActors()', function () {
    it('returns empty array when no reactions exist', async () => {
        const { noteId } = makeIds();
        const actors = await getActors(noteId, 'Like');
        assert.deepEqual(actors, []);
    });

    it('returns actor IDs for all Like reactions on a note', async () => {
        const { noteId } = makeIds();
        const { actorId: a1, activityId: act1 } = makeIds();
        const { actorId: a2, activityId: act2 } = makeIds();
        await addReaction(noteId, a1, 'Like', act1);
        await addReaction(noteId, a2, 'Like', act2);
        const actors = await getActors(noteId, 'Like');
        assert.equal(actors.length, 2);
        assert.ok(actors.includes(a1));
        assert.ok(actors.includes(a2));
    });

    it('does not include Announce actors when querying for Like', async () => {
        const { noteId } = makeIds();
        const { actorId: a1, activityId: act1 } = makeIds();
        const { actorId: a2, activityId: act2 } = makeIds();
        await addReaction(noteId, a1, 'Like', act1);
        await addReaction(noteId, a2, 'Announce', act2);
        const likers = await getActors(noteId, 'Like');
        assert.equal(likers.length, 1);
        assert.equal(likers[0], a1);
    });

    it('does not include reactions for other notes', async () => {
        const { noteId: note1 } = makeIds();
        const { noteId: note2 } = makeIds();
        const { actorId, activityId } = makeIds();
        await addReaction(note1, actorId, 'Like', activityId);
        const actors = await getActors(note2, 'Like');
        assert.deepEqual(actors, []);
    });
});

// ─── Collection.getReactionCount ──────────────────────────────────────────────

describe('Collection.getReactionCount()', function () {
    it('returns 0 when no reactions exist', async () => {
        const { noteId } = makeIds();
        assert.equal(await getCount(noteId, 'Like'), 0);
    });

    it('returns correct count for Like reactions', async () => {
        const { noteId } = makeIds();
        const { actorId: a1, activityId: act1 } = makeIds();
        const { actorId: a2, activityId: act2 } = makeIds();
        const { actorId: a3, activityId: act3 } = makeIds();
        await addReaction(noteId, a1, 'Like', act1);
        await addReaction(noteId, a2, 'Like', act2);
        await addReaction(noteId, a3, 'Like', act3);
        assert.equal(await getCount(noteId, 'Like'), 3);
    });

    it('counts Like and Announce independently', async () => {
        const { noteId } = makeIds();
        const { actorId: a1, activityId: act1 } = makeIds();
        const { actorId: a2, activityId: act2 } = makeIds();
        await addReaction(noteId, a1, 'Like', act1);
        await addReaction(noteId, a2, 'Announce', act2);
        assert.equal(await getCount(noteId, 'Like'), 1);
        assert.equal(await getCount(noteId, 'Announce'), 1);
    });

    it('decrements after removeReactionByActivityId', async () => {
        const { noteId } = makeIds();
        const { actorId, activityId } = makeIds();
        await addReaction(noteId, actorId, 'Like', activityId);
        assert.equal(await getCount(noteId, 'Like'), 1);
        await removeReaction(activityId);
        assert.equal(await getCount(noteId, 'Like'), 0);
    });
});
