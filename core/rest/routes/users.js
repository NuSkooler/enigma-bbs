'use strict';

const {
    jsonResponse,
    problemDetail,
    applyCorsHeaders,
    parseJsonBody,
    API_BASE,
} = require('../util');
const { resolveAuthenticatedUser, requireAuth } = require('../auth');

const User = require('../../user');
const UserProps = require('../../user_property');

const moment = require('moment');

const ROUTE_BASE = `${API_BASE}/users`;

//  Properties that a user may update on their own profile via PUT /users/me
const WRITABLE_PROPS = [
    UserProps.RealName,
    UserProps.Location,
    UserProps.Affiliations,
    UserProps.WebAddress,
    UserProps.AutoSignature,
];

//  Maximum length for each writable property
const PROP_MAX_LEN = {
    [UserProps.RealName]: 64,
    [UserProps.Location]: 64,
    [UserProps.Affiliations]: 64,
    [UserProps.WebAddress]: 256,
    [UserProps.AutoSignature]: 512,
};

//  Fields exposed in public profile, keyed by API name → UserProps key
//  null value = derived, not a raw property
const PUBLIC_PROFILE_FIELDS = {
    realName: UserProps.RealName,
    location: UserProps.Location,
    affiliations: UserProps.Affiliations,
    webAddress: UserProps.WebAddress,
};

exports.register = function register(webServer, log) {
    webServer.addRoute({
        method: 'GET',
        path: new RegExp(`^${ROUTE_BASE}/me$`),
        handler: (req, resp) => _meHandler(req, resp, log),
    });

    webServer.addRoute({
        method: 'PUT',
        path: new RegExp(`^${ROUTE_BASE}/me$`),
        handler: (req, resp) => _meUpdateHandler(req, resp, log),
    });

    webServer.addRoute({
        method: 'GET',
        path: new RegExp(`^${ROUTE_BASE}/([^/]+)$`),
        handler: (req, resp) => _publicProfileHandler(req, resp, log),
    });
};

function _serializeOwnProfile(user) {
    const p = name => user.getProperty(name);
    const pInt = name => {
        const v = parseInt(p(name), 10);
        return isNaN(v) ? 0 : v;
    };

    return {
        userId: user.userId,
        username: user.username,
        groups: user.groups || [],
        realName: p(UserProps.RealName) || undefined,
        location: p(UserProps.Location) || undefined,
        affiliations: p(UserProps.Affiliations) || undefined,
        emailAddress: p(UserProps.EmailAddress) || undefined,
        webAddress: p(UserProps.WebAddress) || undefined,
        autoSignature: p(UserProps.AutoSignature) || undefined,
        accountCreated: p(UserProps.AccountCreated)
            ? moment(p(UserProps.AccountCreated)).toISOString()
            : undefined,
        lastLogin: p(UserProps.LastLoginTs)
            ? moment(p(UserProps.LastLoginTs)).toISOString()
            : undefined,
        loginCount: pInt(UserProps.LoginCount),
        postCount: pInt(UserProps.MessagePostCount),
        uploadCount: pInt(UserProps.FileUlTotalCount),
        uploadBytes: pInt(UserProps.FileUlTotalBytes),
        downloadCount: pInt(UserProps.FileDlTotalCount),
        downloadBytes: pInt(UserProps.FileDlTotalBytes),
        achievementPoints: pInt(UserProps.AchievementTotalPoints),
        minutesOnline: pInt(UserProps.MinutesOnlineTotalCount),
    };
}

function _serializePublicProfile(target, viewerIsSysop) {
    const p = name => target.getProperty(name);
    const pInt = name => {
        const v = parseInt(p(name), 10);
        return isNaN(v) ? 0 : v;
    };

    const profile = {
        userId: target.userId,
        username: target.username,
        accountCreated: p(UserProps.AccountCreated)
            ? moment(p(UserProps.AccountCreated)).toISOString()
            : undefined,
        postCount: pInt(UserProps.MessagePostCount),
        achievementPoints: pInt(UserProps.AchievementTotalPoints),
    };

    //  These fields are opt-in — only shown if the user has set them
    for (const [apiKey, propKey] of Object.entries(PUBLIC_PROFILE_FIELDS)) {
        const val = p(propKey);
        if (val) {
            profile[apiKey] = val;
        }
    }

    //  Sysops get additional fields
    if (viewerIsSysop) {
        profile.groups = target.groups || [];
        profile.emailAddress = p(UserProps.EmailAddress) || undefined;
        profile.lastLogin = p(UserProps.LastLoginTs)
            ? moment(p(UserProps.LastLoginTs)).toISOString()
            : undefined;
        profile.loginCount = pInt(UserProps.LoginCount);
        ((profile.uploadCount = pInt(UserProps.FileUlTotalCount)),
            (profile.downloadCount = pInt(UserProps.FileDlTotalCount)),
            (profile.minutesOnline = pInt(UserProps.MinutesOnlineTotalCount)));
    }

    return profile;
}

