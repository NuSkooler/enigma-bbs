'use strict';

//
//  User.persistProperty() / removeProperty() against an in-memory user
//  database (#447): what is written reads back the same, and a throw from
//  the caller's callback is not reported back to it as a database error.
//

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');

const configModule = require('../core/config.js');
const dbModule = require('../core/database.js');
const UserPreference = require('../core/user_preference.js');

//  user.js captures dbs.user and config.js's get() when it loads, so it is
//  loaded fresh in before() against the in-memory database, and the cached
//  copy everything else uses is put back in after().
const UserPath = require.resolve('../core/user.js');

describe('User property persistence (#447)', function () {
    let User;
    let db;
    let prevDb;
    let prevConfig;
    let savedUserModule;

    before(() => {
        prevConfig = configModule._pushTestConfig({
            menus: {},
            general: {},
            debug: { assertsEnabled: false },
        });

        db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
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
                UNIQUE(user_id, prop_name),
                FOREIGN KEY(user_id) REFERENCES user(id) ON DELETE CASCADE
            );
            INSERT INTO user (id, user_name) VALUES (7, 'tester');
        `);

        prevDb = dbModule.dbs.user;
        dbModule.dbs.user = db;
        savedUserModule = require.cache[UserPath];
        delete require.cache[UserPath];
        User = require('../core/user.js');
    });

    after(() => {
        if (savedUserModule) {
            require.cache[UserPath] = savedUserModule;
        } else {
            delete require.cache[UserPath];
        }
        dbModule.dbs.user = prevDb;
        configModule._popTestConfig(prevConfig);
        db.close();
    });

    function makeUser(userId = 7) {
        const user = new User();
        user.userId = userId;
        return user;
    }

    function stored(userId = 7) {
        return new Promise((resolve, reject) =>
            User.loadProperties(userId, (err, props) =>
                err ? reject(err) : resolve(props)
            )
        );
    }

    it('persistProperty writes a value that loadProperties reads back the same', async () => {
        const user = makeUser();
        await new Promise((resolve, reject) =>
            user.persistProperty('pref__msg_reader', 'lampboard', err =>
                err ? reject(err) : resolve()
            )
        );
        assert.equal((await stored()).pref__msg_reader, 'lampboard');
    });

    it('a preference set through user_preference reads back as text', async () => {
        const user = makeUser();
        await new Promise((resolve, reject) =>
            UserPreference.setUserPreference(user, 'pref__style', 2, err =>
                err ? reject(err) : resolve()
            )
        );
        assert.equal(user.getProperty('pref__style'), '2');
        assert.equal((await stored()).pref__style, '2');
    });

    it('removeProperty deletes the row', async () => {
        const user = makeUser();
        await new Promise(resolve => user.persistProperty('pref__gone', 'x', resolve));
        await new Promise((resolve, reject) =>
            user.removeProperty('pref__gone', err => (err ? reject(err) : resolve()))
        );
        assert.equal('pref__gone' in (await stored()), false);
        assert.equal(user.getProperty('pref__gone'), undefined);
    });

    //
    //  setUserPreference continues into prevMenu() / gotoMenu() from inside
    //  this callback; if that throws, the throw must reach the caller, not
    //  come back through the same callback as if the write had failed.
    //
    ['persistProperty', 'removeProperty', 'persistPropertyByUserId'].forEach(method => {
        it(`${method} calls back once when the callback throws`, () => {
            const user = makeUser();
            let calls = 0;
            const boom = () => {
                ++calls;
                throw new Error('thrown by the caller');
            };
            const run = {
                persistProperty: () => user.persistProperty('pref__x', 'y', boom),
                removeProperty: () => user.removeProperty('pref__x', boom),
                persistPropertyByUserId: () =>
                    User.persistPropertyByUserId(7, 'pref__x', 'y', boom),
            }[method];

            assert.throws(run, /thrown by the caller/);
            assert.equal(calls, 1);
        });
    });

    it('reports a failed write (no such user) and setUserPreference puts the live value back', async () => {
        const user = makeUser(999); //  no user row: the foreign key fails
        user.properties.pref__msg_reader = 'classic';
        const err = await new Promise(resolve =>
            UserPreference.setUserPreference(
                user,
                'pref__msg_reader',
                'lampboard',
                resolve
            )
        );
        assert.ok(err, 'the write failed');
        assert.equal(user.getProperty('pref__msg_reader'), 'classic');
        assert.equal('pref__msg_reader' in (await stored(999)), false);
    });
});
