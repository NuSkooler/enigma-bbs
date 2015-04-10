/* jslint node: true */
'use strict';

var PluginModule		= require('./plugin_module.js').PluginModule;
var theme				= require('./theme.js');
var Log					= require('./logger.js').log;
var ansi				= require('./ansi_term.js');

var async				= require('async');
var assert				= require('assert');

exports.MenuModule		= MenuModule;

function MenuModule(options) {
	PluginModule.call(this, options);

	var self				= this;
	this.menuConfig			= options.menuConfig;
	this.menuConfig.options	= options.menuConfig.options || {};
	this.menuMethods		= {};
	this.viewControllers	= [];

	this.initSequence = function() {
		async.waterfall(
			[
				function beforeDisplayArt(callback) {
					self.beforeArt();
					callback(null);
				},
				function displayArt(callback) {
					theme.displayThemeArt(self.menuConfig.art, self.client, function onArt(err, mciMap) {
						//	:TODO: If the art simply is not found, or failed to load... we need to continue
						if(err) {
							console.log('TODO: log this error properly... maybe handle slightly diff.');
						}
						callback(null, mciMap);
					});
				},
				function afterArtDisplayed(mciMap, callback) {
					if(mciMap) {
						self.mciReady(mciMap);
					}

					callback(null);
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
}

require('util').inherits(MenuModule, PluginModule);

MenuModule.prototype.enter = function(client) {
	this.client = client;
	assert(typeof client !== 'undefined');

	this.initSequence();
};

MenuModule.prototype.leave = function() {
	var count = this.viewControllers.length;
	for(var i = 0; i < count; ++i) {
		this.viewControllers[i].detachClientEvents();
	}
};

MenuModule.prototype.addViewController = function(vc) {
	this.viewControllers.push(vc);
	return vc;
};

MenuModule.prototype.beforeArt = function() {	
	if(this.menuConfig.options.clearScreen) {
		this.client.term.write(ansi.resetScreen());
	}

};

MenuModule.prototype.mciReady = function(mciMap) {
};

MenuModule.prototype.finishedLoading = function() {
};