'use strict';

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');
const { EventEmitter } = require('events');
const configModule = require('../core/config');
const { applyUserSchema, applySystemSchema } = require('./helpers/rest_auth_schema');

const dbModule = require('../core/database');

const API_BASE = '/_enig/api/v1';
const AUTH_PATH = `${API_BASE}/auth`;
const LEGACY_PATH = `${AUTH_PATH}/refresh`;

// A small cookie jar implementing RFC 6265 path matching. Fixtures never
// contain real credentials. Route handlers use the real token store in an
// in-memory database; only login account authentication is stubbed.
class CookieJar {
    constructor() {
        this.cookies = new Map();
    }

    apply(resp) {
        const cookies = resp.headers['Set-Cookie'] || [];
        for (const header of Array.isArray(cookies) ? cookies : [cookies]) {
            const [pair, ...attributes] = header.split('; ');
            const separator = pair.indexOf('=');
            const name = pair.slice(0, separator);
            const value = pair.slice(separator + 1);
            const path = attributes.find(a => a.startsWith('Path=')).slice(5);
            const key = `${name}:${path}`;
            if (attributes.includes('Max-Age=0')) {
                this.cookies.delete(key);
            } else {
                this.cookies.set(key, { name, value, path });
            }
        }
    }

    header(requestPath) {
        return [...this.cookies.values()]
            .filter(
                cookie =>
                    requestPath === cookie.path ||
                    (requestPath.startsWith(cookie.path) &&
                        (cookie.path.endsWith('/') ||
                            requestPath[cookie.path.length] === '/'))
            )
            .sort((a, b) => b.path.length - a.path.length)
            .map(cookie => `${cookie.name}=${cookie.value}`)
            .join('; ');
    }
}

let auth;
let User;
let userDb;
let testUserId;

function makeRoutes() {
    const routes = [];
    const errors = [];
    require('../core/rest/routes/auth').register(
        {
            addRoute(route) {
                routes.push(route);
            },
            checkRateLimit() {
                return true;
            },
        },
        {
            info() {},
            error(...args) {
                errors.push(args);
            },
        }
    );
    const jar = new CookieJar();
    return {
        jar,
        errors,
        tokens: {
            get size() {
                return userDb
                    .prepare(
                        'SELECT count(*) AS count FROM api_refresh_tokens WHERE revoked = 0'
                    )
                    .get().count;
            },
        },
        failRevocation() {
            userDb.exec(`CREATE TRIGGER fail_revocation BEFORE UPDATE ON api_refresh_tokens
                BEGIN SELECT RAISE(ABORT, 'Fixture storage failure'); END`);
        },
        request(action) {
            return new Promise((resolve, reject) => {
                const url = `${AUTH_PATH}/${action}`;
                const resp = {
                    headers: {},
                    setHeader(name, value) {
                        this.headers[name] = value;
                    },
                    writeHead(status, headers) {
                        this.status = status;
                        Object.assign(this.headers, headers);
                    },
                    end(body) {
                        this.body = body;
                        jar.apply(this);
                        resolve(this);
                    },
                };
                const req = new EventEmitter();
                req.url = url;
                req.headers = { cookie: jar.header(url) };
                try {
                    routes.find(r => r.path.test(url)).handler(req, resp);
                    req.emit(
                        'data',
                        JSON.stringify({ username: 'fixture', password: 'fixture' })
                    );
                    req.emit('end');
                } catch (err) {
                    reject(err);
                }
            });
        },
        seedLegacy() {
            auth.issueTokenPair(testUserId, 'fixture', [], (err, tokens) => {
                assert.ifError(err);
                jar.apply({
                    headers: {
                        'Set-Cookie': `enigma_refresh=${tokens.refreshToken}; Path=${LEGACY_PATH}`,
                    },
                });
            });
        },
    };
}

