/* jslint node: true */
'use strict';

//	ENiGMA½
const msgDb			= require('./database.js').dbs.message;
const Config		= require('./config.js').config;
const Message		= require('./message.js');
const Log			= require('./logger.js').log;
const msgNetRecord	= require('./msg_network.js').recordMessage;

//	deps
const async			= require('async');
const _				= require('lodash');
const assert		= require('assert');

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
exports.tempChangeMessageConfAndArea		= tempChangeMessageConfAndArea;
exports.getMessageListForArea				= getMessageListForArea;
exports.getNewMessageCountInAreaForUser		= getNewMessageCountInAreaForUser;
exports.getNewMessagesInAreaForUser			= getNewMessagesInAreaForUser;
exports.getMessageAreaLastReadId			= getMessageAreaLastReadId;
exports.updateMessageAreaLastReadId			= updateMessageAreaLastReadId;
exports.persistMessage						= persistMessage;
exports.trimMessageAreasScheduledEvent		= trimMessageAreasScheduledEvent;

//
//	Method for sorting Message areas and conferences
//	If the sort key is present and is a number, sort in numerical order;
//	Otherwise, use a locale comparison on the sort key or name as a fallback
// 
function sortAreasOrConfs(areasOrConfs, type) {
	let entryA;
	let entryB;

	areasOrConfs.sort((a, b) => {
		entryA = a[type];
		entryB = b[type];

		if(_.isNumber(entryA.sort) && _.isNumber(entryB.sort)) {
			return entryA.sort - entryB.sort;
		} else {
			const keyA = entryA.sort ? entryA.sort.toString() : entryA.name;
			const keyB = entryB.sort ? entryB.sort.toString() : entryB.name;
			return keyA.localeCompare(keyB);
		}
	});
}

function getAvailableMessageConferences(client, options) {
	options = options || { includeSystemInternal : false };
    
    //	perform ACS check per conf & omit system_internal if desired
	return _.omit(Config.messageConferences, (conf, confTag) => {        
		if(!options.includeSystemInternal && 'system_internal' === confTag) {
			return true;
		}

		return !client.acs.hasMessageConfRead(conf);
	});
}

function getSortedAvailMessageConferences(client, options) {
	const confs = _.map(getAvailableMessageConferences(client, options), (v, k) => {
		return {
			confTag : k,
			conf	: v,
		};
	});

	sortAreasOrConfs(confs, 'conf');
	
	return confs;
}

//  Return an *object* of available areas within |confTag|
function getAvailableMessageAreasByConfTag(confTag, options) {
	options = options || {};
    
    //  :TODO: confTag === "" then find default

	if(_.has(Config.messageConferences, [ confTag, 'areas' ])) {
		const areas = Config.messageConferences[confTag].areas;

		if(!options.client || true === options.noAcsCheck) {
			//	everything - no ACS checks
			return areas;
		} else {
			//	perform ACS check per area
			return _.omit(areas, area => {
				return !options.client.acs.hasMessageAreaRead(area);
			});
		}
	}
}

function getSortedAvailMessageAreasByConfTag(confTag, options) {
	const areas = _.map(getAvailableMessageAreasByConfTag(confTag, options), (v, k) => {
		return  {
			areaTag	: k,
			area	: v,
		};
	});
	
	sortAreasOrConfs(areas, 'area');
	
	return areas;
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
		const conf = Config.messageConferences[defaultConf];
		if(true === disableAcsCheck || client.acs.hasMessageConfRead(conf)) {
			return defaultConf;
		} 
	}

	//  just use anything we can
	defaultConf = _.findKey(Config.messageConferences, (conf, confTag) => {
		return 'system_internal' !== confTag && (true === disableAcsCheck || client.acs.hasMessageConfRead(conf));
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
			const area = areaPool[defaultArea];
			if(true === disableAcsCheck || client.acs.hasMessageAreaRead(area)) {
				return defaultArea;
			}            
		}
		
		defaultArea = _.findKey(areaPool, (area) => {
			return (true === disableAcsCheck || client.acs.hasMessageAreaRead(area));       
		});
		
		return defaultArea;
	}
}

function getMessageConferenceByTag(confTag) {
	return Config.messageConferences[confTag];
}

