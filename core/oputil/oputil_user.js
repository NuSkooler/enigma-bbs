/* jslint node: true */
/* eslint-disable no-console */
'use strict';

const {
    printUsageAndSetExitCode,
    getAnswers,
    ExitCodes,
    argv,
    initConfigAndDatabases,
} = require('./oputil_common.js');
const getHelpFor = require('./oputil_help.js').getHelpFor;
const Errors = require('../enig_error.js').Errors;
const UserProps = require('../user_property.js');

// deps
const async = require('async');
const _ = require('lodash');
const moment = require('moment');
const fs = require('fs-extra');
const Table = require('easy-table');

exports.handleUserCommand = handleUserCommand;

//  exported for testing
exports.findDriftedAchievementStats = findDriftedAchievementStats;
exports.applyAchievementStats = applyAchievementStats;
exports.findPostAreasByUser = findPostAreasByUser;
exports.applyPostAreas = applyPostAreas;

function initAndGetUser(userName, cb) {
    async.waterfall(
        [
            function init(callback) {
                initConfigAndDatabases(callback);
            },
            function getUserObject(callback) {
                const User = require('../../core/user.js');
                User.getUserIdAndName(userName, (err, userId) => {
                    if (err) {
                        //  try user ID if number was supplied
                        if (_.isNumber(userName)) {
                            return User.getUser(parseInt(userName), callback);
                        }
                        return callback(err);
                    }
                    return User.getUser(userId, callback);
                });
            },
        ],
        (err, user) => {
            return cb(err, user);
        }
    );
}

function setAccountStatus(user, status) {
    if (argv._.length < 3) {
        return printUsageAndSetExitCode(getHelpFor('User'), ExitCodes.ERROR);
    }

    const AccountStatus = require('../../core/user.js').AccountStatus;

    status = {
        activate: AccountStatus.active,
        deactivate: AccountStatus.inactive,
        disable: AccountStatus.disabled,
        lock: AccountStatus.locked,
    }[status];

    const statusDesc = _.invert(AccountStatus)[status];

    async.series(
        [
            callback => {
                return user.persistProperty(UserProps.AccountStatus, status, callback);
            },
            callback => {
                if (AccountStatus.active !== status) {
                    return callback(null);
                }

                return user.unlockAccount(callback);
            },
        ],
        err => {
            if (err) {
                process.exitCode = ExitCodes.ERROR;
                console.error(err.message);
            } else {
                console.info(`User status set to ${statusDesc}`);
            }
        }
    );
}

function setUserPassword(user) {
    if (argv._.length < 4) {
        return printUsageAndSetExitCode(getHelpFor('User'), ExitCodes.ERROR);
    }

    async.waterfall(
        [
            function validate(callback) {
                //	:TODO: prompt if no password provided (more secure, no history, etc.)
                const password = argv._[argv._.length - 1];
                if (0 === password.length) {
                    return callback(Errors.Invalid('Invalid password'));
                }
                return callback(null, password);
            },
            function set(password, callback) {
                user.setNewAuthCredentials(password, err => {
                    if (err) {
                        process.exitCode = ExitCodes.BAD_ARGS;
                    }
                    return callback(err);
                });
            },
        ],
        err => {
            if (err) {
                console.error(err.message);
            } else {
                console.info('New password set');
            }
        }
    );
}

function removeUserRecordsFromDbAndTable(dbName, tableName, userId, col, cb) {
    const db = require('../../core/database.js').dbs[dbName];
    try {
        db.prepare(
            `DELETE FROM ${tableName}
        WHERE ${col} = ?;`
        ).run(userId);
        return cb(null);
    } catch (err) {
        return cb(err);
    }
}

