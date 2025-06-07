/* jslint node: true */
'use strict';

//  ENiGMA½
const { getMessageAreaByTag, getMessageConferenceByTag } = require('./message_area.js');
const { getAvailableMessageConferences, getAvailableMessageAreasByConfTag } = require('./message_area.js');
const { getMessageListForArea } = require('./message_area.js');
const Message = require('./message.js');
const getServer = require('./listening_server.js').getServer;
const webServerPackageName = require('./servers/content/web.js').moduleInfo.packageName;
const Log = require('./logger.js').log;
const { Errors } = require('./enig_error.js');
const moment = require('moment');

class MessageAreaWebAccess {
    constructor() {
        this.log = Log.child({ module: 'MessageAreaWebAccess' });
    }

    startup(cb) {
        const self = this;

        this.webServer = getServer(webServerPackageName);
        if (!this.webServer) {
            return cb(Errors.DoesNotExist(`Server with package name "${webServerPackageName}" does not exist`));
        }

        if (!this.isEnabled()) {
            const config = require('./config.js').get();
            if (config.contentServers.web.messageAreaApi === false) {
                self.log.info('Message area web API is disabled by configuration');
            }
            return cb(null);
        }

        //  Add all API routes
        const routes = [
            {
                method: 'GET',
                path: '^/api/v1/message-areas/conferences/?(?:\\?.*)?$',
                handler: this.listConferencesHandler.bind(this),
            },
            {
                method: 'GET',
                path: '^/api/v1/message-areas/conferences/([^/]+)/areas/?(?:\\?.*)?$',
                handler: this.listAreasHandler.bind(this),
            },
            {
                method: 'GET',
                path: '^/api/v1/message-areas/areas/([^/]+)/messages/?(?:\\?.*)?$',
                handler: this.listMessagesHandler.bind(this),
            },
            {
                method: 'GET',
                path: '^/api/v1/message-areas/messages/([a-f0-9-]+)/?(?:\\?.*)?$',
                handler: this.getMessageHandler.bind(this),
            }
        ];

        routes.forEach(route => {
            const success = this.webServer.instance.addRoute(route);
            if (!success) {
                self.log.error({ route }, 'Failed to add route');
            }
        });

        self.log.info('Message area web API initialized');
        return cb(null);
    }

    shutdown(cb) {
        return cb(null);
    }

    isEnabled() {
        const config = require('./config.js').get();
        return this.webServer &&
               this.webServer.instance.isEnabled() &&
               config.contentServers.web.messageAreaApi !== false;  // default to true if not specified
    }

    sendJsonResponse(resp, data, statusCode = 200) {
        const json = JSON.stringify(data, null, 2);
        const headers = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(json),
            'Access-Control-Allow-Origin': '*',
        };

