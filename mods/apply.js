/* jslint node: true */
'use strict';

var ansi			= require('../core/ansi_term.js');
var art				= require('../core/art.js');
var user			= require('../core/user.js');
var theme			= require('../core/theme.js');
var Log				= require('../core/logger.js').log;
var MenuModule		= require('../core/menu_module.js').MenuModule;
var ViewController	= require('../core/view_controller.js').ViewController;

//var async			= require('async');

//	:TODO: clean up requires

exports.moduleInfo = {
	name	: 'Apply',
	desc	: 'Application Module',
	author	: 'NuSkooler',
};

exports.getModule	= ApplyModule;


function ApplyModule(menuConfig) {
	MenuModule.call(this, menuConfig);

	var self = this;

	this.clearForm = function() {
		[ 1, 2, ].forEach(function onId(id) {
			self.viewController.getView(id).clearText();
		});
	};
}

require('util').inherits(ApplyModule, MenuModule);

ApplyModule.prototype.enter = function(client) {
	ApplyModule.super_.prototype.enter.call(this, client);
};

ApplyModule.prototype.beforeArt = function() {
	ApplyModule.super_.prototype.beforeArt.call(this);

	this.client.term.write(ansi.resetScreen());
};

ApplyModule.prototype.mciReady = function(mciMap) {
	ApplyModule.super_.prototype.mciReady.call(this, mciMap);

	var self = this;

	self.viewController = self.addViewController(new ViewController(self.client));
	self.viewController.loadFromMCIMapAndConfig( { mciMap : mciMap, menuConfig : self.menuConfig }, function onViewReady(err) {
	});
};