'use strict';

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');

//
//  Config mock — minimal, needed before any transitive require.
//
const configModule = require('../core/config.js');
configModule.get = () => ({ debug: { assertsEnabled: false } });

//
//  In-memory DB injection.  user_temp_token.js captures dbs.user at load
//  time, so inject before requiring it.
//
const dbModule = require('../core/database.js');
const _testDb = new Database(':memory:');
dbModule.dbs.user = _testDb;

//
//  Force a fresh load so it captures the in-memory DB injected above.
//
delete require.cache[require.resolve('../core/user_temp_token.js')];
const userTempToken = require('../core/user_temp_token.js');

//  User.getUser is stubbed inside the getTokenInfo describe only.

// ─── schema ──────────────────────────────────────────────────────────────────

function applySchema(db, done) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS user_temporary_token (
            user_id     INTEGER NOT NULL,
            token       VARCHAR NOT NULL,
            token_type  VARCHAR NOT NULL,
            timestamp   DATETIME NOT NULL,
            UNIQUE(user_id, token_type)
        );
    `);
    return done(null);
}

// ─── createToken ─────────────────────────────────────────────────────────────

describe('userTempToken.createToken()', function () {
    before(done => applySchema(_testDb, done));

    beforeEach(done => {
        _testDb.exec('DELETE FROM user_temporary_token;');
        done();
    });

    it('creates a token and returns a hex string', done => {
        userTempToken.createToken(1, 'test_type', { bits: 128 }, (err, token) => {
            assert.ifError(err);
            assert.ok(token, 'token must be returned');
            assert.equal(typeof token, 'string');
            assert.ok(/^[0-9a-f]+$/.test(token), 'token must be hex');
            done();
        });
    });

    it('persists the token row to the DB', done => {
        userTempToken.createToken(2, 'test_type', { bits: 128 }, (err, token) => {
            assert.ifError(err);
            const row = _testDb
                .prepare(`SELECT * FROM user_temporary_token WHERE token=?`)
                .get(token);
            assert.ok(row, 'row should exist');
            assert.equal(row.user_id, 2);
            assert.equal(row.token_type, 'test_type');
            done();
        });
    });

    it('token is a long random hex string', done => {
        userTempToken.createToken(3, 'test_type', { bits: 128 }, (err, token) => {
            assert.ifError(err);
            assert.ok(/^[0-9a-f]{32,}$/.test(token), 'token should be a long hex string');
            done();
        });
    });

    it('replacing a token for the same user+type leaves exactly one row', done => {
        //  Seed a first token directly — avoids nested createToken calls that
        //  interact badly with async.waterfall + crypto in mocha's runner.
        _testDb
            .prepare(
                `INSERT INTO user_temporary_token (user_id, token, token_type, timestamp)
                VALUES (5, 'seedtoken', 'replace_type', DATETIME('now'))`
            )
            .run();

        userTempToken.createToken(5, 'replace_type', { bits: 128 }, (err, newToken) => {
            assert.ifError(err);
            assert.notEqual(newToken, 'seedtoken', 'token should be freshly generated');

            const count = _testDb
                .prepare(
                    `SELECT COUNT(*) AS n FROM user_temporary_token WHERE user_id=5 AND token_type='replace_type'`
                )
                .get().n;
            assert.equal(count, 1, 'REPLACE should leave exactly one row');

            const row = _testDb
                .prepare(
                    `SELECT token FROM user_temporary_token WHERE user_id=5 AND token_type='replace_type'`
                )
                .get();
            assert.equal(row.token, newToken, 'stored token should be the new one');
            done();
        });
    });
});

// ─── deleteToken ─────────────────────────────────────────────────────────────

describe('userTempToken.deleteToken()', function () {
    before(done => applySchema(_testDb, done));

    beforeEach(done => {
        _testDb.exec('DELETE FROM user_temporary_token;');
        done();
    });

    it('removes the row for the given token', done => {
        userTempToken.createToken(10, 'del_type', { bits: 128 }, (err, token) => {
            assert.ifError(err);
            userTempToken.deleteToken(token, err2 => {
                assert.ifError(err2);
                const row = _testDb
                    .prepare(`SELECT * FROM user_temporary_token WHERE token=?`)
                    .get(token);
                assert.equal(row, undefined);
                done();
            });
        });
    });

    it('is a no-op for a non-existent token', done => {
        userTempToken.deleteToken('deadbeef', err => {
            assert.ifError(err);
            done();
        });
    });
});

// ─── deleteTokenByUserAndType ─────────────────────────────────────────────────

describe('userTempToken.deleteTokenByUserAndType()', function () {
    before(done => applySchema(_testDb, done));

    beforeEach(done => {
        _testDb.exec('DELETE FROM user_temporary_token;');
        done();
    });

    it('removes the row for the given user + type', done => {
        userTempToken.createToken(20, 'auth_type', { bits: 128 }, (err, token) => {
            assert.ifError(err);
            userTempToken.deleteTokenByUserAndType(20, 'auth_type', err2 => {
                assert.ifError(err2);
                const row = _testDb
                    .prepare(`SELECT * FROM user_temporary_token WHERE token=?`)
                    .get(token);
                assert.equal(row, undefined);
                done();
            });
        });
    });

    it('does not remove tokens belonging to other types for the same user', done => {
        userTempToken.createToken(21, 'type_a', { bits: 128 }, err => {
            assert.ifError(err);
            userTempToken.createToken(22, 'type_b', { bits: 128 }, err2 => {
                assert.ifError(err2);
                userTempToken.deleteTokenByUserAndType(21, 'type_a', err3 => {
                    assert.ifError(err3);
                    const remaining = _testDb
                        .prepare(`SELECT COUNT(*) AS n FROM user_temporary_token`)
                        .get().n;
                    assert.equal(remaining, 1, 'type_b for user 22 should remain');
                    done();
                });
            });
        });
    });
});

// ─── getTokenInfo ─────────────────────────────────────────────────────────────

describe('userTempToken.getTokenInfo()', function () {
    const User = require('../core/user.js');
    let _origGetUser;

    before(done => {
        _origGetUser = User.getUser;
        User.getUser = (userId, cb) =>
            cb(null, { userId, username: 'stubuser', properties: {}, groups: [] });
        applySchema(_testDb, done);
    });

    after(function () {
        User.getUser = _origGetUser;
    });

    beforeEach(done => {
        _testDb.exec('DELETE FROM user_temporary_token;');
        done();
    });

    it('returns userId, tokenType, and a user object for a valid token', done => {
        userTempToken.createToken(30, 'info_type', { bits: 128 }, (err, token) => {
            assert.ifError(err);
            userTempToken.getTokenInfo(token, (err2, info) => {
                assert.ifError(err2);
                assert.equal(info.userId, 30);
                assert.equal(info.tokenType, 'info_type');
                assert.ok(info.timestamp, 'timestamp should be set');
                assert.ok(info.user, 'user object should be populated');
                assert.equal(info.user.userId, 30);
                done();
            });
        });
    });

    it('returns DoesNotExist error for an unknown token', done => {
        userTempToken.getTokenInfo('no_such_token', err => {
            assert.ok(err, 'expected an error');
            done();
        });
    });
});

// ─── temporaryTokenMaintenanceTask ────────────────────────────────────────────

describe('userTempToken.temporaryTokenMaintenanceTask()', function () {
    before(done => applySchema(_testDb, done));

    beforeEach(done => {
        _testDb.exec('DELETE FROM user_temporary_token;');
        done();
    });

    it('deletes expired tokens of the specified type', done => {
        //  Insert a row with a timestamp far in the past so it is immediately expired.
        _testDb
            .prepare(
                `INSERT INTO user_temporary_token (user_id, token, token_type, timestamp)
                VALUES (?, ?, ?, DATETIME('now', '-2 hours'))`
            )
            .run(40, 'expiredtoken', 'old_type');

        userTempToken.temporaryTokenMaintenanceTask(['old_type', '1 hour'], err => {
            assert.ifError(err);
            const row = _testDb
                .prepare(`SELECT * FROM user_temporary_token WHERE token='expiredtoken'`)
                .get();
            assert.equal(row, undefined, 'expired token should be deleted');
            done();
        });
    });

    it('retains tokens that have not yet expired', done => {
        _testDb
            .prepare(
                `INSERT INTO user_temporary_token (user_id, token, token_type, timestamp)
                VALUES (?, ?, ?, DATETIME('now'))`
            )
            .run(41, 'freshtoken', 'fresh_type');

        userTempToken.temporaryTokenMaintenanceTask(['fresh_type', '24 hours'], err => {
            assert.ifError(err);
            const row = _testDb
                .prepare(`SELECT * FROM user_temporary_token WHERE token='freshtoken'`)
                .get();
            assert.ok(row, 'fresh token should be retained');
            done();
        });
    });

    it('only deletes tokens of the specified type, leaving others intact', done => {
        _testDb
            .prepare(
                `INSERT INTO user_temporary_token (user_id, token, token_type, timestamp)
                VALUES (?, ?, ?, DATETIME('now', '-2 hours'))`
            )
            .run(42, 'old_a', 'type_a');
        _testDb
            .prepare(
                `INSERT INTO user_temporary_token (user_id, token, token_type, timestamp)
                VALUES (?, ?, ?, DATETIME('now', '-2 hours'))`
            )
            .run(43, 'old_b', 'type_b');

        userTempToken.temporaryTokenMaintenanceTask(['type_a', '1 hour'], err => {
            assert.ifError(err);
            const remaining = _testDb
                .prepare(`SELECT token_type FROM user_temporary_token`)
                .all();
            assert.equal(remaining.length, 1);
            assert.equal(remaining[0].token_type, 'type_b');
            done();
        });
    });
});
