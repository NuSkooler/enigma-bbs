/* jslint node: true */
'use strict';

var ansi			= require('../core/ansi_term.js');
var MenuModule		= require('../core/menu_module.js').MenuModule;
var ViewController	= require('../core/view_controller.js').ViewController;
var menuUtil		= require('../core/menu_util.js');

var _				= require('lodash');

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

StandardMenuModule.prototype.mciReady = function(mciData) {
	StandardMenuModule.super_.prototype.mciReady.call(this, mciData);

	var self = this;

	//
	//	A quick rundown:
	//	*	We may have mciData.menu, mciData.prompt, or both.
	//	*	Prompt form is favored over menu form if both are present.
	//	*	Standard/prefdefined MCI entries must load both (e.g. %BN is expected to resolve)
	//
	//	:TODO: Create MenuModule.standardMciReady() method that others can call that does this -- even custom modules will generally want most of this
	self.viewControllers = {};

	var vcOpts = { client : self.client };
	
	if(mciData.menu) {
		self.viewControllers.menu = new ViewController(vcOpts);
	}

	if(mciData.prompt) {
		self.viewControllers.prompt = new ViewController(vcOpts);
	}

	var viewsReady = function(err) {
		//	:TODO: Hrm.....
	};


	if(self.viewControllers.menu) {
		var menuLoadOpts = {
			mciMap		: mciData.menu,
			callingMenu	: self,
			//menuConfig	: self.menuConfig,
			withoutForm	: _.isObject(mciData.prompt),
		};

		self.viewControllers.menu.loadFromMenuConfig(menuLoadOpts, viewsReady);
	}

	if(self.viewControllers.prompt) {
		var promptLoadOpts = {
			callingMenu		: self,
			mciMap			: mciData.prompt,
		};

		self.viewControllers.prompt.loadFromPromptConfig(promptLoadOpts, viewsReady);
	}

	/*
	var vc = self.addViewController(new ViewController({ client : self.client } ));
	vc.loadFromMCIMapAndConfig( { mciMap : mciData.menu, menuConfig : self.menuConfig }, function onViewReady(err) {
		if(err) {
			console.log(err);
		} else {
		}
	});	
*/
};
