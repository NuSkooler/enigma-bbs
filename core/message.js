/* jslint node: true */
'use strict';

let msgDb			= require('./database.js').dbs.message;
let wordWrapText	= require('./word_wrap.js').wordWrapText;
let ftnUtil			= require('./ftn_util.js');
let createNamedUUID	= require('./uuid_util.js').createNamedUUID;

let uuid			= require('node-uuid');
let async			= require('async');
let _				= require('lodash');
let assert			= require('assert');
let moment			= require('moment');
const iconvEncode	= require('iconv-lite').encode;

module.exports = Message;

const ENIGMA_MESSAGE_UUID_NAMESPACE 	= uuid.parse('154506df-1df8-46b9-98f8-ebb5815baaf8');

function Message(options) {
	options = options || {};

	this.messageId		= options.messageId || 0;	//	always generated @ persist
	this.areaTag		= options.areaTag || Message.WellKnownAreaTags.Invalid;

	if(options.uuid) {
		//	note: new messages have UUID generated @ time of persist. See also Message.createMessageUUID()
		this.uuid = options.uuid;
	}

	this.replyToMsgId	= options.replyToMsgId || 0;
	this.toUserName		= options.toUserName || '';
	this.fromUserName	= options.fromUserName || '';
	this.subject		= options.subject || '';
	this.message		= options.message || '';
	
	if(_.isDate(options.modTimestamp) || moment.isMoment(options.modTimestamp)) {
		this.modTimestamp = moment(options.modTimestamp);
	} else if(_.isString(options.modTimestamp)) {
		this.modTimestamp = moment(options.modTimestamp);
	}

	this.viewCount		= options.viewCount || 0;

	this.meta			= {
		System	: {},	//	we'll always have this one
	};

	if(_.isObject(options.meta)) {
		_.defaultsDeep(this.meta, options.meta);
	}

	if(options.meta) {
		this.meta = options.meta;
	}

	this.hashTags		= options.hashTags || [];

	this.isValid = function() {
		//	:TODO: validate as much as possible
		return true;
	};

	this.isPrivate = function() {
		return Message.isPrivateAreaTag(this.areaTag);
	};

	this.getMessageTimestampString = function(ts) {
		ts = ts || moment();
		return ts.format('YYYY-MM-DDTHH:mm:ss.SSSZ');
	};
}

Message.WellKnownAreaTags = {
	Invalid		: '',
	Private		: 'private_mail',
	Bulletin	: 'local_bulletin',
};

Message.isPrivateAreaTag = function(areaTag) {
	return areaTag.toLowerCase() === Message.WellKnownAreaTags.Private;
};

Message.SystemMetaNames = {
	LocalToUserID			: 'local_to_user_id',
	LocalFromUserID			: 'local_from_user_id',
	StateFlags0				: 'state_flags0',		//	See Message.StateFlags0
};

Message.StateFlags0 = {
	None		: 0x00000000,
	Imported	: 0x00000001,	//	imported from foreign system
	Exported	: 0x00000002,	//	exported to foreign system
};

Message.FtnPropertyNames = {	
	FtnOrigNode			: 'ftn_orig_node',
	FtnDestNode			: 'ftn_dest_node',
	FtnOrigNetwork		: 'ftn_orig_network',
	FtnDestNetwork		: 'ftn_dest_network',
	FtnAttrFlags		: 'ftn_attr_flags',
	FtnCost				: 'ftn_cost',
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
	this.meta.System.local_to_user_id = userId;
};

Message.prototype.setLocalFromUserId = function(userId) {
	this.meta.System.local_from_user_id = userId;
};

Message.createMessageUUID = function(areaTag, modTimestamp, subject, body) {
	assert(_.isString(areaTag));
	assert(_.isDate(modTimestamp) || moment.isMoment(modTimestamp));
	assert(_.isString(subject));
	assert(_.isString(body));

	if(!moment.isMoment(modTimestamp)) {
		modTimestamp = moment(modTimestamp);
	}
		
	areaTag			= iconvEncode(areaTag.toUpperCase(), 'CP437');
	modTimestamp	= iconvEncode(modTimestamp.format('DD MMM YY  HH:mm:ss'), 'CP437');
	subject			= iconvEncode(subject.toUpperCase().trim(), 'CP437');
	body			= iconvEncode(body.replace(/\r\n|[\n\v\f\r\x85\u2028\u2029]/g, '').trim(), 'CP437');
	
	return uuid.unparse(createNamedUUID(ENIGMA_MESSAGE_UUID_NAMESPACE, Buffer.concat( [ areaTag, modTimestamp, subject, body ] )));
}

