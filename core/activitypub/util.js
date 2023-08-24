const User = require('../user');
const { Errors, ErrorReasons } = require('../enig_error');
const UserProps = require('../user_property');
const ActivityPubSettings = require('./settings');
const { stripAnsiControlCodes } = require('../string_util');
const { WellKnownRecipientFields } = require('./const');
const Log = require('../logger').log;
const { getWebDomain } = require('../web_util');
const Endpoints = require('./endpoint');

// deps
const _ = require('lodash');
const mimeTypes = require('mime-types');
const waterfall = require('async/waterfall');
const fs = require('graceful-fs');
const paths = require('path');
const moment = require('moment');
const { encode, decode } = require('html-entities');
const { isString, get } = require('lodash');
const { stripHtml } = require('string-strip-html');

exports.getActorId = o => o.actor?.id || o.actor;
exports.parseTimestampOrNow = parseTimestampOrNow;
exports.isValidLink = isValidLink;
exports.userFromActorId = userFromActorId;
exports.getUserProfileTemplatedBody = getUserProfileTemplatedBody;
exports.messageBodyToHtml = messageBodyToHtml;
exports.messageToHtml = messageToHtml;
exports.htmlToMessageBody = htmlToMessageBody;
exports.userNameFromSubject = userNameFromSubject;
exports.userNameToSubject = userNameToSubject;
exports.extractMessageMetadata = extractMessageMetadata;
exports.recipientIdsFromObject = recipientIdsFromObject;
exports.prepareLocalUserAsActor = prepareLocalUserAsActor;

//  :TODO: more info in default
// this profile template is the *default* for both WebFinger
// profiles and 'self' requests without the
// Accept: application/activity+json headers present
exports.DefaultProfileTemplate = `
User information for: %PREFERRED_USERNAME%

Name: %NAME%
Login Count: %LOGIN_COUNT%
Affiliations: %AFFILIATIONS%
Achievement Points: %ACHIEVEMENT_POINTS%
`;

function parseTimestampOrNow(s) {
    try {
        return moment(s);
    } catch (e) {
        Log.warn({ error: e.message }, `Failed parsing timestamp "${s}"`);
        return moment();
    }
}

function isValidLink(l) {
    return /^https?:\/\/.+$/.test(l);
}

function userFromActorId(actorId, cb) {
    User.getUserIdsWithProperty(UserProps.ActivityPubActorId, actorId, (err, userId) => {
        if (err) {
            return cb(err);
        }

        // must only be 0 or 1
        if (!Array.isArray(userId) || userId.length !== 1) {
            return cb(
                Errors.DoesNotExist(
                    `No user with property '${UserProps.ActivityPubActorId}' of ${actorId}`
                )
            );
        }

        userId = userId[0];
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
    userAsActor,
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
                const val = v => {
                    if (isString(v)) {
                        return v ? encode(v) : '';
                    } else {
                        if (isNaN(v)) {
                            return '';
                        }
                        return v ? v : 0;
                    }
                };

                let birthDate = val(user.getProperty(UserProps.Birthdate));
                if (moment.isDate(birthDate)) {
                    birthDate = moment(birthDate);
                }

                const varMap = {
                    ACTOR_OBJ: JSON.stringify(userAsActor),
                    SUBJECT: userNameToSubject(user.username),
                    INBOX: userAsActor.inbox,
                    SHARED_INBOX: userAsActor.endpoints.sharedInbox,
                    OUTBOX: userAsActor.outbox,
                    FOLLOWERS: userAsActor.followers,
                    FOLLOWING: userAsActor.following,
                    USER_ICON: get(userAsActor, 'icon.url', ''),
                    USER_IMAGE: get(userAsActor, 'image.url', ''),
                    PREFERRED_USERNAME: userAsActor.preferredUsername,
                    NAME: userAsActor.name,
                    SEX: user.getProperty(UserProps.Sex),
                    BIRTHDATE: birthDate,
                    AGE: user.getAge(),
                    LOCATION: user.getProperty(UserProps.Location),
                    AFFILIATIONS: user.getProperty(UserProps.Affiliations),
                    EMAIL: user.getProperty(UserProps.EmailAddress),
                    WEB_ADDRESS: user.getProperty(UserProps.WebAddress),
                    ACCOUNT_CREATED: moment(user.getProperty(UserProps.AccountCreated)),
                    LAST_LOGIN: moment(user.getProperty(UserProps.LastLoginTs)),
                    LOGIN_COUNT: user.getPropertyAsNumber(UserProps.LoginCount),
                    ACHIEVEMENT_COUNT: user.getPropertyAsNumber(
                        UserProps.AchievementTotalCount
                    ),
                    ACHIEVEMENT_POINTS: user.getPropertyAsNumber(
                        UserProps.AchievementTotalPoints
                    ),
                    BOARDNAME: Config().general.boardName,
                };

                let body = template;
                _.each(varMap, (v, varName) => {
                    body = body.replace(new RegExp(`%${varName}%`, 'g'), val(v));
                });

                return callback(null, body, contentType);
            },
        ],
        (err, data, contentType) => {
            return cb(err, data, contentType);
        }
    );
}

