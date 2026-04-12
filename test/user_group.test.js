'use strict';

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');

//
//  Config mock — minimal, needed before any transitive require touches Config.
//
const configModule = require('../core/config.js');
configModule.get = () => ({ debug: { assertsEnabled: false } });

//
//  In-memory DB injection.  user_group.js captures dbs.user at load time, so
//  inject before requiring it.
//
const dbModule = require('../core/database.js');
const _testDb = new Database(':memory:');
dbModule.dbs.user = _testDb;

//
//  Force a fresh load so it captures the in-memory DB injected above (a
//  previous test file may have required user_group.js with a different DB).
//
delete require.cache[require.resolve('../core/user_group.js')];
const userGroup = require('../core/user_group.js');

// ─── schema ──────────────────────────────────────────────────────────────────

function applySchema(db, done) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS user_group_member (
            group_name  VARCHAR NOT NULL,
            user_id     INTEGER NOT NULL,
            UNIQUE(group_name, user_id)
        );
    `);
    return done(null);
}

// ─── getGroupsForUser ────────────────────────────────────────────────────────

describe('userGroup.getGroupsForUser()', function () {
    before(done => applySchema(_testDb, done));

    beforeEach(done => {
        _testDb.exec('DELETE FROM user_group_member;');
        done();
    });

    it('returns empty array when user has no groups', done => {
        userGroup.getGroupsForUser(1, (err, groups) => {
            assert.ifError(err);
            assert.deepEqual(groups, []);
            done();
        });
    });

    it('returns the single group the user belongs to', done => {
        _testDb
            .prepare(`INSERT INTO user_group_member (group_name, user_id) VALUES (?, ?)`)
            .run('users', 1);

        userGroup.getGroupsForUser(1, (err, groups) => {
            assert.ifError(err);
            assert.deepEqual(groups, ['users']);
            done();
        });
    });

    it('returns multiple groups', done => {
        _testDb
            .prepare(`INSERT INTO user_group_member (group_name, user_id) VALUES (?, ?)`)
            .run('users', 2);
        _testDb
            .prepare(`INSERT INTO user_group_member (group_name, user_id) VALUES (?, ?)`)
            .run('sysops', 2);

        userGroup.getGroupsForUser(2, (err, groups) => {
            assert.ifError(err);
            assert.ok(groups.includes('users'));
            assert.ok(groups.includes('sysops'));
            assert.equal(groups.length, 2);
            done();
        });
    });

    it('does not return groups belonging to a different user', done => {
        _testDb
            .prepare(`INSERT INTO user_group_member (group_name, user_id) VALUES (?, ?)`)
            .run('users', 3);
        _testDb
            .prepare(`INSERT INTO user_group_member (group_name, user_id) VALUES (?, ?)`)
            .run('sysops', 4);

        userGroup.getGroupsForUser(3, (err, groups) => {
            assert.ifError(err);
            assert.deepEqual(groups, ['users']);
            done();
        });
    });
});

// ─── addUserToGroup ───────────────────────────────────────────────────────────

describe('userGroup.addUserToGroup()', function () {
    before(done => applySchema(_testDb, done));

    beforeEach(done => {
        _testDb.exec('DELETE FROM user_group_member;');
        done();
    });

    it('inserts a new group membership', done => {
        userGroup.addUserToGroup(10, 'editors', err => {
            assert.ifError(err);
            const row = _testDb
                .prepare(
                    `SELECT * FROM user_group_member WHERE user_id=? AND group_name=?`
                )
                .get(10, 'editors');
            assert.ok(row);
            done();
        });
    });

    it('is idempotent on duplicate insert (REPLACE)', done => {
        userGroup.addUserToGroup(11, 'users', err => {
            assert.ifError(err);
            userGroup.addUserToGroup(11, 'users', err2 => {
                assert.ifError(err2);
                const count = _testDb
                    .prepare(
                        `SELECT COUNT(*) AS n FROM user_group_member WHERE user_id=?`
                    )
                    .get(11).n;
                assert.equal(count, 1);
                done();
            });
        });
    });
});

// ─── addUserToGroups ──────────────────────────────────────────────────────────

describe('userGroup.addUserToGroups()', function () {
    before(done => applySchema(_testDb, done));

    beforeEach(done => {
        _testDb.exec('DELETE FROM user_group_member;');
        done();
    });

    it('inserts all groups in one call', done => {
        userGroup.addUserToGroups(20, ['users', 'editors', 'beta'], err => {
            assert.ifError(err);
            userGroup.getGroupsForUser(20, (err2, groups) => {
                assert.ifError(err2);
                assert.equal(groups.length, 3);
                assert.ok(groups.includes('users'));
                assert.ok(groups.includes('editors'));
                assert.ok(groups.includes('beta'));
                done();
            });
        });
    });

    it('handles an empty groups array without error', done => {
        userGroup.addUserToGroups(21, [], err => {
            assert.ifError(err);
            userGroup.getGroupsForUser(21, (err2, groups) => {
                assert.ifError(err2);
                assert.deepEqual(groups, []);
                done();
            });
        });
    });
});

// ─── removeUserFromGroup ──────────────────────────────────────────────────────

describe('userGroup.removeUserFromGroup()', function () {
    before(done => applySchema(_testDb, done));

    beforeEach(done => {
        _testDb.exec('DELETE FROM user_group_member;');
        done();
    });

    it('removes an existing membership', done => {
        _testDb
            .prepare(`INSERT INTO user_group_member (group_name, user_id) VALUES (?, ?)`)
            .run('users', 30);

        userGroup.removeUserFromGroup(30, 'users', err => {
            assert.ifError(err);
            userGroup.getGroupsForUser(30, (err2, groups) => {
                assert.ifError(err2);
                assert.deepEqual(groups, []);
                done();
            });
        });
    });

    it('is a no-op when the membership does not exist', done => {
        userGroup.removeUserFromGroup(31, 'nonexistent', err => {
            assert.ifError(err);
            done();
        });
    });

    it('removes only the specified group, leaving others intact', done => {
        _testDb
            .prepare(`INSERT INTO user_group_member (group_name, user_id) VALUES (?, ?)`)
            .run('users', 32);
        _testDb
            .prepare(`INSERT INTO user_group_member (group_name, user_id) VALUES (?, ?)`)
            .run('sysops', 32);

        userGroup.removeUserFromGroup(32, 'sysops', err => {
            assert.ifError(err);
            userGroup.getGroupsForUser(32, (err2, groups) => {
                assert.ifError(err2);
                assert.deepEqual(groups, ['users']);
                done();
            });
        });
    });
});
