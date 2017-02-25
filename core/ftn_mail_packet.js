/* jslint node: true */
'use strict';

const ftn			= require('./ftn_util.js');
const Message		= require('./message.js');
const sauce			= require('./sauce.js');
const Address		= require('./ftn_address.js');
const strUtil		= require('./string_util.js');
const Log			= require('./logger.js').log;

const _				= require('lodash');
const assert		= require('assert');
const binary		= require('binary');
const fs			= require('fs');
const async			= require('async');
const iconv			= require('iconv-lite');
const moment		= require('moment');

exports.Packet			= Packet;

/*
	:TODO: things
	* Test SAUCE ignore/extraction
	* FSP-1010 for netmail (see SBBS)
	* Syncronet apparently uses odd origin lines
	* Origin lines starting with "#" instead of "*" ?

*/

const FTN_PACKET_HEADER_SIZE	= 58;	//	fixed header size
const FTN_PACKET_HEADER_TYPE	= 2;
const FTN_PACKET_MESSAGE_TYPE	= 2;
const FTN_PACKET_BAUD_TYPE_2_2	= 2;
const NULL_TERM_BUFFER			= new Buffer( [ 0x00 ] );

//	SAUCE magic header + version ("00")
const FTN_MESSAGE_SAUCE_HEADER = new Buffer('SAUCE00');

const FTN_MESSAGE_KLUDGE_PREFIX	= '\x01';

class PacketHeader {
	constructor(origAddr, destAddr, version, createdMoment) {
		const EMPTY_ADDRESS = {
			node	: 0,
			net		: 0,
			zone	: 0,
			point	: 0,
		};

		this.packetVersion = version || '2+';

		this.origAddress 	= origAddr || EMPTY_ADDRESS;
		this.destAddress 	= destAddr || EMPTY_ADDRESS;
		this.created		= createdMoment || moment();

		//	uncommon to set the following explicitly
		this.prodCodeLo			= 0xfe;	//	http://ftsc.org/docs/fta-1005.003
		this.prodRevLo			= 0;
		this.baud				= 0;
		this.packetType			= FTN_PACKET_HEADER_TYPE;
		this.password			= '';
		this.prodData 			= 0x47694e45;	//	"ENiG"

		this.capWord			= 0x0001;
		this.capWordValidate	= ((this.capWord & 0xff) << 8) | ((this.capWord >> 8) & 0xff);
		
		this.prodCodeHi			= 0xfe;	//	see above
		this.prodRevHi			= 0;		
	}

	get origAddress() {
		let addr = new Address({
			node	: this.origNode,
			zone	: this.origZone,
		});

		if(this.origPoint) {
			addr.point	= this.origPoint;
			addr.net	= this.auxNet;
		} else {
			addr.net	= this.origNet;
		}

		return addr;
	}

	set origAddress(address) {
		if(_.isString(address)) {
			address = Address.fromString(address);
		}

		this.origNode = address.node;

		//	See FSC-48
		if(address.point) {
			this.auxNet		= address.origNet;
			this.origNet	= -1;
			
		} else {
			this.origNet	= address.net;
			this.auxNet		= 0;
		}

		this.origZone	= address.zone;
		this.origZone2	= address.zone;
		this.origPoint	= address.point || 0;
	}

	get destAddress() {
		let addr = new Address({
			node	: this.destNode,
			net		: this.destNet,
			zone	: this.destZone,
		});

		if(this.destPoint) {
			addr.point = this.destPoint;
		}

		return addr;
	}

	set destAddress(address) {
		if(_.isString(address)) {
			address = Address.fromString(address);
		}

		this.destNode	= address.node;
		this.destNet	= address.net;
		this.destZone	= address.zone;
		this.destZone2	= address.zone;
		this.destPoint	= address.point || 0;
	}

	get created() {
		return moment({
			year 	: this.year,
			month	: this.month - 1,	//	moment uses 0 indexed months
			date	: this.day,
			hour	: this.hour,
			minute	: this.minute,
			second	: this.second
		});
	}

