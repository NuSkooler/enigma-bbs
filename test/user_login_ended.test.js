'use strict';

//
//  userLogin() when the connection ends while authentication is under way
//  (the caller hangs up, the SSH login timeout fires): no login side effects,
//  and an error its callers treat as "do nothing more" (#1080).
//

const { strict: assert } = require('assert');
const Module = require('module');

const { ErrorReasons } = require('../core/enig_error.js');

//
//  user_login.js pulls in several heavy modules at load time. Requires made
//  from it are stubbed while it loads; the module cache entry it replaces is
//  put back afterwards, so other test files keep the copy they have.
//
const events = [];
const statCalls = [];
const themeCalls = [];

const recordStat =
    name =>
    (...args) => {
        statCalls.push(name);
        const cb = args[args.length - 1];
        if ('function' === typeof cb) {
            return cb(null);
        }
    };

const STUBS = {
    './theme.js': { setClientTheme: () => themeCalls.push('setClientTheme') },
    './client_connections.js': { clientConnections: [] },
    './logger.js': {
        log: { child: () => makeLog() },
    },
    './events.js': {
        getSystemEvents: () => ({ UserLogin: 'user login' }),
        emit: name => events.push(name),
    },
    './user.js': { AuthFactor1Types: { Password: 'password' } },
    './message_area.js': {
        getMessageConferenceByTag: () => ({}),
        getMessageAreaByTag: () => ({}),
        getSuitableMessageConfAndAreaTags: () => [],
    },
    './file_base_area.js': {
        getFileAreaByTag: () => ({}),
        getDefaultFileAreaTag: () => '',
    },
    './stat_log.js': {
        setUserStat: recordStat('setUserStat'),
        incrementUserStat: recordStat('incrementUserStat'),
        incrementSystemStat: recordStat('incrementSystemStat'),
        incrementNonPersistentSystemStat: recordStat('incrementNonPersistentSystemStat'),
        setNonPersistentSystemStat: recordStat('setNonPersistentSystemStat'),
        appendSystemLogEntry: recordStat('appendSystemLogEntry'),
        now: new Date().toISOString(),
        KeepType: { Max: 'max' },
    },
    './config.js': {
        get: () => ({
            users: { badUserNames: ['root'], failedLogin: { disconnect: 3 } },
            statLog: { systemEvents: { loginHistoryMax: 10 } },
        }),
    },
};

function makeLog() {
    const entries = [];
    const log = { entries, fields: {}, child: () => log };
    ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].forEach(level => {
        log[level] = (obj, msg) => {
            entries.push({ level, obj, msg: 'string' === typeof obj ? obj : msg });
            return true;
        };
    });
    return log;
}

let userLogin;

