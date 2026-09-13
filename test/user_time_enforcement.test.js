'use strict';

const { strict: assert } = require('assert');
const { EventEmitter } = require('events');
const moment = require('moment');

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
const UserInterruptQueue = require('../core/user_interrupt_queue.js');

//  ---------------------------------------------------------------------------

function makeUser(opts = {}) {
    const props = Object.assign({}, opts.properties);
    return {
        userId: opts.userId || 42,
        username: 'someuser',
        groups: opts.groups || ['users'],
        properties: props,
        isAuthenticated: () => false !== opts.authenticated,
        isRoot: () => true === opts.root,
        isGroupMember(names) {
            if (!Array.isArray(names)) {
                names = [names];
            }
            return names.some(n => this.groups.includes(n));
        },
        getProperty: name => props[name],
        getPropertyAsNumber: name => parseInt(props[name], 10),
        persistProperty(name, value, cb) {
            props[name] = value;
            if (cb) {
                return cb(null, value);
            }
        },
    };
}

//
//  A client that records what the interrupt queue would have shown. The
//  queue's own queueItem() reaches into currentMenuModule, which a real
//  session has and this does not, so it is stubbed at the client.
//
function makeClient(user) {
    const client = new EventEmitter();
    Object.assign(client, {
        user,
        node: 1,
        freeTimeDepth: 0,
        warnings: [],
        timeUpCount: 0,
        interruptQueue: {
            queueItem(item) {
                client.warnings.push(item);
            },
        },
    });
    client.acs = new ACS({ client, user });
    client.on('time up', () => (client.timeUpCount += 1));
    return client;
}

const today = () => moment().format('YYYY-MM-DD');

function clientWithBudget(allowed, used, userOpts = {}) {
    TEST_CONFIG.users = { timeLimits: [{ minutesPerDay: allowed }] };
    return makeClient(
        makeUser(
            Object.assign(
                {
                    properties: {
                        [UserProps.TimeUsedTodayMinutes]: used,
                        [UserProps.TimeUsedTodayDate]: today(),
                    },
                },
                userOpts
            )
        )
    );
}

//  spend another n minutes without going through the tick
function spend(client, n) {
    client.user.properties[UserProps.TimeUsedTodayMinutes] += n;
}

//  ---------------------------------------------------------------------------

