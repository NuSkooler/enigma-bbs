'use strict';

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');

//
//  Config mock — must be in place before requiring user.js which captures
//  Config.get at load time.
//
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

//
//  In-memory DB injection — must happen before requiring user.js.
//
const dbModule = require('../core/database.js');
const _testDb = new Database(':memory:');
_testDb.pragma('foreign_keys = ON');
dbModule.dbs.user = _testDb;

//  Stub Events to avoid full system initialisation. The originals are saved
//  here so we can restore them in the wrapping describe's after() — these
//  stubs live on the Events singleton, so leaking them past this file's
//  tests breaks every other test that relies on Events.emit() (e.g. the
//  whole BinkP / NewInboundBSO chain).
const Events = require('../core/events.js');
const _origEventsEmit = Events.emit;
const _origEventsListenerCount = Events.listenerCount;

//
//  Force fresh loads of user.js and user_group.js so both capture the
//  in-memory DB above.  Both are loaded transitively by earlier test files
//  (via achievement.js → activitypub/util.js) before we had a chance to
//  inject the right config/DB, so we must evict the stale cached copies.
//
delete require.cache[require.resolve('../core/user_group.js')];
delete require.cache[require.resolve('../core/user.js')];

//  Module under test — loaded after Config mock and DB are in place.
const User = require('../core/user.js');
const UserProps = require('../core/user_property.js');

//  StatLog stubs — installed in before() so they don't clobber achievement
//  test's stubs during Mocha's file-load phase (all top-level code runs
//  before any test executes).
const StatLog = require('../core/stat_log.js');
let _origSetUserStat;
let _origIncrementUserStat;

