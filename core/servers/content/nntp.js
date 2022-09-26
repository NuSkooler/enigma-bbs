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
    persistMessage,
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
const ACS = require('../../acs');

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

const AuthCommands = 'POST';

// these aren't exported by the NNTP module, unfortunantely
const Responses = {
    ArticlePostedOk: '240 article posted ok',

    SendArticle: '340 send article to be posted',

    PostingNotAllowed: '440 posting not allowed',
    ArticlePostFailed: '441 posting failed',
    AuthRequired: '480 authentication required',
};

const PostCommand = {
    head: 'POST',
    validate: /^POST$/i,

    run(session, cmd) {
        if (!session.authenticated) {
            session.receivingPostArticle = false; // ensure reset
            return Responses.AuthRequired;
        }

        session.receivingPostArticle = true;
        return Responses.SendArticle;
    },

    capability(session, report) {
        report.push('POST');
    },
};

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
        if (AuthCommands.includes(command)) {
            return !session.authenticated && !session.authUser;
        }

        return super._needAuth(session, command);
    }

    _address(session) {
        const addr = session.in_stream.remoteAddress;
        return addr ? addr.replace(/^::ffff:/, '').replace(/^::1$/, 'localhost') : 'N/A';
    }

    _authenticate(session) {
        const username = session.authinfo_user;
        const password = session.authinfo_pass;

        this.log.debug(
            { username, ip: this._address(session) },
            `NNTP authentication request for "${username}"`
        );

        return new Promise(resolve => {
            const user = new User();
            user.authenticateFactor1(
                { type: User.AuthFactor1Types.Password, username, password },
                err => {
                    if (err) {
                        this.log.warn(
                            { username, reason: err.message, ip: this._address(session) },
                            `NNTP authentication failure for "${username}"`
                        );
                        return resolve(false);
                    }

                    session.authUser = user;

                    this.log.info(
                        { username, ip: this._address(session) },
                        `NTTP authentication success for "${username}"`
                    );
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
            To: toName, // JAM-ish
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
            [, messageUuid] = NNTPServer.getMessageIdentifierParts(messageId);
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
                                { messageUuid, messageId, ip: this._address(session) },
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

        const area = getMessageAreaByTag(areaTag, confTag);
        if (!area) {
            return false;
        }

        const acs = new ACS({ client: null, user: session.authUser });
        return acs.hasMessageConfRead(conf) && acs.hasMessageAreaRead(area);
    }

    static hasConfAndAreaWriteAccess(session, confTag, areaTag) {
        if (Message.isPrivateAreaTag(areaTag)) {
            return false;
        }

        const conf = getMessageConferenceByTag(confTag);
        if (!conf) {
            return false;
        }

        const area = getMessageAreaByTag(areaTag, confTag);
        if (!area) {
            return false;
        }

        const acs = new ACS({ client: null, user: session.authUser });
        return acs.hasMessageConfWrite(conf) && acs.hasMessageAreaWrite(area);
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

    static getMessageIdentifierParts(messageId) {
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

    static _importMessage(session, articleLines, cb) {
        const tidyFrom = f => {
            if (f) {
                // remove quotes around name, if present
                let m = /^"([^"]+)" <([^>]+)>$/.exec(f);
                if (m && m[1] && m[2]) {
                    f = `${m[1]} <${m[2]}>`;
                }
            }
            return f;
        };

        asyncWaterfall(
            [
                callback => {
                    return NNTPServer._parseArticleLines(articleLines, callback);
                },
                (parsed, callback) => {
                    // gather some initially important bits
                    const subject = parsed.header.get('subject');
                    const to = parsed.header.get('to') || parsed.header.get('x-jam-to'); // non-standard, may be missing
                    const from = tidyFrom(
                        parsed.header.get('from') ||
                            parsed.header.get('sender') ||
                            parsed.header.get('x-jam-from')
                    );
                    const date = parsed.header.get('date'); // if not present we'll use 'now'
                    const newsgroups = parsed.header
                        .get('newsgroups')
                        .split(',')
                        .map(ng => {
                            const [confTag, areaTag] = ng.split('.');
                            return { confTag, areaTag };
                        });

                    // validate areaTag exists -- currently only a single area/post; no x-posts
                    //  :TODO: look into x-posting
                    const area = getMessageAreaByTag(newsgroups[0].areaTag);
                    if (!area) {
                        return callback(
                            Errors.DoesNotExist(
                                `No area by tag "${newsgroups[0].areaTag}" exists!`
                            )
                        );
                    }

                    //  NOTE: Not all ACS checks work with NNTP since we don't have a standard client;
                    //  If a particular ACS requires a |client|, it will return false!
                    if (
                        !NNTPServer.hasConfAndAreaWriteAccess(
                            session,
                            area.confTag,
                            area.areaTag
                        )
                    ) {
                        return callback(
                            Errors.AccessDenied(
                                `No ACS to ${area.confTag}/${area.areaTag}`
                            )
                        );
                    }

                    if (
                        !_.isString(subject) ||
                        !_.isString(from) ||
                        !Array.isArray(newsgroups)
                    ) {
                        return callback(
                            Errors.Invalid('Missing one or more required article fields')
                        );
                    }

                    return callback(null, {
                        subject,
                        from,
                        date,
                        newsgroups,
                        to,
                        parsed,
                    });
                },
                (msgData, callback) => {
                    if (msgData.to) {
                        return callback(null, msgData);
                    }

                    //
                    // We don't have a 'to' field, try to derive if this is a
                    // response to a message. If not, just fall back 'All'
                    //
                    //  'References'
                    //  - https://www.rfc-editor.org/rfc/rfc5536#section-3.2.10
                    //  - https://www.rfc-editor.org/rfc/rfc5322.html
                    //
                    //  'In-Reply-To'
                    //  - https://www.rfc-editor.org/rfc/rfc5322.html
                    //
                    //  Both may contain 1:N, "optionally" separated by CFWS; by this
                    //  point in the code, they should be space separated at most.
                    //
                    //  Each entry is in msg-id format. That is:
                    //  "<" id-left "@" id-right ">"
                    //
                    msgData.to = 'All'; // fallback
                    let parentMessageId = (
                        msgData.parsed.header.get('in-reply-to') ||
                        msgData.parsed.header.get('references') ||
                        ''
                    ).split(' ')[0];

                    if (parentMessageId) {
                        let [_, messageUuid] =
                            NNTPServer.getMessageIdentifierParts(parentMessageId);
                        if (messageUuid) {
                            const filter = {
                                resultType: 'messageList',
                                uuids: messageUuid,
                                limit: 1,
                            };

                            return Message.findMessages(filter, (err, messageList) => {
                                if (err) {
                                    return callback(err);
                                }

                                // current message/article is a reply to this message:
                                msgData.to = messageList[0].fromUserName;
                                msgData.replyToMsgId = messageList[0].replyToMsgId; // may not be present
                                return callback(null, msgData);
                            });
                        }
                    }

                    return callback(null, msgData);
                },
                (msgData, callback) => {
                    const message = new Message({
                        toUserName: msgData.to,
                        fromUserName: msgData.from,
                        subject: msgData.subject,
                        replyToMsgId: msgData.replyToMsgId || 0,
                        modTimestamp: msgData.date, // moment can generally parse these
                        // :TODO: inspect Content-Type 'charset' if present & attempt to properly decode if not UTF-8
                        message: msgData.parsed.body.join('\n'),
                        areaTag: msgData.newsgroups[0].areaTag,
                    });

                    message.meta.System[Message.SystemMetaNames.ExternalFlavor] =
                        Message.AddressFlavor.NNTP;

                    //  :TODO: investigate JAMNTTP clients/etc.
                    //  :TODO: slurp in various X-XXXX kludges/etc. and bring them in

                    persistMessage(message, err => {
                        if (!err) {
                            Log.info(
                                `NNTP post to "${message.areaTag}" by "${session.authUser.username}": "${message.subject}"`
                            );
                        }
                        return callback(err);
                    });
                },
            ],
            err => {
                return cb(err);
            }
        );
    }

    static _parseArticleLines(articleLines, cb) {
        //
        //  Split articleLines into:
        //  - Header split into N:V pairs
        //  - Message Body lines
        //  -
        const header = new Map();
        const body = [];
        let inHeader = true;
        let currentHeaderName;
        forEachSeries(
            articleLines,
            (line, nextLine) => {
                if (inHeader) {
                    if (line === '.' || line === '') {
                        inHeader = false;
                        return nextLine(null);
                    }

                    const sep = line.indexOf(':');
                    if (sep < 1) {
                        // at least a single char name
                        // entries can split across lines -- they will be prefixed with a single space.
                        if (
                            currentHeaderName &&
                            (line.startsWith(' ') || line.startsWith('\t'))
                        ) {
                            let v = header.get(currentHeaderName);
                            v += line
                                .replace(/^\t/, ' ') // if we're dealign with a legacy tab
                                .trimRight();
                            header.set(currentHeaderName, v);
                            return nextLine(null);
                        }

                        return nextLine(
                            Errors.Invalid(
                                `"${line}" is not a valid NNTP message header!`
                            )
                        );
                    }

                    currentHeaderName = line.slice(0, sep).trim().toLowerCase();
                    const value = line.slice(sep + 1).trim();
                    header.set(currentHeaderName, value);
                    return nextLine(null);
                }

                // body
                if (line !== '.') {
                    // lines consisting of a single '.' are escaped to '..'
                    if (line.startsWith('..')) {
                        body.push(line.slice(1));
                    } else {
                        body.push(line);
                    }
                }
                return nextLine(null);
            },
            err => {
                return cb(err, { header, body });
            }
        );
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

        // :TODO: nntp-server doesn't currently allow posting in a nice way, so this is kludged in. Fork+MR something cleaner at some point
        class ProxySession extends NNTPServerBase.Session {
            constructor(server, stream) {
                super(server, stream);
                this.articleLinesBuffer = [];
            }

            parse(data) {
                if (this.receivingPostArticle) {
                    return this.receivePostArticleData(data);
                }

                super.parse(data);
            }

            receivePostArticleData(data) {
                this.articleLinesBuffer.push(...data.split(/r?\n/));

                const endOfPost = data.length === 1 && data[0] === '.';
                if (endOfPost) {
                    this.receivingPostArticle = false;

                    // Command is not exported currently; maybe submit a MR to allow posting in a nicer way...
                    function Command(runner, articleLines, session) {
                        this.state = 0; // CMD_WAIT
                        this.cmd_line = 'POST';
                        this.resolved_value = null;
                        this.rejected_value = null;
                        this.run = runner;
                        this.articleLines = articleLines;
                        this.session = session;
                    }

                    this.pipeline.push(
                        new Command(
                            this._processarticleLinesBuffer,
                            this.articleLinesBuffer,
                            this
                        )
                    );
                    this.articleLinesBuffer = [];
                    this.tick();
                }
            }

            _processarticleLinesBuffer() {
                return new Promise(resolve => {
                    NNTPServer._importMessage(this.session, this.articleLines, err => {
                        if (err) {
                            this.rejected_value = err; // will be serialized and 403 sent back currently; not really ideal as we want ArticlePostFailed
                            //  :TODO: tick() needs updated in session.js such that we can write back a proper code
                            this.state = 3; // CMD_REJECTED

                            Log.error(
                                { error: err.message },
                                `NNTP post failed: ${err.message}`
                            );
                        } else {
                            this.resolved_value = Responses.ArticlePostedOk;
                            this.state = 2; // CMD_RESOLVED
                        }

                        return resolve();
                    });
                });
            }

            static create(server, stream) {
                return new ProxySession(server, stream);
            }
        }

        const commonOptions = {
            //  :TODO: How to hook into debugging?!
        };

        if (true === _.get(config, 'contentServers.nntp.allowPosts')) {
            // add in some additional supported commands
            const commands = Object.assign({}, NNTPServerBase.commands, {
                POST: PostCommand,
            });

            commonOptions.commands = commands;
            commonOptions.session = ProxySession;
        }

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
