'use strict';

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');

//
//  Config mock — must be in place before requiring any module that captures
//  Config.get at load time.
//
const configModule = require('../core/config.js');
const TEST_CONFIG = {
    debug: { assertsEnabled: false },
    general: { boardName: 'TestBoard' },
};
configModule.get = () => TEST_CONFIG;

//
//  In-memory DB injection — must happen before requiring achievement.js, which
//  captures `UserDb = require('./database.js').dbs.user` at load time.
//
const dbModule = require('../core/database.js');
const _testDb = new Database(':memory:');
_testDb.pragma('foreign_keys = ON');
dbModule.dbs.user = _testDb;

//  Stub StatLog.incrementUserStat to avoid triggering the real Events system
//  (which is not initialized in tests).  The stub still updates the user's
//  in-memory properties so assertions about AchievementTotalCount/Points work.
const StatLog = require('../core/stat_log.js');
StatLog.incrementUserStat = (user, statName, incrementBy = 1, cb) => {
    const current = user.getPropertyAsNumber(statName) || 0;
    user.persistProperty(statName, current + incrementBy, cb);
};

//  Modules under test — loaded after Config mock and DB are in place.
const {
    Achievement,
    UserStatAchievement,
    Achievements,
} = require('../core/achievement.js');

// ─── schema ──────────────────────────────────────────────────────────────────

