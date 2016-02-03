/* jslint node: true */
'use strict';

//var MailPacket		= require('./mail_packet.js');
var ftn				= require('./ftn_util.js');
var Message			= require('./message.js');
var sauce			= require('./sauce.js');

var _				= require('lodash');
var assert			= require('assert');
var binary			= require('binary');
var fs				= require('fs');
var util			= require('util');
var async			= require('async');
var iconv			= require('iconv-lite');
var buffers			= require('buffers');
var moment			= require('moment');

/*
	:TODO: should probably be broken up
		FTNPacket
		FTNPacketImport: packet -> message(s)
		FTNPacketExport: message(s) -> packet
*/

/*
Reader: file to ftn data
Writer: ftn data to packet

Data to toMessage 
Data.fromMessage

FTNMessage.toMessage() => Message
FTNMessage.fromMessage() => Create from Message

* read: header -> simple {} obj, msg -> Message object
* read: read(..., iterator): iterator('header', ...), iterator('message', msg)
* write: provide information to go into header

* Logic of "Is this for us"/etc. elsewhere
*/

const FTN_PACKET_HEADER_SIZE	= 58;	//	fixed header size
const FTN_PACKET_HEADER_TYPE	= 2;
const FTN_PACKET_MESSAGE_TYPE	= 2;

//	EOF + SAUCE.id + SAUCE.version ('00')
const FTN_MESSAGE_SAUCE_HEADER = 
	new Buffer( [ 0x1a, 'S', 'A', 'U', 'C', 'E', '0', '0' ] );

const FTN_MESSAGE_KLUDGE_PREFIX	= '\x01';

