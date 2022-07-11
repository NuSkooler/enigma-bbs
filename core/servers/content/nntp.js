/* jslint node: true */
'use strict';

//  ENiGMA½
const Log = require('../../logger.js').log;
const { ServerModule } = require('../../server_module.js');
const Config = require('../../config.js').get;
const { getTransactionDatabase, getModDatabasePath } = require('../../database.js');
const {
    getMessageAreaByTag,
    getMessageConferenceByTag,
} = require('../../message_area.js');
const User = require('../../user.js');
const Errors = require('../../enig_error.js').Errors;
const Message = require('../../message.js');
const FTNAddress = require('../../ftn_address.js');
const {
    isAnsi,
    stripAnsiControlCodes,
    splitTextAtTerms,
} = require('../../string_util.js');
const AnsiPrep = require('../../ansi_prep.js');
const { stripMciColorCodes } = require('../../color_codes.js');

//  deps
const NNTPServerBase = require('nntp-server');
const _ = require('lodash');
const fs = require('fs-extra');
const forEachSeries = require('async/forEachSeries');
const asyncReduce = require('async/reduce');
const asyncMap = require('async/map');
const asyncSeries = require('async/series');
const asyncWaterfall = require('async/waterfall');
const LRU = require('lru-cache');
const sqlite3 = require('sqlite3');
const paths = require('path');

//
//  Network News Transfer Protocol (NNTP)
//
//  RFCS
//  - https://www.w3.org/Protocols/rfc977/rfc977
//  - https://tools.ietf.org/html/rfc3977
//  - https://tools.ietf.org/html/rfc2980
//  - https://tools.ietf.org/html/rfc5536

//
exports.moduleInfo = {
    name: 'NNTP',
    desc: 'Network News Transfer Protocol (NNTP) Server',
    author: 'NuSkooler',
    packageName: 'codes.l33t.enigma.nntp.server',
};

exports.performMaintenanceTask = performMaintenanceTask;

/*
    General TODO
    - ACS checks need worked out. Currently ACS relies on |client|. We need a client
      spec that can be created even without a login server. Some checks and simply
      return false/fail.
*/

//  simple DB maps NNTP Message-ID's which are
//  sequential per group -> ENiG messages
//  A single instance is shared across NNTP and/or NNTPS
class NNTPDatabase {
    constructor() {}

    init(cb) {
        asyncSeries(
            [
                callback => {
                    this.db = getTransactionDatabase(
                        new sqlite3.Database(
                            getModDatabasePath(exports.moduleInfo),
                            err => {
                                return callback(err);
                            }
                        )
                    );
                },
                callback => {
                    this.db.serialize(() => {
                        this.db.run(
                            `CREATE TABLE IF NOT EXISTS nntp_area_message (
                                nntp_message_id     INTEGER NOT NULL,
                                message_id          INTEGER NOT NULL,
                                message_area_tag    VARCHAR NOT NULL,
                                message_uuid        VARCHAR NOT NULL,

                                UNIQUE(nntp_message_id, message_area_tag)
                            );`
                        );

                        this.db.run(
                            `CREATE INDEX IF NOT EXISTS nntp_area_message_by_uuid_index
                            ON nntp_area_message (message_uuid);`
                        );

                        return callback(null);
                    });
                },
            ],
            err => {
                return cb(err);
            }
        );
    }
}

let nntpDatabase;

class NNTPServer extends NNTPServerBase {
    constructor(options, serverName) {
        super(options);

        this.log = Log.child({ server: serverName });

        const config = Config();
        this.groupCache = new LRU({
            max: _.get(config, 'contentServers.nntp.cache.maxItems', 200),
            ttl: _.get(config, 'contentServers.nntp.cache.maxAge', 1000 * 30), //  default=30s
        });
    }

    _needAuth(session, command) {
        return super._needAuth(session, command);
    }

    _authenticate(session) {
        const username = session.authinfo_user;
        const password = session.authinfo_pass;

        this.log.trace({ username }, 'Authentication request');

        return new Promise(resolve => {
            const user = new User();
            user.authenticateFactor1(
                { type: User.AuthFactor1Types.Password, username, password },
                err => {
                    if (err) {
                        //  :TODO: Log IP address
                        this.log.debug(
                            { username, reason: err.message },
                            'Authentication failure'
                        );
                        return resolve(false);
                    }

                    session.authUser = user;

                    this.log.debug({ username }, 'User authenticated successfully');
                    return resolve(true);
                }
            );
        });
    }

