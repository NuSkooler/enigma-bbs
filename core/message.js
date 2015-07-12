/* jslint node: true */
'use strict';

var msgDb			= require('./database.js').dbs.message;

var uuid			= require('node-uuid');
var async			= require('async');
var _				= require('lodash');

function Message(options) {
	

	var self	= this;

	this.fromExisting = function(opts) {
		self.messageId		= opts.messageId;
		self.areaId			= opts.areaId;
		self.uuid			= opts.uuid;
		self.replyToMsgId	= opts.replyToMsgId;
		self.toUserName		= opts.toUserName;
		self.fromUserName	= opts.fromUserName;
		self.subject		= opts.subject;
		self.message		= opts.message;
		self.modTimestamp	= opts.modTimestamp;
	};

	this.isValid = function() {
		//	:TODO: validate as much as possible
		return true;
	};

	this.createMessageTimestamp = function() {
		return new Date().toISOString();
	};
}

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
					'INSERT INTO message (area_id, message_uuid, reply_to_message_id, to_user_name, from_user_name, subject, message, modified_timestamp) ' +
					'VALUES (?, ?, ?, ?, ?, ?, ?, ?);', [ self.areaId, self.uuid, self.replyToMsgId, self.toUserName, self.fromUserName, self.subject, self.message, self.createMessageTimestamp() ],
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
						metaStmt.run(self.messageId, metaName, self.meta[metaName], function insRan(err) {
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
		]
	);

};