function FTNPacket() {

	var self = this;

	this.parsePacketHeader = function(packetBuffer, cb) {
		assert(Buffer.isBuffer(packetBuffer));

		//
		//	See the following specs:
		//	http://ftsc.org/docs/fts-0001.016
		//	http://ftsc.org/docs/fsc-0048.002
		//	
		if(packetBuffer.length < FTN_PACKET_HEADER_SIZE) {
			cb(new Error('Buffer too small'));
			return;
		}

		binary.parse(packetBuffer)
			.word16lu('origNode')
			.word16lu('destNode')
			.word16lu('year')
			.word16lu('month')
			.word16lu('day')
			.word16lu('hour')
			.word16lu('minute')
			.word16lu('second')
			.word16lu('baud')
			.word16lu('packetType')
			.word16lu('origNet')
			.word16lu('destNet')
			.word8('prodCodeLo')
			.word8('revisionMajor')	//	aka serialNo
			.buffer('password', 8)	//	null padded C style string
			.word16lu('origZone')
			.word16lu('destZone')
			//	Additions in FSC-0048.002 follow...
			.word16lu('auxNet')
			.word16lu('capWordA')
			.word8('prodCodeHi')
			.word8('revisionMinor')
			.word16lu('capWordB')
			.word16lu('originZone2')
			.word16lu('destZone2')
			.word16lu('originPoint')
			.word16lu('destPoint')
			.word32lu('prodData')
			.tap(packetHeader => {
				//	Convert password from NULL padded array to string
				packetHeader.password = ftn.stringFromFTN(packetHeader.password);

				if(FTN_PACKET_HEADER_TYPE !== packetHeader.packetType) {
					cb(new Error('Unsupported header type: ' + packetHeader.packetType));
					return;
				}
				
				//
				//	Date/time components into something more reasonable
				//	Note: The names above match up with object members moment() allows
				//
				packetHeader.created = moment(packetHeader);

				cb(null, packetHeader);
			});
	};

	this.writePacketHeader = function(headerInfo, ws) {
		let buffer = new Buffer(FTN_PACKET_HEADER_SIZE);

		buffer.writeUInt16LE(headerInfo.origNode, 0);
		buffer.writeUInt16LE(headerInfo.destNode, 2);
		buffer.writeUInt16LE(headerInfo.created.year(), 4);
		buffer.writeUInt16LE(headerInfo.created.month(), 6);
		buffer.writeUInt16LE(headerInfo.created.date(), 8);
		buffer.writeUInt16LE(headerInfo.created.hour(), 10);
		buffer.writeUInt16LE(headerInfo.created.minute(), 12);
		buffer.writeUInt16LE(headerInfo.created.second(), 14);
		buffer.writeUInt16LE(headerInfo.baud, 16);
		buffer.writeUInt16LE(FTN_PACKET_HEADER_TYPE, 18);
		buffer.writeUInt16LE(headerInfo.origNet, 20);
		buffer.writeUInt16LE(headerInfo.destNet, 22);
		buffer.writeUInt8(headerInfo.prodCodeLo, 24);
		buffer.writeUInt8(headerInfo.revisionMajor, 25);
		
		const pass = ftn.stringToNullPaddedBuffer(headerInfo.password, 8);
		pass.copy(buffer, 26);
		
		buffer.writeUInt16LE(headerInfo.origZone, 34);
		buffer.writeUInt16LE(headerInfo.destZone, 36);
		
		//	FSC-0048.002 additions...
		buffer.writeUInt16LE(headerInfo.auxNet, 38);
		buffer.writeUInt16LE(headerInfo.capWordA, 40);
		buffer.writeUInt8(headerInfo.prodCodeHi, 42);
		buffer.writeUInt8(headerInfo.revisionMinor, 43);
		buffer.writeUInt16LE(headerInfo.capWordB, 44);
		buffer.writeUInt16LE(headerInfo.origZone2, 46);
		buffer.writeUInt16LE(headerInfo.destZone2, 48);
		buffer.writeUInt16LE(headerInfo.origPoint, 50);
		buffer.writeUInt16LE(headerInfo.destPoint, 52);
		buffer.writeUInt32LE(headerInfo.prodData, 54);
		
		ws.write(buffer);
	};

	this.processMessageBody = function(messageBodyBuffer, cb) {
		//
		//	From FTS-0001.16:
		//		"Message text is unbounded and null terminated (note exception below).
		//
		//		A 'hard' carriage return, 0DH,  marks the end of a paragraph, and must
		//		be preserved.
		//
		//		So   called  'soft'  carriage  returns,  8DH,  may  mark  a   previous
		//		processor's  automatic line wrap, and should be ignored.  Beware  that
		//		they may be followed by linefeeds, or may not.
		//
		//		All  linefeeds, 0AH, should be ignored.  Systems which display message
		//		text should wrap long lines to suit their application."
		//
		//	This can be a bit tricky:
		//	*	Decoding as CP437 converts 0x8d -> 0xec, so we'll need to correct for that
		//	*	Many kludge lines specify an encoding. If we find one of such lines, we'll
		//		likely need to re-decode as the specified encoding
		//	*	SAUCE is binary-ish data, so we need to inspect for it before any
		//		decoding occurs
		//	
		let messageBodyData = {
			message		: [],			
			kludgeLines	: {},	//	KLUDGE:[value1, value2, ...] map
			seenBy		: [],
		};

		function addKludgeLine(line) {
			const sepIndex 	= line.indexOf(':');
			const key		= line.substr(0, sepIndex).toUpperCase();
			const value		= line.substr(sepIndex + 1).trim();

			//
			//	Allow mapped value to be either a key:value if there is only
			//	one entry, or key:[value1, value2,...] if there are more
			//
			if(messageBodyData.kludgeLines[key]) {
				if(!_.isArray(messageBodyData.kludgeLines[key])) {
					messageBodyData.kludgeLines[key] = [ messageBodyData.kludgeLines[key] ];
				}
				messageBodyData.kludgeLines[key].push(value);
			} else {
				messageBodyData.kludgeLines[key] = value;
			}
		}

		async.series(
			[
				function extractSauce(callback) {
					//	:TODO: This is wrong: SAUCE may not have EOF marker for one, also if it's
					//	present, we need to extract it but keep the rest of hte message intact as it likely
					//	has SEEN-BY, PATH, and other kludge information *appended*
					const sauceHeaderPosition = messageBodyBuffer.indexOf(FTN_MESSAGE_SAUCE_HEADER);			
					if(sauceHeaderPosition > -1) {
						sauce.readSAUCE(messageBodyBuffer.slice(sauceHeaderPosition), (err, theSauce) => {
							if(!err) {
								//	we read some SAUCE - don't re-process that portion into the body
								messageBodyBuffer 		= messageBodyBuffer.slice(0, sauceHeaderPosition);
								messageBodyData.sauce	= theSauce;
							}
							callback(null);	//	failure to read SAUCE is OK
						});
					} else {
						callback(null);
					}
				},
				function extractMessageData(callback) {
					const messageLines = 
						iconv.decode(messageBodyBuffer, 'CP437').replace(/[\xec\n]/g, '').split(/\r/g);

					let preOrigin = true;

					messageLines.forEach(line => {
						if(0 === line.length) {
							messageBodyData.message.push('');
							return;
						}

						if(preOrigin) {
							if(line.startsWith('AREA:')) {
								messageBodyData.area = line.substring(line.indexOf(':') + 1).trim();
							} else if(line.startsWith('--- ')) {
								//	Tear Lines are tracked allowing for specialized display/etc.
								messageBodyData.tearLine = line;
							} else if(/[ ]{1,2}(\* )?Origin\: /.test(line)) {	//	To spec is "  * Origin: ..."
								messageBodyData.originLine = line;
								preOrigin = false;
							} else if(FTN_MESSAGE_KLUDGE_PREFIX === line.charAt(0)) {
								addKludgeLine(line.slice(1));
							} else {
								//	regular ol' message line
								messageBodyData.message.push(line);
							}
						} else {
							if(line.startsWith('SEEN-BY:')) {
								messageBodyData.seenBy.push(line.substring(line.indexOf(':') + 1).trim());
							} else if(FTN_MESSAGE_KLUDGE_PREFIX === line.charAt(0)) {
								addKludgeLine(line.slice(1));
							} 
						}
					});

					callback(null);
				}
			],
			function complete(err) {
				messageBodyData.message = messageBodyData.message.join('\n');
				cb(messageBodyData);
			}
		);
	};

	this.parsePacketMessages = function(messagesBuffer, iterator, cb) {
		const NULL_TERM_BUFFER = new Buffer( [ 0 ] );

		binary.stream(messagesBuffer).loop(function looper(end, vars) {
			//
			//	Some variable names used here match up directly with well known
			//	meta data names used with FTN messages.
			//
			this
				.word16lu('messageType')
				.word16lu('ftn_orig_node')
				.word16lu('ftn_dest_node')
				.word16lu('ftn_orig_network')
				.word16lu('ftn_dest_network')
				.word8('ftn_attr_flags1')
				.word8('ftn_attr_flags2')
				.word16lu('ftn_cost')
				.scan('modDateTime', NULL_TERM_BUFFER)	//	:TODO: 20 bytes max
				.scan('toUserName', NULL_TERM_BUFFER)	//	:TODO: 36 bytes max
				.scan('fromUserName', NULL_TERM_BUFFER)	//	:TODO: 36 bytes max
				.scan('subject', NULL_TERM_BUFFER)		//	:TODO: 72 bytes max
				.scan('message', NULL_TERM_BUFFER)
				.tap(function tapped(msgData) {
					if(!msgData.ftn_orig_node) {
						//	end marker -- no more messages
						end();
						cb(null);
						return;
					}

					if(FTN_PACKET_MESSAGE_TYPE != msgData.messageType) {
						end();
						cb(new Error('Unsupported message type: ' + msgData.messageType));
						return;
					}

					//
					//	Convert null terminated arrays to strings
					//
					let convMsgData = {};
					[ 'modDateTime', 'toUserName', 'fromUserName', 'subject' ].forEach(k => {
						convMsgData[k] = iconv.decode(msgData[k], 'CP437');
					});

					//
					//	The message body itself is a special beast as it may
					//	contain special origin lines, kludges, SAUCE in the case
					//	of ANSI files, etc.
					//
					let msg = new Message( {
						toUserName		: convMsgData.toUserName,
						fromUserName	: convMsgData.fromUserName,
						subject			: convMsgData.subject,
						modTimestamp	: ftn.getDateFromFtnDateTime(convMsgData.modDateTime),
					});
										
					msg.meta.FtnProperty = {};
					msg.meta.FtnProperty.ftn_orig_node		= msgData.ftn_orig_node;
					msg.meta.FtnProperty.ftn_dest_node		= msgData.ftn_dest_node;
					msg.meta.FtnProperty.ftn_orig_network 	= msgData.ftn_orig_network;
					msg.meta.FtnProperty.ftn_dest_network	= msgData.ftn_dest_network;
					msg.meta.FtnProperty.ftn_attr_flags1	= msgData.ftn_attr_flags1;
					msg.meta.FtnProperty.ftn_attr_flags2	= msgData.ftn_attr_flags2;
					msg.meta.FtnProperty.ftn_cost			= msgData.ftn_cost;

					self.processMessageBody(msgData.message, function processed(messageBodyData) {
						msg.message = messageBodyData.message;
						msg.meta.FtnKludge = messageBodyData.kludgeLines;
				
						if(messageBodyData.tearLine) {
							msg.meta.FtnProperty.ftn_tear_line = messageBodyData.tearLine;
						}
						if(messageBodyData.seenBy.length > 0) {
							msg.meta.FtnProperty.ftn_seen_by = messageBodyData.seenBy;
						}
						if(messageBodyData.area) {
							msg.meta.FtnProperty.ftn_area = messageBodyData.area;
						}
						if(messageBodyData.originLine) {
							msg.meta.FtnProperty.ftn_origin = messageBodyData.originLine;
						}

						iterator('message', msg);
					})					
				});
		});
	};

	this.writeMessage = function(message, ws) {
		let basicHeader = new Buffer(34);
		
		basicHeader.writeUInt16LE(FTN_PACKET_MESSAGE_TYPE, 0);
		basicHeader.writeUInt16LE(message.meta.FtnProperty.ftn_orig_node, 2);
		basicHeader.writeUInt16LE(message.meta.FtnProperty.ftn_dest_node, 4);
		basicHeader.writeUInt16LE(message.meta.FtnProperty.ftn_orig_network, 6);
		basicHeader.writeUInt16LE(message.meta.FtnProperty.ftn_dest_network, 8);
		basicHeader.writeUInt8(message.meta.FtnProperty.ftn_attr_flags1, 10);
		basicHeader.writeUInt8(message.meta.FtnProperty.ftn_attr_flags2, 11);
		basicHeader.writeUInt16LE(message.meta.FtnProperty.ftn_cost, 12);

		//
		//	From http://ftsc.org/docs/fts-0001.016:
		//	DateTime   = (* a character string 20 characters long *)
        //                             (* 01 Jan 86  02:34:56 *)
        //           DayOfMonth " " Month " " Year " "
        //           " " HH ":" MM ":" SS
        //           Null
        //
		//	DayOfMonth = "01" | "02" | "03" | ... | "31"   (* Fido 0 fills *)
		//	Month      = "Jan" | "Feb" | "Mar" | "Apr" | "May" | "Jun" |
		//	           "Jul" | "Aug" | "Sep" | "Oct" | "Nov" | "Dec"
		//	Year       = "01" | "02" | .. | "85" | "86" | ... | "99" | "00"
		//	HH         = "00" | .. | "23"
		//	MM         = "00" | .. | "59"
		//	SS         = "00" | .. | "59"
		const dateTimeBuffer = new Buffer(ftn.getDateTimeString(message.modTimestamp) + '\0');
		dateTimeBuffer.copy(basicHeader, 14);

		ws.write(basicHeader);

		//	toUserName & fromUserName: up to 36 bytes in length, NULL term'd
		//	:TODO: DRY...
		let encBuf = iconv.encode(message.toUserName + '\0', 'CP437').slice(0, 36);
		encBuf[encBuf.length - 1] = '\0';	//	ensure it's null term'd
		ws.write(encBuf);
		
		encBuf = iconv.encode(message.fromUserName + '\0', 'CP437').slice(0, 36);
		encBuf[encBuf.length - 1] = '\0';	//	ensure it's null term'd
		ws.write(encBuf);

		//	subject: up to 72 bytes in length, NULL term'd
		encBuf = iconv.encode(message.subject + '\0', 'CP437').slice(0, 72);
		encBuf[encBuf.length - 1] = '\0';	//	ensure it's null term'd
		ws.write(encBuf);

		//
		//	message: unbound length, NULL term'd
		//	
		//	We need to build in various special lines - kludges, area,
		//	seen-by, etc.
		//
		//	:TODO: Put this in it's own method
		let msgBody = '';

		function appendMeta(k, m) {
			if(m) {
				let a = m;
				if(!_.isArray(a)) {
					a = [ a ];
				}
				a.forEach(v => {
					msgBody += `${k}: ${v}\n`;
				});
			}
		}

		//	:TODO: is Area really any differnt (e.g. no space between AREA:the_area)
		if(message.meta.FtnProperty.ftn_area) {
			msgBody += `AREA:${message.meta.FtnProperty.ftn_area}\n`;
		}
		
		Object.keys(message.meta.FtnKludge).forEach(k => {
			if('PATH' !== k) {
				appendMeta(k, message.meta.FtnKludge[k]);
			}
		});

		msgBody += message.message;

		appendMeta('', message.meta.FtnProperty.ftn_tear_line);
		appendMeta('', message.meta.FtnProperty.ftn_origin);

		appendMeta('SEEN-BY', message.meta.FtnProperty.ftn_seen_by);
		appendMeta('PATH', message.meta.FtnKludge['PATH']);

		ws.write(iconv.encode(msgBody + '\0', 'CP437'));
	};

	this.parsePacketBuffer = function(packetBuffer, iterator, cb) {
		async.series(
			[
				function processHeader(callback) {
					self.parsePacketHeader(packetBuffer, (err, header) => {
						if(!err) {
							iterator('header', header);
						}
						callback(err);
					});
				},
				function processMessages(callback) {
					self.parsePacketMessages(
						packetBuffer.slice(FTN_PACKET_HEADER_SIZE),
						iterator,
						callback);
				}
			],
			cb
		);		
	};
}