    isGroupSelected(session) {
        return Array.isArray(_.get(session, 'groupInfo.messageList'));
    }

    getJAMStyleFrom(message, fromName) {
        //
        //  Try to to create a (JamNTTPd) JAM style "From" field:
        //
        //  -   If we're dealing with a FTN address, create an email-like format
        //      but do not include ':' or '/' characters as it may cause clients
        //      to puke. FTN addresses are formatted how JamNTTPd does it for
        //      some sort of compliance. We also extend up to 5D addressing.
        //  -   If we have an email address, then it's ready to go.
        //
        const remoteFrom = _.get(message.meta, [
            'System',
            Message.SystemMetaNames.RemoteFromUser,
        ]);
        let jamStyleFrom;
        if (remoteFrom) {
            const flavor = _.get(message.meta, [
                'System',
                Message.SystemMetaNames.ExternalFlavor,
            ]);
            switch (flavor) {
                case [Message.AddressFlavor.FTN]:
                    {
                        let ftnAddr = FTNAddress.fromString(remoteFrom);
                        if (ftnAddr && ftnAddr.isValid()) {
                            //  In general, addresses are in point, node, net, zone, domain order
                            if (ftnAddr.domain) {
                                //  5D
                                // point.node.net.zone@domain or node.net.zone@domain
                                jamStyleFrom = `${ftnAddr.node}.${ftnAddr.net}.${ftnAddr.zone}@${ftnAddr.domain}`;
                                if (ftnAddr.point) {
                                    jamStyleFrom = `${ftnAddr.point}.` + jamStyleFrom;
                                }
                            } else {
                                if (ftnAddr.point) {
                                    jamStyleFrom = `${ftnAddr.point}@${ftnAddr.node}.${ftnAddr.net}.${ftnAddr.zone}`;
                                } else {
                                    jamStyleFrom = `0@${ftnAddr.node}.${ftnAddr.net}.${ftnAddr.zone}`;
                                }
                            }
                        }
                    }
                    break;

                case [Message.AddressFlavor.Email]:
                    jamStyleFrom = `${fromName} <${remoteFrom}>`;
                    break;
            }
        }

        if (!jamStyleFrom) {
            jamStyleFrom = fromName;
        }

        return jamStyleFrom;
    }

    populateNNTPHeaders(session, message, cb) {
        //
        //  Build compliant headers
        //
        //  Resources:
        //  - https://tools.ietf.org/html/rfc5536#section-3.1
        //  - https://github.com/ftnapps/jamnntpd/blob/master/src/nntpserv.c#L962
        //
        const toName = this.getMessageTo(message);
        const fromName = this.getMessageFrom(message);

        message.nntpHeaders = {
            From: this.getJAMStyleFrom(message, fromName),
            'X-Comment-To': toName,
            Newsgroups: session.group.name,
            Subject: message.subject,
            Date: this.getMessageDate(message),
            'Message-ID': this.getMessageIdentifier(message),
            Path: 'ENiGMA1/2!not-for-mail',
            'Content-Type': 'text/plain; charset=utf-8',
        };

        const externalFlavor = _.get(message.meta.System, [
            Message.SystemMetaNames.ExternalFlavor,
        ]);
        if (externalFlavor) {
            message.nntpHeaders['X-ENiG-MessageFlavor'] = externalFlavor;
        }

        //  Any FTN properties -> X-FTN-*
        _.each(message.meta.FtnProperty, (v, k) => {
            const suffix = {
                [Message.FtnPropertyNames.FtnTearLine]: 'Tearline',
                [Message.FtnPropertyNames.FtnOrigin]: 'Origin',
                [Message.FtnPropertyNames.FtnArea]: 'AREA',
                [Message.FtnPropertyNames.FtnSeenBy]: 'SEEN-BY',
            }[k];

            if (suffix) {
                //  some special treatment.
                if ('Tearline' === suffix) {
                    v = v.replace(/^--- /, '');
                } else if ('Origin' === suffix) {
                    v = v.replace(/^[ ]{1,2}\* Origin: /, '');
                }
                if (Array.isArray(v)) {
                    //  ie: SEEN-BY[] -> one big list
                    v = v.join(' ');
                }
                message.nntpHeaders[`X-FTN-${suffix}`] = v.trim();
            }
        });

        //  Other FTN kludges
        _.each(message.meta.FtnKludge, (v, k) => {
            if (Array.isArray(v)) {
                v = v.join(' '); //  same as above
            }
            message.nntpHeaders[`X-FTN-${k.toUpperCase()}`] = v.toString().trim();
        });

        //
        //  Set X-FTN-To and X-FTN-From:
        //  - If remote to/from : joeuser <remoteAddr>
        //  - Without remote    : joeuser
        //
        const remoteFrom = _.get(message.meta, [
            'System',
            Message.SystemMetaNames.RemoteFromUser,
        ]);
        message.nntpHeaders['X-FTN-From'] = remoteFrom
            ? `${fromName} <${remoteFrom}>`
            : fromName;
        const remoteTo = _.get(message.meta, [
            'System',
            Message.SystemMetaNames.RemoteToUser,
        ]);
        message.nntpHeaders['X-FTN-To'] = remoteTo ? `${toName} <${remoteTo}>` : toName;

        if (!message.replyToMsgId) {
            return cb(null);
        }

        //  replyToMessageId -> Message-ID formatted ID
        const filter = {
            resultType: 'uuid',
            ids: [parseInt(message.replyToMsgId)],
            limit: 1,
        };
        Message.findMessages(filter, (err, uuids) => {
            if (!err && Array.isArray(uuids)) {
                message.nntpHeaders.References = this.makeMessageIdentifier(
                    message.replyToMsgId,
                    uuids[0]
                );
            }
            return cb(null);
        });
    }

