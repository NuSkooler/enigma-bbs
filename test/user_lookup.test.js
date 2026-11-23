'use strict';

//
//  User name and real name lookups (logins, mail To:, ActivityPub, FTN,
//  oputil, ...): exact, case-insensitive for ASCII letters as before; '%'
//  and '_' are only themselves.
//

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');

const configModule = require('../core/config.js');
const configDefault = require('../core/config_default.js');
const dbModule = require('../core/database.js');
const UserProps = require('../core/user_property.js');

const FreshPaths = ['../core/user_group.js', '../core/user.js'].map(p =>
    require.resolve(p)
);

describe('user name and real name lookups', function () {
    let saved;
    let previousConfig;
    let db;
    let User;
    const ids = {};

    before(() => {
        previousConfig = configModule._pushTestConfig(configDefault());

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
        };
        dbModule.dbs.user = db;
        FreshPaths.forEach(p => delete require.cache[p]);
        require(FreshPaths[0]);
        User = require(FreshPaths[1]);

        const insUser = db.prepare('INSERT INTO user (user_name) VALUES (?)');
        const insProp = db.prepare(
            'INSERT INTO user_property (user_id, prop_name, prop_value) VALUES (?, ?, ?)'
        );
        [
            ['SysOp', 'Real Sysop'],
            ['a-b', 'Jane Doe'],
            ['Bob', 'Bob Smith'],
            ['Ärger', 'Örjan Ölund'],
        ].forEach(([name, realName]) => {
            ids[name] = Number(insUser.run(name).lastInsertRowid);
            insProp.run(ids[name], UserProps.RealName, realName);
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
        configModule._popTestConfig(previousConfig);
        db.close();
    });

    const lookup = (fn, value) =>
        new Promise(resolve =>
            User[fn](value, (err, userId, userName) => resolve({ err, userId, userName }))
        );

    const assertNone = async (fn, value) => {
        const { err, userId } = await lookup(fn, value);
        assert.ok(err, `${fn}(${JSON.stringify(value)}) found user ${userId}`);
    };

    const assertFinds = async (fn, value, name) => {
        const { err, userId, userName } = await lookup(fn, value);
        assert.ifError(err);
        assert.equal(userId, ids[name]);
        assert.equal(userName, name);
    };

    describe('getUserIdAndName()', () => {
        it('takes "%" and "_" literally', async () => {
            for (const value of ['%', '_', '___', 'S%', '_ob', '%b%']) {
                await assertNone('getUserIdAndName', value);
            }
        });

        it('does not find "a-b" for "a_b"', async () => {
            await assertNone('getUserIdAndName', 'a_b');
            await assertFinds('getUserIdAndName', 'a-b', 'a-b');
        });

        it('is still case-insensitive for ASCII letters', async () => {
            await assertFinds('getUserIdAndName', 'bob', 'Bob');
            await assertFinds('getUserIdAndName', 'BOB', 'Bob');
            await assertFinds('getUserIdAndName', 'sysop', 'SysOp');
        });

        it('matches other letters exactly, as LIKE did', async () => {
            await assertFinds('getUserIdAndName', 'Ärger', 'Ärger');
            await assertFinds('getUserIdAndName', 'ÄRGER', 'Ärger');
            await assertNone('getUserIdAndName', 'ärger');
        });

        it('is exact otherwise', async () => {
            await assertNone('getUserIdAndName', 'Bo');
            await assertNone('getUserIdAndName', 'Bob ');
        });
    });

    describe('getUserIdAndNameByRealName()', () => {
        it('takes "%" and "_" literally', async () => {
            for (const value of ['%', '_', 'J_ne Doe', 'Jane%']) {
                await assertNone('getUserIdAndNameByRealName', value);
            }
        });

        it('is still case-insensitive for ASCII letters', async () => {
            await assertFinds('getUserIdAndNameByRealName', 'jane doe', 'a-b');
            await assertFinds('getUserIdAndNameByRealName', 'BOB SMITH', 'Bob');
        });
    });

    describe('getUserIdAndNameByLookup()', () => {
        it('takes "%" and "_" literally', async () => {
            await assertNone('getUserIdAndNameByLookup', '%');
            await assertNone('getUserIdAndNameByLookup', '_ob');
        });

        it('finds by user name, then real name', async () => {
            await assertFinds('getUserIdAndNameByLookup', 'BOB', 'Bob');
            await assertFinds('getUserIdAndNameByLookup', 'real sysop', 'SysOp');
        });
    });
});
