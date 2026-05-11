'use strict';

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');

// ── Config mock (top-level: must be in place before any require chain fires) ──
const configModule = require('../core/config.js');
const TEST_CONFIG = {
    debug: { assertsEnabled: false },
    users: {
        usernameMin: 2,
        usernameMax: 32,
        requireActivation: false,
        defaultGroups: ['users'],
        failedLogin: { lockAccount: 0 },
    },
};
configModule.get = () => TEST_CONFIG;

const Events = require('../core/events.js');
const StatLog = require('../core/stat_log.js');
const dbModule = require('../core/database.js');

// ── Schema helpers ────────────────────────────────────────────────────────────
function applyUserSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS user (
            id        INTEGER PRIMARY KEY,
            user_name VARCHAR NOT NULL,
            UNIQUE(user_name)
        );
        CREATE TABLE IF NOT EXISTS user_property (
            user_id    INTEGER NOT NULL,
            prop_name  VARCHAR NOT NULL,
            prop_value VARCHAR,
            UNIQUE(user_id, prop_name),
            FOREIGN KEY(user_id) REFERENCES user(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS user_property_idx ON user_property (user_id, prop_name);
        CREATE TABLE IF NOT EXISTS user_group_member (
            group_name VARCHAR NOT NULL,
            user_id    INTEGER NOT NULL,
            UNIQUE(group_name, user_id)
        );
        CREATE TABLE IF NOT EXISTS user_achievement (
            user_id         INTEGER NOT NULL,
            achievement_tag VARCHAR NOT NULL,
            timestamp       DATETIME NOT NULL,
            match           VARCHAR NOT NULL,
            title           VARCHAR NOT NULL,
            text            VARCHAR NOT NULL,
            points          INTEGER NOT NULL,
            UNIQUE(user_id, achievement_tag, match),
            FOREIGN KEY(user_id) REFERENCES user(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS user_temporary_token (
            user_id    INTEGER NOT NULL,
            token      VARCHAR NOT NULL,
            token_type VARCHAR NOT NULL,
            timestamp  DATETIME NOT NULL,
            UNIQUE(user_id, token_type),
            FOREIGN KEY(user_id) REFERENCES user(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS api_refresh_tokens (
            id         INTEGER PRIMARY KEY,
            user_id    INTEGER NOT NULL,
            token_hash VARCHAR NOT NULL,
            issued_at  DATETIME NOT NULL,
            expires_at DATETIME NOT NULL,
            revoked    INTEGER NOT NULL DEFAULT 0,
            UNIQUE(token_hash),
            FOREIGN KEY(user_id) REFERENCES user(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS api_keys (
            id           INTEGER PRIMARY KEY,
            user_id      INTEGER NOT NULL,
            key_hash     VARCHAR NOT NULL,
            label        VARCHAR NOT NULL DEFAULT '',
            scope        VARCHAR NOT NULL DEFAULT 'read',
            created_at   DATETIME NOT NULL,
            last_used_at DATETIME,
            revoked      INTEGER NOT NULL DEFAULT 0,
            UNIQUE(key_hash),
            FOREIGN KEY(user_id) REFERENCES user(id) ON DELETE CASCADE
        );
    `);
}

function applySystemSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS system_stat (
            stat_name  VARCHAR PRIMARY KEY NOT NULL,
            stat_value VARCHAR NOT NULL
        );
    `);
}

// ── Suite ─────────────────────────────────────────────────────────────────────
describe('rest_auth', function () {
    let auth;
    let testUserId;

    //  Saved originals so we can restore after the suite
    let _origUserDb, _origSystemDb;
    let _origEmit, _origListenerCount;
    let _origSetUserStat, _origIncrementUserStat;

    before(function () {
        //  Stash originals
        _origUserDb = dbModule.dbs.user;
        _origSystemDb = dbModule.dbs.system;
        _origEmit = Events.emit;
        _origListenerCount = Events.listenerCount;
        _origSetUserStat = StatLog.setUserStat;
        _origIncrementUserStat = StatLog.incrementUserStat;

        //  Install fresh in-memory DBs
        const userDb = new Database(':memory:');
        userDb.pragma('foreign_keys = ON');
        dbModule.dbs.user = userDb;

        const systemDb = new Database(':memory:');
        dbModule.dbs.system = systemDb;

        applyUserSchema(userDb);
        applySystemSchema(systemDb);

        //  Stub statics that write to external systems
        StatLog.setUserStat = (user, name, value, cb) => {
            user.properties[name] = value;
            if (cb) cb(null);
        };
        StatLog.incrementUserStat = (user, name, by = 1, cb) => {
            const cur = parseInt(user.properties[name] || 0);
            user.properties[name] = cur + by;
            if (cb) cb(null);
        };
        Events.emit = () => {};
        Events.listenerCount = () => 0;

        //  Force-reload user and auth so they capture the new dbs references
        delete require.cache[require.resolve('../core/user_group.js')];
        delete require.cache[require.resolve('../core/user.js')];
        delete require.cache[require.resolve('../core/rest/auth.js')];

        auth = require('../core/rest/auth.js');

        //  Seed a test user
        const info = userDb.prepare("INSERT INTO user (user_name) VALUES ('testuser')").run();
        testUserId = info.lastInsertRowid;
        userDb.prepare("INSERT INTO user_group_member (group_name, user_id) VALUES ('users', ?)").run(testUserId);
    });

    after(function () {
        //  Restore originals so we don't pollute later test files
        dbModule.dbs.user = _origUserDb;
        dbModule.dbs.system = _origSystemDb;
        Events.emit = _origEmit;
        Events.listenerCount = _origListenerCount;
        StatLog.setUserStat = _origSetUserStat;
        StatLog.incrementUserStat = _origIncrementUserStat;

        //  Evict auth from cache so later tests get a fresh copy bound to real DBs
        delete require.cache[require.resolve('../core/user_group.js')];
        delete require.cache[require.resolve('../core/user.js')];
        delete require.cache[require.resolve('../core/rest/auth.js')];
    });

    // ── getOrCreateJwtSecret ──────────────────────────────────────────────────

    describe('getOrCreateJwtSecret()', function () {
        it('generates a secret on first call', function () {
            const secret = auth.getOrCreateJwtSecret();
            assert.ok(secret, 'secret should be truthy');
            assert.equal(typeof secret, 'string');
            assert.ok(secret.length >= 32, 'secret should be at least 32 chars');
        });

        it('returns the same secret on subsequent calls', function () {
            const a = auth.getOrCreateJwtSecret();
            const b = auth.getOrCreateJwtSecret();
            assert.equal(a, b);
        });
    });

    // ── issueTokenPair ────────────────────────────────────────────────────────

    describe('issueTokenPair()', function () {
        it('issues an access token and refresh token', function (done) {
            auth.issueTokenPair(testUserId, 'testuser', ['users'], (err, tokens) => {
                assert.ifError(err);
                assert.ok(tokens.accessToken, 'accessToken present');
                assert.ok(tokens.refreshToken, 'refreshToken present');
                assert.equal(tokens.expiresIn, 15 * 60);
                done();
            });
        });

        it('stores refresh token hash in DB (not plaintext)', function (done) {
            auth.issueTokenPair(testUserId, 'testuser', ['users'], (err, tokens) => {
                assert.ifError(err);

                const rows = dbModule.dbs.user
                    .prepare('SELECT token_hash FROM api_refresh_tokens WHERE revoked = 0 AND user_id = ?')
                    .all(testUserId);

                const hasPlaintext = rows.some(r => r.token_hash === tokens.refreshToken);
                assert.ok(!hasPlaintext, 'plaintext token must not be stored');
                done();
            });
        });
    });

    // ── rotateRefreshToken ────────────────────────────────────────────────────

    describe('rotateRefreshToken()', function () {
        it('issues new tokens and revokes the old refresh token', function (done) {
            auth.issueTokenPair(testUserId, 'testuser', ['users'], (err, first) => {
                assert.ifError(err);

                auth.rotateRefreshToken(first.refreshToken, (err, second) => {
                    assert.ifError(err);
                    assert.ok(second.accessToken);
                    assert.notEqual(second.refreshToken, first.refreshToken);

                    auth.rotateRefreshToken(first.refreshToken, err2 => {
                        assert.ok(err2, 're-using old token should error');
                        done();
                    });
                });
            });
        });

        it('rejects an unknown refresh token', function (done) {
            auth.rotateRefreshToken('not-a-real-token', err => {
                assert.ok(err, 'should return an error');
                done();
            });
        });
    });

    // ── revokeRefreshToken ────────────────────────────────────────────────────

    describe('revokeRefreshToken()', function () {
        it('marks the token as revoked', function (done) {
            auth.issueTokenPair(testUserId, 'testuser', ['users'], (err, tokens) => {
                assert.ifError(err);

                auth.revokeRefreshToken(tokens.refreshToken, err => {
                    assert.ifError(err);

                    auth.rotateRefreshToken(tokens.refreshToken, rotErr => {
                        assert.ok(rotErr, 'revoked token should not rotate');
                        done();
                    });
                });
            });
        });
    });

    // ── API key management ────────────────────────────────────────────────────

    describe('storeApiKey() / listApiKeys() / revokeApiKey()', function () {
        it('stores a key and returns it in the list', function (done) {
            auth.storeApiKey(testUserId, 'test-label', 'read', (err, rawKey) => {
                assert.ifError(err);
                assert.ok(rawKey, 'raw key returned');

                auth.listApiKeys(testUserId, (err, keys) => {
                    assert.ifError(err);
                    const found = keys.find(k => k.label === 'test-label');
                    assert.ok(found, 'key appears in list');
                    assert.equal(found.revoked, 0);
                    done();
                });
            });
        });

        it('revokeApiKey() marks the key revoked', function (done) {
            auth.storeApiKey(testUserId, 'to-revoke', 'read', (err) => {
                assert.ifError(err);

                auth.listApiKeys(testUserId, (err, keys) => {
                    assert.ifError(err);
                    const key = keys.find(k => k.label === 'to-revoke');
                    assert.ok(key);

                    auth.revokeApiKey(key.id, testUserId, (err, changed) => {
                        assert.ifError(err);
                        assert.ok(changed, 'should report a change');

                        auth.listApiKeys(testUserId, (err, keys2) => {
                            assert.ifError(err);
                            const revoked = keys2.find(k => k.id === key.id);
                            assert.equal(revoked.revoked, 1);
                            done();
                        });
                    });
                });
            });
        });

        it('hashApiKey() is deterministic', function () {
            const h1 = auth.hashApiKey('some-key');
            const h2 = auth.hashApiKey('some-key');
            assert.equal(h1, h2);
            assert.notEqual(h1, 'some-key');
        });
    });

    // ── resolveAuthenticatedUser ──────────────────────────────────────────────

    describe('resolveAuthenticatedUser()', function () {
        it('returns null for unauthenticated request', function (done) {
            const req = { headers: {} };
            auth.resolveAuthenticatedUser(req, (err, user) => {
                assert.ifError(err);
                assert.equal(user, null);
                done();
            });
        });

        it('resolves a valid JWT Bearer token', function (done) {
            auth.issueTokenPair(testUserId, 'testuser', ['users'], (err, tokens) => {
                assert.ifError(err);

                const req = { headers: { authorization: `Bearer ${tokens.accessToken}` } };
                auth.resolveAuthenticatedUser(req, (err, user) => {
                    assert.ifError(err);
                    assert.ok(user, 'user should be resolved');
                    assert.equal(user.userId, testUserId);
                    assert.equal(user.username, 'testuser');
                    assert.equal(user.scope, 'jwt');
                    done();
                });
            });
        });

        it('returns null for a tampered JWT', function (done) {
            auth.issueTokenPair(testUserId, 'testuser', ['users'], (err, tokens) => {
                assert.ifError(err);

                const tampered = tokens.accessToken.slice(0, -4) + 'XXXX';
                const req = { headers: { authorization: `Bearer ${tampered}` } };
                auth.resolveAuthenticatedUser(req, (err, user) => {
                    assert.ifError(err);
                    assert.equal(user, null);
                    done();
                });
            });
        });
    });
});