    getMessageUUIDFromMessageID(session, messageId) {
        let messageUuid;

        //  Direct ID request
        if (
            (_.isString(messageId) && '<' !== messageId.charAt(0)) ||
            _.isNumber(messageId)
        ) {
            //  group must be in session
            if (!this.isGroupSelected(session)) {
                return null;
            }

            messageId = parseInt(messageId);
            if (isNaN(messageId)) {
                return null;
            }

            const msg = session.groupInfo.messageList.find(m => {
                return m.index === messageId;
            });

            messageUuid = msg && msg.messageUuid;
        } else {
            //  <Message-ID> request
            [, messageUuid] = this.getMessageIdentifierParts(messageId);
        }

        if (!_.isString(messageUuid)) {
            return null;
        }

        return messageUuid;
    }

    _getArticle(session, messageId) {
        return new Promise(resolve => {
            this.log.trace({ messageId }, 'Get article');

            const messageUuid = this.getMessageUUIDFromMessageID(session, messageId);
            if (!messageUuid) {
                this.log.debug(
                    { messageId },
                    'Unable to retrieve message UUID for article request'
                );
                return resolve(null);
            }

            const message = new Message();
            asyncSeries(
                [
                    callback => {
                        return message.load({ uuid: messageUuid }, callback);
                    },
                    callback => {
                        if (!_.has(session, 'groupInfo.areaTag')) {
                            //  :TODO: if this is needed, how to validate properly?
                            this.log.warn(
                                { messageUuid, messageId },
                                'Get article request without group selection'
                            );
                            return resolve(null);
                        }

                        if (session.groupInfo.areaTag !== message.areaTag) {
                            return resolve(null);
                        }

                        if (
                            !this.hasConfAndAreaReadAccess(
                                session,
                                session.groupInfo.confTag,
                                session.groupInfo.areaTag
                            )
                        ) {
                            this.log.info(
                                { messageUuid, messageId },
                                'Access denied for message'
                            );
                            return resolve(null);
                        }

                        return callback(null);
                    },
                    callback => {
                        return this.populateNNTPHeaders(session, message, callback);
                    },
                    callback => {
                        return this.prepareMessageBody(message, callback);
                    },
                ],
                err => {
                    if (err) {
                        this.log.error(
                            { error: err.message, messageUuid },
                            'Failed to load article'
                        );
                        return resolve(null);
                    }

                    this.log.info(
                        { messageUuid, messageId, areaTag: message.areaTag },
                        'Serving article'
                    );
                    return resolve(message);
                }
            );
        });
    }

