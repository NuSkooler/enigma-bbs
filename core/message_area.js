/* jslint node: true */
'use strict';

//  ENiGMA½
const msgDb = require('./database.js').dbs.message;
const Config = require('./config.js').get;
const Message = require('./message.js');
const Log = require('./logger.js').log;
const msgNetRecord = require('./msg_network.js').recordMessage;
const sortAreasOrConfs = require('./conf_area_util.js').sortAreasOrConfs;
const UserProps = require('./user_property.js');
const StatLog = require('./stat_log.js');
const SysProps = require('./system_property.js');

//  deps
const async = require('async');
const _ = require('lodash');
const assert = require('assert');
const moment = require('moment');

exports.startup = startup;
exports.shutdown = shutdown;
exports.getAvailableMessageConferences = getAvailableMessageConferences;
exports.getSortedAvailMessageConferences = getSortedAvailMessageConferences;
exports.getAvailableMessageAreasByConfTag = getAvailableMessageAreasByConfTag;
exports.getSortedAvailMessageAreasByConfTag = getSortedAvailMessageAreasByConfTag;
exports.getAllAvailableMessageAreaTags = getAllAvailableMessageAreaTags;
exports.getDefaultMessageConferenceTag = getDefaultMessageConferenceTag;
exports.getDefaultMessageAreaTagByConfTag = getDefaultMessageAreaTagByConfTag;
exports.getSuitableMessageConfAndAreaTags = getSuitableMessageConfAndAreaTags;
exports.getMessageConferenceByTag = getMessageConferenceByTag;
exports.getMessageAreaByTag = getMessageAreaByTag;
exports.getMessageConfTagByAreaTag = getMessageConfTagByAreaTag;
exports.changeMessageConference = changeMessageConference;
exports.changeMessageArea = changeMessageArea;
exports.hasMessageConfAndAreaRead = hasMessageConfAndAreaRead;
exports.hasMessageConfAndAreaWrite = hasMessageConfAndAreaWrite;
exports.filterMessageAreaTagsByReadACS = filterMessageAreaTagsByReadACS;
exports.filterMessageListByReadACS = filterMessageListByReadACS;
exports.tempChangeMessageConfAndArea = tempChangeMessageConfAndArea;
exports.getMessageListForArea = getMessageListForArea;
exports.getNewMessageCountInAreaForUser = getNewMessageCountInAreaForUser;
exports.getNewMessageCountAddressedToUser = getNewMessageCountAddressedToUser;
exports.getNewMessagesInAreaForUser = getNewMessagesInAreaForUser;
exports.getMessageIdNewerThanTimestampByArea = getMessageIdNewerThanTimestampByArea;
exports.getMessageAreaLastReadId = getMessageAreaLastReadId;
exports.updateMessageAreaLastReadId = updateMessageAreaLastReadId;
exports.persistMessage = persistMessage;
exports.trimMessageAreasScheduledEvent = trimMessageAreasScheduledEvent;

function startup(cb) {
    //  by default, private messages are NOT included
    async.series(
        [
            callback => {
                Message.findMessages({ resultType: 'count' }, (err, count) => {
                    if (count) {
                        StatLog.setNonPersistentSystemStat(
                            SysProps.MessageTotalCount,
                            count
                        );
                    }
                    return callback(err);
                });
            },
            callback => {
                Message.findMessages(
                    { resultType: 'count', date: moment() },
                    (err, count) => {
                        if (count) {
                            StatLog.setNonPersistentSystemStat(
                                SysProps.MessagesToday,
                                count
                            );
                        }
                        return callback(err);
                    }
                );
            },
        ],
        err => {
            return cb(err);
        }
    );
}

function shutdown(cb) {
    return cb(null);
}

function getAvailableMessageConferences(client, options) {
    options = options || { includeSystemInternal: false };

    assert(client || true === options.noClient);

    //  perform ACS check per conf & omit system_internal if desired
    return _.omitBy(Config().messageConferences, (conf, confTag) => {
        if (!options.includeSystemInternal && 'system_internal' === confTag) {
            return true;
        }

        return client && !client.acs.hasMessageConfRead(conf);
    });
}

function getSortedAvailMessageConferences(client, options) {
    const confs = _.map(getAvailableMessageConferences(client, options), (v, k) => {
        return {
            confTag: k,
            conf: v,
        };
    });

    sortAreasOrConfs(confs, 'conf');

    return confs;
}

