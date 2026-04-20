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
//  Force fresh loads so modules capture our stubs.
//
delete require.cache[require.resolve('../core/web_util.js')];
delete require.cache[require.resolve('../core/activitypub/endpoint.js')];
delete require.cache[require.resolve('../core/activitypub/object.js')];
delete require.cache[require.resolve('../core/activitypub/collection.js')];
delete require.cache[require.resolve('../core/activitypub/actor.js')];

const Collection = require('../core/activitypub/collection.js');
const Actor = require('../core/activitypub/actor.js');

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
    `);
});

beforeEach(() => {
    _apDb.exec('DELETE FROM collection_object_meta; DELETE FROM collection;');
});

// ─── helpers ─────────────────────────────────────────────────────────────────

const ACTOR_ID = 'https://remote.example.com/users/alice';
const ACTOR_SUBJECT = '@alice@remote.example.com';

function makeRemoteActorJson(id = ACTOR_ID) {
    return {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id,
        type: 'Person',
        preferredUsername: 'alice',
        inbox: `${id}/inbox`,
        outbox: `${id}/outbox`,
        followers: `${id}/followers`,
        following: `${id}/following`,
    };
}

// Insert an actor row with a specific timestamp (days relative to now, negative = past)
function insertActorWithAge(daysAgo, id = ACTOR_ID, subject = ACTOR_SUBJECT) {
    const actor = makeRemoteActorJson(id);
    // Use SQLite datetime arithmetic to set the timestamp
    const timestamp = `datetime('now', '${-daysAgo} days')`;
    const { ActorCollectionId } = require('../core/activitypub/const.js');
    const { PublicCollectionId } = require('../core/activitypub/const.js');

    _apDb
        .prepare(
            `
        INSERT INTO collection (collection_id, name, timestamp, owner_actor_id, object_id, object_json, is_private)
        VALUES (?, ?, ${timestamp}, ?, ?, ?, 0)
    `
        )
        .run(ActorCollectionId, 'actors', PublicCollectionId, id, JSON.stringify(actor));

    _apDb
        .prepare(
            `
        INSERT INTO collection_object_meta (collection_id, name, object_id, meta_name, meta_value)
        VALUES (?, ?, ?, ?, ?)
    `
        )
        .run(ActorCollectionId, 'actors', id, 'actor_subject', subject);
}

function fromCache(actorId) {
    return new Promise((resolve, reject) => {
        Actor._fromCache(actorId, (err, actor, subject, needsRefresh) => {
            if (err) return reject(err);
            resolve({ actor, subject, needsRefresh });
        });
    });
}

// ─── Actor._fromCache — cache miss ───────────────────────────────────────────

describe('Actor._fromCache() — cache miss', function () {
    it('returns DoesNotExist error when actor is not in cache', done => {
        Actor._fromCache(ACTOR_ID, err => {
            assert.ok(err, 'should error on cache miss');
            assert.ok(
                err.message.includes('No Actor found') || err.code || err.name,
                `unexpected error: ${err.message}`
            );
            done();
        });
    });
});

// ─── Actor._fromCache — cache hit (fresh) ────────────────────────────────────

describe('Actor._fromCache() — fresh cache hit', function () {
    it('returns the actor and needsRefresh=false when entry is recent (< 15 days)', async () => {
        insertActorWithAge(1); // 1 day old → fresh
        const { actor, subject, needsRefresh } = await fromCache(ACTOR_ID);
        assert.ok(actor, 'should return an actor');
        assert.equal(actor.id, ACTOR_ID);
        assert.equal(subject, ACTOR_SUBJECT);
        assert.equal(needsRefresh, false, 'fresh entry should not need refresh');
    });

    it('needsRefresh=false for a same-day entry', async () => {
        insertActorWithAge(0); // just added
        const { needsRefresh } = await fromCache(ACTOR_ID);
        assert.equal(needsRefresh, false);
    });
});

// ─── Actor._fromCache — stale hit (needsRefresh) ─────────────────────────────

describe('Actor._fromCache() — stale cache hit', function () {
    it('returns the actor and needsRefresh=true when entry is >= 15 days old', async () => {
        insertActorWithAge(20); // 20 days old → stale (> 15-day refresh threshold)
        const { actor, needsRefresh } = await fromCache(ACTOR_ID);
        assert.ok(actor, 'should still return the actor');
        assert.equal(actor.id, ACTOR_ID);
        assert.equal(needsRefresh, true, 'stale entry should need refresh');
    });
});

// ─── Collection.removeExpiredActors ──────────────────────────────────────────

describe('Collection.removeExpiredActors()', function () {
    it('removes actors older than maxAgeDays', done => {
        insertActorWithAge(130); // 130 days → expired (> 125-day deletion threshold)
        Collection.removeExpiredActors(125, err => {
            assert.ifError(err);
            const count = _apDb.prepare('SELECT COUNT(*) AS n FROM collection').get().n;
            assert.equal(count, 0, 'expired actor should have been removed');
            done();
        });
    });

    it('keeps actors younger than maxAgeDays', done => {
        insertActorWithAge(30); // 30 days → not expired
        Collection.removeExpiredActors(125, err => {
            assert.ifError(err);
            const count = _apDb.prepare('SELECT COUNT(*) AS n FROM collection').get().n;
            assert.equal(count, 1, 'fresh actor should be kept');
            done();
        });
    });

    it('removes expired but keeps fresh when both exist', done => {
        insertActorWithAge(
            130,
            'https://remote.example.com/users/old',
            '@old@remote.example.com'
        );
        insertActorWithAge(
            10,
            'https://remote.example.com/users/fresh',
            '@fresh@remote.example.com'
        );
        Collection.removeExpiredActors(125, err => {
            assert.ifError(err);
            const count = _apDb.prepare('SELECT COUNT(*) AS n FROM collection').get().n;
            assert.equal(count, 1, 'only fresh actor should remain');
            const row = _apDb.prepare('SELECT object_id FROM collection LIMIT 1').get();
            assert.ok(
                row.object_id.includes('fresh'),
                'remaining actor should be the fresh one'
            );
            done();
        });
    });
});

// ─── Collection.addActor + actor() round-trip ────────────────────────────────

describe('Collection.addActor() + Collection.actor() round-trip', function () {
    it('stores and retrieves an actor by id', done => {
        const actor = new (require('../core/activitypub/actor.js'))(
            makeRemoteActorJson()
        );
        Collection.addActor(actor, ACTOR_SUBJECT, err => {
            assert.ifError(err);
            Collection.actor(ACTOR_ID, (err, retrieved, info) => {
                assert.ifError(err);
                assert.equal(retrieved.id, ACTOR_ID);
                assert.equal(info.subject, ACTOR_SUBJECT);
                done();
            });
        });
    });

    it('stores and retrieves an actor by subject', done => {
        const actor = new (require('../core/activitypub/actor.js'))(
            makeRemoteActorJson()
        );
        Collection.addActor(actor, ACTOR_SUBJECT, err => {
            assert.ifError(err);
            Collection.actor(ACTOR_SUBJECT, (err, retrieved) => {
                assert.ifError(err);
                assert.equal(retrieved.id, ACTOR_ID);
                done();
            });
        });
    });
});