function removeUser(user) {
    async.series(
        [
            callback => {
                if (user.isRoot()) {
                    return callback(Errors.Invalid('Cannot delete root/SysOp user!'));
                }

                return callback(null);
            },
            callback => {
                if (false === argv.prompt) {
                    return callback(null);
                }

                console.info('About to permanently delete the following user:');
                console.info(`Username : ${user.username}`);
                console.info(
                    `Real name: ${user.properties[UserProps.RealName] || 'N/A'}`
                );
                console.info(`User ID  : ${user.userId}`);
                console.info('WARNING: This cannot be undone!');
                getAnswers(
                    [
                        {
                            name: 'proceed',
                            message: `Proceed in deleting ${user.username}?`,
                            type: 'confirm',
                        },
                    ],
                    answers => {
                        if (answers.proceed) {
                            return callback(null);
                        }
                        return callback(Errors.General('User canceled'));
                    }
                );
            },
            callback => {
                //  Notify AP followers of actor deletion before wiping DB records.
                //  Best-effort: failure here does not abort the delete.
                const ActivityPubSettings = require('../activitypub/settings');
                const apSettings = ActivityPubSettings.fromUser(user);
                if (!apSettings.enabled) {
                    return callback(null);
                }

                const { sendActorDelete } = require('../activitypub/boost_util');
                console.info('Notifying ActivityPub followers of account deletion…');
                sendActorDelete(user, err => {
                    if (err) {
                        console.warn(
                            `Warning: failed to send Delete{Actor} to followers: ${err.message}`
                        );
                    }
                    return callback(null); // always continue
                });
            },
            callback => {
                //  op has confirmed they are wanting ready to proceed (or passed --no-prompt)
                const DeleteFrom = {
                    message: ['user_message_area_last_read'],
                    system: ['user_event_log'],
                    user: ['user_group_member', 'user'],
                    file: ['file_user_rating'],
                };

                async.eachSeries(
                    Object.keys(DeleteFrom),
                    (dbName, nextDbName) => {
                        const tables = DeleteFrom[dbName];
                        async.eachSeries(
                            tables,
                            (tableName, nextTableName) => {
                                const col =
                                    'user' === dbName && 'user' === tableName
                                        ? 'id'
                                        : 'user_id';
                                removeUserRecordsFromDbAndTable(
                                    dbName,
                                    tableName,
                                    user.userId,
                                    col,
                                    err => {
                                        return nextTableName(err);
                                    }
                                );
                            },
                            err => {
                                return nextDbName(err);
                            }
                        );
                    },
                    err => {
                        return callback(err);
                    }
                );
            },
            callback => {
                //
                //  Clean up *private* messages *to* this user
                //
                const Message = require('../../core/message.js');
                const MsgDb = require('../../core/database.js').dbs.message;

                const filter = {
                    resultType: 'id',
                    privateTagUserId: user.userId,
                };
                Message.findMessages(filter, (err, ids) => {
                    if (err) {
                        return callback(err);
                    }

                    async.eachSeries(
                        ids,
                        (messageId, nextMessageId) => {
                            try {
                                MsgDb.prepare(
                                    `DELETE FROM message
                            WHERE message_id = ?;`
                                ).run(messageId);
                                return nextMessageId(null);
                            } catch (err) {
                                return nextMessageId(err);
                            }
                        },
                        err => {
                            return callback(err);
                        }
                    );
                });
            },
        ],
        err => {
            if (err) {
                return console.error(err.reason ? err.reason : err.message);
            }

            console.info('User has been deleted.');
        }
    );
}

function renameUser(user) {
    if (argv._.length < 3) {
        return printUsageAndSetExitCode(getHelpFor('User'), ExitCodes.ERROR);
    }

    const newUserName = argv._[argv._.length - 1];

    async.series(
        [
            callback => {
                const {
                    validateUserNameAvail,
                } = require('../../core/system_view_validate.js');
                return validateUserNameAvail(newUserName, callback);
            },
            callback => {
                const userDb = require('../../core/database.js').dbs.user;
                try {
                    userDb
                        .prepare(
                            `UPDATE user
                    SET user_name = ?
                    WHERE id = ?;`
                        )
                        .run(newUserName, user.userId);
                    return callback(null);
                } catch (err) {
                    return callback(err);
                }
            },
        ],
        err => {
            if (err) {
                return console.error(err.reason ? err.reason : err.message);
            }
            return console.info(`User "${user.username}" renamed to "${newUserName}"`);
        }
    );
}