FTNPacket.prototype.read = function(pathOrBuffer, iterator, cb) {
	var self = this;

	async.series(
		[
			function getBufferIfPath(callback) {
				if(_.isString(pathOrBuffer)) {
					fs.readFile(pathOrBuffer, (err, data) => {
						pathOrBuffer = data;
						callback(err);
					});
				} else {
					callback(null);
				}
			},
			function parseBuffer(callback) {
				self.parsePacketBuffer(pathOrBuffer, iterator, callback);
			}
		],
		cb	//	completion callback
	);
};

FTNPacket.prototype.write = function(path, headerInfo, messages, cb) {
	headerInfo.created 	= headerInfo.created || moment();
	headerInfo.baud		= headerInfo.baud || 0;
	//	:TODO: Other defaults?

	if(!_.isArray(messages)) {
		messages = [ messages ] ;
	}

	let ws = fs.createWriteStream(path);
	this.writePacketHeader(headerInfo, ws);

	messages.forEach(msg => {
		this.writeMessage(msg, ws);
	});
};



//
//	References
//	* http://ftsc.org/docs/fts-0001.016
//	* http://ftsc.org/docs/fsc-0048.002
//
//	Other implementations:
//	* https://github.com/M-griffin/PyPacketMail/blob/master/PyPacketMail.py
//
function FTNMailPacket(options) {

	//MailPacket.call(this, options);
	
	var self			= this;
	self.KLUDGE_PREFIX	= '\x01';

	this.getPacketHeaderAddress = function() {
		return {
			zone	: self.packetHeader.destZone,
			net		: self.packetHeader.destNet,
			node	: self.packetHeader.destNode,
			point	: self.packetHeader.destPoint,
		};
	};

	this.getNetworkNameForAddress = function(addr) {
		var nodeAddr;
		for(var network in self.nodeAddresses) {
			nodeAddr = self.nodeAddresses[network];
			if(nodeAddr.zone === addr.zone &&
				nodeAddr.net === addr.net &&
				nodeAddr.node === addr.node &&
				nodeAddr.point === addr.point)
			{
				return network;
			}
		}
	};

	this.parseFtnPacketHeader = function(packetBuffer, cb) {
		assert(Buffer.isBuffer(packetBuffer));

		if(packetBuffer.length < 58) {
			cb(new Error('Buffer too small'));
			return;		
		}

		binary.parse(packetBuffer)
			.word16lu('origNode')
			.word16lu('destNode')
			.word16lu('year')
			.word16lu('month')
			.word16lu('day')
			.word16lu('hour')
			.word16lu('minute')
			.word16lu('second')
			.word16lu('baud')
			.word16lu('packetType')
			.word16lu('origNet')
			.word16lu('destNet')
			.word8('prodCodeLo')
			.word8('revisionMajor')	//	aka serialNo
			.buffer('password', 8)	//	null terminated C style string
			.word16lu('origZone')
			.word16lu('destZone')
			//	Additions in FSC-0048.002 follow...
			.word16lu('auxNet')
			.word16lu('capWordA')
			.word8('prodCodeHi')
			.word8('revisionMinor')
			.word16lu('capWordB')
			.word16lu('originZone2')
			.word16lu('destZone2')
			.word16lu('originPoint')
			.word16lu('destPoint')
			.word32lu('prodData')
			.tap(function tapped(packetHeader) {
				packetHeader.password = ftn.stringFromFTN(packetHeader.password);

				//	:TODO: Don't hard code magic # here
				if(2 !== packetHeader.packetType) {
					console.log(packetHeader.packetType)
					cb(new Error('Packet is not Type-2'));
					return;
				}
				
				//	:TODO: convert date information -> .created
				
				packetHeader.created = moment(packetHeader);
				/*
					packetHeader.year, packetHeader.month, packetHeader.day, packetHeader.hour,
					packetHeader.minute, packetHeader.second);*/

				//	:TODO: validate & pass error if failure
				cb(null, packetHeader);
			});
	};
	
	this.getPacketHeaderBuffer = function(packetHeader, options) {
		options = options || {};
		
		if(options.created) {
			options.created = moment(options.created);	//	ensure we have a moment obj
		} else {
			options.created = moment();
		}
		
		let buffer = new Buffer(58);
		
		buffer.writeUInt16LE(packetHeader.origNode, 0);
		buffer.writeUInt16LE(packetHeader.destNode, 2);
		buffer.writeUInt16LE(options.created.year(), 4);
		buffer.writeUInt16LE(options.created.month(), 6);
		buffer.writeUInt16LE(options.created.date(), 8);
		buffer.writeUInt16LE(options.created.hour(), 10);
		buffer.writeUInt16LE(options.created.minute(), 12);
		buffer.writeUInt16LE(options.created.second(), 14);
		buffer.writeUInt16LE(0x0000, 16);
		buffer.writeUInt16LE(0x0002, 18);
		buffer.writeUInt16LE(packetHeader.origNet, 20);
		buffer.writeUInt16LE(packetHeader.destNet, 22);
		buffer.writeUInt8(packetHeader.prodCodeLo, 24);
		buffer.writeUInt8(packetHeader.revisionMajor, 25);
		
		const pass = ftn.stringToNullPaddedBuffer(packetHeader.password, 8);
		pass.copy(buffer, 26);
		
		buffer.writeUInt16LE(packetHeader.origZone, 34);
		buffer.writeUInt16LE(packetHeader.destZone, 36);
		
		//	FSC-0048.002 additions...
		buffer.writeUInt16LE(packetHeader.auxNet, 38);
		buffer.writeUInt16LE(packetHeader.capWordA, 40);
		buffer.writeUInt8(packetHeader.prodCodeHi, 42);
		buffer.writeUInt8(packetHeader.revisionMinor, 43);
		buffer.writeUInt16LE(packetHeader.capWordB, 44);
		buffer.writeUInt16LE(packetHeader.origZone2, 46);
		buffer.writeUInt16LE(packetHeader.destZone2, 48);
		buffer.writeUInt16LE(packetHeader.origPoint, 50);
		buffer.writeUInt16LE(packetHeader.destPoint, 52);
		buffer.writeUInt32LE(packetHeader.prodData, 54);
		
		return buffer;
	};

	self.setOrAppend = function(value, dst) {
		if(dst) {
			if(!_.isArray(dst)) {
				dst = [ dst ];
			}

			dst.push(value);
		} else {
			dst = value;
		}
	}


	self.getMessageMeta = function(msgBody, msgData) {
		var meta = {
			FtnKludge	: msgBody.kludgeLines,
			FtnProperty	: {},
		};

		if(msgBody.tearLine) {
			meta.FtnProperty.ftn_tear_line = msgBody.tearLine;
		}
		if(msgBody.seenBy.length > 0) {
			meta.FtnProperty.ftn_seen_by = msgBody.seenBy;
		}
		if(msgBody.area) {
			meta.FtnProperty.ftn_area = msgBody.area;
		}
		if(msgBody.originLine) {
			meta.FtnProperty.ftn_origin = msgBody.originLine;
		}
		
		meta.FtnProperty.ftn_orig_node		= msgData.origNode;
		meta.FtnProperty.ftn_dest_node		= msgData.destNode;
		meta.FtnProperty.ftn_orig_network	= msgData.origNet;
		meta.FtnProperty.ftn_dest_network	= msgData.destNet;
		meta.FtnProperty.ftn_attr_flags1	= msgData.attrFlags1;
		meta.FtnProperty.ftn_attr_flags2	= msgData.attrFlags2;
		meta.FtnProperty.ftn_cost			= msgData.cost;
		
		return meta;
	};

	this.parseFtnMessageBody = function(msgBodyBuffer, cb) {
		//
		//	From FTS-0001.16:
		//	"Message text is unbounded and null terminated (note exception below).
		//
		//	A 'hard' carriage return, 0DH,  marks the end of a paragraph, and must
		//	be preserved.
		//
		//	So   called  'soft'  carriage  returns,  8DH,  may  mark  a   previous
		//	processor's  automatic line wrap, and should be ignored.  Beware  that
		//	they may be followed by linefeeds, or may not.
		//
		//	All  linefeeds, 0AH, should be ignored.  Systems which display message
		//	text should wrap long lines to suit their application."
		//
		//	This is a bit tricky. Decoding the buffer to CP437 converts all 0x8d -> 0xec, so we'll
		//	have to replace those characters if the buffer is left as CP437. 
		//	After decoding, we'll need to peek at the buffer for the various kludge lines
		//	for charsets & possibly re-decode. Uggh!
		//

		//	:TODO: Use the proper encoding here. There appear to be multiple specs and/or
		//	stuff people do with this... some specs kludge lines, which is kinda durpy since
		//	to get to that point, one must read the file (and decode) to find said kludge...


		//var msgLines	= msgBodyBuffer.toString().split(/\r\n|[\n\v\f\r\x85\u2028\u2029]/g);

		//var msgLines = iconv.decode(msgBodyBuffer, 'CP437').replace(/\xec/g, '').split(/\r\n|[\r\n]/g);
		var msgLines = iconv.decode(msgBodyBuffer, 'CP437').replace(/[\xec\n]/g, '').split(/\r/g);

		var msgBody = {
			message		: [],
			kludgeLines	: {},	//	<KLUDGE> -> [ value1, value2, ... ]
			seenBy		: [],
		};

		var preOrigin	= true;

		function addKludgeLine(kl) {
			const kludgeParts = kl.split(':');
			kludgeParts[0]	= kludgeParts[0].toUpperCase();
			kludgeParts[1]	= kludgeParts[1].trim();

			self.setOrAppend(kludgeParts[1], msgBody.kludgeLines[kludgeParts[0]]);
		}

		var sauceBuffers;

		msgLines.forEach(function nextLine(line) {
			if(0 === line.length) {
				msgBody.message.push('');
				return;
			}

			if(preOrigin) {
				if(_.startsWith(line, 'AREA:')) {
					msgBody.area = line.substring(line.indexOf(':') + 1).trim();
				} else if(_.startsWith(line, '--- ')) {
					//	Tag lines are tracked allowing for specialized display/etc.
					msgBody.tearLine = line;
				} else if(/[ ]{1,2}(\* )?Origin\: /.test(line)) {	//	To spec is "  * Origin: ..."
					msgBody.originLine = line;
					preOrigin		= false;
				} else if(self.KLUDGE_PREFIX === line.charAt(0)) {
					addKludgeLine(line.slice(1));
				} else if(!sauceBuffers || _.startsWith(line, '\x1aSAUCE00')) {
					sauceBuffers = sauceBuffers || buffers();
					sauceBuffers.push(new Buffer(line));
				} else {
					msgBody.message.push(line);
				}
			} else {
				if(_.startsWith(line, 'SEEN-BY:')) {
					msgBody.seenBy.push(line.substring(line.indexOf(':') + 1).trim());
				} else if(self.KLUDGE_PREFIX === line.charAt(0)) {
					addKludgeLine(line.slice(1));
				} 
			}
		});

		if(sauceBuffers) {
			//	:TODO: parse sauce -> sauce buffer. This needs changes to this method to return message & optional sauce	
		}

		cb(null, msgBody);
	};

	this.extractMessages = function(buffer, iterator, cb) {
		assert(Buffer.isBuffer(buffer));
		assert(_.isFunction(iterator));

		const NULL_TERM_BUFFER = new Buffer( [ 0 ] );

		binary.stream(buffer).loop(function looper(end, vars) {
			this
				.word16lu('messageType')
				.word16lu('origNode')
				.word16lu('destNode')
				.word16lu('origNet')
				.word16lu('destNet')
				.word8('attrFlags1')
				.word8('attrFlags2')
				.word16lu('cost')
				.scan('modDateTime', NULL_TERM_BUFFER)
				.scan('toUserName', NULL_TERM_BUFFER)
				.scan('fromUserName', NULL_TERM_BUFFER)
				.scan('subject', NULL_TERM_BUFFER)
				.scan('message', NULL_TERM_BUFFER)
				.tap(function tapped(msgData) {
					if(!msgData.origNode) {
						end();
						cb(null);
						return;
					}

					//	buffer to string conversion
					[ 'modDateTime', 'toUserName', 'fromUserName', 'subject', ].forEach(function field(f) {
						msgData[f] = iconv.decode(msgData[f], 'CP437');
					});

					self.parseFtnMessageBody(msgData.message, function msgBodyParsed(err, msgBody) {
						//
						//	Now, create a Message object
						//
						var msg = new Message( {
							//	AREA FTN -> local conf/area occurs elsewhere
							toUserName			: msgData.toUserName,
							fromUserName		: msgData.fromUserName,
							subject				: msgData.subject,
							message				: msgBody.message.join('\n'),	//	:TODO: \r\n is better?
							modTimestamp		: ftn.getDateFromFtnDateTime(msgData.modDateTime),
							meta				: self.getMessageMeta(msgBody, msgData),
							
							
						});
						
						iterator(msg);
						//self.emit('message', msg);	//	:TODO: Placeholder
					});		
				});
		});
	};
	
	//this.getMessageHeaderBuffer = function(headerInfo)

	this.parseFtnMessages = function(buffer, cb) {
		var nullTermBuf		= new Buffer( [ 0 ] );
		var fidoMessages	= [];

		binary.stream(buffer).loop(function looper(end, vars) {
			this
				.word16lu('messageType')
				.word16lu('origNode')
				.word16lu('destNode')
				.word16lu('origNet')
				.word16lu('destNet')
				.word8('attrFlags1')
				.word8('attrFlags2')
				.word16lu('cost')
				.scan('modDateTime', nullTermBuf)
				.scan('toUserName', nullTermBuf)
				.scan('fromUserName', nullTermBuf)
				.scan('subject', nullTermBuf)
				.scan('message', nullTermBuf)
				.tap(function tapped(msgData) {
					if(!msgData.origNode) {
						end();
						cb(null, fidoMessages);
						return;
					}

					//	buffer to string conversion
					//	:TODO: What is the real encoding here?
					[ 'modDateTime', 'toUserName', 'fromUserName', 'subject', ].forEach(function field(f) {
						msgData[f] = msgData[f].toString();
					});

					self.parseFtnMessageBody(msgData.message, function msgBodyParsed(err, msgBody) {
						msgData.message = msgBody;
						fidoMessages.push(_.clone(msgData));
					});		
				});
		});	
	};

	this.extractMesssagesFromPacketBuffer = function(packetBuffer, iterator, cb) {
		assert(Buffer.isBuffer(packetBuffer));
		assert(_.isFunction(iterator));

		async.waterfall(
			[
				function parseHeader(callback) {
					self.parseFtnPacketHeader(packetBuffer, function headerParsed(err, packetHeader) {
						self.packetHeader = packetHeader;
						callback(err);
					});
				},
				function validateDesinationAddress(callback) {
					self.localNetworkName = self.getNetworkNameForAddress(self.getPacketHeaderAddress());
					self.localNetworkName = 'AllowAnyNetworkForDebugging';
					callback(self.localNetworkName ? null : new Error('Packet not addressed do this system'));
				},
				function extractEmbeddedMessages(callback) {
					//	note: packet header is 58 bytes in length
					self.extractMessages(
						packetBuffer.slice(58), iterator, function extracted(err) {
						callback(err);
					});
				}
			],
			function complete(err) {
				cb(err);
			}
		);
	};

	this.loadMessagesFromPacketBuffer = function(packetBuffer, cb) {
		async.waterfall(
			[
				function parseHeader(callback) {
					self.parseFtnPacketHeader(packetBuffer, function headerParsed(err, packetHeader) {
						self.packetHeader = packetHeader;
						callback(err);
					});
				},
				function validateDesinationAddress(callback) {
					self.localNetworkName = self.getNetworkNameForAddress(self.getPacketHeaderAddress());
					self.localNetworkName = 'AllowAnyNetworkForDebugging';
					callback(self.localNetworkName ? null : new Error('Packet not addressed do this system'));
				},
				function parseMessages(callback) {
					self.parseFtnMessages(packetBuffer.slice(58), function messagesParsed(err, fidoMessages) {
						callback(err, fidoMessages);
					});
				},
				function createMessageObjects(fidoMessages, callback) {
					fidoMessages.forEach(function msg(fmsg) {
						console.log(fmsg);
					});
				}
			],
			function complete(err) {
				cb(err);
			}
		);
	};
}