    _getRange(session, first, last /*options*/) {
        return new Promise(resolve => {
            //
            //  Build an array of message objects that can later
            //  be used with the various _build* methods.
            //
            //  :TODO: Handle |options|
            if (!this.isGroupSelected(session)) {
                return resolve(null);
            }

            const uuids = session.groupInfo.messageList
                .filter(m => {
                    if (m.areaTag !== session.groupInfo.areaTag) {
                        return false;
                    }
                    if (m.index < first || m.index > last) {
                        return false;
                    }
                    return true;
                })
                .map(m => {
                    return { uuid: m.messageUuid, index: m.index };
                });

            asyncMap(
                uuids,
                (msgInfo, nextMessageUuid) => {
                    const message = new Message();
                    message.load({ uuid: msgInfo.uuid }, err => {
                        if (err) {
                            return nextMessageUuid(err);
                        }

                        message.index = msgInfo.index;

                        this.populateNNTPHeaders(session, message, () => {
                            this.prepareMessageBody(message, () => {
                                return nextMessageUuid(null, message);
                            });
                        });
                    });
                },
                (err, messages) => {
                    return resolve(err ? null : messages);
                }
            );
        });
    }

    _selectGroup(session, groupName) {
        this.log.trace({ groupName }, 'Select group request');

        return new Promise(resolve => {
            this.getGroup(session, groupName, (err, group) => {
                if (err) {
                    return resolve(false);
                }

                session.group = Object.assign(
                    {}, //  start clean
                    {
                        description: group.friendlyDesc || group.friendlyName,
                        current_article: group.nntp.total ? group.nntp.min_index : 0,
                    },
                    group.nntp
                );

                session.groupInfo = group; //  full set of info

                return resolve(true);
            });
        });
    }

    _getGroups(session, time, wildmat) {
        this.log.trace({ time, wildmat }, 'Get groups request');

        //  :TODO: handle time - probably use as caching mechanism - must consider user/auth/rights
        //  :TODO: handle |time| if possible.
        return new Promise((resolve, reject) => {
            const config = Config();

            //  :TODO: merge confs avail to authenticated user
            const publicConfs = _.get(
                config,
                'contentServers.nntp.publicMessageConferences',
                {}
            );

            asyncReduce(
                Object.keys(publicConfs),
                [],
                (groups, confTag, nextConfTag) => {
                    const areaTags = publicConfs[confTag];
                    //  :TODO: merge area tags available to authenticated user
                    asyncMap(
                        areaTags,
                        (areaTag, nextAreaTag) => {
                            const groupName = this.getGroupName(confTag, areaTag);

                            //  filter on |wildmat| if supplied. We will remove
                            //  empty areas below in the final results.
                            if (wildmat && !wildmat.test(groupName)) {
                                return nextAreaTag(null, null);
                            }

                            this.getGroup(session, groupName, (err, group) => {
                                if (err) {
                                    return nextAreaTag(null, null); //  try others
                                }
                                return nextAreaTag(null, group.nntp);
                            });
                        },
                        (err, areas) => {
                            if (err) {
                                return nextConfTag(err);
                            }

                            areas = areas.filter(a => a && Object.keys(a).length > 0); //  remove empty
                            groups.push(...areas);

                            return nextConfTag(null, groups);
                        }
                    );
                },
                (err, groups) => {
                    if (err) {
                        return reject(err);
                    }
                    return resolve(groups);
                }
            );
        });
    }

    isConfAndAreaPubliclyExposed(confTag, areaTag) {
        const publicAreaTags = _.get(Config(), [
            'contentServers',
            'nntp',
            'publicMessageConferences',
            confTag,
        ]);
        return Array.isArray(publicAreaTags) && publicAreaTags.includes(areaTag);
    }

    hasConfAndAreaReadAccess(session, confTag, areaTag) {
        if (Message.isPrivateAreaTag(areaTag)) {
            return false;
        }

        if (this.isConfAndAreaPubliclyExposed(confTag, areaTag)) {
            return true;
        }

        //  further checks require an authenticated user & ACS
        if (!session || !session.authUser) {
            return false;
        }

        const conf = getMessageConferenceByTag(confTag);
        if (!conf) {
            return false;
        }
        //  :TODO: validate ACS

        const area = getMessageAreaByTag(areaTag, confTag);
        if (!area) {
            return false;
        }
        //  :TODO: validate ACS

        return false;
    }