describe('Time limit enforcement', () => {
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

    describe('warnings', () => {
        it('says nothing while there is plenty left', () => {
            const client = clientWithBudget(60, 10);
            assert.equal(UserTime.checkTimeRemaining(client), undefined);
            assert.equal(client.warnings.length, 0);
        });

        it('warns at each of 5, 3, 2 and 1, exactly once', () => {
            const client = clientWithBudget(60, 54); //  6 left
            const warnedAt = [];
            for (let i = 0; i < 6; ++i) {
                const at = UserTime.checkTimeRemaining(client);
                if ('time up' !== at && undefined !== at) {
                    warnedAt.push(at);
                }
                spend(client, 1);
            }
            assert.deepEqual(warnedAt, [5, 3, 2, 1]);
            assert.equal(client.warnings.length, 4);
        });

        //
        //  The Mystic bug: "If TimeCount = 5" drops the warning entirely when
        //  a tick lands on 4. An equality based implementation passes a naive
        //  test and fails this one.
        //
        it('still warns when a tick skips the threshold', () => {
            const client = clientWithBudget(60, 58); //  2 left, never saw 5 or 3
            assert.equal(UserTime.checkTimeRemaining(client), 2);
            assert.equal(client.warnings.length, 1);
            assert.ok(/2 minutes\b/.test(client.warnings[0].text));
        });

        //
        //  And when it lands *between* thresholds, which is where an
        //  equality test drops the warning altogether rather than merely
        //  being late.
        //
        it('warns at a balance that is not itself a threshold', () => {
            const client = clientWithBudget(60, 56); //  4 left, never saw 5
            assert.equal(UserTime.checkTimeRemaining(client), 5);
            assert.equal(client.warnings.length, 1);
            assert.ok(/4 minutes\b/.test(client.warnings[0].text));
        });

        it('warns four times over a run of ticks that never lands on 5', () => {
            const client = clientWithBudget(60, 54); //  6 left
            const seen = [];
            //  6 -> 4 -> 3 -> 2 -> 1
            [2, 1, 1, 1].forEach(step => {
                spend(client, step);
                const at = UserTime.checkTimeRemaining(client);
                if (undefined !== at) {
                    seen.push(at);
                }
            });
            assert.deepEqual(seen, [5, 3, 2, 1]);
        });

        it('does not re-warn at a threshold it has already passed', () => {
            const client = clientWithBudget(60, 57); //  3 left
            assert.equal(UserTime.checkTimeRemaining(client), 3);
            assert.equal(UserTime.checkTimeRemaining(client), undefined);
            assert.equal(UserTime.checkTimeRemaining(client), undefined);
            assert.equal(client.warnings.length, 1);
        });

        it('says "minute" rather than "minutes" at one', () => {
            const client = clientWithBudget(60, 59);
            UserTime.checkTimeRemaining(client);
            assert.ok(/1 minute\b/.test(client.warnings[0].text));
            assert.ok(!/minutes/.test(client.warnings[0].text));
        });

        it('never pauses for the warning', () => {
            const client = clientWithBudget(60, 55);
            UserTime.checkTimeRemaining(client);
            assert.equal(client.warnings[0].pause, false);
        });

        it('says nothing to an unlimited user', () => {
            const client = makeClient(makeUser());
            assert.equal(UserTime.checkTimeRemaining(client), undefined);
            assert.equal(client.warnings.length, 0);
        });

        it('says nothing to an exempt user, however little is left', () => {
            const client = clientWithBudget(60, 59, { groups: ['users', 'sysops'] });
            assert.equal(UserTime.checkTimeRemaining(client), undefined);
            assert.equal(client.warnings.length, 0);
            assert.equal(client.timeUpCount, 0);
        });

        it('reaches a real interrupt queue', () => {
            //  the stub above proves the call; this proves the shape it takes
            const client = clientWithBudget(60, 59);
            const real = new UserInterruptQueue(client);
            client.interruptQueue = real;
            UserTime.checkTimeRemaining(client);
            assert.equal(real.hasItems(), true);
        });
    });

    //
    //  The case the existing idleLogoff pattern gets wrong: a menu that
    //  exists whose art does not, where MenuModule displays nothing and runs
    //  straight on to logoff -- a silent drop.
    //
    describe('the kick path', () => {
        const { timeUpLogoff } = require('../core/login_server_module.js');

        function kickClient(themeMenus, artExists) {
            const client = makeClient(makeUser());
            client.currentTheme = { menus: themeMenus };
            client.user.properties[UserProps.ThemeId] = 'test';
            client.written = [];
            client.ended = 0;
            client.gotos = [];
            client.term = { write: t => client.written.push(t) };
            client.end = () => (client.ended += 1);
            client.menuStack = {
                goto: (name, cb) => {
                    client.gotos.push(name);
                    return cb(artExists ? null : new Error('nope'));
                },
            };
            return client;
        }

        //  stub theme.getThemeArt so no art has to exist on disk
        const themeModule = require('../core/theme.js');
        let realGetThemeArt;
        beforeEach(() => {
            realGetThemeArt = themeModule.getThemeArt;
        });
        afterEach(() => {
            themeModule.getThemeArt = realGetThemeArt;
        });

        const withArt = present => {
            themeModule.getThemeArt = (options, cb) =>
                present ? cb(null, { data: '' }) : cb(new Error('no such art'));
        };

        it('goes to the menu when the menu and its art both exist', done => {
            withArt(true);
            const client = kickClient({ timeUpLogoff: { art: 'TIMEUP' } }, true);
            timeUpLogoff(client, (err, how) => {
                assert.equal(how, 'menu');
                assert.deepEqual(client.gotos, ['timeUpLogoff']);
                assert.equal(client.ended, 0);
                done();
            });
        });

        it('tells the user plainly when the menu exists but the art does not', done => {
            withArt(false);
            const client = kickClient({ timeUpLogoff: { art: 'TIMEUP' } }, true);
            timeUpLogoff(client, (err, how) => {
                assert.equal(how, 'plain');
                assert.deepEqual(client.gotos, [], 'must not enter the menu');
                assert.equal(client.ended, 1);
                assert.ok(/time for today is up/i.test(client.written.join('')));
                done();
            });
        });

        it('tells the user plainly when the menu names no art at all', done => {
            withArt(true);
            const client = kickClient({ timeUpLogoff: {} }, true);
            timeUpLogoff(client, (err, how) => {
                assert.equal(how, 'plain');
                assert.equal(client.ended, 1);
                done();
            });
        });

        it('tells the user plainly when the menu does not exist', done => {
            withArt(true);
            const client = kickClient({}, true);
            timeUpLogoff(client, (err, how) => {
                assert.equal(how, 'plain');
                assert.equal(client.ended, 1);
                assert.ok(/time for today is up/i.test(client.written.join('')));
                done();
            });
        });

        it('falls back when the menu itself fails to load', done => {
            withArt(true);
            const client = kickClient({ timeUpLogoff: { art: 'TIMEUP' } }, false);
            timeUpLogoff(client, (err, how) => {
                assert.equal(how, 'plain');
                assert.deepEqual(client.gotos, ['timeUpLogoff']);
                assert.equal(client.ended, 1);
                done();
            });
        });
    });

    //
    //  Doors are refused before they start rather than killed part way
    //  through; see core/abracadabra.js validateTimeRemaining().
    //
    describe('hasTimeFor', () => {
        it('allows anything when the door asks for nothing', () => {
            const client = clientWithBudget(60, 59); //  1 left
            assert.equal(UserTime.hasTimeFor(client, undefined), true);
            assert.equal(UserTime.hasTimeFor(client, 0), true);
            assert.equal(UserTime.hasTimeFor(client, 'nonsense'), true);
        });

        it('allows an unlimited user whatever the door asks for', () => {
            const client = makeClient(makeUser());
            assert.equal(UserTime.hasTimeFor(client, 600), true);
        });

        it('allows an exempt user whatever the door asks for', () => {
            const client = clientWithBudget(60, 59, { groups: ['users', 'sysops'] });
            assert.equal(UserTime.hasTimeFor(client, 30), true);
        });

        it('compares >=', () => {
            const client = clientWithBudget(60, 45); //  15 left
            assert.equal(UserTime.hasTimeFor(client, 14), true);
            assert.equal(UserTime.hasTimeFor(client, 15), true);
            assert.equal(UserTime.hasTimeFor(client, 16), false);
        });

        it('accepts the requirement as a string, as hjson may supply it', () => {
            const client = clientWithBudget(60, 45); //  15 left
            assert.equal(UserTime.hasTimeFor(client, '16'), false);
            assert.equal(UserTime.hasTimeFor(client, '15'), true);
        });
    });

    describe('the kick', () => {
        it('emits "time up" at zero', () => {
            const client = clientWithBudget(60, 60);
            assert.equal(UserTime.checkTimeRemaining(client), 'time up');
            assert.equal(client.timeUpCount, 1);
        });

        it('emits "time up" when over the allowance', () => {
            const client = clientWithBudget(60, 500);
            assert.equal(UserTime.checkTimeRemaining(client), 'time up');
            assert.equal(client.timeUpCount, 1);
        });

        it('does not warn on the tick that kicks', () => {
            const client = clientWithBudget(60, 60);
            UserTime.checkTimeRemaining(client);
            assert.equal(client.warnings.length, 0);
        });

        it('never kicks an unlimited user', () => {
            const client = makeClient(
                makeUser({
                    properties: {
                        [UserProps.TimeUsedTodayMinutes]: 9999,
                        [UserProps.TimeUsedTodayDate]: today(),
                    },
                })
            );
            assert.equal(UserTime.checkTimeRemaining(client), undefined);
            assert.equal(client.timeUpCount, 0);
        });
    });
});
