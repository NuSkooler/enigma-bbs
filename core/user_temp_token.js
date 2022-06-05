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

                UserDb.run(
                    `INSERT OR REPLACE INTO user_temporary_token (user_id, token, token_type, timestamp)
                    VALUES (?, ?, ?, ?);`,
                    [userId, token, tokenType, getISOTimestampString()],
                    err => {
                        return callback(err, token);
                    }
                );
            },
        ],
        (err, token) => {
            return cb(err, token);
        }
    );
}

function deleteToken(token, cb) {
    UserDb.run(
        `DELETE FROM user_temporary_token
        WHERE token = ?;`,
        [token],
        err => {
            return cb(err);
        }
    );
}

function deleteTokenByUserAndType(userId, tokenType, cb) {
    UserDb.run(
        `DELETE FROM user_temporary_token
        WHERE user_id = ? AND token_type = ?;`,
        [userId, tokenType],
        err => {
            return cb(err);
        }
    );
}

function getTokenInfo(token, cb) {
    async.waterfall(
        [
            callback => {
                UserDb.get(
                    `SELECT user_id, token_type, timestamp
                    FROM user_temporary_token
                    WHERE token = ?;`,
                    [token],
                    (err, row) => {
                        if (err) {
                            return callback(err);
                        }

                        if (!row) {
                            return callback(
                                Errors.DoesNotExist('No entry found for token')
                            );
                        }

                        const info = {
                            userId: row.user_id,
                            tokenType: row.token_type,
                            timestamp: moment(row.timestamp),
                        };
                        return callback(null, info);
                    }
                );
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

    UserDb.run(
        `DELETE FROM user_temporary_token
        WHERE token IN (
            SELECT token
            FROM user_temporary_token
            WHERE token_type = ?
            AND DATETIME("now") >= DATETIME(timestamp, "+${expTime}")
        );`,
        [tokenType],
        err => {
            if (err) {
                Log.warn(
                    { error: err.message, tokenType },
                    'Failed deleting user temporary token'
                );
            }
            return cb(err);
        }
    );
}
