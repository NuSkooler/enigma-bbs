/* jslint node: true */
'use strict';

//	ENiGMA½
var PluginModule				= require('./plugin_module.js').PluginModule;

exports.MessageNetworkModule	= MessageNetworkModule;

function MessageNetworkModule() {
	PluginModule.call(this);
}

require('util').inherits(MessageNetworkModule, PluginModule);

MessageNetworkModule.prototype.startup = function(cb) {
	cb(null);
};

MessageNetworkModule.prototype.shutdown = function(cb) {
	cb(null);
};

MessageNetworkModule.prototype.record = function(message, cb) {
	cb(null);
};