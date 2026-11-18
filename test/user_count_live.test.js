'use strict';

//
//  #1049: the total user count read by |TU, the WFC and the REST stats route is
//  counted live (cached for a short time), not read once at startup.
//
//  The readers are driven as they are in production. The user database is an
//  in-memory one swapped into dbs.user for the run; modules are required in
//  before() so a load-time capture cannot see another file's state.
//

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');

describe('live total user count (#1049)', function () {
    let dbModule, realUserDb, db, Events, userCount, statsHandler, mci;
    let realNow, now;

    const client = { user: { isAuthenticated: () => true }, term: {} };

    function addUser(name) {
        db.prepare('INSERT INTO user (user_name) VALUES (?);').run(name);
    }

    function restTotal() {
        let body;
        statsHandler(
            { headers: {}, method: 'GET', url: '/_enig/api/v1/system/stats' },
            {
                setHeader() {},
                writeHead() {},
                end(b) {
                    body = JSON.parse(b);
                },
            }
        );
        return body.totalUsers;
    }

    before(() => {
        dbModule = require('../core/database');
        realUserDb = dbModule.dbs.user;
        db = new Database(':memory:');
        db.exec(
            'CREATE TABLE user (id INTEGER PRIMARY KEY, user_name VARCHAR NOT NULL);'
        );
        dbModule.dbs.user = db;

        Events = require('../core/events');
        userCount = require('../core/user_count');
        mci = require('../core/predefined_mci');

        const routes = [];
        require('../core/rest/routes/system').register(
            { addRoute: r => routes.push(r) },
            { info() {}, warn() {}, error() {}, debug() {}, trace() {} }
        );
        statsHandler = routes.find(r =>
            r.path.test('/_enig/api/v1/system/stats')
        ).handler;

        realNow = Date.now;
        Date.now = () => now;
    });

    after(() => {
        Date.now = realNow;
        dbModule.dbs.user = realUserDb;
        db.close();
        userCount.resetUserCountCache();
    });

    beforeEach(() => {
        db.exec('DELETE FROM user;');
        now = 1000000;
        userCount.resetUserCountCache();
    });

    it('|TU, the REST route and the helper agree on the live count', () => {
        addUser('a');
        addUser('b');
        assert.equal(mci.getPredefinedMCIValue(client, 'TU'), 2);
        assert.equal(restTotal(), 2);
        assert.equal(userCount.getTotalUserCount(), 2);
    });

    it('a new user is counted at once when NewUser is emitted', () => {
        userCount.watchNewUsers();
        addUser('a');
        assert.equal(mci.getPredefinedMCIValue(client, 'TU'), 1);

        addUser('b');
        Events.emit(Events.getSystemEvents().NewUser, { user: {} });
        assert.equal(mci.getPredefinedMCIValue(client, 'TU'), 2);
        assert.equal(restTotal(), 2);
        Events.removeAllListeners(Events.getSystemEvents().NewUser);
    });

    it('a removed user drops from the count once the cache expires', () => {
        addUser('a');
        addUser('b');
        addUser('c');
        assert.equal(restTotal(), 3);

        db.prepare("DELETE FROM user WHERE user_name = 'c';").run(); //  as oputil does
        now += userCount.CacheMs - 1;
        assert.equal(restTotal(), 3, 'cached inside the window');
        now += 1;
        assert.equal(restTotal(), 2);
        assert.equal(mci.getPredefinedMCIValue(client, 'TU'), 2);
    });

    it('the cache is not re-read inside its window', () => {
        addUser('a');
        assert.equal(userCount.getTotalUserCount(), 1);
        addUser('b');
        assert.equal(userCount.getTotalUserCount(), 1);
    });

    it('|TU shows 1 for an empty user table, the REST route 0', () => {
        assert.equal(mci.getPredefinedMCIValue(client, 'TU'), 1);
        assert.equal(restTotal(), 0);
    });

    it('a failed read keeps the last count', () => {
        addUser('a');
        assert.equal(userCount.getTotalUserCount(), 1);
        db.exec('ALTER TABLE user RENAME TO user_gone;');
        try {
            now += userCount.CacheMs;
            assert.equal(userCount.getTotalUserCount(), 1);
        } finally {
            db.exec('ALTER TABLE user_gone RENAME TO user;');
        }
    });

    it('a failed first read is retried once per cache window, not on every call', () => {
        const realPrepare = db.prepare;
        let reads = 0;
        db.prepare = function (sql) {
            if (/COUNT\(\*\)/.test(sql)) {
                ++reads;
            }
            return realPrepare.call(this, sql);
        };
        db.exec('ALTER TABLE user RENAME TO user_gone;');
        try {
            assert.equal(userCount.getTotalUserCount(), 0);
            assert.equal(userCount.getTotalUserCount(), 0);
            assert.equal(mci.getPredefinedMCIValue(client, 'TU'), 1);
            assert.equal(reads, 1);

            now += userCount.CacheMs;
            userCount.getTotalUserCount();
            assert.equal(reads, 2);
        } finally {
            db.prepare = realPrepare;
            db.exec('ALTER TABLE user_gone RENAME TO user;');
        }
    });

    it('a count primed at startup is served without another read', () => {
        addUser('a');
        userCount.primeTotalUserCount(7);
        assert.equal(userCount.getTotalUserCount(), 7);
        now += userCount.CacheMs;
        assert.equal(userCount.getTotalUserCount(), 1);
    });
});
