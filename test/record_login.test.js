'use strict';

const { strict: assert } = require('assert');
const moment = require('moment');

//
//  recordLogin() pulls in several heavy modules at load time.  Patch
//  Module._load scoped to requires originating from user_login.js so other
//  test files are unaffected.
//
const Module = require('module');
const _originalLoad = Module._load;

//  Spy-friendly stat log: all async variants call cb(null) so async.parallel
//  completes.  Callers can swap individual methods with their own spy functions
//  before each test.
const statLogStub = {
    setUserStat: (_u, _s, _v, cb) => cb && cb(null),
    incrementUserStat: (_u, _s, _v, cb) => cb && cb(null),
    incrementSystemStat: (_a, _b, cb) => cb && cb(null),
    incrementNonPersistentSystemStat: () => {},
    setNonPersistentSystemStat: () => {},
    appendSystemLogEntry: (_a, _b, _c, _d, cb) => cb && cb(null),
    now: new Date().toISOString(),
    KeepType: { Max: 'max' },
};

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
    './stat_log.js': statLogStub,
    './system_property.js': {
        LoginsToday: 'logins_today',
        LoginCount: 'login_count',
        LastLogin: 'last_login',
    },
    './system_log.js': {
        UserLoginHistory: 'user_login_history',
    },
    './enig_error.js': { Errors: {}, ErrorReasons: {} },
    './config.js': {
        get: () => ({
            statLog: { systemEvents: { loginHistoryMax: 10 } },
        }),
    },
};

Module._load = function (request, parent, isMain) {
    const fromLoginModule =
        parent && parent.filename && parent.filename.includes('user_login');
    if (fromLoginModule && Object.prototype.hasOwnProperty.call(STUBS, request)) {
        return STUBS[request];
    }
    return _originalLoad(request, parent, isMain);
};

//  Bust the module cache so this file gets a fresh load with our stubs,
//  regardless of load order with other test files.
const loginModulePath = require.resolve('../core/user_login.js');
delete require.cache[loginModulePath];

const { recordLogin } = require('../core/user_login.js');

//  Restore after load.
Module._load = _originalLoad;

// ─── helpers ─────────────────────────────────────────────────────────────────

const UserProps = require('../core/user_property.js');

function makeUser(overrides = {}) {
    const props = Object.assign(
        {
            [UserProps.LastLoginTs]: null,
            [UserProps.LoginStreakDays]: 0,
            [UserProps.LoginStreakLastDate]: '',
            [UserProps.AccountCreated]: null,
        },
        overrides
    );
    return {
        authenticated: true,
        userId: 42,
        username: 'testuser',
        sessionId: 'test-session',
        properties: {},
        getProperty: name => props[name] || null,
        getPropertyAsNumber: name => Number(props[name]) || 0,
        persistProperty: (name, value, cb) => {
            props[name] = value;
            if (cb) cb(null);
        },
    };
}

function makeClient(user) {
    return {
        user,
        log: {
            info: () => {},
            warn: () => {},
            error: () => {},
            child: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
        },
        session: { uniqueId: 'test-session' },
        remoteAddress: '127.0.0.1',
        friendlyRemoteAddress: () => '127.0.0.1',
    };
}

//  Run recordLogin and collect all setUserStat calls.
function runRecordLogin(user, done) {
    const calls = [];
    const originalSetUserStat = statLogStub.setUserStat;
    statLogStub.setUserStat = (u, statName, value, cb) => {
        calls.push({ u, statName, value });
        if (cb) cb(null);
    };

    const client = makeClient(user);
    recordLogin(client, err => {
        statLogStub.setUserStat = originalSetUserStat;
        done(err, calls);
    });
}

// ─── recordLogin(): AccountDaysOld ───────────────────────────────────────────

