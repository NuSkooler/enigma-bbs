/* jslint node: true */
'use strict';

//	ENiGMA½
var moduleUtil			= require('./module_util.js');
var Log					= require('./logger.js').log;
var conf				= require('./config.js');

var fs					= require('fs');
var paths				= require('path');
var async				= require('async');
var stripJsonComments	= require('strip-json-comments');

exports.loadMenu		= loadMenu;

function loadMenu(name, client, cb) {
	/*
		TODO: 
		* check access / ACS
		* 
	*/

	async.waterfall(
		[
			function loadMenuConfig(callback) {
				var configJsonPath = paths.join(conf.config.paths.mods, 'menu.json');

				fs.readFile(configJsonPath, { encoding : 'utf8' }, function onMenuConfig(err, data) {
					try {
						var menuJson = JSON.parse(stripJsonComments(data));

						if('object' !== typeof menuJson[name] || null === menuJson[name]) {
							callback(new Error('No configuration entry for \'' + name + '\''));
						} else {
							callback(err, menuJson[name]);
						}
					} catch(e) {
						callback(e);
					}
				});
			},
			function menuConfigLoaded(menuConfig, callback) {
				Log.debug( { config : menuConfig }, 'Menu configuration loaded');

				var moduleName = menuConfig.module || 'standard_menu';

				moduleUtil.loadModule(moduleName, 'mods', function onModule(err, mod) {
					callback(err, mod, menuConfig, moduleName);
				});
			},
		],
		function complete(err, mod, menuConfig, moduleName) {
			if(err) {
				cb(err);
			} else {
				Log.debug( { moduleName : moduleName, moduleInfo : mod.moduleInfo }, 'Loading menu module instance');
				cb(null, new mod.getModule(menuConfig));
			}
		}
	);
}