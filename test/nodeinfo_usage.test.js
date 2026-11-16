'use strict';

//
//  NodeInfo / NodeInfo2 documents: the shape of each version against its
//  published JSON schema, and the active user counts (distinct users, by last
//  login) they carry.
//
//  Schemas: test/fixtures/nodeinfo. 2.0 and 2.1 are from
//  https://nodeinfo.diaspora.software/ns/schema/, 1.0 is from
//  https://github.com/jaywink/nodeinfo2/tree/master/schemas/1.0 (with the
//  trailing commas of its source removed, which JSON does not allow).
//

const { strict: assert } = require('assert');
const fs = require('fs');
const paths = require('path');
const Database = require('better-sqlite3');
const Ajv = require('ajv');

const {
    countActiveUsers,
    ActiveUsersIndexSql,
    ActiveUsersSql,
    ActiveWindowDays,
} = require('../core/active_users');
const UserProps = require('../core/user_property');
const SysProps = require('../core/system_property');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);

function loadSchema(name) {
    return JSON.parse(
        fs.readFileSync(paths.join(__dirname, 'fixtures/nodeinfo', name), 'utf8')
    );
}

function newValidator(schemaFile) {
    const ajv = new Ajv({ schemaId: 'auto', allErrors: true });
    ajv.addMetaSchema(require('ajv/lib/refs/json-schema-draft-04.json'));
    return ajv.compile(loadSchema(schemaFile));
}

function newUserDb() {
    const db = new Database(':memory:');
    db.exec(`
        CREATE TABLE user (id INTEGER PRIMARY KEY, user_name VARCHAR NOT NULL);
        CREATE TABLE user_property (
            user_id     INTEGER NOT NULL,
            prop_name   VARCHAR NOT NULL,
            prop_value  VARCHAR,
            UNIQUE(user_id, prop_name)
        );
        CREATE INDEX user_property_id_and_name_index0 ON user_property (user_id, prop_name);
        ${ActiveUsersIndexSql}
    `);
    return db;
}

//  as the login code writes it: local time with an offset
function stamp(ms, offsetMinutes = -420) {
    const d = new Date(ms + offsetMinutes * 60 * 1000);
    const sign = offsetMinutes < 0 ? '-' : '+';
    const abs = Math.abs(offsetMinutes);
    const hh = String(Math.floor(abs / 60)).padStart(2, '0');
    const mm = String(abs % 60).padStart(2, '0');
    return d.toISOString().replace('Z', `${sign}${hh}:${mm}`);
}

//  registered users 1..n
function addUsers(db, n) {
    const ins = db.prepare('INSERT OR IGNORE INTO user (id, user_name) VALUES (?, ?)');
    for (let i = 1; i <= n; ++i) ins.run(i, `user${i}`);
}

//  records a login for a registered user (added if need be); |orphan| leaves
//  the user table alone
function addLogin(db, userId, ms, offsetMinutes, orphan = false) {
    if (!orphan) {
        db.prepare('INSERT OR IGNORE INTO user (id, user_name) VALUES (?, ?)').run(
            userId,
            `user${userId}`
        );
    }
    db.prepare(
        `INSERT OR REPLACE INTO user_property (user_id, prop_name, prop_value)
         VALUES (?, ?, ?)`
    ).run(userId, UserProps.LastLoginTs, stamp(ms, offsetMinutes));
}

