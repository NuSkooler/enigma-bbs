'use strict';

//
//  getMessageAreaStats() and markMessageAreaRead() (#447).
//
//  The stats answer every area in one statement. Their "new" has to be the
//  one msg_list and new_scan already use -- anything after
//  getEffectiveNewScanLastReadId() -- or an index reader would show counts the
//  reader then disagrees with. So most of what is here builds awkward message
//  bases and checks the one statement against the per-area functions it
//  replaces, area by area.
//

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');
const moment = require('moment');

const configModule = require('../core/config.js');
const { WellKnownConfTags } = require('../core/message_const.js');

const TestConfig = {
    debug: { assertsEnabled: false },
    menus: { cls: false },
    general: { boardName: 'Test Board' },
    messageNetworks: {},
    messageConferences: {
        [WellKnownConfTags.SystemInternal]: {
            name: 'System Internal',
            areas: { private_mail: { name: 'Private Mail' } },
        },
        local: {
            name: 'Local',
            areas: {
                general: { name: 'General' },
                fido_tech: { name: 'FidoNet Tech' },
                old_only: { name: 'Old Only' },
                boundary: { name: 'Boundary' },
                empty_area: { name: 'Empty' },
                MixedCase: { name: 'Mixed Case' },
            },
        },
    },
};

//  message.js and message_area.js capture the message base at load
const FreshModules = ['../core/message.js', '../core/message_area.js'].map(m =>
    require.resolve(m)
);

const UserId = 1;
const OtherUserId = 2;
const Private = 'private_mail';

const Floor = '2026-09-10T00:00:00.000Z';

const ts = date => moment.parseZone(date).format('YYYY-MM-DDTHH:mm:ss.SSSZ');

