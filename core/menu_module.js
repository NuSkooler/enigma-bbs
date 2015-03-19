/* jslint node: true */
'use strict';

var PluginModule			= require('./plugin_module.js').PluginModule;

exports.MenuModule		= MenuModule;

function MenuModule() {
	PluginModule.call(this);

	this.viewControllers = [];
}

require('util').inherits(MenuModule, PluginModule);

MenuModule.prototype.enter = function(client) {
	
};

MenuModule.prototype.leave = function() {
	this.viewControllers.forEach(function onVC(vc) {
		vc.detachClientEvents();
	});
};

MenuModule.prototype.addViewController = function(vc) {
	this.viewControllers.push(vc);
	return vc;	//	allow var vc = this.addViewController(new ViewController(...));
};