//  Return an *object* of available areas within |confTag|
function getAvailableMessageAreasByConfTag(confTag, options) {
    options = options || {};

    //  :TODO: confTag === "" then find default

    const config = Config();
    if (_.has(config.messageConferences, [confTag, 'areas'])) {
        const areas = config.messageConferences[confTag].areas;

        if (!options.client || true === options.noAcsCheck) {
            //  everything - no ACS checks
            return areas;
        } else {
            //  perform ACS check per area
            return _.omitBy(areas, area => {
                return !options.client.acs.hasMessageAreaRead(area);
            });
        }
    }
}

function getSortedAvailMessageAreasByConfTag(confTag, options) {
    const areas = _.map(getAvailableMessageAreasByConfTag(confTag, options), (v, k) => {
        return {
            areaTag: k,
            area: v,
        };
    });

    sortAreasOrConfs(areas, 'area');

    return areas;
}

function getAllAvailableMessageAreaTags(client, options) {
    const areaTags = [];

    //  mask over older messy APIs for now
    const confOpts = Object.assign({}, options, { noClient: client ? false : true });
    const areaOpts = Object.assign({}, options, { client });

    Object.keys(getAvailableMessageConferences(client, confOpts)).forEach(confTag => {
        areaTags.push(
            ...Object.keys(getAvailableMessageAreasByConfTag(confTag, areaOpts))
        );
    });

    return areaTags;
}

function getDefaultMessageConferenceTag(client, disableAcsCheck) {
    //
    //  Find the first conference marked 'default'. If found,
    //  inspect |client| against *read* ACS using defaults if not
    //  specified.
    //
    //  If the above fails, just go down the list until we get one
    //  that passes.
    //
    //  It's possible that we end up with nothing here!
    //
    //  Note that built in 'system_internal' is always ommited here
    //
    const config = Config();
    let defaultConf = _.findKey(config.messageConferences, o => o.default);
    if (defaultConf) {
        const conf = config.messageConferences[defaultConf];
        if (true === disableAcsCheck || client.acs.hasMessageConfRead(conf)) {
            return defaultConf;
        }
    }

    //  just use anything we can
    defaultConf = _.findKey(config.messageConferences, (conf, confTag) => {
        return (
            'system_internal' !== confTag &&
            (true === disableAcsCheck || client.acs.hasMessageConfRead(conf))
        );
    });

    return defaultConf;
}

function getDefaultMessageAreaTagByConfTag(client, confTag, disableAcsCheck) {
    //
    //  Similar to finding the default conference:
    //  Find the first entry marked 'default', if any. If found, check | client| against
    //  *read* ACS. If this fails, just find the first one we can that passes checks.
    //
    //  It's possible that we end up with nothing!
    //
    confTag = confTag || getDefaultMessageConferenceTag(client);

    const config = Config();
    if (confTag && _.has(config.messageConferences, [confTag, 'areas'])) {
        const areaPool = config.messageConferences[confTag].areas;
        let defaultArea = _.findKey(areaPool, o => o.default);
        if (defaultArea) {
            const area = areaPool[defaultArea];
            if (true === disableAcsCheck || client.acs.hasMessageAreaRead(area)) {
                return defaultArea;
            }
        }

        defaultArea = _.findKey(areaPool, (area, areaTag) => {
            if (Message.isPrivateAreaTag(areaTag)) {
                return false;
            }
            return true === disableAcsCheck || client.acs.hasMessageAreaRead(area);
        });

        return defaultArea;
    }
}

function getSuitableMessageConfAndAreaTags(client) {
    //
    //  Attempts to get a pair of suitable conf/area tags:
    //  * Where the client/user has proper ACS to both
    //  * Try to use defaults where possible
    //  * If default conf/area is not an option, use any
    //    that pass ACS.
    //  * Returns a tuple [confTag, areaTag]; areaTag
    //    and possibly confTag may both be set to '' if
    //    if we fail to find something.
    //
    let confTag = getDefaultMessageConferenceTag(client);
    if (!confTag) {
        return ['', '']; //  can't have an area without a conf
    }

    let areaTag = getDefaultMessageAreaTagByConfTag(client, confTag);
    if (!areaTag) {
        //  OK, perhaps *any* area in *any* conf?
        _.forEach(Config().messageConferences, (conf, ct) => {
            if (!client.acs.hasMessageConfRead(conf)) {
                return;
            }
            _.forEach(conf.areas, (area, at) => {
                if (
                    !_.includes(Message.WellKnownAreaTags, at) &&
                    client.acs.hasMessageAreaRead(area)
                ) {
                    confTag = ct;
                    areaTag = at;
                    return false; //  stop inner iteration
                }
            });
            if (areaTag) {
                return false; //  stop iteration
            }
        });
    }

    return [confTag, areaTag || ''];
}

