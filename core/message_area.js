/* jslint node: true */
'use strict';

let msgDb			= require('./database.js').dbs.message;
let Config			= require('./config.js').config;
let Message			= require('./message.js');
let Log				= require('./logger.js').log;
let checkAcs        = require('./acs_util.js').checkAcs;
let msgNetRecord	= require('./msg_network.js').recordMessage;

let async			= require('async');
let _				= require('lodash');
let assert			= require('assert');

exports.getAvailableMessageConferences      = getAvailableMessageConferences;
exports.getSortedAvailMessageConferences	= getSortedAvailMessageConferences;
exports.getAvailableMessageAreasByConfTag   = getAvailableMessageAreasByConfTag;
exports.getSortedAvailMessageAreasByConfTag = getSortedAvailMessageAreasByConfTag;
exports.getDefaultMessageConferenceTag      = getDefaultMessageConferenceTag;
exports.getDefaultMessageAreaTagByConfTag   = getDefaultMessageAreaTagByConfTag;
exports.getMessageConferenceByTag			= getMessageConferenceByTag;
exports.getMessageAreaByTag					= getMessageAreaByTag;
exports.changeMessageConference				= changeMessageConference;
exports.changeMessageArea					= changeMessageArea;
exports.getMessageListForArea				= getMessageListForArea;
exports.getNewMessagesInAreaForUser			= getNewMessagesInAreaForUser;
exports.getMessageAreaLastReadId			= getMessageAreaLastReadId;
exports.updateMessageAreaLastReadId			= updateMessageAreaLastReadId;

const CONF_AREA_RW_ACS_DEFAULT  = 'GM[users]';
const AREA_MANAGE_ACS_DEFAULT   = 'GM[sysops]';

const AREA_ACS_DEFAULT = {
    read    : CONF_AREA_RW_ACS_DEFAULT,
    write   : CONF_AREA_RW_ACS_DEFAULT,
    manage  : AREA_MANAGE_ACS_DEFAULT,  
};

function getAvailableMessageConferences(client, options) {
    options = options || { includeSystemInternal : false };
    
    //	perform ACS check per conf & omit system_internal if desired
    return _.omit(Config.messageConferences, (v, k) => {        
        if(!options.includeSystemInternal && 'system_internal' === k) {
            return true;
        }
        
        const readAcs = v.acs || CONF_AREA_RW_ACS_DEFAULT;
        return !checkAcs(client, readAcs);
    });
}

function getSortedAvailMessageConferences(client, options) {
	var sorted = _.map(getAvailableMessageConferences(client, options), (v, k) => {
		return {
			confTag : k,
			conf	: v,
		};
	});
	
	sorted.sort((a, b) => {
		return a.conf.name.localeCompare(b.conf.name);
	});

	return sorted;
}

//  Return an *object* of available areas within |confTag|
function getAvailableMessageAreasByConfTag(confTag, options) {
	options = options || {};

	if(_.has(Config.messageConferences, [ confTag, 'areas' ])) {
        const areas = Config.messageConferences[confTag].areas;

        if(!options.client || true === options.noAcsCheck) {
            //	everything - no ACS checks
            return areas;
        } else {
            //	perform ACS check per area
            return _.omit(areas, (v, k) => {
                const readAcs = _.has(v, 'acs.read') ? v.acs.read : CONF_AREA_RW_ACS_DEFAULT;
                return !checkAcs(options.client, readAcs);
            });
        }
    }
}

function getSortedAvailMessageAreasByConfTag(confTag, options) {
    const areas = getAvailableMessageAreasByConfTag(confTag, options);
    
    //	:TODO: should probably be using localeCompare / sort
    return _.sortBy(_.map(areas, (v, k) => {
       return {
           areaTag  : k,
           area     : v,
       };
    }), o => o.area.name);  //  sort by name
}

