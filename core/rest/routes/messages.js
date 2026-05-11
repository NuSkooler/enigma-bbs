'use strict';

const {
    jsonResponse,
    problemDetail,
    applyCorsHeaders,
    parseJsonBody,
    encodeCursor,
    decodeCursor,
    paginationMeta,
    API_BASE,
} = require('../util');
const { resolveAuthenticatedUser, requireAuth } = require('../auth');

const {
    getAvailableMessageConferences,
    getAvailableMessageAreasByConfTag,
    getMessageAreaByTag,
    getMessageConferenceByTag,
    getMessageConfTagByAreaTag,
    hasMessageConfAndAreaRead,
    hasMessageConfAndAreaWrite,
    getMessageListForArea,
    persistMessage,
} = require('../../message_area');

const Message = require('../../message');
const { WellKnownAreaTags } = require('../../message_const');
const ACS = require('../../acs');
const Config = require('../../config').get;
const User = require('../../user');

const BLOCKED_AREA_TAGS = new Set([
    WellKnownAreaTags.Private,
    WellKnownAreaTags.ActivityPubShared,
    'activitypub_internal',
]);

const moment = require('moment');
const _ = require('lodash');

const ROUTE_BASE = `${API_BASE}/messages`;
const PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

exports.register = function register(webServer, log) {
    webServer.addRoute({
        method: 'GET',
        path: new RegExp(`^${ROUTE_BASE}/conferences$`),
        handler: (req, resp) => _conferencesHandler(req, resp, log),
    });

    webServer.addRoute({
        method: 'GET',
        path: new RegExp(`^${ROUTE_BASE}/conferences/([^/]+)$`),
        handler: (req, resp) => _conferenceDetailHandler(req, resp, log),
    });

    webServer.addRoute({
        method: 'GET',
        path: new RegExp(`^${ROUTE_BASE}/areas/([^/]+)$`),
        handler: (req, resp) => _areaDetailHandler(req, resp, log),
    });

    webServer.addRoute({
        method: 'GET',
        path: new RegExp(`^${ROUTE_BASE}/areas/([^/]+)/messages$`),
        handler: (req, resp) => _messageListHandler(req, resp, log),
    });

    webServer.addRoute({
        method: 'POST',
        path: new RegExp(`^${ROUTE_BASE}/areas/([^/]+)/messages$`),
        handler: (req, resp) => _postMessageHandler(req, resp, log),
    });

    webServer.addRoute({
        method: 'GET',
        path: new RegExp(`^${ROUTE_BASE}/([0-9a-f-]{36})$`),
        handler: (req, resp) => _messageDetailHandler(req, resp, log),
    });

    webServer.addRoute({
        method: 'DELETE',
        path: new RegExp(`^${ROUTE_BASE}/([0-9a-f-]{36})$`),
        handler: (req, resp) => _deleteMessageHandler(req, resp, log),
    });
};

//  Build a minimal ACS-capable subject from a loaded User instance
function _acsForUser(user) {
    return new ACS({ user });
}

//  Check whether an area tag is publicly exposed via restApi.messages.publicAccess config
function _isAreaPublic(areaTag) {
    const config = Config();
    const publicAccess =
        config.contentServers?.web?.restApi?.messages?.publicAccess || {};
    const confTag = getMessageConfTagByAreaTag(areaTag);
    if (!confTag) {
        return false;
    }
    const rule = publicAccess[confTag];
    if (!rule) {
        return false;
    }
    const included = _matchesGlob(areaTag, rule.include || []);
    const excluded = _matchesGlob(areaTag, rule.exclude || []);
    return included && !excluded;
}

function _matchesGlob(tag, patterns) {
    if (!patterns.length) {
        return false;
    }
    return patterns.some(p => {
        if (p === '*') {
            return true;
        }
        if (p.endsWith('*')) {
            return tag.startsWith(p.slice(0, -1));
        }
        return tag === p;
    });
}

