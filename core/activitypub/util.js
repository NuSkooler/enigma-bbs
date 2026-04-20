const User = require('../user');
const { Errors, ErrorReasons } = require('../enig_error');
const UserProps = require('../user_property');
const ActivityPubSettings = require('./settings');
const { stripAnsiControlCodes } = require('../string_util');

//  Strip ENiGMA pipe color codes (|XX) — inlined to avoid the circular
//  dependency: color_codes.js → predefined_mci.js → activitypub/util.js
const stripMciColorCodes = s => s.replace(/\|[A-Z\d]{2}/g, '');
const { WellKnownRecipientFields } = require('./const');
const Log = require('../logger').log;
const { getWebDomain } = require('../web_util');
const Endpoints = require('./endpoint');
const anyAscii = require('../anyascii/any-ascii');

// deps
const _ = require('lodash');
const mimeTypes = require('mime-types');
const waterfall = require('async/waterfall');
const parallel = require('async/parallel');
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

//  Default HTML profile page served for WebFinger profile requests and
//  'self' actor requests that lack the Accept: application/activity+json header.
//  Operators may override via contentServers.web.handlers.webFinger.profileTemplate
//  (webfinger) or contentServers.web.handlers.activityPub.selfTemplate (AP self).
//
//  Available template vars (scalar, HTML-encoded):
//    %PREFERRED_USERNAME%  %NAME%           %SUBJECT%         %BOARDNAME%
//    %FOLLOWER_COUNT%      %FOLLOWING_COUNT% %LOGIN_COUNT%
//    %ACHIEVEMENT_COUNT%   %ACHIEVEMENT_POINTS%
//    %LOCATION%            %AFFILIATIONS%   %WEB_ADDRESS%
//    %ACCOUNT_CREATED%     %LAST_LOGIN%     %AGE%             %SEX%
//    %USER_ICON%           %USER_IMAGE%
//    %INBOX%               %OUTBOX%         %FOLLOWERS%       %FOLLOWING%
//    %ACTOR_OBJ%           (full actor JSON)
//
//  Raw HTML vars (not encoded — HTML templates only):
//    %AVATAR_HTML%         %SUMMARY_HTML%
//    %RECENT_POSTS_HTML%   %RECENT_POSTS_TEXT%
//
exports.DefaultProfileTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>@%PREFERRED_USERNAME% \u2014 %BOARDNAME%</title>
  <style>
    :root {
      --bg:     #080808;
      --panel:  #101010;
      --border: #1a6b3a;
      --head:   #33dd66;
      --label:  #668866;
      --text:   #aabbaa;
      --link:   #44aaff;
      --accent: #ffaa33;
      --muted:  #445544;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'Courier New', Courier, monospace;
      font-size: 14px;
      line-height: 1.65;
      padding: 2rem 1rem;
    }
    a { color: var(--link); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .wrap { max-width: 740px; margin: 0 auto; }
    .board-line {
      color: var(--muted);
      font-size: 0.8em;
      border-bottom: 1px solid var(--muted);
      padding-bottom: 0.4rem;
      margin-bottom: 1.5rem;
    }
    .profile-header {
      display: flex;
      gap: 1.25rem;
      align-items: flex-start;
      margin-bottom: 1.5rem;
    }
    .avatar {
      width: 72px; height: 72px;
      border: 2px solid var(--border);
      object-fit: cover;
      flex-shrink: 0;
    }
    .avatar-placeholder {
      width: 72px; height: 72px;
      border: 2px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--border);
      font-size: 1.6rem;
      flex-shrink: 0;
    }
    .handle { color: var(--head); font-size: 1.2em; font-weight: bold; }
    .display-name { color: var(--accent); margin-top: 0.15rem; }
    .summary { color: var(--text); margin-top: 0.4rem; font-size: 0.9em; max-width: 500px; }
    .social-line {
      margin-top: 0.5rem;
      color: var(--label);
      font-size: 0.85em;
    }
    .social-line strong { color: var(--text); }
    .section {
      border: 1px solid var(--border);
      background: var(--panel);
      padding: 0.6rem 1rem 0.8rem;
      margin-bottom: 1.25rem;
    }
    .section-head {
      color: var(--border);
      font-size: 0.75em;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      border-bottom: 1px solid #0e2e1a;
      padding-bottom: 0.3rem;
      margin-bottom: 0.6rem;
    }
    .kv { display: grid; grid-template-columns: 148px 1fr; gap: 0.15rem 0.5rem; }
    .kv-l { color: var(--label); }
    .kv-v { color: var(--text); word-break: break-word; }
    .recent-posts { list-style: none; padding: 0; }
    .recent-posts li {
      padding: 0.35rem 0;
      border-bottom: 1px solid #141f14;
      font-size: 0.88em;
    }
    .recent-posts li:last-child { border-bottom: none; }
    .post-date { color: var(--muted); margin-right: 0.4rem; }
    .post-subject { color: var(--accent); }
    .no-posts { color: var(--muted); font-size: 0.88em; font-style: italic; }
    .footer {
      margin-top: 2rem;
      color: var(--muted);
      font-size: 0.75em;
      text-align: center;
    }
  </style>