//  All this file's tests live inside a wrapping describe so the StatLog
//  and Events stubs are scoped to user_db's own tests. Without this they
//  would be installed at file-load time and persist for the entire suite,
//  breaking every test elsewhere that emits or counts listeners.
describe('user_db', function () {
    before(function () {
        _origSetUserStat = StatLog.setUserStat;
        _origIncrementUserStat = StatLog.incrementUserStat;
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
    });

    after(function () {
        StatLog.setUserStat = _origSetUserStat;
        StatLog.incrementUserStat = _origIncrementUserStat;
        Events.emit = _origEventsEmit;
        Events.listenerCount = _origEventsListenerCount;
    });

    // ─── schema ──────────────────────────────────────────────────────────────────

    function applySchema(db, done) {
        db.exec(`
        CREATE TABLE IF NOT EXISTS user (
            id          INTEGER PRIMARY KEY,
            user_name   VARCHAR NOT NULL,
            UNIQUE(user_name)
        );

        CREATE TABLE IF NOT EXISTS user_property (
            user_id     INTEGER NOT NULL,
            prop_name   VARCHAR NOT NULL,
            prop_value  VARCHAR,
            UNIQUE(user_id, prop_name),
            FOREIGN KEY(user_id) REFERENCES user(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS user_property_id_and_name_index0
            ON user_property (user_id, prop_name);

        CREATE TABLE IF NOT EXISTS user_group_member (
            group_name  VARCHAR NOT NULL,
            user_id     INTEGER NOT NULL,
            UNIQUE(group_name, user_id)
        );

        CREATE TABLE IF NOT EXISTS user_achievement (
            user_id             INTEGER NOT NULL,
            achievement_tag     VARCHAR NOT NULL,
            timestamp           DATETIME NOT NULL,
            match               VARCHAR NOT NULL,
            title               VARCHAR NOT NULL,
            text                VARCHAR NOT NULL,
            points              INTEGER NOT NULL,
            UNIQUE(user_id, achievement_tag, match),
            FOREIGN KEY(user_id) REFERENCES user(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS user_temporary_token (
            user_id     INTEGER NOT NULL,
            token       VARCHAR NOT NULL,
            token_type  VARCHAR NOT NULL,
            timestamp   DATETIME NOT NULL,
            UNIQUE(user_id, token_type),
            FOREIGN KEY(user_id) REFERENCES user(id) ON DELETE CASCADE
        );
    `);
        return done(null);
    }

    // ─── helpers ─────────────────────────────────────────────────────────────────

    let _userSeq = 0;
    function uniqueName() {
        return `testuser${++_userSeq}`;
    }

    function createUser(username, password, cb) {
        const user = new User();
        user.username = username;
        user.create({ password }, err => cb(err, user));
    }

    // ─── User.create() ───────────────────────────────────────────────────────────

    describe('User.create()', function () {
        this.timeout(5000); //  PBKDF2 can be slow in tests

        before(done => applySchema(_testDb, done));

        beforeEach(done => {
            _testDb.exec(
                'DELETE FROM user_group_member; DELETE FROM user_property; DELETE FROM user;'
            );
            _userSeq = 0;
            done();
        });

        it('assigns a positive userId after create', done => {
            createUser(uniqueName(), 'p@ssw0rd', (err, user) => {
                assert.ifError(err);
                assert.ok(user.userId > 0, 'userId must be set after create');
                done();
            });
        });

        it('persists user row to DB', done => {
            const name = uniqueName();
            createUser(name, 'secret', (err, user) => {
                assert.ifError(err);
                const row = _testDb
                    .prepare(`SELECT user_name FROM user WHERE id=?`)
                    .get(user.userId);
                assert.ok(row, 'user row should exist in DB');
                assert.equal(row.user_name, name);
                done();
            });
        });

        it('stores password salt and dk as properties', done => {
            createUser(uniqueName(), 'password123', (err, user) => {
                assert.ifError(err);
                assert.ok(
                    user.properties[UserProps.PassPbkdf2Salt],
                    'salt should be set'
                );
                assert.ok(user.properties[UserProps.PassPbkdf2Dk], 'dk should be set');
                done();
            });
        });

        it('first user (root) gets userId=1 and sysops group', done => {
            createUser(uniqueName(), 'rootpass', (err, user) => {
                assert.ifError(err);
                assert.equal(user.userId, 1);
                assert.ok(
                    user.groups.includes('sysops'),
                    'root user should be in sysops'
                );
                done();
            });
        });

        it('subsequent users get incrementing IDs', done => {
            createUser(uniqueName(), 'pass1', (err1, user1) => {
                assert.ifError(err1);
                createUser(uniqueName(), 'pass2', (err2, user2) => {
                    assert.ifError(err2);
                    assert.ok(user2.userId > user1.userId);
                    done();
                });
            });
        });

        it('rejects duplicate username', done => {
            const name = uniqueName();
            createUser(name, 'pass1', err1 => {
                assert.ifError(err1);
                createUser(name, 'pass2', err2 => {
                    assert.ok(err2, 'expected error on duplicate username');
                    done();
                });
            });
        });

        it('rejects username shorter than usernameMin', done => {
            const user = new User();
            user.username = 'x'; //  length 1, min is 2
            user.create({ password: 'pass' }, err => {
                assert.ok(err, 'expected invalid-length error');
                done();
            });
        });

        it('assigns default groups from config', done => {
            createUser(uniqueName(), 'pass', (err, user) => {
                assert.ifError(err);
                assert.ok(
                    user.groups.includes('users'),
                    'should be in default "users" group'
                );
                done();
            });
        });
    });

    // ─── User.getUser() / persistProperty() ──────────────────────────────────────

    describe('User.getUser() and persistProperty()', function () {
        this.timeout(5000);

        before(done => applySchema(_testDb, done));

        beforeEach(done => {
            _testDb.exec(
                'DELETE FROM user_group_member; DELETE FROM user_property; DELETE FROM user;'
            );
            _userSeq = 0;
            done();
        });

        it('getUser() returns the correct username', done => {
            createUser(uniqueName(), 'pass', (err, created) => {
                assert.ifError(err);
                User.getUser(created.userId, (err2, loaded) => {
                    assert.ifError(err2);
                    assert.equal(loaded.username, created.username);
                    done();
                });
            });
        });

        it('getUser() returns stored properties', done => {
            createUser(uniqueName(), 'pass', (err, created) => {
                assert.ifError(err);
                User.getUser(created.userId, (err2, loaded) => {
                    assert.ifError(err2);
                    assert.ok(loaded.properties[UserProps.PassPbkdf2Salt]);
                    done();
                });
            });
        });

        it('persistProperty() round-trips a custom property', done => {
            createUser(uniqueName(), 'pass', (err, user) => {
                assert.ifError(err);
                user.persistProperty('test_prop', 'hello', propErr => {
                    assert.ifError(propErr);

                    User.getUser(user.userId, (err2, loaded) => {
                        assert.ifError(err2);
                        assert.equal(loaded.properties['test_prop'], 'hello');
                        done();
                    });
                });
            });
        });

        it('persistProperty() overwrites an existing property', done => {
            createUser(uniqueName(), 'pass', (err, user) => {
                assert.ifError(err);
                user.persistProperty('mutable_prop', 'first', e1 => {
                    assert.ifError(e1);
                    user.persistProperty('mutable_prop', 'second', e2 => {
                        assert.ifError(e2);
                        User.getUser(user.userId, (e3, loaded) => {
                            assert.ifError(e3);
                            assert.equal(loaded.properties['mutable_prop'], 'second');
                            done();
                        });
                    });
                });
            });
        });

        it('getUser() returns groups', done => {
            createUser(uniqueName(), 'pass', (err, user) => {
                assert.ifError(err);
                User.getUser(user.userId, (err2, loaded) => {
                    assert.ifError(err2);
                    assert.ok(Array.isArray(loaded.groups));
                    assert.ok(loaded.groups.includes('users'));
                    done();
                });
            });
        });
    });
    // ─── Password hashing / migration ────────────────────────────────────────────

    describe('PBKDF2 hashing and migration', function () {
        //  210k-iteration PBKDF2-SHA-512 takes ~1-3 s per hash on modern hardware.
        //  Tests that touch the current params budget 15 s each; legacy-only tests
        //  (1k iterations) stay fast.
        this.timeout(30000);

        before(done => applySchema(_testDb, done));

        beforeEach(done => {
            _testDb.exec(
                'DELETE FROM user_group_member; DELETE FROM user_property; DELETE FROM user;'
            );
            _userSeq = 0;
            done();
        });

        // ── getHashParams ──────────────────────────────────────────────────────────

        it('getHashParams() returns LegacyPBKDF2 when PassHashParams is absent', () => {
            const params = User.getHashParams({});
            assert.deepEqual(params, User.LegacyPBKDF2);
        });

        it('getHashParams() returns LegacyPBKDF2 when PassHashParams is corrupt JSON', () => {
            const params = User.getHashParams({
                [UserProps.PassHashParams]: 'not-json{',
            });
            assert.deepEqual(params, User.LegacyPBKDF2);
        });

        it('getHashParams() returns stored params when PassHashParams is valid JSON', () => {
            const stored = {
                iterations: 210000,
                digest: 'sha512',
                keyLen: 64,
                saltLen: 32,
            };
            const params = User.getHashParams({
                [UserProps.PassHashParams]: JSON.stringify(stored),
            });
            assert.deepEqual(params, stored);
        });

        // ── needsRehash ────────────────────────────────────────────────────────────

        it('needsRehash() returns true when PassHashParams is absent (legacy user)', () => {
            assert.ok(User.needsRehash({}));
        });

        it('needsRehash() returns true when stored iterations differ from target', () => {
            const oldParams = { ...User.PBKDF2, iterations: 1000 };
            assert.ok(
                User.needsRehash({
                    [UserProps.PassHashParams]: JSON.stringify(oldParams),
                })
            );
        });

        it('needsRehash() returns true when stored digest differs from target', () => {
            const oldParams = { ...User.PBKDF2, digest: 'sha1' };
            assert.ok(
                User.needsRehash({
                    [UserProps.PassHashParams]: JSON.stringify(oldParams),
                })
            );
        });

        it('needsRehash() returns true when stored keyLen differs from target', () => {
            const oldParams = { ...User.PBKDF2, keyLen: 128 };
            assert.ok(
                User.needsRehash({
                    [UserProps.PassHashParams]: JSON.stringify(oldParams),
                })
            );
        });

        it('needsRehash() returns false when stored params match current target', () => {
            assert.ok(
                !User.needsRehash({
                    [UserProps.PassHashParams]: JSON.stringify(User.PBKDF2),
                })
            );
        });

        // ── generatePasswordDerivedKey ─────────────────────────────────────────────

        it('generatePasswordDerivedKey() defaults to current PBKDF2 params', done => {
            User.generatePasswordDerivedKeySalt((err, salt) => {
                assert.ifError(err);
                User.generatePasswordDerivedKey('secret', salt, (err, dk) => {
                    assert.ifError(err);
                    //  sha512, keyLen 64 → 128 hex chars
                    assert.equal(dk.length, User.PBKDF2.keyLen * 2);
                    done();
                });
            });
        });

        it('generatePasswordDerivedKey() accepts explicit legacy params and produces legacy-length DK', done => {
            User.generatePasswordDerivedKeySalt((err, salt) => {
                assert.ifError(err);
                User.generatePasswordDerivedKey(
                    'secret',
                    salt,
                    User.LegacyPBKDF2,
                    (err, dk) => {
                        assert.ifError(err);
                        //  sha1, keyLen 128 → 256 hex chars
                        assert.equal(dk.length, User.LegacyPBKDF2.keyLen * 2);
                        done();
                    }
                );
            });
        });

        it('generatePasswordDerivedKey() produces the same DK for the same inputs and params', done => {
            User.generatePasswordDerivedKeySalt((err, salt) => {
                assert.ifError(err);
                User.generatePasswordDerivedKey(
                    'mypass',
                    salt,
                    User.LegacyPBKDF2,
                    (err, dk1) => {
                        assert.ifError(err);
                        User.generatePasswordDerivedKey(
                            'mypass',
                            salt,
                            User.LegacyPBKDF2,
                            (err, dk2) => {
                                assert.ifError(err);
                                assert.equal(dk1, dk2);
                                done();
                            }
                        );
                    }
                );
            });
        });

        // ── create() stores current params ─────────────────────────────────────────

        it('create() stores PassHashParams matching current PBKDF2 target', done => {
            createUser(uniqueName(), 'p@ssw0rd!', (err, user) => {
                assert.ifError(err);
                const raw = user.properties[UserProps.PassHashParams];
                assert.ok(raw, 'PassHashParams should be stored');
                const stored = JSON.parse(raw);
                assert.equal(stored.iterations, User.PBKDF2.iterations);
                assert.equal(stored.digest, User.PBKDF2.digest);
                assert.equal(stored.keyLen, User.PBKDF2.keyLen);
                done();
            });
        });

        it('create() stores a DK of the current keyLen', done => {
            createUser(uniqueName(), 'p@ssw0rd!', (err, user) => {
                assert.ifError(err);
                const dk = user.properties[UserProps.PassPbkdf2Dk];
                assert.equal(
                    dk.length,
                    User.PBKDF2.keyLen * 2,
                    'DK length should match current keyLen'
                );
                done();
            });
        });

        it('needsRehash() returns false for a freshly created user', done => {
            createUser(uniqueName(), 'p@ssw0rd!', (err, user) => {
                assert.ifError(err);
                assert.ok(!User.needsRehash(user.properties));
                done();
            });
        });

        // ── legacy user migration ──────────────────────────────────────────────────

        //  Manually inserts a user with legacy (SHA-1, 1000-iteration) credentials,
        //  simulating a pre-migration account in the database.
        function insertLegacyUser(username, password, done) {
            User.generatePasswordDerivedKeySalt((err, salt) => {
                assert.ifError(err);
                User.generatePasswordDerivedKey(
                    password,
                    salt,
                    User.LegacyPBKDF2,
                    (err, dk) => {
                        assert.ifError(err);

                        const info = _testDb
                            .prepare(`INSERT INTO user (user_name) VALUES (?);`)
                            .run(username);
                        const userId = info.lastInsertRowid;

                        const propStmt = _testDb.prepare(
                            `REPLACE INTO user_property (user_id, prop_name, prop_value) VALUES (?, ?, ?);`
                        );
                        propStmt.run(userId, UserProps.PassPbkdf2Salt, salt);
                        propStmt.run(userId, UserProps.PassPbkdf2Dk, dk);
                        propStmt.run(userId, UserProps.AccountStatus, '2'); //  active (User.AccountStatus.active === 2)
                        //  Intentionally omit PassHashParams — this is the legacy state.

                        const groupStmt = _testDb.prepare(
                            `INSERT OR IGNORE INTO user_group_member (group_name, user_id) VALUES (?, ?);`
                        );
                        groupStmt.run('users', userId);

                        done(null, userId);
                    }
                );
            });
        }

        it('needsRehash() returns true for a manually inserted legacy user', done => {
            insertLegacyUser(uniqueName(), 'legacypass', (err, userId) => {
                assert.ifError(err);
                const props = _testDb
                    .prepare(
                        `SELECT prop_name, prop_value FROM user_property WHERE user_id = ?`
                    )
                    .all(userId)
                    .reduce((acc, r) => {
                        acc[r.prop_name] = r.prop_value;
                        return acc;
                    }, {});
                assert.ok(User.needsRehash(props));
                done();
            });
        });

        it('authenticateFactor1() succeeds for a legacy user', done => {
            const name = uniqueName();
            const pass = 'legacypass1';
            insertLegacyUser(name, pass, err => {
                assert.ifError(err);
                const user = new User();
                user.authenticateFactor1(
                    {
                        username: name,
                        password: pass,
                        type: User.AuthFactor1Types.Password,
                    },
                    err => {
                        assert.ifError(err);
                        done();
                    }
                );
            });
        });

        it('authenticateFactor1() upgrades legacy hash params on successful login', done => {
            const name = uniqueName();
            const pass = 'legacypass2';
            insertLegacyUser(name, pass, (err, userId) => {
                assert.ifError(err);
                const user = new User();
                user.authenticateFactor1(
                    {
                        username: name,
                        password: pass,
                        type: User.AuthFactor1Types.Password,
                    },
                    err => {
                        assert.ifError(err);
                        //  rehash is fire-and-forget; give it a moment to complete
                        setTimeout(() => {
                            //  budget for 210k-iteration PBKDF2 rehash
                            const row = _testDb
                                .prepare(
                                    `SELECT prop_value FROM user_property WHERE user_id = ? AND prop_name = ?`
                                )
                                .get(userId, UserProps.PassHashParams);
                            assert.ok(
                                row,
                                'PassHashParams should now be stored after rehash'
                            );
                            const stored = JSON.parse(row.prop_value);
                            assert.equal(stored.iterations, User.PBKDF2.iterations);
                            assert.equal(stored.digest, User.PBKDF2.digest);
                            assert.equal(stored.keyLen, User.PBKDF2.keyLen);
                            done();
                        }, 3000);
                    }
                );
            });
        });

        it('re-hashed legacy user can authenticate again with new params', done => {
            const name = uniqueName();
            const pass = 'legacypass3';
            insertLegacyUser(name, pass, err => {
                assert.ifError(err);
                const user1 = new User();
                user1.authenticateFactor1(
                    {
                        username: name,
                        password: pass,
                        type: User.AuthFactor1Types.Password,
                    },
                    err => {
                        assert.ifError(err);
                        //  wait for rehash to land, then try logging in again
                        setTimeout(() => {
                            //  budget for 210k-iteration PBKDF2 rehash
                            const user2 = new User();
                            user2.authenticateFactor1(
                                {
                                    username: name,
                                    password: pass,
                                    type: User.AuthFactor1Types.Password,
                                },
                                err => {
                                    assert.ifError(
                                        err,
                                        'Second login with new hash params should succeed'
                                    );
                                    done();
                                }
                            );
                        }, 3000);
                    }
                );
            });
        });

        it('wrong password is rejected for a legacy user', done => {
            const name = uniqueName();
            insertLegacyUser(name, 'correctpass', err => {
                assert.ifError(err);
                const user = new User();
                user.authenticateFactor1(
                    {
                        username: name,
                        password: 'wrongpass',
                        type: User.AuthFactor1Types.Password,
                    },
                    err => {
                        assert.ok(err, 'Wrong password should be rejected');
                        done();
                    }
                );
            });
        });

        it('wrong password is rejected for a current-params user', done => {
            createUser(uniqueName(), 'correctpass', (err, created) => {
                assert.ifError(err);
                const user = new User();
                user.authenticateFactor1(
                    {
                        username: created.username,
                        password: 'wrongpass',
                        type: User.AuthFactor1Types.Password,
                    },
                    err => {
                        assert.ok(err, 'Wrong password should be rejected');
                        done();
                    }
                );
            });
        });

        // ── setNewAuthCredentials ──────────────────────────────────────────────────

        it('setNewAuthCredentials() stores updated PassHashParams', done => {
            createUser(uniqueName(), 'originalpass', (err, user) => {
                assert.ifError(err);
                user.setNewAuthCredentials('newpass', err => {
                    assert.ifError(err);
                    const raw = user.properties[UserProps.PassHashParams];
                    assert.ok(raw);
                    const stored = JSON.parse(raw);
                    assert.equal(stored.iterations, User.PBKDF2.iterations);
                    assert.equal(stored.digest, User.PBKDF2.digest);
                    done();
                });
            });
        });
    });
}); // describe('user_db')
