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
	:TODO: things
	* Read/detect packet types: 2, 2.2, and 2+
	* Write packet types: 2, 2.2, and 2+
	* Test SAUCE ignore/extraction
	* FSP-1010 for netmail (see SBBS)


*/

const FTN_PACKET_HEADER_SIZE	= 58;	//	fixed header size
const FTN_PACKET_HEADER_TYPE	= 2;
const FTN_PACKET_MESSAGE_TYPE	= 2;
const FTN_PACKET_BAUD_TYPE_2_2	= 2;

//	SAUCE magic header + version ("00")
const FTN_MESSAGE_SAUCE_HEADER = new Buffer('SAUCE00');

const FTN_MESSAGE_KLUDGE_PREFIX	= '\x01';

//
//	Read/Write FTN packets with support for the following formats:
//
//	*	Type 1 FTS-0001	@ http://ftsc.org/docs/fts-0001.016 (Obsolete)
//	*	Type 2.2 FSC-0045	@ http://ftsc.org/docs/fsc-0045.001
//	*	Type 2+ FSC-0039 and FSC-0048 @ http://ftsc.org/docs/fsc-0039.004 
//		and http://ftsc.org/docs/fsc-0048.002
//	
//	Additional resources:
//	*	Writeup on differences between type 2, 2.2, and 2+:
//		http://walon.org/pub/fidonet/FTSC-nodelists-etc./pkt-types.txt
//
function FTNPacket() {

	var self = this;

	this.parsePacketHeader = function(packetBuffer, cb) {
		assert(Buffer.isBuffer(packetBuffer));

		if(packetBuffer.length < FTN_PACKET_HEADER_SIZE) {
			cb(new Error('Buffer too small'));
			return;
		}

		//
		//	Start out reading as if this is a FSC-0048 2+ packet
		//
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
			.word8('prodRevLo')	//	aka serialNo
			.buffer('password', 8)	//	null padded C style string
			.word16lu('origZone')
			.word16lu('destZone')
			//	Additions in FSC-0048.002 follow...
			.word16lu('auxNet')
			.word16lu('capWordA')
			.word8('prodCodeHi')
			.word8('prodRevHi')
			.word16lu('capWordB')
			.word16lu('origZone2')
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
				//	What kind of packet do we really have here?
				//
				if(FTN_PACKET_BAUD_TYPE_2_2 === packetHeader.baud) {
					packetHeader.packetVersion = '2.2';
				} else {
					//
					//	See heuristics described in FSC-0048, "Receiving Type-2+ bundles"
					//
					const capWordASwapped = 
						((packetHeader.capWordA & 0xff) << 8) |
						((packetHeader.capWordA >> 8) & 0xff);

					if(capWordASwapped === packetHeader.capWordB && 
						0 != packetHeader.capWordB &&
						packetHeader.capWordB & 0x0001)
					{
						packetHeader.packetVersion = '2+';
					} else {
						packetHeader.packetVersion = '2';
						packetHeader.point
					}
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
		buffer.writeUInt8(headerInfo.prodRevHi, 25);
		
		const pass = ftn.stringToNullPaddedBuffer(headerInfo.password, 8);
		pass.copy(buffer, 26);
		
		buffer.writeUInt16LE(headerInfo.origZone, 34);
		buffer.writeUInt16LE(headerInfo.destZone, 36);
		
		//	FSC-0048.002 additions...
		buffer.writeUInt16LE(headerInfo.auxNet, 38);
		buffer.writeUInt16LE(headerInfo.capWordA, 40);
		buffer.writeUInt8(headerInfo.prodCodeHi, 42);
		buffer.writeUInt8(headerInfo.prodRevLo, 43);
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
						sauce.readSAUCE(messageBodyBuffer.slice(sauceHeaderPosition, sauceHeaderPosition + sauce.SAUCE_SIZE), (err, theSauce) => {
							if(!err) {
								//	we read some SAUCE - don't re-process that portion into the body
								messageBodyBuffer		= messageBodyBuffer.slice(0, sauceHeaderPosition) + messageBodyBuffer.slice(sauceHeaderPosition + sauce.SAUCE_SIZE);
//								messageBodyBuffer 		= messageBodyBuffer.slice(0, sauceHeaderPosition);
								messageBodyData.sauce	= theSauce;
							} else {
								console.log(err)
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

						//
						//	Update message UUID, if possible, based on MSGID and AREA
						//
						if(_.isString(msg.meta.FtnKludge.MSGID) &&
							_.isString(msg.meta.FtnProperty.ftn_area) &&
							msg.meta.FtnKludge.MSGID.length > 0 &&
							msg.meta.FtnProperty.ftn_area.length > 0)
						{
							msg.uuid = ftn.createMessageUuid(
								msg.meta.FtnKludge.MSGID,
								msg.meta.FtnProperty.area);
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

		//
		//	FTN-0004.001 @ http://ftsc.org/docs/fts-0004.001
		//	AREA:CONFERENCE
		//	Should be first line in a message
		//
		if(message.meta.FtnProperty.ftn_area) {
			msgBody += `AREA:${message.meta.FtnProperty.ftn_area}\n`;
		}
		
		Object.keys(message.meta.FtnKludge).forEach(k => {
			//	we want PATH to be last
			if('PATH' !== k) {
				appendMeta(k, message.meta.FtnKludge[k]);
			}
		});

		msgBody += message.message;

		//
		//	FTN-0004.001 @ http://ftsc.org/docs/fts-0004.001
		//	Origin line should be near the bottom of a message
		//
		appendMeta('', message.meta.FtnProperty.ftn_tear_line);
		
		//
		//	Tear line should be near the bottom of a message
		//
		appendMeta('', message.meta.FtnProperty.ftn_origin);

		//
		//	FTN-0004.001 @ http://ftsc.org/docs/fts-0004.001
		//	SEEN-BY and PATH should be the last lines of a message
		//
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

			let address = {
				zone	: 46,
				net		: 1,
				node	: 232,
				domain	: 'l33t.codes',
			};
			msg.areaTag = 'agn_bbs';
			msg.messageId = 1234;
			console.log(ftn.getMessageIdentifier(msg, address));
			console.log(ftn.getProductIdentifier())
			//console.log(ftn.getOrigin(address))
			console.log(ftn.parseAddress('46:1/232.4@l33t.codes'))
			console.log(ftn.getUTCTimeZoneOffset())
		}
	},
	function completion(err) {
		console.log(err);
	}
);
