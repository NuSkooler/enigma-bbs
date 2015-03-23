/* jslint node: true */
'use strict';

var PluginModule		= require('./plugin_module.js').PluginModule;
var theme				= require('./theme.js');

var async				= require('async');
var assert				= require('assert');

exports.MenuModule		= MenuModule;

function MenuModule(menuConfig) {
	PluginModule.call(this);

	var self				= this;
	this.menuConfig			= menuConfig;

	this.viewControllers	= [];

	this.loadArt = function() {
		async.waterfall(
			[
				function displayArt(callback) {
					theme.displayThemeArt(self.menuConfig.art, self.client, function onArt(err, mciMap) {
						callback(err, mciMap);
					});
				},
				function artDisplayed(mciMap, callback) {
					if(!mciMap) {
						callback(null);
					} else {
						self.mciReady(mciMap);
					}
				}
			],
			function onComplete(err) {
				if(err) {
					//	:TODO: Log me!!! ... and what else?
				}
			}
		);
	};
}

require('util').inherits(MenuModule, PluginModule);

MenuModule.prototype.enter = function(client) {
	this.client = client;
	assert(typeof client !== 'undefined');
};

MenuModule.prototype.leave = function() {
	this.viewControllers.forEach(function onVC(vc) {
		vc.detachClientEvents();
	});
};

MenuModule.prototype.addViewController = function(vc) {
	this.viewControllers.push(vc);
	return vc;
};

MenuModule.prototype.mciReady = function(mciMap) {
};