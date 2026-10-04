'use strict';

const { strict: assert } = require('assert');
const fs = require('fs');
const paths = require('path');
const vm = require('vm');

const API_BASE = '/_enig/api/v1';
const AUTH_PATH = `${API_BASE}/auth`;
const LEGACY_PATH = `${AUTH_PATH}/refresh`;

// A small cookie jar implementing RFC 6265 path matching. Fixtures never
// contain real credentials. The handlers themselves are production source;
// account lookup and token storage are isolated so these tests need no server.
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

function makeRoutes() {
    const routes = [];
    const tokens = new Set();
    let sequence = 0;
    let revokeError;
    const issue = cb => {
        const refreshToken = `fixture-${++sequence}`;
        tokens.add(refreshToken);
        cb(null, { refreshToken, accessToken: 'fixture-access', expiresIn: 900 });
    };
    const dependencies = {
        '../util': {
            API_BASE,
            applyCorsHeaders() {},
            parseJsonBody(req, cb) {
                cb(null, req.body);
            },
            jsonResponse(resp, status, body) {
                resp.status = status;
                resp.body = body;
            },
            problemDetail(resp, status) {
                resp.status = status;
            },
        },
        '../auth': {
            issueTokenPair(_id, _username, _groups, cb) {
                issue(cb);
            },
            rotateRefreshToken(token, cb) {
                if (!tokens.delete(token)) {
                    return cb(new Error('Invalid fixture'));
                }
                issue(cb);
            },
            revokeRefreshToken(token, cb) {
                if (revokeError) {
                    return cb(revokeError);
                }
                tokens.delete(token);
                cb(null);
            },
        },
        '../../user': {
            getUserByUsername(_username, cb) {
                cb(null, {
                    userId: 1,
                    username: 'fixture',
                    groups: [],
                    authenticated: true,
                    authenticateFactor1(_info, next) {
                        next(null);
                    },
                });
            },
        },
    };
    const exports = {};
    vm.runInNewContext(
        fs.readFileSync(paths.join(__dirname, '../core/rest/routes/auth.js'), 'utf8'),
        {
            exports,
            require(name) {
                assert.ok(name in dependencies);
                return dependencies[name];
            },
            Date,
        },
        { filename: 'core/rest/routes/auth.js' }
    );
    exports.register(
        {
            addRoute(route) {
                routes.push(route);
            },
            checkRateLimit() {
                return true;
            },
        },
        { info() {}, error() {} }
    );
    const jar = new CookieJar();
    return {
        jar,
        tokens,
        failRevocation() {
            revokeError = new Error('Fixture storage failure');
        },
        request(action) {
            const url = `${AUTH_PATH}/${action}`;
            const resp = {
                headers: {},
                setHeader(name, value) {
                    this.headers[name] = value;
                },
                writeHead(status) {
                    this.status = status;
                },
                end() {},
            };
            const req = {
                url,
                headers: { cookie: jar.header(url) },
                body: { username: 'fixture', password: 'fixture' },
            };
            routes.find(r => r.path.test(url)).handler(req, resp);
            jar.apply(resp);
            return resp;
        },
        seedLegacy() {
            tokens.add('fixture-legacy');
            jar.apply({
                headers: {
                    'Set-Cookie': `enigma_refresh=fixture-legacy; Path=${LEGACY_PATH}`,
                },
            });
        },
    };
}

describe('REST auth routes: refresh cookie lifecycle', () => {
    it('revokes and clears the login session on logout', () => {
        const ctx = makeRoutes();
        assert.equal(ctx.request('login').status, 200);
        assert.equal(ctx.request('logout').status, 204);
        assert.equal(ctx.tokens.size, 0);
        assert.equal(ctx.jar.cookies.size, 0);
    });

    it('revokes the rotated session on logout', () => {
        const ctx = makeRoutes();
        ctx.request('login');
        assert.equal(ctx.request('refresh').status, 200);
        assert.equal(ctx.request('logout').status, 204);
        assert.equal(ctx.tokens.size, 0);
        assert.equal(ctx.jar.cookies.size, 0);
        assert.equal(ctx.request('refresh').status, 401);
    });

    it('migrates a legacy cookie on refresh and logs the new session out', () => {
        const ctx = makeRoutes();
        ctx.seedLegacy();
        assert.equal(ctx.request('refresh').status, 200);
        assert.equal(ctx.jar.cookies.has(`enigma_refresh:${LEGACY_PATH}`), false);
        assert.equal(ctx.jar.cookies.has(`enigma_refresh:${AUTH_PATH}`), true);
        ctx.request('logout');
        assert.equal(ctx.tokens.size, 0);
        assert.equal(ctx.jar.cookies.size, 0);
    });

    it('expires a legacy cookie when logging in again', () => {
        const ctx = makeRoutes();
        ctx.seedLegacy();
        ctx.request('login');
        assert.equal(ctx.jar.cookies.has(`enigma_refresh:${LEGACY_PATH}`), false);
        assert.equal(ctx.jar.cookies.size, 1);
    });

    it('clears both cookie paths on logout, including without a matching cookie', () => {
        const ctx = makeRoutes();
        ctx.seedLegacy();
        const resp = ctx.request('logout');
        assert.equal(resp.status, 204);
        assert.equal(ctx.jar.cookies.size, 0);
        assert.equal(ctx.request('logout').status, 204);
    });

    it('preserves HttpOnly, Secure and SameSite=Strict on issued and rotated cookies', () => {
        const ctx = makeRoutes();
        for (const action of ['login', 'refresh']) {
            const value = ctx.request(action).headers['Set-Cookie'];
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

    it('does not claim successful logout when token revocation fails', () => {
        const ctx = makeRoutes();
        ctx.request('login');
        ctx.failRevocation();
        assert.equal(ctx.request('logout').status, 500);
        assert.equal(ctx.tokens.size, 1);
    });
});
