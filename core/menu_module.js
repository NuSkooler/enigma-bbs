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
var Config				= require('./config.js').config;

var async				= require('async');
var assert				= require('assert');
var _					= require('lodash');

exports.MenuModule		= MenuModule;

//	:TODO: some of this is a bit off... should pause after finishedLoading()

function MenuModule(options) {
	PluginModule.call(this, options);

	var self				= this;
	this.menuName			= options.menuName;
	this.menuConfig			= options.menuConfig;
	this.client				= options.client;
    
    //  :TODO: this and the line below with .config creates empty ({}) objects in the theme --
    //  ...which we really should not do. If they aren't there already, don't use 'em.
	this.menuConfig.options	= options.menuConfig.options || {};
	this.menuMethods		= {};	//	methods called from @method's

	this.cls				= _.isBoolean(this.menuConfig.options.cls) ? 
		this.menuConfig.options.cls : 
		Config.menus.cls;

	this.menuConfig.config = this.menuConfig.config || {};

	this.initViewControllers();

	this.initSequence = function() {
		var mciData = { };

		async.series(
			[
				function beforeDisplayArt(callback) {
					self.beforeArt(callback);
				},
				function displayMenuArt(callback) {
					if(_.isString(self.menuConfig.art)) {
						theme.displayThemedAsset(
							self.menuConfig.art, 
							self.client, 
							self.menuConfig.options,	//	can include .font, .trailingLF, etc.
							function displayed(err, artData) {
								if(err) {
									self.client.log.debug( { art : self.menuConfig.art, err : err }, 'Could not display art');
								} else {
									mciData.menu = artData.mciMap;
								}
								callback(null);	//	non-fatal
							}
						);
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
						theme.displayThemedAsset(
							promptConfig.art, 
							self.client, 
							self.menuConfig.options,	//	can include .font, .trailingLF, etc.
							function displayed(err, artData) {
								if(!err) {
									mciData.prompt = artData.mciMap;
								}
								callback(err);
							});
					} else {						
						callback(null);
					}
				},
				function recordCursorPosition(callback) {
					if(self.shouldPause()) {
						self.client.once('cursor position report', function cpr(pos) {
							self.afterArtPos = pos;
							self.client.log.trace( { position : pos }, 'After art position recorded');
							callback(null);
						});
						self.client.term.write(ansi.queryPos());
					} else {
						callback(null);
					}
				},
				function afterArtDisplayed(callback) {
					self.mciReady(mciData, callback);
				},
				function displayPauseIfRequested(callback) {
					if(self.shouldPause()) {
						self.client.term.write(ansi.goto(self.afterArtPos[0], 1));

						//	:TODO: really need a client.term.pause() that uses the correct art/etc.
						theme.displayThemedPause( { client : self.client }, function keyPressed() {
							callback(null);
						});
					} else {
						callback(null);
					}
				}
			],
			function complete(err) {
				if(err) {
					console.log(err)
					//	:TODO: what to do exactly?????
					return self.prevMenu();
				}

				self.finishedLoading();
				self.autoNextMenu();
			}
		);
	};

	this.shouldPause = function() {
		return 'end' === self.menuConfig.options.pause || true === self.menuConfig.options.pause;
	};

	this.hasNextTimeout = function() {
		return _.isNumber(self.menuConfig.options.nextTimeout);
	};

	this.autoNextMenu = function() {
		function goNext() {
			if(_.isString(self.menuConfig.next) || _.isArray(self.menuConfig.next)) {
				menuUtil.handleNext(self.client, self.menuConfig.next);	
			} else {
				self.prevMenu();
			}
		}
        
        if(_.has(self.menuConfig, 'runtime.autoNext') && true === self.menuConfig.runtime.autoNext) {
			/*
				If 'next' is supplied, we'll use it. Otherwise, utlize fallback which
				may be explicit (supplied) or non-explicit (previous menu)

				'next' may be a simple asset, or a object with next.asset and
				extrArgs

				next: assetSpec

				-or-

				next: {
					asset: assetSpec
					extraArgs: ...
				}
			*/			
			if(self.hasNextTimeout()) {
				setTimeout(function nextTimeout() {
					goNext();
				}, this.menuConfig.options.nextTimeout);
			} else {
				goNext();
			}
		}
	};

	this.haveNext = function() {
		return (_.isString(this.menuConfig.next) || _.isArray(this.menuConfig.next));
	};
}

