'use strict';

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');

//
//  Config mock — before requiring stat_log.js, which captures sysDb at load.
//
const configModule = require('../core/config.js');
configModule.get = () => ({ debug: { assertsEnabled: false } });

const dbModule = require('../core/database.js');
dbModule.dbs.system = new Database(':memory:');

delete require.cache[require.resolve('../core/stat_log.js')];
const StatLog = require('../core/stat_log.js');

const UserProps = require('../core/user_property.js');
const { findPostAreasByUser, applyPostAreas } = require('../core/oputil/oputil_user.js');

// ─── live tracking: StatLog.recordUserPostAreaTag() ──────────────────────────

//  A user that keeps its properties in memory, as the real one does between
//  persists.
function makeUser(initialTags) {
    const props = {};
    if (undefined !== initialTags) {
        props[UserProps.MessagePostAreaTags] = initialTags;
    }
    const stats = [];
    return {
        props,
        stats,
        getProperty: name => props[name] || null,
        getPropertyAsNumber: name => Number(props[name]) || 0,
        persistProperty: (name, value, cb) => {
            props[name] = value;
            return cb ? cb(null) : undefined;
        },
    };
}

//  Capture what would be persisted as a stat, without the DB or event bus.
function withCapturedStats(user, fn) {
    const original = StatLog.setUserStat;
    StatLog.setUserStat = (u, statName, statValue, cb) => {
        u.props[statName] = `${statValue}`;
        user.stats.push({ statName, statValue });
        return cb ? cb(null) : undefined;
    };
    try {
        fn();
    } finally {
        StatLog.setUserStat = original;
    }
}

function post(user, ...areaTags) {
    withCapturedStats(user, () => {
        areaTags.forEach(t => StatLog.recordUserPostAreaTag(user, t));
    });
}

function tagsOf(user) {
    return JSON.parse(user.props[UserProps.MessagePostAreaTags] || '[]');
}

describe('StatLog.recordUserPostAreaTag()', () => {
    it('records the first area and counts it', () => {
        const user = makeUser();
        post(user, 'fsx_bbs');
        assert.deepEqual(tagsOf(user), ['fsx_bbs']);
        assert.deepEqual(user.stats, [
            { statName: UserProps.MessagePostAreaCount, statValue: 1 },
        ]);
    });

    it('counts distinct areas, not posts', () => {
        const user = makeUser();
        post(user, 'fsx_bbs', 'fsx_bbs', 'fsx_bbs');
        assert.deepEqual(tagsOf(user), ['fsx_bbs']);
        assert.equal(user.stats.length, 1, 'a repeat area must not touch the count');
    });

    it('advances the count as new areas appear', () => {
        const user = makeUser();
        post(user, 'one', 'two', 'one', 'three');
        assert.deepEqual(tagsOf(user), ['one', 'two', 'three']);
        assert.deepEqual(
            user.stats.map(s => s.statValue),
            [1, 2, 3]
        );
    });

    it('carries on from a set that is already stored', () => {
        const user = makeUser(JSON.stringify(['one', 'two']));
        post(user, 'three');
        assert.deepEqual(tagsOf(user), ['one', 'two', 'three']);
        assert.deepEqual(user.stats, [
            { statName: UserProps.MessagePostAreaCount, statValue: 3 },
        ]);
    });

    it('ignores private mail and the ActivityPub shared inbox', () => {
        const user = makeUser();
        post(user, 'private_mail', 'activitypub_shared');
        assert.deepEqual(tagsOf(user), []);
        assert.deepEqual(user.stats, [], 'neither is a place on the board');
    });

    it('ignores a missing area tag', () => {
        const user = makeUser();
        post(user, undefined, '');
        assert.deepEqual(tagsOf(user), []);
        assert.deepEqual(user.stats, []);
    });

    it('starts the set again if the stored value is unreadable', () => {
        const user = makeUser('{not json');
        post(user, 'one');
        assert.deepEqual(tagsOf(user), ['one']);
        assert.deepEqual(user.stats, [
            { statName: UserProps.MessagePostAreaCount, statValue: 1 },
        ]);
    });

    it('starts the set again if the stored value is not an array', () => {
        const user = makeUser(JSON.stringify({ one: true }));
        post(user, 'one');
        assert.deepEqual(tagsOf(user), ['one']);
    });
});

// ─── backfill: findPostAreasByUser() / applyPostAreas() ──────────────────────

function makeMsgDb() {
    const db = new Database(':memory:');
    db.exec(`
        CREATE TABLE message (
            message_id      INTEGER PRIMARY KEY,
            area_tag        VARCHAR NOT NULL,
            from_user_name  VARCHAR NOT NULL
        );
        CREATE TABLE message_meta (
            message_id      INTEGER NOT NULL,
            meta_category   VARCHAR NOT NULL,
            meta_name       VARCHAR NOT NULL,
            meta_value      VARCHAR NOT NULL
        );
    `);
    return db;
}

