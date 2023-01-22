const { WellKnownLocations } = require('../servers/content/web');
const User = require('../user');
const { Errors, ErrorReasons } = require('../enig_error');
const UserProps = require('../user_property');
const ActivityPubSettings = require('./settings');

// deps
const _ = require('lodash');
const mimeTypes = require('mime-types');
const waterfall = require('async/waterfall');
const fs = require('graceful-fs');
const paths = require('path');
const moment = require('moment');

exports.ActivityStreamsContext = 'https://www.w3.org/ns/activitystreams';
exports.isValidLink = isValidLink;
exports.makeSharedInboxUrl = makeSharedInboxUrl;
exports.makeUserUrl = makeUserUrl;
exports.webFingerProfileUrl = webFingerProfileUrl;
exports.selfUrl = selfUrl;
exports.userFromAccount = userFromAccount;
exports.accountFromSelfUrl = accountFromSelfUrl;
exports.getUserProfileTemplatedBody = getUserProfileTemplatedBody;
exports.messageBodyToHtml = messageBodyToHtml;

//  :TODO: more info in default
// this profile template is the *default* for both WebFinger
// profiles and 'self' requests without the
// Accept: application/activity+json headers present
exports.DefaultProfileTemplate = `
User information for: %USERNAME%

Real Name: %REAL_NAME%
Login Count: %LOGIN_COUNT%
Affiliations: %AFFILIATIONS%
Achievement Points: %ACHIEVEMENT_POINTS%
`;

function isValidLink(l) {
    return /^https?:\/\/.+$/.test(l);
}

function makeSharedInboxUrl(webServer) {
    return webServer.buildUrl(WellKnownLocations.Internal + '/ap/shared-inbox');
}

function makeUserUrl(webServer, user, relPrefix) {
    return webServer.buildUrl(
        WellKnownLocations.Internal + `${relPrefix}${user.username}`
    );
}

function webFingerProfileUrl(webServer, user) {
    return webServer.buildUrl(WellKnownLocations.Internal + `/wf/@${user.username}`);
}

function selfUrl(webServer, user) {
    return makeUserUrl(webServer, user, '/ap/users/');
}

function accountFromSelfUrl(url) {
    // https://some.l33t.enigma.board/_enig/ap/users/Masto -> Masto
    //  :TODO: take webServer, and just take path-to-users.length +1
    return url.substring(url.lastIndexOf('/') + 1);
}

function userFromAccount(accountName, cb) {
    if (accountName.startsWith('@')) {
        accountName = accountName.slice(1);
    }

    User.getUserIdAndName(accountName, (err, userId) => {
        if (err) {
            return cb(err);
        }

        User.getUser(userId, (err, user) => {
            if (err) {
                return cb(err);
            }

            const accountStatus = user.getPropertyAsNumber(UserProps.AccountStatus);
            if (
                User.AccountStatus.disabled == accountStatus ||
                User.AccountStatus.inactive == accountStatus
            ) {
                return cb(Errors.AccessDenied('Account disabled', ErrorReasons.Disabled));
            }

            const activityPubSettings = ActivityPubSettings.fromUser(user);
            if (!activityPubSettings.enabled) {
                return cb(Errors.AccessDenied('ActivityPub is not enabled for user'));
            }

            return cb(null, user);
        });
    });
}

function getUserProfileTemplatedBody(
    templateFile,
    user,
    defaultTemplate,
    defaultContentType,
    cb
) {
    const Log = require('../logger').log;
    const Config = require('../config').get;

    waterfall(
        [
            callback => {
                return fs.readFile(templateFile || '', 'utf8', (err, template) => {
                    return callback(null, template);
                });
            },
            (template, callback) => {
                if (!template) {
                    if (templateFile) {
                        Log.warn(`Failed to load profile template "${templateFile}"`);
                    }
                    return callback(null, defaultTemplate, defaultContentType);
                }

                const contentType = mimeTypes.contentType(paths.basename(templateFile));
                return callback(null, template, contentType);
            },
            (template, contentType, callback) => {
                const up = (p, na = 'N/A') => {
                    return user.getProperty(p) || na;
                };

                let birthDate = up(UserProps.Birthdate);
                if (moment.isDate(birthDate)) {
                    birthDate = moment(birthDate);
                }

                const varMap = {
                    USERNAME: user.username,
                    REAL_NAME: user.getSanitizedName('real'),
                    SEX: up(UserProps.Sex),
                    BIRTHDATE: birthDate,
                    AGE: user.getAge(),
                    LOCATION: up(UserProps.Location),
                    AFFILIATIONS: up(UserProps.Affiliations),
                    EMAIL: up(UserProps.EmailAddress),
                    WEB_ADDRESS: up(UserProps.WebAddress),
                    ACCOUNT_CREATED: moment(user.getProperty(UserProps.AccountCreated)),
                    LAST_LOGIN: moment(user.getProperty(UserProps.LastLoginTs)),
                    LOGIN_COUNT: up(UserProps.LoginCount),
                    ACHIEVEMENT_COUNT: up(UserProps.AchievementTotalCount, '0'),
                    ACHIEVEMENT_POINTS: up(UserProps.AchievementTotalPoints, '0'),
                    BOARDNAME: Config().general.boardName,
                };

                let body = template;
                _.each(varMap, (val, varName) => {
                    body = body.replace(new RegExp(`%${varName}%`, 'g'), val);
                });

                return callback(null, body, contentType);
            },
        ],
        (err, data, contentType) => {
            return cb(err, data, contentType);
        }
    );
}

//
//  Apply very basic HTML to a message following
//  Mastodon's supported tags of 'p', 'br', 'a', and 'span':
//  https://blog.joinmastodon.org/2018/06/how-to-implement-a-basic-activitypub-server/
//
function messageBodyToHtml(body) {
    return `<p>${body.replace(/\r?\n/g, '<br>')}</p>`;
}
