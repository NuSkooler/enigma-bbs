'use strict';

//
//  Thread (context) lookups: the context / conversation indexes, the
//  bounded Collection queries, and the paged /note/context collection.
//

const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const paths = require('path');
const Database = require('better-sqlite3');

const SHARED = 'sharedInbox';
const NOTE_UUID = 'bf81a22e-cb3e-41c8-b114-21f375b61124';

//  the collection table and its indexes as database.js created them before
//  the context indexes
const PriorSchema = `
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
    CREATE INDEX IF NOT EXISTS collection_entry_by_object_id_index0
        ON collection (object_id);
    CREATE INDEX IF NOT EXISTS collection_by_name_timestamp_index0
        ON collection (name, timestamp);
    CREATE INDEX IF NOT EXISTS collection_embedded_object_id_index0
        ON collection (json_extract(object_json, '$.object.id'));
`;

function insertNote(db, { n, name = SHARED, context, conversation, type = 'Note', at }) {
    const object = { id: `https://remote.example/notes/${n}`, type };
    if (context) object.context = context;
    if (conversation) object.conversation = conversation;
    db.prepare(
        `INSERT INTO collection (collection_id, name, timestamp, owner_actor_id, object_id, object_json, is_private)
        VALUES (?, ?, ?, ?, ?, ?, 0)`
    ).run(
        'https://www.w3.org/ns/activitystreams#Public',
        name,
        new Date(Date.UTC(2026, 0, 1) + (undefined === at ? n : at) * 1000).toISOString(),
        'owner',
        `https://remote.example/activities/${n}`,
        JSON.stringify({
            id: `https://remote.example/activities/${n}`,
            type: 'Create',
            object,
        })
    );
}

