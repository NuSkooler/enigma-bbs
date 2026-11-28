'use strict';

//
//  userLogin() sent UserLogin before postLoginPrep() ran. When the setup
//  failed (a database write, say), the caller was told the login failed,
//  but UserLogin had already gone out and the client's User stayed filled
//  in. Now UserLogin goes out only once the setup succeeds, and a failed
//  setup leaves the same User reset in place (#1182).
//

const { strict: assert } = require('assert');
const Module = require('module');

function makeLog() {
    const log = { fields: {}, child: () => log };
    ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].forEach(level => {
        log[level] = () => true;
    });
    return log;
}

describe('userLogin(): a login whose setup fails (#1182)', () => {
    let userLogin;
    let emitted;
    let persistErr;
    const loginModulePath = require.resolve('../core/user_login.js');

    //  postLoginPrep() moves the caller to a suitable area (the stored one is
    //  not configured), which is a write; |persistErr| makes it fail
    const STUBS = {
        './theme.js': { setClientTheme: () => {} },
        './client_connections.js': { clientConnections: [] },
        './logger.js': { log: { child: () => makeLog() } },
        './events.js': {
            getSystemEvents: () => ({ UserLogin: 'user login' }),
            emit: (name, info) => emitted.push({ name, info }),
        },
        './user.js': { AuthFactor1Types: { Password: 'password' } },
        './message_area.js': {
            getMessageConferenceByTag: () => ({}),
            getMessageAreaByTag: () => null,
            getSuitableMessageConfAndAreaTags: () => ['local', 'local_general'],
        },
        './file_base_area.js': {
            getFileAreaByTag: () => ({}),
            getDefaultFileAreaTag: () => '',
        },
        './config.js': {
            get: () => ({
                users: { badUserNames: [], failedLogin: { disconnect: 3 } },
            }),
        },
    };

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

        const savedCacheEntry = require.cache[loginModulePath];
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
        emitted = [];
        persistErr = null;
    });

    //  Not authenticated at the end of factor 1 (a 2FA user), so recordLogin()
    //  stays out of it.
    function login() {
        const client = {
            clientEnded: false,
            log: makeLog(),
            session: { uniqueId: 'session-1' },
            remoteAddress: '192.0.2.20',
            acs: {
                hasMessageConfRead: () => true,
                hasMessageAreaRead: () => true,
                hasFileAreaRead: () => true,
            },
        };
        const user = {
            userId: 0,
            properties: {},
            resets: 0,
            getProperty: name => user.properties[name],
            persistProperties: (props, cb) => {
                if (persistErr) {
                    return cb(persistErr);
                }
                Object.assign(user.properties, props);
                return cb(null);
            },
            authenticateFactor1: (authInfo, cb) => {
                user.userId = 42;
                user.username = 'somebody';
                return setImmediate(() => cb(null));
            },
            reset: () => {
                ++user.resets;
                user.userId = 0;
                user.username = '';
                user.properties = {};
                delete user.sessionId;
            },
        };
        client.user = user;

        return new Promise(resolve =>
            userLogin(client, 'somebody', 'secret', err => resolve({ err, client, user }))
        );
    }

    it('sends no UserLogin, and leaves the same User reset to nobody', async () => {
        persistErr = new Error('SQLITE_FULL');
        const { err, client, user } = await login();
        assert.equal(err, persistErr);
        assert.deepEqual(emitted, []);
        assert.equal(client.user, user, 'the same User, reset in place');
        assert.equal(user.resets, 1);
        assert.equal(user.userId, 0);
        assert.equal(user.username, '');
        assert.equal(user.sessionId, undefined);
    });

    it('a login whose setup succeeds sends UserLogin once, with the user', async () => {
        const { err, user } = await login();
        assert.ifError(err);
        assert.equal(emitted.length, 1);
        assert.equal(emitted[0].name, 'user login');
        assert.equal(emitted[0].info.user, user);
        assert.equal(user.userId, 42);
        assert.equal(user.resets, 0);
    });
});
