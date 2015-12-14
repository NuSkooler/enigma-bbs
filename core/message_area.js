/* jslint node: true */
'use strict';

var msgDb			= require('./database.js').dbs.message;
var Config			= require('./config.js').config;
var Message			= require('./message.js');

var async			= require('async');
var _				= require('lodash');
var assert			= require('assert');

exports.getAvailableMessageAreas			= getAvailableMessageAreas;
exports.getDefaultMessageArea				= getDefaultMessageArea;
exports.getMessageAreaByName				= getMessageAreaByName;
exports.changeMessageArea					= changeMessageArea;
exports.getMessageListForArea				= getMessageListForArea;
exports.getMessageAreaLastReadId			= getMessageAreaLastReadId;
exports.updateMessageAreaLastReadId			= updateMessageAreaLastReadId;

function getAvailableMessageAreas(options) {
	//	example: [ { "name" : "local_music", "desc" : "Music Discussion", "groups" : ["somegroup"] }, ... ]
	options = options || {};

	var areas = Config.messages.areas;
	var avail = [];
	for(var i = 0; i < areas.length; ++i) {
		if(true !== options.includePrivate &&
			Message.WellKnownAreaNames.Private === areas[i].name)
		{
			continue;
		}

		avail.push(areas[i]);
	}

	return avail;
}

function getDefaultMessageArea() {
	//
	//	Return first non-private/etc. area name. This will be from config.hjson
	//
	return getAvailableMessageAreas()[0];
	/*
	var avail = getAvailableMessageAreas();
	for(var i = 0; i < avail.length; ++i) {
		if(Message.WellKnownAreaNames.Private !== avail[i].name) {
			return avail[i];
		}
	}
	*/
}

function getMessageAreaByName(areaName) {
	areaName = areaName.toLowerCase();

	var availAreas	= getAvailableMessageAreas( { includePrivate : true } );
	var index		= _.findIndex(availAreas, function pred(an) {
		return an.name == areaName;
	});

	if(index > -1) {
		return availAreas[index];
	}
}

function changeMessageArea(client, areaName, cb) {
	
	async.waterfall(
		[
			function getArea(callback) {
				var area = getMessageAreaByName(areaName);

				if(area) {
					callback(null, area);
				} else {
					callback(new Error('Invalid message area'));
				}
			},
			function validateAccess(area, callback) {
				if(_.isArray(area.groups) && !
					client.user.isGroupMember(area.groups))
				{
					callback(new Error('User does not have access to this area'));
				} else {
					callback(null, area);
				}
			},
			function changeArea(area, callback) {
				client.user.persistProperty('message_area_name', area.name, function persisted(err) {
					callback(err, area);
				});
			}
		],
		function complete(err, area) {
			if(!err) {
				client.log.info( area, 'Current message area changed');
			} else {
				client.log.warn( { area : area, error : err.message }, 'Could not change message area');
			}

			cb(err);
		}
	);
}

function getMessageListForArea(options, areaName, cb) {
	//
	//	options.client (required)
	//

	options.client.log.debug( { areaName : areaName }, 'Fetching available messages');

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
					'WHERE area_name=? '																											+
					'ORDER BY message_id;',
					[ areaName.toLowerCase() ],
					function msgRow(err, row) {
						if(!err) {
							msgList.push( { 
								messageId		: row.message_id,
								messageUuid		: row.message_uuid,
								replyToMsgId	: row.reply_to_message_id,
								toUserName		: row.to_user_name,
								fromUserName	: row.from_user_name,
								subject			: row.subject,
								modTimestamp	: row.modified_timestamp,
								viewCount		: row.view_count,
							} );
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

function getMessageAreaLastReadId(userId, areaName, cb) {
	msgDb.get(
		'SELECT message_id '					+
		'FROM user_message_area_last_read '		+
		'WHERE user_id = ? AND area_name = ?;',
		[ userId, areaName ],
		cb	//	(err, lastId)
	);
}

function updateMessageAreaLastReadId(userId, areaName, messageId) {
	//	:TODO: likely a better way to do this...
	async.waterfall(
		[
			function getCurrent(callback) {
				getMessageAreaLastReadId(userId, areaName, function result(err, lastId) {
					lastId = lastId || 0;
					callback(null, lastId);	//	ignore errors as we default to 0
				});
			},
			function update(lastId, callback) {
				if(messageId > lastId) {
					msgDb.run(
						'REPLACE INTO user_message_area_last_read (user_id, area_name, message_id) '	+
						'VALUES (?, ?, ?);',
						[ userId, areaName, messageId ]
					);
				}
			}
		]
	);
}
