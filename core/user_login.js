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
exports.checkSSHPubKey = checkSSHPubKey;
exports.recordLogin = recordLogin;
exports.transformLoginError = transformLoginError;

function userLogin(client, username, password, options, cb) {
    if (!cb && _.isFunction(options)) {
        cb = options;
        options = {};
    }

    if (isBannedUsername(client, username, cb)) {
        return;
    }

    const authInfo = {
        username,
        password,
    };

    authInfo.type = options.authType || User.AuthFactor1Types.Password;
    authInfo.pubKey = options.ctx;

    //  the User this login is for; see the check after authentication
    const loginUser = client.user;

    loginUser.authenticateFactor1(authInfo, err => {
        //
        //  The connection can end while authentication is under way (the
        //  caller hangs up, the SSH login timeout fires). There is nobody to
        //  log in, and the client is no longer tracked: stop here, before
        //  any of the login's side effects. Callers treat ClientEnded as
        //  "do nothing more".
        //
        if (client.clientEnded) {
            return cb(abandonLogin(client, username, err));
        }

        if (err) {
            return cb(transformLoginError(err, client, username));
        }

        //
        //  Nor is there anyone to log in if the connection was refused while
        //  authentication was under way: the SSH server refuses a login for
        //  the account's state and gives the client a fresh User (see
        //  refuseLogin() in core/servers/login/ssh.js), and a request the
        //  client abandoned can still be checking a password meanwhile. Its
        //  success is not a login, and none of a login's side effects run.
        //  A failure above is counted as any is.
        //
        if (client.user !== loginUser || client.refused) {
            return cb(
                abandonLogin(
                    client,
                    username,
                    null,
                    'Login abandoned: the connection was refused during login'
                )
            );
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

//
//  A banned username gets a BadLogin, slowly, to thwart brute force attacks.
//  Returns true if |username| is banned; |cb| is then called later.
//
function isBannedUsername(client, username, cb) {
    if (!Config().users.badUserNames.includes(username.toLowerCase())) {
        return false;
    }

    client.log.info(
        { username, ip: client.remoteAddress },
        `Attempt to login with banned username "${username}"`
    );

    setTimeout(() => {
        if (client.clientEnded) {
            return cb(abandonLogin(client, username));
        }
        return cb(Errors.BadLogin('Disallowed username', ErrorReasons.NotAllowed));
    }, 2000);
    return true;
}

//
//  An SSH client asking whether a public key would be accepted, before it
//  signs with it (see User.checkSSHPubKey()). Not a login: there are none of
//  userLogin()'s side effects, and the account itself (disabled, locked, and
//  so on) is not looked at until the client has proved it holds the key.
//  Errors are as userLogin()'s, so its callers can handle both alike. A key
//  that does not match counts toward users.failedLogin.disconnect, as any
//  failed attempt on the connection does, but not toward locking the account.
//
function checkSSHPubKey(client, username, pubKey, cb) {
    if (isBannedUsername(client, username, cb)) {
        return;
    }

    client.user.checkSSHPubKey(username, _.get(pubKey, 'key'), err => {
        if (client.clientEnded) {
            return cb(abandonLogin(client, username, err));
        }

        if (err) {
            return cb(transformLoginError(err, client, username));
        }

        return cb(null);
    });
}

function abandonLogin(
    client,
    username,
    authErr,
    why = 'Login abandoned: the connection ended during login'
) {
    client.log.info(
        {
            username,
            ip: client.remoteAddress,
            authResult: authErr ? authErr.message : 'authenticated',
        },
        why
    );
    return Errors.General('The connection ended during login', ErrorReasons.ClientEnded);
}

function postLoginPrep(client, cb) {
    async.series(
        [
            callback => {
                //
                //  User may (no longer) have read (view) rights to their current
                //  message, conferences and/or areas. Move them out if so. An
                //  area that is not configured (removed, its conference
                //  removed, or none at all) is no read either (#1141).
                //
                const confTag = client.user.getProperty(UserProps.MessageConfTag);
                const conf = getMessageConferenceByTag(confTag) || {};
                const area = getMessageAreaByTag(
                    client.user.getProperty(UserProps.MessageAreaTag),
                    confTag
                );

                if (
                    !area ||
                    !client.acs.hasMessageConfRead(conf) ||
                    !client.acs.hasMessageAreaRead(area)
                ) {
                    //  move them out of both area and possibly conf to something suitable, hopefully.
                    const [newConfTag, newAreaTag] =
                        getSuitableMessageConfAndAreaTags(client);
                    //  nothing better found (no area at all, nothing readable)
                    if (
                        newConfTag === (confTag || '') &&
                        newAreaTag ===
                            (client.user.getProperty(UserProps.MessageAreaTag) || '')
                    ) {
                        return callback(null);
                    }
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

const DateFormat = 'YYYY-MM-DD'; //  matches LoginStreakLastDate's convention

//  Given the user's stored streak state and the current moment, compute the new
//  streak day count and the date string to store.
//  Returns [newStreakDays, newStreakLastDate] — unchanged when the streak has
//  already been credited today.
//
//  The run is measured in whole calendar days against the day the streak was
//  last credited. Measuring against the previous login instead means a caller
//  who connects twice in a day moves the goalposts on themselves: the second
//  login becomes the reference, and the next day's login is "too soon" to count.
//  That is the same thing as saying the more often you call, the less likely the
//  streak is to advance -- the opposite of what it is for.
//
function computeLoginStreak(user, now) {
    const currentDays = user.getPropertyAsNumber(UserProps.LoginStreakDays) || 0;
    const lastDateStr = user.getProperty(UserProps.LoginStreakLastDate) || '';
    const todayStr = now.format(DateFormat);

    const lastDate = lastDateStr ? moment(lastDateStr, DateFormat, true) : null;
    if (!lastDate || !lastDate.isValid()) {
        //  nothing credited yet, or a stored date we cannot read
        return [1, todayStr];
    }

    const daysSince = now.clone().startOf('day').diff(lastDate.startOf('day'), 'days');

    if (daysSince <= 0) {
        //  already credited today; a clock that moved backwards lands here too,
        //  where leaving the streak alone is the safe answer
        return [currentDays, lastDateStr];
    }

    if (1 === daysSince) {
        return [currentDays + 1, todayStr];
    }

    //  a day was missed -- start the run again at today
    return [1, todayStr];
}

function recordLogin(client, cb) {
    assert(client.user.authenticated); //  don't get in situations where this isn't true

    const user = client.user;
    const loginTimestamp = StatLog.now;
    const previousLoginTimestamp = user.getProperty(UserProps.LastLoginTs);

    //  Compute before the parallel block writes LoginStreakLastDate back.
    const now = moment();
    const [newStreakDays, newStreakLastDate] = computeLoginStreak(user, now);

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
                if (previousLoginTimestamp) {
                    return StatLog.setUserStat(
                        user,
                        UserProps.PrevLoginTs,
                        previousLoginTimestamp,
                        callback
                    );
                }
                return callback(null);
            },
            callback => {
                return StatLog.incrementUserStat(user, UserProps.LoginCount, 1, callback);
            },
            callback => {
                const created = user.getProperty(UserProps.AccountCreated);
                if (created) {
                    const daysOld = moment().diff(moment(created), 'days');
                    return StatLog.setUserStat(
                        user,
                        UserProps.AccountDaysOld,
                        daysOld,
                        callback
                    );
                }
                return callback(null);
            },
            callback => {
                return StatLog.setUserStat(
                    user,
                    UserProps.LoginStreakDays,
                    newStreakDays,
                    callback
                );
            },
            callback => {
                if (newStreakLastDate) {
                    return StatLog.setUserStat(
                        user,
                        UserProps.LoginStreakLastDate,
                        newStreakLastDate,
                        callback
                    );
                }
                return callback(null);
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

exports.computeLoginStreak = computeLoginStreak;

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