//  Resolve auth and check area read access. Calls cb(authedUser|null, areaObj) on
//  success, or writes an error response and returns without calling cb.
function _resolveAreaReadAccess(req, resp, areaTag, cb) {
    const area = getMessageAreaByTag(areaTag);
    if (!area) {
        return problemDetail(resp, 404, 'Not Found', `Area '${areaTag}' not found`);
    }

    //  System/internal areas are never accessible via the REST API
    if (BLOCKED_AREA_TAGS.has(areaTag)) {
        return problemDetail(
            resp,
            403,
            'Forbidden',
            'This area is not accessible via the REST API'
        );
    }

    resolveAuthenticatedUser(req, (err, authedUser) => {
        if (authedUser) {
            //  Authenticated — do a full ACS check
            User.getUser(authedUser.userId, (err, user) => {
                if (err || !user) {
                    return problemDetail(resp, 401, 'Authentication Required');
                }
                const acs = _acsForUser(user);
                const conf = getMessageConferenceByTag(
                    area.confTag || getMessageConfTagByAreaTag(areaTag)
                );
                if (
                    !acs.hasMessageConfRead(conf || {}) ||
                    !acs.hasMessageAreaRead(area)
                ) {
                    return problemDetail(
                        resp,
                        403,
                        'Forbidden',
                        'Insufficient access to this area'
                    );
                }
                return cb(user, area);
            });
        } else {
            //  Unauthenticated — must be in the public allowlist
            if (!_isAreaPublic(areaTag)) {
                return problemDetail(resp, 401, 'Authentication Required');
            }
            return cb(null, area);
        }
    });
}

function _serializeConference(confTag, conf) {
    return {
        confTag,
        name: conf.name || confTag,
        desc: conf.desc || undefined,
    };
}

function _serializeArea(areaTag, area) {
    return {
        areaTag,
        name: area.name || areaTag,
        desc: area.desc || undefined,
        confTag: area.confTag || getMessageConfTagByAreaTag(areaTag),
    };
}

function _serializeMessageSummary(msg) {
    return {
        messageId: msg.messageId || msg.message_id,
        uuid: msg.messageUuid || msg.message_uuid,
        areaTag: msg.areaTag || msg.area_tag,
        replyToMessageId: msg.replyToMessageId || msg.reply_to_message_id || undefined,
        toUserName: msg.toUserName || msg.to_user_name,
        fromUserName: msg.fromUserName || msg.from_user_name,
        subject: msg.subject,
        timestamp: moment(msg.modTimestamp || msg.modified_timestamp).toISOString(),
    };
}

function _serializeMessageFull(msg) {
    const out = _serializeMessageSummary(msg);
    out.body = msg.message;
    //  Include FTN/network meta if present — clients can use this to identify networked msgs
    if (msg.meta?.System) {
        const sys = msg.meta.System;
        const net = {};
        if (sys.FtnOrigNode) {
            net.ftnOrigNode = sys.FtnOrigNode;
        }
        if (sys.FtnArea) {
            net.ftnArea = sys.FtnArea;
        }
        if (sys.FtnTearLine) {
            net.ftnTearLine = sys.FtnTearLine;
        }
        if (Object.keys(net).length) {
            out.network = net;
        }
    }
    return out;
}

function _conferencesHandler(req, resp, log) {
    applyCorsHeaders(req, resp);

    resolveAuthenticatedUser(req, (err, authedUser) => {
        let confs;

        if (authedUser) {
            User.getUser(authedUser.userId, (err, user) => {
                if (err || !user) {
                    return problemDetail(resp, 401, 'Authentication Required');
                }
                //  Pass a minimal client-like object that satisfies getAvailableMessageConferences
                const fakeClient = { acs: _acsForUser(user) };
                confs = getAvailableMessageConferences(fakeClient, {});
                return _sendConferences(resp, confs);
            });
        } else {
            //  Unauthenticated: return only conferences that contain at least one public area
            const config = Config();
            const publicAccess =
                config.contentServers?.web?.restApi?.messages?.publicAccess || {};
            confs = getAvailableMessageConferences(null, { noClient: true });
            const publicConfTags = new Set(Object.keys(publicAccess));
            confs = _.pickBy(confs, (_v, tag) => publicConfTags.has(tag));
            return _sendConferences(resp, confs);
        }
    });
}

function _sendConferences(resp, confs) {
    const data = Object.entries(confs || {}).map(([confTag, conf]) =>
        _serializeConference(confTag, conf)
    );
    return jsonResponse(resp, 200, paginationMeta(data, null));
}