describe('NodeInfo active users', function () {
    describe('countActiveUsers()', function () {
        //  just the windows
        const windows = (db, now = NOW) => {
            const w = { ...countActiveUsers(db, now) };
            delete w.total;
            return w;
        };

        it('uses the documented windows', () => {
            assert.deepEqual(
                { ...ActiveWindowDays },
                { activeHalfyear: 180, activeMonth: 30, activeWeek: 7 }
            );
        });

        it('is all zero for a board nobody has logged in to', () => {
            assert.deepEqual(windows(newUserDb()), {
                activeHalfyear: 0,
                activeMonth: 0,
                activeWeek: 0,
            });
        });

        it('counts a user once however many times they logged in', () => {
            const db = newUserDb();
            //  the last login is what is stored; repeated logins overwrite it
            for (let i = 0; i < 50; ++i) {
                addLogin(db, 1, NOW - i * 60 * 1000);
            }
            assert.deepEqual(windows(db), {
                activeHalfyear: 1,
                activeMonth: 1,
                activeWeek: 1,
            });
        });

        it('counts each user in the windows their last login falls in', () => {
            const db = newUserDb();
            addLogin(db, 1, NOW - 1 * DAY); //  all three
            addLogin(db, 2, NOW - 10 * DAY); //  month, half year
            addLogin(db, 3, NOW - 100 * DAY); //  half year
            addLogin(db, 4, NOW - 400 * DAY); //  none
            assert.deepEqual(windows(db), {
                activeHalfyear: 3,
                activeMonth: 2,
                activeWeek: 1,
            });
        });

        it('puts the window edges at exactly 7, 30 and 180 days', () => {
            const db = newUserDb();
            addLogin(db, 1, NOW - 7 * DAY + 1000);
            addLogin(db, 2, NOW - 7 * DAY - 1000);
            addLogin(db, 3, NOW - 30 * DAY + 1000);
            addLogin(db, 4, NOW - 30 * DAY - 1000);
            addLogin(db, 5, NOW - 180 * DAY + 1000);
            addLogin(db, 6, NOW - 180 * DAY - 1000);
            assert.deepEqual(windows(db), {
                activeHalfyear: 5, //  1 2 3 4 5
                activeMonth: 3, //  1 2 3
                activeWeek: 1, //  1
            });
        });

        it('compares instants, whatever offset a timestamp was written with', () => {
            const db = newUserDb();
            //  the same instant, 6 days ago, written in three zones
            addLogin(db, 1, NOW - 6 * DAY, -420);
            addLogin(db, 2, NOW - 6 * DAY, 0);
            addLogin(db, 3, NOW - 6 * DAY, 600);
            //  8 days ago, written in a zone whose clock reads later
            addLogin(db, 4, NOW - 8 * DAY, 840);
            const counts = windows(db);
            assert.equal(counts.activeWeek, 3);
            assert.equal(counts.activeMonth, 4);
        });

        it('returns the live number of users as total', () => {
            const db = newUserDb();
            addUsers(db, 3);
            assert.equal(countActiveUsers(db, NOW).total, 3);
            addUsers(db, 8);
            assert.equal(countActiveUsers(db, NOW).total, 8);
        });

        it('ignores other properties and unreadable timestamps', () => {
            const db = newUserDb();
            addLogin(db, 1, NOW - DAY);
            db.prepare(`INSERT INTO user_property VALUES (2, ?, ?)`).run(
                UserProps.PrevLoginTs,
                stamp(NOW - DAY)
            );
            db.prepare(`INSERT INTO user_property VALUES (3, ?, ?)`).run(
                UserProps.LastLoginTs,
                'not a date'
            );
            db.prepare(`INSERT INTO user_property VALUES (4, ?, NULL)`).run(
                UserProps.LastLoginTs
            );
            assert.deepEqual(windows(db), {
                activeHalfyear: 1,
                activeMonth: 1,
                activeWeek: 1,
            });
        });

        it('reads only the partial covering index: no table scan, no table lookup', () => {
            const db = newUserDb();
            const plan = db
                .prepare(`EXPLAIN QUERY PLAN ${ActiveUsersSql}`)
                .all({ halfyear: '', month: '', week: '' })
                .map(r => r.detail)
                .join('\n');
            assert.match(
                plan,
                /SCAN user_property USING COVERING INDEX user_property_last_login_index0/
            );
        });
    });

    describe('documents', function () {
        const testConfig = {
            general: { boardName: 'Test Board', closedSystem: false },
            loginServers: { telnet: { enabled: true }, ssh: { enabled: true } },
            contentServers: {
                web: {
                    domain: 'bbs.example.org',
                    https: { enabled: true, port: 443 },
                    http: { enabled: false, port: 8080 },
                    handlers: { activityPub: { enabled: true } },
                },
            },
        };

        let NodeInfo2, StatLog, Collection, dbModule;
        let realGetStat, realCountPosts, realUserDb;

        before(() => {
            ({
                getModule: NodeInfo2,
            } = require('../core/servers/content/web_handlers/nodeinfo2.js'));
            StatLog = require('../core/stat_log');
            Collection = require('../core/activitypub/collection');
            dbModule = require('../core/database');
            realGetStat = StatLog.getSystemStat;
            realCountPosts = Collection.countLocalPosts;
            realUserDb = dbModule.dbs.user;
        });

        after(() => {
            StatLog.getSystemStat = realGetStat;
            Collection.countLocalPosts = realCountPosts;
            dbModule.dbs.user = realUserDb;
        });

        //  startupTotal: the TotalUserCount stat, set once at startup and never
        //  updated; the documents must not use it
        function setup(db, startupTotal = 1) {
            dbModule.dbs.user = db;
            StatLog.getSystemStat = name =>
                SysProps.TotalUserCount === name
                    ? startupTotal
                    : realGetStat.call(StatLog, name);
            Collection.countLocalPosts = cb => cb(null, 11);

            const handler = new NodeInfo2();
            const noop = () => {};
            handler.log = {
                warn: noop,
                info: noop,
                debug: noop,
                error: noop,
                trace: noop,
            };
            handler._config = () => testConfig;
            return handler;
        }

        function nodeInfo2Doc(handler) {
            let doc;
            handler._nodeInfo2Handler(
                {},
                {
                    writeHead() {},
                    end(body) {
                        doc = JSON.parse(body);
                    },
                }
            );
            return doc;
        }

        function standardDoc(handler, version) {
            let doc;
            handler._nodeInfoStandardHandler(
                { url: `/_enig/nodeinfo/${version}` },
                {
                    writeHead() {},
                    end(body) {
                        doc = JSON.parse(body);
                    },
                }
            );
            return doc;
        }

        //  a board of 5 users where 1 logged in 140 times in the half year
        function busyBoard() {
            const db = newUserDb();
            const now = Date.now();
            addLogin(db, 1, now - 1 * 60 * 1000);
            addLogin(db, 2, now - 3 * DAY);
            addLogin(db, 3, now - 20 * DAY);
            addLogin(db, 4, now - 150 * DAY);
            addUsers(db, 5);
            return db; //  user 5 never logged in
        }

        const validate10 = () => newValidator('nodeinfo2-1.0.schema.json');

        it('NodeInfo2 1.0 carries the counts under usage.users and validates', () => {
            const handler = setup(busyBoard());
            const doc = nodeInfo2Doc(handler);
            const validate = validate10();
            assert.ok(validate(doc), JSON.stringify(validate.errors));
            assert.deepEqual(doc.usage, {
                users: { total: 5, activeHalfyear: 4, activeMonth: 3, activeWeek: 2 },
                localPosts: 11,
            });
            for (const k of ['activeHalfyear', 'activeMonth', 'activeWeek']) {
                assert.equal(k in doc.usage, false, `${k} must not be at usage.*`);
            }
        });

        for (const version of ['2.0', '2.1']) {
            it(`NodeInfo ${version} keeps its shape and validates`, () => {
                const handler = setup(busyBoard());
                const doc = standardDoc(handler, version);
                const validate = newValidator(`nodeinfo-${version}.schema.json`);
                assert.ok(validate(doc), JSON.stringify(validate.errors));
                assert.equal(doc.version, version);
                assert.deepEqual(doc.usage, {
                    users: { total: 5, activeHalfyear: 4, activeMonth: 3 },
                    localPosts: 11,
                });
            });
        }

        it('reports the live user count, not the stat set at startup', () => {
            //  the board started with 2 users and has 5 now
            const doc = nodeInfo2Doc(setup(busyBoard(), 2));
            assert.deepEqual(doc.usage.users, {
                total: 5,
                activeHalfyear: 4,
                activeMonth: 3,
                activeWeek: 2,
            });
            const v21 = standardDoc(setup(busyBoard(), 2), '2.1');
            assert.deepEqual(v21.usage.users, {
                total: 5,
                activeHalfyear: 4,
                activeMonth: 3,
            });

            //  and a board that started empty is not stuck at 0
            const fresh = nodeInfo2Doc(setup(busyBoard(), 0));
            assert.equal(fresh.usage.users.total, 5);
            assert.equal(fresh.usage.users.activeWeek, 2);
        });

        it('reports the live total when the startup stat is unset', () => {
            for (const unset of [undefined, null, '', 'abc']) {
                const doc = nodeInfo2Doc(setup(busyBoard(), unset));
                assert.equal(doc.usage.users.total, 5, `stat ${unset}`);
                assert.ok(validate10()(doc));
            }
        });

        it('caps each count at the total', () => {
            //  logins recorded for user ids that are not (or no longer) users
            const db = busyBoard();
            addLogin(db, 90, Date.now() - 1000, undefined, true);
            addLogin(db, 91, Date.now() - 1000, undefined, true);
            addLogin(db, 92, Date.now() - 1000, undefined, true);
            addLogin(db, 5, Date.now() - 1000);
            addLogin(db, 4, Date.now() - 1000);
            const doc = nodeInfo2Doc(setup(db));
            assert.deepEqual(doc.usage.users, {
                total: 5,
                activeHalfyear: 5,
                activeMonth: 5,
                activeWeek: 5,
            });
        });

        it('reports a total of 0 as 0', () => {
            const doc = nodeInfo2Doc(setup(newUserDb(), 9));
            assert.deepEqual(doc.usage.users, {
                total: 0,
                activeHalfyear: 0,
                activeMonth: 0,
                activeWeek: 0,
            });
        });

        it('leaves usage.users empty, rather than guessing, when it cannot be read', () => {
            const db = new Database(':memory:'); //  no tables
            const doc = nodeInfo2Doc(setup(db, 5));
            assert.deepEqual(doc.usage.users, {});
            assert.equal(doc.usage.localPosts, 11);
            assert.ok(validate10()(doc));

            const v20 = standardDoc(setup(db, 5), '2.0');
            assert.deepEqual(v20.usage.users, {});
            assert.ok(newValidator('nodeinfo-2.0.schema.json')(v20));
        });
    });
});