	set created(momentCreated) {
		if(!moment.isMoment(momentCreated)) {
			momentCreated = moment(momentCreated);
		}

		this.year	= momentCreated.year();
		this.month	= momentCreated.month() + 1;	//	moment uses 0 indexed months
		this.day	= momentCreated.date();			//	day of month
		this.hour	= momentCreated.hour();
		this.minute	= momentCreated.minute();
		this.second	= momentCreated.second();
	}
}

exports.PacketHeader = PacketHeader;

//
//	Read/Write FTN packets with support for the following formats:
//
//	*	Type 2 FTS-0001	@ http://ftsc.org/docs/fts-0001.016 (Obsolete)
//	*	Type 2.2 FSC-0045	@ http://ftsc.org/docs/fsc-0045.001
//	*	Type 2+ FSC-0039 and FSC-0048 @ http://ftsc.org/docs/fsc-0039.004 
//		and http://ftsc.org/docs/fsc-0048.002
//	
//	Additional resources:
//	*	Writeup on differences between type 2, 2.2, and 2+:
//		http://walon.org/pub/fidonet/FTSC-nodelists-etc./pkt-types.txt
//
function Packet(options) {
	var self = this;
    
	this.options = options || {};

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
			//
			//	The following is "filler" in FTS-0001, specifics in
			//	FSC-0045 and FSC-0048
			//
			.word16lu('auxNet')
			.word16lu('capWordValidate')
			.word8('prodCodeHi')
			.word8('prodRevHi')
			.word16lu('capWord')
			.word16lu('origZone2')
			.word16lu('destZone2')
			.word16lu('origPoint')
			.word16lu('destPoint')
			.word32lu('prodData')
			.tap(packetHeader => {
				//	Convert password from NULL padded array to string
				//packetHeader.password = ftn.stringFromFTN(packetHeader.password);
				packetHeader.password = strUtil.stringFromNullTermBuffer(packetHeader.password, 'CP437');

				if(FTN_PACKET_HEADER_TYPE !== packetHeader.packetType) {
					cb(new Error('Unsupported header type: ' + packetHeader.packetType));
					return;
				}

				//
				//	What kind of packet do we really have here?
				//
				//	:TODO: adjust values based on version discovered
				if(FTN_PACKET_BAUD_TYPE_2_2 === packetHeader.baud) {
					packetHeader.packetVersion = '2.2';

					//	See FSC-0045
					packetHeader.origPoint	= packetHeader.year;
					packetHeader.destPoint	= packetHeader.month;

					packetHeader.destDomain = packetHeader.origZone2;
					packetHeader.origDomain	= packetHeader.auxNet;
				} else {
					//
					//	See heuristics described in FSC-0048, "Receiving Type-2+ bundles"
					//
					const capWordValidateSwapped = 
						((packetHeader.capWordValidate & 0xff) << 8) |
						((packetHeader.capWordValidate >> 8) & 0xff);

					if(capWordValidateSwapped === packetHeader.capWord && 
						0 != packetHeader.capWord &&
						packetHeader.capWord & 0x0001)
					{
						packetHeader.packetVersion = '2+';

						//	See FSC-0048
						if(-1 === packetHeader.origNet) {
							packetHeader.origNet = packetHeader.auxNet;
						}
					} else {
						packetHeader.packetVersion = '2';

						//	:TODO: should fill bytes be 0?
					}
				}
						
				packetHeader.created = moment({
					year 	: packetHeader.year,
					month	: packetHeader.month - 1,	//	moment uses 0 indexed months
					date	: packetHeader.day,
					hour	: packetHeader.hour,
					minute	: packetHeader.minute,
					second	: packetHeader.second
				});
				
				let ph = new PacketHeader();
				_.assign(ph, packetHeader);

				cb(null, ph);
			});
	};
	
	this.getPacketHeaderBuffer = function(packetHeader) {
		let buffer = new Buffer(FTN_PACKET_HEADER_SIZE);

		buffer.writeUInt16LE(packetHeader.origNode, 0);
		buffer.writeUInt16LE(packetHeader.destNode, 2);
		buffer.writeUInt16LE(packetHeader.year, 4);
		buffer.writeUInt16LE(packetHeader.month, 6);	
		buffer.writeUInt16LE(packetHeader.day, 8);
		buffer.writeUInt16LE(packetHeader.hour, 10);
		buffer.writeUInt16LE(packetHeader.minute, 12);
		buffer.writeUInt16LE(packetHeader.second, 14);
		
		buffer.writeUInt16LE(packetHeader.baud, 16);
		buffer.writeUInt16LE(FTN_PACKET_HEADER_TYPE, 18);
		buffer.writeUInt16LE(-1 === packetHeader.origNet ? 0xffff : packetHeader.origNet, 20);
		buffer.writeUInt16LE(packetHeader.destNet, 22);
		buffer.writeUInt8(packetHeader.prodCodeLo, 24);
		buffer.writeUInt8(packetHeader.prodRevHi, 25);
		
		const pass = ftn.stringToNullPaddedBuffer(packetHeader.password, 8);
		pass.copy(buffer, 26);
		
		buffer.writeUInt16LE(packetHeader.origZone, 34);
		buffer.writeUInt16LE(packetHeader.destZone, 36);
		buffer.writeUInt16LE(packetHeader.auxNet, 38);
		buffer.writeUInt16LE(packetHeader.capWordValidate, 40);
		buffer.writeUInt8(packetHeader.prodCodeHi, 42);
		buffer.writeUInt8(packetHeader.prodRevLo, 43);
		buffer.writeUInt16LE(packetHeader.capWord, 44);
		buffer.writeUInt16LE(packetHeader.origZone2, 46);
		buffer.writeUInt16LE(packetHeader.destZone2, 48);
		buffer.writeUInt16LE(packetHeader.origPoint, 50);
		buffer.writeUInt16LE(packetHeader.destPoint, 52);
		buffer.writeUInt32LE(packetHeader.prodData, 54);
		
		return buffer;
	};

	this.writePacketHeader = function(packetHeader, ws) {
		let buffer = new Buffer(FTN_PACKET_HEADER_SIZE);

		buffer.writeUInt16LE(packetHeader.origNode, 0);
		buffer.writeUInt16LE(packetHeader.destNode, 2);
		buffer.writeUInt16LE(packetHeader.year, 4);
		buffer.writeUInt16LE(packetHeader.month, 6);	
		buffer.writeUInt16LE(packetHeader.day, 8);
		buffer.writeUInt16LE(packetHeader.hour, 10);
		buffer.writeUInt16LE(packetHeader.minute, 12);
		buffer.writeUInt16LE(packetHeader.second, 14);
		
		buffer.writeUInt16LE(packetHeader.baud, 16);
		buffer.writeUInt16LE(FTN_PACKET_HEADER_TYPE, 18);
		buffer.writeUInt16LE(-1 === packetHeader.origNet ? 0xffff : packetHeader.origNet, 20);
		buffer.writeUInt16LE(packetHeader.destNet, 22);
		buffer.writeUInt8(packetHeader.prodCodeLo, 24);
		buffer.writeUInt8(packetHeader.prodRevHi, 25);
		
		const pass = ftn.stringToNullPaddedBuffer(packetHeader.password, 8);
		pass.copy(buffer, 26);
		
		buffer.writeUInt16LE(packetHeader.origZone, 34);
		buffer.writeUInt16LE(packetHeader.destZone, 36);
		buffer.writeUInt16LE(packetHeader.auxNet, 38);
		buffer.writeUInt16LE(packetHeader.capWordValidate, 40);
		buffer.writeUInt8(packetHeader.prodCodeHi, 42);
		buffer.writeUInt8(packetHeader.prodRevLo, 43);
		buffer.writeUInt16LE(packetHeader.capWord, 44);
		buffer.writeUInt16LE(packetHeader.origZone2, 46);
		buffer.writeUInt16LE(packetHeader.destZone2, 48);
		buffer.writeUInt16LE(packetHeader.origPoint, 50);
		buffer.writeUInt16LE(packetHeader.destPoint, 52);
		buffer.writeUInt32LE(packetHeader.prodData, 54);
		
		ws.write(buffer);
		
		return buffer.length;
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
		
		let encoding = 'cp437';

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
				function extractChrsAndDetermineEncoding(callback) {
					//
					//	From FTS-5003.001:
					//	"The CHRS control line is formatted as follows:
					//
					//	^ACHRS: <identifier> <level>
					//
					//	Where <identifier> is a character string of no more than eight (8)
					//	ASCII characters identifying the character set or character encoding
					//	scheme used, and level is a positive integer value describing what
					//	level of CHRS the  message is written in."
					//
					//	Also according to the spec, the deprecated "CHARSET" value may be used
					//	:TODO: Look into CHARSET more - should we bother supporting it?
					//	:TODO: See encodingFromHeader() for CHRS/CHARSET support @ https://github.com/Mithgol/node-fidonet-jam
					const FTN_CHRS_PREFIX 	= new Buffer( [ 0x01, 0x43, 0x48, 0x52, 0x53, 0x3a, 0x20 ] );	//	"\x01CHRS:"
					const FTN_CHRS_SUFFIX	= new Buffer( [ 0x0d ] );
					binary.parse(messageBodyBuffer)
						.scan('prefix', FTN_CHRS_PREFIX)
						.scan('content', FTN_CHRS_SUFFIX)
						.tap(chrsData => {
							if(chrsData.prefix && chrsData.content && chrsData.content.length > 0) {
								const chrs = iconv.decode(chrsData.content, 'CP437');
								const chrsEncoding = ftn.getEncodingFromCharacterSetIdentifier(chrs);
								if(chrsEncoding) {
									encoding = chrsEncoding;
								}
								callback(null);
							} else {
								callback(null);
							}
						});
				},
				function extractMessageData(callback) {
					//
					//	Decode |messageBodyBuffer| using |encoding| defaulted or detected above
					//
					//	:TODO: Look into \xec thing more - document
					let decoded;
					try {
						decoded = iconv.decode(messageBodyBuffer, encoding);
					} catch(e) {
						Log.debug( { encoding : encoding, error : e.toString() }, 'Error decoding. Falling back to ASCII');
						decoded = iconv.decode(messageBodyBuffer, 'ascii');
					}
					//const messageLines = iconv.decode(messageBodyBuffer, encoding).replace(/\xec/g, '').split(/\r\n|[\n\v\f\r\x85\u2028\u2029]/g);
					const messageLines	= decoded.replace(/\xec/g, '').split(/\r\n|[\n\v\f\r\x85\u2028\u2029]/g);
					let endOfMessage	= false;

					messageLines.forEach(line => {
						if(0 === line.length) {
							messageBodyData.message.push('');
							return;
						}
						
						if(line.startsWith('AREA:')) {
							messageBodyData.area = line.substring(line.indexOf(':') + 1).trim();
						} else if(line.startsWith('--- ')) {
							//	Tear Lines are tracked allowing for specialized display/etc.
							messageBodyData.tearLine = line;
						} else if(/^[ ]{1,2}\* Origin\: /.test(line)) {	//	To spec is " * Origin: ..."
							messageBodyData.originLine = line;
							endOfMessage = true;	//	Anything past origin is not part of the message body
						} else if(line.startsWith('SEEN-BY:')) {
							endOfMessage = true;	//	Anything past the first SEEN-BY is not part of the message body
							messageBodyData.seenBy.push(line.substring(line.indexOf(':') + 1).trim());
						} else if(FTN_MESSAGE_KLUDGE_PREFIX === line.charAt(0)) {
							if('PATH:' === line.slice(1, 6)) {
								endOfMessage = true;	//	Anything pats the first PATH is not part of the message body
							}
							addKludgeLine(line.slice(1));
						} else if(!endOfMessage) {
							//	regular ol' message line
							messageBodyData.message.push(line);
						}
					});

					return callback(null);
				}
			],
			() => {
				messageBodyData.message = messageBodyData.message.join('\n');
				return cb(messageBodyData);
			}
		);
	};
	
	this.parsePacketMessages = function(packetBuffer, iterator, cb) {
		binary.parse(packetBuffer)
			.word16lu('messageType')
			.word16lu('ftn_orig_node')
			.word16lu('ftn_dest_node')
			.word16lu('ftn_orig_network')
			.word16lu('ftn_dest_network')
			.word16lu('ftn_attr_flags')
			.word16lu('ftn_cost')
			.scan('modDateTime', NULL_TERM_BUFFER)	//	:TODO: 20 bytes max
			.scan('toUserName', NULL_TERM_BUFFER)	//	:TODO: 36 bytes max
			.scan('fromUserName', NULL_TERM_BUFFER)	//	:TODO: 36 bytes max
			.scan('subject', NULL_TERM_BUFFER)		//	:TODO: 72 bytes max6
			.scan('message', NULL_TERM_BUFFER)
			.tap(function tapped(msgData) {	//	no arrow function; want classic this
				if(!msgData.messageType) {
					//	end marker -- no more messages			
					return cb(null);
				}
				
				if(FTN_PACKET_MESSAGE_TYPE != msgData.messageType) {
					return cb(new Error('Unsupported message type: ' + msgData.messageType));
				}
				
				const read = 
					14 +								//	fixed header size
					msgData.modDateTime.length + 1 +
					msgData.toUserName.length + 1 +
					msgData.fromUserName.length + 1 +
					msgData.subject.length + 1 +
					msgData.message.length + 1;
				
				//
				//	Convert null terminated arrays to strings
				//
				let convMsgData = {};
				[ 'modDateTime', 'toUserName', 'fromUserName', 'subject' ].forEach(k => {
					convMsgData[k] = iconv.decode(msgData[k], 'CP437');
				});

				//
				//	The message body itself is a special beast as it may
				//	contain an origin line, kludges, SAUCE in the case
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
				msg.meta.FtnProperty.ftn_attr_flags		= msgData.ftn_attr_flags;
				msg.meta.FtnProperty.ftn_cost			= msgData.ftn_cost;

				self.processMessageBody(msgData.message, messageBodyData => {
					msg.message 		= messageBodyData.message;
					msg.meta.FtnKludge	= messageBodyData.kludgeLines;
			
					if(messageBodyData.tearLine) {
						msg.meta.FtnProperty.ftn_tear_line = messageBodyData.tearLine;
                        
                        if(self.options.keepTearAndOrigin) {
                            msg.message += `\r\n${messageBodyData.tearLine}\r\n`;
                        }
					}
					
					if(messageBodyData.seenBy.length > 0) {
						msg.meta.FtnProperty.ftn_seen_by = messageBodyData.seenBy;
					}
					
					if(messageBodyData.area) {
						msg.meta.FtnProperty.ftn_area = messageBodyData.area;
					}
					
					if(messageBodyData.originLine) {
						msg.meta.FtnProperty.ftn_origin = messageBodyData.originLine;
                        
                        if(self.options.keepTearAndOrigin) {
                            msg.message += `${messageBodyData.originLine}\r\n`;
                        }
					}
					
					//
					//	If we have a UTC offset kludge (e.g. TZUTC) then update
					//	modDateTime with it
					//
					if(_.isString(msg.meta.FtnKludge.TZUTC) && msg.meta.FtnKludge.TZUTC.length > 0) {
						msg.modDateTime = msg.modTimestamp.utcOffset(msg.meta.FtnKludge.TZUTC);
					}
					
					const nextBuf = packetBuffer.slice(read);
					if(nextBuf.length > 0) {
						let next = function(e) {
							if(e) {
								cb(e);
							} else {
								self.parsePacketMessages(nextBuf, iterator, cb);
							}
						};
						
						iterator('message', msg, next);
					} else {
						cb(null);
					}
				});			
			});
	};
		
	this.getMessageEntryBuffer = function(message, options) {
		let basicHeader = new Buffer(34);
		
		basicHeader.writeUInt16LE(FTN_PACKET_MESSAGE_TYPE, 0);
		basicHeader.writeUInt16LE(message.meta.FtnProperty.ftn_orig_node, 2);
		basicHeader.writeUInt16LE(message.meta.FtnProperty.ftn_dest_node, 4);
		basicHeader.writeUInt16LE(message.meta.FtnProperty.ftn_orig_network, 6);
		basicHeader.writeUInt16LE(message.meta.FtnProperty.ftn_dest_network, 8);
		basicHeader.writeUInt16LE(message.meta.FtnProperty.ftn_attr_flags, 10);
		basicHeader.writeUInt16LE(message.meta.FtnProperty.ftn_cost, 12);

		const dateTimeBuffer = new Buffer(ftn.getDateTimeString(message.modTimestamp) + '\0');
		dateTimeBuffer.copy(basicHeader, 14);

		//	toUserName & fromUserName: up to 36 bytes in length, NULL term'd
		//	:TODO: DRY...
		let toUserNameBuf = iconv.encode(message.toUserName + '\0', 'CP437').slice(0, 36);
		toUserNameBuf[toUserNameBuf.length - 1] = '\0';	//	ensure it's null term'd
		
		let fromUserNameBuf = iconv.encode(message.fromUserName + '\0', 'CP437').slice(0, 36);
		fromUserNameBuf[fromUserNameBuf.length - 1] = '\0';	//	ensure it's null term'd
		
		//	subject: up to 72 bytes in length, NULL term'd
		let subjectBuf = iconv.encode(message.subject + '\0', 'CP437').slice(0, 72);
		subjectBuf[subjectBuf.length - 1] = '\0';	//	ensure it's null term'd

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
					msgBody += `${k}: ${v}\r`;
				});
			}
		}
		
		//
		//	FTN-0004.001 @ http://ftsc.org/docs/fts-0004.001
		//	AREA:CONFERENCE
		//	Should be first line in a message
		//
		if(message.meta.FtnProperty.ftn_area) {
			msgBody += `AREA:${message.meta.FtnProperty.ftn_area}\r`;	//	note: no ^A (0x01)
		}
		
		Object.keys(message.meta.FtnKludge).forEach(k => {
			//	we want PATH to be last
			if('PATH' !== k) {
				appendMeta(`\x01${k}`, message.meta.FtnKludge[k]);
			}
		});

		msgBody += message.message + '\r';

		//
		//	FTN-0004.001 @ http://ftsc.org/docs/fts-0004.001
		//	Tear line should be near the bottom of a message
		//
		if(message.meta.FtnProperty.ftn_tear_line) {
			msgBody += `${message.meta.FtnProperty.ftn_tear_line}\r`;
		}
		
		//		
		//	Origin line should be near the bottom of a message
		//
		if(message.meta.FtnProperty.ftn_origin) {
			msgBody += `${message.meta.FtnProperty.ftn_origin}\r`;
		}

		//
		//	FTN-0004.001 @ http://ftsc.org/docs/fts-0004.001
		//	SEEN-BY and PATH should be the last lines of a message
		//
		appendMeta('SEEN-BY', message.meta.FtnProperty.ftn_seen_by);	//	note: no ^A (0x01)

		appendMeta('\x01PATH', message.meta.FtnKludge['PATH']);
		
		let msgBodyEncoded;
		try {
			msgBodyEncoded = iconv.encode(msgBody + '\0', options.encoding);
		} catch(e) {
			msgBodyEncoded = iconv.encode(msgBody + '\0', 'ascii');
		}
		
		return Buffer.concat( [ 
			basicHeader, 
			toUserNameBuf, 
			fromUserNameBuf, 
			subjectBuf,
			msgBodyEncoded 
		]);
	};

	this.writeMessage = function(message, ws, options) {
		let basicHeader = new Buffer(34);
		
		basicHeader.writeUInt16LE(FTN_PACKET_MESSAGE_TYPE, 0);
		basicHeader.writeUInt16LE(message.meta.FtnProperty.ftn_orig_node, 2);
		basicHeader.writeUInt16LE(message.meta.FtnProperty.ftn_dest_node, 4);
		basicHeader.writeUInt16LE(message.meta.FtnProperty.ftn_orig_network, 6);
		basicHeader.writeUInt16LE(message.meta.FtnProperty.ftn_dest_network, 8);
		basicHeader.writeUInt16LE(message.meta.FtnProperty.ftn_attr_flags, 10);
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
					msgBody += `${k}: ${v}\r`;
				});
			}
		}

		//
		//	FTN-0004.001 @ http://ftsc.org/docs/fts-0004.001
		//	AREA:CONFERENCE
		//	Should be first line in a message
		//
		if(message.meta.FtnProperty.ftn_area) {
			msgBody += `AREA:${message.meta.FtnProperty.ftn_area}\r`;	//	note: no ^A (0x01)
		}
		
		Object.keys(message.meta.FtnKludge).forEach(k => {
			//	we want PATH to be last
			if('PATH' !== k) {
				appendMeta(`\x01${k}`, message.meta.FtnKludge[k]);
			}
		});

		msgBody += message.message + '\r';

		//
		//	FTN-0004.001 @ http://ftsc.org/docs/fts-0004.001
		//	Tear line should be near the bottom of a message
		//
		if(message.meta.FtnProperty.ftn_tear_line) {
			msgBody += `${message.meta.FtnProperty.ftn_tear_line}\r`;
		}
		
		//		
		//	Origin line should be near the bottom of a message
		//
		if(message.meta.FtnProperty.ftn_origin) {
			msgBody += `${message.meta.FtnProperty.ftn_origin}\r`;
		}

		//
		//	FTN-0004.001 @ http://ftsc.org/docs/fts-0004.001
		//	SEEN-BY and PATH should be the last lines of a message
		//
		appendMeta('SEEN-BY', message.meta.FtnProperty.ftn_seen_by);	//	note: no ^A (0x01)

		appendMeta('\x01PATH', message.meta.FtnKludge['PATH']);

		//
		//	:TODO: We should encode based on config and add the proper kludge here!
		ws.write(iconv.encode(msgBody + '\0', options.encoding));
	};

	this.parsePacketBuffer = function(packetBuffer, iterator, cb) {
		async.series(
			[
				function processHeader(callback) {
					self.parsePacketHeader(packetBuffer, (err, header) => {
						if(err) {
							return callback(err);
						}
						
						let next = function(e) {
							callback(e);
						};
						
						iterator('header', header, next);
					});
				},
				function processMessages(callback) {
					self.parsePacketMessages(
						packetBuffer.slice(FTN_PACKET_HEADER_SIZE),
						iterator,
						callback);
				}
			],
			cb	//	complete
		);		
	};
}

