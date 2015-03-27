/* jslint node: true */
'use strict';

//	ENiGMA½
var moduleUtil			= require('./module_util.js');
var Log					= require('./logger.js').log;
var conf				= require('./config.js');

var fs					= require('fs');
var paths				= require('path');
var async				= require('async');
var assert				= require('assert');

var stripJsonComments	= require('strip-json-comments');

exports.loadMenu		= loadMenu;
exports.getFormConfig	= getFormConfig;

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



function getFormConfig(menuConfig, mciMap, cb) {
	async.filter(
		menuConfig.form, 
		function check(form, callback) {
			if(!form.mciReq || form.mciReq.length <= 0) {
				callback(false);
				return;
			}

			var count = form.mciReq.length;
			for(var i = 0; i < count; ++i) {
				if(!mciMap[form.mciReq[i]]) {
					callback(false);
				}
			}
			callback(true);
		},
		function filtered(form) {
			if(form.length > 0) {
				assert(1 === form.length);
				cb(form[0]);
			} else {
				cb(null);
			}
		}
	);
}

/*
function getFormConfig(menuConfig, mciMap) {
	var count = menuConfig.form ? menuConfig.form.length : 0;
	var mciReq;
	for(var i = 0; i < count; ++i) {
		mciReq = menuConfig.form[i].mciReq;
		if(mciReq) {
			if(mciReq.length === mciMap.length) {
				for(var m = 0; m < mciReq.length; ++m) {
					if(!mciMap[mciReq[m]]) {
						return null;
					}
				}
			}
		}
	}
}
*/