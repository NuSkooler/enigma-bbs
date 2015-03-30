/* jslint node: true */
'use strict';

var ansi			= require('../core/ansi_term.js');
var art				= require('../core/art.js');
var user			= require('../core/user.js');
var theme			= require('../core/theme.js');
var MenuModule		= require('../core/menu_module.js').MenuModule;
var ViewController	= require('../core/view_controller.js').ViewController;

//var async			= require('async');

//	:TODO: clean up requires

exports.moduleInfo = {
	name	: 'Login',
	desc	: 'Login Module',
	author	: 'NuSkooler',
};

exports.getModule	= LoginModule;


function LoginModule(menuConfig) {
	MenuModule.call(this, menuConfig);
}

require('util').inherits(LoginModule, MenuModule);

LoginModule.prototype.enter = function(client) {
	LoginModule.super_.prototype.enter.call(this, client);
};

LoginModule.prototype.beforeArt = function() {
	LoginModule.super_.prototype.beforeArt.call(this);

	this.client.term.write(ansi.resetScreen());
};

LoginModule.prototype.mciReady = function(mciMap) {
	LoginModule.super_.prototype.mciReady.call(this, mciMap);

	var self = this;

	var vc = self.addViewController(new ViewController(self.client));
	vc.loadFromMCIMapAndConfig( { mciMap : mciMap, menuConfig : self.menuConfig }, function onViewReady(err) {
	});
};