Message.getMessageIdByUuid = function(uuid, cb) {
	msgDb.get(
		`SELECT message_id
		FROM message
		WHERE message_uuid = ?
		LIMIT 1;`, 
		[ uuid ], 
		(err, row) => {
			if(err) {
				cb(err);
			} else {
				const success = (row && row.message_id);
				cb(success ? null : new Error('No match'), success ? row.message_id : null);
			}
		}
	);
};

Message.getMessageIdsByMetaValue = function(category, name, value, cb) {
	msgDb.all(
		`SELECT message_id
		FROM message_meta
		WHERE meta_category = ? AND meta_name = ? AND meta_value = ?;`,
		[ category, name, value ],
		(err, rows) => {
			if(err) {
				cb(err);
			} else {
				cb(null, rows.map(r => parseInt(r.message_id)));	//	return array of ID(s)
			}
		}
	);
};

Message.getMetaValuesByMessageId = function(messageId, category, name, cb) {
	const sql = 
		`SELECT meta_value
		FROM message_meta
		WHERE message_id = ? AND meta_category = ? AND meta_name = ?;`;
	
	msgDb.all(sql, [ messageId, category, name ], (err, rows) => {
		if(err) {
			return cb(err);
		}
		
		if(0 === rows.length) {
			return cb(new Error('No value for category/name'));
		}
		
		//	single values are returned without an array
		if(1 === rows.length) {
			return cb(null, rows[0].meta_value);
		}
		
		cb(null, rows.map(r => r.meta_value));	//	map to array of values only
	});
};

Message.getMetaValuesByMessageUuid = function(uuid, category, name, cb) {	
	async.waterfall(
		[
			function getMessageId(callback) {
				Message.getMessageIdByUuid(uuid, (err, messageId) => {
					callback(err, messageId);
				});
			},
			function getMetaValues(messageId, callback) {
				Message.getMetaValuesByMessageId(messageId, category, name, (err, values) => {
					callback(err, values);
				});
			}
		],
		(err, values) => {
			cb(err, values);
		}
	);
};

Message.prototype.loadMeta = function(cb) {
	/*
		Example of loaded this.meta:
		
		meta: {
			System: {
				local_to_user_id: 1234,				
			},
			FtnProperty: {
				ftn_seen_by: [ "1/102 103", "2/42 52 65" ]
			}
		}					
	*/	
	
	const sql = 
		`SELECT meta_category, meta_name, meta_value
		FROM message_meta
		WHERE message_id = ?;`;
		
	let self = this;
	msgDb.each(sql, [ this.messageId ], (err, row) => {
		if(!(row.meta_category in self.meta)) {
			self.meta[row.meta_category] = { };
			self.meta[row.meta_category][row.meta_name] = row.meta_value;
		} else {
			if(!(row.meta_name in self.meta[row.meta_category])) {
				self.meta[row.meta_category][row.meta_name] = row.meta_value; 
			} else {
				if(_.isString(self.meta[row.meta_category][row.meta_name])) {
					self.meta[row.meta_category][row.meta_name] = [ self.meta[row.meta_category][row.meta_name] ];					
				}
				
				self.meta[row.meta_category][row.meta_name].push(row.meta_value);
			}
		}
	}, err => {
		cb(err);
	});
};

Message.prototype.load = function(options, cb) {
	assert(_.isString(options.uuid));

	var self = this;

	async.series(
		[
			function loadMessage(callback) {
				msgDb.get(
					'SELECT message_id, area_tag, message_uuid, reply_to_message_id, to_user_name, from_user_name, subject, '	+
					'message, modified_timestamp, view_count '																	+
					'FROM message '																								+
					'WHERE message_uuid=? '																						+
					'LIMIT 1;',
					[ options.uuid ],
					(err, msgRow) => {
						if(err) {
							return callback(err);
						}
						if(!msgRow) {
							return callback(new Error('Message (no longer) available'));
						}
						
						self.messageId		= msgRow.message_id;
						self.areaTag		= msgRow.area_tag;
						self.messageUuid	= msgRow.message_uuid;
						self.replyToMsgId	= msgRow.reply_to_message_id;
						self.toUserName		= msgRow.to_user_name;
						self.fromUserName	= msgRow.from_user_name;
						self.subject		= msgRow.subject;
						self.message		= msgRow.message;
						self.modTimestamp	= moment(msgRow.modified_timestamp);
						self.viewCount		= msgRow.view_count;

						callback(err);
					}
				);
			},
			function loadMessageMeta(callback) {
				self.loadMeta(err => {
					callback(err);
				});
			},
			function loadHashTags(callback) {
				//	:TODO:
				callback(null);
			}
		],
		function complete(err) {
			cb(err);
		}
	);
};

