'use strict';

const { strict: assert } = require('assert');
const moment = require('moment');

//
//  user_time.js reads config.js's |get| on every call rather than capturing
//  it, so a pushed test config reaches it whatever order the suite loads in.
//  Pushed and popped around this file's tests so nothing leaks.
//
const configModule = require('../core/config.js');
const TEST_CONFIG = {
    debug: { assertsEnabled: false },
    menus: { cls: false },
    general: { boardName: 'ENiGMA½ BBS' },
    users: {},
};

const UserProps = require('../core/user_property.js');
const ACS = require('../core/acs.js');
const UserTime = require('../core/user_time.js');

//  ---------------------------------------------------------------------------

function makeUser(opts = {}) {
    const props = Object.assign({}, opts.properties);

    return {
        userId: opts.userId || 42,
        username: opts.username || 'someuser',
        groups: opts.groups || ['users'],
        properties: props,
        persisted: [],

        isAuthenticated() {
            return false !== opts.authenticated;
        },
        isRoot() {
            return true === opts.root;
        },
        isGroupMember(names) {
            if (!Array.isArray(names)) {
                names = [names];
            }
            return names.some(n => this.groups.includes(n));
        },
        getProperty(name) {
            return props[name];
        },
        getPropertyAsNumber(name) {
            return parseInt(props[name], 10);
        },
        persistProperty(name, value, cb) {
            props[name] = value;
            this.persisted.push([name, value]);
            if (cb) {
                return cb(null, value);
            }
        },
        removeProperty(name, cb) {
            delete props[name];
            if (cb) {
                return cb(null);
            }
        },
    };
}

function makeClient(user) {
    const client = { user, freeTimeDepth: 0 };
    client.acs = new ACS({ client, user });
    return client;
}

const today = () => moment().format('YYYY-MM-DD');

function withTimeLimits(bands, unlimitedText) {
    TEST_CONFIG.users = { timeLimits: bands };
    if (undefined !== unlimitedText) {
        TEST_CONFIG.users.unlimitedTimeText = unlimitedText;
    }
}

//  ---------------------------------------------------------------------------