function getMessageConferenceByTag(confTag) {
    return Object.assign({ confTag }, Config().messageConferences[confTag]);
}

function getMessageConfTagByAreaTag(areaTag) {
    const confs = Config().messageConferences;
    return Object.keys(confs).find(confTag => {
        return _.has(confs, [confTag, 'areas', areaTag]);
    });
}

function getMessageAreaByTag(areaTag, optionalConfTag) {
    const confs = Config().messageConferences;

    //  :TODO: this could be cached
    if (_.isString(optionalConfTag)) {
        if (_.has(confs, [optionalConfTag, 'areas', areaTag])) {
            return Object.assign(
                {
                    areaTag,
                    confTag: optionalConfTag,
                },
                confs[optionalConfTag].areas[areaTag]
            );
        }
    } else {
        //
        //  No confTag to work with - we'll have to search through them all
        //
        let area;
        _.forEach(confs, (conf, confTag) => {
            if (_.has(conf, ['areas', areaTag])) {
                area = Object.assign({ areaTag, confTag }, conf.areas[areaTag]);
                return false; //  stop iteration
            }
        });

        return area;
    }
}

function changeMessageConference(client, confTag, cb) {
    async.waterfall(
        [
            function getConf(callback) {
                const conf = getMessageConferenceByTag(confTag);

                if (conf) {
                    callback(null, conf);
                } else {
                    callback(new Error('Invalid message conference tag'));
                }
            },
            function getDefaultAreaInConf(conf, callback) {
                const areaTag = getDefaultMessageAreaTagByConfTag(client, confTag);
                const area = getMessageAreaByTag(areaTag, confTag);

                if (area) {
                    callback(null, conf, { areaTag: areaTag, area: area });
                } else {
                    callback(new Error('No available areas for this user in conference'));
                }
            },
            function validateAccess(conf, areaInfo, callback) {
                if (
                    !client.acs.hasMessageConfRead(conf) ||
                    !client.acs.hasMessageAreaRead(areaInfo.area)
                ) {
                    return callback(
                        new Error('Access denied to message area and/or conference')
                    );
                } else {
                    return callback(null, conf, areaInfo);
                }
            },
            function changeConferenceAndArea(conf, areaInfo, callback) {
                const newProps = {
                    [UserProps.MessageConfTag]: confTag,
                    [UserProps.MessageAreaTag]: areaInfo.areaTag,
                };
                client.user.persistProperties(newProps, err => {
                    callback(err, conf, areaInfo);
                });
            },
        ],
        function complete(err, conf, areaInfo) {
            if (!err) {
                client.log.info(
                    { confTag: confTag, confName: conf.name, areaTag: areaInfo.areaTag },
                    'Current message conference changed'
                );
            } else {
                client.log.warn(
                    { confTag: confTag, error: err.message },
                    'Could not change message conference'
                );
            }
            cb(err);
        }
    );
}

function changeMessageAreaWithOptions(client, areaTag, options, cb) {
    options = options || {}; //  :TODO: this is currently pointless... cb is required...

    async.waterfall(
        [
            function getArea(callback) {
                const area = getMessageAreaByTag(areaTag);
                return callback(area ? null : new Error('Invalid message areaTag'), area);
            },
            function validateAccess(area, callback) {
                //
                //  Need at least *read* to access the area
                //
                if (!client.acs.hasMessageAreaRead(area)) {
                    return callback(new Error('Access denied to message area'));
                } else {
                    return callback(null, area);
                }
            },
            function changeArea(area, callback) {
                if (true === options.persist) {
                    client.user.persistProperty(
                        UserProps.MessageAreaTag,
                        areaTag,
                        function persisted(err) {
                            return callback(err, area);
                        }
                    );
                } else {
                    client.user.properties[UserProps.MessageAreaTag] = areaTag;
                    return callback(null, area);
                }
            },
        ],
        function complete(err, area) {
            if (!err) {
                client.log.info(
                    { areaTag: areaTag, area: area },
                    'Current message area changed'
                );
            } else {
                client.log.warn(
                    { areaTag: areaTag, area: area, error: err.message },
                    'Could not change message area'
                );
            }

            return cb(err);
        }
    );
}

