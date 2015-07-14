/* jslint node: true */
'use strict';

var Config			= require('./config.js').config;
var ftn				= require('./ftn_util.js');

var _				= require('lodash');
var assert			= require('assert');
var binary			= require('binary');
var fs				= require('fs');
var util			= require('util');
var async			= require('async');

//
//	References
//	https://github.com/M-griffin/PyPacketMail/blob/master/PyPacketMail.py
//

function FTNMailPacket(options) {

	//
	//	Map of networkName -> { zone, net, node, point, ... }
	//
	//
	//	:TODO: ...
	//	options.nodeAddresses
	
	var self			= this;
	this.nodeAddresses	= options.nodeAddresses || {};

	/*
	this.loadNodeAddresses = function() {
		if(Config.networks) {
			for(var name in Config.networks) {
				if(!Config.networks[name].address) {
					continue;
				}

				this.nodeAddresses[name] = Config.networks[name].address;
			}
		}
	};

	this.loadNodeAddresses();
	*/

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
			.word16lu('originNet')
			.word16lu('destNet')
			.word8('prodCodeLo')
			.word8('revisionMajor')	//	aka serialNo
			.buffer('password', 8)	//	null terminated C style string
			.word16lu('origZone')
			.word16lu('destZone')
			//	:TODO: Document the various specs/fields more
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
					cb(new Error('Packet is not Type-2'));
					return;
				}

				//	:TODO: validate & pass error if failure
				cb(null, packetHeader);
			});
	};

	this.parseFtnMessageBody = function(msgBodyBuffer, cb) {

	};

	this.parseFtnMessages = function(buffer, cb) {
		var nullTermBuf		= new Buffer( [ 0 ] );
		var fidoMessages	= [];

		binary.stream(buffer).loop(function looper(end, vars) {
			this
				.word16lu('messageType')
				.word16lu('originNode')
				.word16lu('destNode')
				.word16lu('originNet')
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
					if(!msgData.originNode) {
						end();
						cb(null, fidoMessages);
						return;
					}

					//	buffer to string conversion
					//	:TODO: What is the real encoding here?
					[ 'modDateTime', 'toUserName', 'fromUserName', 'subject', ].forEach(function field(f) {
						msgData[f] = msgData[f].toString();
					});



					fidoMessages.push(_.clone(msgData));
				});
		});	
	};

	/*
	this.loadMessageHeader = function(msgHeaderBuffer, cb) {
		assert(Buffer.isBuffer(msgHeaderBuffer));

		if(msgHeaderBuffer.length < 14) {
			cb(new Error('Buffer too small'));
			return;
		}

		binary.parse(msgHeaderBuffer)
			.word16lu('messageType')
			.word16lu('originNode')
			.word16lu('destNode')
			.word16lu('originNet')
			.word16lu('destNet')
			.word8('attrFlags1')
			.word8('attrFlags2')
			.word16lu('cost')
			.tap(function tapped(msgHeader) {
				console.log(msgHeader)

				var nullTermBuf = new Buffer( [ 0 ] );
				var offset = 14;
				binary.parse(msgHeaderBuffer.slice(offset))
					.scan('modDateTime', nullTermBuf)
					.scan('toUserName', nullTermBuf)
					.tap(function tapped(varMsgHeader) {
						console.log(varMsgHeader.modDateTime.toString())
						console.log(varMsgHeader.toUserName.toString())
					});

				cb(null, msgHeader);
			});
	};

	this.loadMessage = function(buf, cb) {
		var bufPosition = 0;
		async.waterfall(
			[
				function loadHdr(callback) {
					self.loadMessageHeader(buf.slice(bufPosition), function headerLoaded(err, msgHeader) {
						callback(err, msgHeader);
					});
				}
			]
		);
	};
	*/

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
					callback(self.localNetworkName ? null : new Error('Packet not addressed do this system'));
				},
				function parseMessages(callback) {
					self.parseFtnMessages(packetBuffer.slice(58), function messagesParsed(err, fidoMessages) {
						callback(err, fidoMessages);
					});
				},
				function createMessageObjects(fidoMessages, callback) {
					fidoMessages.forEach(function msg(fmsg) {
						console.log(fmsg.subject);
					});
				}
			],
			function complete(err) {
				cb(err);
			}
		);
	};

}

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

mailPacket.parse('/home/bashby/ownCloud/Projects/ENiGMA½ BBS/FTNPackets/27000425.pkt', function parsed(err, messages) {

});