//
//	Message attributes defined in FTS-0001.016
//	http://ftsc.org/docs/fts-0001.016
//
//	See also:
//	* http://www.skepticfiles.org/aj/basics03.htm
//
Packet.Attribute = {
	Private					: 0x0001,	//	Private message / NetMail
	Crash					: 0x0002,
	Received				: 0x0004,
	Sent					: 0x0008,
	FileAttached			: 0x0010,
	InTransit				: 0x0020,
	Orphan					: 0x0040,
	KillSent				: 0x0080,
	Local					: 0x0100,	//	Message is from *this* system	
	Hold					: 0x0200,
	Reserved0				: 0x0400,
	FileRequest				: 0x0800,
	ReturnReceiptRequest	: 0x1000,
	ReturnReceipt			: 0x2000,
	AuditRequest			: 0x4000,
	FileUpdateRequest		: 0x8000,
};
Object.freeze(Packet.Attribute);

Packet.prototype.read = function(pathOrBuffer, iterator, cb) {
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
				self.parsePacketBuffer(pathOrBuffer, iterator, err => {
					callback(err);
				});
			}
		],
		err => {
			cb(err);
		}
	);
};

Packet.prototype.writeHeader = function(ws, packetHeader) {
	return this.writePacketHeader(packetHeader, ws);
};

