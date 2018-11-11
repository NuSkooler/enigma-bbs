/* jslint node: true */
'use strict';

//  ENiGMA½
const setClientTheme    = require('./theme.js').setClientTheme;
const clientConnections = require('./client_connections.js').clientConnections;
const StatLog           = require('./stat_log.js');
const logger            = require('./logger.js');
const Events            = require('./events.js');
const Config            = require('./config.js').get;

//  deps
const async             = require('async');

exports.userLogin       = userLogin;

function userLogin(client, username, password, cb) {
    client.user.authenticate(username, password, function authenticated(err) {
        if(err) {
            client.log.info( { username : username, error : err.message }, 'Failed login attempt');

            //  :TODO: if username exists, record failed login attempt to properties
            //  :TODO: check Config max failed logon attempts/etc. - set err.maxAttempts = true

            return cb(err);
        }
        const user  = client.user;

        //
        //  Ensure this user is not already logged in.
        //  Loop through active connections -- which includes the current --
        //  and check for matching user ID. If the count is > 1, disallow.
        //
        let existingClientConnection;
        clientConnections.forEach(function connEntry(cc) {
            if(cc.user !== user && cc.user.userId === user.userId) {
                existingClientConnection = cc;
            }
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

            const existingConnError = new Error('Already logged in as supplied user');
            existingConnError.existingConn = true;

            //  :TODO: We should use EnigError & pass existing connection as second param

            return cb(existingConnError);
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