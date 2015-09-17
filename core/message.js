/* jslint node: true */
'use strict';

var msgDb			= require('./database.js').dbs.message;
var wordWrapText	= require('./word_wrap.js').wordWrapText;

var uuid			= require('node-uuid');
var async			= require('async');
var _				= require('lodash');
var assert			= require('assert');

module.exports = Message;

function Message(options) {
	options = options || {};

	this.messageId		= options.messageId || 0;	//	always generated @ persist
	this.areaName		= options.areaName || Message.WellKnownAreaNames.Invalid;
	this.uuid			= uuid.v1();
	this.replyToMsgId	= options.replyToMsgId || 0;
	this.toUserName		= options.toUserName || '';
	this.fromUserName	= options.fromUserName || '';
	this.subject		= options.subject || '';
	this.message		= options.message || '';
	
	if(_.isDate(options.modTimestamp)) {
		this.modTimestamp = options.modTimestamp;
	} else if(_.isString(options.modTimestamp)) {
		this.modTimestamp = new Date(options.modTimestamp);
	}

	this.viewCount		= options.viewCount || 0;

	this.meta			= {
		system	: {},	//	we'll always have this one
	};

	if(_.isObject(options.meta)) {
		_.defaultsDeep(this.meta, options.meta);
	}

	if(options.meta) {
		this.meta = options.meta;
	}

//	this.meta			= options.meta || {};
	this.hashTags		= options.hashTags || [];

	var self			= this;

	this.isValid = function() {
		//	:TODO: validate as much as possible
		return true;
	};

	this.getMessageTimestampString = function(ts) {
		ts = ts || new Date();
		return ts.toISOString();
	};

	/*
	Object.defineProperty(this, 'messageId', {
		get : function() {
			return messageId;
		}
	});

	Object.defineProperty(this, 'areaId', {
		get : function() { return areaId; },
		set : function(i) {
			areaId = i;
		}
	});

	*/
}

Message.WellKnownAreaNames = {
	Invalid	: '',
	Private	: 'private_mail'
};

Message.Status = {
	New		: 0,
	Read	: 1,
};

Message.MetaCategories = {
	System				: 1,			//	ENiGMA1/2 stuff
	FtnProperty			: 2,			//	Various FTN network properties, ftn_cost, ftn_origin, ...
	FtnKludge			: 3,			//	FTN kludges -- PATH, MSGID, ...
};

Message.SystemMetaNames = {
	LocalToUserID			: 'local_to_user_id',
	LocalFromUserID			: 'local_from_user_id',
};

Message.FtnPropertyNames = {
	FtnCost				: 'ftn_cost',
	FtnOrigNode			: 'ftn_orig_node',
	FtnDestNode			: 'ftn_dest_node',
	FtnOrigNetwork		: 'ftn_orig_network',
	FtnDestNetwork		: 'ftn_dest_network',
	FtnOrigZone			: 'ftn_orig_zone',
	FtnDestZone			: 'ftn_dest_zone',
	FtnOrigPoint		: 'ftn_orig_point',
	FtnDestPoint		: 'ftn_dest_point',
	FtnAttribute		: 'ftn_attribute',

	FtnTearLine			: 'ftn_tear_line',		//	http://ftsc.org/docs/fts-0004.001
	FtnOrigin			: 'ftn_origin',			//	http://ftsc.org/docs/fts-0004.001
	FtnArea				: 'ftn_area',			//	http://ftsc.org/docs/fts-0004.001
	FtnSeenBy			: 'ftn_seen_by',		//	http://ftsc.org/docs/fts-0004.001
};

//	Note: kludges are stored with their names as-is

Message.prototype.setLocalToUserId = function(userId) {
	this.meta.system.local_to_user_id = userId;
};

Message.prototype.setLocalFromUserId = function(userId) {
	this.meta.system.local_from_user_id = userId;
};

