/* jslint node: true */
'use strict';

var PluginModule			= require('./plugin_module.js').PluginModule;

exports.ServerModule	= ServerModule;

function ServerModule() {
	PluginModule.call(this);
}

require('util').inherits(ServerModule, PluginModule);

ServerModule.prototype.createServer = function() {
	return null;
};