require('util').inherits(MenuModule, PluginModule);

require('./mod_mixins.js').ViewControllerManagement.call(MenuModule.prototype);


MenuModule.prototype.enter = function() {
	if(_.isString(this.menuConfig.status)) {
		this.client.currentStatus = this.menuConfig.status;
	} else {
		this.client.currentStatus = 'Browsing menus';
	}

	this.initSequence();
};

MenuModule.prototype.getSaveState = function() {
	//	nothing in base
};

MenuModule.prototype.restoreSavedState = function(savedState) {
	//	nothing in base
};

MenuModule.prototype.nextMenu = function(cb) {
	//
	//	If we don't actually have |next|, we'll go previous
	//
	if(!this.haveNext()) {
		this.prevMenu(cb);
		return;
	}

	//	:TODO: this, prevMenu(), and gotoMenu() need a default |cb| handler if none is supplied.
	//	...if the error is that we do not meet ACS requirements and did not get a match, then what?
	if(!cb) {
		cb = function(err) {
			if(err) {
				//	:TODO: Don't console.log() here!
				console.log(err)
			}
		}
	}
	this.client.menuStack.next(cb);
};

MenuModule.prototype.prevMenu = function(cb) {
	this.client.menuStack.prev(cb);
};

MenuModule.prototype.gotoMenu = function(name, options, cb) {
	this.client.menuStack.goto(name, options, cb);
};

MenuModule.prototype.leave = function() {
	this.detachViewControllers();
};

MenuModule.prototype.beforeArt = function(cb) {
	//
	//	Set emulated baud rate - note that some terminals will display
	//	part of the ESC sequence here (generally a single 'r') if they 
	//	do not support cterm style baud rates
	//
	if(_.isNumber(this.menuConfig.options.baudRate)) {
		this.client.term.write(ansi.setEmulatedBaudRate(this.menuConfig.options.baudRate));
	}

	if(this.cls) {
		this.client.term.write(ansi.resetScreen());
	}

	return cb(null);
};

MenuModule.prototype.mciReady = function(mciData, cb) {
	//	Reserved for sub classes
	cb(null);
};

MenuModule.prototype.standardMCIReadyHandler = function(mciData, cb) {
	//
	//	A quick rundown:
	//	*	We may have mciData.menu, mciData.prompt, or both.
	//	*	Prompt form is favored over menu form if both are present.
	//	*	Standard/prefdefined MCI entries must load both (e.g. %BN is expected to resolve)
	//
	var self = this;

	async.series(
		[
			function addViewControllers(callback) {
				_.forEach(mciData, function entry(mciMap, name) {
					assert('menu' === name || 'prompt' === name);
					self.addViewController(name, new ViewController( { client : self.client } ));
				});
				callback(null);
			},
			function createMenu(callback) {
				if(self.viewControllers.menu) {
					var menuLoadOpts = {
						mciMap		: mciData.menu,
						callingMenu	: self,
						withoutForm	: _.isObject(mciData.prompt),
					};

					self.viewControllers.menu.loadFromMenuConfig(menuLoadOpts, function menuLoaded(err) {
						callback(err);
					});
				} else {
					callback(null);
				}
			},
			function createPrompt(callback) {
				if(self.viewControllers.prompt) {
					var promptLoadOpts = {
						callingMenu		: self,
						mciMap			: mciData.prompt,
					};

					self.viewControllers.prompt.loadFromPromptConfig(promptLoadOpts, function promptLoaded(err) {
						callback(err);
					});
				} else {
					callback(null);
				}
			}
		],
		function complete(err) {
			cb(err);
		}
	);
};

MenuModule.prototype.finishedLoading = function() {
};