describe('message area stats (#447)', function () {
    let testDb;
    let prevMessageDb;
    let prevConfig;
    let savedModules;

    let MessageArea;
    let Message;

    before(() => {
        prevConfig = configModule._pushTestConfig(TestConfig);

        const dbModule = require('../core/database.js');
        prevMessageDb = dbModule.dbs.message;
        testDb = new Database(':memory:');
        testDb.pragma('foreign_keys = ON');
        //  the real schema, index and all
        dbModule.initMessageDatabase(testDb);
        dbModule.dbs.message = testDb;

        savedModules = FreshModules.map(path => [path, require.cache[path]]);
        FreshModules.forEach(path => delete require.cache[path]);

        Message = require('../core/message.js');
        MessageArea = require('../core/message_area.js');
    });

    after(() => {
        savedModules.forEach(([path, cached]) => {
            if (cached) {
                require.cache[path] = cached;
            } else {
                delete require.cache[path];
            }
        });

        require('../core/database.js').dbs.message = prevMessageDb;
        testDb.close();
        configModule._popTestConfig(prevConfig);
    });

    beforeEach(() => {
        testDb.exec('DELETE FROM message_meta;');
        testDb.exec('DELETE FROM message;');
        testDb.exec('DELETE FROM user_message_area_last_read;');
    });

    //  an explicit ID, since IDs out of date order are the point
    function addMessage(messageId, areaTag, date, { to = 'All', toUserId } = {}) {
        testDb
            .prepare(
                `INSERT INTO message (message_id, area_tag, message_uuid, to_user_name,
                    from_user_name, subject, message, modified_timestamp)
                VALUES (?, ?, ?, ?, 'Someone', ?, 'body', ?);`
            )
            .run(
                messageId,
                areaTag,
                `stats-447-${messageId}`,
                to,
                `Message ${messageId}`,
                ts(date)
            );

        if (toUserId) {
            testDb
                .prepare(
                    `INSERT INTO message_meta VALUES (?, 'System', 'local_to_user_id', ?);`
                )
                .run(messageId, String(toUserId));
        }
    }

    //  as stored, case and all: the pointer table is read in lower case
    function setLastRead(areaTag, messageId, userId = UserId) {
        testDb
            .prepare('REPLACE INTO user_message_area_last_read VALUES (?, ?, ?);')
            .run(userId, areaTag, messageId);
    }

    function lastRead(areaTag, userId = UserId) {
        const row = testDb
            .prepare(
                'SELECT message_id FROM user_message_area_last_read ' +
                    'WHERE user_id = ? AND area_tag = ?;'
            )
            .get(userId, areaTag);
        return row ? row.message_id : 0;
    }

    function makeUser(properties = {}, { userId = UserId, username = 'anne' } = {}) {
        return {
            userId,
            username,
            getProperty: name => properties[name],
        };
    }

    const stats = (user, tags) =>
        new Promise((resolve, reject) =>
            MessageArea.getMessageAreaStats(user, tags, (err, result) =>
                err ? reject(err) : resolve(result)
            )
        );

    const find = filter =>
        new Promise((resolve, reject) =>
            Message.findMessages(filter, (err, result) =>
                err ? reject(err) : resolve(result)
            )
        );

    //
    //  The same numbers from the per-area functions: the effective pointer,
    //  then findMessages() counts from it -- the list msg_list builds and
    //  marks new.
    //
    async function perAreaStats(user, areaTag) {
        const startId = await new Promise((resolve, reject) =>
            MessageArea.getEffectiveNewScanLastReadId(user, areaTag, (err, id) =>
                err ? reject(err) : resolve(id)
            )
        );

        const isPrivate = Message.isPrivateAreaTag(areaTag);
        const scope = () => (isPrivate ? { privateTagUserId: user.userId } : { areaTag });

        const total = await find({ ...scope(), resultType: 'count' });
        const newCount = await find({
            ...scope(),
            newerThanMessageId: startId,
            resultType: 'count',
        });

        //  getNewMessageCountInAreaForUser()'s addrToOnly, from the effective
        //  pointer
        const yours = isPrivate
            ? newCount
            : await find({
                  areaTag,
                  newerThanMessageId: startId,
                  toUserName: user.username,
                  resultType: 'count',
              });

        let lastPostId;
        if (isPrivate) {
            const ids = await find({
                ...scope(),
                sort: 'messageId',
                order: 'descending',
                limit: 1,
            });
            lastPostId = ids[0] || 0;
        } else {
            lastPostId = await new Promise((resolve, reject) =>
                MessageArea.getHighestMessageIdByArea(areaTag, (err, id) =>
                    err ? reject(err) : resolve(id)
                )
            );
        }

        const row = lastPostId
            ? testDb
                  .prepare('SELECT modified_timestamp FROM message WHERE message_id = ?;')
                  .get(lastPostId)
            : null;

        return {
            total,
            newCount,
            yours,
            lastPostId,
            lastPostTs: row ? row.modified_timestamp : null,
        };
    }

    async function assertMatchesPerArea(user, tags, label) {
        const actual = await stats(user, tags);
        assert.deepEqual(
            Object.keys(actual).sort(),
            [...new Set(tags)].sort(),
            `${label}: one entry per tag`
        );
        for (const tag of tags) {
            const expected = await perAreaStats(user, tag);
            assert.deepEqual(actual[tag], expected, `${label}: ${tag}`);
        }
        return actual;
    }

    //
    //  A message base with the awkward cases in it:
    //
    //   general     in date order, straddling the floor, to the caller by name
    //               in several cases, and a name LIKE would match loosely
    //   fido_tech   FTN imports: old-dated messages arriving after newer ones,
    //               a non-UTC offset, and messages on the floor's +1 second
    //               boundary
    //   old_only    everything before the floor
    //   boundary    the floor's own second and the one after, which are not
    //               after it, deciding the pointer
    //   empty_area  nothing at all
    //   MixedCase   stored in mixed case; its pointer is stored lower case
    //   private     mail to the caller and to someone else, either side of
    //               the floor
    //
    function seedAwkwardBase() {
        addMessage(1, 'general', '2026-09-01T00:00:00Z', { to: 'anne' });
        addMessage(2, 'general', '2026-09-05T00:00:00Z');
        addMessage(3, 'general', '2026-09-11T00:00:00Z', { to: 'Anne' });
        addMessage(4, 'general', '2026-09-12T00:00:00Z', { to: 'ANNE' });
        addMessage(5, 'general', '2026-09-13T00:00:00Z', { to: 'annette' });
        addMessage(6, 'general', '2026-09-14T00:00:00Z', { to: 'Bob' });

        addMessage(9, 'fido_tech', '2026-08-15T00:00:00Z');
        addMessage(10, 'fido_tech', '2026-09-20T00:00:00Z');
        addMessage(11, 'fido_tech', '2026-09-21T00:00:00Z', { to: 'anne' });
        //  a late import, dated before the floor
        addMessage(12, 'fido_tech', '2026-08-01T00:00:00Z', { to: 'anne' });
        //  dated after the floor, arrived after a newer one
        addMessage(13, 'fido_tech', '2026-09-15T00:00:00Z');
        //  09-09T18:00-06:00 = 09-10T00:00Z: on the floor, not after it
        addMessage(14, 'fido_tech', '2026-09-09T18:00:00-06:00');
        //  the floor plus one second: still not "after" it
        addMessage(15, 'fido_tech', '2026-09-10T00:00:01Z');
        //  plus two: after it
        addMessage(16, 'fido_tech', '2026-09-10T00:00:02Z', { to: 'anne' });

        //  the floor's own second and the next are not after it; the first
        //  message that is decides the pointer
        addMessage(25, 'boundary', '2026-09-09T18:00:00-06:00');
        addMessage(26, 'boundary', '2026-09-10T00:00:01Z');
        addMessage(27, 'boundary', '2026-09-10T00:00:02Z', { to: 'anne' });
        addMessage(28, 'boundary', '2026-09-01T00:00:00Z');

        addMessage(20, 'old_only', '2026-08-01T00:00:00Z', { to: 'anne' });
        addMessage(21, 'old_only', '2026-08-02T00:00:00Z');

        addMessage(30, 'MixedCase', '2026-09-01T00:00:00Z');
        addMessage(31, 'MixedCase', '2026-09-20T00:00:00Z', { to: 'anne' });
        addMessage(32, 'MixedCase', '2026-09-21T00:00:00Z');

        addMessage(40, Private, '2026-09-01T00:00:00Z', { toUserId: UserId });
        addMessage(41, Private, '2026-09-02T00:00:00Z', { toUserId: OtherUserId });
        addMessage(42, Private, '2026-09-20T00:00:00Z', { toUserId: UserId });
        addMessage(43, Private, '2026-09-21T00:00:00Z', { toUserId: OtherUserId });
        //  someone else's mail is the area's newest
        addMessage(44, Private, '2026-09-22T00:00:00Z', { toUserId: OtherUserId });
    }

    const AllTags = [
        'general',
        'fido_tech',
        'old_only',
        'boundary',
        'empty_area',
        'MixedCase',
        //  not how it is stored: matches no messages, but finds the pointer
        'mixedcase',
        Private,
        //  private mail in any case is private mail
        'PRIVATE_MAIL',
        'no_such_area',
    ];

    const Floors = {
        'no floor': {},
        'a floor': { newscan_min_timestamp: Floor },
        'a floor in another offset': {
            newscan_min_timestamp: '2026-09-09T18:00:00.000-06:00',
        },
        'an invalid floor': { newscan_min_timestamp: 'not a date' },
        'an empty floor': { newscan_min_timestamp: '' },
        'a floor after everything': { newscan_min_timestamp: '2027-01-01T00:00:00Z' },
        'a floor before everything': { newscan_min_timestamp: '2020-01-01T00:00:00Z' },
    };

    const Pointers = {
        'no pointers': () => {},
        'pointers below the floor': () => {
            setLastRead('general', 1);
            setLastRead('fido_tech', 5);
            setLastRead('old_only', 20);
            setLastRead('mixedcase', 29);
            setLastRead(Private, 40);
        },
        'pointers above the floor': () => {
            setLastRead('general', 4);
            setLastRead('fido_tech', 14);
            setLastRead('old_only', 21);
            setLastRead('mixedcase', 31);
            setLastRead(Private, 42);
        },
        'pointers past the end': () => {
            setLastRead('general', 100);
            setLastRead('fido_tech', 100);
            setLastRead('empty_area', 100);
            setLastRead(Private, 100);
        },
        //  updateMessageAreaLastReadId() never writes these; they are not read
        'pointers stored in mixed case': () => {
            setLastRead('MixedCase', 32);
            setLastRead('General', 6);
        },
        "someone else's pointers": () => {
            setLastRead('general', 6, OtherUserId);
            setLastRead('fido_tech', 16, OtherUserId);
            setLastRead(Private, 44, OtherUserId);
        },
    };

    describe('matches the per-area functions', () => {
        for (const [floorName, properties] of Object.entries(Floors)) {
            for (const [pointerName, setPointers] of Object.entries(Pointers)) {
                it(`with ${floorName} and ${pointerName}`, async () => {
                    seedAwkwardBase();
                    setPointers();
                    await assertMatchesPerArea(
                        makeUser(properties),
                        AllTags,
                        `${floorName}, ${pointerName}`
                    );
                });
            }
        }

        it('for the other user, whose private mail is different', async () => {
            seedAwkwardBase();
            Pointers['pointers below the floor']();
            setLastRead(Private, 41, OtherUserId);
            for (const properties of Object.values(Floors)) {
                await assertMatchesPerArea(
                    makeUser(properties, { userId: OtherUserId, username: 'bob' }),
                    AllTags,
                    `other user ${JSON.stringify(properties)}`
                );
            }
        });

        it('for a username LIKE treats as a pattern', async () => {
            seedAwkwardBase();
            addMessage(7, 'general', '2026-09-15T00:00:00Z', { to: 'a_ne' });
            addMessage(8, 'general', '2026-09-16T00:00:00Z', { to: 'abne' });
            const actual = await assertMatchesPerArea(
                makeUser({}, { username: 'a_ne' }),
                ['general'],
                'a_ne'
            );
            //  findMessages() matches toUserName with LIKE, so _ is a wildcard:
            //  anne, Anne, ANNE, a_ne and abne
            assert.equal(actual.general.yours, 5);
        });

        it('for a user with no username', async () => {
            seedAwkwardBase();
            await assertMatchesPerArea(
                makeUser({}, { username: '' }),
                ['general', Private],
                'no username'
            );
        });
    });

    describe('the numbers themselves', () => {
        it('counts without a floor from the raw pointer', async () => {
            seedAwkwardBase();
            setLastRead('general', 2);
            setLastRead('mixedcase', 31);

            const s = await stats(makeUser(), ['general', 'MixedCase', 'empty_area']);
            assert.deepEqual(s.general, {
                total: 6,
                newCount: 4,
                yours: 2, //  Anne, ANNE; annette is not anne
                lastPostId: 6,
                lastPostTs: ts('2026-09-14T00:00:00Z'),
            });
            assert.equal(s.MixedCase.newCount, 1);
            assert.equal(s.MixedCase.total, 3);
            assert.deepEqual(s.empty_area, {
                total: 0,
                newCount: 0,
                yours: 0,
                lastPostId: 0,
                lastPostTs: null,
            });
        });

        it('starts a floor at the lowest ID dated after it, not the earliest dated', async () => {
            seedAwkwardBase();
            const s = await stats(makeUser({ newscan_min_timestamp: Floor }), [
                'fido_tech',
                'old_only',
            ]);
            //  the lowest ID dated after the floor is 10, so everything after
            //  9 is new -- 12, a late import dated before the floor, included
            assert.equal(s.fido_tech.total, 8);
            assert.equal(s.fido_tech.newCount, 7);
            assert.equal(s.fido_tech.yours, 3);
            //  nothing after the floor: caught up
            assert.equal(s.old_only.newCount, 0);
            assert.equal(s.old_only.total, 2);
        });

        it('counts a message on the floor, or one second after it, as before it', async () => {
            seedAwkwardBase();
            const s = await stats(makeUser({ newscan_min_timestamp: Floor }), [
                'boundary',
            ]);
            //  27 is the first after the floor: 27 and the late 28 are new
            assert.equal(s.boundary.newCount, 2);
            assert.equal(s.boundary.yours, 1);
        });

        it("applies no floor to private mail, and counts only the caller's", async () => {
            seedAwkwardBase();
            const s = await stats(
                makeUser({ newscan_min_timestamp: '2027-01-01T00:00:00Z' }),
                [Private]
            );
            assert.deepEqual(s[Private], {
                total: 2,
                newCount: 2,
                yours: 2,
                lastPostId: 42, //  not 44, which is someone else's
                lastPostTs: ts('2026-09-20T00:00:00Z'),
            });
        });

        it('answers an empty or missing tag list with nothing', async () => {
            seedAwkwardBase();
            assert.deepEqual(await stats(makeUser(), []), {});
            assert.deepEqual(await stats(makeUser(), undefined), {});
        });

        it('answers duplicate tags once', async () => {
            seedAwkwardBase();
            const s = await stats(makeUser(), ['general', 'general']);
            assert.deepEqual(Object.keys(s), ['general']);
            assert.equal(s.general.total, 6);
        });

        it('runs one statement however many areas', async () => {
            seedAwkwardBase();
            let prepared = 0;
            const realPrepare = testDb.prepare;
            testDb.prepare = function (...args) {
                prepared += 1;
                return realPrepare.apply(this, args);
            };
            try {
                await stats(makeUser({ newscan_min_timestamp: Floor }), AllTags);
            } finally {
                testDb.prepare = realPrepare;
            }
            assert.equal(prepared, 1);
        });
    });

    describe('markMessageAreaRead()', () => {
        const mark = (user, areaTag) =>
            new Promise((resolve, reject) =>
                MessageArea.markMessageAreaRead(user, areaTag, err =>
                    err ? reject(err) : resolve()
                )
            );

        it('moves the pointer to the highest ID, and nothing is new after', async () => {
            seedAwkwardBase();
            setLastRead('fido_tech', 10);
            await mark(makeUser(), 'fido_tech');
            assert.equal(lastRead('fido_tech'), 16);

            const s = await stats(makeUser(), ['fido_tech']);
            assert.equal(s.fido_tech.newCount, 0);
            assert.equal(s.fido_tech.yours, 0);
        });

        it('stores a mixed-case tag in lower case, as the pointer is read', async () => {
            seedAwkwardBase();
            await mark(makeUser(), 'MixedCase');
            assert.equal(lastRead('mixedcase'), 32);
            assert.equal(lastRead('MixedCase'), 0);
            const s = await stats(makeUser(), ['MixedCase']);
            assert.equal(s.MixedCase.newCount, 0);
        });

        it('never moves a pointer backwards', async () => {
            seedAwkwardBase();
            setLastRead('general', 100);
            await mark(makeUser(), 'general');
            assert.equal(lastRead('general'), 100);
        });

        it('leaves an empty area alone', async () => {
            seedAwkwardBase();
            await mark(makeUser(), 'empty_area');
            assert.equal(lastRead('empty_area'), 0);
        });

        it('marks private mail read, and only touches the caller', async () => {
            seedAwkwardBase();
            setLastRead(Private, 41, OtherUserId);
            await mark(makeUser(), 'Private_Mail');
            assert.equal(lastRead(Private), 44);
            assert.equal(lastRead(Private, OtherUserId), 41);
            const s = await stats(makeUser(), [Private]);
            assert.equal(s[Private].newCount, 0);
        });
    });
});