function makeUserDb() {
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
    `);
    return db;
}

let nextMsgId = 1;
function addMessage(msgDb, fromUserName, areaTag, { ftn = false } = {}) {
    const id = nextMsgId++;
    msgDb
        .prepare(
            'INSERT INTO message (message_id, area_tag, from_user_name) VALUES (?, ?, ?);'
        )
        .run(id, areaTag, fromUserName);
    if (ftn) {
        msgDb
            .prepare(
                `INSERT INTO message_meta (message_id, meta_category, meta_name, meta_value)
                VALUES (?, 'FtnProperty', 'ftn_origin', '* Origin: Somewhere Else');`
            )
            .run(id);
    }
}

function addUser(userDb, id, name) {
    userDb.prepare('INSERT INTO user (id, user_name) VALUES (?, ?);').run(id, name);
}

describe('oputil user backfill-post-areas', () => {
    it('collects the distinct areas a local user posted in', () => {
        const m = makeMsgDb();
        const u = makeUserDb();
        addUser(u, 1, 'localuser');
        addMessage(m, 'localuser', 'one');
        addMessage(m, 'localuser', 'one');
        addMessage(m, 'localuser', 'two');

        const rows = findPostAreasByUser(m, u);
        assert.equal(rows.length, 1);
        assert.deepEqual(rows[0].areaTags, ['one', 'two']);
    });

    it('does NOT credit echomail that arrived over FTN', () => {
        //  The remote poster's handle can collide with a local account name;
        //  ftn_origin is what separates what was typed here from what was
        //  imported. This is the case that makes a naive name match wrong.
        const m = makeMsgDb();
        const u = makeUserDb();
        addUser(u, 1, 'collision');
        addMessage(m, 'collision', 'remote_one', { ftn: true });
        addMessage(m, 'collision', 'remote_two', { ftn: true });
        addMessage(m, 'collision', 'local_one');

        const rows = findPostAreasByUser(m, u);
        assert.deepEqual(rows[0].areaTags, ['local_one']);
    });

    it('ignores a handle with no local account', () => {
        const m = makeMsgDb();
        const u = makeUserDb();
        addUser(u, 1, 'localuser');
        addMessage(m, 'somebody_else', 'one');

        assert.deepEqual(findPostAreasByUser(m, u), []);
    });

    it('ignores private mail and the ActivityPub shared inbox', () => {
        const m = makeMsgDb();
        const u = makeUserDb();
        addUser(u, 1, 'localuser');
        addMessage(m, 'localuser', 'private_mail');
        addMessage(m, 'localuser', 'activitypub_shared');

        assert.deepEqual(findPostAreasByUser(m, u), []);
    });

    it('merges with what is already recorded rather than replacing it', () => {
        const m = makeMsgDb();
        const u = makeUserDb();
        addUser(u, 1, 'localuser');
        u.prepare(
            'INSERT INTO user_property (user_id, prop_name, prop_value) VALUES (?, ?, ?);'
        ).run(1, UserProps.MessagePostAreaTags, JSON.stringify(['pruned_away']));
        addMessage(m, 'localuser', 'still_here');

        const rows = findPostAreasByUser(m, u);
        assert.deepEqual(rows[0].areaTags, ['pruned_away', 'still_here']);
        assert.equal(rows[0].was, 1);
    });

    it('reports nobody when the message base adds nothing new', () => {
        const m = makeMsgDb();
        const u = makeUserDb();
        addUser(u, 1, 'localuser');
        u.prepare(
            'INSERT INTO user_property (user_id, prop_name, prop_value) VALUES (?, ?, ?);'
        ).run(1, UserProps.MessagePostAreaTags, JSON.stringify(['one']));
        addMessage(m, 'localuser', 'one');

        assert.deepEqual(findPostAreasByUser(m, u), []);
    });

    it('writes both the set and the count, and settles on a second pass', () => {
        const m = makeMsgDb();
        const u = makeUserDb();
        addUser(u, 1, 'localuser');
        addMessage(m, 'localuser', 'one');
        addMessage(m, 'localuser', 'two');

        applyPostAreas(u, findPostAreasByUser(m, u));

        const props = u
            .prepare(
                `SELECT prop_name, prop_value FROM user_property
                WHERE user_id = 1 ORDER BY prop_name;`
            )
            .all();
        assert.deepEqual(props, [
            { prop_name: UserProps.MessagePostAreaCount, prop_value: '2' },
            {
                prop_name: UserProps.MessagePostAreaTags,
                prop_value: JSON.stringify(['one', 'two']),
            },
        ]);

        assert.deepEqual(findPostAreasByUser(m, u), [], 'must be idempotent');
    });
});
