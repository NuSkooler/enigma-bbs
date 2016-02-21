/* jslint node: true */
'use strict';

//	ENiGMA½
let MessageScanTossModule	= require('../msg_scan_toss_module.js').MessageScanTossModule;
let Config					= require('../config.js').config;
let ftnMailPacket			= require('../ftn_mail_packet.js');
let ftnUtil					= require('../ftn_util.js');
let Address					= require('../ftn_address.js');
let Log						= require('../logger.js').log;

let moment					= require('moment');
let _						= require('lodash');
let paths					= require('path');
let mkdirp 					= require('mkdirp');

exports.moduleInfo = {
	name	: 'FTN',
	desc	: 'FidoNet Style Message Scanner/Tosser',
	author	: 'NuSkooler',
};

/*
	:TODO: 
	* Add bundle timer (arcmail)
	* Queue until time elapses / fixed time interval
	* Pakcets append until >= max byte size
	* [if arch type is not empty): Packets -> bundle until max byte size -> repeat process
	* NetMail needs explicit isNetMail()  check
	* NetMail filename / location / etc. is still unknown - need to post on groups & get real answers
*/ 

exports.getModule = FTNMessageScanTossModule;

function FTNMessageScanTossModule() {
	MessageScanTossModule.call(this);

	if(_.has(Config, 'scannerTossers.ftn_bso')) {
		this.moduleConfig = Config.scannerTossers.ftn_bso;
	}
	
	this.isDefaultDomainZone = function(networkName, address) {
		return(networkName === this.moduleConfig.defaultNetwork && address.zone === this.moduleConfig.defaultZone);
	}
	
	this.getOutgoingPacketDir = function(networkName, remoteAddress) {
		let dir = this.moduleConfig.paths.outbound;
		if(!this.isDefaultDomainZone(networkName, remoteAddress)) {
			const hexZone = `000${remoteAddress.zone.toString(16)}`.substr(-3);
			dir = paths.join(dir, `${networkName.toLowerCase()}.${hexZone}`);
		}
		return dir;
	};
	
	this.getOutgoingPacketFileName = function(basePath, message, isTemp) {
		//
		//	Generating an outgoing packet file name comes with a few issues:
		//	*	We must use DOS 8.3 filenames due to legacy systems that receive
		//		the packet not understanding LFNs
		//	*	We need uniqueness; This is especially important with packets that
		//		end up in bundles and on the receiving/remote system where conflicts
		//		with other systems could also occur
		//
		//	There are a lot of systems in use here for the name:
		//	*	HEX CRC16/32 of data
		//	*	HEX UNIX timestamp
		//	*	Mystic at least at one point, used Hex8(day of month + seconds past midnight + hundredths of second) 
		//		See https://groups.google.com/forum/#!searchin/alt.bbs.mystic/netmail$20filename/alt.bbs.mystic/m1xLnY8i1pU/YnG2excdl6MJ
		//	* 	SBBSEcho uses DDHHMMSS - see https://github.com/ftnapps/pkg-sbbs/blob/master/docs/fidonet.txt
		//	*	We already have a system for 8-character serial number gernation that is
		//		used for e.g. in FTS-0009.001 MSGIDs... let's use that!
		// 		
		const name	= ftnUtil.getMessageSerialNumber(message);
		const ext	= (true === isTemp) ? 'pk_' : 'pkt';				 
		return paths.join(basePath, `${name}.${ext}`);
	};

	this.createMessagePacket = function(message, options) {
		this.prepareMessage(message, options);

		let packet = new ftnMailPacket.Packet();

		let packetHeader = new ftnMailPacket.PacketHeader(
			options.network.localAddress,
			options.remoteAddress,
			options.nodeConfig.packetType);

		packetHeader.password = options.nodeConfig.packetPassword || '';
				
		if(message.isPrivate()) {
			//	:TODO: this should actually be checking for isNetMail()!!
		} else {
			const outgoingDir = this.getOutgoingPacketDir(options.networkName, options.remoteAddress);
			
			mkdirp(outgoingDir, err => {
				if(err) {
					//	:TODO: Handle me!!
				} else {
					packet.write(
						this.getOutgoingPacketFileName(outgoingDir, message), 
						packetHeader, 
						[ message ],
						{ encoding : options.encoding }
						);
				}	
			});
		}
		
	};

	this.prepareMessage = function(message, options) {
		//
		//	Set various FTN kludges/etc.
		//
		message.meta.FtnProperty = message.meta.FtnProperty || {};
		message.meta.FtnKludge = message.meta.FtnKludge || {};
		
		message.meta.FtnProperty.ftn_orig_node		= options.network.localAddress.node;
		message.meta.FtnProperty.ftn_dest_node		= options.remoteAddress.node;
		message.meta.FtnProperty.ftn_orig_network	= options.network.localAddress.net;
		message.meta.FtnProperty.ftn_dest_network	= options.remoteAddress.net;
		//	:TODO: attr1 & 2
		message.meta.FtnProperty.ftn_cost			= 0;
		
		message.meta.FtnProperty.ftn_tear_line		= ftnUtil.getTearLine();		

		//	:TODO: Need an explicit isNetMail() check
		if(message.isPrivate()) {
			//
			//	NetMail messages need a FRL-1005.001 "Via" line
			//	http://ftsc.org/docs/frl-1005.001
			//
			if(_.isString(message.meta.FtnKludge.Via)) {
				message.meta.FtnKludge.Via = [ message.meta.FtnKludge.Via ];
			}
			message.meta.FtnKludge.Via = message.meta.FtnKludge.Via || [];
			message.meta.FtnKludge.Via.push(ftnUtil.getVia(options.network.localAddress));
		} else {
			//
			//	EchoMail requires some additional properties & kludges
			//			
			message.meta.FtnProperty.ftn_origin		= ftnUtil.getOrigin(options.network.localAddress);
			message.meta.FtnProperty.ftn_area		= Config.messageNetworks.ftn.areas[message.areaTag].tag;
			
			//
			//	When exporting messages, we should create/update SEEN-BY
			//	with remote address(s) we are exporting to.
			//
			message.meta.FtnProperty.ftn_seen_by = 
				ftnUtil.getUpdatedSeenByEntries(
					message.meta.FtnProperty.ftn_seen_by,
					Config.messageNetworks.ftn.areas[message.areaTag].uplinks
				);

			//
			//	And create/update PATH for ourself
			//
			message.meta.FtnKludge.PATH = 
				ftnUtil.getUpdatedPathEntries(message.meta.FtnKludge.PATH, options.network.localAddress);
		}
		
		//
		//	Additional kludges
		//	
		message.meta.FtnKludge.MSGID = ftnUtil.getMessageIdentifier(message, options.network.localAddress);	
		message.meta.FtnKludge.TZUTC = ftnUtil.getUTCTimeZoneOffset();
		
		if(!message.meta.FtnKludge.PID) {
			message.meta.FtnKludge.PID = ftnUtil.getProductIdentifier();
		}
		
		if(!message.meta.FtnKludge.TID) {
			//	:TODO: Create TID!!
			//message.meta.FtnKludge.TID = 
		}
		
		//
		//	Determine CHRS and actual internal encoding name
		//	Try to preserve anything already here
		let encoding = options.nodeConfig.encoding || 'utf8';
		if(message.meta.FtnKludge.CHRS) {
			const encFromChars = ftnUtil.getEncodingFromCharacterSetIdentifier(message.meta.FtnKludge.CHRS);
			if(encFromChars) {
				encoding = encFromChars;
			}
		}
		
		options.encoding = encoding;	//	save for later
		message.meta.FtnKludge.CHRS = ftnUtil.getCharacterSetIdentifierByEncoding(encoding);
		//	:TODO: FLAGS kludge? 
		//	:TODO: Add REPLY kludge if appropriate
		
	};
	
	
	//	:TODO: change to something like isAreaConfigValid
	//	check paths, Addresses, etc.
	this.isAreaConfigComplete = function(areaConfig) {
		if(!_.isString(areaConfig.tag) || !_.isString(areaConfig.network)) {
			return false;
		}
		
		if(_.isString(areaConfig.uplinks)) {
			areaConfig.uplinks = areaConfig.uplinks.split(' ');
		}
		
		return (_.isArray(areaConfig.uplinks));
	};

}

