/* jslint node: true */
'use strict';

var PluginModule		= require('./plugin_module.js').PluginModule;
var theme				= require('./theme.js');
var art					= require('./art.js');
var Log					= require('./logger.js').log;
var ansi				= require('./ansi_term.js');
var asset				= require('./asset.js');
//var promptUtil			= require('./prompt_util.js');
var ViewController		= require('./view_controller.js').ViewController;

var async				= require('async');
var assert				= require('assert');
var _					= require('lodash');

exports.MenuModule		= MenuModule;

function MenuModule(options) {
	PluginModule.call(this, options);

	var self				= this;
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
				theme.displayThemeArt(dispOptions, function displayed(err, mciMap) {
					cb(err, mciMap);
				});
				break;

			case 'method' :
				//	:TODO: fetch and render via method/generator
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
						self.displayArtAsset(self.menuConfig.art, function displayed(err, mciMap) {
							mciData.menu = mciMap;
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
						//	:TODO: allow inline prompts in the future, e.g. @inline:memberName -> "memberName" : { ... }
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
					//	:TODO: what to do exactly?????
				}

				self.finishedLoading();
			}
		);
	};
/*
	this.initSequence2 = function() {
		async.waterfall(
			[
				function beforeDisplayArt(callback) {
					self.beforeArt();
					callback(null);
				},
				function displayArtAsset(callback) {
					var artAsset = asset.getArtAsset(self.menuConfig.art);

					if(!artAsset) {
						//	no art to display
						callback(null, null);
						return;
					}

					var dispOptions = {
						name		: artAsset.asset,
						client		: self.client,
						font		: self.menuConfig.font,
					};

					if('art' === artAsset.type) {
						theme.displayThemeArt(dispOptions, function displayedArt(err, mciMap) {
							callback(null, mciMap);
						});
					} else if('method' === artAsset.type) {
						//	:TODO: support fetching the asset (e.g. rendering into buffer) -> display it.
					}
				},
				function afterArtDisplayed(mciMap, callback) {
					if(mciMap) {
						self.mciReady(mciMap);
					}

					callback(null);
				},
				function loadPrompt(callback) {
					if(!_.isString(self.menuConfig.prompt)) {
						//	no prompt supplied
						callback(null, null);
						return;
					}

					var loadPromptOpts = {
						name	: self.menuConfig.prompt,
						client	: self.client,
					};

					promptUtil.loadPrompt(loadPromptOpts, function promptLoaded(err, prompt) {
						callback(err, prompt);
					});
				},
				function displayPrompt(prompt, callback) {
					if(!prompt) {
						callback(null);
						return;
					}

					//	:TODO: go to proper prompt location before displaying

					var dispOptions = {
						art		: prompt.artInfo.data,
						sauce	: prompt.artInfo.sauce,
						client	: self.client,
						font	: prompt.config.font,
					};


					art.display(dispOptions, function displayed(err, mciMap) {

					});
				}
			],
			function complete(err) {
				if(err) {
					//	:TODO: Log me!!! ... and what else?
					console.log(err);
				}

				self.finishedLoading();
			}
		);
	};
	*/
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
	if(this.menuConfig.options.clearScreen) {
		this.client.term.write(ansi.resetScreen());
	}
};

MenuModule.prototype.mciReady = function(mciData) {
};

MenuModule.prototype.finishedLoading = function() {

	var self = this;

	if(_.isNumber(this.menuConfig.options.nextTimeout) &&
		_.isString(this.menuConfig.next))
	{
		setTimeout(function nextTimeout() {
			self.client.gotoMenuModule( { name : self.menuConfig.next } );
		}, this.menuConfig.options.nextTimeout);
	}
};