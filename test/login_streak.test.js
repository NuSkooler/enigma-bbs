'use strict';

const { strict: assert } = require('assert');
const moment = require('moment');

//
//  user_login.js requires several heavy modules at load time. Stub the ones
//  that would blow up without a full system context before requiring the
//  module under test.
//
const Module = require('module');
const _originalLoad = Module._load;
const STUBS = {
    './theme.js': { setClientTheme: () => {} },
    './client_connections.js': { clientConnections: [] },
    './logger.js': {
        log: {
            info: () => {},
            warn: () => {},
            error: () => {},
            debug: () => {},
            trace: () => {},
            child: () => ({
                info: () => {},
                warn: () => {},
                error: () => {},
                debug: () => {},
                trace: () => {},
            }),
        },
    },
    './events.js': {
        getSystemEvents: () => ({}),
        emit: () => {},
        addMultipleEventListener: () => {},
    },
    './user.js': {},
    './message_area.js': {
        getMessageConferenceByTag: () => {},
        getMessageAreaByTag: () => {},
        getSuitableMessageConfAndAreaTags: () => {},
    },
    './file_base_area.js': {
        getFileAreaByTag: () => {},
        getDefaultFileAreaTag: () => {},
    },
    './stat_log.js': {
        setUserStat: () => {},
        incrementUserStat: () => {},
        incrementSystemStat: (_a, _b, cb) => cb && cb(null),
        incrementNonPersistentSystemStat: () => {},
        setNonPersistentSystemStat: () => {},
        appendSystemLogEntry: (_a, _b, _c, _d, cb) => cb && cb(null),
        now: new Date().toISOString(),
        KeepType: { Max: 'max' },
    },
    './system_property.js': {},
    './system_log.js': {},
    './enig_error.js': { Errors: {}, ErrorReasons: {} },
};

Module._load = function (request, parent, isMain) {
    //  Only intercept requires that come from user_login.js itself.
    const fromLoginModule =
        parent && parent.filename && parent.filename.includes('user_login');
    if (fromLoginModule && Object.prototype.hasOwnProperty.call(STUBS, request)) {
        return STUBS[request];
    }
    return _originalLoad(request, parent, isMain);
};

const { computeLoginStreak } = require('../core/user_login.js');

//  Restore after load — other test files should not be affected.
Module._load = _originalLoad;

// ─── helpers ─────────────────────────────────────────────────────────────────

const UserProps = require('../core/user_property.js');

//  Build a minimal user object with just enough interface for computeLoginStreak.
function makeUser(overrides = {}) {
    const props = Object.assign(
        {
            [UserProps.LoginStreakDays]: 0,
            [UserProps.LoginStreakLastDate]: '',
        },
        overrides
    );
    return {
        getProperty: name => props[name] || null,
        getPropertyAsNumber: name => Number(props[name]) || 0,
    };
}

//  A user mid-streak: |days| long, last credited on |lastDate|.
function userOnStreak(days, lastDate) {
    return makeUser({
        [UserProps.LoginStreakDays]: days,
        [UserProps.LoginStreakLastDate]: lastDate,
    });
}

const at = s => moment(s);

// ─── computeLoginStreak() ─────────────────────────────────────────────────────

