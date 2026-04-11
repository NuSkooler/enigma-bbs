/* jslint node: true */
'use strict';

//  ENiGMA½
const UserDb = require('./database.js').dbs.user;
const { getISOTimestampString } = require('./database.js');
const { Errors } = require('./enig_error.js');
const User = require('./user.js');
const Log = require('./logger.js').log;

//  deps
const crypto = require('crypto');
const async = require('async');
const moment = require('moment');

exports.createToken = createToken;
exports.deleteToken = deleteToken;
exports.deleteTokenByUserAndType = deleteTokenByUserAndType;
exports.getTokenInfo = getTokenInfo;
exports.temporaryTokenMaintenanceTask = temporaryTokenMaintenanceTask;

exports.WellKnownTokenTypes = {
    AuthFactor2OTPRegister: 'auth_factor2_otp_register',
};

function createToken(userId, tokenType, options = { bits: 128 }, cb) {
    async.waterfall(
        [
            callback => {
                return crypto.randomBytes(options.bits, callback);
            },
            (token, callback) => {
                token = token.toString('hex');
                try {
                    UserDb.prepare(
                        `INSERT OR REPLACE INTO user_temporary_token (user_id, token, token_type, timestamp)
                        VALUES (?, ?, ?, ?);`
                    ).run(userId, token, tokenType, getISOTimestampString());
                    return callback(null, token);
                } catch (err) {
                    return callback(err);
                }
            },
        ],
        (err, token) => {
            return cb(err, token);
        }
    );
}

function deleteToken(token, cb) {
    try {
        UserDb.prepare(`DELETE FROM user_temporary_token WHERE token = ?;`).run(token);
        return cb(null);
    } catch (err) {
        return cb(err);
    }
}

function deleteTokenByUserAndType(userId, tokenType, cb) {
    try {
        UserDb.prepare(
            `DELETE FROM user_temporary_token WHERE user_id = ? AND token_type = ?;`
        ).run(userId, tokenType);
        return cb(null);
    } catch (err) {
        return cb(err);
    }
}

function getTokenInfo(token, cb) {
    async.waterfall(
        [
            callback => {
                try {
                    const row = UserDb.prepare(
                        `SELECT user_id, token_type, timestamp
                        FROM user_temporary_token
                        WHERE token = ?;`
                    ).get(token);

                    if (!row) {
                        return callback(Errors.DoesNotExist('No entry found for token'));
                    }

                    return callback(null, {
                        userId: row.user_id,
                        tokenType: row.token_type,
                        timestamp: moment(row.timestamp),
                    });
                } catch (err) {
                    return callback(err);
                }
            },
            (info, callback) => {
                User.getUser(info.userId, (err, user) => {
                    info.user = user;
                    return callback(err, info);
                });
            },
        ],
        (err, info) => {
            return cb(err, info);
        }
    );
}

function temporaryTokenMaintenanceTask(args, cb) {
    const tokenType = args[0];

    if (!tokenType) {
        return Log.error(
            'Cannot run temporary token maintenance task with out specifying "tokenType" as argument 0'
        );
    }

    const expTime = args[1] || '24 hours';

    try {
        UserDb.prepare(
            `DELETE FROM user_temporary_token
            WHERE token IN (
                SELECT token
                FROM user_temporary_token
                WHERE token_type = ?
                AND DATETIME('now') >= DATETIME(timestamp, '+${expTime}')
            );`
        ).run(tokenType);
        return cb(null);
    } catch (err) {
        Log.warn(
            { error: err.message, tokenType },
            'Failed deleting user temporary token'
        );
        return cb(err);
    }
}
