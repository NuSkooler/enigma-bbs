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

exports.loadMenu						= loadMenu;
exports.getFormConfigByIDAndMap			= getFormConfigByIDAndMap;
exports.handleAction					= handleAction;
exports.applyThemeCustomization			= applyThemeCustomization;


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

				var modSupplied = _.isString(menuConfig.module);

				var modLoadOpts = {
					name		: modSupplied ? menuConfig.module : 'standard_menu',
					path		: modSupplied ? Config.paths.mods : __dirname,
					category	: modSupplied ? 'mods' : null,
				};

				moduleUtil.loadModuleEx(modLoadOpts, function moduleLoaded(err, mod) {
					var modData = {
						name	: modLoadOpts.name,
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
					var moduleInstance = new modData.mod.getModule(
						{
							menuName	: options.name,
							menuConfig	: modData.config, 
							args		: options.args,
						});
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

function getFormConfigByIDAndMap(menuConfig, formId, mciMap, cb) {
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
	Log.trace( { mciKey : mciReqKey }, 'Looking for MCI configuration key');
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

function handleAction(client, formData, conf) {
	assert(_.isObject(conf));
	assert(_.isString(conf.action));

	var actionAsset = asset.parseAsset(conf.action);
	assert(_.isObject(actionAsset));

	function callModuleMenuMethod(path) {
		if('' === paths.extname(path)) {
			path += '.js';
		}

		try {
			var methodMod = require(path);
			methodMod[actionAsset.asset](client.currentMenuModule, formData, conf.extraArgs);
		} catch(e) {
			Log.error( { error : e.toString(), methodName : actionAsset.asset }, 'Failed to execute asset method');
		}
	}

	switch(actionAsset.type) {
		case 'method' :
		case 'systemMethod' : 
			if(_.isString(actionAsset.location)) {
				callModuleMenuMethod(paths.join(Config.paths.mods, actionAsset.location));
			} else {
				if('systemMethod' === actionAsset.type) {
					callModuleMenuMethod(paths.join(__dirname, 'system_menu_method.js'));
				} else {
					//	local to current module
					var currentModule = client.currentMenuModule;
					if(_.isFunction(currentModule.menuMethods[actionAsset.asset])) {
						currentModule.menuMethods[actionAsset.asset](formData, conf.extraArgs);
					}
				}
			}
			break;

		case 'menu' :
			client.gotoMenuModule( { name : actionAsset.asset, formData : formData, extraArgs : conf.extraArgs } );
			break;
	}
}

function applyThemeCustomization(options) {
	//
	//	options.name : menu/prompt name
	//	options.configMci	: menu or prompt config (menu.json / prompt.json) specific mci section
	//	options.client	: client
	//
	assert(_.isString(options.name));
	assert(_.isObject(options.client));

	console.log(options.configMci)
	
	if(_.isUndefined(options.configMci)) {
		options.configMci = {};
	}

	if(_.has(options.client.currentTheme, [ 'customization', 'byName', options.name ])) {
		var themeConfig = options.client.currentTheme.customization.byName[options.name];
		Object.keys(themeConfig).forEach(function mciEntry(mci) {
			_.defaults(options.configMci[mci], themeConfig[mci]);		
		});
	}

	//	:TODO: apply generic stuff, e.g. "VM" (vs "VM1")
}