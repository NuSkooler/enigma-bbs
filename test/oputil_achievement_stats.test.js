'use strict';

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');

const {
    findDriftedAchievementStats,
    applyAchievementStats,
} = require('../core/oputil/oputil_user.js');

function makeDb() {
    const db = new Database(':memory:');
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

        CREATE TABLE user_achievement (
            user_id         INTEGER NOT NULL,
            achievement_tag VARCHAR NOT NULL,
            timestamp       DATETIME NOT NULL,
            match           VARCHAR NOT NULL,
            title           VARCHAR NOT NULL,
            text            VARCHAR NOT NULL,
            points          INTEGER NOT NULL,
            UNIQUE(user_id, achievement_tag, match)
        );
    `);
    return db;
}

function addUser(db, id, name) {
    db.prepare('INSERT INTO user (id, user_name) VALUES (?, ?);').run(id, name);
}

function earn(db, userId, tag, match, points) {
    db.prepare(
        `INSERT INTO user_achievement
            (user_id, achievement_tag, timestamp, match, title, text, points)
        VALUES (?, ?, '2026-01-01T00:00:00.000-07:00', ?, 't', 'x', ?);`
    ).run(userId, tag, `${match}`, points);
}

function setTotals(db, userId, count, points) {
    const ins = db.prepare(
        'INSERT INTO user_property (user_id, prop_name, prop_value) VALUES (?, ?, ?);'
    );
    ins.run(userId, 'achievement_total_count', `${count}`);
    ins.run(userId, 'achievement_total_points', `${points}`);
}

function totalsOf(db, userId) {
    const rows = db
        .prepare(
            `SELECT prop_name, prop_value FROM user_property
            WHERE user_id = ? AND prop_name LIKE 'achievement_total%';`
        )
        .all(userId);
    return rows.reduce(
        (acc, r) => Object.assign(acc, { [r.prop_name]: r.prop_value }),
        {}
    );
}

describe('oputil user fix-achievement-stats', () => {
    it('reports totals inflated above what was actually earned', () => {
        const db = makeDb();
        addUser(db, 1, 'inflated');
        earn(db, 1, 'user_login_count', 10, 5);
        earn(db, 1, 'user_login_count', 100, 15);
        //  as if every crossing re-awarded the lower tier it already held
        setTotals(db, 1, 5, 45);

        const drifted = findDriftedAchievementStats(db);
        assert.equal(drifted.length, 1);
        assert.equal(drifted[0].user_name, 'inflated');
        assert.equal(drifted[0].stored_count, 5);
        assert.equal(drifted[0].actual_count, 2);
        assert.equal(drifted[0].stored_points, 45);
        assert.equal(drifted[0].actual_points, 20);
    });

    it('leaves users whose totals already match alone', () => {
        const db = makeDb();
        addUser(db, 1, 'correct');
        earn(db, 1, 'user_post_count', 5, 10);
        setTotals(db, 1, 1, 10);

        assert.deepEqual(findDriftedAchievementStats(db), []);
    });

    it('never touches users who have no totals recorded', () => {
        const db = makeDb();
        addUser(db, 1, 'never_earned');

        assert.deepEqual(findDriftedAchievementStats(db), []);
        assert.deepEqual(totalsOf(db, 1), {});
    });

    it('zeroes totals for a user whose achievements were all removed', () => {
        const db = makeDb();
        addUser(db, 1, 'wiped');
        setTotals(db, 1, 3, 30);

        const drifted = findDriftedAchievementStats(db);
        assert.equal(drifted.length, 1);
        assert.equal(drifted[0].actual_count, 0);
        assert.equal(drifted[0].actual_points, 0);

        applyAchievementStats(db, drifted);
        assert.deepEqual(totalsOf(db, 1), {
            achievement_total_count: '0',
            achievement_total_points: '0',
        });
    });

    it('writes the recomputed totals back and settles on a second pass', () => {
        const db = makeDb();
        addUser(db, 1, 'inflated');
        addUser(db, 2, 'correct');
        earn(db, 1, 'user_login_count', 10, 5);
        earn(db, 1, 'user_login_count', 100, 15);
        earn(db, 2, 'user_post_count', 5, 10);
        setTotals(db, 1, 5, 45);
        setTotals(db, 2, 1, 10);

        applyAchievementStats(db, findDriftedAchievementStats(db));

        assert.deepEqual(totalsOf(db, 1), {
            achievement_total_count: '2',
            achievement_total_points: '20',
        });
        //  untouched
        assert.deepEqual(totalsOf(db, 2), {
            achievement_total_count: '1',
            achievement_total_points: '10',
        });
        //  idempotent
        assert.deepEqual(findDriftedAchievementStats(db), []);
    });

    it('orders the report by how much the points total was inflated', () => {
        const db = makeDb();
        addUser(db, 1, 'small_drift');
        addUser(db, 2, 'big_drift');
        earn(db, 1, 'user_login_count', 10, 5);
        earn(db, 2, 'user_login_count', 10, 5);
        setTotals(db, 1, 2, 10);
        setTotals(db, 2, 9, 200);

        const drifted = findDriftedAchievementStats(db);
        assert.deepEqual(
            drifted.map(r => r.user_name),
            ['big_drift', 'small_drift']
        );
    });
});