Packet.prototype.writeMessageEntry = function(ws, msgEntry) {
	ws.write(msgEntry);
	return msgEntry.length; 	
};

Packet.prototype.writeTerminator = function(ws) {
	ws.write(new Buffer( [ 0 ] ));	//	final extra null term
	return 1;
};

Packet.prototype.writeStream = function(ws, messages, options) {
	if(!_.isBoolean(options.terminatePacket)) {
		options.terminatePacket = true;
	}
	
	if(_.isObject(options.packetHeader)) {
		this.writePacketHeader(options.packetHeader, ws);
	}
	
	options.encoding = options.encoding || 'utf8';

	messages.forEach(msg => {
		this.writeMessage(msg, ws, options);
	});

	if(true === options.terminatePacket) {
		ws.write(new Buffer( [ 0 ] ));	//	final extra null term
	}
};

Packet.prototype.write = function(path, packetHeader, messages, options) {
	if(!_.isArray(messages)) {
		messages = [ messages ];
	}
	
	options = options || { encoding : 'utf8' };	//	utf-8 = 'CHRS UTF-8 4'

	this.writeStream(
		fs.createWriteStream(path),	//	:TODO: specify mode/etc.
		messages,
		{ packetHeader : packetHeader, terminatePacket : true }
		);
};
