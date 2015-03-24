/* jslint node: true */
'use strict';

var MenuModule		= require('../core/menu_module.js').MenuModule;
var ansi			= require('../core/ansi_term.js');

exports.moduleInfo = {
	name	: 'Goodbye',
	desc	: 'Log off / Goodbye Module',
	author	: 'NuSkooler',
};

exports.getModule	= GoodbyeModule;

function GoodbyeModule(menuConfig) {
	MenuModule.call(this, menuConfig);
}

require('util').inherits(GoodbyeModule, MenuModule);

GoodbyeModule.prototype.enter = function(client) {
	GoodbyeModule.super_.prototype.enter.call(this, client);
};

GoodbyeModule.prototype.beforeArt = function() {
	GoodbyeModule.super_.prototype.beforeArt.call(this);

	this.client.term.write(ansi.resetScreen());
};

GoodbyeModule.prototype.mciReady = function(mciMap) {
	GoodbyeModule.super_.prototype.mciReady.call(this, mciMap);
};

GoodbyeModule.prototype.finishedLoading = function() {
	GoodbyeModule.super_.prototype.finishedLoading.call(this);
	
	this.client.end();
};