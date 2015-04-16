/* jslint node: true */
'use strict';

var ansi			= require('../core/ansi_term.js');
var MenuModule		= require('../core/menu_module.js').MenuModule;
var ViewController	= require('../core/view_controller.js').ViewController;
var menuUtil		= require('../core/menu_util.js');

exports.getModule	= StandardMenuModule;

exports.moduleInfo = {
	name	: 'Standard Menu Module',
	desc	: 'Menu module handling most standard stuff',
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

StandardMenuModule.prototype.mciReady = function(mciMap) {
	StandardMenuModule.super_.prototype.mciReady.call(this, mciMap);

	var self = this;

	var vc = self.addViewController(new ViewController({ client : self.client } ));
	vc.loadFromMCIMapAndConfig( { mciMap : mciMap, menuConfig : self.menuConfig }, function onViewReady(err) {
		if(err) {
			console.log(err);
		} else {
		/*	vc.on('submit', function onFormSubmit(formData) {
				console.log(formData);
			});*/
		}
	});	
};