describe('computeLoginStreak()', function () {
    describe('nothing credited yet', function () {
        it('starts the streak at 1', () => {
            const now = at('2024-06-15T09:00:00');
            const [days, date] = computeLoginStreak(makeUser(), now);
            assert.equal(days, 1);
            assert.equal(date, '2024-06-15');
        });

        it('starts at 1 when the stored date cannot be parsed', () => {
            const user = userOnStreak(9, 'not-a-date');
            const [days, date] = computeLoginStreak(user, at('2024-06-15T09:00:00'));
            assert.equal(days, 1);
            assert.equal(date, '2024-06-15');
        });
    });

    describe('already credited today', function () {
        it('leaves the streak alone on a second login the same day', () => {
            const user = userOnStreak(10, '2024-06-15');
            const [days, date] = computeLoginStreak(user, at('2024-06-15T22:00:00'));
            assert.equal(days, 10);
            assert.equal(date, '2024-06-15');
        });

        it('leaves the streak alone if the clock moved backwards', () => {
            const user = userOnStreak(10, '2024-06-15');
            const [days, date] = computeLoginStreak(user, at('2024-06-14T22:00:00'));
            assert.equal(days, 10);
            assert.equal(date, '2024-06-15');
        });
    });

    describe('consecutive days advance the streak', function () {
        it('increments on the next calendar day', () => {
            const user = userOnStreak(5, '2024-06-14');
            const [days, date] = computeLoginStreak(user, at('2024-06-15T20:30:00'));
            assert.equal(days, 6);
            assert.equal(date, '2024-06-15');
        });

        it('increments even when the calls are only minutes apart across midnight', () => {
            //  One credit per calendar day is the rule, so this is a short gap
            //  rather than a way to earn two days at once.
            const user = userOnStreak(4, '2024-06-15');
            const [days, date] = computeLoginStreak(user, at('2024-06-16T00:02:00'));
            assert.equal(days, 5);
            assert.equal(date, '2024-06-16');
        });

        it('increments when the calls are nearly 48h apart but on consecutive days', () => {
            //  00:30 Sat to 23:30 Sun: 47h, but no day was missed.
            const user = userOnStreak(8, '2024-06-15');
            const [days] = computeLoginStreak(user, at('2024-06-16T23:30:00'));
            assert.equal(days, 9);
        });
    });

    describe('a missed day breaks the streak', function () {
        it('resets when one day is skipped', () => {
            const user = userOnStreak(20, '2024-06-13');
            const [days, date] = computeLoginStreak(user, at('2024-06-15T10:00:00'));
            assert.equal(days, 1);
            assert.equal(date, '2024-06-15');
        });

        it('resets even when the gap is under 48h, if a day was missed', () => {
            //  23:00 Thu to 22:00 Sat is 47h, but Friday never happened.
            //  The old hours-based rule counted this as consecutive.
            const user = userOnStreak(8, '2024-06-13');
            const [days] = computeLoginStreak(user, at('2024-06-15T22:00:00'));
            assert.equal(days, 1, 'a skipped day must break the run');
        });

        it('resets after a week away', () => {
            const user = userOnStreak(100, '2024-06-01');
            const [days, date] = computeLoginStreak(user, at('2024-06-08T10:00:00'));
            assert.equal(days, 1);
            assert.equal(date, '2024-06-08');
        });
    });

    describe('regression: calling more than once a day', function () {
        //
        //  The streak used to be measured from the previous login rather than
        //  from the day it was last credited, so a caller who connected twice in
        //  one day pushed the reference point forward and the next day's login
        //  was rejected as "too soon". Heavy callers were pinned at a streak of
        //  1 no matter how many consecutive days they called.
        //
        it('advances for a caller who connects morning and evening every day', () => {
            let days = 0;
            let lastDate = '';

            //  Mon..Fri, twice a day.
            for (const day of ['17', '18', '19', '20', '21']) {
                for (const hour of ['09:00:00', '20:00:00']) {
                    const user = userOnStreak(days, lastDate);
                    [days, lastDate] = computeLoginStreak(
                        user,
                        at(`2024-06-${day}T${hour}`)
                    );
                }
            }

            assert.equal(days, 5, 'five consecutive days should be a streak of 5');
            assert.equal(lastDate, '2024-06-21');
        });

        it('advances the same whether the caller connects once or ten times a day', () => {
            const run = perDay => {
                let days = 0;
                let lastDate = '';
                for (const day of ['10', '11', '12']) {
                    for (let i = 0; i < perDay; i++) {
                        const user = userOnStreak(days, lastDate);
                        const hour = String(8 + i).padStart(2, '0');
                        [days, lastDate] = computeLoginStreak(
                            user,
                            at(`2024-06-${day}T${hour}:00:00`)
                        );
                    }
                }
                return days;
            };

            assert.equal(run(1), 3);
            assert.equal(run(10), 3);
        });
    });

    describe('streak accumulation', function () {
        it('builds correctly over 10 consecutive daily logins', () => {
            let days = 0;
            let lastDate = '';

            for (let i = 0; i < 10; i++) {
                const now = at('2024-06-10T18:00:00').add(i, 'days');
                [days, lastDate] = computeLoginStreak(userOnStreak(days, lastDate), now);
            }

            assert.equal(days, 10);
            assert.equal(lastDate, '2024-06-19');
        });

        it('starts over after a break, then builds again', () => {
            let days = 0;
            let lastDate = '';
            const login = s => {
                [days, lastDate] = computeLoginStreak(
                    userOnStreak(days, lastDate),
                    at(s)
                );
            };

            login('2024-06-10T12:00:00');
            login('2024-06-11T12:00:00');
            login('2024-06-12T12:00:00');
            assert.equal(days, 3);

            login('2024-06-20T12:00:00'); //  eight days away
            assert.equal(days, 1);

            login('2024-06-21T12:00:00');
            assert.equal(days, 2);
        });
    });
});