describe('User time budget', () => {
    let previousConfig;

    before(() => {
        previousConfig = configModule._pushTestConfig(TEST_CONFIG);
    });

    after(() => {
        configModule._popTestConfig(previousConfig);
    });

    afterEach(() => {
        TEST_CONFIG.users = {};
    });

    describe('isTimeExempt', () => {
        it('exempts root', () => {
            assert.equal(UserTime.isTimeExempt(makeUser({ root: true })), true);
        });

        //  The trap: isSysOp() is an alias for isRoot() and would meter every
        //  co-sysop. This case is the only thing that catches using it.
        it('exempts a sysops group member who is not root', () => {
            const user = makeUser({ groups: ['users', 'sysops'] });
            assert.equal(user.isRoot(), false);
            assert.equal(UserTime.isTimeExempt(user), true);
        });

        it('does not exempt an ordinary user', () => {
            assert.equal(UserTime.isTimeExempt(makeUser()), false);
        });

        it('does not exempt nobody at all', () => {
            assert.equal(UserTime.isTimeExempt(null), false);
        });
    });

    describe('allowance resolution', () => {
        it('is unlimited with no configuration at all', () => {
            const client = makeClient(makeUser());
            assert.equal(UserTime.getAllowedMinutesToday(client), null);
            assert.equal(UserTime.getTimeLeftMinutes(client), null);
        });

        it('is unlimited when timeLimits is empty', () => {
            withTimeLimits([]);
            const client = makeClient(makeUser());
            assert.equal(UserTime.getAllowedMinutesToday(client), null);
        });

        it('uses the first matching band', () => {
            withTimeLimits([
                { acs: 'GM[vip]', minutesPerDay: 240 },
                { acs: 'GM[users]', minutesPerDay: 90 },
                { minutesPerDay: 30 },
            ]);
            const client = makeClient(makeUser({ groups: ['users', 'vip'] }));
            assert.equal(UserTime.getAllowedMinutesToday(client), 240);
        });

        it('falls through to a later band when an earlier one does not match', () => {
            withTimeLimits([
                { acs: 'GM[vip]', minutesPerDay: 240 },
                { acs: 'GM[users]', minutesPerDay: 90 },
                { minutesPerDay: 30 },
            ]);
            const client = makeClient(makeUser({ groups: ['users'] }));
            assert.equal(UserTime.getAllowedMinutesToday(client), 90);
        });

        it('falls through to the band with no acs', () => {
            withTimeLimits([
                { acs: 'GM[vip]', minutesPerDay: 240 },
                { minutesPerDay: 30 },
            ]);
            const client = makeClient(makeUser({ groups: ['nobody'] }));
            assert.equal(UserTime.getAllowedMinutesToday(client), 30);
        });

        it('is unlimited when every band has an acs and none match', () => {
            withTimeLimits([{ acs: 'GM[vip]', minutesPerDay: 240 }]);
            const client = makeClient(makeUser({ groups: ['nobody'] }));
            assert.equal(UserTime.getAllowedMinutesToday(client), null);
        });

        it('lets the per-user property beat a matching band', () => {
            withTimeLimits([{ minutesPerDay: 30 }]);
            const client = makeClient(
                makeUser({ properties: { [UserProps.TimeMinutesPerDay]: 120 } })
            );
            assert.equal(UserTime.getAllowedMinutesToday(client), 120);
        });

        it('treats a per-user property of 0 as unlimited', () => {
            withTimeLimits([{ minutesPerDay: 30 }]);
            const client = makeClient(
                makeUser({ properties: { [UserProps.TimeMinutesPerDay]: 0 } })
            );
            assert.equal(UserTime.getAllowedMinutesToday(client), null);
        });

        it('treats a band minutesPerDay of 0 as unlimited', () => {
            withTimeLimits([{ minutesPerDay: 0 }]);
            const client = makeClient(makeUser());
            assert.equal(UserTime.getAllowedMinutesToday(client), null);
        });

        it('exempts root even with a default band configured', () => {
            withTimeLimits([{ minutesPerDay: 30 }]);
            const client = makeClient(makeUser({ root: true }));
            assert.equal(UserTime.getAllowedMinutesToday(client), null);
        });

        it('exempts a co-sysop even with a default band configured', () => {
            withTimeLimits([{ minutesPerDay: 30 }]);
            const client = makeClient(makeUser({ groups: ['users', 'sysops'] }));
            assert.equal(UserTime.getAllowedMinutesToday(client), null);
        });

        it('is unlimited for an unauthenticated session', () => {
            withTimeLimits([{ minutesPerDay: 30 }]);
            const client = makeClient(makeUser({ authenticated: false }));
            assert.equal(UserTime.getAllowedMinutesToday(client), null);
        });

        it('is unlimited with no session at all', () => {
            assert.equal(UserTime.getAllowedMinutesToday(null), null);
            assert.equal(UserTime.getTimeLeftMinutes(null), null);
        });
    });

    //
    //  A band is ACS, and ACS reads things that move mid-session. Resolving
    //  it on every read let the allowance fall underneath a session that had
    //  already spent against the old answer.
    //
    describe('band pinning', () => {
        it('pins the band for the session, so an ACS change cannot move it', () => {
            withTimeLimits([
                { acs: 'GM[vip]', minutesPerDay: 240 },
                { minutesPerDay: 30 },
            ]);
            const user = makeUser({ groups: ['users', 'vip'] });
            const client = makeClient(user);
            assert.equal(UserTime.getAllowedMinutesToday(client), 240);

            user.groups = ['users']; //  mid-session ACS change
            assert.equal(UserTime.getAllowedMinutesToday(client), 240);
        });

        //
        //  The case this exists for: the allowance falling below what has
        //  already been spent strands the caller at zero with no warning.
        //
        it('does not strand a session whose band would drop below what it used', () => {
            withTimeLimits([
                { acs: 'GM[vip]', minutesPerDay: 240 },
                { minutesPerDay: 30 },
            ]);
            const user = makeUser({
                groups: ['users', 'vip'],
                properties: {
                    [UserProps.TimeUsedTodayMinutes]: 100,
                    [UserProps.TimeUsedTodayDate]: today(),
                },
            });
            const client = makeClient(user);
            assert.equal(UserTime.getTimeLeftMinutes(client), 140);

            user.groups = ['users']; //  would now match the 30 minute band
            assert.equal(
                UserTime.getTimeLeftMinutes(client),
                140,
                'must not drop to 0 under a session that already spent 100'
            );
        });

        it('does not reach a session already underway from a config reload', () => {
            withTimeLimits([{ minutesPerDay: 60 }]);
            const client = makeClient(makeUser());
            assert.equal(UserTime.getAllowedMinutesToday(client), 60);

            withTimeLimits([{ minutesPerDay: 5 }]);
            assert.equal(UserTime.getAllowedMinutesToday(client), 60);

            //  ...but the next session gets the new value
            assert.equal(UserTime.getAllowedMinutesToday(makeClient(makeUser())), 5);
        });

        it('re-resolves when the day rolls over mid-session', () => {
            withTimeLimits([{ minutesPerDay: 60 }]);
            const client = makeClient(makeUser());
            assert.equal(UserTime.getAllowedMinutesToday(client), 60);

            withTimeLimits([{ minutesPerDay: 90 }]);
            client.timeBand.date = moment().subtract(1, 'day').format('YYYY-MM-DD');
            assert.equal(UserTime.getAllowedMinutesToday(client), 90);
        });

        it('pins unlimited as firmly as it pins a number', () => {
            withTimeLimits([{ acs: 'GM[vip]', minutesPerDay: 30 }]);
            const user = makeUser({ groups: ['users'] }); //  no band matches
            const client = makeClient(user);
            assert.equal(UserTime.getAllowedMinutesToday(client), null);

            user.groups = ['users', 'vip'];
            assert.equal(UserTime.getAllowedMinutesToday(client), null);
        });

        it('gives each session its own pin', () => {
            withTimeLimits([
                { acs: 'GM[vip]', minutesPerDay: 240 },
                { minutesPerDay: 30 },
            ]);
            const vip = makeClient(makeUser({ groups: ['users', 'vip'] }));
            const plain = makeClient(makeUser({ groups: ['users'] }));
            assert.equal(UserTime.getAllowedMinutesToday(vip), 240);
            assert.equal(UserTime.getAllowedMinutesToday(plain), 30);
            assert.equal(UserTime.getAllowedMinutesToday(vip), 240);
        });

        it('lets the per-account override change under a pinned band', () => {
            withTimeLimits([{ minutesPerDay: 60 }]);
            const client = makeClient(makeUser());
            assert.equal(UserTime.getAllowedMinutesToday(client), 60);

            client.user.properties[UserProps.TimeMinutesPerDay] = 200;
            assert.equal(UserTime.getAllowedMinutesToday(client), 200);

            client.user.removeProperty(UserProps.TimeMinutesPerDay);
            assert.equal(
                UserTime.getAllowedMinutesToday(client),
                60,
                'band still pinned'
            );
        });
    });

    describe('re-entrancy guard', () => {
        //
        //  A band whose acs contains ML would recurse: accessor -> bands ->
        //  ML -> accessor. Standing in for ML here, since PR B has not wired
        //  it up yet; what matters is that a nested read during a band
        //  evaluation reads as unlimited rather than recursing.
        //
        it('reads as unlimited while a band evaluation is in progress', () => {
            withTimeLimits([{ acs: 'GM[users]', minutesPerDay: 30 }]);
            const client = makeClient(makeUser());

            let nested;
            client.acs.getConditionalValue = () => {
                nested = UserTime.getTimeLeftMinutes(client);
                return 30;
            };

            assert.equal(UserTime.getAllowedMinutesToday(client), 30);
            assert.equal(nested, null, 'nested read must be unlimited');
        });

        it('restores the guard after a band evaluation throws', () => {
            withTimeLimits([{ minutesPerDay: 30 }]);
            const client = makeClient(makeUser());

            const boom = makeClient(makeUser());
            boom.acs.getConditionalValue = () => {
                throw new Error('boom');
            };
            assert.throws(() => UserTime.getAllowedMinutesToday(boom));

            assert.equal(UserTime.getAllowedMinutesToday(client), 30);
        });
    });

    describe('time remaining', () => {
        it('is the allowance less what has been used', () => {
            withTimeLimits([{ minutesPerDay: 60 }]);
            const client = makeClient(
                makeUser({
                    properties: {
                        [UserProps.TimeUsedTodayMinutes]: 25,
                        [UserProps.TimeUsedTodayDate]: today(),
                    },
                })
            );
            assert.equal(UserTime.getTimeLeftMinutes(client), 35);
        });

        it('never goes below zero', () => {
            withTimeLimits([{ minutesPerDay: 60 }]);
            const client = makeClient(
                makeUser({
                    properties: {
                        [UserProps.TimeUsedTodayMinutes]: 900,
                        [UserProps.TimeUsedTodayDate]: today(),
                    },
                })
            );
            assert.equal(UserTime.getTimeLeftMinutes(client), 0);
        });

        it('counts usage even when the user is unlimited', () => {
            const user = makeUser();
            const client = makeClient(user);
            UserTime.accrueMinute(client);
            UserTime.accrueMinute(client);
            assert.equal(UserTime.getTimeLeftMinutes(client), null);
            assert.equal(UserTime.getTimeUsedTodayMinutes(user), 2);
        });
    });

    describe('day rollover', () => {
        it('stamps today on a user with no properties at all', () => {
            const user = makeUser();
            assert.equal(UserTime.getTimeUsedTodayMinutes(user), 0);
            assert.equal(user.getProperty(UserProps.TimeUsedTodayDate), today());
        });

        //  a userId exists from factor 1 onwards, before 2FA has been answered
        it('writes nothing for a session that is not authenticated yet', () => {
            const user = makeUser({ authenticated: false });
            assert.equal(UserTime.resetDailyUsageIfNeeded(user), false);
            assert.equal(UserTime.getTimeUsedTodayMinutes(user), 0);
            assert.deepEqual(user.persisted, []);
            assert.equal(user.getProperty(UserProps.TimeUsedTodayDate), undefined);
        });

        it('zeroes a stale balance on read', () => {
            const user = makeUser({
                properties: {
                    [UserProps.TimeUsedTodayMinutes]: 500,
                    [UserProps.TimeUsedTodayDate]: '1999-12-31',
                },
            });
            assert.equal(UserTime.getTimeUsedTodayMinutes(user), 0);
            assert.equal(user.getProperty(UserProps.TimeUsedTodayDate), today());
        });

        it('resets before billing, so a session across midnight starts fresh', () => {
            const user = makeUser({
                properties: {
                    [UserProps.TimeUsedTodayMinutes]: 500,
                    [UserProps.TimeUsedTodayDate]: moment()
                        .subtract(1, 'day')
                        .format('YYYY-MM-DD'),
                },
            });
            assert.equal(UserTime.accrueMinute(makeClient(user)), 1);
            assert.equal(user.getProperty(UserProps.TimeUsedTodayDate), today());
        });

        it("leaves today's balance alone", () => {
            const user = makeUser({
                properties: {
                    [UserProps.TimeUsedTodayMinutes]: 7,
                    [UserProps.TimeUsedTodayDate]: today(),
                },
            });
            assert.equal(UserTime.resetDailyUsageIfNeeded(user), false);
            assert.equal(UserTime.getTimeUsedTodayMinutes(user), 7);
        });
    });

    describe('accrual', () => {
        it('bills and persists one minute per tick', () => {
            const user = makeUser();
            const client = makeClient(user);
            UserTime.accrueMinute(client);
            UserTime.accrueMinute(client);
            UserTime.accrueMinute(client);
            assert.equal(user.getPropertyAsNumber(UserProps.TimeUsedTodayMinutes), 3);
            assert.ok(
                user.persisted.some(
                    ([n, v]) => n === UserProps.TimeUsedTodayMinutes && 3 === v
                ),
                'each tick must persist, not merely update in memory'
            );
        });

        it('bills nothing for an unauthenticated session', () => {
            const user = makeUser({ authenticated: false });
            assert.equal(UserTime.accrueMinute(makeClient(user)), undefined);
            assert.equal(user.getProperty(UserProps.TimeUsedTodayMinutes), undefined);
        });

        it('bills nothing while free time is in effect', () => {
            const user = makeUser();
            const client = makeClient(user);
            UserTime.accrueMinute(client);
            client.freeTimeDepth = 1;
            UserTime.accrueMinute(client);
            UserTime.accrueMinute(client);
            client.freeTimeDepth = 0;
            UserTime.accrueMinute(client);
            assert.equal(user.getPropertyAsNumber(UserProps.TimeUsedTodayMinutes), 2);
        });
    });

    describe('unlimitedTimeText', () => {
        it('defaults to "Unlimited"', () => {
            assert.equal(UserTime.unlimitedTimeText(), 'Unlimited');
        });

        it('honours the configured text', () => {
            withTimeLimits([], 'No limit!');
            assert.equal(UserTime.unlimitedTimeText(), 'No limit!');
        });
    });
});