function _conferenceDetailHandler(req, resp, log) {
    applyCorsHeaders(req, resp);

    const confTag = req.url.match(/\/conferences\/([^/?]+)/)?.[1];
    if (!confTag) {
        return problemDetail(resp, 400, 'Bad Request');
    }

    const conf = getMessageConferenceByTag(confTag);
    if (!conf) {
        return problemDetail(resp, 404, 'Not Found', `Conference '${confTag}' not found`);
    }

    resolveAuthenticatedUser(req, (err, authedUser) => {
        const _send = user => {
            const fakeClient = user ? { acs: _acsForUser(user) } : null;
            const areas = getAvailableMessageAreasByConfTag(confTag, {
                client: fakeClient,
                noAcsCheck: !fakeClient,
            });
            const areaData = Object.entries(areas || {})
                .filter(([areaTag]) => (fakeClient ? true : _isAreaPublic(areaTag)))
                .map(([areaTag, area]) => _serializeArea(areaTag, { ...area, confTag }));

            return jsonResponse(resp, 200, {
                ..._serializeConference(confTag, conf),
                areas: areaData,
            });
        };

        if (authedUser) {
            User.getUser(authedUser.userId, (err, user) => {
                if (err || !user) {
                    return problemDetail(resp, 401, 'Authentication Required');
                }
                return _send(user);
            });
        } else {
            return _send(null);
        }
    });
}

function _areaDetailHandler(req, resp, log) {
    applyCorsHeaders(req, resp);

    const areaTag = req.url.match(/\/areas\/([^/?]+)$/)?.[1];
    if (!areaTag) {
        return problemDetail(resp, 400, 'Bad Request');
    }

    _resolveAreaReadAccess(req, resp, areaTag, (_user, area) => {
        const confTag = getMessageConfTagByAreaTag(areaTag);
        return jsonResponse(resp, 200, _serializeArea(areaTag, { ...area, confTag }));
    });
}

function _messageListHandler(req, resp, log) {
    applyCorsHeaders(req, resp);

    const areaTag = req.url.match(/\/areas\/([^/?]+)\/messages/)?.[1];
    if (!areaTag) {
        return problemDetail(resp, 400, 'Bad Request');
    }

    _resolveAreaReadAccess(req, resp, areaTag, (_user, _area) => {
        const params = new URL(req.url, 'http://localhost').searchParams;
        const limit = Math.min(
            parseInt(params.get('limit') || PAGE_SIZE, 10),
            MAX_PAGE_SIZE
        );
        const cursorParam = params.get('cursor');

        let afterMessageId = 0;
        if (cursorParam) {
            const decoded = decodeCursor(cursorParam);
            afterMessageId = decoded?.messageId || 0;
        }

        const filter = {
            resultType: 'messageList',
            sort: 'messageId',
            order: 'ascending',
            newerThanMessageId: afterMessageId,
            limit: limit + 1, // fetch one extra to detect next page
        };

        getMessageListForArea(null, areaTag, filter, (err, messages) => {
            if (err) {
                log.error({ err, areaTag }, 'Error fetching message list');
                return problemDetail(resp, 500, 'Internal Server Error');
            }

            const hasMore = messages.length > limit;
            if (hasMore) {
                messages = messages.slice(0, limit);
            }

            const data = messages.map(_serializeMessageSummary);
            const lastMsg = data[data.length - 1];
            const nextCursor =
                hasMore && lastMsg
                    ? encodeCursor({ messageId: lastMsg.messageId })
                    : null;

            return jsonResponse(resp, 200, paginationMeta(data, nextCursor));
        });
    });
}

function _messageDetailHandler(req, resp, log) {
    applyCorsHeaders(req, resp);

    const uuid = req.url.match(/\/messages\/([0-9a-f-]{36})/)?.[1];
    if (!uuid) {
        return problemDetail(resp, 400, 'Bad Request');
    }

    const msg = new Message();
    msg.load({ uuid }, err => {
        if (err) {
            return problemDetail(resp, 404, 'Not Found', 'Message not found');
        }

        //  Check area access after loading (we need the areaTag from the message)
        _resolveAreaReadAccess(req, resp, msg.areaTag, () => {
            return jsonResponse(resp, 200, _serializeMessageFull(msg));
        });
    });
}

