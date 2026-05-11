'use strict';

const { dbs } = require('../database');
const Config = require('../config').get;
const User = require('../user');

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const moment = require('moment');

exports.getOrCreateJwtSecret = getOrCreateJwtSecret;
exports.issueTokenPair = issueTokenPair;
exports.rotateRefreshToken = rotateRefreshToken;
exports.revokeRefreshToken = revokeRefreshToken;
exports.resolveAuthenticatedUser = resolveAuthenticatedUser;
exports.requireAuth = requireAuth;
exports.hashApiKey = hashApiKey;
exports.storeApiKey = storeApiKey;
exports.listApiKeys = listApiKeys;
exports.revokeApiKey = revokeApiKey;

const JWT_SECRET_STAT = 'api_jwt_secret';
const ACCESS_TOKEN_TTL_S = 15 * 60; // 15 minutes
const REFRESH_TOKEN_TTL_DAYS = 30;

function getOrCreateJwtSecret() {
    const row = dbs.system
        .prepare('SELECT stat_value FROM system_stat WHERE stat_name = ?')
        .get(JWT_SECRET_STAT);

    if (row) {
        return row.stat_value;
    }

    //  Check config override (e.g. multi-node shared secret)
    const config = Config();
    const override = config.contentServers?.web?.restApi?.jwtSecret;
    const secret = override || crypto.randomBytes(48).toString('hex');

    dbs.system
        .prepare('REPLACE INTO system_stat (stat_name, stat_value) VALUES (?, ?)')
        .run(JWT_SECRET_STAT, secret);

    return secret;
}

function _hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function issueTokenPair(userId, username, groups, cb) {
    const secret = getOrCreateJwtSecret();

    const accessToken = jwt.sign({ userId, username, groups }, secret, {
        expiresIn: ACCESS_TOKEN_TTL_S,
        issuer: 'enigma-bbs',
    });

    const rawRefresh = crypto.randomBytes(48).toString('hex');
    const tokenHash = _hashToken(rawRefresh);
    const now = moment().toISOString();
    const expires = moment().add(REFRESH_TOKEN_TTL_DAYS, 'days').toISOString();

    try {
        dbs.user
            .prepare(
                `INSERT INTO api_refresh_tokens
                    (user_id, token_hash, issued_at, expires_at, revoked)
                 VALUES (?, ?, ?, ?, 0)`
            )
            .run(userId, tokenHash, now, expires);
    } catch (err) {
        return cb(err);
    }

    return cb(null, { accessToken, refreshToken: rawRefresh, expiresIn: ACCESS_TOKEN_TTL_S });
}

function rotateRefreshToken(rawRefresh, cb) {
    const tokenHash = _hashToken(rawRefresh);
    const now = moment();

    const row = dbs.user
        .prepare(
            `SELECT id, user_id, expires_at, revoked FROM api_refresh_tokens
             WHERE token_hash = ?`
        )
        .get(tokenHash);

    if (!row || row.revoked) {
        return cb(new Error('Invalid or revoked refresh token'));
    }

    if (moment(row.expires_at).isBefore(now)) {
        return cb(new Error('Refresh token expired'));
    }

    //  Revoke old token
    dbs.user
        .prepare('UPDATE api_refresh_tokens SET revoked = 1 WHERE id = ?')
        .run(row.id);

    User.getUser(row.user_id, (err, user) => {
        if (err || !user) {
            return cb(err || new Error('User not found'));
        }

        const groups = user.groups || [];
        return issueTokenPair(user.userId, user.username, groups, cb);
    });
}

function revokeRefreshToken(rawRefresh, cb) {
    const tokenHash = _hashToken(rawRefresh);
    dbs.user
        .prepare('UPDATE api_refresh_tokens SET revoked = 1 WHERE token_hash = ?')
        .run(tokenHash);
    return cb(null);
}

function _verifyBearer(authHeader, cb) {
    const token = authHeader.slice(7).trim();
    const secret = getOrCreateJwtSecret();

    jwt.verify(token, secret, { issuer: 'enigma-bbs' }, (err, payload) => {
        if (err) {
            return cb(null, null);
        }
        return cb(null, { userId: payload.userId, username: payload.username, groups: payload.groups || [], scope: 'jwt' });
    });
}

function _verifyApiKey(keyHeader, cb) {
    const keyHash = hashApiKey(keyHeader);

    const row = dbs.user
        .prepare(
            `SELECT id, user_id, scope, revoked FROM api_keys
             WHERE key_hash = ?`
        )
        .get(keyHash);

    if (!row || row.revoked) {
        return cb(null, null);
    }

    //  Touch last_used_at
    dbs.user
        .prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?')
        .run(moment().toISOString(), row.id);

    User.getUser(row.user_id, (err, user) => {
        if (err || !user) {
            return cb(null, null);
        }
        return cb(null, {
            userId: user.userId,
            username: user.username,
            groups: user.groups || [],
            scope: row.scope,
        });
    });
}

function resolveAuthenticatedUser(req, cb) {
    const auth = req.headers['authorization'] || '';

    if (auth.toLowerCase().startsWith('bearer ')) {
        return _verifyBearer(auth, cb);
    }

    const apiKey = req.headers['x-enigma-api-key'];
    if (apiKey) {
        return _verifyApiKey(apiKey, cb);
    }

    return cb(null, null);
}

function requireAuth(req, resp, cb) {
    resolveAuthenticatedUser(req, (err, authedUser) => {
        if (err || !authedUser) {
            const { problemDetail } = require('./util');
            problemDetail(resp, 401, 'Authentication Required', 'Valid credentials must be provided');
            return;
        }
        return cb(authedUser);
    });
}

function hashApiKey(rawKey) {
    return crypto.createHash('sha256').update(rawKey).digest('hex');
}

function storeApiKey(userId, label, scope, cb) {
    const rawKey = crypto.randomBytes(32).toString('hex');
    const keyHash = hashApiKey(rawKey);
    const now = moment().toISOString();

    try {
        dbs.user
            .prepare(
                `INSERT INTO api_keys (user_id, key_hash, label, scope, created_at, revoked)
                 VALUES (?, ?, ?, ?, ?, 0)`
            )
            .run(userId, keyHash, label, scope, now);
    } catch (err) {
        return cb(err);
    }

    return cb(null, rawKey);
}

function listApiKeys(userId, cb) {
    try {
        const rows = dbs.user
            .prepare(
                `SELECT id, label, scope, created_at, last_used_at, revoked
                 FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`
            )
            .all(userId);
        return cb(null, rows);
    } catch (err) {
        return cb(err);
    }
}

function revokeApiKey(keyId, userId, cb) {
    try {
        const info = dbs.user
            .prepare(
                'UPDATE api_keys SET revoked = 1 WHERE id = ? AND user_id = ?'
            )
            .run(keyId, userId);
        return cb(null, info.changes > 0);
    } catch (err) {
        return cb(err);
    }
}