    getGroup(session, groupName, cb) {
        let group = this.groupCache.get(groupName);
        if (group) {
            return cb(null, group);
        }

        const [confTag, areaTag] = groupName.split('.');
        if (!confTag || !areaTag) {
            return cb(Errors.UnexpectedState(`Invalid NNTP group name: ${groupName}`));
        }

        if (!this.hasConfAndAreaReadAccess(session, confTag, areaTag)) {
            return cb(
                Errors.AccessDenied(
                    `No access to conference ${confTag} and/or area ${areaTag}`
                )
            );
        }

        const area = getMessageAreaByTag(areaTag, confTag);
        if (!area) {
            return cb(
                Errors.DoesNotExist(
                    `No area for areaTag "${areaTag}" / confTag "${confTag}"`
                )
            );
        }

        this.getMappedMessageListForArea(areaTag, (err, messageList) => {
            if (err) {
                return cb(err);
            }

            if (0 === messageList.length) {
                //
                //  Handle empty group
                //  See https://tools.ietf.org/html/rfc3977#section-6.1.1.2
                //
                return cb(null, {
                    messageList: [],
                    confTag,
                    areaTag,
                    friendlyName: area.name,
                    friendlyDesc: area.desc,
                    nntp: {
                        name: groupName,
                        description: area.desc,
                        min_index: 0,
                        max_index: 0,
                        total: 0,
                    },
                });
            }

            group = {
                messageList,
                confTag,
                areaTag,
                friendlyName: area.name,
                friendlyDesc: area.desc,
                nntp: {
                    name: groupName,
                    min_index: messageList[0].index,
                    max_index: messageList[messageList.length - 1].index,
                    total: messageList.length,
                },
            };

            this.groupCache.set(groupName, group);

            return cb(null, group);
        });
    }

    getMappedMessageListForArea(areaTag, cb) {
        //
        //  Get all messages in mapped database. Then, find any messages that are not
        //  yet mapped with ID's > the highest ID we have. Any new messages will have
        //  new mappings created.
        //
        //  :TODO: introduce caching
        asyncWaterfall(
            [
                callback => {
                    nntpDatabase.db.all(
                        `SELECT nntp_message_id, message_id, message_uuid
                        FROM nntp_area_message
                        WHERE message_area_tag = ?
                        ORDER BY nntp_message_id;`,
                        [areaTag],
                        (err, rows) => {
                            if (err) {
                                return callback(err);
                            }

                            let messageList;
                            const lastMessageId =
                                rows.length > 0 ? rows[rows.length - 1].message_id : 0;
                            if (!lastMessageId) {
                                messageList = [];
                            } else {
                                messageList = rows.map(r => {
                                    return {
                                        areaTag,
                                        index: r.nntp_message_id, //  node-nntp wants this name
                                        messageUuid: r.message_uuid,
                                    };
                                });
                            }

                            return callback(null, messageList, lastMessageId);
                        }
                    );
                },
                (messageList, lastMessageId, callback) => {
                    //  Find any new entries
                    const filter = {
                        areaTag,
                        newerThanMessageId: lastMessageId,
                        sort: 'messageId',
                        order: 'ascending',
                        resultType: 'messageList',
                    };
                    Message.findMessages(filter, (err, newMessageList) => {
                        if (err) {
                            return callback(err);
                        }

                        let index =
                            messageList.length > 0
                                ? messageList[messageList.length - 1].index + 1
                                : 1;
                        newMessageList = newMessageList.map(m => {
                            return Object.assign(m, { index: index++ });
                        });

                        if (0 === newMessageList.length) {
                            return callback(null, messageList);
                        }

                        //  populate mapping DB with any new entries
                        nntpDatabase.db.beginTransaction((err, trans) => {
                            if (err) {
                                return callback(err);
                            }

                            forEachSeries(
                                newMessageList,
                                (newMessage, nextNewMessage) => {
                                    trans.run(
                                        `INSERT INTO nntp_area_message (nntp_message_id, message_id, message_area_tag, message_uuid)
                                    VALUES (?, ?, ?, ?);`,
                                        [
                                            newMessage.index,
                                            newMessage.messageId,
                                            areaTag,
                                            newMessage.messageUuid,
                                        ],
                                        err => {
                                            return nextNewMessage(err);
                                        }
                                    );
                                },
                                err => {
                                    if (err) {
                                        return trans.rollback(() => {
                                            return callback(err);
                                        });
                                    }

                                    trans.commit(() => {
                                        messageList.push(
                                            ...newMessageList.map(m => {
                                                return {
                                                    areaTag,
                                                    index: m.nntpMessageId,
                                                    messageUuid: m.messageUuid,
                                                };
                                            })
                                        );

                                        return callback(null, messageList);
                                    });
                                }
                            );
                        });
                    });
                },
            ],
            (err, messageList) => {
                return cb(err, messageList);
            }
        );
    }

