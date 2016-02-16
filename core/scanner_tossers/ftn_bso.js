/* jslint node: true */
'use strict';

//	ENiGMA½
let MessageScanTossModule		= require('../scan_toss_module.js').MessageScanTossModule;
let Config						= require('../config.js').config;
let ftnMailpacket				= require('../ftn_mail_packet.js');
let ftnUtil						= require('../ftn_util.js');

let moment						= require('moment');

exports.moduleInfo = {
	name	: 'FTN',
	desc	: 'FidoNet Style Message Scanner/Tosser',
	author	: 'NuSkooler',
};

exports.getModule = FTNMessageScanTossModule;

function FTNMessageScanTossModule() {
	MessageScanTossModule.call(this);

	this.config = Config.scannerTossers.ftn_bso;

	this.createMessagePacket = function(message, config) {
		this.prepareMessage(message);

		let packet = new ftnMailPacket.Packet();

		let packetHeader = new ftnMailpacket.PacketHeader();
		packetHeader.init(
			config.network.localAddress,
			config.remoteAddress);

		packetHeader.setPassword(config.remoteNode.packetPassword || '');
	};

	this.prepareMessage = function(message, config) {
		//
		//	Set various FTN kludges/etc.
		//
		message.meta.FtnProperty = message.meta.FtnProperty || {};
		message.meta.FtnProperty.ftn_orig_node		= config.network.localAddress.node;
		message.meta.FtnProperty.ftn_dest_node		= config.remoteAddress.node;
		message.meta.FtnProperty.ftn_orig_network	= config.network.localAddress.net;
		message.meta.FtnProperty.ftn_dest_network	= config.remoteAddress.net;
		//	:TODO: attr1 & 2
		message.meta.FtnProperty.ftn_cost			= 0;

		message.meta.FtnProperty.ftn_tear_line		= ftnUtil.getTearLine();
		message.meta.FtnProperty.ftn_origin			= ftnUtil.getOrigin(config.network.localAddress);

		if(message.areaTag) {
			message.meta.FtnProperty.ftn_area = message.areaTag;
		} else {
			//	:TODO: add "Via" line -- FSP-1010
		}

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
		message.meta.FtnKludge['PATH'] = 
			ftnUtil.getUpdatedPathEntries(
				message.meta.FtnKludge['PATH'], 
				config.network.localAddress.node
			);
	};

}

require('util').inherits(FTNMessageScanTossModule, MessageScanTossModule);

FTNMessageScanTossModule.prototype.startup = function(cb) {
	cb(null);
};

FTNMessageScanTossModule.prototype.shutdown = function(cb) {
	cb(null);
};

FTNMessageScanTossModule.prototype.record = function(message, cb) {


	cb(null);
	
	//	:TODO: should perhaps record in batches - e.g. start an event, record
	//	to temp location until time is hit or N achieved such that if multiple
	//	messages are being created a .FTN file is not made for each one
};