</head>
<body>
<div class="wrap">

  <div class="board-line">%BOARDNAME%</div>

  <div class="profile-header">
    %AVATAR_HTML%
    <div>
      <div class="handle">@%PREFERRED_USERNAME%</div>
      <div class="display-name">%NAME%</div>
      %SUMMARY_HTML%
      <div class="social-line">
        <strong>%FOLLOWER_COUNT%</strong> followers &nbsp;&middot;&nbsp;
        <strong>%FOLLOWING_COUNT%</strong> following &nbsp;&middot;&nbsp;
        <strong>%LOGIN_COUNT%</strong> logins
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-head">Info</div>
    <div class="kv">
      <div class="kv-l">Location</div>       <div class="kv-v">%LOCATION%</div>
      <div class="kv-l">Affiliations</div>   <div class="kv-v">%AFFILIATIONS%</div>
      <div class="kv-l">Web</div>            <div class="kv-v"><a href="%WEB_ADDRESS%">%WEB_ADDRESS%</a></div>
      <div class="kv-l">Member since</div>   <div class="kv-v">%ACCOUNT_CREATED%</div>
      <div class="kv-l">Last seen</div>      <div class="kv-v">%LAST_LOGIN%</div>
      <div class="kv-l">Achievements</div>   <div class="kv-v">%ACHIEVEMENT_COUNT% &nbsp;(%ACHIEVEMENT_POINTS% pts)</div>
    </div>
  </div>

  <div class="section">
    <div class="section-head">Recent Posts</div>
    %RECENT_POSTS_HTML%
  </div>

  <div class="footer">
    Powered by <a href="https://enigma-bbs.github.io">ENiGMA&frac12; BBS</a>
  </div>