function _meHandler(req, resp, log) {
    applyCorsHeaders(req, resp);

    requireAuth(req, resp, authedUser => {
        User.getUser(authedUser.userId, (err, user) => {
            if (err || !user) {
                return problemDetail(resp, 404, 'Not Found', 'User not found');
            }
            return jsonResponse(resp, 200, _serializeOwnProfile(user));
        });
    });
}

function _meUpdateHandler(req, resp, log) {
    applyCorsHeaders(req, resp);

    requireAuth(req, resp, authedUser => {
        parseJsonBody(req, (err, body) => {
            if (err) {
                return problemDetail(resp, 400, 'Bad Request', err.message);
            }

            //  Collect valid updates only
            const updates = {};
            for (const propKey of WRITABLE_PROPS) {
                const apiKey = _propKeyToApiKey(propKey);
                if (apiKey in body) {
                    const val = body[apiKey];
                    if (val !== null && val !== undefined && typeof val !== 'string') {
                        return problemDetail(
                            resp,
                            400,
                            'Bad Request',
                            `Field "${apiKey}" must be a string or null`
                        );
                    }
                    const maxLen = PROP_MAX_LEN[propKey];
                    if (val && val.length > maxLen) {
                        return problemDetail(
                            resp,
                            400,
                            'Bad Request',
                            `Field "${apiKey}" exceeds maximum length of ${maxLen}`
                        );
                    }
                    updates[propKey] = val || '';
                }
            }

            if (Object.keys(updates).length === 0) {
                return problemDetail(
                    resp,
                    400,
                    'Bad Request',
                    'No valid fields provided'
                );
            }

            User.getUser(authedUser.userId, (err, user) => {
                if (err || !user) {
                    return problemDetail(resp, 404, 'Not Found', 'User not found');
                }

                user.persistProperties(updates, err => {
                    if (err) {
                        log.error(
                            { err, userId: user.userId },
                            'Failed to update user properties'
                        );
                        return problemDetail(resp, 500, 'Internal Server Error');
                    }

                    return jsonResponse(resp, 200, _serializeOwnProfile(user));
                });
            });
        });
    });
}

function _publicProfileHandler(req, resp, log) {
    applyCorsHeaders(req, resp);

    const usernameMatch = req.url.match(/\/users\/([^/?]+)/);
    if (!usernameMatch) {
        return problemDetail(resp, 400, 'Bad Request');
    }
    const username = decodeURIComponent(usernameMatch[1]);

    resolveAuthenticatedUser(req, (err, authedUser) => {
        const continueWithViewer = viewer => {
            User.getUserByUsername(username, (err, target) => {
                if (err || !target) {
                    return problemDetail(resp, 404, 'Not Found', 'User not found');
                }

                const viewerIsSysop = viewer
                    ? viewer.isSysOp?.() || viewer.isGroupMember?.('sysops')
                    : false;
                return jsonResponse(
                    resp,
                    200,
                    _serializePublicProfile(target, viewerIsSysop)
                );
            });
        };

        if (authedUser) {
            User.getUser(authedUser.userId, (err, viewer) =>
                continueWithViewer(viewer || null)
            );
        } else {
            continueWithViewer(null);
        }
    });
}

//  Map UserProps key → camelCase API key for PUT body parsing
function _propKeyToApiKey(propKey) {
    const map = {
        [UserProps.RealName]: 'realName',
        [UserProps.Location]: 'location',
        [UserProps.Affiliations]: 'affiliations',
        [UserProps.WebAddress]: 'webAddress',
        [UserProps.AutoSignature]: 'autoSignature',
    };
    return map[propKey] || propKey;
}
