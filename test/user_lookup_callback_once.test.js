'use strict';

//
//  The User lookups ran their callback inside the try around the database
//  call, so a throw in the callback was caught there and passed to the
//  callback again as a lookup error: the callback ran twice and the real
//  exception was lost (#1168; getUserName() was fixed in #1166).
//
//  user.js captures dbs.user at load, so a fresh copy is loaded against an
//  in-memory user database and the original put back afterwards.
//

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');

describe('User lookups: a throw in the callback', () => {
    let dbModule;
    let realUserDb;
    let db;
    let User;
    let savedUserEntry;
    const userPath = require.resolve('../core/user.js');

    before(() => {
        dbModule = require('../core/database');
        realUserDb = dbModule.dbs.user;
        db = new Database(':memory:');
        db.exec(
            `CREATE TABLE user (id INTEGER PRIMARY KEY, user_name VARCHAR NOT NULL);
            CREATE TABLE user_property (
                user_id INTEGER NOT NULL,
                prop_name VARCHAR NOT NULL,
                prop_value VARCHAR,
                UNIQUE(user_id, prop_name)
            );`
        );
        db.prepare('INSERT INTO user (id, user_name) VALUES (1, ?);').run('NuSkooler');
        db.prepare(
            'INSERT INTO user_property (user_id, prop_name, prop_value) VALUES (1, ?, ?);'
        ).run('real_name', 'Bryan Ashby');
        dbModule.dbs.user = db;

        savedUserEntry = require.cache[userPath];
        delete require.cache[userPath];
        User = require('../core/user.js');
    });

    after(() => {
        dbModule.dbs.user = realUserDb;
        if (savedUserEntry) {
            require.cache[userPath] = savedUserEntry;
        } else {
            delete require.cache[userPath];
        }
        db.close();
    });

    //  |call(cb)| starts a lookup that succeeds; its callback throws
    function throwsOnceFromCallback(call) {
        let calls = 0;
        const errs = [];
        assert.throws(
            () =>
                call(err => {
                    ++calls;
                    errs.push(err);
                    throw new Error('downstream');
                }),
            /downstream/
        );
        assert.equal(calls, 1, 'the callback runs once');
        assert.ifError(errs[0]);
    }

    const LOOKUPS = {
        getUserIdAndName: cb => User.getUserIdAndName('nuskooler', cb),
        getUserIdsAndNamesLike: cb => User.getUserIdsAndNamesLike('nu%', cb),
        getUserIdAndNameByRealName: cb =>
            User.getUserIdAndNameByRealName('Bryan Ashby', cb),
        loadProperties: cb => User.loadProperties(1, cb),
        getUserIdsWithProperty: cb =>
            User.getUserIdsWithProperty('real_name', 'Bryan Ashby', cb),
        getUserCount: cb => User.getUserCount(cb),
        getUserList: cb => User.getUserList({}, cb),
    };

    for (const [name, call] of Object.entries(LOOKUPS)) {
        it(`${name}() lets it reach the caller, and calls back once`, () => {
            throwsOnceFromCallback(call);
        });
    }

    it('the lookups still give their results', done => {
        User.getUserIdAndName('NUSKOOLER', (err, userId, userName) => {
            assert.ifError(err);
            assert.deepEqual([userId, userName], [1, 'NuSkooler']);
            User.getUserIdAndNameByRealName('bryan ashby', (err, userId) => {
                assert.ifError(err);
                assert.equal(userId, 1);
                User.loadProperties(1, (err, props) => {
                    assert.ifError(err);
                    assert.deepEqual(props, { real_name: 'Bryan Ashby' });
                    User.getUserCount((err, count) => {
                        assert.ifError(err);
                        assert.equal(count, 1);
                        User.getUserList({}, (err, list) => {
                            assert.ifError(err);
                            assert.equal(list.length, 1);
                            assert.equal(list[0].userName, 'NuSkooler');
                            done();
                        });
                    });
                });
            });
        });
    });

    it('an unknown name is still a DoesNotExist error', done => {
        User.getUserIdAndName('nobody', err => {
            assert.ok(err);
            done();
        });
    });
});