describe('REST auth routes: refresh cookie lifecycle', () => {
    let originalUserDb, originalSystemDb, originalLookup, originalConfig;

    beforeEach(() => {
        originalConfig = configModule._pushTestConfig({
            debug: { assertsEnabled: false },
        });
        originalUserDb = dbModule.dbs.user;
        originalSystemDb = dbModule.dbs.system;
        userDb = new Database(':memory:');
        userDb.pragma('foreign_keys = ON');
        dbModule.dbs.user = userDb;
        dbModule.dbs.system = new Database(':memory:');
        applyUserSchema(userDb);
        applySystemSchema(dbModule.dbs.system);
        testUserId = userDb
            .prepare("INSERT INTO user (user_name) VALUES ('fixture')")
            .run().lastInsertRowid;
        for (const path of [
            '../core/user_group',
            '../core/user',
            '../core/rest/auth',
            '../core/rest/routes/auth',
            '../core/rest/util',
        ]) {
            delete require.cache[require.resolve(path)];
        }
        auth = require('../core/rest/auth');
        User = require('../core/user');
        originalLookup = User.getUserByUsername;
        User.getUserByUsername = (_username, cb) =>
            cb(null, {
                userId: testUserId,
                username: 'fixture',
                groups: [],
                authenticated: true,
                authenticateFactor1(_info, next) {
                    next(null);
                },
            });
    });

    afterEach(() => {
        configModule._popTestConfig(originalConfig);
        if (User) User.getUserByUsername = originalLookup;
        if (userDb?.open) userDb.close();
        if (dbModule.dbs.system !== originalSystemDb) dbModule.dbs.system.close();
        dbModule.dbs.user = originalUserDb;
        dbModule.dbs.system = originalSystemDb;
        for (const path of [
            '../core/user_group',
            '../core/user',
            '../core/rest/auth',
            '../core/rest/routes/auth',
            '../core/rest/util',
        ]) {
            delete require.cache[require.resolve(path)];
        }
    });
    it('revokes and clears the login session on logout', async () => {
        const ctx = makeRoutes();
        assert.equal((await ctx.request('login')).status, 200);
        const logout = await ctx.request('logout');
        assert.equal(logout.status, 204);
        assert.equal(logout.body, undefined);
        assert.equal(ctx.tokens.size, 0);
        assert.equal(ctx.jar.cookies.size, 0);
    });

    it('revokes the rotated session on logout', async () => {
        const ctx = makeRoutes();
        await ctx.request('login');
        assert.equal((await ctx.request('refresh')).status, 200);
        const logout = await ctx.request('logout');
        assert.equal(logout.status, 204);
        assert.equal(logout.body, undefined);
        assert.equal(ctx.tokens.size, 0);
        assert.equal(ctx.jar.cookies.size, 0);
        assert.equal((await ctx.request('refresh')).status, 401);
    });

    it('migrates a legacy cookie on refresh and logs the new session out', async () => {
        const ctx = makeRoutes();
        ctx.seedLegacy();
        assert.equal((await ctx.request('refresh')).status, 200);
        assert.equal(ctx.jar.cookies.has(`enigma_refresh:${LEGACY_PATH}`), false);
        assert.equal(ctx.jar.cookies.has(`enigma_refresh:${AUTH_PATH}`), true);
        await ctx.request('logout');
        assert.equal(ctx.tokens.size, 0);
        assert.equal(ctx.jar.cookies.size, 0);
    });

    it('expires a legacy cookie when logging in again', async () => {
        const ctx = makeRoutes();
        ctx.seedLegacy();
        await ctx.request('login');
        assert.equal(ctx.jar.cookies.has(`enigma_refresh:${LEGACY_PATH}`), false);
        assert.equal(ctx.jar.cookies.size, 1);
    });

    it('clears both cookie paths on logout, including without a matching cookie', async () => {
        const ctx = makeRoutes();
        ctx.seedLegacy();
        const resp = await ctx.request('logout');
        assert.equal(resp.status, 204);
        assert.equal(ctx.jar.cookies.size, 0);
        assert.equal((await ctx.request('logout')).status, 204);
    });

    it('preserves HttpOnly, Secure and SameSite=Strict on issued and rotated cookies', async () => {
        const ctx = makeRoutes();
        for (const action of ['login', 'refresh']) {
            const value = (await ctx.request(action)).headers['Set-Cookie'];
            const headers = Array.isArray(value) ? value : [value];
            const issued = headers.find(header => !header.includes('Max-Age=0'));
            assert.ok(issued.includes(`Path=${AUTH_PATH};`));
            for (const attribute of [
                'HttpOnly',
                'Secure',
                'SameSite=Strict',
                'Expires=',
            ]) {
                assert.ok(issued.includes(attribute));
            }
        }
    });

    it('does not claim successful logout when token revocation fails', async () => {
        const ctx = makeRoutes();
        await ctx.request('login');
        ctx.failRevocation();
        const resp = await ctx.request('logout');
        assert.equal(resp.status, 500);
        assert.equal(JSON.parse(resp.body).detail, 'Failed to end session');
        assert.equal(resp.headers['Set-Cookie'], undefined);
        assert.equal(ctx.tokens.size, 1);
        assert.equal(ctx.jar.cookies.size, 1);
        const [fields, message] = ctx.errors[0];
        assert.equal(fields.err.message, 'Fixture storage failure');
        assert.equal(message, 'Failed to revoke refresh token');
    });
});
