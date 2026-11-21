/* jslint node: true */
'use strict';

//  ENiGMA½
const msgDb = require('./database.js').dbs.message;
const { getISOTimestampString } = require('./database.js');
const configModule = require('./config.js');
//  Look up the current Config.get function on each call rather than capturing
//  it at module-load time. configModule.get is replaced at runtime by the
//  Config bootstrapper (and by tests that swap in fixture configs). A
//  load-time capture freezes whichever getter happened to be installed when
//  message_area.js was first required, which leaks across mocha files when
//  the require cache holds the cached module.
const Config = (...args) => configModule.get(...args);
const Message = require('./message.js');
const Log = require('./logger.js').log;
const msgNetRecord = require('./msg_network.js').recordMessage;
const sortAreasOrConfs = require('./conf_area_util.js').sortAreasOrConfs;
const UserProps = require('./user_property.js');
const StatLog = require('./stat_log.js');
const SysProps = require('./system_property.js');
const {
    SystemInternalConfTags,
    WellKnownConfTags,
    WellKnownAreaTags,
} = require('./message_const');
const Collection = require('./activitypub/collection');
const { Collections } = require('./activitypub/const');

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
exports.getHighestMessageIdByArea = getHighestMessageIdByArea;
exports.getLastReadIdForTimestampByArea = getLastReadIdForTimestampByArea;
exports.getMessageAreaLastReadId = getMessageAreaLastReadId;
exports.getEffectiveNewScanLastReadId = getEffectiveNewScanLastReadId;
exports.updateMessageAreaLastReadId = updateMessageAreaLastReadId;
exports.getMessageAreaStats = getMessageAreaStats;
exports.markMessageAreaRead = markMessageAreaRead;
exports.getMessageAreaLastReadGeneration = getMessageAreaLastReadGeneration;
exports.getReadableMessageAreaTagsInConf = getReadableMessageAreaTagsInConf;
exports.getNewScanMessageAreaTags = getNewScanMessageAreaTags;
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
    options = options || {};

    assert(client || true === options.noClient);

    //  perform ACS check per conf & omit "System Internal" if desired
    return _.omitBy(Config().messageConferences, (conf, confTag) => {
        if (!options.includeSystemInternal && SystemInternalConfTags.includes(confTag)) {
            return true;
        }

        //  Conferences flagged hideFromBrowse are kept out of the regular
        //  conference/area UIs but remain available to newscan, search, etc.
        //  Callers that should still see them (newscan, configure-newscan,
        //  set-newscan-date) opt in with { includeHidden: true }.
        if (!options.includeHidden && conf.hideFromBrowse === true) {
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
        const hideFiltered = !options.includeHidden;

        if (!options.client || true === options.noAcsCheck) {
            //  No ACS checks. Still respect area-level hideFromBrowse unless
            //  the caller opts in to seeing hidden entries.
            if (!hideFiltered) {
                return areas;
            }
            return _.omitBy(areas, area => area.hideFromBrowse === true);
        } else {
            //  perform ACS check per area
            return _.omitBy(areas, area => {
                if (hideFiltered && area.hideFromBrowse === true) {
                    return true;
                }
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
    //  Note that built in "System Internal" are always omitted here
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
            !SystemInternalConfTags.includes(confTag) &&
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
                    !Message.WellKnownAreaTags.includes(at) &&
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
                    `${client.node} changed message conference to ${areaInfo.areaTag}`
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
                client.log.debug(
                    { areaTag: areaTag, area: area },
                    `Node ${client.node} changed message area to ${areaTag}`
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

//
//  |areaOrTag| is an area object or an area tag. No area at all (undefined
//  or null: a user with no current message area, or a lookup that found
//  nothing) is no access (#1139). A tag that is no longer configured is
//  checked as an empty area, as it always has been.
//
function hasMessageConfAndAreaRead(client, areaOrTag) {
    if (_.isString(areaOrTag)) {
        areaOrTag = getMessageAreaByTag(areaOrTag) || {};
    }
    if (!_.isObject(areaOrTag)) {
        return false;
    }
    const conf = getMessageConferenceByTag(areaOrTag.confTag);
    return (
        client.acs.hasMessageConfRead(conf) && client.acs.hasMessageAreaRead(areaOrTag)
    );
}

//  see hasMessageConfAndAreaRead()
function hasMessageConfAndAreaWrite(client, areaOrTag) {
    if (_.isString(areaOrTag)) {
        areaOrTag = getMessageAreaByTag(areaOrTag) || {};
    }
    if (!_.isObject(areaOrTag)) {
        return false;
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

function getNewMessageCountInAreaForUser(
    user,
    areaTag,
    options = { addrToOnly: false },
    cb
) {
    getMessageAreaLastReadId(user.userId, areaTag, (err, lastMessageId) => {
        lastMessageId = lastMessageId || 0;

        const filter = {
            areaTag,
            newerThanMessageId: lastMessageId,
            resultType: 'count',
        };

        if (Message.isPrivateAreaTag(areaTag)) {
            filter.privateTagUserId = user.userId;
        } else if (options.addrToOnly) {
            filter.toUserName = user.username;
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
                lastMessageId = lastMessageId || 0; // eslint-disable-line no-unused-vars
                getNewMessageCountInAreaForUser(
                    client.user,
                    areaTag,
                    { addrToOnly: true },
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

//
//  The lowest message ID in |areaTag| newer than |newerThanTimestamp|, or null
//  if there is none. Not the earliest *dated* one, which is what this used to
//  answer: an import keeps its author's date, so the earliest-dated message
//  can have arrived last, and a scan pointer built from it skipped every
//  message that arrived before it. The comparison matches findMessages()'
//  newerThanTimestamp. It covers the whole area, so for private_mail it is
//  not limited to one user's mail -- conservative, as a pointer goes.
//
function getMessageIdNewerThanTimestampByArea(areaTag, newerThanTimestamp, cb) {
    if (moment.isMoment(newerThanTimestamp)) {
        newerThanTimestamp = getISOTimestampString(newerThanTimestamp);
    }

    //  answered outside the try, here and below: an exception thrown by the
    //  caller's callback would otherwise call it a second time, with an error
    let row;
    try {
        row = msgDb
            .prepare(
                'SELECT MIN(message_id) AS message_id ' +
                    'FROM message ' +
                    'WHERE area_tag = ? ' +
                    "AND DATETIME(modified_timestamp) > DATETIME(?, '+1 seconds');"
            )
            .get(areaTag, newerThanTimestamp);
    } catch (err) {
        return cb(err);
    }
    return cb(null, row && row.message_id ? row.message_id : null);
}

//  the highest message ID in |areaTag|, or 0 for an empty area
function getHighestMessageIdByArea(areaTag, cb) {
    let row;
    try {
        row = msgDb
            .prepare(
                'SELECT MAX(message_id) AS message_id FROM message WHERE area_tag = ?;'
            )
            .get(areaTag);
    } catch (err) {
        return cb(err);
    }
    return cb(null, (row && row.message_id) || 0);
}

//
//  A timestamp as a lastread ID for |areaTag|: everything dated after it is
//  new, so one short of the lowest ID newer than it. With nothing newer the
//  area is caught up, at its highest ID. null for an empty area, which has no
//  pointer to give.
//
function getLastReadIdForTimestampByArea(areaTag, timestamp, cb) {
    getMessageIdNewerThanTimestampByArea(areaTag, timestamp, (err, lowestId) => {
        if (err) {
            return cb(err);
        }
        if (lowestId) {
            return cb(null, lowestId - 1);
        }
        return getHighestMessageIdByArea(areaTag, (err, highestId) => {
            return cb(err, highestId || null);
        });
    });
}

function getMessageAreaLastReadId(userId, areaTag, cb) {
    let row;
    try {
        row = msgDb
            .prepare(
                'SELECT message_id ' +
                    'FROM user_message_area_last_read ' +
                    'WHERE user_id = ? AND area_tag = ?;'
            )
            .get(userId, areaTag.toLowerCase());
    } catch (err) {
        return cb(err);
    }
    return cb(null, row ? row.message_id : 0);
}

//
//  The caller's new scan floor (NewScanMinTimestamp) as a valid moment, or
//  null for none. Parsed here rather than by SQLite, which answers NULL for a
//  date it cannot read -- and an area with "nothing after" a NULL floor would
//  count as read.
//
function getNewScanFloor(user) {
    const floorValue = user.getProperty(UserProps.NewScanMinTimestamp);
    const floor = floorValue ? moment(floorValue, moment.ISO_8601) : null;
    return floor && floor.isValid() ? floor : null;
}

function getEffectiveNewScanLastReadId(user, areaTag, cb) {
    getMessageAreaLastReadId(user.userId, areaTag, (err, rawLastRead) => {
        if (err) {
            return cb(null, 0); //  don't let a read error break the scan
        }

        //  mail addressed to the caller is never backlog, and the %NP count
        //  reads the raw pointer too
        const floor = Message.isPrivateAreaTag(areaTag) ? null : getNewScanFloor(user);
        if (!floor) {
            return cb(null, rawLastRead || 0);
        }

        //  nothing dated before the floor is new; an area with nothing after
        //  it is caught up, not scanned from the pointer alone
        getLastReadIdForTimestampByArea(areaTag, floor, (err, floorLastReadId) => {
            if (err || !floorLastReadId) {
                return cb(null, rawLastRead || 0);
            }
            return cb(null, Math.max(rawLastRead || 0, floorLastReadId));
        });
    });
}

//
//  Per-area message stats for |user|, for every area in one statement rather
//  than two or three queries per area. Each figure is a correlated subquery
//  per area rather than one GROUP BY over a join: SQLite answers COUNT(*) and
//  MAX() over the (area_tag) index range without reading a row, and on a real
//  message base that was several times faster than the joined GROUP BY. Each area's start ID is
//  getEffectiveNewScanLastReadId()'s: the lastread pointer, raised to the new
//  scan floor exactly as getLastReadIdForTimestampByArea() turns a date into a
//  pointer (one short of the lowest ID dated after it, else the area's highest
//  ID). Private mail counts only the caller's own mail, as findMessages()'
//  privateTagUserId does, and has no floor.
//
//  Area tags are matched against messages as given and against the lastread
//  table in lower case, as the per-area functions do. A private mail tag in any
//  case means private_mail.
//
//  ACS-blind: callers pass tags they have already filtered.
//
const MESSAGE_AREA_STATS_SQL = `
    WITH req AS MATERIALIZED (
        SELECT
            json_extract(value, '$[0]') AS tag,
            json_extract(value, '$[1]') AS msg_tag,
            json_extract(value, '$[2]') AS lr_tag,
            json_extract(value, '$[3]') AS is_private
        FROM json_each(@areas)
    ),
    own_private AS MATERIALIZED (
        SELECT message_id
        FROM message_meta
        WHERE meta_category = 'System' AND meta_name = @toUserIdMeta AND meta_value = @userIdText
    ),
    area AS MATERIALIZED (
        SELECT
            r.*,
            COALESCE(lr.message_id, 0) AS raw_id,
            CASE WHEN r.is_private = 0
                THEN (SELECT MAX(m.message_id) FROM message m WHERE m.area_tag = r.msg_tag)
                ELSE (
                    SELECT MAX(m.message_id)
                    FROM own_private o JOIN message m ON m.message_id = o.message_id
                    WHERE m.area_tag = r.msg_tag
                )
            END AS last_id,
            --  getMessageIdNewerThanTimestampByArea()
            CASE WHEN r.is_private = 0 AND @floor IS NOT NULL
                THEN (
                    SELECT MIN(m.message_id)
                    FROM message m
                    WHERE m.area_tag = r.msg_tag
                    AND DATETIME(m.modified_timestamp) > DATETIME(@floor, '+1 seconds')
                )
            END AS floor_min_id
        FROM req r
        LEFT JOIN user_message_area_last_read lr
            ON lr.user_id = @userId AND lr.area_tag = r.lr_tag
    ),
    eff AS MATERIALIZED (
        SELECT
            a.*,
            --  getLastReadIdForTimestampByArea(), then the larger of the two
            MAX(
                a.raw_id,
                CASE WHEN a.is_private = 0 AND @floor IS NOT NULL
                    THEN COALESCE(a.floor_min_id - 1, a.last_id, 0)
                    ELSE 0
                END
            ) AS start_id
        FROM area a
    )
    SELECT
        e.tag, e.last_id,
        CASE WHEN e.is_private = 0
            THEN (SELECT COUNT(*) FROM message m WHERE m.area_tag = e.msg_tag)
            ELSE (
                SELECT COUNT(*)
                FROM own_private o JOIN message m ON m.message_id = o.message_id
                WHERE m.area_tag = e.msg_tag
            )
        END AS total,
        CASE WHEN e.is_private = 0
            THEN (
                SELECT COUNT(*)
                FROM message m
                WHERE m.area_tag = e.msg_tag AND m.message_id > e.start_id
            )
            ELSE (
                SELECT COUNT(*)
                FROM own_private o JOIN message m ON m.message_id = o.message_id
                WHERE m.area_tag = e.msg_tag AND m.message_id > e.start_id
            )
        END AS new_count,
        --  NULL where every new message counts: private mail, or no name to match
        CASE WHEN e.is_private = 0 AND @toUserName IS NOT NULL
            THEN (
                SELECT COUNT(*)
                FROM message m
                WHERE m.area_tag = e.msg_tag AND m.message_id > e.start_id
                AND m.to_user_name LIKE @toUserName
            )
        END AS yours,
        (SELECT modified_timestamp FROM message WHERE message_id = e.last_id) AS last_ts
    FROM eff e;`;

//
//  cb(err, { [areaTag]: { total, newCount, yours, lastPostId, lastPostTs } })
//
//  total       messages in the area (private mail: the caller's own)
//  newCount    messages after the effective new scan pointer
//  yours       new messages addressed to the caller by name, as
//              getNewMessageCountInAreaForUser()'s addrToOnly matches them
//              (LIKE, so ASCII case-insensitive); all new private mail
//  lastPostId  the highest message ID (0 for an empty area)
//  lastPostTs  its modified_timestamp as stored, or null
//
function getMessageAreaStats(user, areaTags, cb) {
    const tags = [...new Set(areaTags || [])].filter(t => _.isString(t) && t.length > 0);
    if (0 === tags.length) {
        return cb(null, {});
    }

    const floor = getNewScanFloor(user);
    const areas = tags.map(tag => {
        const isPrivate = Message.isPrivateAreaTag(tag);
        return [
            tag,
            isPrivate ? Message.WellKnownAreaTags.Private : tag,
            tag.toLowerCase(),
            isPrivate ? 1 : 0,
        ];
    });

    //  answered outside the try: an exception thrown by the caller's callback
    //  would otherwise call it a second time, with an error
    let rows;
    try {
        rows = msgDb.prepare(MESSAGE_AREA_STATS_SQL).all({
            areas: JSON.stringify(areas),
            toUserIdMeta: Message.SystemMetaNames.LocalToUserID,
            //  stored as text; a number would not compare equal
            userIdText: String(user.userId),
            userId: user.userId,
            floor: floor ? getISOTimestampString(floor) : null,
            //  findMessages() skips an empty toUserName rather than match it
            toUserName: user.username || null,
        });
    } catch (err) {
        return cb(err);
    }

    const stats = {};
    for (const row of rows) {
        stats[row.tag] = {
            total: row.total,
            newCount: row.new_count,
            yours: null === row.yours ? row.new_count : row.yours,
            lastPostId: row.last_id || 0,
            lastPostTs: row.last_ts || null,
        };
    }
    return cb(null, stats);
}

//
//  Moves |user|'s lastread pointer for |areaTag| to the area's highest message
//  ID. Forward only, as updateMessageAreaLastReadId() is by default.
//
function markMessageAreaRead(user, areaTag, cb) {
    //  as getMessageAreaStats() reads it; the pointer itself is per tag
    const msgAreaTag = Message.isPrivateAreaTag(areaTag)
        ? Message.WellKnownAreaTags.Private
        : areaTag;
    getHighestMessageIdByArea(msgAreaTag, (err, highestId) => {
        if (err) {
            return cb(err);
        }
        if (!highestId) {
            return cb(null); //  empty area; nothing to mark
        }
        return updateMessageAreaLastReadId(user.userId, areaTag, highestId, cb);
    });
}

//
//  Bumped whenever one of a user's lastread pointers moves. StatLog keys its
//  cached per-user message counts on it, so a count read after the pointer
//  moved is recounted rather than served from the cache window. It is
//  per-process: a pointer moved by another process (oputil, say) is picked
//  up when the cache window ends.
//
const lastReadGenerations = new Map(); //  userId -> n

function getMessageAreaLastReadGeneration(userId) {
    return lastReadGenerations.get(userId) || 0;
}

//
//  The areas in |confTag| that |client| can read, hidden ones included, as
//  new_scan scans them. [] for a conference the caller cannot read.
//
function getReadableMessageAreaTagsInConf(client, confTag) {
    const confs = getAvailableMessageConferences(client, {
        includeSystemInternal: true,
        includeHidden: true,
    });
    if (!confTag || !confs[confTag]) {
        return [];
    }
    return Object.keys(
        getAvailableMessageAreasByConfTag(confTag, { client, includeHidden: true }) || {}
    );
}

//
//  The areas new_scan would scan for |client|: every readable area, private
//  mail and hidden conferences included, narrowed to the caller's
//  NewScanAreaTags selection when they have made one. A menu's
//  omitMessageAreaTags is new_scan's own and not applied here.
//
function getNewScanMessageAreaTags(client) {
    const areaTags = getAllAvailableMessageAreaTags(client, {
        includeSystemInternal: true,
        includeHidden: true,
    });

    let selected = null;
    const raw = client.user.getProperty(UserProps.NewScanAreaTags);
    if (raw) {
        try {
            const tags = JSON.parse(raw);
            selected = Array.isArray(tags) && tags.length > 0 ? tags : null;
        } catch (e) {
            selected = null;
        }
    }

    return selected ? areaTags.filter(tag => selected.includes(tag)) : areaTags;
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
                //  a pointer that could not be read is not 0: writing over it
                //  could move it backwards
                getMessageAreaLastReadId(userId, areaTag, function result(err, lastId) {
                    return callback(err, lastId || 0);
                });
            },
            function update(lastId, callback) {
                if (allowOlder || messageId > lastId) {
                    try {
                        msgDb
                            .prepare(
                                'REPLACE INTO user_message_area_last_read (user_id, area_tag, message_id) ' +
                                    'VALUES (?, ?, ?);'
                            )
                            //  lower case, as getMessageAreaLastReadId() reads
                            //  it: a row stored any other way is never found
                            .run(userId, areaTag.toLowerCase(), messageId);
                    } catch (err) {
                        return callback(err);
                    }
                    lastReadGenerations.set(
                        userId,
                        getMessageAreaLastReadGeneration(userId) + 1
                    );
                    return callback(null, true); //  true=didUpdate
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

        try {
            const info = msgDb
                .prepare(
                    `DELETE FROM message
                    WHERE message_id IN(
                        SELECT message_id
                        FROM message
                        WHERE area_tag = ?
                        ORDER BY message_id DESC
                        LIMIT -1 OFFSET ${areaInfo.maxMessages}
                    );`
                )
                //  as stored, which is as configured: the age trim below
                //  matches it the same way
                .run(areaInfo.areaTag);
            Log.debug(
                { areaInfo: areaInfo, type: 'maxMessages', count: info.changes },
                'Area trimmed successfully'
            );
            return cb(null);
        } catch (err) {
            Log.error(
                { areaInfo: areaInfo, error: err.message, type: 'maxMessages' },
                'Error trimming message area'
            );
            return cb(err);
        }
    }

    function trimMessageAreaByMaxAgeDays(areaInfo, cb) {
        if (0 === areaInfo.maxAgeDays) {
            return cb(null);
        }

        try {
            const info = msgDb
                .prepare(
                    `DELETE FROM message
                    WHERE area_tag = ? AND modified_timestamp < date('now', '-${areaInfo.maxAgeDays} days');`
                )
                .run(areaInfo.areaTag);
            Log.debug(
                { areaInfo: areaInfo, type: 'maxAgeDays', count: info.changes },
                'Area trimmed successfully'
            );
            return cb(null);
        } catch (err) {
            Log.warn(
                { areaInfo: areaInfo, error: err.message, type: 'maxAgeDays' },
                'Error trimming message area'
            );
            return cb(err);
        }
    }

    async.waterfall(
        [
            function getAreaTags(callback) {
                //
                //  We use SQL here vs API such that no-longer-used tags are picked up
                //
                try {
                    const rows = msgDb
                        .prepare(
                            `SELECT DISTINCT area_tag
                            FROM message;`
                        )
                        .all();
                    const areaTags = (rows || [])
                        .map(row => row.area_tag)
                        .filter(tag => !Message.isPrivateAreaTag(tag));
                    return callback(null, areaTags);
                } catch (err) {
                    return callback(err);
                }
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
                const cbWrap = (e, t, c) => {
                    if (e) {
                        Log.warn({ error: e.message, type: t }, `Failed trimming (${t})`);
                    }
                    return c(null);
                };

                const ApSharedAreaTag = Message.WellKnownAreaTags.ActivityPubShared;

                //  Clean up messages, and any associated ActivityPub 'SharedInbox'
                //  Notes (ie: the source of said messages)
                async.each(
                    areaInfos,
                    (areaInfo, nextArea) => {
                        Log.info(
                            { areaInfo },
                            `Trimming message area "${areaInfo.areaTag}"...`
                        );

                        async.series(
                            [
                                next => {
                                    trimMessageAreaByMaxMessages(areaInfo, err => {
                                        return cbWrap(err, 'Messages:MaxCount', next);
                                    });
                                },
                                next => {
                                    if (areaInfo.areaTag !== ApSharedAreaTag) {
                                        return next(null);
                                    }
                                    Collection.removeByMaxCount(
                                        Collections.SharedInbox,
                                        areaInfo.maxMessages,
                                        err => {
                                            return cbWrap(
                                                err,
                                                'ActivityPubShared:MaxCount',
                                                next
                                            );
                                        }
                                    );
                                },
                                next => {
                                    trimMessageAreaByMaxAgeDays(areaInfo, err => {
                                        return cbWrap(err, 'Messages:MaxAgeDays', next);
                                    });
                                },
                                next => {
                                    if (areaInfo.areaTag !== ApSharedAreaTag) {
                                        return next(null);
                                    }
                                    Collection.removeByMaxAgeDays(
                                        Collections.SharedInbox,
                                        areaInfo.maxAgeDays,
                                        err => {
                                            return cbWrap(
                                                err,
                                                'ActivityPubShared:MaxAgeDays',
                                                next
                                            );
                                        }
                                    );
                                },
                            ],
                            err => {
                                return nextArea(err);
                            }
                        );
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
                //  Config is a function here (see the top of this file), so the
                //  setting has to be read from what it returns; reading the
                //  function itself always fell back to the default. 0 keeps
                //  sent mail, as 0 means unlimited for the other trim settings.
                //
                const DefaultMaxExternalSentAgeDays = 30;
                const configured = _.get(
                    Config(),
                    [
                        'messageConferences',
                        WellKnownConfTags.SystemInternal,
                        'areas',
                        WellKnownAreaTags.Private,
                        'maxExternalSentAgeDays',
                    ],
                    DefaultMaxExternalSentAgeDays
                );

                let maxExternalSentAgeDays = configured;
                if (
                    !Number.isFinite(maxExternalSentAgeDays) ||
                    maxExternalSentAgeDays < 0
                ) {
                    Log.warn(
                        { maxExternalSentAgeDays: configured },
                        `Invalid maxExternalSentAgeDays; using ${DefaultMaxExternalSentAgeDays}`
                    );
                    maxExternalSentAgeDays = DefaultMaxExternalSentAgeDays;
                }

                if (0 === maxExternalSentAgeDays) {
                    return callback(null);
                }

                try {
                    const info = msgDb
                        .prepare(
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
                                WHERE m.area_tag='${Message.WellKnownAreaTags.Private}' AND DATETIME('now') > DATETIME(m.modified_timestamp, ?)
                            );`
                        )
                        .run(`+${maxExternalSentAgeDays} days`);
                    Log.debug(
                        { count: info.changes },
                        'Private externally sent messages trimmed successfully'
                    );
                } catch (err) {
                    Log.warn(
                        { error: err.message },
                        'Error trimming private externally sent messages'
                    );
                }

                return callback(null);
            },
        ],
        err => {
            return cb(err);
        }
    );
}
