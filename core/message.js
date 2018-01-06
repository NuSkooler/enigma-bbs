/* jslint node: true */
'use strict';

const msgDb					= require('./database.js').dbs.message;
const wordWrapText			= require('./word_wrap.js').wordWrapText;
const ftnUtil				= require('./ftn_util.js');
const createNamedUUID		= require('./uuid_util.js').createNamedUUID;
const getISOTimestampString	= require('./database.js').getISOTimestampString;
const Errors				= require('./enig_error.js').Errors;
const ANSI					= require('./ansi_term.js');

const { 
	isAnsi, isFormattedLine,
	splitTextAtTerms, 
	renderSubstr
}							= require('./string_util.js');

const ansiPrep				= require('./ansi_prep.js');

//	deps
const uuidParse				= require('uuid-parse');
const async					= require('async');
const _						= require('lodash');
const assert				= require('assert');
const moment				= require('moment');
const iconvEncode			= require('iconv-lite').encode;

module.exports = Message;

const ENIGMA_MESSAGE_UUID_NAMESPACE 	= uuidParse.parse('154506df-1df8-46b9-98f8-ebb5815baaf8');

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
	ExplicitEncoding		: 'explicit_encoding',	//	Explicitly set encoding when exporting/etc.
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
	this.meta.System = this.meta.System || {};
	this.meta.System[Message.SystemMetaNames.LocalToUserID] = userId;
};

Message.prototype.setLocalFromUserId = function(userId) {
	this.meta.System = this.meta.System || {};
	this.meta.System[Message.SystemMetaNames.LocalFromUserID] = userId;
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
	
	return uuidParse.unparse(createNamedUUID(ENIGMA_MESSAGE_UUID_NAMESPACE, Buffer.concat( [ areaTag, modTimestamp, subject, body ] )));
};

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

Message.prototype.persistMetaValue = function(category, name, value, transOrDb, cb) {
	if(!_.isFunction(cb) && _.isFunction(transOrDb)) {
		cb = transOrDb;
		transOrDb = msgDb;
	}

	const metaStmt = transOrDb.prepare(
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

Message.prototype.persist = function(cb) {

	if(!this.isValid()) {
		return cb(new Error('Cannot persist invalid message!'));
	}

	const self = this;
	
	async.waterfall(
		[
			function beginTransaction(callback) {
				return msgDb.beginTransaction(callback);
			},
			function storeMessage(trans, callback) {
				//	generate a UUID for this message if required (general case)
				const msgTimestamp = moment();
				if(!self.uuid) {
					self.uuid = Message.createMessageUUID(
						self.areaTag,
						msgTimestamp,
						self.subject,
						self.message);
				}

				trans.run(
					`INSERT INTO message (area_tag, message_uuid, reply_to_message_id, to_user_name, from_user_name, subject, message, modified_timestamp)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?);`, 
					[ self.areaTag, self.uuid, self.replyToMsgId, self.toUserName, self.fromUserName, self.subject, self.message, getISOTimestampString(msgTimestamp) ],
					function inserted(err) {	//	use non-arrow function for 'this' scope
						if(!err) {
							self.messageId = this.lastID;
						}

						return callback(err, trans);
					}
				);
			},
			function storeMeta(trans, callback) {
				if(!self.meta) {
					return callback(null, trans);
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
						self.persistMetaValue(category, name, self.meta[category][name], trans, err => {
							nextName(err);
						});
					}, err => {
						nextCat(err);
					});
						
				}, err => {
					callback(err, trans);
				});					
			},
			function storeHashTags(trans, callback) {
				//	:TODO: hash tag support
				return callback(null, trans);
			}
		],
		(err, trans) => {
			if(trans) {
				trans[err ? 'rollback' : 'commit'](transErr => {
					return cb(err ? err : transErr, self.messageId);
				});
			} else {
				return cb(err);
			}
		}
	);
};

Message.prototype.getFTNQuotePrefix = function(source) {
	source = source || 'fromUserName';

	return ftnUtil.getQuotePrefix(this[source]);
};

Message.prototype.getTearLinePosition = function(input) {
	const m = input.match(/^--- .+$(?![\s\S]*^--- .+$)/m);
	return m ? m.index : -1;
};

