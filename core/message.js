/* jslint node: true */
'use strict';

var msgDb			= require('./database.js').dbs.message;

var uuid			= require('node-uuid');
var async			= require('async');
var _				= require('lodash');
var assert			= require('assert');

exports.Message		= Message;

function Message(options) {
	
	this.messageId		= options.messageId || 0;	//	always generated @ persist
	this.areaId			= options.areaId || Message.WellKnownAreaIds.Invalid;		//	0 = invalid; 1 = private; Everything else is user defined
	this.uuid			= uuid.v1();
	this.replyToMsgId	= options.replyToMsgId || 0;
	this.toUserName		= options.toUserName || '';
	this.fromUserName	= options.fromUserName || '';
	this.subject		= options.subject || '';
	this.message		= options.message || '';
	this.modTimestamp	= options.modTimestamp || '';	//	blank = set @ persist
	this.viewCount		= options.viewCount || 0;
	this.meta			= options.meta || {};
	this.hashTags		= options.hashTags || [];

	var self			= this;

	this.isValid = function() {
		//	:TODO: validate as much as possible
		return true;
	};

	this.createMessageTimestamp = function() {
		return new Date().toISOString();
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

Message.WellKnownAreaIds = {
	Invalid	: 0,
	Private	: 1,
};

Message.MetaNames = {
	//
	//	FidoNet: http://ftsc.org/docs/fts-0001.016
	//
	FidoNetCost				: 'fidonet_cost',
	FidoNetOrigNode			: 'fidonet_orig_node',
	FidoNetDestNode			: 'fidonet_dest_node',
	FidoNetOrigNetwork		: 'fidonet_orig_network',
	FidoNetDestNetwork		: 'fidonet_dest_network',
	FidoNetOrigZone			: 'fidonet_orig_zone',
	FidoNetDestZone			: 'fidonet_dest_zone',
	FidoNetOrigPoint		: 'fidonet_orig_point',
	FidoNetDestPoint		: 'fidonet_dest_point',
	FidoNetAttribute		: 'fidonet_attribute',

	FidoNetProgramID		: 'fidonet_program_id',			//	"PID"					http://ftsc.org/docs/fsc-0046.005

	FidoNetMsgID			: 'fidonet_msg_id',				//	"MSGID"					http://ftsc.org/docs/fsc-0070.002

	FidoNetMessageID		: 'fidonet_message_id',			//	"MESSAGE-ID"			http://ftsc.org/docs/fsc-0030.001
	FidoNetInReplyTo		: 'fidonet_in_reply_to',		//	"IN-REPLY-TO"			http://ftsc.org/docs/fsc-0030.001

	FidoNetTearLineBanner	: 'fidonet_tear_line_banner',	//	FTN style tear line		http://ftsc.org/docs/fts-0004.001
	FidoNetOrigin			: 'fidonet_origin',				//	FTN style "* Origin..."	http://ftsc.org/docs/fts-0004.001
	FidoNetSeenBy			: 'fidonet_seen_by',			//	FTN style "SEEN-BY"		http://ftsc.org/docs/fts-0004.001
	FidoNetPath				: 'fidonet_path',				//	FTN style "PATH"		http://ftsc.org/docs/fts-0004.001

	LocalToUserID			: 'local_to_user_id',
	LocalFromUserID			: 'local_from_user_id',

	//	:TODO: Search further:
	//	https://www.npmjs.com/package/fidonet-jam

};

Message.prototype.setLocalToUserId = function(userId) {
	this.meta.LocalToUserID = userId;
};

Message.prototype.setLocalFromUserId = function(userId) {
	this.meta.LocalFromUserID = userId;
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
				var modTs = self.modTimestamp || self.createMessageTimestamp();

				msgDb.run(
					'INSERT INTO message (area_id, message_uuid, reply_to_message_id, to_user_name, from_user_name, subject, message, modified_timestamp) ' +
					'VALUES (?, ?, ?, ?, ?, ?, ?, ?);', [ self.areaId, self.uuid, self.replyToMsgId, self.toUserName, self.fromUserName, self.subject, self.message, modTs ],
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
						'INSERT INTO message_meta (message_id, meta_name, meta_value) ' + 
						'VALUES (?, ?, ?);');

					async.each(Object.keys(self.meta), function meta(metaName, next) {
						metaStmt.run(self.messageId, metaName, self.meta[metaName], function inserted(err) {
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