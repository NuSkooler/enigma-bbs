'use strict';

//
//  A password login for a user name that does not exist derives a key all
//  the same (PBKDF2 with the current parameters and a fixed dummy salt), so
//  it is answered in about the time a wrong password for a real account
//  takes: the answer time no longer tells whether an account exists (#1179).
//  An SSH key login has no PBKDF2 for a real account either, so it does none.
//
//  Through User.authenticateFactor1() on an in-memory user database; the
//  modules that capture it and Config at first require are loaded afresh.
//

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');
const _ = require('lodash');

const configModule = require('../core/config.js');
const configDefault = require('../core/config_default.js');
const dbModule = require('../core/database.js');
const Events = require('../core/events.js');
const UserProps = require('../core/user_property.js');
const { ErrorCodes } = require('../core/enig_error.js');

const FreshPaths = [
    '../core/stat_log.js',
    '../core/user_group.js',
    '../core/user.js',
].map(p => require.resolve(p));

describe('a login for a user name that does not exist', function () {
    this.timeout(20000); //  PBKDF2

    let saved;
    let previousConfig;
    let db;
    let User;
    let realDerive;
    let derived = [];

    before(done => {
        previousConfig = configModule._pushTestConfig(
            _.merge(configDefault(), {
                debug: { assertsEnabled: false },
                users: { failedLogin: { disconnect: 0, lockAccount: 0 } },
            })
        );

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

        require(FreshPaths[0]);
        require(FreshPaths[1]);
        User = require(FreshPaths[2]);

        realDerive = User.generatePasswordDerivedKey;
        User.generatePasswordDerivedKey = (password, salt, options, cb) => {
            derived.push({ password, salt, options });
            return realDerive(password, salt, options, cb);
        };

        User.generatePasswordDerivedKeyAndSalt('right-pass', (err, info) => {
            if (err) {
                return done(err);
            }
            const userId = Number(
                db.prepare('INSERT INTO user (user_name) VALUES (?)').run('known')
                    .lastInsertRowid
            );
            const stmt = db.prepare(
                'INSERT INTO user_property (user_id, prop_name, prop_value) VALUES (?, ?, ?)'
            );
            _.each(
                {
                    [UserProps.AccountStatus]: String(User.AccountStatus.active),
                    [UserProps.PassPbkdf2Salt]: info.salt,
                    [UserProps.PassPbkdf2Dk]: info.dk,
                    [UserProps.PassHashParams]: JSON.stringify(User.PBKDF2),
                },
                (value, name) => stmt.run(userId, name, value)
            );
            return done();
        });
    });

    beforeEach(() => {
        derived = [];
    });

    after(() => {
        User.generatePasswordDerivedKey = realDerive;
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

    function login(authInfo) {
        return new Promise(resolve => {
            new User().authenticateFactor1(
                Object.assign({ type: User.AuthFactor1Types.Password }, authInfo),
                err => resolve(err)
            );
        });
    }

    it('derives one key with the current parameters, and still says it does not exist', async () => {
        const err = await login({ username: 'nobody', password: 'guess' });
        assert.ok(err);
        assert.equal(err.code, ErrorCodes.DoesNotExist);
        assert.equal(derived.length, 1);
        assert.equal(derived[0].password, 'guess');
        assert.deepEqual(derived[0].options, User.PBKDF2);
        assert.equal(derived[0].salt.length, User.PBKDF2.saltLen * 2, 'hex');
    });

    it('uses the same dummy salt every time', async () => {
        await login({ username: 'nobody', password: 'a' });
        await login({ username: 'someone-else', password: 'b' });
        assert.equal(derived.length, 2);
        assert.equal(derived[0].salt, derived[1].salt);
        assert.equal(derived[0].salt, User.unknownUserSalt());
    });

    it('derives as many keys as a wrong password for a real account', async () => {
        await login({ username: 'known', password: 'wrong-pass' });
        const known = derived.length;
        derived = [];
        await login({ username: 'nobody', password: 'wrong-pass' });
        assert.equal(known, 1);
        assert.equal(derived.length, known);
    });

    it('derives nothing for an SSH key login', async () => {
        const err = await login({
            username: 'nobody',
            type: User.AuthFactor1Types.SSHPubKey,
            pubKey: { key: 'ssh-ed25519 AAAA' },
        });
        assert.equal(err.code, ErrorCodes.DoesNotExist);
        assert.equal(derived.length, 0);
    });
});
