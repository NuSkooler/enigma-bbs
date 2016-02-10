/* jslint node: true */
'use strict';

//	ENiGMA½
var MessageScanTossModule		= require('../scan_toss_module.js').MessageScanTossModule;
var Config						= require('../config.js').config;

exports.moduleInfo = {
	name	: 'FTN',
	desc	: 'FidoNet Style Message Scanner/Tosser',
	author	: 'NuSkooler',
};

exports.getModule = FTNMessageScanTossModule;

function FTNMessageScanTossModule() {
	MessageScanTossModule.call(this);

	this.config = Config.scannerTossers.ftn_bso;

	
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