function getDefaultMessageConferenceTag(client, disableAcsCheck) {
	//
	//	Find the first conference marked 'default'. If found,
	//	inspect |client| against *read* ACS using defaults if not
	//	specified.
	//	
	//	If the above fails, just go down the list until we get one
	//	that passes.
	//
	//	It's possible that we end up with nothing here!
	//
	//	Note that built in 'system_internal' is always ommited here
	//
    let defaultConf = _.findKey(Config.messageConferences, o => o.default);
    if(defaultConf) {
        const acs = Config.messageConferences[defaultConf].acs || CONF_AREA_RW_ACS_DEFAULT;
        if(true === disableAcsCheck || checkAcs(client, acs)) {
            return defaultConf;
        } 
    }
    
    //  just use anything we can
    defaultConf = _.findKey(Config.messageConferences, (o, k) => {
        const acs = o.acs || CONF_AREA_RW_ACS_DEFAULT;
        return 'system_internal' !== k && (true === disableAcsCheck || checkAcs(client, acs));
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
    
    if(confTag && _.has(Config.messageConferences, [ confTag, 'areas' ])) {
        const areaPool = Config.messageConferences[confTag].areas;        
        let defaultArea = _.findKey(areaPool, o => o.default);
        if(defaultArea) {
            const readAcs = _.has(areaPool, [ defaultArea, 'acs', 'read' ]) ? areaPool[defaultArea].acs.read : AREA_ACS_DEFAULT.read;
            if(true === disableAcsCheck || checkAcs(client, readAcs)) {
                return defaultArea;
            }            
        }
        
        defaultArea = _.findKey(areaPool, (o, k) => {
            const readAcs = _.has(areaPool, [ defaultArea, 'acs', 'read' ]) ? areaPool[defaultArea].acs.read : AREA_ACS_DEFAULT.read;
            return (true === disableAcsCheck || checkAcs(client, readAcs));       
        });
        
        return defaultArea;
    }
}

function getMessageConferenceByTag(confTag) {
	return Config.messageConferences[confTag];
}

function getMessageAreaByTag(areaTag, optionalConfTag) {
    const confs = Config.messageConferences;
    
    if(_.isString(optionalConfTag)) {
        if(_.has(confs, [ optionalConfTag, 'areas', areaTag ])) {
            return confs[optionalConfTag].areas[areaTag];
        }
    } else {
        //
        //  No confTag to work with - we'll have to search through them all
        //
        var area;
        _.forEach(confs, (v, k) => {
            if(_.has(v, [ 'areas', areaTag ])) {
                area = v.areas[areaTag];
                return false;   //  stop iteration
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
				
				if(conf) {
					callback(null, conf);
				} else {
					callback(new Error('Invalid message conference tag'));
				}
			},
			function getDefaultAreaInConf(conf, callback) {
				const areaTag 	= getDefaultMessageAreaTagByConfTag(client, confTag);
				const area		= getMessageAreaByTag(areaTag, confTag);
				
				if(area) {
					callback(null, conf, { areaTag : areaTag, area : area } );
				} else {
					callback(new Error('No available areas for this user in conference'));
				}
			},
			function validateAccess(conf, areaInfo, callback) {
				const confAcs = conf.acs || CONF_AREA_RW_ACS_DEFAULT;				
				
				if(!checkAcs(client, confAcs)) {
					callback(new Error('User does not have access to this conference'));
				} else {
					const areaAcs = _.has(areaInfo, 'area.acs.read') ? areaInfo.area.acs.read : CONF_AREA_RW_ACS_DEFAULT;
					if(!checkAcs(client, areaAcs)) {
						callback(new Error('User does not have access to default area in this conference'));
					} else {
						callback(null, conf, areaInfo);
					}
				}
			},			
			function changeConferenceAndArea(conf, areaInfo, callback) {
				const newProps = {
					message_conf_tag	: confTag,
					message_area_tag	: areaInfo.areaTag,
				};
				client.user.persistProperties(newProps, err => {
					callback(err, conf, areaInfo);
				});
			},
		],
		function complete(err, conf, areaInfo) {
			if(!err) {
				client.log.info( { confTag : confTag, confName : conf.name, areaTag : areaInfo.areaTag }, 'Current message conference changed');
			} else {
				client.log.warn( { confTag : confTag, error : err.message }, 'Could not change message conference');
			}
			cb(err);
		}
	);
}

function changeMessageArea(client, areaTag, cb) {
	
	async.waterfall(
		[
			function getArea(callback) {
				const area = getMessageAreaByTag(areaTag);

				if(area) {
					callback(null, area);
				} else {
					callback(new Error('Invalid message area tag'));
				}
			},
			function validateAccess(area, callback) {
                //
                //  Need at least *read* to access the area
                //
                const readAcs = _.has(area, 'acs.read') ? area.acs.read : CONF_AREA_RW_ACS_DEFAULT;
                if(!checkAcs(client, readAcs)) {                    
					callback(new Error('User does not have access to this area'));
				} else {
					callback(null, area);
				}
			},
			function changeArea(area, callback) {
				client.user.persistProperty('message_area_tag', areaTag, function persisted(err) {
					callback(err, area);
				});
			}
		],
		function complete(err, area) {
			if(!err) {
				client.log.info( { areaTag : areaTag, area : area }, 'Current message area changed');
			} else {
				client.log.warn( { areaTag : areaTag, area : area, error : err.message }, 'Could not change message area');
			}

			cb(err);
		}
	);
}

function getMessageFromRow(row) {
	return { 
		messageId		: row.message_id,
		messageUuid		: row.message_uuid,
		replyToMsgId	: row.reply_to_message_id,
		toUserName		: row.to_user_name,
		fromUserName	: row.from_user_name,
		subject			: row.subject,
		modTimestamp	: row.modified_timestamp,
		viewCount		: row.view_count,
	};
}

function getNewMessagesInAreaForUser(userId, areaTag, cb) {
	//
	//	If |areaTag| is Message.WellKnownAreaTags.Private,
	//	only messages addressed to |userId| should be returned.
	//
	//	Only messages > lastMessageId should be returned
	//
	var msgList = [];

	async.waterfall(
		[
			function getLastMessageId(callback) {
				getMessageAreaLastReadId(userId, areaTag, function fetched(err, lastMessageId) {
					callback(null, lastMessageId || 0);	//	note: willingly ignoring any errors here!
				});
			},
			function getMessages(lastMessageId, callback) {
				var sql = 
					'SELECT message_id, message_uuid, reply_to_message_id, to_user_name, from_user_name, subject, modified_timestamp, view_count ' +
					'FROM message ' +
					'WHERE area_tag ="' + areaTag + '" AND message_id > ' + lastMessageId;

				if(Message.WellKnownAreaTags.Private === areaTag) {
					sql += 
						' AND message_id in (' +
						'SELECT message_id from message_meta where meta_category=' + Message.MetaCategories.System + 
						' AND meta_name="' + Message.SystemMetaNames.LocalToUserID + '" and meta_value=' + userId + ')';
				}

				sql += ' ORDER BY message_id;';

				msgDb.each(sql, function msgRow(err, row) {
					if(!err) {
						msgList.push(getMessageFromRow(row));
					}
				}, callback);
			}
		],
		function complete(err) {
			cb(err, msgList);
		}
	);	
}

function getMessageListForArea(options, areaTag, cb) {
	//
	//	options.client (required)
	//

	options.client.log.debug( { areaTag : areaTag }, 'Fetching available messages');

	assert(_.isObject(options.client));

	/*
		[
			{ 
				messageId, messageUuid, replyToId, toUserName, fromUserName, subject, modTimestamp,
				status(new|old),
				viewCount
			}
		]
	*/

	var msgList = [];

	async.series(
		[
			function fetchMessages(callback) {
				msgDb.each(
					'SELECT message_id, message_uuid, reply_to_message_id, to_user_name, from_user_name, subject, modified_timestamp, view_count '	+
					'FROM message '																													+
					'WHERE area_tag = ? '																											+
					'ORDER BY message_id;',
					[ areaTag.toLowerCase() ],
					function msgRow(err, row) {
						if(!err) {
							msgList.push(getMessageFromRow(row));
						}
					},
					callback
				);
			},
			function fetchStatus(callback) {
				callback(null);//	:TODO: fixmeh.
			}
		],
		function complete(err) {
			cb(err, msgList);
		}
	);
}

function getMessageAreaLastReadId(userId, areaTag, cb) {
	msgDb.get(
		'SELECT message_id '					+
		'FROM user_message_area_last_read '		+
		'WHERE user_id = ? AND area_tag = ?;',
		[ userId, areaTag ],
		function complete(err, row) {
			cb(err, row ? row.message_id : 0);
		}
	);
}

function updateMessageAreaLastReadId(userId, areaTag, messageId, cb) {
	//	:TODO: likely a better way to do this...
	async.waterfall(
		[
			function getCurrent(callback) {
				getMessageAreaLastReadId(userId, areaTag, function result(err, lastId) {
					lastId = lastId || 0;
					callback(null, lastId);	//	ignore errors as we default to 0
				});
			},
			function update(lastId, callback) {
				if(messageId > lastId) {
					msgDb.run(
						'REPLACE INTO user_message_area_last_read (user_id, area_tag, message_id) '	+
						'VALUES (?, ?, ?);',
						[ userId, areaTag, messageId ],
						function written(err) {
                            callback(err, true);    //  true=didUpdate
                        }
					);
				} else {
					callback(null);
				}
			}
		],
		function complete(err, didUpdate) {
			if(err) {
				Log.debug( 
					{ error : err.toString(), userId : userId, areaTag : areaTag, messageId : messageId }, 
					'Failed updating area last read ID');
			} else {
                if(true === didUpdate) {
                    Log.trace( 
                        { userId : userId, areaTag : areaTag, messageId : messageId },
                        'Area last read ID updated');
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
				message.persist(callback);
			},
			function recordToMessageNetworks(callback) {
				msgNetRecord(message, callback);
			}
		],
		cb
	);
}