'use strict';

//
//  users.failedLogin.lockAccount: an active account is locked once it has
//  had that many failed logins in a row, and unlocked (by autoUnlockMinutes,
//  a sysop, or a password reset) back to the status it had. Through
//  User.authenticateFactor1() on an in-memory user database, with the real
//  StatLog counting the failures.
//

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');
const _ = require('lodash');

const configModule = require('../core/config.js');
const configDefault = require('../core/config_default.js');
const dbModule = require('../core/database.js');
const Events = require('../core/events.js');
const UserProps = require('../core/user_property.js');
const { ErrorReasons } = require('../core/enig_error.js');

//  These capture the user database and Config at first require. stat_log.js
//  too: other test files replace its methods (and leave them replaced), and
//  User counts failed logins with it.
const FreshPaths = [
    '../core/stat_log.js',
    '../core/user_group.js',
    '../core/user.js',
].map(p => require.resolve(p));

const RightPass = 'right-pass';

describe('account lockout (users.failedLogin)', function () {
    this.timeout(20000); //  PBKDF2

    let saved;
    let previousConfig;
    let config;
    let db;
    let User;
    let StatLog;
    let passProps;

    before(done => {
        config = _.merge(configDefault(), {
            debug: { assertsEnabled: false },
            users: {
                failedLogin: { disconnect: 0, lockAccount: 3, autoUnlockMinutes: 60 },
            },
        });
        previousConfig = configModule._pushTestConfig(config);

        db = new Database(':memory:');
        db.exec(`
            CREATE TABLE user (
                id          INTEGER PRIMARY KEY,
                user_name   VARCHAR NOT NULL,
                UNIQUE(user_name)
            );
            CREATE TABLE user_property (
                user_id     INTEGER NOT NULL,
                prop_name   VARCHAR NOT NULL,
                prop_value  VARCHAR,
                UNIQUE(user_id, prop_name)
            );
            CREATE TABLE user_group_member (
                group_name  VARCHAR NOT NULL,
                user_id     INTEGER NOT NULL,
                UNIQUE(group_name, user_id)
            );
        `);

        saved = {
            modules: FreshPaths.map(p => require.cache[p]),
            userDb: dbModule.dbs.user,
            emit: Events.emit,
        };
        dbModule.dbs.user = db;
        FreshPaths.forEach(p => delete require.cache[p]);
        Events.emit = () => true;

        StatLog = require(FreshPaths[0]);
        require(FreshPaths[1]);
        User = require(FreshPaths[2]);

        User.generatePasswordDerivedKeyAndSalt(RightPass, (err, info) => {
            if (err) {
                return done(err);
            }
            passProps = {
                [UserProps.PassPbkdf2Salt]: info.salt,
                [UserProps.PassPbkdf2Dk]: info.dk,
                [UserProps.PassHashParams]: JSON.stringify(User.PBKDF2),
            };
            return done();
        });
    });

    after(() => {
        FreshPaths.forEach((p, i) => {
            if (saved.modules[i]) {
                require.cache[p] = saved.modules[i];
            } else {
                delete require.cache[p];
            }
        });
        dbModule.dbs.user = saved.userDb;
        Events.emit = saved.emit;
        configModule._popTestConfig(previousConfig);
        db.close();
    });

    let userSeq = 0;
    function addUser(props = {}) {
        const username = `lockuser${++userSeq}`;
        const userId = Number(
            db.prepare('INSERT INTO user (user_name) VALUES (?)').run(username)
                .lastInsertRowid
        );
        const stmt = db.prepare(
            'INSERT INTO user_property (user_id, prop_name, prop_value) VALUES (?, ?, ?)'
        );
        _.each(
            Object.assign(
                { [UserProps.AccountStatus]: String(User.AccountStatus.active) },
                passProps,
                props
            ),
            (value, name) => {
                if (undefined !== value) {
                    stmt.run(userId, name, String(value));
                }
            }
        );
        return { username, userId };
    }

    function getProp(userId, name) {
        const row = db
            .prepare(
                'SELECT prop_value FROM user_property WHERE user_id = ? AND prop_name = ?'
            )
            .get(userId, name);
        return row ? row.prop_value : undefined;
    }

    function login(username, password) {
        return new Promise(resolve => {
            const user = new User();
            user.authenticateFactor1(
                { username, password, type: User.AuthFactor1Types.Password },
                err => resolve({ err, user })
            );
        });
    }

    async function failTimes(username, n) {
        for (let i = 0; i < n; ++i) {
            const { err } = await login(username, 'wrong-pass');
            assert.ok(err, 'a wrong password is refused');
        }
    }

    const hoursAgo = h => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
    const status = name => String(User.AccountStatus[name]);

    it('StatLog.incrementUserStat() calls back with the new value', done => {
        const user = { properties: { n: '4' } };
        user.getPropertyAsNumber = name => parseInt(user.properties[name], 10);
        user.persistProperty = (name, value, cb) => {
            user.properties[name] = value;
            return cb(null);
        };
        StatLog.incrementUserStat(user, 'n', 2, (err, newValue) => {
            assert.ifError(err);
            assert.equal(newValue, 6);
            done();
        });
    });

    describe('the failed login count stat event', () => {
        const LogPath = require.resolve('../core/logger.js');
        let warnings;
        let savedWarn;

        //  run |fn| with |listener| for UserStatIncrement in place of the stub
        async function withListener(listener, fn) {
            const stubbedEmit = Events.emit;
            Events.emit = (event, info) => {
                if (Events.getSystemEvents().UserStatIncrement === event) {
                    listener(info);
                }
                return true;
            };
            try {
                return await fn();
            } finally {
                Events.emit = stubbedEmit;
            }
        }

        beforeEach(() => {
            warnings = [];
            const log = require(LogPath).log;
            savedWarn = log.warn;
            log.warn = (fields, msg) => warnings.push({ fields, msg });
        });

        afterEach(() => {
            require(LogPath).log.warn = savedWarn;
        });

        it('is sent once the count is stored, outside the transaction', async () => {
            const { username, userId } = addUser({ [UserProps.FailedLoginAttempts]: 1 });
            const seen = [];
            await withListener(
                info => {
                    seen.push({
                        statName: info.statName,
                        statValue: info.statValue,
                        oldValue: info.oldValue,
                        stored: getProp(userId, UserProps.FailedLoginAttempts),
                        inTransaction: db.inTransaction,
                        userId: info.user.userId,
                    });
                },
                () => failTimes(username, 1)
            );
            assert.deepEqual(seen, [
                {
                    statName: UserProps.FailedLoginAttempts,
                    statValue: 2,
                    oldValue: 1,
                    stored: '2',
                    inTransaction: false,
                    userId,
                },
            ]);
        });

        it('a listener that throws does not undo the count nor the lock, and is logged', async () => {
            const { username, userId } = addUser();
            await withListener(
                () => {
                    throw new Error('listener failure');
                },
                () => failTimes(username, 3)
            );
            assert.equal(getProp(userId, UserProps.FailedLoginAttempts), '3');
            assert.equal(getProp(userId, UserProps.AccountStatus), status('locked'));
            assert.equal(warnings.length, 3);
            assert.ok(
                warnings.every(w => 'listener failure' === w.fields.error),
                JSON.stringify(warnings)
            );
        });

        it('is not sent when the transaction rolls back', async () => {
            const { userId } = addUser();
            const seen = [];
            const user = new User();
            const persist = User.prototype.persistProperties;
            //  the lock write fails: everything is rolled back
            User.prototype.persistProperties = function (props, cb) {
                return cb(new Error('fixture failure'));
            };
            try {
                db.prepare(
                    'INSERT INTO user_property (user_id, prop_name, prop_value) VALUES (?, ?, ?)'
                ).run(userId, UserProps.FailedLoginAttempts, '2');
                const err = await withListener(
                    info => seen.push(info),
                    () => new Promise(resolve => user.processFailedLogin(userId, resolve))
                );
                assert.match(err.message, /fixture failure/);
            } finally {
                User.prototype.persistProperties = persist;
            }
            assert.deepEqual(seen, []);
            assert.equal(getProp(userId, UserProps.FailedLoginAttempts), '2');
            assert.equal(getProp(userId, UserProps.AccountStatus), status('active'));
        });

        it('StatLog.incrementUserStat() still sends it at once', done => {
            const user = { properties: { n: '1' } };
            user.getPropertyAsNumber = name => parseInt(user.properties[name], 10);
            user.persistProperty = (name, value, cb) => {
                user.properties[name] = value;
                return cb(null);
            };
            const seen = [];
            const stubbedEmit = Events.emit;
            Events.emit = (event, info) => seen.push({ event, info });
            try {
                StatLog.incrementUserStat(user, 'n', 1, err => {
                    assert.ifError(err);
                    //  sent before the callback, as before
                    assert.equal(seen.length, 1);
                    assert.equal(
                        seen[0].event,
                        Events.getSystemEvents().UserStatIncrement
                    );
                    assert.equal(seen[0].info.statValue, 2);
                    done();
                });
            } finally {
                Events.emit = stubbedEmit;
            }
        });
    });

    it('locks an active account at the threshold, and refuses the right password then', async () => {
        const { username, userId } = addUser();
        await failTimes(username, 2);
        assert.equal(getProp(userId, UserProps.AccountStatus), status('active'));

        await failTimes(username, 1);
        assert.equal(getProp(userId, UserProps.AccountStatus), status('locked'));
        assert.equal(
            getProp(userId, UserProps.AccountLockedPrevStatus),
            status('active')
        );
        assert.ok(getProp(userId, UserProps.AccountLockedTs));

        const { err } = await login(username, RightPass);
        assert.ok(err);
        assert.equal(err.reasonCode, ErrorReasons.Locked);
    });

    ['disabled', 'inactive'].forEach(name => {
        it(`does not lock a ${name} account`, async () => {
            const { username, userId } = addUser({
                [UserProps.AccountStatus]: status(name),
            });
            await failTimes(username, 4);
            assert.equal(getProp(userId, UserProps.AccountStatus), status(name));
            assert.equal(getProp(userId, UserProps.AccountLockedPrevStatus), undefined);
            assert.equal(getProp(userId, UserProps.AccountLockedTs), undefined);
        });
    });

    //  counts the password checks made while it is in place
    function countDerives() {
        const derive = User.generatePasswordDerivedKey;
        const counter = { calls: 0 };
        User.generatePasswordDerivedKey = function (...args) {
            ++counter.calls;
            return derive.apply(User, args);
        };
        counter.restore = () => (User.generatePasswordDerivedKey = derive);
        return counter;
    }

    describe('a disabled or inactive account', () => {
        [
            ['disabled', ErrorReasons.Disabled],
            ['inactive', ErrorReasons.Inactive],
        ].forEach(([name, reason]) => {
            it(`${name}: answers the right and a wrong password alike, before checking either`, async () => {
                const { username, userId } = addUser({
                    [UserProps.AccountStatus]: status(name),
                    [UserProps.FailedLoginAttempts]: 1,
                });
                const derives = countDerives();
                let right;
                let wrong;
                try {
                    right = await login(username, RightPass);
                    wrong = await login(username, 'wrong-pass');
                } finally {
                    derives.restore();
                }
                assert.equal(right.err.reasonCode, reason);
                assert.equal(wrong.err.reasonCode, reason);
                assert.equal(right.err.message, wrong.err.message);
                assert.equal(right.user.isAuthenticated(), false);
                assert.equal(derives.calls, 0, 'no password was checked');
                //  nothing counted
                assert.equal(getProp(userId, UserProps.FailedLoginAttempts), '1');
            });
        });

        it('any other status that is not active is refused alike, unchecked', async () => {
            const { username } = addUser({ [UserProps.AccountStatus]: '42' });
            const derives = countDerives();
            let right;
            let wrong;
            try {
                right = await login(username, RightPass);
                wrong = await login(username, 'wrong-pass');
            } finally {
                derives.restore();
            }
            assert.match(right.err.message, /Account is not active/);
            assert.equal(right.err.message, wrong.err.message);
            assert.equal(derives.calls, 0);
        });

        it('a lock that ran out over a disabled account: the right and a wrong password both get Disabled', async () => {
            const lockedTs = hoursAgo(2);
            const { username, userId } = addUser({
                [UserProps.AccountStatus]: status('locked'),
                [UserProps.AccountLockedPrevStatus]: status('disabled'),
                [UserProps.AccountLockedTs]: lockedTs,
            });
            const right = await login(username, RightPass);
            const wrong = await login(username, 'wrong-pass');
            assert.equal(right.err.reasonCode, ErrorReasons.Disabled);
            assert.equal(wrong.err.reasonCode, ErrorReasons.Disabled);
            //  the lock is neither re-armed nor cleared
            assert.equal(getProp(userId, UserProps.AccountStatus), status('locked'));
            assert.equal(getProp(userId, UserProps.AccountLockedTs), lockedTs);
        });

        it('disabled by a sysop while a wrong password is checked: answered Disabled, as the right one is', async () => {
            const { username, userId } = addUser();
            const derive = User.generatePasswordDerivedKey;
            User.generatePasswordDerivedKey = function (...args) {
                //  oputil user disable, during the check
                db.prepare(
                    'UPDATE user_property SET prop_value = ? WHERE user_id = ? AND prop_name = ?'
                ).run(status('disabled'), userId, UserProps.AccountStatus);
                return derive.apply(User, args);
            };
            let wrong;
            try {
                wrong = await login(username, 'wrong-pass');
            } finally {
                User.generatePasswordDerivedKey = derive;
            }
            assert.equal(wrong.err.reasonCode, ErrorReasons.Disabled);
            const right = await login(username, RightPass);
            assert.equal(right.err.reasonCode, ErrorReasons.Disabled);
            assert.equal(right.err.message, wrong.err.message);
        });

        it('disabled by a sysop while the right password is checked: refused, and not counted', async () => {
            const { username, userId } = addUser();
            const derive = User.generatePasswordDerivedKey;
            User.generatePasswordDerivedKey = function (...args) {
                db.prepare(
                    'UPDATE user_property SET prop_value = ? WHERE user_id = ? AND prop_name = ?'
                ).run(status('inactive'), userId, UserProps.AccountStatus);
                return derive.apply(User, args);
            };
            let right;
            try {
                right = await login(username, RightPass);
            } finally {
                User.generatePasswordDerivedKey = derive;
            }
            assert.equal(right.err.reasonCode, ErrorReasons.Inactive);
            assert.equal(right.user.isAuthenticated(), false);
            assert.equal(getProp(userId, UserProps.FailedLoginAttempts), undefined);
        });
    });

    describe('a lock in force', () => {
        const lockedProps = (extra = {}) =>
            Object.assign(
                {
                    [UserProps.AccountStatus]: status('locked'),
                    [UserProps.AccountLockedPrevStatus]: status('active'),
                    [UserProps.AccountLockedTs]: hoursAgo(0.5),
                    [UserProps.FailedLoginAttempts]: 3,
                },
                extra
            );

        it('answers the right and a wrong password alike, before checking either', async () => {
            const { username } = addUser(lockedProps());
            const right = await login(username, RightPass);
            const wrong = await login(username, 'wrong-pass');
            assert.equal(right.err.reasonCode, ErrorReasons.Locked);
            assert.equal(wrong.err.reasonCode, ErrorReasons.Locked);
            assert.equal(right.err.message, wrong.err.message);
        });

        it('does not count further failures, nor move the lock', async () => {
            const props = lockedProps();
            const { username, userId } = addUser(props);
            await failTimes(username, 3);
            assert.equal(getProp(userId, UserProps.AccountStatus), status('locked'));
            assert.equal(
                getProp(userId, UserProps.AccountLockedPrevStatus),
                status('active')
            );
            assert.equal(
                getProp(userId, UserProps.AccountLockedTs),
                props[UserProps.AccountLockedTs]
            );
            assert.equal(getProp(userId, UserProps.FailedLoginAttempts), '3');
        });

        it('with no lock time (oputil user lock) never runs out', async () => {
            const { username } = addUser(
                lockedProps({
                    [UserProps.AccountLockedTs]: undefined,
                    [UserProps.AccountLockedPrevStatus]: undefined,
                })
            );
            assert.equal(
                (await login(username, RightPass)).err.reasonCode,
                ErrorReasons.Locked
            );
        });
    });

    //  the right password's check finishes |ms| after the others
    function slowRightPassword(ms) {
        const derive = User.generatePasswordDerivedKey;
        User.generatePasswordDerivedKey = function (...args) {
            if (RightPass === args[0]) {
                return setTimeout(() => derive.apply(User, args), ms);
            }
            return derive.apply(User, args);
        };
        return () => (User.generatePasswordDerivedKey = derive);
    }

    //  10 wrong passwords and the right one at once, the right one finishing last
    async function burst(username, loginFn = login) {
        const restore = slowRightPassword(400);
        try {
            return await Promise.all([
                ...Array.from({ length: 10 }, () => loginFn(username, 'wrong-pass')),
                loginFn(username, RightPass),
            ]);
        } finally {
            restore();
        }
    }

    describe('logins in flight', () => {
        it('the right password is refused once the lock lands, and the lock stays as set', async () => {
            const { username, userId } = addUser();
            const results = await burst(username);

            const right = results[results.length - 1];
            assert.ok(right.err, 'refused');
            assert.equal(right.err.reasonCode, ErrorReasons.Locked);
            assert.equal(right.user.isAuthenticated(), false);

            //  every answer from the lock on is the right password's: the two
            //  wrong ones before it are told so, the rest (the one that set
            //  the lock included) are told it is locked
            const answers = results.map(r => `${r.err.message} [${r.err.reasonCode}]`);
            const locked = `${right.err.message} [${right.err.reasonCode}]`;
            assert.equal(answers.filter(a => a === locked).length, 9, answers.join(', '));
            assert.equal(
                answers.filter(a => /Invalid password/.test(a)).length,
                2,
                answers.join(', ')
            );

            assert.equal(getProp(userId, UserProps.AccountStatus), status('locked'));
            assert.equal(
                getProp(userId, UserProps.AccountLockedPrevStatus),
                status('active')
            );
            assert.ok(getProp(userId, UserProps.AccountLockedTs));
            //  failures after the lock landed are not counted
            assert.equal(getProp(userId, UserProps.FailedLoginAttempts), '3');
        });

        it('on a lock that has run out, every answer is the right password', async () => {
            const { username, userId } = addUser({
                [UserProps.AccountStatus]: status('locked'),
                [UserProps.AccountLockedPrevStatus]: status('active'),
                [UserProps.AccountLockedTs]: hoursAgo(2),
            });
            const results = await burst(username);
            const answers = new Set(
                results.map(
                    r => `${r.err && r.err.message} [${r.err && r.err.reasonCode}]`
                )
            );
            assert.deepEqual([...answers], ['Access denied: Account is locked [LOCKED]']);
            assert.equal(getProp(userId, UserProps.AccountStatus), status('locked'));
        });

        it('a wrong password finishing after the lock landed does not move it', async () => {
            const { username, userId } = addUser({ [UserProps.FailedLoginAttempts]: 2 });
            //  this one is checked against the account before the lock...
            const late = login(username, 'wrong-pass');
            //  ...which lands while it is under way
            await failTimes(username, 1);
            const lockedTs = getProp(userId, UserProps.AccountLockedTs);
            assert.ok(lockedTs);
            const { err } = await late;
            assert.equal(err.reasonCode, ErrorReasons.Locked);
            assert.equal(getProp(userId, UserProps.AccountLockedTs), lockedTs);
            assert.equal(getProp(userId, UserProps.FailedLoginAttempts), '3');
        });
    });

    describe('a legacy password hash', () => {
        //  password props hashed with the old parameters (no PassHashParams)
        const legacyProps = () =>
            new Promise((resolve, reject) => {
                const salt = require('crypto').randomBytes(32).toString('hex');
                User.generatePasswordDerivedKey(
                    RightPass,
                    salt,
                    User.LegacyPBKDF2,
                    (err, dk) =>
                        err
                            ? reject(err)
                            : resolve({
                                  [UserProps.PassPbkdf2Salt]: salt,
                                  [UserProps.PassPbkdf2Dk]: dk,
                                  [UserProps.PassHashParams]: undefined,
                              })
                );
            });
        //  long enough for a background upgrade to have finished
        const settle = () => new Promise(resolve => setTimeout(resolve, 1000));

        it('is upgraded after a successful login', async () => {
            const props = await legacyProps();
            const { username, userId } = addUser(props);
            assert.ifError((await login(username, RightPass)).err);
            await settle();
            assert.ok(getProp(userId, UserProps.PassHashParams), 'upgraded');
            assert.notEqual(
                getProp(userId, UserProps.PassPbkdf2Dk),
                props[UserProps.PassPbkdf2Dk]
            );
        });

        it('is not upgraded for the right password answered locked in a burst', async () => {
            const props = await legacyProps();
            const { username, userId } = addUser(props);
            const results = await burst(username);
            assert.equal(results[results.length - 1].err.reasonCode, ErrorReasons.Locked);
            await settle();
            assert.equal(getProp(userId, UserProps.PassHashParams), undefined);
            assert.equal(
                getProp(userId, UserProps.PassPbkdf2Dk),
                props[UserProps.PassPbkdf2Dk]
            );
        });

        it('is not upgraded for the right password of an account refused after the check', async () => {
            //  a lock that ran out over an account disabled before it
            const props = await legacyProps();
            const { username, userId } = addUser(
                Object.assign(props, {
                    [UserProps.AccountStatus]: status('locked'),
                    [UserProps.AccountLockedPrevStatus]: status('disabled'),
                    [UserProps.AccountLockedTs]: hoursAgo(2),
                })
            );
            const { err } = await login(username, RightPass);
            assert.equal(err.reasonCode, ErrorReasons.Disabled);
            await settle();
            assert.equal(getProp(userId, UserProps.PassHashParams), undefined);
        });

        it('is not upgraded for the right password on a locked account', async () => {
            const props = await legacyProps();
            const { username, userId } = addUser(
                Object.assign(props, {
                    [UserProps.AccountStatus]: status('locked'),
                    [UserProps.AccountLockedPrevStatus]: status('active'),
                    [UserProps.AccountLockedTs]: hoursAgo(0.5),
                })
            );
            assert.equal(
                (await login(username, RightPass)).err.reasonCode,
                ErrorReasons.Locked
            );
            await settle();
            assert.equal(getProp(userId, UserProps.PassHashParams), undefined);
        });
    });

    describe('a lock that has run out', () => {
        it('a wrong password locks the account again from now', async () => {
            const oldTs = hoursAgo(2);
            const { username, userId } = addUser({
                [UserProps.AccountStatus]: status('locked'),
                [UserProps.AccountLockedPrevStatus]: status('active'),
                [UserProps.AccountLockedTs]: oldTs,
                [UserProps.FailedLoginAttempts]: 3,
            });
            const { err } = await login(username, 'wrong-pass');
            assert.ok(err);
            assert.equal(getProp(userId, UserProps.AccountStatus), status('locked'));
            assert.notEqual(getProp(userId, UserProps.AccountLockedTs), oldTs);
            assert.ok(
                Date.now() - new Date(getProp(userId, UserProps.AccountLockedTs)) <
                    60 * 1000
            );
            //  in force again: the right password is refused
            assert.equal(
                (await login(username, RightPass)).err.reasonCode,
                ErrorReasons.Locked
            );
        });

        it('with no status kept from before, the right password unlocks to active', async () => {
            const { username, userId } = addUser({
                [UserProps.AccountStatus]: status('locked'),
                [UserProps.AccountLockedTs]: hoursAgo(2),
            });
            const { err } = await login(username, RightPass);
            assert.ifError(err);
            assert.equal(getProp(userId, UserProps.AccountStatus), status('active'));
            assert.equal(getProp(userId, UserProps.AccountLockedTs), undefined);
        });
    });

    it('a successful login resets the count', async () => {
        const { username, userId } = addUser();
        await failTimes(username, 2);
        assert.equal(getProp(userId, UserProps.FailedLoginAttempts), '2');
        const { err } = await login(username, RightPass);
        assert.ifError(err);
        assert.equal(getProp(userId, UserProps.FailedLoginAttempts), undefined);
        //  and the count starts again
        await failTimes(username, 2);
        assert.equal(getProp(userId, UserProps.AccountStatus), status('active'));
    });

    it('auto unlock lets the right password in and restores the status', async () => {
        const { username, userId } = addUser({
            [UserProps.AccountStatus]: status('locked'),
            [UserProps.AccountLockedPrevStatus]: status('active'),
            [UserProps.AccountLockedTs]: hoursAgo(2),
            [UserProps.FailedLoginAttempts]: 3,
        });
        const { err, user } = await login(username, RightPass);
        assert.ifError(err);
        assert.equal(user.isAuthenticated(), true);
        assert.equal(getProp(userId, UserProps.AccountStatus), status('active'));
        assert.equal(getProp(userId, UserProps.AccountLockedPrevStatus), undefined);
        assert.equal(getProp(userId, UserProps.AccountLockedTs), undefined);
        assert.equal(getProp(userId, UserProps.FailedLoginAttempts), undefined);
    });

    it('auto unlock does not let in an account that was disabled before its lock', async () => {
        const { username, userId } = addUser({
            [UserProps.AccountStatus]: status('locked'),
            [UserProps.AccountLockedPrevStatus]: status('disabled'),
            [UserProps.AccountLockedTs]: hoursAgo(2),
        });
        const { err, user } = await login(username, RightPass);
        assert.ok(err, 'refused');
        assert.equal(err.reasonCode, ErrorReasons.Disabled);
        assert.equal(user.isAuthenticated(), false);
        assert.equal(getProp(userId, UserProps.AccountStatus), status('locked'));
    });

    it('a lock not yet due for auto unlock refuses the right password', async () => {
        const { username } = addUser({
            [UserProps.AccountStatus]: status('locked'),
            [UserProps.AccountLockedPrevStatus]: status('active'),
            [UserProps.AccountLockedTs]: hoursAgo(0.5),
        });
        const { err } = await login(username, RightPass);
        assert.equal(err.reasonCode, ErrorReasons.Locked);
    });

    //
    //  The telnet / WebSocket login form: system_menu_method's login(), as a
    //  menu calls it, with userLogin()'s other collaborators stubbed
    //
    describe('the login menu', () => {
        const Module = require('module');
        const paths = ['../core/user_login.js', '../core/system_menu_method.js'].map(p =>
            require.resolve(p)
        );
        let savedModules;
        let menuMethods;

        const stubs = {
            './theme.js': { setClientTheme: () => {} },
            './client_connections.js': { clientConnections: [] },
            './logger.js': { log: { child: () => makeLog() } },
            './message_area.js': {
                getMessageConferenceByTag: () => ({}),
                getMessageAreaByTag: () => ({}),
                getSuitableMessageConfAndAreaTags: () => [],
            },
            './file_base_area.js': {
                getFileAreaByTag: () => ({}),
                getDefaultFileAreaTag: () => '',
            },
            './stat_log.js': {
                setUserStat: (u, n, v, cb) => cb && cb(null),
                incrementUserStat: (u, n, v, cb) => cb && cb(null),
                incrementSystemStat: (n, v, cb) => cb && cb(null),
                incrementNonPersistentSystemStat: () => {},
                setNonPersistentSystemStat: () => {},
                appendSystemLogEntry: (k, v, m, t, cb) => cb && cb(null),
                now: new Date().toISOString(),
                KeepType: { Max: 'max' },
            },
        };

        function makeLog() {
            const log = { fields: {}, child: () => log };
            ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].forEach(level => {
                log[level] = () => true;
            });
            return log;
        }

        before(() => {
            savedModules = paths.map(p => require.cache[p]);
            paths.forEach(p => delete require.cache[p]);
            const originalLoad = Module._load;
            Module._load = function (request, parent, isMain) {
                if (
                    parent &&
                    parent.filename === paths[0] &&
                    Object.prototype.hasOwnProperty.call(stubs, request)
                ) {
                    return stubs[request];
                }
                return originalLoad(request, parent, isMain);
            };
            try {
                require(paths[0]);
                menuMethods = require(paths[1]);
            } finally {
                Module._load = originalLoad;
            }
        });

        after(() => {
            paths.forEach((p, i) => {
                if (savedModules[i]) {
                    require.cache[p] = savedModules[i];
                } else {
                    delete require.cache[p];
                }
            });
        });

        //  where the menu went: { goto: menu } or { prev: true }
        function menuLogin(username, password) {
            return new Promise(resolve => {
                const client = {
                    user: new User(),
                    log: makeLog(),
                    session: { uniqueId: 'menu-session' },
                    remoteAddress: '192.0.2.30',
                    friendlyRemoteAddress: () => '192.0.2.30',
                    clientEnded: false,
                };
                const menu = {
                    client,
                    menuConfig: {
                        config: {
                            locked: 'accountLocked',
                            disabled: 'accountDisabled',
                            inactive: 'accountInactive',
                        },
                    },
                    gotoMenu: (name, cb) => {
                        cb(null);
                        resolve({ goto: name });
                    },
                    prevMenu: cb => {
                        cb(null);
                        resolve({ prev: true });
                    },
                };
                menuMethods.login(menu, { value: { username, password } }, {}, () => {});
            });
        }

        it('goes to the same place for the right and a wrong password while locked', async () => {
            const { username } = addUser({
                [UserProps.AccountStatus]: status('locked'),
                [UserProps.AccountLockedPrevStatus]: status('active'),
                [UserProps.AccountLockedTs]: hoursAgo(0.5),
            });
            assert.deepEqual(await menuLogin(username, RightPass), {
                goto: 'accountLocked',
            });
            assert.deepEqual(await menuLogin(username, 'wrong-pass'), {
                goto: 'accountLocked',
            });
        });

        it('in a burst, every caller after the lock lands goes to the same place', async () => {
            const { username } = addUser();
            const results = await burst(username, menuLogin);
            const right = results[results.length - 1];
            assert.deepEqual(right, { goto: 'accountLocked' });
            assert.equal(results.filter(r => r.prev).length, 2);
            assert.equal(results.filter(r => 'accountLocked' === r.goto).length, 9);
        });

        it('a wrong password for an account not locked goes back, as before', async () => {
            const { username } = addUser();
            assert.deepEqual(await menuLogin(username, 'wrong-pass'), { prev: true });
        });

        [
            ['disabled', 'accountDisabled'],
            ['inactive', 'accountInactive'],
        ].forEach(([name, menu]) => {
            it(`goes to the same place for the right and a wrong password when the account is ${name}`, async () => {
                const { username } = addUser({ [UserProps.AccountStatus]: status(name) });
                assert.deepEqual(await menuLogin(username, RightPass), { goto: menu });
                assert.deepEqual(await menuLogin(username, 'wrong-pass'), { goto: menu });
            });
        });
    });

    describe('a status set by a sysop (oputil user lock / disable / activate)', () => {
        const load = userId =>
            new Promise((resolve, reject) =>
                User.getUser(userId, (err, user) => (err ? reject(err) : resolve(user)))
            );
        const setStatus = (user, name) =>
            new Promise((resolve, reject) =>
                user.setAccountStatusBySysop(User.AccountStatus[name], err =>
                    err ? reject(err) : resolve()
                )
            );
        const unlock = user =>
            new Promise((resolve, reject) =>
                user.unlockAccount(err => (err ? reject(err) : resolve()))
            );
        //  locked by failed logins, long enough ago to have run out
        const autoLocked = () =>
            addUser({
                [UserProps.AccountStatus]: status('locked'),
                [UserProps.AccountLockedPrevStatus]: status('active'),
                [UserProps.AccountLockedTs]: hoursAgo(2),
                [UserProps.FailedLoginAttempts]: 3,
            });

        it('a sysop lock over a lock from failed logins does not run out', async () => {
            const { username, userId } = autoLocked();
            await setStatus(await load(userId), 'locked');
            assert.equal(getProp(userId, UserProps.AccountLockedTs), undefined);
            assert.equal(getProp(userId, UserProps.AccountLockedPrevStatus), undefined);
            const { err } = await login(username, RightPass);
            assert.equal(err.reasonCode, ErrorReasons.Locked);
            assert.equal(getProp(userId, UserProps.AccountStatus), status('locked'));
        });

        it('a sysop lock is not undone by a password reset unlock', async () => {
            const { userId } = autoLocked();
            await setStatus(await load(userId), 'locked');
            await unlock(await load(userId));
            assert.equal(getProp(userId, UserProps.AccountStatus), status('locked'));
        });

        it('disabled, then locked again, by a sysop stays locked', async () => {
            const { username, userId } = autoLocked();
            await setStatus(await load(userId), 'disabled');
            await setStatus(await load(userId), 'locked');
            assert.equal(
                (await login(username, RightPass)).err.reasonCode,
                ErrorReasons.Locked
            );
        });

        it('a sysop disable over a lock is not restored away', async () => {
            const { username, userId } = autoLocked();
            await setStatus(await load(userId), 'disabled');
            await unlock(await load(userId));
            assert.equal(getProp(userId, UserProps.AccountStatus), status('disabled'));
            assert.equal(
                (await login(username, RightPass)).err.reasonCode,
                ErrorReasons.Disabled
            );
        });

        it('activate clears the lock and the count', async () => {
            const { username, userId } = autoLocked();
            await setStatus(await load(userId), 'active');
            assert.equal(getProp(userId, UserProps.AccountStatus), status('active'));
            assert.equal(getProp(userId, UserProps.AccountLockedTs), undefined);
            assert.equal(getProp(userId, UserProps.FailedLoginAttempts), undefined);
            assert.ifError((await login(username, RightPass)).err);
        });

        it('activate clears the count of an account that was never locked', async () => {
            const { userId } = addUser({ [UserProps.FailedLoginAttempts]: 8 });
            await setStatus(await load(userId), 'active');
            assert.equal(getProp(userId, UserProps.FailedLoginAttempts), undefined);
        });
    });

    //
    //  The reset form's POST, with the web server stubbed out
    //
    describe('an email password reset', () => {
        const Module = require('module');
        const resetPath = require.resolve('../core/web_password_reset.js');
        let savedModule;
        let WebPasswordReset;
        let body;

        const stubs = {
            './listening_server.js': {
                getServer: () => ({
                    instance: {
                        checkRateLimit: () => true,
                        respondWithError: (resp, code) => resp.writeHead(code),
                    },
                }),
            },
            './servers/content/web.js': { moduleInfo: { packageName: 'web' } },
            './servers/content/web': { WellKnownLocations: { Internal: '/_internal' } },
            './web_util': { buildUrl: p => p },
            './http_body': {
                readTextBody: (req, max, cb) => cb(null, body),
                isTooLarge: () => false,
            },
        };

        before(() => {
            savedModule = require.cache[resetPath];
            delete require.cache[resetPath];
            const originalLoad = Module._load;
            Module._load = function (request, parent, isMain) {
                if (
                    parent &&
                    parent.filename === resetPath &&
                    Object.prototype.hasOwnProperty.call(stubs, request)
                ) {
                    return stubs[request];
                }
                return originalLoad(request, parent, isMain);
            };
            try {
                WebPasswordReset = require(resetPath).WebPasswordReset;
            } finally {
                Module._load = originalLoad;
            }
        });

        after(() => {
            if (savedModule) {
                require.cache[resetPath] = savedModule;
            } else {
                delete require.cache[resetPath];
            }
        });

        //  |during|: run while the new password's key is derived
        function reset(userId, password, during) {
            body = `token=tok&password=${password}&confirm_password=${password}`;
            WebPasswordReset.getUserByToken = (token, cb) =>
                User.getUser(userId, (err, user) => {
                    if (user && during) {
                        const setCredentials = user.setNewAuthCredentials.bind(user);
                        user.setNewAuthCredentials = (pw, done) =>
                            setCredentials(pw, err => {
                                during();
                                return done(err);
                            });
                    }
                    return cb(err, user);
                });
            return new Promise(resolve => {
                const resp = {
                    writeHead: code => (resp.code = code),
                    end: () => resolve(resp.code),
                };
                WebPasswordReset.routeResetPasswordPost({}, resp);
                //  a refused reset only writes the head
                setTimeout(() => resolve(resp.code), 3000);
            });
        }

        it('leaves a status a sysop set while it was under way', async () => {
            const { userId } = addUser({
                [UserProps.AccountStatus]: status('locked'),
                [UserProps.AccountLockedPrevStatus]: status('active'),
                [UserProps.AccountLockedTs]: hoursAgo(0.1),
                [UserProps.FailedLoginAttempts]: 3,
            });
            const code = await reset(userId, 'new-pass-2', () => {
                //  oputil user disable
                User.getUser(userId, (err, other) =>
                    other.setAccountStatusBySysop(User.AccountStatus.disabled, () => {})
                );
            });
            assert.equal(code, 200);
            assert.equal(getProp(userId, UserProps.AccountStatus), status('disabled'));
        });

        it('unlocks a lock that landed while it was under way', async () => {
            const { userId } = addUser();
            const code = await reset(userId, 'new-pass-3', () => {
                db.prepare(
                    'INSERT INTO user_property (user_id, prop_name, prop_value) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?) ON CONFLICT(user_id, prop_name) DO UPDATE SET prop_value = excluded.prop_value'
                ).run(
                    userId,
                    UserProps.AccountStatus,
                    status('locked'),
                    userId,
                    UserProps.AccountLockedPrevStatus,
                    status('active'),
                    userId,
                    UserProps.AccountLockedTs,
                    new Date().toISOString()
                );
            });
            assert.equal(code, 200);
            assert.equal(getProp(userId, UserProps.AccountStatus), status('active'));
            assert.equal(getProp(userId, UserProps.AccountLockedTs), undefined);
        });

        it('clears the failed login count of an account that is not locked', async () => {
            const { username, userId } = addUser({ [UserProps.FailedLoginAttempts]: 2 });
            assert.equal(await reset(userId, 'new-pass-1'), 200);
            assert.equal(getProp(userId, UserProps.FailedLoginAttempts), undefined);
            //  one typo now is one failure, not the one that locks
            await failTimes(username, 1);
            assert.equal(getProp(userId, UserProps.AccountStatus), status('active'));
        });
    });

    describe('User.inLockTransaction()', () => {
        it('writes nothing when the work fails', async () => {
            const { userId } = addUser();
            const err = await new Promise(resolve =>
                User.inLockTransaction(done => {
                    User.persistPropertyByUserId(
                        userId,
                        UserProps.AccountStatus,
                        User.AccountStatus.locked,
                        () => done(new Error('fixture failure'))
                    );
                }, resolve)
            );
            assert.match(err.message, /fixture failure/);
            assert.equal(getProp(userId, UserProps.AccountStatus), status('active'));
        });

        it('refuses, and writes nothing for, work that does not finish in step', async () => {
            const { userId } = addUser();
            const err = await new Promise(resolve =>
                User.inLockTransaction(done => {
                    User.persistPropertyByUserId(
                        userId,
                        UserProps.AccountStatus,
                        User.AccountStatus.locked
                    );
                    setImmediate(() => done(null));
                }, resolve)
            );
            assert.ok(err);
            assert.equal(getProp(userId, UserProps.AccountStatus), status('active'));
        });
    });

    describe('unlockAccount()', () => {
        const load = userId =>
            new Promise((resolve, reject) =>
                User.getUser(userId, (err, user) => (err ? reject(err) : resolve(user)))
            );
        const unlock = user =>
            new Promise((resolve, reject) =>
                user.unlockAccount(err => (err ? reject(err) : resolve()))
            );

        it('restores the status from before the lock and clears the count', async () => {
            const { userId } = addUser({
                [UserProps.AccountStatus]: status('locked'),
                [UserProps.AccountLockedPrevStatus]: status('active'),
                [UserProps.AccountLockedTs]: hoursAgo(0.5),
                [UserProps.FailedLoginAttempts]: 9,
            });
            await unlock(await load(userId));
            assert.equal(getProp(userId, UserProps.AccountStatus), status('active'));
            assert.equal(getProp(userId, UserProps.AccountLockedPrevStatus), undefined);
            assert.equal(getProp(userId, UserProps.FailedLoginAttempts), undefined);
        });

        it('leaves a status set since the lock alone (a password reset does not re-enable a disabled account)', async () => {
            const { userId } = addUser({
                [UserProps.AccountStatus]: status('disabled'),
                [UserProps.AccountLockedPrevStatus]: status('active'),
                [UserProps.AccountLockedTs]: hoursAgo(0.5),
            });
            await unlock(await load(userId));
            assert.equal(getProp(userId, UserProps.AccountStatus), status('disabled'));
            assert.equal(getProp(userId, UserProps.AccountLockedPrevStatus), undefined);
            assert.equal(getProp(userId, UserProps.AccountLockedTs), undefined);
        });

        it('does nothing to an account that was never locked', async () => {
            const { userId } = addUser({ [UserProps.FailedLoginAttempts]: 2 });
            await unlock(await load(userId));
            assert.equal(getProp(userId, UserProps.AccountStatus), status('active'));
            assert.equal(getProp(userId, UserProps.FailedLoginAttempts), '2');
        });
    });
});