//require('util').inherits(FTNMailPacket, MailPacket);

FTNMailPacket.prototype.parse = function(path, cb) {
	var self = this;

	async.waterfall(
		[
			function readFromFile(callback) {
				fs.readFile(path, function packetData(err, data) {
					callback(err, data);
				});
			},
			function extractMessages(data, callback) {
				self.loadMessagesFromPacketBuffer(data, function extracted(err, messages) {
					callback(err, messages);
				});
			}
		],
		function complete(err, messages) {
			cb(err, messages);
		}
	);
};

FTNMailPacket.prototype.read = function(pathOrBuffer, iterator, cb) {
	var self = this;

	if(_.isString(pathOrBuffer)) {
		async.waterfall(
			[
				function readPacketFile(callback) {
					fs.readFile(pathOrBuffer, function packetData(err, data) {
						callback(err, data);
					});
				},
				function extractMessages(data, callback) {
					self.extractMesssagesFromPacketBuffer(data, iterator, callback);
				}
			],
			cb
		);		
	} else if(Buffer.isBuffer(pathOrBuffer)) {

	}
};

FTNMailPacket.prototype.write = function(messages, fileName, options) {
	if(!_.isArray(messages)) {
		messages = [ messages ];
	}
	
	
	
};

var ftnPacket = new FTNPacket();
var theHeader;
var written = false;
ftnPacket.read(
	process.argv[2],
	function iterator(dataType, data) {
		if('header' === dataType) {
			theHeader = data;
			console.log(theHeader);
		} else if('message' === dataType) {
			const msg = data;
			console.log(msg);

			if(!written) {
				written = true;

				let messages = [ msg ];
				ftnPacket.write('/home/nuskooler/Downloads/ftnout/test1.pkt', theHeader, messages, err => {

				});

			}
		}
	},
	function completion(err) {
		console.log(err);
	}
);