//
//  Temporairly -- e.g. non-persisted -- change to an area and it's
//  associated underlying conference. ACS is checked for both.
//
//  This is useful for example when doing a new scan
//
function tempChangeMessageConfAndArea(client, areaTag) {
    const area = getMessageAreaByTag(areaTag);
    const confTag = getMessageConfTagByAreaTag(areaTag);

    if (!area || !confTag) {
        return false;
    }

    const conf = getMessageConferenceByTag(confTag);

    if (!client.acs.hasMessageConfRead(conf) || !client.acs.hasMessageAreaRead(area)) {
        return false;
    }

    client.user.properties[UserProps.MessageConfTag] = confTag;
    client.user.properties[UserProps.MessageAreaTag] = areaTag;

    return true;
}

function changeMessageArea(client, areaTag, cb) {
    changeMessageAreaWithOptions(client, areaTag, { persist: true }, cb);
}

function hasMessageConfAndAreaRead(client, areaOrTag) {
    if (_.isString(areaOrTag)) {
        areaOrTag = getMessageAreaByTag(areaOrTag) || {};
    }
    const conf = getMessageConferenceByTag(areaOrTag.confTag);
    return (
        client.acs.hasMessageConfRead(conf) && client.acs.hasMessageAreaRead(areaOrTag)
    );
}

function hasMessageConfAndAreaWrite(client, areaOrTag) {
    if (_.isString(areaOrTag)) {
        areaOrTag = getMessageAreaByTag(areaOrTag) || {};
    }
    const conf = getMessageConferenceByTag(areaOrTag.confTag);
    return (
        client.acs.hasMessageConfWrite(conf) && client.acs.hasMessageAreaWrite(areaOrTag)
    );
}

function filterMessageAreaTagsByReadACS(client, areaTags) {
    if (!Array.isArray(areaTags)) {
        areaTags = [areaTags];
    }

    return areaTags.filter(areaTag => {
        const area = getMessageAreaByTag(areaTag);
        return hasMessageConfAndAreaRead(client, area);
    });
}

function filterMessageListByReadACS(client, messageList) {
    //
    //  Filter out messages belonging to conf/areas the user
    //  doesn't have access to.
    //

    //  Keep a cache around for quick lookup.
    const acsCache = new Map(); //  areaTag:boolean

    return messageList.filter(msg => {
        let cached = acsCache.get(msg.areaTag);
        if (false === cached) {
            return false;
        }
        if (true === cached) {
            return true;
        }
        cached = hasMessageConfAndAreaRead(client, msg.areaTag);
        acsCache.set(msg.areaTag, cached);
        return cached;
    });
}

function getNewMessageCountInAreaForUser(userId, areaTag, cb) {
    getMessageAreaLastReadId(userId, areaTag, (err, lastMessageId) => {
        lastMessageId = lastMessageId || 0;

        const filter = {
            areaTag,
            newerThanMessageId: lastMessageId,
            resultType: 'count',
        };

        if (Message.isPrivateAreaTag(areaTag)) {
            filter.privateTagUserId = userId;
        }

        Message.findMessages(filter, (err, count) => {
            return cb(err, count);
        });
    });
}

// New message count -- for all areas available to the user
// that are addressed to that user (ie: matching username)
// Does NOT Include private messages.
function getNewMessageCountAddressedToUser(client, cb) {
    const areaTags = getAllAvailableMessageAreaTags(client).filter(
        areaTag => areaTag !== Message.WellKnownAreaTags.Private
    );

    let newMessageCount = 0;
    async.forEach(
        areaTags,
        (areaTag, nextAreaTag) => {
            getMessageAreaLastReadId(client.user.userId, areaTag, (_, lastMessageId) => {
                lastMessageId = lastMessageId || 0;
                getNewMessageCountInAreaForUser(
                    client.user.userId,
                    areaTag,
                    (err, count) => {
                        newMessageCount += count;
                        return nextAreaTag(err);
                    }
                );
            });
        },
        () => {
            return cb(null, newMessageCount);
        }
    );
}

function getNewMessagesInAreaForUser(userId, areaTag, cb) {
    getMessageAreaLastReadId(userId, areaTag, (err, lastMessageId) => {
        lastMessageId = lastMessageId || 0;

        const filter = {
            areaTag,
            resultType: 'messageList',
            newerThanMessageId: lastMessageId,
            sort: 'messageId',
            order: 'ascending',
        };

        if (Message.isPrivateAreaTag(areaTag)) {
            filter.privateTagUserId = userId;
        }

        return Message.findMessages(filter, cb);
    });
}

