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
    contentServers: { web: { domain: 'test.example.com', port: 443, https: true } },
};
configModule.get = () => TEST_CONFIG;

//
//  Logger mock — collection.js captures Log.log at load time; stub it out so
//  _removeByLogHelper doesn't crash when Log.log is undefined.
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
//  In-memory activitypub DB — injected before requiring collection.js, which
//  captures dbs.activitypub at module load time.
//
const dbModule = require('../core/database.js');
const _apDb = new Database(':memory:');
_apDb.pragma('foreign_keys = ON');
dbModule.dbs.activitypub = _apDb;

//
//  Force fresh load so collection.js picks up the injected DB.
//
delete require.cache[require.resolve('../core/activitypub/collection.js')];
const Collection = require('../core/activitypub/collection.js');

// ─── schema (mirrors database.js DB_INIT_TABLE.activitypub) ──────────────────

function applySchema(db) {
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

        CREATE INDEX IF NOT EXISTS collection_entry_by_name_actor_id_index0
            ON collection (name, owner_actor_id);

        CREATE INDEX IF NOT EXISTS collection_entry_by_name_collection_id_index0
            ON collection (name, collection_id);

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
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const TEST_COLLECTION_ID = 'https://test.example.com/_enig/ap/users/testuser/followers';
const TEST_OWNER_ACTOR_ID = 'https://test.example.com/_enig/ap/users/testuser';
const ACTOR_COLLECTION_ID = 'https://www.w3.org/ns/activitystreams#Public'; // ActorCollectionId

function makeEntry(id, name, collectionId, ownerId, isPrivate = false) {
    const obj = { id, type: 'Person', name: `Actor ${id}` };
    _apDb
        .prepare(
            `INSERT OR IGNORE INTO collection
                (collection_id, name, timestamp, owner_actor_id, object_id, object_json, is_private)
                VALUES (?, ?, datetime('now'), ?, ?, ?, ?)`
        )
        .run(collectionId, name, ownerId, id, JSON.stringify(obj), isPrivate ? 1 : 0);
    return obj;
}

function makeEntryAt(id, name, collectionId, ownerId, daysAgo, isPrivate = false) {
    const obj = { id, type: 'Person' };
    _apDb
        .prepare(
            `INSERT OR IGNORE INTO collection
                (collection_id, name, timestamp, owner_actor_id, object_id, object_json, is_private)
                VALUES (?, ?, datetime('now', ?), ?, ?, ?, ?)`
        )
        .run(
            collectionId,
            name,
            `-${daysAgo} days`,
            ownerId,
            id,
            JSON.stringify(obj),
            isPrivate ? 1 : 0
        );
    return obj;
}

function clearCollection() {
    _apDb.exec('DELETE FROM collection_object_meta; DELETE FROM collection;');
}

// ─── setup ───────────────────────────────────────────────────────────────────

before(() => {
    applySchema(_apDb);
});

beforeEach(() => {
    clearCollection();
});

// ─── addToCollection / removeById ────────────────────────────────────────────

describe('Collection.addToCollection / removeById', function () {
    it('inserts an entry and retrieves it by objectId', done => {
        const objectId = 'https://remote.example.com/users/alice';
        const obj = { id: objectId, type: 'Person' };

        Collection.addToCollection(
            'followers',
            null,
            TEST_COLLECTION_ID,
            objectId,
            obj,
            false,
            false,
            err => {
                assert.ifError(err);

                const row = _apDb
                    .prepare('SELECT object_json FROM collection WHERE object_id = ?')
                    .get(objectId);
                assert.ok(row, 'row should exist');
                assert.deepEqual(JSON.parse(row.object_json), obj);
                done();
            }
        );
    });

    it('removeById deletes the entry', done => {
        const objectId = 'https://remote.example.com/users/bob';
        const obj = { id: objectId, type: 'Person' };

        Collection.addToCollection(
            'followers',
            null,
            TEST_COLLECTION_ID,
            objectId,
            obj,
            false,
            false,
            err => {
                assert.ifError(err);

                Collection.removeById('followers', objectId, err2 => {
                    assert.ifError(err2);
                    const row = _apDb
                        .prepare('SELECT object_json FROM collection WHERE object_id = ?')
                        .get(objectId);
                    assert.equal(row, undefined, 'row should be gone');
                    done();
                });
            }
        );
    });

    it('INSERT OR IGNORE silently skips duplicates', done => {
        const objectId = 'https://remote.example.com/users/carol';
        const obj = { id: objectId, type: 'Person' };

        Collection.addToCollection(
            'followers',
            null,
            TEST_COLLECTION_ID,
            objectId,
            obj,
            false,
            true,
            err1 => {
                assert.ifError(err1);
                Collection.addToCollection(
                    'followers',
                    null,
                    TEST_COLLECTION_ID,
                    objectId,
                    obj,
                    false,
                    true,
                    err2 => {
                        assert.ifError(err2);
                        const rows = _apDb
                            .prepare('SELECT * FROM collection WHERE object_id = ?')
                            .all(objectId);
                        assert.equal(rows.length, 1, 'should have exactly one row');
                        done();
                    }
                );
            }
        );
    });

    it('cascade delete removes collection_object_meta rows', done => {
        const objectId = 'https://remote.example.com/users/dan';
        const obj = { id: objectId, type: 'Person' };
        const name = 'actors';
        const collId = 'https://www.w3.org/ns/activitystreams#Public';

        // Insert collection row
        _apDb
            .prepare(
                `INSERT OR IGNORE INTO collection
                    (collection_id, name, timestamp, owner_actor_id, object_id, object_json, is_private)
                    VALUES (?, ?, datetime('now'), ?, ?, ?, 0)`
            )
            .run(collId, name, collId, objectId, JSON.stringify(obj));

        // Insert meta row
        _apDb
            .prepare(
                `INSERT OR IGNORE INTO collection_object_meta
                    (collection_id, name, object_id, meta_name, meta_value)
                    VALUES (?, ?, ?, ?, ?)`
            )
            .run(collId, name, objectId, 'actor_subject', '@dan@remote.example.com');

        const metaBefore = _apDb
            .prepare('SELECT * FROM collection_object_meta WHERE object_id = ?')
            .all(objectId);
        assert.equal(metaBefore.length, 1, 'meta row should exist before delete');

        Collection.removeById(name, objectId, err => {
            assert.ifError(err);
            const metaAfter = _apDb
                .prepare('SELECT * FROM collection_object_meta WHERE object_id = ?')
                .all(objectId);
            assert.equal(metaAfter.length, 0, 'meta row should be removed by cascade');
            done();
        });
    });
});

// ─── removeByMaxCount ─────────────────────────────────────────────────────────

describe('Collection.removeByMaxCount', function () {
    it('removes oldest rows, keeping the N newest', done => {
        const name = 'sharedInbox';
        // Insert 5 items with explicit ascending timestamps so order is deterministic
        for (let i = 1; i <= 5; i++) {
            _apDb
                .prepare(
                    `INSERT OR IGNORE INTO collection
                        (collection_id, name, timestamp, owner_actor_id, object_id, object_json, is_private)
                        VALUES (?, ?, datetime('now', ?), ?, ?, ?, 0)`
                )
                .run(
                    'https://test.example.com/shared',
                    name,
                    `+${i} seconds`,
                    'https://www.w3.org/ns/activitystreams#Public',
                    `https://remote.example.com/notes/${i}`,
                    JSON.stringify({ id: `note${i}` })
                );
        }

        const before = _apDb
            .prepare('SELECT COUNT(*) AS n FROM collection WHERE name = ?')
            .get(name);
        assert.equal(before.n, 5);

        Collection.removeByMaxCount(name, 3, err => {
            assert.ifError(err);

            const after = _apDb
                .prepare('SELECT COUNT(*) AS n FROM collection WHERE name = ?')
                .get(name);
            assert.equal(after.n, 3, 'should keep exactly 3 rows');

            // The 3 kept rows should be the ones with the highest rowids (newest)
            const kept = _apDb
                .prepare(
                    'SELECT object_json FROM collection WHERE name = ? ORDER BY _rowid_ ASC'
                )
                .all(name);
            const ids = kept.map(r => JSON.parse(r.object_json).id);
            assert.deepEqual(ids, ['note3', 'note4', 'note5'], 'should keep newest 3');
            done();
        });
    });

    it('does nothing when count is already within limit', done => {
        const name = 'sharedInbox';
        for (let i = 1; i <= 2; i++) {
            _apDb
                .prepare(
                    `INSERT OR IGNORE INTO collection
                        (collection_id, name, timestamp, owner_actor_id, object_id, object_json, is_private)
                        VALUES (?, ?, datetime('now'), ?, ?, ?, 0)`
                )
                .run(
                    'https://test.example.com/shared',
                    name,
                    'https://www.w3.org/ns/activitystreams#Public',
                    `https://remote.example.com/notes/x${i}`,
                    JSON.stringify({ id: `notex${i}` })
                );
        }

        Collection.removeByMaxCount(name, 10, err => {
            assert.ifError(err);
            const after = _apDb
                .prepare('SELECT COUNT(*) AS n FROM collection WHERE name = ?')
                .get(name);
            assert.equal(after.n, 2, 'should leave all rows intact');
            done();
        });
    });
});

// ─── removeByMaxAgeDays ───────────────────────────────────────────────────────

describe('Collection.removeByMaxAgeDays', function () {
    it('removes entries older than maxAgeDays', done => {
        const name = 'outbox';
        const collId = 'https://test.example.com/_enig/ap/users/testuser/outbox';

        // 2 old entries (40 days ago) and 2 recent ones (1 day ago)
        for (let i = 1; i <= 2; i++) {
            makeEntryAt(
                `https://remote.example.com/notes/old${i}`,
                name,
                collId,
                TEST_OWNER_ACTOR_ID,
                40
            );
        }
        for (let i = 1; i <= 2; i++) {
            makeEntryAt(
                `https://remote.example.com/notes/new${i}`,
                name,
                collId,
                TEST_OWNER_ACTOR_ID,
                1
            );
        }

        const before = _apDb
            .prepare('SELECT COUNT(*) AS n FROM collection WHERE name = ?')
            .get(name);
        assert.equal(before.n, 4);

        Collection.removeByMaxAgeDays(name, 30, err => {
            assert.ifError(err);
            const after = _apDb
                .prepare('SELECT COUNT(*) AS n FROM collection WHERE name = ?')
                .get(name);
            assert.equal(after.n, 2, 'should remove the 2 old entries');

            const remaining = _apDb
                .prepare('SELECT object_id FROM collection WHERE name = ?')
                .all(name);
            assert.ok(
                remaining.every(r => r.object_id.includes('/new')),
                'only recent entries should remain'
            );
            done();
        });
    });

    it('removes nothing when all entries are within age limit', done => {
        const name = 'outbox';
        const collId = 'https://test.example.com/_enig/ap/users/testuser/outbox';
        for (let i = 1; i <= 3; i++) {
            makeEntryAt(
                `https://remote.example.com/notes/recent${i}`,
                name,
                collId,
                TEST_OWNER_ACTOR_ID,
                5
            );
        }

        Collection.removeByMaxAgeDays(name, 30, err => {
            assert.ifError(err);
            const after = _apDb
                .prepare('SELECT COUNT(*) AS n FROM collection WHERE name = ?')
                .get(name);
            assert.equal(after.n, 3, 'should leave all rows intact');
            done();
        });
    });
});

// ─── removeExpiredActors ──────────────────────────────────────────────────────

describe('Collection.removeExpiredActors', function () {
    //  Must match ActorCollectionId = PublicCollectionId + 'Actors' from const.js
    const ACTOR_COLL_ID = 'https://www.w3.org/ns/activitystreams#PublicActors';
    const ACTORS_NAME = 'actors';

    function insertActor(id, daysAgo) {
        const obj = { id, type: 'Person' };
        _apDb
            .prepare(
                `INSERT OR IGNORE INTO collection
                    (collection_id, name, timestamp, owner_actor_id, object_id, object_json, is_private)
                    VALUES (?, ?, datetime('now', ?), ?, ?, ?, 0)`
            )
            .run(
                ACTOR_COLL_ID,
                ACTORS_NAME,
                `-${daysAgo} days`,
                ACTOR_COLL_ID,
                id,
                JSON.stringify(obj)
            );
    }

    it('removes actors older than maxAgeDays', done => {
        insertActor('https://remote.example.com/users/old1', 130);
        insertActor('https://remote.example.com/users/old2', 200);
        insertActor('https://remote.example.com/users/fresh1', 10);

        Collection.removeExpiredActors(125, err => {
            assert.ifError(err);
            const remaining = _apDb
                .prepare('SELECT object_id FROM collection WHERE name = ?')
                .all(ACTORS_NAME);
            assert.equal(remaining.length, 1, 'should keep only the fresh actor');
            assert.equal(
                remaining[0].object_id,
                'https://remote.example.com/users/fresh1'
            );
            done();
        });
    });

    it('keeps all actors when none are expired', done => {
        insertActor('https://remote.example.com/users/a1', 30);
        insertActor('https://remote.example.com/users/a2', 60);

        Collection.removeExpiredActors(125, err => {
            assert.ifError(err);
            const remaining = _apDb
                .prepare('SELECT COUNT(*) AS n FROM collection WHERE name = ?')
                .get(ACTORS_NAME);
            assert.equal(remaining.n, 2, 'should keep all actors');
            done();
        });
    });
});

// ─── publicOrderedById — pagination ──────────────────────────────────────────

describe('Collection.publicOrderedById — pagination', function () {
    const COLL_NAME = 'outbox';
    const COLL_ID = 'https://test.example.com/_enig/ap/users/testuser/outbox';

    function insertNote(i) {
        const id = `https://test.example.com/_enig/ap/note${i}`;
        _apDb
            .prepare(
                `INSERT OR IGNORE INTO collection
                    (collection_id, name, timestamp, owner_actor_id, object_id, object_json, is_private)
                    VALUES (?, ?, datetime('now', ?), ?, ?, ?, 0)`
            )
            .run(
                COLL_ID,
                COLL_NAME,
                `+${i} seconds`,
                TEST_OWNER_ACTOR_ID,
                id,
                JSON.stringify({ id, type: 'Create' })
            );
    }

    it('no page: returns OrderedCollection with totalItems and first link', done => {
        for (let i = 1; i <= 5; i++) insertNote(i);

        Collection.publicOrderedById(COLL_NAME, COLL_ID, null, null, (err, coll) => {
            assert.ifError(err);
            assert.equal(coll.type, 'OrderedCollection');
            assert.equal(coll.totalItems, 5);
            assert.equal(coll.first, `${COLL_ID}?page=1`);
            assert.equal(
                coll.orderedItems,
                undefined,
                'root should not have orderedItems'
            );
            done();
        });
    });

    it('page=1 returns first page with correct items and no prev', done => {
        for (let i = 1; i <= 25; i++) insertNote(i);

        Collection.publicOrderedById(COLL_NAME, COLL_ID, '1', null, (err, coll) => {
            assert.ifError(err);
            assert.equal(coll.type, 'OrderedCollectionPage');
            assert.equal(coll.orderedItems.length, 20, 'page size should be 20');
            assert.equal(coll.totalItems, 25);
            assert.equal(coll.partOf, COLL_ID);
            assert.ok(coll.next, 'should have a next link');
            assert.equal(coll.prev, undefined, 'first page should have no prev');
            done();
        });
    });

    it('page=2 returns second page with prev and no next when no more items', done => {
        for (let i = 1; i <= 25; i++) insertNote(i);

        Collection.publicOrderedById(COLL_NAME, COLL_ID, '2', null, (err, coll) => {
            assert.ifError(err);
            assert.equal(coll.orderedItems.length, 5, 'remaining 5 items on page 2');
            assert.ok(coll.prev, 'should have a prev link');
            assert.equal(coll.next, undefined, 'no items beyond page 2');
            done();
        });
    });

    it("'all' sentinel returns every item as OrderedCollection without paging", done => {
        for (let i = 1; i <= 25; i++) insertNote(i);

        Collection.publicOrderedById(COLL_NAME, COLL_ID, 'all', null, (err, coll) => {
            assert.ifError(err);
            assert.equal(coll.type, 'OrderedCollection');
            assert.equal(coll.orderedItems.length, 25);
            assert.equal(coll.next, undefined);
            done();
        });
    });

    it('mapper is applied to each entry', done => {
        for (let i = 1; i <= 3; i++) insertNote(i);
        const mapper = e => e.id;

        Collection.publicOrderedById(COLL_NAME, COLL_ID, '1', mapper, (err, coll) => {
            assert.ifError(err);
            assert.ok(
                coll.orderedItems.every(v => typeof v === 'string'),
                'mapper should transform entries to strings'
            );
            done();
        });
    });

    it('empty collection: no page returns totalItems=0 with no orderedItems pointer', done => {
        Collection.publicOrderedById(COLL_NAME, COLL_ID, null, null, (err, coll) => {
            assert.ifError(err);
            assert.equal(coll.totalItems, 0);
            assert.equal(coll.first, undefined);
            assert.deepEqual(coll.orderedItems, []);
            done();
        });
    });
});

// ─── objectByEmbeddedId ───────────────────────────────────────────────────────

describe('Collection.objectByEmbeddedId', function () {
    it('finds an activity by its embedded object.id', done => {
        const noteId = 'https://remote.example.com/notes/42';
        const activity = {
            id: 'https://remote.example.com/activities/1',
            type: 'Create',
            object: { id: noteId, type: 'Note', content: 'hello' },
        };
        _apDb
            .prepare(
                `INSERT OR IGNORE INTO collection
                    (collection_id, name, timestamp, owner_actor_id, object_id, object_json, is_private)
                    VALUES (?, ?, datetime('now'), ?, ?, ?, 0)`
            )
            .run(
                'https://test.example.com/shared',
                'sharedInbox',
                TEST_OWNER_ACTOR_ID,
                activity.id,
                JSON.stringify(activity)
            );

        Collection.objectByEmbeddedId(noteId, (err, obj) => {
            assert.ifError(err);
            assert.ok(obj, 'should find the activity');
            assert.equal(obj.object.id, noteId);
            done();
        });
    });

    it('returns null for unknown note ID', done => {
        Collection.objectByEmbeddedId(
            'https://remote.example.com/notes/NOPE',
            (err, obj) => {
                assert.ifError(err);
                assert.equal(obj, null);
                done();
            }
        );
    });
});

// ─── updateCollectionEntry ────────────────────────────────────────────────────

describe('Collection.updateCollectionEntry', function () {
    it('updates object_json for an existing entry', done => {
        const objectId = 'https://remote.example.com/notes/updateme';
        const original = {
            id: objectId,
            type: 'Create',
            object: { content: 'original' },
        };
        const updated = { id: objectId, type: 'Create', object: { content: 'updated' } };

        _apDb
            .prepare(
                `INSERT OR IGNORE INTO collection
                    (collection_id, name, timestamp, owner_actor_id, object_id, object_json, is_private)
                    VALUES (?, ?, datetime('now'), ?, ?, ?, 0)`
            )
            .run(
                'https://test.example.com/shared',
                'sharedInbox',
                TEST_OWNER_ACTOR_ID,
                objectId,
                JSON.stringify(original)
            );

        Collection.updateCollectionEntry('sharedInbox', objectId, updated, err => {
            assert.ifError(err);
            const row = _apDb
                .prepare('SELECT object_json FROM collection WHERE object_id = ?')
                .get(objectId);
            const parsed = JSON.parse(row.object_json);
            assert.equal(parsed.object.content, 'updated');
            done();
        });
    });
});

// ─── addCollectionObjectMeta ──────────────────────────────────────────────────

describe('Collection.addCollectionObjectMeta', function () {
    const COLL_ID = 'https://www.w3.org/ns/activitystreams#Public';
    const COLL_NAME = 'sharedInbox';

    function insertActivity(activityId) {
        const obj = {
            id: activityId,
            type: 'Announce',
            actor: 'https://remote.example.com/users/alice',
            object: 'https://bbs.example.com/notes/1',
        };
        _apDb
            .prepare(
                `INSERT OR IGNORE INTO collection
                    (collection_id, name, timestamp, owner_actor_id, object_id, object_json, is_private)
                    VALUES (?, ?, datetime('now'), ?, ?, ?, 0)`
            )
            .run(COLL_ID, COLL_NAME, COLL_ID, activityId, JSON.stringify(obj));
    }

    it('inserts a meta row for an existing collection entry', done => {
        const id = 'https://remote.example.com/activities/meta1';
        insertActivity(id);

        Collection.addCollectionObjectMeta(
            COLL_NAME,
            COLL_ID,
            id,
            'activity_type',
            'Announce',
            err => {
                assert.ifError(err);
                const row = _apDb
                    .prepare(
                        'SELECT meta_value FROM collection_object_meta WHERE object_id = ? AND meta_name = ?'
                    )
                    .get(id, 'activity_type');
                assert.ok(row, 'meta row should exist');
                assert.equal(row.meta_value, 'Announce');
                done();
            }
        );
    });

    it('is idempotent — inserting the same meta twice does not error', done => {
        const id = 'https://remote.example.com/activities/meta2';
        insertActivity(id);

        Collection.addCollectionObjectMeta(
            COLL_NAME,
            COLL_ID,
            id,
            'boosted_by',
            'https://remote.example.com/users/bob',
            err => {
                assert.ifError(err);
                Collection.addCollectionObjectMeta(
                    COLL_NAME,
                    COLL_ID,
                    id,
                    'boosted_by',
                    'https://remote.example.com/users/bob',
                    err2 => {
                        assert.ifError(err2);
                        const count = _apDb
                            .prepare(
                                'SELECT COUNT(*) AS n FROM collection_object_meta WHERE object_id = ? AND meta_name = ?'
                            )
                            .get(id, 'boosted_by').n;
                        assert.equal(count, 1);
                        done();
                    }
                );
            }
        );
    });

    it('multiple distinct meta_name values can coexist on one entry', done => {
        const id = 'https://remote.example.com/activities/meta3';
        insertActivity(id);

        Collection.addCollectionObjectMeta(
            COLL_NAME,
            COLL_ID,
            id,
            'activity_type',
            'Announce',
            err => {
                assert.ifError(err);
                Collection.addCollectionObjectMeta(
                    COLL_NAME,
                    COLL_ID,
                    id,
                    'original_note_id',
                    'https://bbs.example.com/notes/1',
                    err2 => {
                        assert.ifError(err2);
                        const rows = _apDb
                            .prepare(
                                'SELECT meta_name FROM collection_object_meta WHERE object_id = ?'
                            )
                            .all(id);
                        assert.equal(rows.length, 2);
                        done();
                    }
                );
            }
        );
    });

    it('meta rows are cascade-deleted when the parent collection entry is removed', done => {
        const id = 'https://remote.example.com/activities/meta4';
        insertActivity(id);

        Collection.addCollectionObjectMeta(
            COLL_NAME,
            COLL_ID,
            id,
            'activity_type',
            'Announce',
            err => {
                assert.ifError(err);
                _apDb.prepare('DELETE FROM collection WHERE object_id = ?').run(id);
                const row = _apDb
                    .prepare('SELECT * FROM collection_object_meta WHERE object_id = ?')
                    .get(id);
                assert.equal(row, undefined, 'meta rows should be cascade-deleted');
                done();
            }
        );
    });
});

// ─── getCollectionObjectsByMeta ───────────────────────────────────────────────

describe('Collection.getCollectionObjectsByMeta', function () {
    const COLL_ID = 'https://www.w3.org/ns/activitystreams#Public';
    const COLL_NAME = 'sharedInbox';

    function insertAnnounce(activityId, noteId, booster) {
        const obj = { id: activityId, type: 'Announce', actor: booster, object: noteId };
        _apDb
            .prepare(
                `INSERT OR IGNORE INTO collection
                    (collection_id, name, timestamp, owner_actor_id, object_id, object_json, is_private)
                    VALUES (?, ?, datetime('now'), ?, ?, ?, 0)`
            )
            .run(COLL_ID, COLL_NAME, COLL_ID, activityId, JSON.stringify(obj));
        _apDb
            .prepare(
                `INSERT OR IGNORE INTO collection_object_meta
                (collection_id, name, object_id, meta_name, meta_value)
             VALUES (?, ?, ?, 'original_note_id', ?)`
            )
            .run(COLL_ID, COLL_NAME, activityId, noteId);
    }

    it('returns entries matching the given meta_name and meta_value', done => {
        const NOTE = 'https://bbs.example.com/notes/queryme';
        insertAnnounce(
            'https://remote.example.com/activities/q1',
            NOTE,
            'https://remote.example.com/users/alice'
        );
        insertAnnounce(
            'https://remote.example.com/activities/q2',
            NOTE,
            'https://remote.example.com/users/bob'
        );

        Collection.getCollectionObjectsByMeta(
            COLL_NAME,
            'original_note_id',
            NOTE,
            (err, results) => {
                assert.ifError(err);
                assert.equal(results.length, 2, 'should find both Announces');
                const actors = results.map(r => r.object.actor).sort();
                assert.ok(
                    actors.some(x => x === 'https://remote.example.com/users/alice')
                );
                assert.ok(actors.some(x => x === 'https://remote.example.com/users/bob'));
                done();
            }
        );
    });

    it('returns empty array when no entries match', done => {
        Collection.getCollectionObjectsByMeta(
            COLL_NAME,
            'original_note_id',
            'https://bbs.example.com/notes/NOPE',
            (err, results) => {
                assert.ifError(err);
                assert.deepEqual(results, []);
                done();
            }
        );
    });

    it('does not return entries from a different collection name', done => {
        const NOTE = 'https://bbs.example.com/notes/isolation';
        insertAnnounce(
            'https://remote.example.com/activities/iso1',
            NOTE,
            'https://remote.example.com/users/carol'
        );

        Collection.getCollectionObjectsByMeta(
            'outbox',
            'original_note_id',
            NOTE,
            (err, results) => {
                assert.ifError(err);
                assert.deepEqual(
                    results,
                    [],
                    'should not see sharedInbox entries when querying outbox'
                );
                done();
            }
        );
    });
});
