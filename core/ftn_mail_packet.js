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

	this.getNetworkForAddress = function(addr) {
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

	this.loadPacketHeader = function(packetBuffer, cb) {
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
			//	where is the rest of the spec?
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

				cb(null, packetHeader);
			});
	};

	this.loadMessagesFromPacketBuffer = function(packetBuffer, cb) {
		async.series(
			[
				function loadHdr(callback) {
					self.loadPacketHeader(packetBuffer, function headerLoaded(err, packetHeader) {
						self.packetHeader = packetHeader;
						callback(err);
					});
				},
				function validateType(callback) {
					//	:TODO: don't use a magic # here....
					if(2 !== self.packetHeader.packetType) {
						callback(new Error('Packet is not Type-2'));
					} else {
						callback(null);
					}
				},
				function checkAddress(callback) {
					/*
					if(0 !== self.packetHeader.destPoint) {
						self.packetNodeAddress = ftn.getFormattedFTNAddress(self.getPacketHeaderAddress(), '4D');
					} else {
						self.packetNodeAddress = ftn.getFormattedFTNAddress(self.getPacketHeaderAddress(), '3D');
					}*/

					var network = self.getNetworkForAddress(self.getPacketHeaderAddress());
					callback(network ? null : new Error('Packet not addressed do this system'));
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

mailPacket.parse('/home/nuskooler/ownCloud/Projects/ENiGMA½ BBS/FTNPackets/27000425.pkt', function parsed(err, messages) {

});