function getMessageListForArea(client, areaTag, filter, cb) {
    if (!cb && _.isFunction(filter)) {
        cb = filter;
        filter = {
            areaTag,
            resultType: 'messageList',
            sort: 'messageId',
            order: 'ascending',
        };
    } else {
        Object.assign(filter, { areaTag });
    }

    if (client) {
        if (!hasMessageConfAndAreaRead(client, areaTag)) {
            return cb(null, []);
        }
    }

    if (Message.isPrivateAreaTag(areaTag)) {
        filter.privateTagUserId = client ? client.user.userId : 'INVALID_USER_ID';
    }

    return Message.findMessages(filter, cb);
}

function getMessageIdNewerThanTimestampByArea(areaTag, newerThanTimestamp, cb) {
    Message.findMessages(
        {
            areaTag,
            newerThanTimestamp,
            sort: 'modTimestamp',
            order: 'ascending',
            limit: 1,
        },
        (err, id) => {
            if (err) {
                return cb(err);
            }
            return cb(null, id ? id[0] : null);
        }
    );
}

function getMessageAreaLastReadId(userId, areaTag, cb) {
    msgDb.get(
        'SELECT message_id ' +
            'FROM user_message_area_last_read ' +
            'WHERE user_id = ? AND area_tag = ?;',
        [userId, areaTag.toLowerCase()],
        function complete(err, row) {
            cb(err, row ? row.message_id : 0);
        }
    );
}

function updateMessageAreaLastReadId(userId, areaTag, messageId, allowOlder, cb) {
    if (!cb && _.isFunction(allowOlder)) {
        cb = allowOlder;
        allowOlder = false;
    }

    //  :TODO: likely a better way to do this...
    async.waterfall(
        [
            function getCurrent(callback) {
                getMessageAreaLastReadId(userId, areaTag, function result(err, lastId) {
                    lastId = lastId || 0;
                    callback(null, lastId); //  ignore errors as we default to 0
                });
            },
            function update(lastId, callback) {
                if (allowOlder || messageId > lastId) {
                    msgDb.run(
                        'REPLACE INTO user_message_area_last_read (user_id, area_tag, message_id) ' +
                            'VALUES (?, ?, ?);',
                        [userId, areaTag, messageId],
                        function written(err) {
                            callback(err, true); //  true=didUpdate
                        }
                    );
                } else {
                    callback(null);
                }
            },
        ],
        function complete(err, didUpdate) {
            if (err) {
                Log.debug(
                    {
                        error: err.toString(),
                        userId: userId,
                        areaTag: areaTag,
                        messageId: messageId,
                    },
                    'Failed updating area last read ID'
                );
            } else {
                if (true === didUpdate) {
                    Log.trace(
                        { userId: userId, areaTag: areaTag, messageId: messageId },
                        'Area last read ID updated'
                    );
                }
            }
            cb(err);
        }
    );
}

function persistMessage(message, cb) {
    async.series(
        [
            function persistMessageToDisc(callback) {
                return message.persist(callback);
            },
            function recordToMessageNetworks(callback) {
                return msgNetRecord(message, callback);
            },
        ],
        cb
    );
}