function modUserGroups(user) {
    if (argv._.length < 3) {
        return printUsageAndSetExitCode(getHelpFor('User'), ExitCodes.ERROR);
    }

    let groupName = argv._[argv._.length - 1].toString().replace(/["']/g, ''); //	remove any quotes - necessary to allow "-foo"
    let action = groupName[0]; //	+ or -

    if ('-' === action || '+' === action || '~' === action) {
        groupName = groupName.substr(1);
    }

    action = action || '+';

    if (0 === groupName.length) {
        return printUsageAndSetExitCode(getHelpFor('User'), ExitCodes.ERROR);
    }

    //
    //	Groups are currently arbitrary, so do a slight validation
    //
    if (!/[A-Za-z0-9]+/.test(groupName)) {
        process.exitCode = ExitCodes.BAD_ARGS;
        return console.error('Bad group name');
    }

    function done(err) {
        if (err) {
            process.exitCode = ExitCodes.BAD_ARGS;
            console.error(err.message);
        } else {
            console.info('User groups modified');
        }
    }

    const UserGroup = require('../../core/user_group.js');
    if ('-' === action || '~' === action) {
        UserGroup.removeUserFromGroup(user.userId, groupName, done);
    } else {
        UserGroup.addUserToGroup(user.userId, groupName, done);
    }
}

function setUserTimeLimit(user) {
    if (argv._.length < 3) {
        return printUsageAndSetExitCode(getHelpFor('User'), ExitCodes.ERROR);
    }

    const value = argv._[argv._.length - 1].toString();

    function done(err, desc) {
        if (err) {
            process.exitCode = ExitCodes.ERROR;
            return console.error(err.message);
        }
        return console.info(`Daily time limit for ${user.username}: ${desc}`);
    }

    //
    //  "clear" removes the override so the account falls back through the
    //  users.timeLimits bands again. Without it an operator can only ever
    //  replace an override, never undo one.
    //
    if ('clear' === value.toLowerCase()) {
        return user.removeProperty(UserProps.TimeMinutesPerDay, err =>
            done(err, 'cleared (falls back to users.timeLimits)')
        );
    }

    const minutes = parseInt(value, 10);
    if (isNaN(minutes) || minutes < 0 || String(minutes) !== value) {
        process.exitCode = ExitCodes.BAD_ARGS;
        return console.error('Expected a number of minutes, 0, or "clear"');
    }

    //  0 is unlimited, matching the users.timeLimits convention
    return user.persistProperty(UserProps.TimeMinutesPerDay, minutes, err =>
        done(err, 0 === minutes ? '0 (unlimited)' : `${minutes} minute(s) per day`)
    );
}

function formatSSHKeyInfo(user) {
    const ssh2 = require('ssh2');
    const crypto = require('crypto');

    const storedKey = user.getProperty(UserProps.SSHPubKey);
    if (!storedKey) {
        return 'none';
    }

    const parts = storedKey.split(/\s+/);
    const algo = parts[0] || 'unknown';
    const comment = parts.length > 2 ? parts.slice(2).join(' ') : '';

    const parsed = ssh2.utils.parseKey(storedKey);
    const keyObject = Array.isArray(parsed) ? parsed[0] : parsed;

    let fingerprint = 'unavailable';
    if (
        keyObject &&
        !(keyObject instanceof Error) &&
        _.isFunction(keyObject.getPublicSSH)
    ) {
        fingerprint =
            'SHA256:' +
            crypto.createHash('sha256').update(keyObject.getPublicSSH()).digest('base64');
    }

    return comment
        ? `${algo} (${fingerprint})  comment: ${comment}`
        : `${algo} (${fingerprint})`;
}

function showUserInfo(user) {
    const User = require('../user');
    const ActivityPubSettings = require('../activitypub/settings');
    const { OTPTypes } = require('../user_2fa_otp');

    const statusDesc = () => {
        const status = user.properties[UserProps.AccountStatus];
        return _.invert(User.AccountStatus)[status] || 'N/A';
    };

    const created = () => {
        const ac = user.properties[UserProps.AccountCreated];
        return ac ? moment(ac).format() : 'N/A';
    };

    const lastLogin = () => {
        const ll = user.properties[UserProps.LastLoginTs];
        return ll ? moment(ll).format() : 'N/A';
    };

    const propOrNA = p => {
        return user.properties[p] || 'N/A';
    };

    const currentTheme = () => {
        return user.properties[UserProps.ThemeId];
    };

    //
    //  Only the per-account override is shown: the users.timeLimits bands
    //  resolve against a live session's ACS, which oputil does not have.
    //
    const timeLimitDesc = () => {
        const minutes = parseInt(user.properties[UserProps.TimeMinutesPerDay], 10);
        if (isNaN(minutes)) {
            return 'default (users.timeLimits)';
        }
        return minutes > 0 ? `${minutes} minute(s)` : 'unlimited';
    };

    //
    //  Tracked whether or not anything is metered, so this is the "time on
    //  today" figure even on a board with no limits. Stale by definition if
    //  the stamp is not today's: the counters are reset lazily, on the
    //  user's next read or tick, not by a scheduled job.
    //
    const timeUsedTodayDesc = () => {
        const date = user.properties[UserProps.TimeUsedTodayDate];
        if (!date) {
            return 'N/A';
        }
        const minutes =
            parseInt(user.properties[UserProps.TimeUsedTodayMinutes], 10) || 0;
        const today = moment().format('YYYY-MM-DD');
        return date === today
            ? `${minutes} minute(s)`
            : `0 minute(s) (last on ${date}: ${minutes})`;
    };

    const apSettings = ActivityPubSettings.fromUser(user);

    let infoDump = `User information:
Username     : ${user.username}${user.isRoot() ? ' (root/SysOp)' : ''}
Real name    : ${propOrNA(UserProps.RealName)}
ID           : ${user.userId}
Status       : ${statusDesc()}
Groups       : ${user.groups.join(', ')}
Theme ID     : ${currentTheme()}
Created      : ${created()}
Last login   : ${lastLogin()}
Login count  : ${propOrNA(UserProps.LoginCount)}
Email        : ${propOrNA(UserProps.EmailAddress)}
Location     : ${propOrNA(UserProps.Location)}
Affiliations : ${propOrNA(UserProps.Affiliations)}
ActivityPub  : ${apSettings.enabled ? 'enabled' : 'disabled'}`;

    const otp = user.getProperty(UserProps.AuthFactor2OTP);
    const oppDesc =
        {
            [OTPTypes.RFC6238_TOTP]: 'RFC6238 TOTP',
            [OTPTypes.RFC4266_HOTP]: 'rfc4266 HOTP',
            [OTPTypes.GoogleAuthenticator]: 'GoogleAuth',
        }[otp] || 'disabled';
    infoDump += `\nTime/day     : ${timeLimitDesc()}`;
    infoDump += `\nTime today   : ${timeUsedTodayDesc()}`;
    infoDump += `\n2FA OTP      : ${oppDesc}`;
    infoDump += `\nSSH key      : ${formatSSHKeyInfo(user)}`;

    if (argv.security && otp) {
        const backupCodesOrNa = () => {
            try {
                return JSON.parse(
                    user.getProperty(UserProps.AuthFactor2OTPBackupCodes)
                ).join(', ');
            } catch (e) {
                return 'N/A';
            }
        };
        infoDump += `\nOTP secret   : ${
            user.getProperty(UserProps.AuthFactor2OTPSecret) || 'N/A'
        }
OTP Backup   : ${backupCodesOrNa()}`;
    }

    console.info(infoDump);
}

function twoFactorAuthOTP(user) {
    if (argv._.length < 4) {
        return printUsageAndSetExitCode(getHelpFor('User'), ExitCodes.ERROR);
    }

    const {
        OTPTypes,
        prepareOTP,
        createBackupCodes,
    } = require('../../core/user_2fa_otp.js');

    let otpType = argv._[argv._.length - 1];

    //  shortcut for removal
    if ('disable' === otpType) {
        const props = [
            UserProps.AuthFactor2OTP,
            UserProps.AuthFactor2OTPSecret,
            UserProps.AuthFactor2OTPBackupCodes,
        ];
        return user.removeProperties(props, err => {
            if (err) {
                console.error(err.message);
            } else {
                console.info(`2FA OTP disabled for ${user.username}`);
            }
        });
    }

    async.waterfall(
        [
            function validate(callback) {
                //  :TODO: Prompt for if not supplied
                //  allow aliases for OTP types
                otpType =
                    {
                        google: OTPTypes.GoogleAuthenticator,
                        hotp: OTPTypes.RFC4266_HOTP,
                        totp: OTPTypes.RFC6238_TOTP,
                    }[otpType] || otpType;
                otpType = _.find(OTPTypes, t => {
                    return t.toLowerCase() === otpType.toLowerCase();
                });
                if (!otpType) {
                    return callback(Errors.Invalid('Invalid OTP type'));
                }
                return callback(null, otpType);
            },
            function prepare(otpType, callback) {
                const otpOpts = {
                    username: user.username,
                    qrType: argv['qr-type'] || 'ascii',
                };
                prepareOTP(otpType, otpOpts, (err, otpInfo) => {
                    return callback(
                        err,
                        Object.assign(otpInfo, {
                            otpType,
                            backupCodes: createBackupCodes(),
                        })
                    );
                });
            },
            function storeOrDisplayQR(otpInfo, callback) {
                if (!argv.out || !otpInfo.qr) {
                    return callback(null, otpInfo);
                }

                fs.writeFile(argv.out, otpInfo.qr, 'utf8', err => {
                    return callback(err, otpInfo);
                });
            },
            function persist(otpInfo, callback) {
                const props = {
                    [UserProps.AuthFactor2OTP]: otpInfo.otpType,
                    [UserProps.AuthFactor2OTPSecret]: otpInfo.secret,
                    [UserProps.AuthFactor2OTPBackupCodes]: JSON.stringify(
                        otpInfo.backupCodes
                    ),
                };
                user.persistProperties(props, err => {
                    return callback(err, otpInfo);
                });
            },
        ],
        (err, otpInfo) => {
            if (err) {
                console.error(err.message);
            } else {
                console.info(`OTP enabled for  : ${user.username}`);
                console.info(`Secret           : ${otpInfo.secret}`);
                console.info(`Backup codes     : ${otpInfo.backupCodes.join(', ')}`);

                if (otpInfo.qr) {
                    if (!argv.out) {
                        console.info('--- Begin QR ---');
                        console.info(otpInfo.qr);
                        console.info('--- End QR ---');
                    } else {
                        console.info(`QR code saved to ${argv.out}`);
                    }
                }
            }
        }
    );
}

function listUsers() {
    //  oputil user list [disabled|inactive|active|locked|all]
    //  :TODO: --created-since SPEC and --last-called SPEC
    //  --created-since SPEC
    //  SPEC can be TIMESTAMP or e.g. "-1hour" or "-90days"
    let listWhat;
    if (argv._.length > 2) {
        listWhat = argv._[argv._.length - 1];
    } else {
        listWhat = 'all';
    }

    const sortBy = (argv.sort || 'id').toLowerCase();

    const User = require('../../core/user');
    if (!['all'].concat(Object.keys(User.AccountStatus)).includes(listWhat)) {
        return printUsageAndSetExitCode(getHelpFor('User'), ExitCodes.ERROR);
    }

    async.waterfall(
        [
            callback => {
                const UserProps = require('../../core/user_property');

                const userListOpts = {
                    properties: [
                        UserProps.RealName,
                        UserProps.AccountStatus,
                        UserProps.AccountCreated,
                        UserProps.LastLoginTs,
                        UserProps.LoginCount,
                    ],
                };

                User.getUserList(userListOpts, (err, userList) => {
                    if (err) {
                        return callback(err);
                    }

                    if ('all' === listWhat) {
                        return callback(null, userList);
                    }

                    const accountStatusFilter = User.AccountStatus[listWhat].toString();

                    return callback(
                        null,
                        userList.filter(user => {
                            return user[UserProps.AccountStatus] === accountStatusFilter;
                        })
                    );
                });
            },
            (userList, callback) => {
                // default sort: by ID
                const sortById = (left, right) => {
                    return left.userId - right.userId;
                };

                const sortByLogin = prop => (left, right) => {
                    return parseInt(right[prop]) - parseInt(left[prop]);
                };

                const sortByString = prop => (left, right) => {
                    return left[prop].localeCompare(right[prop], {
                        sensitivity: false,
                        numeric: true,
                    });
                };

                const sortByTimestamp = prop => (left, right) => {
                    return moment(right[prop]) - moment(left[prop]);
                };

                let sorter;
                switch (sortBy) {
                    case 'username':
                        sorter = sortByString('userName');
                        break;
                    case 'realname':
                        sorter = sortByString(UserProps.RealName);
                        break;
                    case 'status':
                        sorter = sortByString(UserProps.AccountStatus);
                        break;
                    case 'created':
                        sorter = sortByTimestamp(UserProps.AccountCreated);
                        break;
                    case 'lastlogin':
                        sorter = sortByTimestamp(UserProps.LastLoginTs);
                        break;
                    case 'logins':
                        sorter = sortByLogin(UserProps.LoginCount);
                        break;

                    case 'id':
                    default:
                        sorter = sortById;
                        break;
                }

                userList.sort(sorter);

                const StatusNames = _.invert(User.AccountStatus);

                const propOrNA = (user, prop) => {
                    return user[prop] || 'N/A';
                };

                const timestampOrNA = (user, prop, format) => {
                    let ts = user[prop];
                    return ts ? moment(ts).format(format) : 'N/A';
                };

                const makeAccountStatus = status => {
                    return StatusNames[status] || 'N/A';
                };

                const table = new Table();
                userList.forEach(user => {
                    table.cell('ID', user.userId);
                    table.cell('Username', user.userName);
                    table.cell('Real Name', user[UserProps.RealName]);
                    table.cell(
                        'Status',
                        makeAccountStatus(user[UserProps.AccountStatus])
                    );
                    table.cell(
                        'Created',
                        timestampOrNA(user, UserProps.AccountCreated, 'YYYY-MM-DD')
                    );
                    table.cell(
                        'Last Login',
                        timestampOrNA(user, UserProps.LastLoginTs, 'YYYY-MM-DD HH::mm')
                    );
                    table.cell('Logins', propOrNA(user, UserProps.LoginCount));

                    table.newRow();
                });

                console.info(table.toString());

                return callback(null);
            },
        ],
        err => {
            if (err) {
                return console.error(err.reason ? err.reason : err.message);
            }
        }
    );
}

function importSSHKey(user) {
    if (argv._.length < 4) {
        return printUsageAndSetExitCode(getHelpFor('User'), ExitCodes.ERROR);
    }

    const keyFilePath = argv._[argv._.length - 1];

    async.waterfall(
        [
            callback => fs.readFile(keyFilePath, 'utf8', callback),
            (keyContent, callback) => {
                const trimmed = keyContent.trim();
                if (!trimmed) {
                    return callback(new Error(`File is empty: ${keyFilePath}`));
                }
                return callback(null, trimmed);
            },
            (keyContent, callback) => user.setPublicSSHKey(keyContent, callback),
        ],
        err => {
            if (err) {
                process.exitCode = ExitCodes.ERROR;
                return console.error(`Failed to import SSH key: ${err.message}`);
            }
            console.info(
                `SSH public key imported for "${user.username}"\n  ${formatSSHKeyInfo(
                    user
                )}`
            );
        }
    );
}

function removeSSHKey(user) {
    const storedKey = user.getProperty(UserProps.SSHPubKey);
    if (!storedKey) {
        process.exitCode = ExitCodes.ERROR;
        return console.error(`No SSH public key on file for "${user.username}"`);
    }

    user.setPublicSSHKey('', err => {
        if (err) {
            process.exitCode = ExitCodes.ERROR;
            return console.error(`Failed to remove SSH key: ${err.message}`);
        }
        console.info(`SSH public key removed for "${user.username}"`);
    });
}

//
//  achievement_total_count/achievement_total_points are running totals kept by
//  StatLog. Before the duplicate-award fix, a retroactive achievement re-queued
//  every lower tier the user already held; record() bumped both totals before
//  INSERT OR IGNORE dropped the duplicate row, so the totals drifted above
//  user_achievement and never came back down.
//
//  user_achievement is the record of what was actually earned, so recompute
//  from it. Users who have never earned anything carry no totals at all and are
//  left alone; only rows that already exist are corrected.
//
function findDriftedAchievementStats(db) {
    return db
        .prepare(
            `SELECT u.id AS user_id, u.user_name,
                COALESCE(a.earned_count, 0) AS actual_count,
                COALESCE(a.earned_points, 0) AS actual_points,
                CAST(pc.prop_value AS INTEGER) AS stored_count,
                CAST(pp.prop_value AS INTEGER) AS stored_points
            FROM user u
            LEFT JOIN (
                SELECT user_id, COUNT(*) AS earned_count, SUM(points) AS earned_points
                FROM user_achievement
                GROUP BY user_id
            ) a ON a.user_id = u.id
            LEFT JOIN user_property pc
                ON pc.user_id = u.id AND pc.prop_name = 'achievement_total_count'
            LEFT JOIN user_property pp
                ON pp.user_id = u.id AND pp.prop_name = 'achievement_total_points'
            WHERE (pc.prop_value IS NOT NULL OR pp.prop_value IS NOT NULL)
              AND (COALESCE(CAST(pc.prop_value AS INTEGER), -1) <> COALESCE(a.earned_count, 0)
                OR COALESCE(CAST(pp.prop_value AS INTEGER), -1) <> COALESCE(a.earned_points, 0))
            ORDER BY (COALESCE(CAST(pp.prop_value AS INTEGER), 0) - COALESCE(a.earned_points, 0)) DESC;`
        )
        .all();
}

function applyAchievementStats(db, rows) {
    const upsert = db.prepare(
        `INSERT INTO user_property (user_id, prop_name, prop_value)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id, prop_name) DO UPDATE SET prop_value = excluded.prop_value;`
    );

    db.transaction(() => {
        rows.forEach(row => {
            upsert.run(
                row.user_id,
                UserProps.AchievementTotalCount,
                `${row.actual_count}`
            );
            upsert.run(
                row.user_id,
                UserProps.AchievementTotalPoints,
                `${row.actual_points}`
            );
        });
    })();
}

//
//  Reconstruct which areas each user has posted in, for boards that were already
//  running before post_area_tags existed. Without this everyone starts at zero
//  and has to revisit areas they posted in years ago.
//
//  Two things make the message base awkward to read for this. Echomail carries
//  the *remote* poster's handle in from_user_name, and some of those collide with
//  local account names -- on the board this was written against, four handles
//  with hundreds of messages between them turned out to be other people on other
//  systems entirely. Messages that arrived over FTN carry an ftn_origin property,
//  so excluding those leaves what was actually typed here.
//
//  The result is a floor rather than an exact history: areas prune old messages,
//  so a user's earliest areas may no longer be represented. Posting in one of
//  them again simply adds it back.
//
function findPostAreasByUser(msgDb, userDb) {
    const MessageConst = require('../message_const.js');

    //  private mail is not an area anyone "posted in", and the ActivityPub
    //  shared inbox is a holding pen rather than a place on the board
    const notAreas = [MessageConst.WellKnownAreaTags.Private].concat(
        MessageConst.WellKnownExternalAreaTags
    );

    const pairs = msgDb
        .prepare(
            `SELECT DISTINCT m.from_user_name AS user_name, m.area_tag AS area_tag
            FROM message m
            WHERE m.area_tag NOT IN (${notAreas.map(() => '?').join(', ')})
              AND NOT EXISTS (
                  SELECT 1 FROM message_meta mm
                  WHERE mm.message_id = m.message_id
                    AND mm.meta_category = 'FtnProperty'
                    AND mm.meta_name = 'ftn_origin'
              );`
        )
        .all(notAreas);

    const userIdByName = new Map(
        userDb
            .prepare('SELECT id, user_name FROM user;')
            .all()
            .map(row => [row.user_name, row.id])
    );

    const found = new Map();
    pairs.forEach(pair => {
        const userId = userIdByName.get(pair.user_name);
        if (!userId) {
            return; //  a remote poster, or an account since removed
        }
        if (!found.has(userId)) {
            found.set(userId, { userId, userName: pair.user_name, areaTags: new Set() });
        }
        found.get(userId).areaTags.add(pair.area_tag);
    });

    //  Merge with anything already recorded -- the set only ever grows, and this
    //  may be run on a board that has been tracking live for a while.
    const rows = [];
    found.forEach(entry => {
        const stored = userDb
            .prepare(
                'SELECT prop_value FROM user_property WHERE user_id = ? AND prop_name = ?;'
            )
            .get(entry.userId, UserProps.MessagePostAreaTags);

        let existing = [];
        if (stored && stored.prop_value) {
            try {
                const parsed = JSON.parse(stored.prop_value);
                if (Array.isArray(parsed)) {
                    existing = parsed;
                }
            } catch (e) {
                existing = [];
            }
        }

        const merged = new Set(existing);
        const before = merged.size;
        entry.areaTags.forEach(t => merged.add(t));

        if (merged.size === before) {
            return; //  nothing the board did not already know
        }

        rows.push({
            userId: entry.userId,
            userName: entry.userName,
            areaTags: Array.from(merged).sort(),
            was: before,
        });
    });

    return rows.sort((a, b) => b.areaTags.length - a.areaTags.length);
}

function applyPostAreas(db, rows) {
    const upsert = db.prepare(
        `INSERT INTO user_property (user_id, prop_name, prop_value)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id, prop_name) DO UPDATE SET prop_value = excluded.prop_value;`
    );

    db.transaction(() => {
        rows.forEach(row => {
            upsert.run(
                row.userId,
                UserProps.MessagePostAreaTags,
                JSON.stringify(row.areaTags)
            );
            upsert.run(
                row.userId,
                UserProps.MessagePostAreaCount,
                `${row.areaTags.length}`
            );
        });
    })();
}

function backfillPostAreas() {
    const dryRun = true === argv['dry-run'];
    const dbs = require('../database.js').dbs;

    let rows;
    try {
        rows = findPostAreasByUser(dbs.message, dbs.user);
    } catch (err) {
        process.exitCode = ExitCodes.ERROR;
        return console.error(`Failed to inspect the message base: ${err.message}`);
    }

    if (0 === rows.length) {
        return console.info("Every user's posted-area list is already up to date.");
    }

    const table = new Table();
    rows.forEach(row => {
        table.cell('Username', row.userName);
        table.cell('Areas', `${row.was} -> ${row.areaTags.length}`);
        table.cell('Added', row.areaTags.length - row.was, Table.number(0));
        table.newRow();
    });
    console.info(table.toString());
    console.info(
        `${rows.length} user(s) to update. This is a floor: areas prune old\n` +
            'messages, so areas a user has not posted in for some time may be missing.'
    );

    if (dryRun) {
        return console.info('Dry run: no changes written.');
    }

    try {
        applyPostAreas(dbs.user, rows);
    } catch (err) {
        process.exitCode = ExitCodes.ERROR;
        return console.error(`Failed to write posted-area lists: ${err.message}`);
    }

    console.info(`Recorded posted areas for ${rows.length} user(s).`);
    console.info(
        'Achievements are not awarded here -- there is no session to announce them\n' +
            "to. They are earned on the user's next post."
    );
}

function fixAchievementStats() {
    const dryRun = true === argv['dry-run'];
    const UserDb = require('../database.js').dbs.user;

    let drifted;
    try {
        drifted = findDriftedAchievementStats(UserDb);
    } catch (err) {
        process.exitCode = ExitCodes.ERROR;
        return console.error(`Failed to inspect achievement stats: ${err.message}`);
    }

    if (0 === drifted.length) {
        return console.info(
            'All achievement totals match user_achievement; nothing to do.'
        );
    }

    //
    //  A user can be missing one of the two totals entirely -- the row is then
    //  NULL rather than a number. Show that as "unset" instead of "null", and
    //  count it as nothing removed rather than letting NULL coerce to zero and
    //  subtract the user's whole total from the phantom tally.
    //
    const pointsRemoved = row =>
        null === row.stored_points ? 0 : row.stored_points - row.actual_points;
    const storedOf = value => (null === value ? 'unset' : value);

    const table = new Table();
    drifted.forEach(row => {
        table.cell('Username', row.user_name);
        table.cell('Count', `${storedOf(row.stored_count)} -> ${row.actual_count}`);
        table.cell('Points', `${storedOf(row.stored_points)} -> ${row.actual_points}`);
        table.cell('Points Removed', pointsRemoved(row), Table.number(0));
        table.newRow();
    });
    console.info(table.toString());

    const totalPoints = drifted.reduce((sum, row) => sum + pointsRemoved(row), 0);
    console.info(
        `${drifted.length} user(s) drifted; ${totalPoints} phantom point(s) total.`
    );

    if (dryRun) {
        return console.info('Dry run: no changes written.');
    }

    const applyNow = () => {
        try {
            applyAchievementStats(UserDb, drifted);
        } catch (err) {
            process.exitCode = ExitCodes.ERROR;
            return console.error(`Failed to write achievement stats: ${err.message}`);
        }

        console.info(`Recalculated achievement totals for ${drifted.length} user(s).`);
    };

    if (false === argv.prompt) {
        return applyNow();
    }

    //
    //  StatLog.incrementUserStat() reads the current total from the in-memory
    //  User object, so a user who is online when this runs still holds the old
    //  figure; the next achievement they earn persists that stale value and
    //  puts them right back where they started. Nothing refreshes it on the
    //  increment path, so the only way to be sure is to have the board down.
    //
    console.info(
        'Stop the BBS before continuing. A user who is online holds their totals in'
    );
    console.info(
        'memory, and the next achievement they earn writes that cached figure back,'
    );
    console.info('undoing this repair for them.');
    console.info('WARNING: This cannot be undone -- back up your user database first!');

    getAnswers(
        [
            {
                name: 'proceed',
                message: `Recalculate totals for ${drifted.length} user(s)?`,
                type: 'confirm',
            },
        ],
        answers => {
            if (!answers.proceed) {
                return console.info('Canceled.');
            }
            return applyNow();
        }
    );
}

function handleUserCommand() {
    function errUsage() {
        return printUsageAndSetExitCode(getHelpFor('User'), ExitCodes.ERROR);
    }

    if (true === argv.help) {
        return errUsage();
    }

    const action = argv._[1];
    const userRequired = ![
        'list',
        'fix-achievement-stats',
        'backfill-post-areas',
    ].includes(action);

    //  actions of the form: user <action> USERNAME <value>
    const takesTrailingValue = [
        'pw',
        'pass',
        'passwd',
        'password',
        'group',
        'mv',
        'rename',
        '2fa-otp',
        'otp',
        'import-ssh-key',
        'time',
    ].includes(action);

    let userName;
    if (userRequired) {
        //
        //  Bail before the lookup when the trailing value is missing:
        //  otherwise the username index lands on the action name itself and
        //  the operator is told "no matching username", which says nothing
        //  about what they actually left out.
        //
        if (takesTrailingValue && argv._.length < 4) {
            return errUsage();
        }

        userName = argv._[takesTrailingValue ? argv._.length - 2 : argv._.length - 1];
    }

    if (!userName && userRequired) {
        return errUsage();
    }

    const dispatch = user => {
        return (
            {
                pw: setUserPassword,
                passwd: setUserPassword,
                password: setUserPassword,

                rm: removeUser,
                remove: removeUser,
                del: removeUser,
                delete: removeUser,

                mv: renameUser,
                rename: renameUser,

                activate: setAccountStatus,
                deactivate: setAccountStatus,
                disable: setAccountStatus,
                lock: setAccountStatus,

                group: modUserGroups,

                time: setUserTimeLimit,

                info: showUserInfo,

                '2fa-otp': twoFactorAuthOTP,
                otp: twoFactorAuthOTP,
                list: listUsers,

                'import-ssh-key': importSSHKey,
                'remove-ssh-key': removeSSHKey,

                'fix-achievement-stats': fixAchievementStats,
                'backfill-post-areas': backfillPostAreas,
            }[action] || errUsage
        )(user, action);
    };

    const reportErr = err => {
        process.exitCode = ExitCodes.ERROR;
        return console.error(err.message);
    };

    //
    //  An action that takes no username still needs config and databases up.
    //  Initialize directly rather than asking initAndGetUser() to look up a
    //  username we do not have -- its lookup would fail for a second reason and
    //  mask a genuine startup failure behind whatever the action hits next.
    //
    if (!userRequired) {
        return initConfigAndDatabases(err => {
            return err ? reportErr(err) : dispatch(undefined);
        });
    }

    initAndGetUser(userName, (err, user) => {
        return err ? reportErr(err) : dispatch(user);
    });
}