    _buildHead(session, message) {
        return _.map(message.nntpHeaders, (v, k) => `${k}: ${v}`).join('\r\n');
    }

    _buildBody(session, message) {
        return message.preparedBody;
    }

    _buildHeaderField(session, message, field) {
        const body = message.preparedBody || message.message;
        const value =
            {
                ':bytes': Buffer.byteLength(body).toString(),
                ':lines': splitTextAtTerms(body).length.toString(),
            }[field] ||
            _.find(message.nntpHeaders, (v, k) => {
                return k.toLowerCase() === field;
            });

        if (!value) {
            //
            //  Clients will check some headers just to see if they exist.
            //  Don't spam logs with these. For others, it's good to know.
            //
            if (!['references', 'xref'].includes(field)) {
                this.log.trace(`No value for requested header field "${field}"`);
            }
        }

        return value;
    }

    _getOverviewFmt(session) {
        return super._getOverviewFmt(session);
    }

    _getNewNews(session, time, wildmat) {
        //  Currently seems pointless to implement. No semi-modern clients seem to use it anyway.
        this.log.debug(
            { time, wildmat },
            'Request made using unsupported NEWNEWS command'
        );
        throw new Errors.Invalid('NEWNEWS is not enabled on this server');
    }

    getMessageDate(message) {
        //  https://tools.ietf.org/html/rfc5536#section-3.1.1 -> https://tools.ietf.org/html/rfc5322#section-3.3
        return message.modTimestamp.format('ddd, D MMM YYYY HH:mm:ss ZZ');
    }

    makeMessageIdentifier(messageId, messageUuid) {
        //
        //  Spec        : RFC-5536 Section 3.1.3 @ https://tools.ietf.org/html/rfc5536#section-3.1.3
        //  Example     : <2456.0f6587f7-5512-4d03-8740-4d592190145a@enigma-bbs>
        //
        return `<${messageId}.${messageUuid}@enigma-bbs>`;
    }

    getMessageIdentifier(message) {
        //  note that we use the *real* message ID here, not the NNTP-specific index.
        return this.makeMessageIdentifier(message.messageId, message.messageUuid);
    }

    getMessageIdentifierParts(messageId) {
        const m = messageId.match(
            /<([0-9]+)\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@enigma-bbs>/
        );
        if (m) {
            return [m[1], m[2]];
        }
        return [];
    }

    getMessageTo(message) {
        //  :TODO: same as From -- check config
        return message.toUserName;
    }

    getMessageFrom(message) {
        //  :TODO: NNTP config > conf > area config for real names
        return message.fromUserName;
    }

    prepareMessageBody(message, cb) {
        if (isAnsi(message.message)) {
            AnsiPrep(
                message.message,
                {
                    rows: 'auto',
                    cols: 79,
                    forceLineTerm: true,
                    asciiMode: true,
                    fillLines: false,
                },
                (err, prepped) => {
                    message.preparedBody = prepped || message.message;
                    return cb(null);
                }
            );
        } else {
            message.preparedBody = stripMciColorCodes(
                stripAnsiControlCodes(message.message, { all: true })
            );
            return cb(null);
        }
    }

    getGroupName(confTag, areaTag) {
        //
        //  Example:
        //  input : fsxNet (confTag) fsx_bbs (areaTag)
        //  output: fsx_net.fsx_bbs
        //
        //  Note also that periods are replaced in conf and area
        //  tags such that we *only* have a period separator
        //  between the two for a group name!
        //
        return `${_.snakeCase(confTag).replace(/\./g, '_')}.${_.snakeCase(
            areaTag
        ).replace(/\./g, '_')}`;
    }
}

