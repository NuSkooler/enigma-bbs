/* jslint node: true */
'use strict';

//  ENiGMA½
const setClientTheme    = require('./theme.js').setClientTheme;
const clientConnections = require('./client_connections.js').clientConnections;
const StatLog           = require('./stat_log.js');
const logger            = require('./logger.js');
const Events            = require('./events.js');
const Config            = require('./config.js').get;
const {
    Errors,
    ErrorReasons
}                       = require('./enig_error.js');

//  deps
const async             = require('async');
const _                 = require('lodash');

exports.userLogin       = userLogin;

function userLogin(client, username, password, cb) {
    client.user.authenticate(username, password, err => {
        const config = Config();

        if(err) {
            client.log.info( { username : username, error : err.message }, 'Failed login attempt');

            client.user.sessionFailedLoginAttempts = _.get(client.user, 'sessionFailedLoginAttempts', 0) + 1;
            const disconnect = config.users.failedLogin.disconnect;
            if(disconnect > 0 && client.user.sessionFailedLoginAttempts >= disconnect) {
                return cb(Errors.BadLogin('To many failed login attempts', ErrorReasons.TooMany));
            }

            return cb(err);
        }

        const user = client.user;

        //  Good login; reset any failed attempts
        delete user.sessionFailedLoginAttempts;

        //
        //  Ensure this user is not already logged in.
        //
        const existingClientConnection = clientConnections.find(cc => {
            return user !== cc.user &&          //  not current connection
                user.userId === cc.user.userId; //  ...but same user
        });

        if(existingClientConnection) {
            client.log.info(
                {
                    existingClientId    : existingClientConnection.session.id,
                    username            : user.username,
                    userId              : user.userId
                },
                'Already logged in'
            );

            return cb(Errors.BadLogin(
                `User ${user.username} already logged in.`,
                ErrorReasons.AlreadyLoggedIn
            ));
        }

        //  update client logger with addition of username
        client.log = logger.log.child(
            {
                clientId    : client.log.fields.clientId,
                sessionId   : client.log.fields.sessionId,
                username    : user.username,
            }
        );
        client.log.info('Successful login');

        //  User's unique session identifier is the same as the connection itself
        user.sessionId = client.session.uniqueId;   //  convienence

        Events.emit(Events.getSystemEvents().UserLogin, { user } );

        async.parallel(
            [
                function setTheme(callback) {
                    setClientTheme(client, user.properties.theme_id);
                    return callback(null);
                },
                function updateSystemLoginCount(callback) {
                    return StatLog.incrementSystemStat('login_count', 1, callback);
                },
                function recordLastLogin(callback) {
                    return StatLog.setUserStat(user, 'last_login_timestamp', StatLog.now, callback);
                },
                function updateUserLoginCount(callback) {
                    return StatLog.incrementUserStat(user, 'login_count', 1, callback);
                },
                function recordLoginHistory(callback) {
                    const loginHistoryMax = Config().statLog.systemEvents.loginHistoryMax;
                    const historyItem = JSON.stringify({
                        userId      : user.userId,
                        sessionId   : user.sessionId,
                    });

                    return StatLog.appendSystemLogEntry(
                        'user_login_history',
                        historyItem,
                        loginHistoryMax,
                        StatLog.KeepType.Max,
                        callback
                    );
                }
            ],
            err => {
                return cb(err);
            }
        );
    });
}