describe('userLogin() when the connection ends during login (#1080)', function () {
    let savedCacheEntry;
    const loginModulePath = require.resolve('../core/user_login.js');

    before(() => {
        const originalLoad = Module._load;
        Module._load = function (request, parent, isMain) {
            const fromLoginModule =
                parent && parent.filename && parent.filename === loginModulePath;
            if (fromLoginModule && Object.prototype.hasOwnProperty.call(STUBS, request)) {
                return STUBS[request];
            }
            return originalLoad(request, parent, isMain);
        };

        savedCacheEntry = require.cache[loginModulePath];
        delete require.cache[loginModulePath];
        try {
            userLogin = require('../core/user_login.js').userLogin;
        } finally {
            Module._load = originalLoad;
            if (savedCacheEntry) {
                require.cache[loginModulePath] = savedCacheEntry;
            } else {
                delete require.cache[loginModulePath];
            }
        }
    });

    beforeEach(() => {
        events.length = 0;
        statCalls.length = 0;
        themeCalls.length = 0;
    });

    //
    //  |endDuringAuth|: the connection ends while authenticateFactor1() is
    //  in flight, which then finishes with |authErr|
    //
    function makeClient({ endDuringAuth, authErr = null }) {
        const writes = [];
        const client = {
            clientEnded: false,
            log: makeLog(),
            session: { uniqueId: 'session-1' },
            remoteAddress: '192.0.2.20',
            friendlyRemoteAddress: () => '192.0.2.20',
            term: { write: data => writes.push(data) },
            acs: {
                hasMessageConfRead: () => true,
                hasMessageAreaRead: () => true,
                hasFileAreaRead: () => true,
            },
            writes,
        };

        client.user = {
            userId: 0,
            properties: {},
            getProperty: () => null,
            getPropertyAsNumber: () => 0,
            authenticateFactor1: (authInfo, cb) => {
                if (endDuringAuth) {
                    client.clientEnded = true;
                }
                setImmediate(() => {
                    if (!authErr) {
                        client.user.userId = 42;
                        client.user.username = 'somebody';
                        client.user.authenticated = true;
                    }
                    return cb(authErr);
                });
            },
        };

        return client;
    }

    function login(client) {
        return new Promise(resolve =>
            userLogin(client, 'somebody', 'secret', err => resolve(err))
        );
    }

    it('logs in, records the login and emits UserLogin when the connection stays', async () => {
        const client = makeClient({ endDuringAuth: false });
        const err = await login(client);
        assert.equal(err, null);
        assert.deepEqual(events, ['user login']);
        assert.ok(statCalls.length > 0, 'login recorded');
    });

    it('authentication finishing after the end: an error, and no login side effects', async () => {
        const client = makeClient({ endDuringAuth: true });
        const err = await login(client);

        assert.ok(err, 'an error');
        assert.equal(err.reasonCode, ErrorReasons.ClientEnded);
        assert.deepEqual(events, [], 'no UserLogin');
        assert.deepEqual(statCalls, [], 'no recordLogin()');
        assert.deepEqual(themeCalls, [], 'no theme set');
        assert.deepEqual(client.writes, [], 'nothing written to the client');
        assert.equal(client.user.sessionId, undefined);
        assert.ok(
            !client.log.entries.some(e => /successfully logged in/.test(e.msg)),
            'not logged as a login'
        );
        assert.ok(
            client.log.entries.some(e => 'info' === e.level && /abandoned/.test(e.msg)),
            'logged as abandoned'
        );
    });

    it('a failed authentication finishing after the end is not counted as a failed attempt', async () => {
        const authErr = new Error('Invalid password');
        const client = makeClient({ endDuringAuth: true, authErr });
        const err = await login(client);

        assert.equal(err.reasonCode, ErrorReasons.ClientEnded);
        assert.equal(client.sessionFailedLoginAttempts, undefined);
        assert.ok(!client.log.entries.some(e => /Failed login attempt/.test(e.msg)));
        assert.deepEqual(client.writes, []);
        assert.deepEqual(events, []);
    });

    describe('callers', () => {
        //
        //  system_menu_method.js destructures userLogin at require time, so
        //  a stub only reaches a freshly loaded copy; the cache entry is
        //  dropped again afterwards so the next require gets the real one.
        //
        it('the login menu method does nothing more for an ended client', async () => {
            const realModule = require('../core/user_login.js');
            const real = realModule.userLogin;
            const smmPath = require.resolve('../core/system_menu_method.js');
            const savedSmm = require.cache[smmPath];

            const { Errors } = require('../core/enig_error.js');
            realModule.userLogin = (client, username, password, cb) =>
                cb(Errors.General('The connection ended', ErrorReasons.ClientEnded));
            delete require.cache[smmPath];

            const calls = [];
            const callingMenu = {
                client: { log: makeLog() },
                menuConfig: { config: {} },
                prevMenu: cb => calls.push('prevMenu') && cb(null),
                gotoMenu: (name, cb) => calls.push('gotoMenu') && cb(null),
                nextMenu: cb => calls.push('nextMenu') && cb(null),
            };

            try {
                const { login } = require('../core/system_menu_method.js');
                const err = await new Promise(resolve =>
                    login(
                        callingMenu,
                        { value: { username: 'somebody', password: 'x' } },
                        {},
                        resolve
                    )
                );
                assert.equal(err, null);
                assert.deepEqual(calls, [], 'no menu change, no logoff');
            } finally {
                realModule.userLogin = real;
                if (savedSmm) {
                    require.cache[smmPath] = savedSmm;
                } else {
                    delete require.cache[smmPath];
                }
            }
        });
    });
});