//  method exposed for event scheduler
function trimMessageAreasScheduledEvent(args, cb) {
    function trimMessageAreaByMaxMessages(areaInfo, cb) {
        if (0 === areaInfo.maxMessages) {
            return cb(null);
        }

        msgDb.run(
            `DELETE FROM message
            WHERE message_id IN(
                SELECT message_id
                FROM message
                WHERE area_tag = ?
                ORDER BY message_id DESC
                LIMIT -1 OFFSET ${areaInfo.maxMessages}
            );`,
            [areaInfo.areaTag.toLowerCase()],
            function result(err) {
                //  no arrow func; need this
                if (err) {
                    Log.error(
                        { areaInfo: areaInfo, error: err.message, type: 'maxMessages' },
                        'Error trimming message area'
                    );
                } else {
                    Log.debug(
                        { areaInfo: areaInfo, type: 'maxMessages', count: this.changes },
                        'Area trimmed successfully'
                    );
                }
                return cb(err);
            }
        );
    }

    function trimMessageAreaByMaxAgeDays(areaInfo, cb) {
        if (0 === areaInfo.maxAgeDays) {
            return cb(null);
        }

        msgDb.run(
            `DELETE FROM message
            WHERE area_tag = ? AND modified_timestamp < date('now', '-${areaInfo.maxAgeDays} days');`,
            [areaInfo.areaTag],
            function result(err) {
                //  no arrow func; need this
                if (err) {
                    Log.warn(
                        { areaInfo: areaInfo, error: err.message, type: 'maxAgeDays' },
                        'Error trimming message area'
                    );
                } else {
                    Log.debug(
                        { areaInfo: areaInfo, type: 'maxAgeDays', count: this.changes },
                        'Area trimmed successfully'
                    );
                }
                return cb(err);
            }
        );
    }

    async.waterfall(
        [
            function getAreaTags(callback) {
                const areaTags = [];

                //
                //  We use SQL here vs API such that no-longer-used tags are picked up
                //
                msgDb.each(
                    `SELECT DISTINCT area_tag
                    FROM message;`,
                    (err, row) => {
                        if (err) {
                            return callback(err);
                        }

                        //  We treat private mail special
                        if (!Message.isPrivateAreaTag(row.area_tag)) {
                            areaTags.push(row.area_tag);
                        }
                    },
                    err => {
                        return callback(err, areaTags);
                    }
                );
            },
            function prepareAreaInfo(areaTags, callback) {
                let areaInfos = [];

                //  determine maxMessages & maxAgeDays per area
                const config = Config();
                areaTags.forEach(areaTag => {
                    let maxMessages = config.messageAreaDefaults.maxMessages;
                    let maxAgeDays = config.messageAreaDefaults.maxAgeDays;

                    const area = getMessageAreaByTag(areaTag); //  note: we don't know the conf here
                    if (area) {
                        maxMessages = area.maxMessages || maxMessages;
                        maxAgeDays = area.maxAgeDays || maxAgeDays;
                    }

                    areaInfos.push({
                        areaTag: areaTag,
                        maxMessages: maxMessages,
                        maxAgeDays: maxAgeDays,
                    });
                });

                return callback(null, areaInfos);
            },
            function trimGeneralAreas(areaInfos, callback) {
                async.each(
                    areaInfos,
                    (areaInfo, next) => {
                        trimMessageAreaByMaxMessages(areaInfo, err => {
                            if (err) {
                                return next(err);
                            }

                            trimMessageAreaByMaxAgeDays(areaInfo, err => {
                                return next(err);
                            });
                        });
                    },
                    callback
                );
            },
            function trimExternalPrivateSentMail(callback) {
                //
                //  *External* (FTN, email, ...) outgoing is cleaned up *after export*
                //  if it is older than the configured |maxExternalSentAgeDays| days
                //
                //  Outgoing externally exported private mail is:
                //  - In the 'private_mail' area
                //  - Marked exported (state_flags0 exported bit set)
                //  - Marked with any external flavor (we don't mark local)
                //
                const maxExternalSentAgeDays = _.get(
                    Config,
                    'messageConferences.system_internal.areas.private_mail.maxExternalSentAgeDays',
                    30
                );

                msgDb.run(
                    `DELETE FROM message
                    WHERE message_id IN (
                        SELECT m.message_id
                        FROM message m
                        JOIN message_meta mms
                            ON m.message_id = mms.message_id AND
                            (mms.meta_category='System' AND mms.meta_name='${Message.SystemMetaNames.StateFlags0}' AND (mms.meta_value & ${Message.StateFlags0.Exported} = ${Message.StateFlags0.Exported}))
                        JOIN message_meta mmf
                            ON m.message_id = mmf.message_id AND
                            (mmf.meta_category='System' AND mmf.meta_name='${Message.SystemMetaNames.ExternalFlavor}')
                        WHERE m.area_tag='${Message.WellKnownAreaTags.Private}' AND DATETIME('now') > DATETIME(m.modified_timestamp, '+${maxExternalSentAgeDays} days')
                    );`,
                    function results(err) {
                        //  no arrow func; need this
                        if (err) {
                            Log.warn(
                                { error: err.message },
                                'Error trimming private externally sent messages'
                            );
                        } else {
                            Log.debug(
                                { count: this.changes },
                                'Private externally sent messages trimmed successfully'
                            );
                        }
                    }
                );

                return callback(null);
            },
        ],
        err => {
            return cb(err);
        }
    );
}
