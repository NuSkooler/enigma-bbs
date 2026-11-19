'use strict';

//
//  #1049: the TotalUserCount system stat is refreshed when it is read (at most
//  once per 30 s), not set once at startup, and a NewUser event counts at once.
//
//  The unchanged readers are driven as they are in production: |TU, the REST
//  stats route and a theme's @sysStat:user_total_count (asset.js). The user
//  database is an in-memory one swapped into dbs.user for the run.
//
//  stat_log.js and user.js capture database handles at load, and other test
//  files evict stat_log.js, so the readers loaded earlier may hold different
//  StatLog instances. before() therefore loads fresh copies of the modules
//  involved and after() puts the originals back in the require cache.
//

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');

const FreshModules = [
    '../core/stat_log.js',
    '../core/user.js',
    '../core/asset.js',
    '../core/predefined_mci.js',
    '../core/rest/routes/system.js',
    //  sys_event_user_log.test.js loads it against a stub events.js
    '../core/sys_event_user_log.js',
];

const TTLMs = 30 * 1000;

describe('live total user count (#1049)', function () {
    let dbModule, realUserDb, db, loggerModule, realLog, Events;
    let StatLog, SysProps, User, asset, mci, statsHandler;
    let savedCache, addedListeners, realNow, now, reads, warnings;

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

    const tu = () => mci.getPredefinedMCIValue(client, 'TU');
    const themeStat = () => asset.resolveSystemStatAsset('@sysStat:user_total_count');

    before(() => {
        dbModule = require('../core/database');
        realUserDb = dbModule.dbs.user;
        db = new Database(':memory:');
        db.exec(
            'CREATE TABLE user (id INTEGER PRIMARY KEY, user_name VARCHAR NOT NULL);'
        );
        dbModule.dbs.user = db;

        loggerModule = require('../core/logger');
        realLog = loggerModule.log;
        const log = {
            warn: (...args) => warnings.push(args),
            info() {},
            debug() {},
            trace() {},
            error() {},
            child: () => log,
        };
        loggerModule.log = log;

        savedCache = {};
        for (const m of FreshModules) {
            const p = require.resolve(m);
            savedCache[p] = require.cache[p];
            delete require.cache[p];
        }

        StatLog = require('../core/stat_log');
        SysProps = require('../core/system_property');
        User = require('../core/user');
        asset = require('../core/asset');
        mci = require('../core/predefined_mci');

        const routes = [];
        require('../core/rest/routes/system').register(
            { addRoute: r => routes.push(r) },
            { info() {}, warn() {}, error() {}, debug() {}, trace() {} }
        );
        statsHandler = routes.find(r =>
            r.path.test('/_enig/api/v1/system/stats')
        ).handler;

        const realGetUserCount = User.getUserCount;
        User.getUserCount = cb => {
            ++reads;
            return realGetUserCount.call(User, cb);
        };

        //  the production NewUser handler, against this StatLog
        StatLog.appendUserLogEntry = () => {};
        Events = require('../core/events');
        const eventNames = Object.values(Events.getSystemEvents());
        const before = new Map(eventNames.map(n => [n, Events.listeners(n)]));
        require('../core/sys_event_user_log')(StatLog);
        addedListeners = [];
        for (const n of eventNames) {
            for (const l of Events.listeners(n)) {
                if (!before.get(n).includes(l)) {
                    addedListeners.push([n, l]);
                }
            }
        }

        realNow = Date.now;
        Date.now = () => now;
    });

    after(() => {
        Date.now = realNow;
        for (const [n, l] of addedListeners) {
            Events.removeListener(n, l);
        }
        for (const [p, mod] of Object.entries(savedCache)) {
            if (mod) {
                require.cache[p] = mod;
            } else {
                delete require.cache[p];
            }
        }
        loggerModule.log = realLog;
        dbModule.dbs.user = realUserDb;
        db.close();
    });

    beforeEach(() => {
        db.exec('DELETE FROM user;');
        now = 1000000;
        reads = 0;
        warnings = [];
        StatLog.setNonPersistentSystemStat(SysProps.TotalUserCount, undefined);
        StatLog.markTotalUserCountRefreshed(0);
    });

    it('|TU, the REST route and a theme @sysStat agree on the live count', () => {
        addUser('a');
        addUser('b');
        assert.equal(tu(), '2');
        assert.equal(restTotal(), 2);
        assert.equal(themeStat(), 2);
        assert.equal(reads, 1);
    });

    it('a new user is counted at once when NewUser is emitted', () => {
        addUser('a');
        assert.equal(themeStat(), 1);

        addUser('b');
        Events.emit(Events.getSystemEvents().NewUser, { user: {} });
        assert.equal(tu(), '2');
        assert.equal(restTotal(), 2);
        assert.equal(themeStat(), 2);
        assert.equal(reads, 1, 'counted by the event, not a re-read');
    });

    it('a user removed by oputil drops from the count once the window expires', () => {
        addUser('a');
        addUser('b');
        addUser('c');
        assert.equal(restTotal(), 3);

        db.prepare("DELETE FROM user WHERE user_name = 'c';").run(); //  as oputil does
        now += TTLMs - 1;
        assert.equal(restTotal(), 3, 'cached inside the window');
        assert.equal(themeStat(), 3, 'cached inside the window');
        now += 1;
        assert.equal(themeStat(), 2);
        assert.equal(restTotal(), 2);
        assert.equal(tu(), '2');
    });

    it('the count is not re-read inside its window', () => {
        addUser('a');
        assert.equal(themeStat(), 1);
        addUser('b');
        assert.equal(themeStat(), 1);
        assert.equal(tu(), '1');
        assert.equal(restTotal(), 1);
        assert.equal(reads, 1);
    });

    it('|TU shows 1 for an empty user table, the REST route 0', () => {
        assert.equal(tu(), '1');
        assert.equal(restTotal(), 0);
        //  resolveSystemStatAsset() falls back to the spec for a falsy stat
        assert.equal(themeStat(), '@sysStat:user_total_count');
        assert.equal(reads, 1);
    });

    it('a failed read keeps the last count and logs a warning', () => {
        addUser('a');
        assert.equal(themeStat(), 1);
        db.exec('ALTER TABLE user RENAME TO user_gone;');
        try {
            now += TTLMs;
            assert.equal(themeStat(), 1);
            assert.equal(tu(), '1');
            assert.equal(restTotal(), 1);
            assert.equal(warnings.length, 1);
        } finally {
            db.exec('ALTER TABLE user_gone RENAME TO user;');
        }
    });

    it('a failed first read is retried once per window, not on every read', () => {
        db.exec('ALTER TABLE user RENAME TO user_gone;');
        try {
            assert.equal(restTotal(), 0);
            assert.equal(restTotal(), 0);
            assert.equal(tu(), '1');
            assert.equal(themeStat(), '@sysStat:user_total_count', 'nothing to show');
            assert.equal(reads, 1);

            now += TTLMs;
            restTotal();
            assert.equal(reads, 2);
        } finally {
            db.exec('ALTER TABLE user_gone RENAME TO user;');
        }
    });

    //  #1105: TU and NT return strings like every other predefined MCI code;
    //  a number was dropped by |TU (UI), drawn as a colour (body) and by %TU.
    describe('TU and NT as strings (#1105)', () => {
        let PipeCodes;
        const ESC = '\x1b';
        //  the production resolver, passed in so no other file's can answer
        const opts = extra =>
            Object.assign({ client, resolveMci: mci.getPredefinedMCIValue }, extra);

        before(() => {
            PipeCodes = require('../core/pipe_codes');
        });

        afterEach(() => {
            StatLog.setNonPersistentSystemStat(SysProps.NewUsersTodayCount, undefined);
        });

        it('|TU draws the count in both pipe dialects', () => {
            addUser('a');
            addUser('b');
            assert.equal(PipeCodes.render('[|TU]', opts()), '[2]');
            assert.equal(PipeCodes.render('[|TU]', opts({ dialect: 'body' })), '[2]');
            assert.ok(!PipeCodes.render('|TU', opts({ dialect: 'body' })).includes(ESC));
        });

        it('|NT draws the count, 0 included', () => {
            assert.equal(mci.getPredefinedMCIValue(client, 'NT'), '0');
            assert.equal(PipeCodes.render('[|NT]', opts()), '[0]');
            StatLog.setNonPersistentSystemStat(SysProps.NewUsersTodayCount, 3);
            assert.equal(mci.getPredefinedMCIValue(client, 'NT'), '3');
            assert.equal(PipeCodes.render('[|NT]', opts({ dialect: 'body' })), '[3]');
        });

        it('{TU} and {NT} reach the format object as numbers, NT=0 too', () => {
            addUser('a');
            assert.deepEqual(mci.getPredefinedMCIFormatObject(client, '{TU} {NT}'), {
                TU: 1,
                NT: 0,
            });
        });

        it('TU is grouped like TC and TT', () => {
            StatLog.setNonPersistentSystemStat(SysProps.TotalUserCount, 1234);
            StatLog.markTotalUserCountRefreshed();
            assert.equal(tu(), (1234).toLocaleString());
        });
    });

    it('the startup seed is served without another read', () => {
        addUser('a');

        //  as bbs.js initUserCount does
        StatLog.setNonPersistentSystemStat(SysProps.TotalUserCount, 7);
        StatLog.markTotalUserCountRefreshed();

        assert.equal(themeStat(), 7);
        assert.equal(tu(), '7');
        assert.equal(reads, 0);
        now += TTLMs;
        assert.equal(themeStat(), 1);
        assert.equal(reads, 1);
    });
});
