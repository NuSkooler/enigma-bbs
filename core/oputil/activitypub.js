const {
    printUsageAndSetExitCode,
    ExitCodes,
    argv,
    initConfigAndDatabases,
} = require('./oputil_common');
const getHelpFor = require('./oputil_help.js').getHelpFor;
const UserProps = require('../user_property');
const { Errors } = require('../enig_error');

// deps
const async = require('async');
const { get } = require('lodash');

exports.handleUserCommand = handleUserCommand;

function applyAction(username, actionFunc, cb) {
    initConfigAndDatabases(err => {
        if (err) {
            return cb(err);
        }

        if (!validateActivityPub()) {
            return cb(Errors.General('Activity Pub is not enabled'));
        }

        if ('*' === username) {
            return actionFunc(null, cb);
        } else {
            const User = require('../../core/user.js');
            User.getUserIdAndName(username, (err, userId) => {
                if (err) {
                    //  try user ID if number was supplied
                    userId = parseInt(userId);
                    if (isNaN(userId)) {
                        return cb(err);
                    }
                }

                User.getUser(userId, (err, user) => {
                    if (err) {
                        return cb(err);
                    }
                    return actionFunc(user, cb);
                });
            });
        }
    });
}

function conditionSingleUser(User, username, userId, settings, cb) {
    const { userNameToSubject } = require('../activitypub/util');
    const subject = userNameToSubject(username);
    if (!subject) {
        return cb(Errors.General(`Failed to get subject for ${username}`));
    }

    console.info(`Conditioning ${username} (${userId}) -> ${subject}...`);

    User.persistPropertyByUserId(userId, UserProps.ActivityPubSettings, settings, err => {
        return cb(err);
    });
}

function actionConditionAllUsers(_, cb) {
    const User = require('../../core/user.js');
    const ActivityPubSettings = require('../activitypub/settings');
    const defaultSettings = JSON.stringify(new ActivityPubSettings());

    User.getUserList({}, (err, userList) => {
        if (err) {
            return cb(err);
        }

        async.each(
            userList,
            (entry, next) => {
                conditionSingleUser(
                    User,
                    entry.userName,
                    entry.userId,
                    defaultSettings,
                    next
                );
            },
            err => {
                return cb(err);
            }
        );
    });
}

function actionConditionUser(user, cb) {
    const User = require('../../core/user.js');
    const ActivityPubSettings = require('../activitypub/settings');
    const defaultSettings = JSON.stringify(new ActivityPubSettings());
    return conditionSingleUser(User, user.username, user.userId, defaultSettings, cb);
}

function validateActivityPub() {
    //
    //  Web Server, and ActivityPub both must be enabled
    //
    const sysConfig = require('../config').get;
    const config = sysConfig();
    if (
        true !== get(config, 'contentServers.web.http.enabled') &&
        true !== get(config, 'contentServers.web.https.enabled')
    ) {
        return false;
    }

    return true === get(config, 'contentServers.web.handlers.activityPub.enabled');
}

function conditionUser(action, username) {
    return applyAction(
        username,
        '*' === username ? actionConditionAllUsers : actionConditionUser,
        err => {
            if (err) {
                console.error(err.message);
            }
        }
    );
}

function handleUserCommand() {
    const errUsage = () => {
        return printUsageAndSetExitCode(getHelpFor('ActivityPub'), ExitCodes.ERROR);
    };

    if (true === argv.help) {
        return errUsage();
    }

    const action = argv._[1];
    const usernameIdx = ['condition'].includes(action)
        ? argv._.length - 1
        : argv._.length;
    const username = argv._[usernameIdx];

    if (!username) {
        return errUsage();
    }

    return (
        {
            condition: conditionUser,
        }[action] || errUsage
    )(action, username);
}