function _postMessageHandler(req, resp, log) {
    applyCorsHeaders(req, resp);

    const areaTag = req.url.match(/\/areas\/([^/?]+)\/messages/)?.[1];
    if (!areaTag) {
        return problemDetail(resp, 400, 'Bad Request');
    }

    requireAuth(req, resp, authedUser => {
        User.getUser(authedUser.userId, (err, user) => {
            if (err || !user) {
                return problemDetail(resp, 401, 'Authentication Required');
            }

            const area = getMessageAreaByTag(areaTag);
            if (!area) {
                return problemDetail(
                    resp,
                    404,
                    'Not Found',
                    `Area '${areaTag}' not found`
                );
            }

            if (BLOCKED_AREA_TAGS.has(areaTag)) {
                return problemDetail(
                    resp,
                    403,
                    'Forbidden',
                    'This area is not accessible via the REST API'
                );
            }

            const acs = _acsForUser(user);
            const confTag = getMessageConfTagByAreaTag(areaTag);
            const conf = getMessageConferenceByTag(confTag);
            if (!acs.hasMessageConfWrite(conf || {}) || !acs.hasMessageAreaWrite(area)) {
                return problemDetail(
                    resp,
                    403,
                    'Forbidden',
                    'Insufficient access to post to this area'
                );
            }

            parseJsonBody(req, (err, body) => {
                if (err) {
                    return problemDetail(resp, 400, 'Bad Request', 'Invalid JSON body');
                }

                const { subject, message, toUserName, replyToMessageId } = body || {};
                if (!subject || !message) {
                    return problemDetail(
                        resp,
                        400,
                        'Bad Request',
                        '"subject" and "message" are required'
                    );
                }

                const msg = new Message({
                    areaTag,
                    toUserName: toUserName || 'All',
                    fromUserName: user.username,
                    subject: String(subject).slice(0, 72),
                    message: String(message),
                    modTimestamp: moment(),
                });

                msg.setLocalFromUserId(user.userId);

                if (replyToMessageId && Number.isInteger(replyToMessageId)) {
                    msg.replyToMessageId = replyToMessageId;
                }

                persistMessage(msg, err => {
                    if (err) {
                        log.error({ err, areaTag }, 'Error persisting message');
                        return problemDetail(resp, 500, 'Internal Server Error');
                    }

                    log.info(
                        { userId: user.userId, areaTag, uuid: msg.messageUuid },
                        'Message posted via REST API'
                    );

                    return jsonResponse(resp, 201, _serializeMessageSummary(msg));
                });
            });
        });
    });
}

function _deleteMessageHandler(req, resp, log) {
    applyCorsHeaders(req, resp);

    const uuid = req.url.match(/\/messages\/([0-9a-f-]{36})/)?.[1];
    if (!uuid) {
        return problemDetail(resp, 400, 'Bad Request');
    }

    requireAuth(req, resp, authedUser => {
        User.getUser(authedUser.userId, (err, user) => {
            if (err || !user) {
                return problemDetail(resp, 401, 'Authentication Required');
            }

            const msg = new Message();
            msg.load({ uuid }, err => {
                if (err) {
                    return problemDetail(resp, 404, 'Not Found', 'Message not found');
                }

                const isSysop = user.isGroupMember('sysops');
                const localFromId = parseInt(
                    msg.meta?.System?.[Message.SystemMetaNames.LocalFromUserID] || '0',
                    10
                );
                const isOwn =
                    localFromId === user.userId || msg.fromUserName === user.username;

                if (!isSysop && !isOwn) {
                    return problemDetail(
                        resp,
                        403,
                        'Forbidden',
                        'You can only delete your own messages'
                    );
                }

                //  deleteMessage enforces its own rights check; we pass user for that path,
                //  but our sysop/own check above already covers the REST use case
                try {
                    const { dbs } = require('../../database');
                    dbs.message
                        .prepare('DELETE FROM message WHERE message_uuid = ?')
                        .run(msg.messageUuid);
                } catch (delErr) {
                    log.error({ err: delErr, uuid }, 'Error deleting message');
                    return problemDetail(resp, 500, 'Internal Server Error');
                }

                log.info({ userId: user.userId, uuid }, 'Message deleted via REST API');
                resp.writeHead(204);
                return resp.end();
            });
        });
    });
}
