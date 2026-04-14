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

const { computeLoginStreak, LOGIN_STREAK_MIN_HOURS } = require('../core/user_login.js');

//  Restore after load — other test files should not be affected.
Module._load = _originalLoad;

// ─── helpers ─────────────────────────────────────────────────────────────────

const UserProps = require('../core/user_property.js');

//  Build a minimal user object with just enough interface for computeLoginStreak.
function makeUser(overrides = {}) {
    const props = Object.assign(
        {
            [UserProps.LastLoginTs]: null,
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

//  Return a moment() that is exactly |hours| hours after |base|.
function hoursAfter(base, hours) {
    return base.clone().add(hours, 'hours');
}

//  Format a moment as the date string stored in LoginStreakLastDate.
function dateStr(m) {
    return m.format('YYYY-MM-DD');
}

// ─── computeLoginStreak() ─────────────────────────────────────────────────────

describe('computeLoginStreak()', function () {
    describe('first login (no LastLoginTs)', function () {
        it('starts streak at 1', () => {
            const user = makeUser();
            const now = moment();
            const [days, date] = computeLoginStreak(user, now);
            assert.equal(days, 1);
            assert.equal(date, dateStr(now));
        });
    });

    describe('too soon (< LOGIN_STREAK_MIN_HOURS elapsed)', function () {
        it('does not change streak days when gap is 0 hours', () => {
            const base = moment();
            const user = makeUser({
                [UserProps.LastLoginTs]: base.toISOString(),
                [UserProps.LoginStreakDays]: 5,
                [UserProps.LoginStreakLastDate]: dateStr(base),
            });
            const [days, date] = computeLoginStreak(user, base);
            assert.equal(days, 5);
            assert.equal(date, dateStr(base));
        });

        it('does not change streak when gap is exactly 1 hour', () => {
            const base = moment();
            const user = makeUser({
                [UserProps.LastLoginTs]: base.toISOString(),
                [UserProps.LoginStreakDays]: 3,
                [UserProps.LoginStreakLastDate]: dateStr(base),
            });
            const now = hoursAfter(base, 1);
            const [days] = computeLoginStreak(user, now);
            assert.equal(days, 3);
        });

        it(`does not change streak when gap is LOGIN_STREAK_MIN_HOURS - 1 (${
            LOGIN_STREAK_MIN_HOURS - 1
        }h)`, () => {
            const base = moment();
            const user = makeUser({
                [UserProps.LastLoginTs]: base.toISOString(),
                [UserProps.LoginStreakDays]: 7,
                [UserProps.LoginStreakLastDate]: dateStr(base),
            });
            const now = hoursAfter(base, LOGIN_STREAK_MIN_HOURS - 1);
            const [days] = computeLoginStreak(user, now);
            assert.equal(days, 7);
        });

        it('midnight exploit: 11:58 PM → 12:02 AM does not advance streak', () => {
            const prevLogin = moment('2024-06-15T23:58:00');
            const user = makeUser({
                [UserProps.LastLoginTs]: prevLogin.toISOString(),
                [UserProps.LoginStreakDays]: 4,
                [UserProps.LoginStreakLastDate]: '2024-06-15',
            });
            const now = moment('2024-06-16T00:02:00'); //  different calendar day, only 4 min later
            const [days, date] = computeLoginStreak(user, now);
            assert.equal(days, 4, 'streak must not advance on midnight exploit');
            assert.equal(date, '2024-06-15');
        });
    });

    describe('already counted today', function () {
        it('does not double-count a second qualifying login on the same calendar day', () => {
            const base = moment('2024-06-15T09:00:00');
            const user = makeUser({
                [UserProps.LastLoginTs]: base.toISOString(),
                [UserProps.LoginStreakDays]: 10,
                [UserProps.LoginStreakLastDate]: '2024-06-15',
            });
            //  22 hours later — same calendar day, gap > MIN_HOURS
            const now = moment('2024-06-15T22:00:00');
            const [days, date] = computeLoginStreak(user, now);
            assert.equal(days, 10, 'should not increment when already counted today');
            assert.equal(date, '2024-06-15');
        });
    });

    describe('streak continues (gap within 48h, different day)', function () {
        it(`increments streak when gap is exactly LOGIN_STREAK_MIN_HOURS (${LOGIN_STREAK_MIN_HOURS}h)`, () => {
            const base = moment('2024-06-14T10:00:00');
            const user = makeUser({
                [UserProps.LastLoginTs]: base.toISOString(),
                [UserProps.LoginStreakDays]: 3,
                [UserProps.LoginStreakLastDate]: '2024-06-14',
            });
            const now = hoursAfter(base, LOGIN_STREAK_MIN_HOURS);
            const [days, date] = computeLoginStreak(user, now);
            assert.equal(days, 4);
            assert.equal(date, dateStr(now));
        });

        it('increments streak for a normal next-day login (~24h gap)', () => {
            const base = moment('2024-06-14T20:00:00');
            const user = makeUser({
                [UserProps.LastLoginTs]: base.toISOString(),
                [UserProps.LoginStreakDays]: 5,
                [UserProps.LoginStreakLastDate]: '2024-06-14',
            });
            const now = moment('2024-06-15T20:30:00');
            const [days, date] = computeLoginStreak(user, now);
            assert.equal(days, 6);
            assert.equal(date, '2024-06-15');
        });

        it('increments streak when gap is 47h (edge of 48h window)', () => {
            const base = moment('2024-06-13T10:00:00');
            const user = makeUser({
                [UserProps.LastLoginTs]: base.toISOString(),
                [UserProps.LoginStreakDays]: 8,
                [UserProps.LoginStreakLastDate]: '2024-06-13',
            });
            const now = hoursAfter(base, 47);
            const [days] = computeLoginStreak(user, now);
            assert.equal(days, 9);
        });

        it('updates the stored date to today', () => {
            const base = moment('2024-06-14T10:00:00');
            const user = makeUser({
                [UserProps.LastLoginTs]: base.toISOString(),
                [UserProps.LoginStreakDays]: 1,
                [UserProps.LoginStreakLastDate]: '2024-06-14',
            });
            const now = moment('2024-06-15T11:00:00');
            const [, date] = computeLoginStreak(user, now);
            assert.equal(date, '2024-06-15');
        });
    });

    describe('streak broken (gap > 48h)', function () {
        it('resets to 1 when gap is exactly 49h', () => {
            const base = moment('2024-06-13T10:00:00');
            const user = makeUser({
                [UserProps.LastLoginTs]: base.toISOString(),
                [UserProps.LoginStreakDays]: 20,
                [UserProps.LoginStreakLastDate]: '2024-06-13',
            });
            const now = hoursAfter(base, 49);
            const [days, date] = computeLoginStreak(user, now);
            assert.equal(days, 1, 'streak must reset to 1');
            assert.equal(date, dateStr(now));
        });

        it('resets to 1 after a week-long absence', () => {
            const base = moment('2024-06-01T10:00:00');
            const user = makeUser({
                [UserProps.LastLoginTs]: base.toISOString(),
                [UserProps.LoginStreakDays]: 100,
                [UserProps.LoginStreakLastDate]: '2024-06-01',
            });
            const now = moment('2024-06-08T10:00:00');
            const [days] = computeLoginStreak(user, now);
            assert.equal(days, 1);
        });

        it('updates the stored date to today after reset', () => {
            const base = moment('2024-06-01T10:00:00');
            const user = makeUser({
                [UserProps.LastLoginTs]: base.toISOString(),
                [UserProps.LoginStreakDays]: 50,
                [UserProps.LoginStreakLastDate]: '2024-06-01',
            });
            const now = moment('2024-06-10T10:00:00');
            const [, date] = computeLoginStreak(user, now);
            assert.equal(date, '2024-06-10');
        });
    });

    describe('boundary: exactly 48h gap', function () {
        it('still counts as streak continuing at exactly 48h', () => {
            const base = moment('2024-06-13T10:00:00');
            const user = makeUser({
                [UserProps.LastLoginTs]: base.toISOString(),
                [UserProps.LoginStreakDays]: 12,
                [UserProps.LoginStreakLastDate]: '2024-06-13',
            });
            const now = hoursAfter(base, 48);
            const [days] = computeLoginStreak(user, now);
            assert.equal(days, 13);
        });
    });

    describe('streak accumulation across multiple logins', function () {
        it('builds streak correctly over 5 simulated daily logins', () => {
            //  Simulate 5 consecutive daily logins, each ~24h apart.
            let props = {
                [UserProps.LastLoginTs]: null,
                [UserProps.LoginStreakDays]: 0,
                [UserProps.LoginStreakLastDate]: '',
            };

            const baseDay = moment('2024-06-10T18:00:00');

            for (let i = 0; i < 5; i++) {
                const now = baseDay.clone().add(i, 'days');
                const user = {
                    getProperty: name => props[name] || null,
                    getPropertyAsNumber: name => Number(props[name]) || 0,
                };
                const [days, date] = computeLoginStreak(user, now);
                //  Update simulated stored props for next iteration.
                props[UserProps.LastLoginTs] = now.toISOString();
                props[UserProps.LoginStreakDays] = days;
                props[UserProps.LoginStreakLastDate] = date;
            }

            assert.equal(props[UserProps.LoginStreakDays], 5);
            assert.equal(props[UserProps.LoginStreakLastDate], '2024-06-14');
        });

        it('resets mid-streak correctly', () => {
            //  3 days of streak, then a 3-day gap, then one more login.
            let props = {
                [UserProps.LastLoginTs]: null,
                [UserProps.LoginStreakDays]: 0,
                [UserProps.LoginStreakLastDate]: '',
            };

            const days = [
                moment('2024-06-10T18:00:00'),
                moment('2024-06-11T18:00:00'),
                moment('2024-06-12T18:00:00'),
                //  gap — 2024-06-13, 2024-06-14, 2024-06-15 missed
                moment('2024-06-16T18:00:00'),
            ];

            for (const now of days) {
                const user = {
                    getProperty: name => props[name] || null,
                    getPropertyAsNumber: name => Number(props[name]) || 0,
                };
                const [newDays, newDate] = computeLoginStreak(user, now);
                props[UserProps.LastLoginTs] = now.toISOString();
                props[UserProps.LoginStreakDays] = newDays;
                props[UserProps.LoginStreakLastDate] = newDate;
            }

            assert.equal(
                props[UserProps.LoginStreakDays],
                1,
                'streak should have reset to 1 after gap'
            );
            assert.equal(props[UserProps.LoginStreakLastDate], '2024-06-16');
        });
    });
});
