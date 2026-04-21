'use strict';

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');

//
//  Config mock — before requiring stat_log.js which captures sysDb at load time.
//
const configModule = require('../core/config.js');
const TEST_CONFIG = {
    debug: { assertsEnabled: false },
};
configModule.get = () => TEST_CONFIG;

//
//  In-memory DB injection — must happen before requiring stat_log.js.
//
const dbModule = require('../core/database.js');
const _testDb = new Database(':memory:');
_testDb.pragma('foreign_keys = ON');
dbModule.dbs.system = _testDb;

//
//  Force a fresh load of stat_log.js so it captures the in-memory DB above.
//  stat_log.js is loaded transitively by achievement.test.js (via
//  achievement.js) before we had a chance to inject dbs.system.
//
delete require.cache[require.resolve('../core/stat_log.js')];

//  Module under test — singleton, loaded after DB is in place.
const StatLog = require('../core/stat_log.js');

// ─── schema ──────────────────────────────────────────────────────────────────

function applySchema(db, done) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS system_stat (
            stat_name   VARCHAR PRIMARY KEY NOT NULL,
            stat_value  VARCHAR NOT NULL
        );

        CREATE TABLE IF NOT EXISTS system_event_log (
            id          INTEGER PRIMARY KEY,
            timestamp   DATETIME NOT NULL,
            log_name    VARCHAR NOT NULL,
            log_value   VARCHAR NOT NULL
        );

        CREATE TABLE IF NOT EXISTS user_event_log (
            id          INTEGER PRIMARY KEY,
            timestamp   DATETIME NOT NULL,
            user_id     INTEGER NOT NULL,
            session_id  VARCHAR NOT NULL,
            log_name    VARCHAR NOT NULL,
            log_value   VARCHAR NOT NULL,
            UNIQUE(timestamp, user_id, session_id, log_name)
        );
    `);
    return done(null);
}

// ─── init ────────────────────────────────────────────────────────────────────

describe('StatLog.init()', function () {
    before(done => applySchema(_testDb, done));

    beforeEach(done => {
        _testDb.exec('DELETE FROM system_stat;');
        StatLog.systemStats = {};
        done();
    });

    it('loads empty stats without error', done => {
        StatLog.init(err => {
            assert.ifError(err);
            assert.deepEqual(StatLog.systemStats, {});
            done();
        });
    });

    it('loads pre-existing stats into systemStats', done => {
        _testDb
            .prepare(`INSERT INTO system_stat (stat_name, stat_value) VALUES (?, ?)`)
            .run('test_stat', '99');

        StatLog.init(err => {
            assert.ifError(err);
            assert.equal(StatLog.systemStats['test_stat'], '99');
            done();
        });
    });

    it('loads multiple pre-existing stats', done => {
        _testDb
            .prepare(`INSERT INTO system_stat (stat_name, stat_value) VALUES (?, ?)`)
            .run('a', '1');
        _testDb
            .prepare(`INSERT INTO system_stat (stat_name, stat_value) VALUES (?, ?)`)
            .run('b', '2');

        StatLog.init(err => {
            assert.ifError(err);
            assert.equal(StatLog.systemStats['a'], '1');
            assert.equal(StatLog.systemStats['b'], '2');
            done();
        });
    });
});

// ─── setSystemStat / getSystemStat ───────────────────────────────────────────

describe('StatLog.setSystemStat() / getSystemStat()', function () {
    before(done => applySchema(_testDb, done));

    beforeEach(done => {
        _testDb.exec('DELETE FROM system_stat;');
        StatLog.systemStats = {};
        done();
    });

    it('persists a stat to the DB and returns it via getSystemStat', done => {
        StatLog.setSystemStat('login_count', 5, err => {
            assert.ifError(err);

            const row = _testDb
                .prepare(`SELECT stat_value FROM system_stat WHERE stat_name=?`)
                .get('login_count');
            assert.ok(row, 'row should exist in DB');
            assert.equal(Number(row.stat_value), 5);
            done();
        });
    });

    it('overwrites an existing stat value', done => {
        StatLog.setSystemStat('login_count', 1, err => {
            assert.ifError(err);
            StatLog.setSystemStat('login_count', 42, err2 => {
                assert.ifError(err2);
                const row = _testDb
                    .prepare(`SELECT stat_value FROM system_stat WHERE stat_name=?`)
                    .get('login_count');
                assert.equal(Number(row.stat_value), 42);
                done();
            });
        });
    });

    it('works fire-and-forget (no callback)', done => {
        StatLog.setSystemStat('fire_forget', 'yes');
        setImmediate(() => {
            const row = _testDb
                .prepare(`SELECT stat_value FROM system_stat WHERE stat_name=?`)
                .get('fire_forget');
            assert.ok(row);
            assert.equal(row.stat_value, 'yes');
            done();
        });
    });

    it('incrementSystemStat accumulates correctly', done => {
        StatLog.setSystemStat('counter', 10, err => {
            assert.ifError(err);
            StatLog.incrementSystemStat('counter', 5, err2 => {
                assert.ifError(err2);
                const row = _testDb
                    .prepare(`SELECT stat_value FROM system_stat WHERE stat_name=?`)
                    .get('counter');
                assert.equal(parseInt(row.stat_value), 15);
                done();
            });
        });
    });
});

// ─── appendSystemLogEntry / findSystemLogEntries ──────────────────────────────

describe('StatLog.appendSystemLogEntry() / findSystemLogEntries()', function () {
    before(done => applySchema(_testDb, done));

    beforeEach(done => {
        _testDb.exec('DELETE FROM system_event_log;');
        done();
    });

    it('appends an entry and finds it by logName', done => {
        StatLog.appendSystemLogEntry('test_log', 'value1', -1, 'forever', err => {
            assert.ifError(err);
            StatLog.findSystemLogEntries({ logName: 'test_log' }, (err2, rows) => {
                assert.ifError(err2);
                assert.ok(Array.isArray(rows));
                assert.equal(rows.length, 1);
                assert.equal(rows[0].log_value, 'value1');
                done();
            });
        });
    });

    it('count resultType returns correct count', done => {
        StatLog.appendSystemLogEntry('count_log', 'a', -1, 'forever', e1 => {
            assert.ifError(e1);
            StatLog.appendSystemLogEntry('count_log', 'b', -1, 'forever', e2 => {
                assert.ifError(e2);
                StatLog.findSystemLogEntries(
                    { logName: 'count_log', resultType: 'count' },
                    (err, count) => {
                        assert.ifError(err);
                        assert.equal(count, 2);
                        done();
                    }
                );
            });
        });
    });

    it('keep=max trims entries to N most recent', done => {
        const append = (val, cb) =>
            StatLog.appendSystemLogEntry('trim_log', val, 2, 'max', cb);

        append('one', e1 => {
            assert.ifError(e1);
            append('two', e2 => {
                assert.ifError(e2);
                append('three', e3 => {
                    assert.ifError(e3);
                    StatLog.findSystemLogEntries(
                        { logName: 'trim_log', resultType: 'count' },
                        (err, count) => {
                            assert.ifError(err);
                            assert.ok(count <= 2, `expected <=2 entries, got ${count}`);
                            done();
                        }
                    );
                });
            });
        });
    });

    it('entries from a different logName are not returned', done => {
        StatLog.appendSystemLogEntry('log_a', 'aval', -1, 'forever', e1 => {
            assert.ifError(e1);
            StatLog.appendSystemLogEntry('log_b', 'bval', -1, 'forever', e2 => {
                assert.ifError(e2);
                StatLog.findSystemLogEntries({ logName: 'log_a' }, (err, rows) => {
                    assert.ifError(err);
                    assert.equal(rows.length, 1);
                    assert.equal(rows[0].log_value, 'aval');
                    done();
                });
            });
        });
    });
});
