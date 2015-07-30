/* jslint node: true */
'use strict';

var MenuModule		= require('./menu_module.js').MenuModule;

exports.getModule	= StandardMenuModule;

exports.moduleInfo = {
	name	: 'Standard Menu Module',
	desc	: 'A Menu Module capable of handing standard configurations',
	author	: 'NuSkooler',
};

function StandardMenuModule(menuConfig) {
	MenuModule.call(this, menuConfig);
}

require('util').inherits(StandardMenuModule, MenuModule);


StandardMenuModule.prototype.enter = function(client) {
	StandardMenuModule.super_.prototype.enter.call(this, client);
};

StandardMenuModule.prototype.beforeArt = function() {
	StandardMenuModule.super_.prototype.beforeArt.call(this);
};

StandardMenuModule.prototype.mciReady = function(mciData, cb) {
	var self = this;
	
	StandardMenuModule.super_.prototype.mciReady.call(this, mciData, function mciReadyComplete(err) {
		if(err) {
			cb(err);
		} else {
			//	 we do this so other modules can be both customized and still perform standard tasks
			StandardMenuModule.super_.prototype.standardMCIReadyHandler.call(self, mciData, cb);
		}
	});
};