/*
var mailPacket = new FTNMailPacket(
	{
		nodeAddresses : {
			fidoNet : {
				zone	: 46,
				net		: 1,
				node	: 140,
				point 	: 0,
				domain	: ''
			}
		}
	}
);


var didWrite = false;
mailPacket.read(
	process.argv[2],
	//'/home/nuskooler/ownCloud/Projects/ENiGMA½ BBS/FTNPackets/mf/extracted/27000425.pkt',
	function packetIter(msg) {
		console.log(msg);
		if(_.has(msg, 'meta.FtnProperty.ftn_area')) {
			console.log('AREA: ' + msg.meta.FtnProperty.ftn_area);
		}
		
		if(!didWrite) {
			console.log(mailPacket.packetHeader);
			console.log('-----------');
			
			
			didWrite = true;
			
			let outTest = fs.createWriteStream('/home/nuskooler/Downloads/ftnout/test1.pkt');
			let buffer = mailPacket.getPacketHeaderBuffer(mailPacket.packetHeader);
			//mailPacket.write(buffer, msg.packetHeader);
			outTest.write(buffer);
		}
	},
	function complete(err) {
		console.log(err);
	}
);
*/
/*
	Area Map
	networkName: {
		area_tag: conf_name:area_tag_name
		...
	}
*/

/*
mailPacket.parse('/home/nuskooler/ownCloud/Projects/ENiGMA½ BBS/FTNPackets/BAD_BNDL.007', function parsed(err, messages) {
	console.log(err)
});
*/