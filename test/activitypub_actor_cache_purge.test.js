'use strict';

//
//  #964 review: a fetched actor used to be cached under the id inside the
//  fetched document, so a cached actor's key may have been planted. The
//  activitypub database's actor cache is purged once, at user_version 2.
//

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');

const Logger = require('../core/logger.js');
const { migrateActivityPubActorCachePurge } = require('../core/database.js');

const ACTORS = 'https://www.w3.org/ns/activitystreams#PublicActors';

function buildApDb(version = 1) {
    const db = new Database(':memory:');
    db.exec(`
        CREATE TABLE collection (
            collection_id   VARCHAR NOT NULL,
            name            VARCHAR NOT NULL,
            timestamp       DATETIME NOT NULL,
            owner_actor_id  VARCHAR NOT NULL,
            object_id       VARCHAR NOT NULL,
            object_json     VARCHAR NOT NULL,
            is_private      INTEGER NOT NULL,
            UNIQUE(name, collection_id, object_id)
        );
        CREATE TABLE collection_object_meta (
            collection_id   VARCHAR NOT NULL,
            name            VARCHAR NOT NULL,
            object_id       VARCHAR NOT NULL,
            meta_name       VARCHAR NOT NULL,
            meta_value      VARCHAR NOT NULL,
            UNIQUE(collection_id, object_id, meta_name)
        );
        CREATE TABLE note_reactions (
            note_id         VARCHAR NOT NULL,
            actor_id        VARCHAR NOT NULL,
            reaction_type   VARCHAR NOT NULL,
            activity_id     VARCHAR NOT NULL,
            timestamp       DATETIME NOT NULL,
            UNIQUE(note_id, actor_id, reaction_type)
        );
    `);
    db.pragma(`user_version = ${version}`);
    return db;
}

function addRow(db, name, collectionId, objectId) {
    db.prepare(
        `INSERT INTO collection (collection_id, name, timestamp, owner_actor_id, object_id, object_json, is_private)
        VALUES (?, ?, '2026-10-29T12:00:00Z', 'owner', ?, ?, 0);`
    ).run(collectionId, name, objectId, JSON.stringify({ id: objectId, type: 'Person' }));
}

function buildPopulatedDb(version = 1) {
    const db = buildApDb(version);
    for (const n of [1, 2, 3]) {
        const id = `https://remote.example/users/u${n}`;
        addRow(db, 'actors', ACTORS, id);
        db.prepare(
            `INSERT INTO collection_object_meta (collection_id, name, object_id, meta_name, meta_value)
            VALUES (?, 'actors', ?, 'actor_subject', ?);`
        ).run(ACTORS, id, `@u${n}@remote.example`);
    }
    //  kept: follow relationships hold their own copy of the actor
    addRow(
        db,
        'followers',
        'https://bbs.example/users/bob/followers',
        'https://remote.example/users/u1'
    );
    addRow(
        db,
        'following',
        'https://bbs.example/users/bob/following',
        'https://remote.example/users/u2'
    );
    addRow(
        db,
        'sharedInbox',
        'https://www.w3.org/ns/activitystreams#Public',
        'https://remote.example/a/1'
    );
    db.prepare(
        `INSERT INTO note_reactions VALUES ('https://bbs.example/n/1', 'https://remote.example/users/u3', 'Like', 'https://remote.example/a/2', '2026-10-29');`
    ).run();
    return db;
}

const countIn = (db, name) =>
    db.prepare('SELECT COUNT(*) AS n FROM collection WHERE name = ?;').get(name).n;

describe('ActivityPub actor cache purge (#964 review)', function () {
    let savedLog;
    let logged;
    let savedConsoleError;
    let consoleErrors;

    beforeEach(function () {
        savedLog = Logger.log;
        logged = [];
        const record = level => (obj, msg) => logged.push({ level, obj, msg });
        Logger.log = {
            info: record('info'),
            warn: record('warn'),
            error: record('error'),
            debug() {},
            trace() {},
            child() {
                return this;
            },
        };
        savedConsoleError = console.error; //  eslint-disable-line no-console
        consoleErrors = [];
        console.error = msg => consoleErrors.push(msg); //  eslint-disable-line no-console
    });

    afterEach(function () {
        Logger.log = savedLog;
        console.error = savedConsoleError; //  eslint-disable-line no-console
    });

    it('removes every cached actor and its meta, and nothing else', function () {
        const db = buildPopulatedDb();

        migrateActivityPubActorCachePurge(db);

        assert.equal(db.pragma('user_version', { simple: true }), 2);
        assert.equal(countIn(db, 'actors'), 0);
        assert.equal(
            db
                .prepare(
                    `SELECT COUNT(*) AS n FROM collection_object_meta WHERE name = 'actors';`
                )
                .get().n,
            0
        );
        assert.equal(countIn(db, 'followers'), 1);
        assert.equal(countIn(db, 'following'), 1);
        assert.equal(countIn(db, 'sharedInbox'), 1);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM note_reactions;').get().n, 1);

        const infos = logged.filter(l => l.level === 'info');
        assert.equal(infos.length, 2);
        assert.equal(infos[0].obj.rowCount, 3);
        assert.equal(infos[1].obj.actors, 3);
        assert.equal(infos[1].obj.meta, 3);
        assert.equal(typeof infos[1].obj.durationMs, 'number');
    });

    it('runs once', function () {
        const db = buildPopulatedDb();
        migrateActivityPubActorCachePurge(db);
        logged.length = 0;

        //  actors cached after the purge are fetched under the new rules
        addRow(db, 'actors', ACTORS, 'https://remote.example/users/new');
        migrateActivityPubActorCachePurge(db);

        assert.equal(countIn(db, 'actors'), 1);
        assert.deepEqual(logged, []);
    });

    it('a database with nothing cached only records the version', function () {
        const db = buildApDb();
        migrateActivityPubActorCachePurge(db);
        assert.equal(db.pragma('user_version', { simple: true }), 2);
        assert.deepEqual(logged, []);
    });

    it('waits for the version 1 migration', function () {
        const db = buildPopulatedDb(0);
        migrateActivityPubActorCachePurge(db);
        assert.equal(db.pragma('user_version', { simple: true }), 0);
        assert.equal(countIn(db, 'actors'), 3);
    });

    it('does not run inside a transaction the caller opened', function () {
        const db = buildPopulatedDb();
        db.transaction(() => migrateActivityPubActorCachePurge(db))();
        assert.equal(db.pragma('user_version', { simple: true }), 1);
        assert.equal(countIn(db, 'actors'), 3);
        assert.equal(consoleErrors.length, 1);
        assert.match(consoleErrors[0], /actor cache inside an open transaction/);

        migrateActivityPubActorCachePurge(db);
        assert.equal(countIn(db, 'actors'), 0);
    });
});
