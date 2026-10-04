'use strict';

const {
    jsonResponse,
    problemDetail,
    applyCorsHeaders,
    parseJsonBody,
    API_BASE,
} = require('../util');

const { issueTokenPair, rotateRefreshToken, revokeRefreshToken } = require('../auth');

const User = require('../../user');

const ROUTE_BASE = `${API_BASE}/auth`;
const LEGACY_REFRESH_COOKIE_PATH = `${ROUTE_BASE}/refresh`;
const REFRESH_COOKIE_ATTRIBUTES = 'HttpOnly; Secure; SameSite=Strict';

//  Rate limit: 10 requests per 15 minutes per IP on login
const LOGIN_RATE = { windowMs: 15 * 60 * 1000, maxRequests: 10 };

function expiredRefreshCookie(path) {
    return `enigma_refresh=; ${REFRESH_COOKIE_ATTRIBUTES}; Path=${path}; Max-Age=0`;
}

function setRefreshCookie(resp, tokens) {
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toUTCString();
    resp.setHeader('Set-Cookie', [
        expiredRefreshCookie(LEGACY_REFRESH_COOKIE_PATH),
        `enigma_refresh=${tokens.refreshToken}; ${REFRESH_COOKIE_ATTRIBUTES}; Path=${ROUTE_BASE}; Expires=${expires}`,
    ]);
}

function clearRefreshCookies(resp) {
    resp.setHeader('Set-Cookie', [
        expiredRefreshCookie(LEGACY_REFRESH_COOKIE_PATH),
        expiredRefreshCookie(ROUTE_BASE),
    ]);
}

exports.register = function register(webServer, log) {
    webServer.addRoute({
        method: 'POST',
        path: new RegExp(`^${ROUTE_BASE}/login(?:[?#]|$)`),
        handler: (req, resp) => _loginHandler(req, resp, webServer, log),
    });

    webServer.addRoute({
        method: 'POST',
        path: new RegExp(`^${ROUTE_BASE}/refresh(?:[?#]|$)`),
        handler: (req, resp) => _refreshHandler(req, resp, log),
    });

    webServer.addRoute({
        method: 'POST',
        path: new RegExp(`^${ROUTE_BASE}/logout(?:[?#]|$)`),
        handler: (req, resp) => _logoutHandler(req, resp, log),
    });
};

function _loginHandler(req, resp, webServer, log) {
    applyCorsHeaders(req, resp);

    if (!webServer.checkRateLimit(req, resp, 'rest:login', LOGIN_RATE)) {
        return;
    }

    parseJsonBody(req, (err, body) => {
        if (err || !body?.username || !body?.password) {
            return problemDetail(
                resp,
                400,
                'Bad Request',
                'username and password are required'
            );
        }

        const { username, password } = body;

        User.getUserByUsername(username, (err, user) => {
            if (err || !user) {
                log.info({ username }, 'REST API login failed (user not found)');
                return problemDetail(
                    resp,
                    401,
                    'Authentication Failed',
                    'Invalid credentials'
                );
            }

            user.authenticateFactor1({ username, password }, authErr => {
                if (authErr || !user.authenticated) {
                    log.info({ username }, 'REST API login failed');
                    return problemDetail(
                        resp,
                        401,
                        'Authentication Failed',
                        'Invalid credentials'
                    );
                }

                issueTokenPair(
                    user.userId,
                    user.username,
                    user.groups || [],
                    (err, tokens) => {
                        if (err) {
                            log.error({ err }, 'Failed to issue token pair');
                            return problemDetail(
                                resp,
                                500,
                                'Internal Server Error',
                                'Failed to create session'
                            );
                        }

                        //  Refresh token goes in an HttpOnly cookie; access token in response body
                        setRefreshCookie(resp, tokens);

                        log.info(
                            { userId: user.userId, username: user.username },
                            'REST API login success'
                        );

                        return jsonResponse(resp, 200, {
                            accessToken: tokens.accessToken,
                            tokenType: 'Bearer',
                            expiresIn: tokens.expiresIn,
                        });
                    }
                );
            });
        });
    });
}

function _refreshHandler(req, resp, _log) {
    applyCorsHeaders(req, resp);

    const cookie = req.headers['cookie'] || '';
    const match = /enigma_refresh=([^;]+)/.exec(cookie);
    if (!match) {
        return problemDetail(resp, 401, 'Missing Refresh Token');
    }

    rotateRefreshToken(match[1], (err, tokens) => {
        if (err) {
            return problemDetail(resp, 401, 'Invalid Refresh Token', err.message);
        }

        setRefreshCookie(resp, tokens);

        return jsonResponse(resp, 200, {
            accessToken: tokens.accessToken,
            tokenType: 'Bearer',
            expiresIn: tokens.expiresIn,
        });
    });
}

function _logoutHandler(req, resp, log) {
    applyCorsHeaders(req, resp);

    const cookie = req.headers['cookie'] || '';
    const match = /enigma_refresh=([^;]+)/.exec(cookie);

    if (!match) {
        clearRefreshCookies(resp);
        resp.writeHead(204);
        return resp.end();
    }

    revokeRefreshToken(match[1], err => {
        if (err) {
            log.error('Failed to revoke refresh token');
            return problemDetail(
                resp,
                500,
                'Internal Server Error',
                'Failed to end session'
            );
        }
        clearRefreshCookies(resp);
        resp.writeHead(204);
        return resp.end();
    });
}