function getMessageConfByAreaTag(areaTag) {
	const confs = Config.messageConferences;
	let conf;
	_.forEach(confs, (v) => {
		if(_.has(v, [ 'areas', areaTag ])) {
			conf = v;
			return false;   //  stop iteration
		}
	});
	return conf;
}

function getMessageConfTagByAreaTag(areaTag) {
	const confs = Config.messageConferences;
	return Object.keys(confs).find( (confTag) => {
		return _.has(confs, [ confTag, 'areas', areaTag]);
	});
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
		let area;
		_.forEach(confs, (v) => {
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
				if(!client.acs.hasMessageConfRead(conf) || !client.acs.hasMessageAreaRead(areaInfo.area)) {
					return callback(new Error('Access denied to message area and/or conference'));
				} else {
					return callback(null, conf, areaInfo);
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

function changeMessageAreaWithOptions(client, areaTag, options, cb) {
	options = options || {};

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
				if(!client.acs.hasMessageAreaRead(area)) {
					return callback(new Error('Access denied to message area'));
				} else {
					return callback(null, area);
				}
			},
			function changeArea(area, callback) {
				if(true === options.persist) {
					client.user.persistProperty('message_area_tag', areaTag, function persisted(err) {
						return callback(err, area);
					});
				} else {
					client.user.properties['message_area_tag'] = areaTag;
					return callback(null, area);
				}
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

//
//	Temporairly -- e.g. non-persisted -- change to an area and it's 
//	associated underlying conference. ACS is checked for both.
//
//	This is useful for example when doing a new scan
//
function tempChangeMessageConfAndArea(client, areaTag) {
	const area		= getMessageAreaByTag(areaTag);
	const confTag	= getMessageConfTagByAreaTag(areaTag);

	if(!area || !confTag) {
		return false;
	}

	const conf = getMessageConferenceByTag(confTag);

	if(!client.acs.hasMessageConfRead(conf) || !client.acs.hasMessageAreaRead(area)) {
		return false;
	}
	
	client.user.properties.message_conf_tag	= confTag;
	client.user.properties.message_area_tag = areaTag;

	return true;
}

function changeMessageArea(client, areaTag, cb) {
	changeMessageAreaWithOptions(client, areaTag, { persist : true }, cb);
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

function getNewMessageDataInAreaForUserSql(userId, areaTag, lastMessageId, what) {
	//
	//	Helper for building SQL to fetch either a full message list or simply
	//	a count of new messages based on |what|.
	//
	//	* If |areaTag| is Message.WellKnownAreaTags.Private,
	//	  only messages addressed to |userId| should be returned/counted.
	//
	//	* Only messages > |lastMessageId| should be returned/counted
	//
	const selectWhat = ('count' === what) ? 
		'COUNT() AS count' : 
		'message_id, message_uuid, reply_to_message_id, to_user_name, from_user_name, subject, modified_timestamp, view_count';

	let sql = 
		`SELECT ${selectWhat}
		FROM message
		WHERE area_tag = "${areaTag}" AND message_id > ${lastMessageId}`;

	if(Message.isPrivateAreaTag(areaTag)) {
		sql += 
			` AND message_id in (
				SELECT message_id 
				FROM message_meta 
				WHERE meta_category = "System" AND meta_name = "${Message.SystemMetaNames.LocalToUserID}" AND meta_value = ${userId}
			)`;
	}

	if('count' === what) {
		sql += ';';
	} else {
		sql += ' ORDER BY message_id;';
	}

	return sql;
}

function getNewMessageCountInAreaForUser(userId, areaTag, cb) {
	async.waterfall(
		[
			function getLastMessageId(callback) {
				getMessageAreaLastReadId(userId, areaTag, function fetched(err, lastMessageId) {
					callback(null, lastMessageId || 0);	//	note: willingly ignoring any errors here!
				});
			},
			function getCount(lastMessageId, callback) {
				const sql = getNewMessageDataInAreaForUserSql(userId, areaTag, lastMessageId, 'count');
				msgDb.get(sql, (err, row) => {
					return callback(err, row ? row.count : 0);
				});
			} 
		],
		cb
	);
}

function getNewMessagesInAreaForUser(userId, areaTag, cb) {
	//
	//	If |areaTag| is Message.WellKnownAreaTags.Private,
	//	only messages addressed to |userId| should be returned.
	//
	//	Only messages > lastMessageId should be returned
	//
	let msgList = [];

	async.waterfall(
		[
			function getLastMessageId(callback) {
				getMessageAreaLastReadId(userId, areaTag, function fetched(err, lastMessageId) {
					callback(null, lastMessageId || 0);	//	note: willingly ignoring any errors here!
				});
			},
			function getMessages(lastMessageId, callback) {
				const sql = getNewMessageDataInAreaForUserSql(userId, areaTag, lastMessageId, 'messages');

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

	let msgList = [];

	async.series(
		[
			function fetchMessages(callback) {
				let sql = 
					`SELECT message_id, message_uuid, reply_to_message_id, to_user_name, from_user_name, subject, modified_timestamp, view_count
					FROM message
					WHERE area_tag = ?`;

				if(Message.isPrivateAreaTag(areaTag)) {
					sql += 
						` AND message_id IN (
							SELECT message_id 
							FROM message_meta 
							WHERE meta_category = "System" AND meta_name = "${Message.SystemMetaNames.LocalToUserID}" AND meta_value = ${options.client.user.userId}
						)`;
				}

				sql += ' ORDER BY message_id;'; 

				msgDb.each(
					sql,
					[ areaTag.toLowerCase() ],
					(err, row) => {
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

//	method exposed for event scheduler
function trimMessageAreasScheduledEvent(args, cb) {
	
	function trimMessageAreaByMaxMessages(areaInfo, cb) {
		if(0 === areaInfo.maxMessages) {
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
			[ areaInfo.areaTag],
			err => {
				if(err) {
					Log.error( { areaInfo : areaInfo, err : err, type : 'maxMessages' }, 'Error trimming message area');
				} else {
					Log.debug( { areaInfo : areaInfo, type : 'maxMessages' }, 'Area trimmed successfully');
				}
				return cb(err);
			}	
		);
	}

	function trimMessageAreaByMaxAgeDays(areaInfo, cb) {
		if(0 === areaInfo.maxAgeDays) {
			return cb(null);
		}

		msgDb.run(
			`DELETE FROM message
			WHERE area_tag = ? AND modified_timestamp < date('now', '-${areaInfo.maxAgeDays} days');`,
			[ areaInfo.areaTag ],
			err => {
				if(err) {
					Log.warn( { areaInfo : areaInfo, err : err, type : 'maxAgeDays' }, 'Error trimming message area');
				} else {
					Log.debug( { areaInfo : areaInfo, type : 'maxAgeDays' }, 'Area trimmed successfully');
				}
				return cb(err);
			}
		);
	}
	
	async.waterfall(
		[			
			function getAreaTags(callback) {
				let areaTags = [];
				msgDb.each(
					`SELECT DISTINCT area_tag
					FROM message;`,
					(err, row) => {
						if(err) {
							return callback(err);
						}
						areaTags.push(row.area_tag);
					},
					err => {
						return callback(err, areaTags);
					}
				);
			},
			function prepareAreaInfo(areaTags, callback) {
				let areaInfos = [];

				//	determine maxMessages & maxAgeDays per area
				areaTags.forEach(areaTag => {
					
					let maxMessages = Config.messageAreaDefaults.maxMessages;
					let maxAgeDays	= Config.messageAreaDefaults.maxAgeDays;
					
					const area = getMessageAreaByTag(areaTag);	//	note: we don't know the conf here
					if(area) {
						if(area.maxMessages) {
							maxMessages = area.maxMessages;
						}
						if(area.maxAgeDays) {
							maxAgeDays = area.maxAgeDays;
						}
					}

					areaInfos.push( {
						areaTag		: areaTag,
						maxMessages	: maxMessages,
						maxAgeDays	: maxAgeDays,
					} );					
				});

				return callback(null, areaInfos);
			},
			function trimAreas(areaInfos, callback) {
				async.each(
					areaInfos,
					(areaInfo, next) => {
						trimMessageAreaByMaxMessages(areaInfo, err => {
							if(err) {
								return next(err);
							}

							trimMessageAreaByMaxAgeDays(areaInfo, err => {
								return next(err);
							});							
						});
					},
					callback
				);
			}			
		],
		err => {
			return cb(err);
		}
	);
	
}