describe('recordLogin() — AccountDaysOld', function () {
    it('sets AccountDaysOld when AccountCreated is present', done => {
        const createdDate = moment().subtract(30, 'days').toISOString();
        const user = makeUser({ [UserProps.AccountCreated]: createdDate });

        runRecordLogin(user, (err, calls) => {
            assert.ifError(err);
            const daysOldCall = calls.find(c => c.statName === UserProps.AccountDaysOld);
            assert.ok(daysOldCall, 'setUserStat should be called with AccountDaysOld');
            //  Allow ±1 for test timing across midnight boundaries.
            assert.ok(
                daysOldCall.value >= 29 && daysOldCall.value <= 31,
                `AccountDaysOld value ${daysOldCall.value} should be ~30`
            );
            done();
        });
    });

    it('does not set AccountDaysOld when AccountCreated is absent', done => {
        const user = makeUser(); // no AccountCreated

        runRecordLogin(user, (err, calls) => {
            assert.ifError(err);
            const daysOldCall = calls.find(c => c.statName === UserProps.AccountDaysOld);
            assert.ok(
                !daysOldCall,
                'setUserStat should NOT be called with AccountDaysOld when no AccountCreated'
            );
            done();
        });
    });

    it('AccountDaysOld is 0 for a brand-new account (created today)', done => {
        const createdDate = moment().toISOString();
        const user = makeUser({ [UserProps.AccountCreated]: createdDate });

        runRecordLogin(user, (err, calls) => {
            assert.ifError(err);
            const daysOldCall = calls.find(c => c.statName === UserProps.AccountDaysOld);
            assert.ok(daysOldCall, 'setUserStat should be called with AccountDaysOld');
            assert.ok(
                daysOldCall.value >= 0 && daysOldCall.value <= 1,
                `AccountDaysOld should be 0 or 1 for a same-day account, got ${daysOldCall.value}`
            );
            done();
        });
    });
});

// ─── recordLogin(): LoginStreakDays / LoginStreakLastDate ─────────────────────

describe('recordLogin() — login streak parallel branches', function () {
    it('sets LoginStreakDays on every login', done => {
        const user = makeUser(); // first ever login → streak = 1

        runRecordLogin(user, (err, calls) => {
            assert.ifError(err);
            const streakCall = calls.find(c => c.statName === UserProps.LoginStreakDays);
            assert.ok(streakCall, 'setUserStat should be called with LoginStreakDays');
            assert.equal(streakCall.value, 1, 'first login streak should be 1');
            done();
        });
    });

    it('sets LoginStreakLastDate to today on first login', done => {
        const user = makeUser();
        const todayStr = moment().format('YYYY-MM-DD');

        runRecordLogin(user, (err, calls) => {
            assert.ifError(err);
            const dateCall = calls.find(
                c => c.statName === UserProps.LoginStreakLastDate
            );
            assert.ok(dateCall, 'setUserStat should be called with LoginStreakLastDate');
            assert.equal(dateCall.value, todayStr);
            done();
        });
    });

    it('increments streak for a qualifying next-day login', done => {
        const prevLogin = moment().subtract(25, 'hours').toISOString();
        const prevDate = moment().subtract(1, 'day').format('YYYY-MM-DD');
        const user = makeUser({
            [UserProps.LastLoginTs]: prevLogin,
            [UserProps.LoginStreakDays]: 3,
            [UserProps.LoginStreakLastDate]: prevDate,
        });

        runRecordLogin(user, (err, calls) => {
            assert.ifError(err);
            const streakCall = calls.find(c => c.statName === UserProps.LoginStreakDays);
            assert.ok(streakCall, 'setUserStat should be called with LoginStreakDays');
            assert.equal(streakCall.value, 4, 'streak should increment from 3 to 4');
            done();
        });
    });

    it('resets streak after a long absence', done => {
        const prevLogin = moment().subtract(72, 'hours').toISOString();
        const prevDate = moment().subtract(3, 'days').format('YYYY-MM-DD');
        const user = makeUser({
            [UserProps.LastLoginTs]: prevLogin,
            [UserProps.LoginStreakDays]: 20,
            [UserProps.LoginStreakLastDate]: prevDate,
        });

        runRecordLogin(user, (err, calls) => {
            assert.ifError(err);
            const streakCall = calls.find(c => c.statName === UserProps.LoginStreakDays);
            assert.ok(streakCall, 'setUserStat should be called with LoginStreakDays');
            assert.equal(
                streakCall.value,
                1,
                'streak should reset to 1 after long absence'
            );
            done();
        });
    });

    it('calls recordLogin callback with null on success', done => {
        const user = makeUser();
        const client = makeClient(user);
        recordLogin(client, err => {
            assert.ifError(err);
            done();
        });
    });
});
