/* jslint node: true */
'use strict';

var PluginModule			= require('./plugin_module.js').PluginModule;

exports.ServerModule	= ServerModule;

function ServerModule() {
	PluginModule.call(this);

	this.viewControllers = [];
}

require('util').inherits(ServerModule, PluginModule);

ServerModule.prototype.createServer = function() {
	console.log('ServerModule createServer')
	return null;
};