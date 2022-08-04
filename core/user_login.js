/* jslint node: true */
'use strict';

//  ENiGMA½
const setClientTheme = require('./theme.js').setClientTheme;
const clientConnections = require('./client_connections.js').clientConnections;
const StatLog = require('./stat_log.js');
const logger = require('./logger.js');
const Events = require('./events.js');
const Config = require('./config.js').get;
const { Errors, ErrorReasons } = require('./enig_error.js');
const UserProps = require('./user_property.js');
const SysProps = require('./system_property.js');
const SystemLogKeys = require('./system_log.js');
const User = require('./user.js');
const {
    getMessageConferenceByTag,
    getMessageAreaByTag,
    getSuitableMessageConfAndAreaTags,
} = require('./message_area.js');
const { getFileAreaByTag, getDefaultFileAreaTag } = require('./file_base_area.js');

//  deps
const async = require('async');
const _ = require('lodash');
const assert = require('assert');
const moment = require('moment');

exports.userLogin = userLogin;
exports.recordLogin = recordLogin;
exports.transformLoginError = transformLoginError;

function userLogin(client, username, password, options, cb) {
    if (!cb && _.isFunction(options)) {
        cb = options;
        options = {};
    }

    const config = Config();

    if (config.users.badUserNames.includes(username.toLowerCase())) {
        client.log.info(
            { username, ip: client.remoteAddress },
            `Attempt to login with banned username "${username}"`
        );

        //  slow down a bit to thwart brute force attacks
        return setTimeout(() => {
            return cb(Errors.BadLogin('Disallowed username', ErrorReasons.NotAllowed));
        }, 2000);
    }

    const authInfo = {
        username,
        password,
    };

    authInfo.type = options.authType || User.AuthFactor1Types.Password;
    authInfo.pubKey = options.ctx;

    client.user.authenticateFactor1(authInfo, err => {
        if (err) {
            return cb(transformLoginError(err, client, username));
        }

        const user = client.user;

        //  Good login; reset any failed attempts
        delete client.sessionFailedLoginAttempts;

        //
        //  Ensure this user is not already logged in.
        //
        const existingClientConnection = clientConnections.find(cc => {
            return (
                user !== cc.user && //  not current connection
                user.userId === cc.user.userId
            ); //  ...but same user
        });

        if (existingClientConnection) {
            client.log.warn(
                {
                    existingNodeId: existingClientConnection.node,
                    username: user.username,
                    userId: user.userId,
                },
                `User "${user.username}" already logged in on node ${existingClientConnection.node}`
            );

            return cb(
                Errors.BadLogin(
                    `User ${user.username} already logged in.`,
                    ErrorReasons.AlreadyLoggedIn
                )
            );
        }

        //  update client logger with addition of username
        client.log = logger.log.child({
            nodeId: client.log.fields.nodeId,
            sessionId: client.log.fields.sessionId,
            username: user.username,
        });

        client.log.info(`User "${user.username}" successfully logged in`);

        //  User's unique session identifier is the same as the connection itself
        user.sessionId = client.session.uniqueId; //  convenience

        Events.emit(Events.getSystemEvents().UserLogin, { user });

        setClientTheme(client, user.properties[UserProps.ThemeId]);

        postLoginPrep(client, err => {
            if (err) {
                return cb(err);
            }

            if (user.authenticated) {
                return recordLogin(client, cb);
            }

            //  recordLogin() must happen after 2FA!
            return cb(null);
        });
    });
}

function postLoginPrep(client, cb) {
    async.series(
        [
            callback => {
                //
                //  User may (no longer) have read (view) rights to their current
                //  message, conferences and/or areas. Move them out if so.
                //
                const confTag = client.user.getProperty(UserProps.MessageConfTag);
                const conf = getMessageConferenceByTag(confTag) || {};
                const area =
                    getMessageAreaByTag(
                        client.user.getProperty(UserProps.MessageAreaTag),
                        confTag
                    ) || {};

                if (
                    !client.acs.hasMessageConfRead(conf) ||
                    !client.acs.hasMessageAreaRead(area)
                ) {
                    //  move them out of both area and possibly conf to something suitable, hopefully.
                    const [newConfTag, newAreaTag] =
                        getSuitableMessageConfAndAreaTags(client);
                    client.user.persistProperties(
                        {
                            [UserProps.MessageConfTag]: newConfTag,
                            [UserProps.MessageAreaTag]: newAreaTag,
                        },
                        err => {
                            return callback(err);
                        }
                    );
                } else {
                    return callback(null);
                }
            },
            callback => {
                //  Likewise for file areas
                const area =
                    getFileAreaByTag(client.user.getProperty(UserProps.FileAreaTag)) ||
                    {};
                if (!client.acs.hasFileAreaRead(area)) {
                    const areaTag = getDefaultFileAreaTag(client) || '';
                    client.user.persistProperty(UserProps.FileAreaTag, areaTag, err => {
                        return callback(err);
                    });
                } else {
                    return callback(null);
                }
            },
        ],
        err => {
            return cb(err);
        }
    );
}

function recordLogin(client, cb) {
    assert(client.user.authenticated); //  don't get in situations where this isn't true

    const user = client.user;
    const loginTimestamp = StatLog.now;

    async.parallel(
        [
            callback => {
                StatLog.incrementNonPersistentSystemStat(SysProps.LoginsToday, 1);
                return StatLog.incrementSystemStat(SysProps.LoginCount, 1, callback);
            },
            callback => {
                return StatLog.setUserStat(
                    user,
                    UserProps.LastLoginTs,
                    loginTimestamp,
                    callback
                );
            },
            callback => {
                return StatLog.incrementUserStat(user, UserProps.LoginCount, 1, callback);
            },
            callback => {
                const loginHistoryMax = Config().statLog.systemEvents.loginHistoryMax;
                const historyItem = JSON.stringify({
                    userId: user.userId,
                    sessionId: user.sessionId,
                });

                return StatLog.appendSystemLogEntry(
                    SystemLogKeys.UserLoginHistory,
                    historyItem,
                    loginHistoryMax,
                    StatLog.KeepType.Max,
                    callback
                );
            },
            callback => {
                //  Update live last login information which includes additional
                //  (pre-resolved) information such as user name/etc.
                const lastLogin = {
                    userId: user.userId,
                    sessionId: user.sessionId,
                    userName: user.username,
                    realName: user.getProperty(UserProps.RealName),
                    affiliation: user.getProperty(UserProps.Affiliations),
                    emailAddress: user.getProperty(UserProps.EmailAddress),
                    sex: user.getProperty(UserProps.Sex),
                    location: user.getProperty(UserProps.Location),
                    timestamp: moment(loginTimestamp),
                };

                StatLog.setNonPersistentSystemStat(SysProps.LastLogin, lastLogin);
                return callback(null);
            },
        ],
        err => {
            return cb(err);
        }
    );
}

function transformLoginError(err, client, username) {
    client.sessionFailedLoginAttempts =
        _.get(client, 'sessionFailedLoginAttempts', 0) + 1;
    const disconnect = Config().users.failedLogin.disconnect;
    if (disconnect > 0 && client.sessionFailedLoginAttempts >= disconnect) {
        err = Errors.BadLogin('To many failed login attempts', ErrorReasons.TooMany);
    }

    client.log.warn(
        { username, ip: client.remoteAddress, reason: err.message },
        `Failed login attempt for user "${username}", ${client.friendlyRemoteAddress()}`
    );
    return err;
}