function messageBodyToHtml(body) {
    body = encode(stripAnsiControlCodes(body), { mode: 'nonAsciiPrintable' }).replace(
        /\r?\n/g,
        '<br>'
    );

    return `<p>${body}</p>`;
}

//
//  Apply very basic HTML to a message following
//  Mastodon's supported tags of 'p', 'br', 'a', and 'span':
//  - https://docs.joinmastodon.org/spec/activitypub/#sanitization
//  - https://blog.joinmastodon.org/2018/06/how-to-implement-a-basic-activitypub-server/
//
//  Microformats:
//  - https://microformats.org/wiki/
//  - https://indieweb.org/note
//  - https://docs.joinmastodon.org/spec/microformats/
//
function messageToHtml(message) {
    const msg = encode(stripAnsiControlCodes(message.message.trim()), {
        mode: 'nonAsciiPrintable',
    }).replace(/\r?\n/g, '<br>');

    //  :TODO: figure out any microformats we should use here...

    return `<p>${msg}</p>`;
}

function htmlToMessageBody(html) {
    const res = stripHtml(decode(html));
    return res.result;
}

function userNameFromSubject(subject) {
    return subject.replace(/^acct:(.+)$/, '$1');
}

function userNameToSubject(userName) {
    return `@${userName}@${getWebDomain()}`;
}

function extractMessageMetadata(body) {
    const metadata = { mentions: new Set(), hashTags: new Set() };

    const re = /(@\w+)|(#[A-Za-z0-9_]+)/g;
    const matches = body.matchAll(re);
    for (const m of matches) {
        if (m[1]) {
            metadata.mentions.add(m[1]);
        } else if (m[2]) {
            metadata.hashTags.add(m[2]);
        }
    }

    return metadata;
}

function recipientIdsFromObject(obj) {
    const ids = [];

    WellKnownRecipientFields.forEach(field => {
        let v = obj[field];
        if (v) {
            if (!Array.isArray(v)) {
                v = [v];
            }
            ids.push(...v);
        }
    });

    return Array.from(new Set(ids));
}

function prepareLocalUserAsActor(user, options = { force: false }, cb) {
    const hasProps =
        user.getProperty(UserProps.ActivityPubActorId) &&
        user.getProperty(UserProps.PrivateActivityPubSigningKey) &&
        user.getProperty(UserProps.PublicActivityPubSigningKey);

    if (hasProps && !options.force) {
        return cb(null);
    }

    const actorId = Endpoints.actorId(user);
    user.setProperty(UserProps.ActivityPubActorId, actorId);

    user.updateActivityPubKeyPairProperties(err => {
        if (err) {
            return cb(err);
        }

        user.generateNewRandomAvatar((err, outPath) => {
            if (err) {
                return err;
            }

            //  :TODO: fetch over +op default overrides here, e.g. 'enabled'
            const apSettings = ActivityPubSettings.fromUser(user);

            const filename = paths.basename(outPath);
            const avatarUrl = Endpoints.avatar(user, filename);

            apSettings.image = avatarUrl;
            apSettings.icon = avatarUrl;

            user.setProperty(UserProps.AvatarImageUrl, avatarUrl);
            user.setProperty(UserProps.ActivityPubSettings, JSON.stringify(apSettings));

            return cb(null);
        });
    });
}