Message.prototype.getQuoteLines = function(options, cb) {
	if(!options.termWidth || !options.termHeight || !options.cols) {
		return cb(Errors.MissingParam());
	}
	
	options.startCol			= options.startCol || 1;
	options.includePrefix 		= _.get(options, 'includePrefix', true);
	options.ansiResetSgr		= options.ansiResetSgr || ANSI.getSGRFromGraphicRendition( { fg : 39, bg : 49 }, true);
	options.ansiFocusPrefixSgr	= options.ansiFocusPrefixSgr || ANSI.getSGRFromGraphicRendition( { intensity : 'bold', fg : 39, bg : 49 } );
	options.isAnsi				= options.isAnsi || isAnsi(this.message);	//	:TODO: If this.isAnsi, use that setting
	
	/*
		Some long text that needs to be wrapped and quoted should look right after
		doing so, don't ya think? yeah I think so		

		Nu> Some long text that needs to be wrapped and quoted should look right 
		Nu> after doing so, don't ya think? yeah I think so

		Ot> Nu> Some long text that needs to be wrapped and quoted should look 
		Ot> Nu> right after doing so, don't ya think? yeah I think so

	*/
	const quotePrefix = options.includePrefix ? this.getFTNQuotePrefix(options.prefixSource || 'fromUserName') : '';

	function getWrapped(text, extraPrefix) {
		extraPrefix = extraPrefix ? ` ${extraPrefix}` : '';

		const wrapOpts = {
			width		: options.cols - (quotePrefix.length + extraPrefix.length),
			tabHandling	: 'expand',
			tabWidth	: 4,
		};
		
		return wordWrapText(text, wrapOpts).wrapped.map( (w, i) => {
			return i === 0 ? `${quotePrefix}${w}` : `${quotePrefix}${extraPrefix}${w}`;
		});
	}

	function getFormattedLine(line) {
		//	for pre-formatted text, we just append a line truncated to fit
		let newLen;
		const total = line.length + quotePrefix.length;

		if(total > options.cols) {
			newLen = options.cols - total;
		} else {
			newLen = total;
		}

		return `${quotePrefix}${line.slice(0, newLen)}`;
	}

	if(options.isAnsi) {
		ansiPrep(
			this.message.replace(/\r?\n/g, '\r\n'),	//	normalized LF -> CRLF
			{
				termWidth		: options.termWidth,
				termHeight		: options.termHeight,
				cols			: options.cols,
				rows			: 'auto',
				startCol		: options.startCol,
				forceLineTerm	: true,				
			},
			(err, prepped) => {
				prepped = prepped || this.message;
				
				let lastSgr = '';
				const split = splitTextAtTerms(prepped);
				
				const quoteLines		= [];
				const focusQuoteLines	= [];

				//
				//	Do not include quote prefixes (e.g. XX> ) on ANSI replies (and therefor quote builder)
				//	as while this works in ENiGMA, other boards such as Mystic, WWIV, etc. will try to 
				//	strip colors, colorize the lines, etc. If we exclude the prefixes, this seems to do
				//	the trick and allow them to leave them alone!
				//
				split.forEach(l => {
					quoteLines.push(`${lastSgr}${l}`);
					
					focusQuoteLines.push(`${options.ansiFocusPrefixSgr}>${lastSgr}${renderSubstr(l, 1, l.length - 1)}`);
					lastSgr = (l.match(/(?:\x1b\x5b)[\?=;0-9]*m(?!.*(?:\x1b\x5b)[\?=;0-9]*m)/) || [])[0] || '';	//	eslint-disable-line no-control-regex
				});

				quoteLines[quoteLines.length - 1] += options.ansiResetSgr;
				
				return cb(null, quoteLines, focusQuoteLines, true);
			}
		);
	} else {
		const QUOTE_RE	= /^ ((?:[A-Za-z0-9]{2}\> )+(?:[A-Za-z0-9]{2}\>)*) */;
		const quoted	= [];
		const input		= _.trimEnd(this.message).replace(/\b/g, '');
	
		//	find *last* tearline
		let tearLinePos = this.getTearLinePosition(input);
		tearLinePos = -1 === tearLinePos ? input.length : tearLinePos;	//	we just want the index or the entire string
		
		input.slice(0, tearLinePos).split(/\r\n\r\n|\n\n/).forEach(paragraph => {
			//
			//	For each paragraph, a state machine:
			//	- New line - line
			//	- New (pre)quoted line - quote_line
			//	- Continuation of new/quoted line
			//
			//	Also:
			//	- Detect pre-formatted lines & try to keep them as-is
			//
			let state;
			let buf = '';
			let quoteMatch;

			if(quoted.length > 0) {
				//
				//	Preserve paragraph seperation.
				//
				//	FSC-0032 states something about leaving blank lines fully blank
				//	(without a prefix) but it seems nicer (and more consistent with other systems)
				//	to put 'em in.
				//
				quoted.push(quotePrefix);
			}

			paragraph.split(/\r?\n/).forEach(line => {
				if(0 === line.trim().length) {
					//	see blank line notes above
					return quoted.push(quotePrefix);
				}

				quoteMatch = line.match(QUOTE_RE);

				switch(state) {
					case 'line' :
						if(quoteMatch) {
							if(isFormattedLine(line)) {
								quoted.push(getFormattedLine(line.replace(/\s/, '')));
							} else {
								quoted.push(...getWrapped(buf, quoteMatch[1]));
								state = 'quote_line';
								buf = line;
							}
						} else {
							buf += ` ${line}`;
						}
						break;
						
					case 'quote_line' :
						if(quoteMatch) {
							const rem = line.slice(quoteMatch[0].length);
							if(!buf.startsWith(quoteMatch[0])) {
								quoted.push(...getWrapped(buf, quoteMatch[1]));
								buf = rem;
							} else {
								buf += ` ${rem}`;
							}
						} else {
							quoted.push(...getWrapped(buf));
							buf = line;
							state = 'line';
						}
						break;
							
					default :
						if(isFormattedLine(line)) {
							quoted.push(getFormattedLine(line));
						} else {
							state	= quoteMatch ? 'quote_line' : 'line';
							buf		= 'line' === state ? line : line.replace(/\s/, '');	//	trim *first* leading space, if any
						}
						break;
				}		
			});
			
			quoted.push(...getWrapped(buf, quoteMatch ? quoteMatch[1] : null));
		});
		
		input.slice(tearLinePos).split(/\r?\n/).forEach(l => {
			quoted.push(...getWrapped(l));
		});

		return cb(null, quoted, null, false);
	}
};
