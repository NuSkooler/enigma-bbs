/* jslint node: true */
'use strict';

//	ENiGMA½
var MessageNetworkModule		= require('./msg_network_module.js').MessageNetworkModule;

function FTNMessageNetworkModule() {
	MessageNetworkModule.call(this);
}

require('util').inherits(FTNMessageNetworkModule, MessageNetworkModule);

FTNMessageNetworkModule.prototype.startup = function(cb) {
	cb(null);
};

FTNMessageNetworkModule.prototype.shutdown = function(cb) {
	cb(null);
};

FTNMessageNetworkModule.prototype.record = function(message, cb) {
	cb(null);
	
	//	:TODO: should perhaps record in batches - e.g. start an event, record
	//	to temp location until time is hit or N achieved such that if multiple
	//	messages are being created a .FTN file is not made for each one
};