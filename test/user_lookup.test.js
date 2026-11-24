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

//  email.js and system_view_validate.js capture Config, and user.js
const FreshPaths = [
    '../core/user_group.js',
    '../core/user.js',
    '../core/email.js',
    '../core/system_view_validate.js',
    '../core/scanner_tossers/email.js',
].map(p => require.resolve(p));

describe('user name and real name lookups', function () {
    let saved;
    let previousConfig;
    let db;
    let User;
    let config;
    let email;
    let validate;
    let EmailTosser;
    const ids = {};

    before(() => {
        config = configDefault();
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
        };
        dbModule.dbs.user = db;
        FreshPaths.forEach(p => delete require.cache[p]);
        //  email.js and the tosser capture the logger too; another test file
        //  may have left one without child()
        const loggerModule = require('../core/logger.js');
        saved.log = loggerModule.log;
        const quiet = {};
        ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].forEach(level => {
            quiet[level] = () => true;
        });
        quiet.child = () => quiet;
        loggerModule.log = quiet;

        require(FreshPaths[0]);
        User = require(FreshPaths[1]);
        email = require(FreshPaths[2]);
        validate = require(FreshPaths[3]);
        EmailTosser = require(FreshPaths[4]).getModule;

        const insUser = db.prepare('INSERT INTO user (user_name) VALUES (?)');
        const insProp = db.prepare(
            'INSERT INTO user_property (user_id, prop_name, prop_value) VALUES (?, ?, ?)'
        );
        [
            ['SysOp', 'Real Sysop'],
            ['a-b', 'Jane Doe'],
            ['Bob', 'Bob Smith'],
            ['Ärger', 'Örjan Ölund'],
            ['John Doe', 'Johnny'],
            ['Mary  Ann', 'Mary'],
            ['Pat Lee', 'P1'],
            ['Pat.Lee', 'P2'],
            ['pat lee!', 'P3'],
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
        require('../core/logger.js').log = saved.log;
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
    describe('email recipients (resolveEmailLocalPart())', () => {
        const resolve = localPart =>
            new Promise(done =>
                email.resolveEmailLocalPart(localPart, (err, userId, userName) =>
                    done({ err, userId, userName })
                )
            );

        afterEach(() => {
            delete config.email.outbound.usernameReplaceChar;
        });

        it('finds the user outbound mail from them is sent as', async () => {
            assert.equal(email.emailLocalPart('John Doe'), 'John_Doe');
            const { err, userName } = await resolve('John_Doe');
            assert.ifError(err);
            assert.equal(userName, 'John Doe');
            assert.equal((await resolve('john_doe')).userName, 'John Doe');
            //  runs of other characters are one replacement
            assert.equal((await resolve('Mary_Ann')).userName, 'Mary  Ann');
        });

        it('the email tosser delivers a reply to the user it came from', async () => {
            const tosser = new EmailTosser();
            const from = tosser._buildFromAddress(
                { outbound: { fromDomain: 'bbs.example' } },
                'John Doe'
            );
            assert.equal(from.address, 'John_Doe@bbs.example');
            const recipient = await tosser._resolveRecipient([{ address: from.address }]);
            assert.ok(recipient, 'found');
            assert.equal(recipient.username, 'John Doe');
            assert.equal(recipient.userId, ids['John Doe']);
        });

        it('finds a user name as it is first', async () => {
            assert.equal((await resolve('a-b')).userName, 'a-b');
            assert.equal((await resolve('bob')).userName, 'Bob');
        });

        it('works with another replacement character', async () => {
            config.email.outbound.usernameReplaceChar = '.';
            assert.equal((await resolve('John.Doe')).userName, 'John Doe');
            assert.ok((await resolve('John_Doe')).err);
        });

        it('delivers to nobody when two users give the same address', async () => {
            //  "Pat Lee" and "pat lee!" both give Pat_Lee ("Pat.Lee" does not)
            const { err } = await resolve('Pat_Lee');
            assert.ok(err, 'ambiguous');
            assert.equal((await resolve('Pat.Lee')).userName, 'Pat.Lee');
        });

        it('takes "%" and "_" in an address literally', async () => {
            assert.ok((await resolve('%')).err);
            assert.ok((await resolve('_')).err);
            assert.ok((await resolve('J%')).err);
            assert.ok((await resolve('John%')).err);
        });
    });

    describe('new user names (validateUserNameAvail())', () => {
        const check = name =>
            new Promise(done => validate.validateUserNameAvail(name, done));

        it('refuses a name that would get an existing user email address', async () => {
            for (const name of [
                'John_Doe',
                'john_doe',
                'John  Doe',
                ' John Doe',
                'Mary Ann',
            ]) {
                const err = await check(name);
                assert.ok(err, `${name} is refused`);
            }
        });

        it('allows names that give another address', async () => {
            for (const name of ['John-Doe', 'John_Dow', 'Johnny_Doe', 'a_b']) {
                assert.equal(await check(name), null, name);
            }
        });
    });
});
