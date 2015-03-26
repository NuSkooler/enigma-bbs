/* jslint node: true */
'use strict';

var MenuModule		= require('../core/menu_module.js').MenuModule;
var ansi			= require('../core/ansi_term.js');

exports.moduleInfo = {
	name	: 'LogOff',
	desc	: 'Log off / Goodbye Module',
	author	: 'NuSkooler',
};

exports.getModule	= LogOffModule;

function LogOffModule(menuConfig) {
	MenuModule.call(this, menuConfig);
}

require('util').inherits(LogOffModule, MenuModule);

LogOffModule.prototype.enter = function(client) {
	LogOffModule.super_.prototype.enter.call(this, client);
};

LogOffModule.prototype.beforeArt = function() {
	LogOffModule.super_.prototype.beforeArt.call(this);

	this.client.term.write(ansi.resetScreen());
};

LogOffModule.prototype.mciReady = function(mciMap) {
	LogOffModule.super_.prototype.mciReady.call(this, mciMap);
};

LogOffModule.prototype.finishedLoading = function() {
	LogOffModule.super_.prototype.finishedLoading.call(this);
	
	this.client.end();
};