require('util').inherits(FTNMessageScanTossModule, MessageScanTossModule);

FTNMessageScanTossModule.prototype.startup = function(cb) {
	Log.info('FidoNet Scanner/Tosser starting up');
	
	FTNMessageScanTossModule.super_.prototype.startup.call(this, cb);
};

FTNMessageScanTossModule.prototype.shutdown = function(cb) {
	Log.info('FidoNet Scanner/Tosser shutting down');

	FTNMessageScanTossModule.super_.prototype.shutdown.call(this, cb);
};

FTNMessageScanTossModule.prototype.record = function(message) {
	if(!_.has(this, 'moduleConfig.nodes') || 
		!_.has(Config, [ 'messageNetworks', 'ftn', 'areas', message.areaTag ]))
	{
		return;
	}

	const areaConfig = Config.messageNetworks.ftn.areas[message.areaTag];
	if(!this.isAreaConfigComplete(areaConfig)) {
		//	:TODO: should probably log a warning here
		return;
	}

	//
	//	For each uplink, find the best configuration match
	//
	areaConfig.uplinks.forEach(uplink => {
		//	:TODO: sort by least # of '*' & take top?
		const nodeKey = _.filter(Object.keys(this.moduleConfig.nodes), addr => {
			return Address.fromString(addr).isMatch(uplink);
		})[0];

		if(nodeKey) {
			const processOptions = {
				nodeConfig		: this.moduleConfig.nodes[nodeKey],
				network			: Config.messageNetworks.ftn.networks[areaConfig.network],
				remoteAddress	: Address.fromString(uplink),
				networkName		: areaConfig.network,
			};
						
			if(_.isString(processOptions.network.localAddress)) {
				//	:TODO: move/cache this - e.g. @ startup(). Think about due to Config cache
				processOptions.network.localAddress = Address.fromString(processOptions.network.localAddress);
			}
			
			//	:TODO: Validate the rest of the matching config -- or do that elsewhere, e.g. startup()
			
			this.createMessagePacket(message, processOptions);	
		}
	});

	
	//	:TODO: should perhaps record in batches - e.g. start an event, record
	//	to temp location until time is hit or N achieved such that if multiple
	//	messages are being created a .FTN file is not made for each one
};
