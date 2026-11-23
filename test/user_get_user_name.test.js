'use strict';

//
//  User.getUserName() called back inside its try, so a throw in the
//  callback was caught there and passed to the callback again as a lookup
//  error: the callback ran twice and the real exception was lost.
//
//  user.js captures dbs.user at load, so a fresh copy is loaded against an
//  in-memory user database and the original put back afterwards.
//

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');

describe('User.getUserName()', () => {
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
            'CREATE TABLE user (id INTEGER PRIMARY KEY, user_name VARCHAR NOT NULL);'
        );
        db.prepare('INSERT INTO user (id, user_name) VALUES (1, ?);').run('NuSkooler');
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

    it('gives the name for a user ID', done => {
        User.getUserName(1, (err, userName) => {
            assert.ifError(err);
            assert.equal(userName, 'NuSkooler');
            done();
        });
    });

    it('gives an error for an unknown user ID', done => {
        User.getUserName(99, (err, userName) => {
            assert.ok(err);
            assert.equal(userName, undefined);
            done();
        });
    });

    it('a throw in the callback reaches the caller; the callback runs once', () => {
        let calls = 0;
        assert.throws(
            () =>
                User.getUserName(1, () => {
                    ++calls;
                    throw new Error('downstream');
                }),
            /downstream/
        );
        assert.equal(calls, 1);
    });
});