        resp.writeHead(statusCode, headers);
        return resp.end(json);
    }

    sendError(resp, error, statusCode = 500) {
        return this.sendJsonResponse(resp, {
            error: true,
            message: error.message || error
        }, statusCode);
    }

    listConferencesHandler(req, resp) {
        //  Get all available conferences
        const conferences = getAvailableMessageConferences(null, { noClient: true });

        const response = {
            conferences: Object.keys(conferences).map(confTag => {
                const conf = conferences[confTag];
                return {
                    confTag,
                    name: conf.name,
                    desc: conf.desc,
                    sort: conf.sort,
                    areaCount: Object.keys(conf.areas || {}).length
                };
            })
        };

        return this.sendJsonResponse(resp, response);
    }

    listAreasHandler(req, resp, pathMatches) {
        if (!pathMatches || pathMatches.length < 2) {
            return this.sendError(resp, 'Invalid conference tag', 400);
        }
        const confTag = pathMatches[1];

        //  Validate conference exists
        const conference = getMessageConferenceByTag(confTag);
        if (!conference) {
            return this.sendError(resp, 'Conference not found', 404);
        }

        //  Get areas in this conference
        const areas = getAvailableMessageAreasByConfTag(confTag, { noAcsCheck: true });

        //  Filter out private areas
        const publicAreas = Object.keys(areas)
            .filter(areaTag => !Message.isPrivateAreaTag(areaTag))
            .map(areaTag => {
                const area = areas[areaTag];
                return {
                    areaTag,
                    confTag,
                    name: area.name,
                    desc: area.desc,
                    sort: area.sort
                };
            });

        const response = {
            conference: {
                confTag,
                name: conference.name,
                desc: conference.desc
            },
            areas: publicAreas
        };

        return this.sendJsonResponse(resp, response);
    }

    parseQueryParams(url) {
        const params = {};
        const queryStart = url.indexOf('?');

        if (queryStart === -1) {
            return params;
        }

        const queryString = url.substring(queryStart + 1);
        const pairs = queryString.split('&');

        pairs.forEach(pair => {
            const [key, value] = pair.split('=');
            if (key) {
                params[decodeURIComponent(key)] = value ? decodeURIComponent(value) : '';
            }
        });

        return params;
    }

    listMessagesHandler(req, resp, pathMatches) {
        if (!pathMatches || pathMatches.length < 2) {
            return this.sendError(resp, 'Invalid area tag', 400);
        }

        const areaTag = pathMatches[1];
        const queryParams = this.parseQueryParams(req.url);

        //  Validate area exists and is not private
        const area = getMessageAreaByTag(areaTag);
        if (!area) {
            return this.sendError(resp, 'Area not found', 404);
        }

        if (Message.isPrivateAreaTag(areaTag)) {
            return this.sendError(resp, 'Access denied', 403);
        }

        //  Parse pagination parameters
        const page = parseInt(queryParams.page) || 1;
        const limit = Math.min(parseInt(queryParams.limit) || 50, 200); // max 200 messages per page
        const offset = (page - 1) * limit;
        const includeReplies = queryParams.include_replies === 'true';

        //  Build filter for message list
        const filter = {
            areaTag,
            resultType: 'messageList',
            sort: 'messageId',
            order: queryParams.order === 'ascending' ? 'ascending' : 'descending',
            limit: limit + 1, // Get one extra to determine if there's a next page
        };

        getMessageListForArea(null, areaTag, filter, (err, messages) => {
            if (err) {
                return this.sendError(resp, 'Failed to retrieve messages', 500);
            }

            //  Determine if there's a next page
            const hasMore = messages.length > limit;
            if (hasMore) {
                messages.pop(); // Remove the extra message
            }

            //  Apply offset manually since the DB query doesn't support it directly
            const paginatedMessages = messages.slice(offset, offset + limit);

            if (!includeReplies) {
                //  Transform messages for response without replies (faster)
                const messageList = paginatedMessages.map(msg => ({
                    messageId: msg.messageId,
                    messageUuid: msg.messageUuid,
                    subject: msg.subject,
                    fromUserName: msg.fromUserName,
                    toUserName: msg.toUserName,
                    modTimestamp: this.formatTimestamp(msg.modTimestamp),
                    replyToMsgId: msg.replyToMsgId || null
                }));

                const response = {
                    area: {
                        areaTag: area.areaTag,
                        confTag: area.confTag,
                        name: area.name,
                        desc: area.desc
                    },
                    pagination: {
                        page,
                        limit,
                        hasMore: offset + limit < messages.length || hasMore,
                        total: null // We don't have an efficient way to get total count
                    },
                    messages: messageList
                };

                return this.sendJsonResponse(resp, response);
            } else {
                //  Include replies - requires additional queries
                const async = require('async');
                async.map(paginatedMessages, (msg, nextMsg) => {
                    this.getRepliesForMessage(msg.messageId, msg.areaTag, (err, replies) => {
                        if (err) {
                            replies = []; // Continue without replies if lookup fails
                        }

                        const messageWithReplies = {
                            messageId: msg.messageId,
                            messageUuid: msg.messageUuid,
                            subject: msg.subject,
                            fromUserName: msg.fromUserName,
                            toUserName: msg.toUserName,
                            modTimestamp: this.formatTimestamp(msg.modTimestamp),
                            replyToMsgId: msg.replyToMsgId || null,
                            replies: replies
                        };

                        return nextMsg(null, messageWithReplies);
                    });
                }, (err, messageList) => {
                    if (err) {
                        return this.sendError(resp, 'Failed to retrieve message replies', 500);
                    }

                    const response = {
                        area: {
                            areaTag: area.areaTag,
                            confTag: area.confTag,
                            name: area.name,
                            desc: area.desc
                        },
                        pagination: {
                            page,
                            limit,
                            hasMore: offset + limit < messages.length || hasMore,
                            total: null // We don't have an efficient way to get total count
                        },
                        messages: messageList
                    };

                    return this.sendJsonResponse(resp, response);
                });
            }
        });
    }

    getMessageHandler(req, resp, pathMatches) {
        if (!pathMatches || pathMatches.length < 2) {
            return this.sendError(resp, 'Invalid message UUID', 400);
        }

        const messageUuid = pathMatches[1];

        const message = new Message();
        message.load({ uuid: messageUuid }, err => {
            if (err) {
                return this.sendError(resp, 'Message not found', 404);
            }

            //  Check if message is in a private area
            if (Message.isPrivateAreaTag(message.areaTag)) {
                return this.sendError(resp, 'Access denied', 403);
            }

            //  Get area info
            const area = getMessageAreaByTag(message.areaTag);
            if (!area) {
                return this.sendError(resp, 'Area not found', 404);
            }

            //  Get replies to this message
            this.getRepliesForMessage(message.messageId, message.areaTag, (err, replies) => {
                if (err) {
                    this.log.warn({ error: err.message }, 'Failed to load replies');
                    replies = []; // Continue without replies if lookup fails
                }

                //  Build response
                const response = {
                    message: {
                        messageId: message.messageId,
                        messageUuid: message.messageUuid,
                        areaTag: message.areaTag,
                        subject: message.subject,
                        fromUserName: message.fromUserName,
                        toUserName: message.toUserName,
                        modTimestamp: this.formatTimestamp(message.modTimestamp),
                        replyToMsgId: message.replyToMsgId || null,
                        message: message.message,
                        meta: message.meta || {},
                        replies: replies
                    },
                    area: {
                        areaTag: area.areaTag,
                        confTag: area.confTag,
                        name: area.name,
                        desc: area.desc
                    }
                };

                return this.sendJsonResponse(resp, response);
            });
        });
    }

    formatTimestamp(timestamp) {
        if (moment.isMoment(timestamp)) {
            return timestamp.format('YYYY-MM-DDTHH:mm:ss.SSSZ');
        } else if (timestamp instanceof Date) {
            return moment(timestamp).format('YYYY-MM-DDTHH:mm:ss.SSSZ');
        } else if (typeof timestamp === 'string') {
            return moment(timestamp).format('YYYY-MM-DDTHH:mm:ss.SSSZ');
        } else if (typeof timestamp === 'number') {
            return moment.unix(timestamp).format('YYYY-MM-DDTHH:mm:ss.SSSZ');
        } else {
            return moment().format('YYYY-MM-DDTHH:mm:ss.SSSZ'); // fallback to current time
        }
    }

    getRepliesForMessage(messageId, areaTag, cb) {
        const filter = {
            areaTag,
            replyToMessageId: messageId,
            resultType: 'messageList',
            sort: 'messageId',
            order: 'ascending'  // replies in chronological order
        };

        Message.findMessages(filter, (err, replies) => {
            if (err) {
                return cb(err);
            }

            const replyList = replies
                .filter(reply => !Message.isPrivateAreaTag(reply.areaTag))  // ensure no private areas
                .map(reply => ({
                    messageId: reply.messageId,
                    messageUuid: reply.messageUuid,
                    subject: reply.subject,
                    fromUserName: reply.fromUserName,
                    toUserName: reply.toUserName,
                    modTimestamp: this.formatTimestamp(reply.modTimestamp)
                }));

            return cb(null, replyList);
        });
    }
}

module.exports = new MessageAreaWebAccess();