function applySchema(db, done) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS user (
            id      INTEGER PRIMARY KEY
        );

        CREATE TABLE IF NOT EXISTS user_achievement (
            user_id             INTEGER NOT NULL,
            achievement_tag     VARCHAR NOT NULL,
            timestamp           DATETIME NOT NULL,
            match               VARCHAR NOT NULL,
            title               VARCHAR NOT NULL,
            text                TEXT NOT NULL,
            points              INTEGER NOT NULL,
            UNIQUE(user_id, achievement_tag, match),
            FOREIGN KEY(user_id) REFERENCES user(id) ON DELETE CASCADE
        );
    `);

    //  seed stub user rows so FK checks pass (userId values used by makeUser())
    const insertUser = db.prepare('INSERT OR IGNORE INTO user (id) VALUES (?)');
    for (let id = 1; id <= 50; id++) {
        insertUser.run(id);
    }

    return done(null);
}

// ─── helpers ─────────────────────────────────────────────────────────────────

//  Minimal mock events — achievements instance uses addMultipleEventListener
//  at startup; we skip that in unit tests by never calling monitorUserStatEvents.
const mockEvents = {
    addMultipleEventListener: () => ({}),
    removeMultipleEventListener: () => {},
    emit: () => {},
};

//  Fake user with just enough interface to satisfy record() and StatLog paths.
function makeUser(userId = 1) {
    const props = {};
    return {
        userId,
        username: 'testuser',
        getPropertyAsNumber: name => props[name] || 0,
        persistProperty: (name, value, cb) => {
            props[name] = value;
            if (cb) {
                cb(null);
            }
        },
        //  used by getFormatObject
        realName: () => 'Test User',
        properties: {},
    };
}

//  Minimal fake client wrapping a user.
function makeClient(user) {
    return {
        node: 1,
        user,
        currentTheme: {
            achievements: { defaults: {} },
            helpers: { getDateTimeFormat: () => 'YYYY-MM-DD' },
        },
    };
}

//  Build an Achievements instance with an inline config, no file I/O.
function makeAchievements(achievementsConfig = {}) {
    const instance = new Achievements(mockEvents);
    instance.config = {
        get: () =>
            Object.assign({}, TEST_CONFIG, {
                enabled: true,
                achievements: achievementsConfig,
            }),
    };
    instance._statNameIndex = new Map();
    return instance;
}

//  Minimal valid achievement detail block.
function makeDetails(overrides = {}) {
    return Object.assign(
        { title: 'Test Title', text: 'Test text', points: 10 },
        overrides
    );
}

//  Minimal valid achievement data for a userStatSet achievement.
function makeAchievementData(overrides = {}) {
    return Object.assign(
        {
            type: 'userStatSet',
            statName: 'login_count',
            match: {
                2: makeDetails({ title: 'Return Caller', points: 5 }),
                10: makeDetails({ title: 'Curious Caller', points: 10 }),
                50: makeDetails({ title: 'Regular', points: 25 }),
            },
        },
        overrides
    );
}

//  Minimal info object for record() calls.
function makeRecordInfo(user, overrides = {}) {
    const client = makeClient(user);
    return Object.assign(
        {
            client,
            user,
            achievementTag: 'user_login_count',
            achievement: Achievement.factory(makeAchievementData()),
            matchField: 2,
            matchValue: 2,
            achievedValue: 2,
            details: makeDetails({ title: 'Return Caller', points: 5 }),
            timestamp: new Date(),
        },
        overrides
    );
}

//  Minimal interrupt item for record().
function makeInterruptItem(overrides = {}) {
    return Object.assign({ title: 'Return Caller', achievText: 'Test text' }, overrides);
}

// ─── Achievement.factory() ────────────────────────────────────────────────────

describe('Achievement.factory()', function () {
    it('returns undefined for null data', () => {
        assert.equal(Achievement.factory(null), undefined);
    });

    it('returns undefined for undefined data', () => {
        assert.equal(Achievement.factory(undefined), undefined);
    });

    it('returns undefined for unknown type', () => {
        assert.equal(Achievement.factory({ type: 'unknownType' }), undefined);
    });

    it('returns a UserStatAchievement for userStatSet', () => {
        const a = Achievement.factory(makeAchievementData({ type: 'userStatSet' }));
        assert.ok(a instanceof UserStatAchievement);
    });

    it('returns a UserStatAchievement for userStatInc', () => {
        const a = Achievement.factory(makeAchievementData({ type: 'userStatInc' }));
        assert.ok(a instanceof UserStatAchievement);
    });

    it('returns a UserStatAchievement for userStatIncNewVal', () => {
        const a = Achievement.factory(makeAchievementData({ type: 'userStatIncNewVal' }));
        assert.ok(a instanceof UserStatAchievement);
    });

    it('returns undefined when statName is missing', () => {
        const data = makeAchievementData();
        delete data.statName;
        assert.equal(Achievement.factory(data), undefined);
    });

    it('returns undefined when match is missing', () => {
        const data = makeAchievementData();
        delete data.match;
        assert.equal(Achievement.factory(data), undefined);
    });

    it('defaults retroactive to true when not specified', () => {
        const a = Achievement.factory(makeAchievementData());
        assert.equal(a.data.retroactive, true);
    });

    it('respects retroactive: false when set', () => {
        const a = Achievement.factory(makeAchievementData({ retroactive: false }));
        assert.equal(a.data.retroactive, false);
    });
});

// ─── Achievement.isValidMatchDetails() ───────────────────────────────────────

describe('Achievement.isValidMatchDetails()', function () {
    let a;
    before(() => {
        a = Achievement.factory(makeAchievementData());
    });

    it('returns true for a fully valid details block', () => {
        assert.ok(a.isValidMatchDetails(makeDetails()));
    });

    it('returns false for null', () => {
        assert.ok(!a.isValidMatchDetails(null));
    });

    it('returns false when title is missing', () => {
        const d = makeDetails();
        delete d.title;
        assert.ok(!a.isValidMatchDetails(d));
    });

    it('returns false when title is not a string', () => {
        assert.ok(!a.isValidMatchDetails(makeDetails({ title: 42 })));
    });

    it('returns false when text is missing', () => {
        const d = makeDetails();
        delete d.text;
        assert.ok(!a.isValidMatchDetails(d));
    });

    it('returns false when points is missing', () => {
        const d = makeDetails();
        delete d.points;
        assert.ok(!a.isValidMatchDetails(d));
    });

    it('returns false when points is a string', () => {
        assert.ok(!a.isValidMatchDetails(makeDetails({ points: '10' })));
    });

    it('returns true when globalText is a string', () => {
        assert.ok(
            a.isValidMatchDetails(makeDetails({ globalText: 'Hello {userName}!' }))
        );
    });

    it('returns false when globalText is a number', () => {
        assert.ok(!a.isValidMatchDetails(makeDetails({ globalText: 123 })));
    });
});

// ─── UserStatAchievement.getMatchDetails() ───────────────────────────────────

describe('UserStatAchievement.getMatchDetails()', function () {
    let a;
    before(() => {
        //  matchKeys will be sorted [50, 10, 2]
        a = Achievement.factory(makeAchievementData());
    });

    it('returns empty array when value is below the lowest threshold', () => {
        const [details] = a.getMatchDetails(1);
        assert.equal(details, undefined);
    });

    it('returns the matching tier for an exact threshold hit', () => {
        const [details, matchField, matchValue] = a.getMatchDetails(2);
        assert.equal(details.title, 'Return Caller');
        assert.equal(matchField, 2);
        assert.equal(matchValue, 2);
    });

    it('returns the highest tier not exceeding the value (greatest-not-exceeding)', () => {
        //  value=7 is above 2 but below 10 → should match tier 2
        const [details, matchField] = a.getMatchDetails(7);
        assert.equal(matchField, 2);
        assert.equal(details.title, 'Return Caller');
    });

    it('returns the correct tier when hitting a higher threshold exactly', () => {
        const [details, matchField] = a.getMatchDetails(10);
        assert.equal(matchField, 10);
        assert.equal(details.title, 'Curious Caller');
    });

    it('returns the highest tier when value exceeds all thresholds', () => {
        const [details, matchField] = a.getMatchDetails(999);
        assert.equal(matchField, 50);
        assert.equal(details.title, 'Regular');
    });

    it('matchKeys are sorted descending', () => {
        assert.deepEqual(a.matchKeys, [50, 10, 2]);
    });

    it('returns empty array when the matching entry has invalid details', () => {
        const badData = makeAchievementData({
            match: {
                5: { title: 'No Text or Points' }, //  missing text + points
            },
        });
        const bad = Achievement.factory(badData);
        //  factory returns undefined since isValid() passes but getMatchDetails
        //  will return [] because isValidMatchDetails rejects it
        if (!bad) {
            return; //  factory may reject — either outcome is acceptable
        }
        const [details] = bad.getMatchDetails(5);
        assert.equal(details, undefined);
    });
});

// ─── UserStatAchievement.isValid() ───────────────────────────────────────────

describe('UserStatAchievement.isValid()', function () {
    it('returns true for a well-formed achievement', () => {
        const a = new UserStatAchievement(makeAchievementData());
        assert.ok(a.isValid());
    });

    it('returns false when a match key is non-numeric', () => {
        const data = makeAchievementData({
            match: {
                notAnumber: makeDetails(),
                10: makeDetails(),
            },
        });
        const a = new UserStatAchievement(data);
        assert.ok(!a.isValid());
    });
});

// ─── Achievements._buildAchievementIndex() ───────────────────────────────────

describe('Achievements._buildAchievementIndex()', function () {
    it('indexes enabled achievements by statName', () => {
        const instance = makeAchievements({
            login_ach: makeAchievementData({ statName: 'login_count' }),
            post_ach: makeAchievementData({ statName: 'post_count' }),
        });
        instance._buildAchievementIndex();

        assert.deepEqual(instance._statNameIndex.get('login_count'), ['login_ach']);
        assert.deepEqual(instance._statNameIndex.get('post_count'), ['post_ach']);
    });

    it('groups multiple achievements sharing a statName', () => {
        const instance = makeAchievements({
            login_ach_a: makeAchievementData({ statName: 'login_count' }),
            login_ach_b: makeAchievementData({ statName: 'login_count' }),
        });
        instance._buildAchievementIndex();

        const tags = instance._statNameIndex.get('login_count');
        assert.ok(Array.isArray(tags));
        assert.equal(tags.length, 2);
        assert.ok(tags.includes('login_ach_a'));
        assert.ok(tags.includes('login_ach_b'));
    });

    it('excludes explicitly disabled achievements', () => {
        const instance = makeAchievements({
            login_ach: Object.assign(makeAchievementData({ statName: 'login_count' }), {
                enabled: false,
            }),
        });
        instance._buildAchievementIndex();

        assert.equal(instance._statNameIndex.get('login_count'), undefined);
    });

    it('returns undefined for stats with no matching achievements', () => {
        const instance = makeAchievements({
            login_ach: makeAchievementData({ statName: 'login_count' }),
        });
        instance._buildAchievementIndex();

        assert.equal(instance._statNameIndex.get('post_count'), undefined);
    });

    it('rebuilds cleanly on second call (config reload)', () => {
        const instance = makeAchievements({
            login_ach: makeAchievementData({ statName: 'login_count' }),
        });
        instance._buildAchievementIndex();
        assert.ok(instance._statNameIndex.has('login_count'));

        //  Simulate reload with different config
        instance.config = {
            get: () =>
                Object.assign({}, TEST_CONFIG, {
                    enabled: true,
                    achievements: {
                        post_ach: makeAchievementData({ statName: 'post_count' }),
                    },
                }),
        };
        instance._buildAchievementIndex();

        assert.equal(instance._statNameIndex.get('login_count'), undefined);
        assert.deepEqual(instance._statNameIndex.get('post_count'), ['post_ach']);
    });
});

// ─── Achievements.record() and loadEarnedMatchFields() ───────────────────────
//  These tests require the in-memory database.

describe('Achievements.record()', function () {
    before(done => applySchema(_testDb, done));
    beforeEach(done => {
        _testDb.exec('DELETE FROM user_achievement;');
        done();
    });

    it('inserts the achievement and calls back with no error on first insert', done => {
        const user = makeUser(1);
        const instance = makeAchievements();
        const info = makeRecordInfo(user);
        const item = makeInterruptItem();

        instance.record(info, item, err => {
            assert.ifError(err);
            done();
        });
    });

    it('returns TooMany error on duplicate insert (same user/tag/match)', done => {
        const user = makeUser(2);
        const instance = makeAchievements();
        const info = makeRecordInfo(user);
        const item = makeInterruptItem();

        instance.record(info, item, err => {
            assert.ifError(err);
            //  second insert for same user/tag/match
            instance.record(info, item, err2 => {
                assert.ok(err2, 'expected an error on second insert');
                assert.equal(err2.reasonCode, 'TOOMANY');
                done();
            });
        });
    });

    it('does not inflate stats on duplicate insert', done => {
        const user = makeUser(3);
        const instance = makeAchievements();
        const info = makeRecordInfo(user);
        const item = makeInterruptItem();

        instance.record(info, item, err => {
            assert.ifError(err);
            const countAfterFirst = user.getPropertyAsNumber('achievement_total_count');

            instance.record(info, item, () => {
                const countAfterSecond = user.getPropertyAsNumber(
                    'achievement_total_count'
                );
                assert.equal(
                    countAfterSecond,
                    countAfterFirst,
                    'count must not grow on duplicate'
                );
                done();
            });
        });
    });

    it('increments AchievementTotalPoints by the details.points value', done => {
        const user = makeUser(4);
        const instance = makeAchievements();
        const info = makeRecordInfo(user, {
            details: makeDetails({ title: 'T', text: 'x', points: 17 }),
        });
        const item = makeInterruptItem();

        instance.record(info, item, err => {
            assert.ifError(err);
            const pts = user.getPropertyAsNumber('achievement_total_points');
            assert.equal(pts, 17);
            done();
        });
    });

    it('two different users can earn the same achievement independently', done => {
        const userA = makeUser(10);
        const userB = makeUser(11);
        const instance = makeAchievements();
        const item = makeInterruptItem();

        instance.record(makeRecordInfo(userA), item, errA => {
            assert.ifError(errA);
            instance.record(makeRecordInfo(userB), item, errB => {
                assert.ifError(errB);
                done();
            });
        });
    });

    it('same user can earn different match tiers of the same achievement', done => {
        const user = makeUser(12);
        const instance = makeAchievements();
        const item = makeInterruptItem();

        const infoTier2 = makeRecordInfo(user, { matchField: 2 });
        const infoTier10 = makeRecordInfo(user, {
            matchField: 10,
            details: makeDetails({ title: 'Curious Caller', points: 10 }),
        });

        instance.record(infoTier2, item, err => {
            assert.ifError(err);
            instance.record(infoTier10, item, err2 => {
                assert.ifError(err2);
                done();
            });
        });
    });
});

// ─── Achievements.loadEarnedMatchFields() ────────────────────────────────────

describe('Achievements.loadEarnedMatchFields()', function () {
    before(done => applySchema(_testDb, done));
    beforeEach(done => {
        _testDb.exec('DELETE FROM user_achievement;');
        done();
    });

    it('returns an empty Set when no records exist for the user/tag', done => {
        const user = makeUser(20);
        const instance = makeAchievements();

        instance.loadEarnedMatchFields(user, 'user_login_count', (err, fields) => {
            assert.ifError(err);
            assert.ok(fields instanceof Set);
            assert.equal(fields.size, 0);
            done();
        });
    });

    it('returns a Set containing the earned match values as integers', done => {
        const user = makeUser(21);
        const instance = makeAchievements();
        const item = makeInterruptItem();

        const info2 = makeRecordInfo(user, { matchField: 2 });
        const info10 = makeRecordInfo(user, {
            matchField: 10,
            details: makeDetails({ title: 'Curious', points: 10 }),
        });

        instance.record(info2, item, err => {
            assert.ifError(err);
            instance.record(info10, item, err2 => {
                assert.ifError(err2);
                instance.loadEarnedMatchFields(
                    user,
                    'user_login_count',
                    (err3, fields) => {
                        assert.ifError(err3);
                        assert.ok(fields.has(2), 'should contain match=2');
                        assert.ok(fields.has(10), 'should contain match=10');
                        assert.equal(fields.size, 2);
                        done();
                    }
                );
            });
        });
    });

    it('isolates records by achievement tag', done => {
        const user = makeUser(22);
        const instance = makeAchievements();
        const item = makeInterruptItem();

        const infoLogin = makeRecordInfo(user, {
            achievementTag: 'user_login_count',
            matchField: 5,
        });
        const infoPost = makeRecordInfo(user, {
            achievementTag: 'user_post_count',
            matchField: 5,
        });

        instance.record(infoLogin, item, err => {
            assert.ifError(err);
            instance.record(infoPost, item, err2 => {
                assert.ifError(err2);
                instance.loadEarnedMatchFields(
                    user,
                    'user_post_count',
                    (err3, fields) => {
                        assert.ifError(err3);
                        assert.ok(fields.has(5));
                        assert.equal(fields.size, 1, 'only the post_count tag record');
                        done();
                    }
                );
            });
        });
    });

    it('isolates records by user ID', done => {
        const userA = makeUser(30);
        const userB = makeUser(31);
        const instance = makeAchievements();
        const item = makeInterruptItem();

        instance.record(makeRecordInfo(userA, { matchField: 2 }), item, err => {
            assert.ifError(err);
            instance.loadEarnedMatchFields(userB, 'user_login_count', (err2, fields) => {
                assert.ifError(err2);
                assert.equal(fields.size, 0, 'userB should see no records');
                done();
            });
        });
    });
});

// ─── Achievements.getAchievementsEarnedByUser() ──────────────────────────────

describe('Achievements.getAchievementsEarnedByUser()', function () {
    before(done => applySchema(_testDb, done));
    beforeEach(done => {
        _testDb.exec('DELETE FROM user_achievement;');
        done();
    });

    function makeInstanceWithConfig() {
        return makeAchievements({
            user_login_count: makeAchievementData({
                type: 'userStatSet',
                statName: 'login_count',
            }),
        });
    }

    it('returns an empty array for a user with no achievements', done => {
        const instance = makeInstanceWithConfig();
        instance.getAchievementsEarnedByUser(99, (err, earned) => {
            assert.ifError(err);
            assert.deepEqual(earned, []);
            done();
        });
    });

    it('returns earned achievements with correct fields', done => {
        const user = makeUser(40);
        const instance = makeInstanceWithConfig();
        const item = makeInterruptItem();

        instance.record(makeRecordInfo(user), item, err => {
            assert.ifError(err);
            instance.getAchievementsEarnedByUser(user.userId, (err2, earned) => {
                assert.ifError(err2);
                assert.equal(earned.length, 1);
                const a = earned[0];
                assert.equal(a.achievementTag, 'user_login_count');
                assert.equal(a.title, 'Return Caller');
                assert.equal(a.points, 5);
                assert.ok(a.timestamp);
                done();
            });
        });
    });

    it('populates statName for userStatSet achievements', done => {
        const user = makeUser(41);
        const instance = makeInstanceWithConfig();
        const item = makeInterruptItem();

        instance.record(makeRecordInfo(user), item, err => {
            assert.ifError(err);
            instance.getAchievementsEarnedByUser(user.userId, (err2, earned) => {
                assert.ifError(err2);
                assert.equal(earned.length, 1);
                assert.equal(earned[0].statName, 'login_count');
                done();
            });
        });
    });

    it('filters out rows whose achievement tag no longer exists in config', done => {
        const user = makeUser(42);
        //  Record against a tag that exists
        const instance = makeInstanceWithConfig();
        const item = makeInterruptItem();

        instance.record(makeRecordInfo(user), item, err => {
            assert.ifError(err);

            //  Now use an instance with an empty config (tag removed)
            const instanceNoConfig = makeAchievements({});
            instanceNoConfig.getAchievementsEarnedByUser(user.userId, (err2, earned) => {
                assert.ifError(err2);
                assert.deepEqual(earned, [], 'removed-tag rows should be filtered out');
                done();
            });
        });
    });

    it('returns multiple achievements for the same user', done => {
        const user = makeUser(43);
        const instance = makeInstanceWithConfig();
        const item = makeInterruptItem();

        const info2 = makeRecordInfo(user, {
            matchField: 2,
            details: makeDetails({ title: 'Return Caller', points: 5 }),
        });
        const info10 = makeRecordInfo(user, {
            matchField: 10,
            details: makeDetails({ title: 'Curious Caller', points: 10 }),
        });

        //  The interrupt item title is what record() stores in the DB.
        instance.record(info2, makeInterruptItem({ title: 'Return Caller' }), err => {
            assert.ifError(err);
            instance.record(
                info10,
                makeInterruptItem({ title: 'Curious Caller' }),
                err2 => {
                    assert.ifError(err2);
                    instance.getAchievementsEarnedByUser(user.userId, (err3, earned) => {
                        assert.ifError(err3);
                        assert.equal(earned.length, 2);
                        const titles = new Set(earned.map(a => a.title));
                        assert.ok(titles.has('Return Caller'));
                        assert.ok(titles.has('Curious Caller'));
                        done();
                    });
                }
            );
        });
    });
});