Message.prototype.load = function(options, cb) {
	assert(_.isString(options.uuid));

	var self = this;

	async.series(
		[
			function loadMessage(callback) {
				msgDb.get(
					'SELECT message_id, area_name, message_uuid, reply_to_message_id, to_user_name, from_user_name, subject, '	+
					'message, modified_timestamp, view_count '																	+
					'FROM message '																								+
					'WHERE message_uuid=? '																						+
					'LIMIT 1;',
					[ options.uuid ],
					function row(err, msgRow) {
						self.messageId		= msgRow.message_id;
						self.areaName		= msgRow.area_name;
						self.messageUuid	= msgRow.message_uuid;
						self.replyToMsgId	= msgRow.reply_to_message_id;
						self.toUserName		= msgRow.to_user_name;
						self.fromUserName	= msgRow.from_user_name;
						self.subject		= msgRow.subject;
						self.message		= msgRow.message;
						self.modTimestamp	= msgRow.modified_timestamp;
						self.viewCount		= msgRow.view_count;

						callback(err);
					}
				);
			},
			function loadMessageMeta(callback) {
				//	:TODO:
				callback(null);
			},
			function loadHashTags(callback) {
				//	:TODO:
				callback(null);
			},
			function loadMessageStatus(callback) {
				if(options.user) {
					//	:TODO: Load from user_message_status
				}
				callback(null);
			}
		],
		function complete(err) {
			cb(err);
		}
	);
};

Message.prototype.persist = function(cb) {

	if(!this.isValid()) {
		cb(new Error('Cannot persist invalid message!'));
		return;
	}

	var self = this;

	async.series(
		[
			function beginTransaction(callback) {
				msgDb.run('BEGIN;', function transBegin(err) {
					callback(err);
				});
			},
			function storeMessage(callback) {
				msgDb.run(
					'INSERT INTO message (area_name, message_uuid, reply_to_message_id, to_user_name, from_user_name, subject, message, modified_timestamp) ' +
					'VALUES (?, ?, ?, ?, ?, ?, ?, ?);', [ self.areaName, self.uuid, self.replyToMsgId, self.toUserName, self.fromUserName, self.subject, self.message, self.getMessageTimestampString(self.modTimestamp) ],
					function msgInsert(err) {
						if(!err) {
							self.messageId = this.lastID;
						}

						callback(err);
					}
				);
			},
			function storeMeta(callback) {
				if(!self.meta) {
					callback(null);
				} else {
					//	:TODO: this should be it's own method such that meta can be updated
					var metaStmt = msgDb.prepare(
						'INSERT INTO message_meta (message_id, meta_category, meta_name, meta_value) ' + 
						'VALUES (?, ?, ?, ?);');

					for(var metaCategroy in self.meta) {
						async.each(Object.keys(self.meta[metaCategroy]), function meta(metaName, next) {
							metaStmt.run(self.messageId, Message.MetaCategories[metaCategroy], metaName, self.meta[metaCategroy][metaName], function inserted(err) {
								next(err);
							});
						}, function complete(err) {
							if(!err) {
								metaStmt.finalize(function finalized() {
									callback(null);
								});
							} else {
								callback(err);
							}
						});
					}
				}
			},
			function storeHashTags(callback) {
				//	:TODO: hash tag support
				callback(null);
			}
		],
		function complete(err) {
			msgDb.run(err ? 'ROLLBACK;' : 'COMMIT;', function transEnd(err) {
				cb(err, self.messageId);
			});
		}
	);
};

Message.prototype.getFTNQuotePrefix = function(source) {
	source = source || 'fromUserName';

	switch(source) {
		case 'fromUserName' :
			return this.fromUserName[0].toUpperCase() + this.fromUserName[1].toLowerCase();

		case 'toUserName' :
			return this.toUserName[0].toUpperCase() + this.toUserName[1].toLowerCase();		

		//	:TODO: real names
	}
};

Message.prototype.getQuoteLines = function(width, options) {
	//	:TODO: options.maxBlankLines = 1

	options = options || {};
	
	//
	//	Include FSC-0032 style quote prefixes?
	//
	//	See http://ftsc.org/docs/fsc-0032.001
	//
	if(!_.isBoolean(options.includePrefix)) {
		options.includePrefix = true;
	}

	var quoteLines = [];

	var origLines = this.message
		.replace(/\b/g, '')
		.split(/\r\n|[\n\v\f\r\x85\u2028\u2029]/g);	
	
	var wrapOpts = {
		width		: width,
		tabHandling	: 'expand',
		tabWidth	: 4,
	};

	var quotePrefix;
	if(options.includePrefix) {
		quotePrefix = ' ' + this.getFTNQuotePrefix(options.prefixSource || 'fromUserName') + '> ';
	}

	for(var i = 0; i < origLines.length; ++i) {
		Array.prototype.push.apply(quoteLines, wordWrapText(quotePrefix + origLines[i], wrapOpts).wrapped);
	}

	return quoteLines;
};
