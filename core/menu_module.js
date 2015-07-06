/* jslint node: true */
'use strict';

var PluginModule		= require('./plugin_module.js').PluginModule;
var theme				= require('./theme.js');
var art					= require('./art.js');
var Log					= require('./logger.js').log;
var ansi				= require('./ansi_term.js');
var asset				= require('./asset.js');
var ViewController		= require('./view_controller.js').ViewController;
var menuUtil			= require('./menu_util.js');

var async				= require('async');
var assert				= require('assert');
var _					= require('lodash');

exports.MenuModule		= MenuModule;

function MenuModule(options) {
	PluginModule.call(this, options);

	var self				= this;
	this.menuName			= options.menuName;
	this.menuConfig			= options.menuConfig;
	this.menuConfig.options	= options.menuConfig.options || {};
	this.menuMethods		= {};	//	methods called from @method's
	this.viewControllers	= {};	//	name->vc

	this.displayArtAsset = function(assetSpec, cb) {
		var artAsset = asset.getArtAsset(assetSpec);

		if(!artAsset) {
			cb(new Error('Asset not found: ' + assetSpec));
			return;
		}

		var dispOptions = {
			name	: artAsset.asset,
			client	: self.client,
			font	: self.menuConfig.font,
		};

		switch(artAsset.type) {
			case 'art' :
				theme.displayThemeArt(dispOptions, function displayed(err, themeArtData) {
					cb(err, { mciMap : themeArtData.mciMap, height : themeArtData.extraInfo.height } );
				});
				break;

			case 'method' :
				//	:TODO: fetch and render via method/generator
				break;

			case 'inline' :
				if(_.isString(assetSpec.asset)) {
					//	:TODO: think about this more in relation to themes, etc. How can this come
					//	from a theme (with override from menu.json) ???
					//	look @ client.currentTheme.inlineArt[name] -> menu/prompt[name]
				}
				break;

			default :
				cb(new Error('Unsupported art asset type'));
				break;
		}
	};

	this.initSequence = function() {
		var mciData = { };

		async.waterfall(
			[
				function beforeDisplayArt(callback) {
					self.beforeArt();
					callback(null);
				},
				function displayMenuArt(callback) {
					if(_.isString(self.menuConfig.art)) {
						self.displayArtAsset(self.menuConfig.art, function displayed(err, artData) {
							mciData.menu = artData.mciMap;
							callback(err);
						});
					} else {						
						callback(null);
					}
				},
				function moveToPromptLocation(callback) {												
					if(self.menuConfig.prompt) {
						//	:TODO: fetch and move cursor to prompt location, if supplied. See notes/etc. on placements
					}

					callback(null);
				},
				function displayPromptArt(callback) {
					if(_.isString(self.menuConfig.prompt)) {
						//	If a prompt is specified, we need the configuration
						if(!_.isObject(self.menuConfig.promptConfig)) {
							callback(new Error('Prompt specified but configuraiton not found!'));
							return;
						}

						//	Prompts *must* have art. If it's missing it's an error
						//	:TODO: allow inline prompts in the future, e.g. @inline:memberName -> { "memberName" : { "text" : "stuff", ... } }
						var promptConfig = self.menuConfig.promptConfig;
						self.displayArtAsset(promptConfig.art, function displayed(err, mciMap) {
							mciData.prompt = mciMap;
							callback(err);
						});
					} else {						
						callback(null);
					}
				},
				function afterArtDisplayed(callback) {
					self.mciReady(mciData);
					callback(null);
				}
			],
			function complete(err) {
				if(err) {
					console.log(err)
					//	:TODO: what to do exactly?????
				}

				self.finishedLoading();
			}
		);
	};
}

require('util').inherits(MenuModule, PluginModule);

MenuModule.prototype.enter = function(client) {
	this.client = client;
	assert(_.isObject(client));

	this.initSequence();
};

MenuModule.prototype.leave = function() {
	var self = this;
	Object.keys(this.viewControllers).forEach(function entry(name) {
		self.viewControllers[name].detachClientEvents();
	});
};

MenuModule.prototype.addViewController = function(name, vc) {
	assert(!this.viewControllers[name]);
	this.viewControllers[name] = vc;
	return vc;
};

MenuModule.prototype.beforeArt = function() {	
	if(this.menuConfig.options.cls) {
		this.client.term.write(ansi.resetScreen());
	}

	if(_.isNumber(this.menuConfig.options.baudRate)) {
		this.client.term.write(ansi.setEmulatedBaudRate(this.menuConfig.options.baudRate));
	}
};

MenuModule.prototype.mciReady = function(mciData) {
};

MenuModule.prototype.standardMCIReadyHandler = function(mciData) {
	//
	//	A quick rundown:
	//	*	We may have mciData.menu, mciData.prompt, or both.
	//	*	Prompt form is favored over menu form if both are present.
	//	*	Standard/prefdefined MCI entries must load both (e.g. %BN is expected to resolve)
	//
	var self				= this;

	_.forEach(mciData, function entry(mciMap, name) {
		assert('menu' === name || 'prompt' === name);
		self.addViewController(name, new ViewController( { client : self.client } ));
	});
	
	var viewsReady = function(err) {
		//	:TODO: what should really happen here?
		if(err) {
			self.client.log.warn(err);
		}
	};

	if(self.viewControllers.menu) {
		var menuLoadOpts = {
			mciMap		: mciData.menu,
			callingMenu	: self,
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
};

MenuModule.prototype.finishedLoading = function() {

	var self = this;

	if(_.isNumber(this.menuConfig.options.nextTimeout) &&
		_.isString(this.menuConfig.next))
	{
		setTimeout(function nextTimeout() {
			self.client.gotoMenuModule( { name : self.menuConfig.next } );
		}, this.menuConfig.options.nextTimeout);
	} else {
		if(!_.isObject(self.menuConfig.form) && !_.isString(self.menuConfig.prompt) &&
			_.isString(self.menuConfig.action))
		{
			menuUtil.handleAction(self.client, null, self.menuConfig);
		}

	}
};