Message.prototype.persistMetaValue = function(category, name, value, cb) {
	const metaStmt = msgDb.prepare(
		`INSERT INTO message_meta (message_id, meta_category, meta_name, meta_value) 
		VALUES (?, ?, ?, ?);`);
		
	if(!_.isArray(value)) {
		value = [ value ];
	}
	
	let self = this;
	
	async.each(value, (v, next) => {
		metaStmt.run(self.messageId, category, name, v, err => {
			next(err);
		});
	}, err => {
		cb(err);
	});
};

Message.startTransaction = function(cb) {
	msgDb.run('BEGIN;', err => {
		cb(err);
	});
};

Message.endTransaction = function(hadError, cb) {
	msgDb.run(hadError ? 'ROLLBACK;' : 'COMMIT;', err => {
		cb(err);
	});	
};

Message.prototype.persist = function(cb) {

	if(!this.isValid()) {
		return cb(new Error('Cannot persist invalid message!'));
	}

	const self = this;
	
	async.series(
		[
			function beginTransaction(callback) {
				Message.startTransaction(err => {
					return callback(err);
				});
			},
			function storeMessage(callback) {
				//	generate a UUID for this message if required (general case)
				const msgTimestamp = moment();
				if(!self.uuid) {
					self.uuid = Message.createMessageUUID(
						self.areaTag,
						msgTimestamp,
						self.subject,
						self.message);
				}

				msgDb.run(
					`INSERT INTO message (area_tag, message_uuid, reply_to_message_id, to_user_name, from_user_name, subject, message, modified_timestamp)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?);`, 
					[ self.areaTag, self.uuid, self.replyToMsgId, self.toUserName, self.fromUserName, self.subject, self.message, self.getMessageTimestampString(msgTimestamp) ],
					function inserted(err) {	//	use non-arrow function for 'this' scope
						if(!err) {
							self.messageId = this.lastID;
						}

						return callback(err);
					}
				);
			},
			function storeMeta(callback) {
				if(!self.meta) {
					return callback(null);
				}
				/*
					Example of self.meta:
					
					meta: {
						System: {
							local_to_user_id: 1234,				
						},
						FtnProperty: {
							ftn_seen_by: [ "1/102 103", "2/42 52 65" ]
						}
					}					
				*/
				async.each(Object.keys(self.meta), (category, nextCat) => {
					async.each(Object.keys(self.meta[category]), (name, nextName) => {
						self.persistMetaValue(category, name, self.meta[category][name], err => {
							nextName(err);
						});
					}, err => {
						nextCat(err);
					});
						
				}, err => {
					callback(err);
				});					
			},
			function storeHashTags(callback) {
				//	:TODO: hash tag support
				return callback(null);
			}
		],
		err => {
			Message.endTransaction(err, transErr => {
				return cb(err ? err : transErr, self.messageId);
			});
		}
	);
};

Message.prototype.getFTNQuotePrefix = function(source) {
	source = source || 'fromUserName';

	return ftnUtil.getQuotePrefix(this[source]);
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
		.trim()
		.replace(/\b/g, '')
		.split(/\r\n|[\n\v\f\r\x85\u2028\u2029]/g);	
	
	var quotePrefix = '';	//	we need this init even if blank
	if(options.includePrefix) {
		quotePrefix = this.getFTNQuotePrefix(options.prefixSource || 'fromUserName');
	}

	var wrapOpts = {
		width		: width - quotePrefix.length,
		tabHandling	: 'expand',
		tabWidth	: 4,
	};

	function addPrefix(l) {
		return quotePrefix + l;
	}

	var wrapped;
	for(var i = 0; i < origLines.length; ++i) {
		wrapped = wordWrapText(origLines[i], wrapOpts).wrapped;
		Array.prototype.push.apply(quoteLines, _.map(wrapped, addPrefix));
	}

	return quoteLines;
};
