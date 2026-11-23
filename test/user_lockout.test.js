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

    describe('logins in flight', () => {
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

        it('the right password is refused once the lock lands, and the lock stays as set', async () => {
            const { username, userId } = addUser();
            const restore = slowRightPassword(400);
            let results;
            try {
                results = await Promise.all([
                    ...Array.from({ length: 10 }, () => login(username, 'wrong-pass')),
                    login(username, RightPass),
                ]);
            } finally {
                restore();
            }

            const right = results[results.length - 1];
            assert.ok(right.err, 'refused');
            assert.equal(right.err.reasonCode, ErrorReasons.Locked);
            assert.equal(right.user.isAuthenticated(), false);

            assert.equal(getProp(userId, UserProps.AccountStatus), status('locked'));
            assert.equal(
                getProp(userId, UserProps.AccountLockedPrevStatus),
                status('active')
            );
            assert.ok(getProp(userId, UserProps.AccountLockedTs));
            //  failures after the lock landed are not counted
            assert.equal(getProp(userId, UserProps.FailedLoginAttempts), '3');
        });

        it('a wrong password finishing after the lock landed does not move it', async () => {
            const { username, userId } = addUser({ [UserProps.FailedLoginAttempts]: 2 });
            //  this one is checked against the account before the lock...
            const late = login(username, 'wrong-pass');
            //  ...which lands while it is under way
            await failTimes(username, 1);
            const lockedTs = getProp(userId, UserProps.AccountLockedTs);
            assert.ok(lockedTs);
            await late;
            assert.equal(getProp(userId, UserProps.AccountLockedTs), lockedTs);
            assert.equal(getProp(userId, UserProps.FailedLoginAttempts), '3');
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
                    menuConfig: { config: { locked: 'accountLocked' } },
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

        it('a wrong password for an account not locked goes back, as before', async () => {
            const { username } = addUser();
            assert.deepEqual(await menuLogin(username, 'wrong-pass'), { prev: true });
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
