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
}); // describe('user_db')