exports.getModule = class NNTPServerModule extends ServerModule {
    constructor() {
        super();
    }

    isEnabled() {
        return this.enableNntp || this.enableNttps;
    }

    get enableNntp() {
        return _.get(Config(), 'contentServers.nntp.nntp.enabled', false);
    }

    get enableNttps() {
        return _.get(Config(), 'contentServers.nntp.nntps.enabled', false);
    }

    isConfigured() {
        const config = Config();

        //
        //  Any conf/areas exposed?
        //
        const publicConfs = _.get(
            config,
            'contentServers.nntp.publicMessageConferences',
            {}
        );
        const areasExposed = _.some(publicConfs, areas => {
            return Array.isArray(areas) && areas.length > 0;
        });

        if (!areasExposed) {
            return false;
        }

        const nntp = _.get(config, 'contentServers.nntp.nntp');
        if (nntp && this.enableNntp) {
            if (isNaN(nntp.port)) {
                return false;
            }
        }

        const nntps = _.get(config, 'contentServers.nntp.nntps');
        if (nntps && this.enableNttps) {
            if (isNaN(nntps.port)) {
                return false;
            }

            if (!_.isString(nntps.certPem) || !_.isString(nntps.keyPem)) {
                return false;
            }
        }

        return true;
    }

    createServer(cb) {
        if (!this.isEnabled() || !this.isConfigured()) {
            return cb(null);
        }

        const config = Config();

        const commonOptions = {
            //requireAuth : true,   //  :TODO: re-enable!
            //  :TODO: override |session| - use our own debug to Bunyan, etc.
        };

        if (this.enableNntp) {
            this.nntpServer = new NNTPServer(
                //  :TODO: according to docs: if connection is non-tls, but behind proxy (assuming TLS termination?!!) then set this to true
                Object.assign({ secure: false }, commonOptions),
                'NNTP'
            );
        }

        if (this.enableNttps) {
            this.nntpsServer = new NNTPServer(
                Object.assign(
                    {
                        secure: true,
                        tls: {
                            cert: fs.readFileSync(
                                config.contentServers.nntp.nntps.certPem
                            ),
                            key: fs.readFileSync(config.contentServers.nntp.nntps.keyPem),
                        },
                    },
                    commonOptions
                ),
                'NTTPS'
            );
        }

        nntpDatabase = new NNTPDatabase();
        nntpDatabase.init(err => {
            return cb(err);
        });
    }

    listen(cb) {
        const config = Config();
        forEachSeries(
            ['nntp', 'nntps'],
            (service, nextService) => {
                const server = this[`${service}Server`];
                if (server) {
                    const port = config.contentServers.nntp[service].port;
                    server
                        .listen(this.listenURI(port, service))
                        .catch(e => {
                            Log.warn(
                                { error: e.message, port },
                                `${service.toUpperCase()} failed to listen`
                            );
                            return nextService(null); //  try next anyway
                        })
                        .then(() => {
                            return nextService(null);
                        });
                } else {
                    return nextService(null);
                }
            },
            err => {
                return cb(err);
            }
        );
    }

    listenURI(port, service = 'nntp') {
        return `${service}://0.0.0.0:${port}`;
    }
};

function performMaintenanceTask(args, cb) {
    //
    //  Delete any message mapping that no longer have
    //  an actual message associated with them.
    //
    if (!nntpDatabase) {
        Log.trace('Cannot perform NNTP maintenance without NNTP database initialized');
        return cb(null);
    }

    let attached = false;
    asyncSeries(
        [
            callback => {
                const messageDbPath = paths.join(Config().paths.db, 'message.sqlite3');
                nntpDatabase.db.run(
                    `ATTACH DATABASE "${messageDbPath}" AS msgdb;`,
                    err => {
                        attached = !err;
                        return callback(err);
                    }
                );
            },
            callback => {
                nntpDatabase.db.run(
                    `DELETE FROM nntp_area_message
                    WHERE message_uuid NOT IN (
                        SELECT message_uuid
                        FROM msgdb.message
                    );`,
                    function result(err) {
                        //  no arrow func; need |this.changes|
                        if (err) {
                            Log.warn(
                                { error: err.message },
                                'Failed to delete from NNTP database'
                            );
                        } else {
                            Log.debug(
                                { count: this.changes },
                                'Deleted mapped message IDs from NNTP database'
                            );
                        }
                        return callback(err);
                    }
                );
            },
        ],
        err => {
            if (attached) {
                nntpDatabase.db.run('DETACH DATABASE msgdb;');
            }
            return cb(err);
        }
    );
}
