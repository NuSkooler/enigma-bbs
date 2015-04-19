/* jslint node: true */
'use strict';

//	ENiGMA½
var moduleUtil			= require('./module_util.js');
var Log					= require('./logger.js').log;
var conf				= require('./config.js');	//	:TODO: remove me!
var Config				= require('./config.js').config;
var asset				= require('./asset.js');
var theme				= require('./theme.js');

var fs					= require('fs');
var paths				= require('path');
var async				= require('async');
var assert				= require('assert');
var _					= require('lodash');

var stripJsonComments	= require('strip-json-comments');

exports.loadMenu		= loadMenu;
exports.getFormConfig	= getFormConfig;


function loadModJSON(fileName, cb) {
	//	:TODO: really need to cache menu.json and prompt.json only reloading if they change - see chokidar & gaze npms
	var filePath = paths.join(Config.paths.mods, fileName);

	fs.readFile(filePath, { encoding : 'utf8' }, function jsonData(err, data) {
		try {
			var json = JSON.parse(stripJsonComments(data));
			cb(null, json);
		} catch(e) {
			cb(e);
		}
	});
}

function getMenuConfig(name, cb) {
	var menuConfig;

	async.waterfall(
		[
			function loadMenuJSON(callback) {
				loadModJSON('menu.json', function loaded(err, menuJson) {
					callback(err, menuJson);
				});
			},
			function locateMenuConfig(menuJson, callback) {
				if(_.isObject(menuJson[name])) {
					menuConfig = menuJson[name];
					callback(null);
				} else {
					callback(new Error('No menu entry for \'' + name + '\''));
				}
			},
			function loadPromptJSON(callback) {
				if(_.isString(menuConfig.prompt)) {
					loadModJSON('prompt.json', function loaded(err, promptJson) {
						callback(err, promptJson);
					});
				} else {
					callback(null, null);
				}
			},
			function locatePromptConfig(promptJson, callback) {
				if(promptJson) {
					if(_.isObject(promptJson[menuConfig.prompt])) {
						menuConfig.promptConfig = promptJson[menuConfig.prompt];
					} else {
						callback(new Error('No prompt entry for \'' + menuConfig.prompt + '\''));
						return;
					}		
				}
				callback(null);
			}			
		],
		function complete(err) {
			cb(err, menuConfig);
		}
	);
}

function loadMenu(options, cb) {
	assert(_.isObject(options));
	assert(_.isString(options.name));
	assert(_.isObject(options.client));	

	async.waterfall(
		[
			function getMenuConfiguration(callback) {
				getMenuConfig(options.name, function menuConfigLoaded(err, menuConfig) {
					callback(err, menuConfig);
				});
			},
			function loadMenuModule(menuConfig, callback) {
				var moduleName = menuConfig.module || 'standard_menu';

				moduleUtil.loadModule(moduleName, 'mods', function moduleLoaded(err, mod) {
					var modData = {
						name	: moduleName,
						config	: menuConfig,
						mod		: mod,
					};

					callback(err, modData);
				});
			},			
			function createModuleInstance(modData, callback) {
				Log.debug(
					{ moduleName : modData.name, args : options.args, config : modData.config, info : modData.mod.modInfo },
					'Creating menu module instance');

				try {
					var moduleInstance = new modData.mod.getModule( { menuConfig : modData.config, args : options.args } );
					callback(null, moduleInstance);
				} catch(e) {
					callback(e);
				}
			}
		],
		function complete(err, modInst) {
			cb(err, modInst);
		}
	);
}

function loadMenu2(options, cb) {

	assert(options);
	assert(options.name);
	assert(options.client);

	var name	= options.name;
	var client	= options.client;
	/*
		TODO: 
		* check access / ACS
		* 
	*/

	async.waterfall(
		[
			//	:TODO: Need a good way to cache this information & only (re)load if modified
			function loadMenuConfig(callback) {
				var configJsonPath = paths.join(conf.config.paths.mods, 'menu.json');

				fs.readFile(configJsonPath, { encoding : 'utf8' }, function onMenuConfig(err, data) {
					try {
						var menuJson = JSON.parse(stripJsonComments(data));

						if(!_.isObject(menuJson[name])) {
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
				var moduleName = menuConfig.module || 'standard_menu';

				moduleUtil.loadModule(moduleName, 'mods', function onModule(err, mod) {
					callback(err, mod, menuConfig, moduleName);
				});
			}
		],
		function complete(err, mod, menuConfig, moduleName) {
			if(err) {
				cb(err);
			} else {
				Log.debug(
					{ moduleName : moduleName, args : options.args, config : menuConfig, info : mod.moduleInfo },
					'Creating menu module instance');

				//	:TODO: throw from MenuModule() - catch here
				cb(null, new mod.getModule({ menuConfig : menuConfig, args : options.args } ));
			}
		}
	);
}

function getFormConfig(menuConfig, formId, mciMap, cb) {
	assert(_.isObject(menuConfig));

	if(!_.isObject(menuConfig.form)) {
		cb(new Error('Invalid or missing \'form\' member for menu'));
		return;
	}

	if(!_.isObject(menuConfig.form[formId])) {
		cb(new Error('No form found for formId ' + formId));
		return;
	}

	var formForId = menuConfig.form[formId];

	var mciReqKey = _.sortBy(Object.keys(mciMap), String).join('');
	if(_.isObject(formForId[mciReqKey])) {
		cb(null, formForId[mciReqKey]);
		return;
	} 

	if(_.has(formForId, 'mci') || _.has(formForId, 'submit')) {
		cb(null, formForId);
		return;
	}

	cb(new Error('No matching form configuration found'));
}