describe('ActivityPub thread (context) lookups', function () {
    let tmpDir,
        db,
        dbModule,
        priorApDb,
        configModule,
        priorConfigGet,
        Collection,
        Handler;
    const TEST_CONFIG = {
        debug: { assertsEnabled: false },
        general: { boardName: 'TestBoard' },
        contentServers: {
            web: {
                domain: 'test.example.com',
                https: { enabled: true, port: 443 },
                handlers: { activityPub: { enabled: true } },
            },
        },
    };
    const noop = () => {};
    const logStub = {
        fatal: noop,
        error: noop,
        warn: noop,
        info: noop,
        debug: noop,
        trace: noop,
        child: () => logStub,
    };

    before(() => {
        tmpDir = fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-ap-context-'));
        dbModule = require('../core/database.js');
        priorApDb = dbModule.dbs.activitypub;
        configModule = require('../core/config.js');
        priorConfigGet = configModule.get;
        configModule.get = () => TEST_CONFIG;
    });

    after(() => {
        dbModule.dbs.activitypub = priorApDb;
        configModule.get = priorConfigGet;
        //  bound to this file's database and config: later files load their own
        for (const m of [
            '../core/web_util.js',
            '../core/activitypub/collection.js',
            '../core/servers/content/web_handlers/activitypub.js',
        ]) {
            delete require.cache[require.resolve(m)];
        }
        if (db && db.open) db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('ensureActivityPubContextIndexes()', function () {
        it('adds both indexes to an existing database, and is safe to run again', () => {
            const file = paths.join(tmpDir, 'activitypub.sqlite3');
            const prior = new Database(file);
            prior.exec(PriorSchema);
            insertNote(prior, { n: 1, context: 'https://t.example/1' });
            prior.close();

            db = new Database(file);
            dbModule.ensureActivityPubContextIndexes(db);
            dbModule.ensureActivityPubContextIndexes(db);

            const names = db
                .prepare(
                    `SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'collection_object_%'`
                )
                .all()
                .map(r => r.name)
                .sort();
            assert.deepEqual(names, [
                'collection_object_context_index0',
                'collection_object_conversation_index0',
            ]);
            assert.equal(db.prepare('SELECT COUNT(*) AS n FROM collection').get().n, 1);
        });
    });

    describe('Collection context queries', function () {
        const CTX = 'https://t.example/thread';
        let statements;

        before(() => {
            //  rows from several threads and collections, so a scan would show
            db.exec('DELETE FROM collection');
            db.exec('BEGIN');
            for (let n = 1; n <= 300; ++n) {
                insertNote(db, {
                    n,
                    name: n % 4 === 0 ? 'outbox' : SHARED,
                    context: n % 2 ? `https://t.example/other/${n % 7}` : undefined,
                    conversation: n % 2 ? undefined : `https://t.example/other/${n % 5}`,
                });
            }
            for (let n = 301; n <= 310; ++n) {
                insertNote(db, n % 2 ? { n, context: CTX } : { n, conversation: CTX });
            }
            insertNote(db, { n: 311, name: 'outbox', context: CTX });
            db.exec('COMMIT');

            dbModule.dbs.activitypub = db;
            delete require.cache[require.resolve('../core/activitypub/collection.js')];
            Collection = require('../core/activitypub/collection.js');

            //  record the SQL the queries run
            statements = [];
            const prepare = db.prepare.bind(db);
            db.prepare = sql => {
                statements.push(sql);
                return prepare(sql);
            };
        });

        after(() => {
            delete db.prepare;
        });

        const call = (fn, ...args) =>
            new Promise((resolve, reject) =>
                fn(...args, (err, result) => (err ? reject(err) : resolve(result)))
            );

        it('finds a thread by context or conversation, in this collection only, oldest first', async () => {
            const { rows } = await call(Collection.getCollectionByContext, SHARED, CTX);
            const ids = rows.map(r => JSON.parse(r.object_json).object.id);
            assert.equal(ids.length, 10);
            assert.equal(ids[0], 'https://remote.example/notes/301');
            assert.equal(ids[9], 'https://remote.example/notes/310');
        });

        it('honours limit and offset', async () => {
            const { rows } = await call(Collection.getCollectionByContext, SHARED, CTX, {
                limit: 3,
                offset: 4,
            });
            assert.deepEqual(
                rows.map(r => JSON.parse(r.object_json).object.id),
                [305, 306, 307].map(n => `https://remote.example/notes/${n}`)
            );
        });

        it('counts the thread', async () => {
            assert.equal(await call(Collection.countByContext, SHARED, CTX), 10);
            assert.equal(
                await call(Collection.countByContext, SHARED, 'https://x/none'),
                0
            );
        });

        it('uses the context and conversation indexes, not a collection scan', async () => {
            statements.length = 0;
            await call(Collection.getCollectionByContext, SHARED, CTX, { limit: 5 });
            await call(Collection.countByContext, SHARED, CTX);
            const queries = statements.filter(sql => /\$\.object\.context/.test(sql));
            assert.equal(queries.length, 2);

            for (const sql of queries) {
                const params = [SHARED, CTX, CTX];
                if (/LIMIT/.test(sql)) params.push(5, 0);
                const plan = db
                    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
                    .all(...params)
                    .map(r => r.detail)
                    .join('\n');
                assert.match(plan, /USING INDEX collection_object_context_index0/);
                assert.match(plan, /USING INDEX collection_object_conversation_index0/);
                assert.doesNotMatch(plan, /collection_by_name_timestamp_index0/);
            }
        });
    });

    describe('GET /note/context', function () {
        let noteId, contextUrl;

        before(() => {
            //  web_util reads the config mock above once loaded afresh
            delete require.cache[require.resolve('../core/web_util.js')];
            delete require.cache[
                require.resolve('../core/servers/content/web_handlers/activitypub.js')
            ];
            //  the handler binds the Collection loaded above (same database)
            Handler =
                require('../core/servers/content/web_handlers/activitypub.js').getModule;
            const { getBaseUrl } = require('../core/web_util.js');
            noteId = `${getBaseUrl()}/_enig/ap/${NOTE_UUID}/note`;
            contextUrl = `${noteId}/context`;
        });

        beforeEach(() => {
            db.exec('DELETE FROM collection');
        });

        function get(query = '') {
            const handler = new Handler();
            handler.log = logStub;
            return new Promise((resolve, reject) => {
                handler.webServer = {
                    ok: (resp, body, headers) =>
                        resolve({ body: JSON.parse(body), headers }),
                    internalServerError: (resp, err) => reject(err),
                };
                handler._noteContextGetHandler(
                    { url: `/_enig/ap/${NOTE_UUID}/note/context${query}`, headers: {} },
                    {}
                );
            });
        }

        const thread = count =>
            db.transaction(() => {
                for (let n = 1; n <= count; ++n) {
                    insertNote(db, { n, context: noteId });
                }
            })();

        it('answers a short thread inline, as before', async () => {
            thread(3);
            insertNote(db, { n: 4, context: noteId, type: 'Question' });
            const { body } = await get();
            assert.equal(body.type, 'OrderedCollection');
            assert.equal(body.id, contextUrl);
            assert.equal(body.totalItems, 3);
            assert.equal(body.orderedItems.length, 3);
            assert.equal(body.first, undefined);
        });

        it('answers an empty thread inline', async () => {
            const { body } = await get();
            assert.deepEqual(
                {
                    type: body.type,
                    totalItems: body.totalItems,
                    items: body.orderedItems,
                },
                { type: 'OrderedCollection', totalItems: 0, items: [] }
            );
        });

        it('gives a long thread as totalItems and a first page', async () => {
            thread(250);
            const { body } = await get();
            assert.equal(body.type, 'OrderedCollection');
            assert.equal(body.totalItems, 250);
            assert.equal(body.first, `${contextUrl}?page=1`);
            assert.equal(body.orderedItems, undefined);
        });

        it('pages a long thread with next and prev links', async () => {
            thread(250);

            const first = (await get('?page=1')).body;
            assert.equal(first.type, 'OrderedCollectionPage');
            assert.equal(first.id, `${contextUrl}?page=1`);
            assert.equal(first.partOf, contextUrl);
            assert.equal(first.orderedItems.length, 100);
            assert.equal(first.orderedItems[0].id, 'https://remote.example/notes/1');
            assert.equal(first.next, `${contextUrl}?page=2`);
            assert.equal(first.prev, undefined);

            const last = (await get('?page=3')).body;
            assert.equal(last.orderedItems.length, 50);
            assert.equal(last.orderedItems[0].id, 'https://remote.example/notes/201');
            assert.equal(last.next, undefined);
            assert.equal(last.prev, `${contextUrl}?page=2`);
        });

        it('keeps the order across a page boundary between equal timestamps', async () => {
            db.transaction(() => {
                for (let n = 1; n <= 150; ++n) {
                    insertNote(db, { n, context: noteId, at: 0 });
                }
            })();
            const ids = page => page.orderedItems.map(o => o.id);
            const first = ids((await get('?page=1')).body);
            const second = ids((await get('?page=2')).body);
            const expected = n => `https://remote.example/notes/${n}`;
            assert.equal(first[0], expected(1));
            assert.equal(first[99], expected(100));
            assert.equal(second[0], expected(101));
            assert.equal(second.length, 50);
            assert.equal(new Set([...first, ...second]).size, 150);
        });

        it('answers a page past the end, however large, with no items', async () => {
            thread(5);
            for (const page of ['2', '99999999999999999999999']) {
                const { body } = await get(`?page=${page}`);
                assert.equal(body.type, 'OrderedCollectionPage');
                assert.deepEqual(body.orderedItems, []);
                assert.equal(body.next, undefined);
                //  answered as the page just after the last, so its links can be followed
                assert.equal(body.id, `${contextUrl}?page=2`);
                assert.equal(body.prev, `${contextUrl}?page=1`);
            }
        });
    });
});
