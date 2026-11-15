'use strict';

//
//  message_meta lookups by value.
//
//  The table's only key was UNIQUE(message_id, meta_category, meta_name,
//  meta_value), which leads with message_id, so every lookup by value -- the
//  MSGID dupe check and REPLY resolution on each imported FTN message,
//  getMessageIdsByMetaValue(), the private mail filter -- scanned the whole
//  table. message_meta_by_category_name_value_index serves those.
//
//  The SQL is captured from the real functions rather than copied here, so a
//  change to the query that stops it using the index fails this test.
//

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');

const INDEX_NAME = 'message_meta_by_category_name_value_index';
const MESSAGE_META_AUTOINDEX = 'sqlite_autoindex_message_meta_1';

function indexNames(db) {
    return db
        .prepare(
            `SELECT name FROM sqlite_master
            WHERE type = 'index' AND tbl_name = 'message_meta' ORDER BY name;`
        )
        .all()
        .map(r => r.name);
}

function queryPlan(db, sql, params) {
    return db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...params)
        .map(r => r.detail)
        .join('\n');
}

describe('message_meta lookup-by-value index', function () {
    let initMessageDatabase;

    before(() => {
        ({ initMessageDatabase } = require('../core/database.js'));
    });

    it('is created on a new database', () => {
        const db = new Database(':memory:');
        try {
            initMessageDatabase(db);
            assert.ok(indexNames(db).includes(INDEX_NAME), indexNames(db).join(', '));
        } finally {
            db.close();
        }
    });

    it('is added to an existing database at its next start', () => {
        //  A current-version database built before the index existed: the
        //  schema runs on every start, so it must not depend on a migration.
        const db = new Database(':memory:');
        try {
            initMessageDatabase(db);
            db.exec(`DROP INDEX ${INDEX_NAME};`);
            db.prepare(
                `INSERT INTO message (area_tag, message_uuid, to_user_name, from_user_name,
                    subject, message, modified_timestamp)
                VALUES ('a', 'u-1', 'All', 'Me', 's', 'b', '2026-01-01T00:00:00.000Z');`
            ).run();
            db.prepare(
                `INSERT INTO message_meta VALUES (1, 'FtnKludge', 'MSGID', '1:2/3 abcd1234');`
            ).run();
            assert.ok(!indexNames(db).includes(INDEX_NAME));

            initMessageDatabase(db);

            assert.ok(indexNames(db).includes(INDEX_NAME));
            assert.equal(
                db.pragma('integrity_check', { simple: true }),
                'ok',
                'and the rows already there are in it'
            );
            //  and starting again is a no-op
            initMessageDatabase(db);
            assert.equal(indexNames(db).filter(n => INDEX_NAME === n).length, 1);
        } finally {
            db.close();
        }
    });

    describe('queries', () => {
        let db;
        let prevMessageDb;
        let Message;
        let captured;
        let realPrepare;

        before(() => {
            //  message.js captures dbs.message at load: swap the database in,
            //  then load a fresh copy (and drop it again afterwards).
            const dbModule = require('../core/database.js');
            prevMessageDb = dbModule.dbs.message;
            db = new Database(':memory:');
            db.pragma('foreign_keys = ON');
            initMessageDatabase(db);
            dbModule.dbs.message = db;

            captured = [];
            realPrepare = db.prepare.bind(db);
            db.prepare = sql => {
                captured.push(sql);
                return realPrepare(sql);
            };

            delete require.cache[require.resolve('../core/message.js')];
            Message = require('../core/message.js');
        });

        after(() => {
            delete require.cache[require.resolve('../core/message.js')];
            require('../core/database.js').dbs.message = prevMessageDb;
            db.close();
        });

        beforeEach(() => {
            captured.length = 0;
        });

        function lastCaptured(pattern) {
            const sql = captured.filter(s => pattern.test(s)).pop();
            assert.ok(sql, `no query matching ${pattern} was prepared`);
            return sql;
        }

        it('getMessageIdsByMetaValue (MSGID dupe check, REPLY resolution) uses it', done => {
            Message.getMessageIdsByMetaValue('FtnKludge', 'MSGID', '1:2/3 abcd', err => {
                if (err) {
                    return done(err);
                }
                const sql = lastCaptured(/FROM message_meta/);
                const plan = queryPlan(db, sql, ['FtnKludge', 'MSGID', '1:2/3 abcd']);
                assert.match(
                    plan,
                    new RegExp(`USING (COVERING )?INDEX ${INDEX_NAME}`),
                    plan
                );
                return done();
            });
        });

        it('the private mail filter uses it', done => {
            Message.findMessages({ privateTagUserId: 1, resultType: 'id' }, err => {
                if (err) {
                    return done(err);
                }
                const sql = lastCaptured(/FROM message_meta/);
                const plan = queryPlan(db, sql.replace(/;\s*$/, ''), [
                    Message.WellKnownAreaTags.Private,
                    Message.SystemMetaNames.LocalToUserID,
                    '1',
                ]);
                assert.match(plan, new RegExp(`INDEX ${INDEX_NAME}`), plan);
                return done();
            });
        });

        it('loading a message keeps using the message_id key', done => {
            //  loadMeta() takes rows in index order, and that order is the
            //  order kludges come back in -- and so the order they are written
            //  to an exported packet. The new index must not be picked here.
            const message = new Message({ messageId: 1 });
            message.loadMeta(err => {
                if (err) {
                    return done(err);
                }
                const sql = lastCaptured(/FROM message_meta/);
                const plan = queryPlan(db, sql, [1]);
                assert.match(plan, new RegExp(`INDEX ${MESSAGE_META_AUTOINDEX}`), plan);
                assert.doesNotMatch(plan, new RegExp(INDEX_NAME), plan);
                return done();
            });
        });

        it('the EchoMail relay decision read keeps using the message_id key', () => {
            //  Given the choice, the planner takes the new index on
            //  (meta_category, meta_name) for this query and walks every
            //  SEEN-BY row in the base to find one chunk's: ~170 ms a chunk
            //  instead of ~2 ms on a 36k-message base.
            //
            //  It does so once the base has statistics for the message_id key
            //  and none yet for the new index -- which is every board that has
            //  run PRAGMA optimize, at its first start with the index. These
            //  are the statistics of that 36k-message base; this test goes
            //  last in the file as nothing else here wants them.
            realPrepare('ANALYZE;').run();
            realPrepare('DELETE FROM sqlite_stat1;').run();
            realPrepare(
                `INSERT INTO sqlite_stat1 (tbl, idx, stat)
                VALUES ('message_meta', '${MESSAGE_META_AUTOINDEX}', '630863 23 8 2 1');`
            ).run();
            realPrepare('ANALYZE sqlite_schema;').run();

            const ftnBsoPath = require.resolve('../core/scanner_tossers/ftn_bso.js');
            delete require.cache[ftnBsoPath];
            try {
                const { getModule } = require(ftnBsoPath);
                const ids = Array.from({ length: 500 }, (_, i) => i + 1);
                new getModule().getRelayDecisionMeta(ids);

                const sql = lastCaptured(/FROM message_meta[\s\S]*ftn_seen_by/);
                const plan = queryPlan(db, sql.replace(/;\s*$/, ''), ids);
                assert.match(plan, new RegExp(`INDEX ${MESSAGE_META_AUTOINDEX}`), plan);
                assert.doesNotMatch(plan, new RegExp(INDEX_NAME), plan);
            } finally {
                delete require.cache[ftnBsoPath];
            }
        });
    });
});