</div>
</body>
</html>
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
    //  Local actor IDs embed the username in the path: /ap/users/{username}
    //  Extract it so we can fall back to a username lookup when the stored
    //  actor ID has a stale domain (e.g. after an ngrok rotation or domain change).
    const localActorPathRe = /\/ap\/users\/([^/?#]+)$/;

    const finishWithUser = (userId, next) => {
        User.getUser(userId, (err, user) => {
            if (err) {
                return next(err);
            }
            const accountStatus = user.getPropertyAsNumber(UserProps.AccountStatus);
            if (
                User.AccountStatus.disabled == accountStatus ||
                User.AccountStatus.inactive == accountStatus
            ) {
                return next(
                    Errors.AccessDenied('Account disabled', ErrorReasons.Disabled)
                );
            }
            const activityPubSettings = ActivityPubSettings.fromUser(user);
            if (!activityPubSettings.enabled) {
                return next(Errors.AccessDenied('ActivityPub is not enabled for user'));
            }
            return next(null, user);
        });
    };

    User.getUserIdsWithProperty(UserProps.ActivityPubActorId, actorId, (err, userIds) => {
        if (!err && Array.isArray(userIds) && userIds.length === 1) {
            return finishWithUser(userIds[0], cb);
        }

        //  Exact match failed — try path-based username extraction so a stale
        //  stored actor ID (different domain/scheme) doesn't block local lookups.
        const m = localActorPathRe.exec(actorId);
        if (!m) {
            return cb(
                Errors.DoesNotExist(
                    `No user with property '${UserProps.ActivityPubActorId}' of ${actorId}`
                )
            );
        }

        const username = decodeURIComponent(m[1]);
        User.getUserIdAndName(username, (err, userId) => {
            if (err) {
                return cb(
                    Errors.DoesNotExist(
                        `No user with property '${UserProps.ActivityPubActorId}' of ${actorId}`
                    )
                );
            }
            return finishWithUser(userId, cb);
        });
    });
}

function _notePreview(note, maxLen) {
    const raw = note.content || note.name || note.summary || '';
    const text = (stripHtml(raw).result || '').replace(/\s+/g, ' ').trim();
    return text.length > maxLen
        ? text.slice(0, maxLen - 1) + '\u2026'
        : text || '(no content)';
}

function _formatRecentPostsHtml(posts) {
    if (!posts || posts.length === 0) {
        return '<p class="no-posts">No posts yet.</p>';
    }
    const items = posts
        .map(activity => {
            const note = activity.object || {};
            const url = encode(note.url || note.id || '#');
            const subject = note.name || note.summary || '';
            const preview = encode(_notePreview(note, 100));
            const date = activity.published
                ? moment(activity.published).format('YYYY-MM-DD')
                : '';
            const subjectPart = subject
                ? `<span class="post-subject">${encode(subject)}</span> \u2014 `
                : '';
            return `  <li><span class="post-date">${encode(date)}</span> ${subjectPart}<a href="${url}">${preview}</a></li>`;
        })
        .join('\n');
    return `<ul class="recent-posts">\n${items}\n</ul>`;
}

function _formatRecentPostsText(posts) {
    if (!posts || posts.length === 0) {
        return '  (no posts yet)';
    }
    return posts
        .map(activity => {
            const note = activity.object || {};
            const url = note.url || note.id || '';
            const preview = _notePreview(note, 72);
            const date = activity.published
                ? moment(activity.published).format('YYYY-MM-DD')
                : '';
            return `  ${date}  ${preview}\n  ${url}`;
        })
        .join('\n\n');
}

function _actorAvatarHtml(actor) {
    const iconUrl = get(actor, 'icon.url', '');
    if (iconUrl) {
        return `<img class="avatar" src="${encode(iconUrl)}" alt="avatar">`;
    }
    return '<div class="avatar-placeholder">[ ]</div>';
}

function _actorSummaryHtml(actor) {
    //  actor.summary is AP HTML originating from our own local actor record.
    if (!actor.summary) {
        return '';
    }
    return `<div class="summary">${actor.summary}</div>`;
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
                //  Lazy require to avoid circular dep at module load time:
                //  collection.js already requires util.js at its top level.
                const Collection = require('./collection');

                parallel(
                    {
                        followerCount: cb =>
                            Collection.followers(
                                userAsActor.followers,
                                null,
                                (err, coll) => cb(null, err ? 0 : coll.totalItems)
                            ),
                        followingCount: cb =>
                            Collection.following(
                                userAsActor.following,
                                null,
                                (err, coll) => cb(null, err ? 0 : coll.totalItems)
                            ),
                        recentPosts: cb =>
                            Collection.recentPublicPosts(
                                userAsActor.outbox,
                                10,
                                (err, posts) => cb(null, err ? [] : posts)
                            ),
                    },
                    (err, collData) => {
                        if (err) {
                            collData = {
                                followerCount: 0,
                                followingCount: 0,
                                recentPosts: [],
                            };
                        }
                        return callback(null, template, contentType, collData);
                    }
                );
            },
            (template, contentType, collData, callback) => {
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

                //  Encoded (HTML-safe) scalar vars.
                const varMap = {
                    ACTOR_OBJ: JSON.stringify(userAsActor),
                    SUBJECT: userNameToSubject(user.username),
                    INBOX: userAsActor.inbox,
                    SHARED_INBOX: userAsActor.endpoints.sharedInbox,
                    OUTBOX: userAsActor.outbox,
                    FOLLOWERS: userAsActor.followers,
                    FOLLOWING: userAsActor.following,
                    FOLLOWER_COUNT: collData.followerCount,
                    FOLLOWING_COUNT: collData.followingCount,
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

                //  Raw HTML vars — substituted after the encoded pass so they
                //  are never double-encoded.  Safe to use in HTML templates only.
                const rawVars = {
                    RECENT_POSTS_HTML: _formatRecentPostsHtml(collData.recentPosts),
                    RECENT_POSTS_TEXT: _formatRecentPostsText(collData.recentPosts),
                    AVATAR_HTML: _actorAvatarHtml(userAsActor),
                    SUMMARY_HTML: _actorSummaryHtml(userAsActor),
                };

                let body = template;
                _.each(varMap, (v, varName) => {
                    body = body.replace(new RegExp(`%${varName}%`, 'g'), val(v));
                });
                _.each(rawVars, (v, varName) => {
                    body = body.replace(new RegExp(`%${varName}%`, 'g'), v);
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
    body = encode(stripAnsiControlCodes(stripMciColorCodes(body)), {
        mode: 'nonAsciiPrintable',
    }).replace(/\r?\n/g, '<br>');

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
    //  Strip BBS pipe color codes (|XX) then ANSI escape sequences before
    //  HTML-encoding so neither bleeds into the federated AP content field.
    const msg = encode(
        stripAnsiControlCodes(stripMciColorCodes(message.message.trim())),
        { mode: 'nonAsciiPrintable' }
    ).replace(/\r?\n/g, '<br>');

    return `<p>${msg}</p>`;
}

function htmlToMessageBody(html) {
    //  Replace <br> variants with line breaks before stripping tags so that
    //  Mastodon-style line-separated paragraphs survive the HTML strip pass.
    const withLineBreaks = decode(html).replace(/<br\s*\/?>/gi, '\r\n');
    const res = stripHtml(withLineBreaks);
    return anyAscii(res.result);
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
                return cb(err);
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
