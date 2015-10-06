/* jslint node: true */
'use strict';

//	ENiGMA½
var moduleUtil			= require('./module_util.js');
var Log					= require('./logger.js').log;
var conf				= require('./config.js');	//	:TODO: remove me!
var Config				= require('./config.js').config;
var asset				= require('./asset.js');
var theme				= require('./theme.js');
var configCache			= require('./config_cache.js');
var MCIViewFactory		= require('./mci_view_factory.js').MCIViewFactory;

var fs					= require('fs');
var paths				= require('path');
var async				= require('async');
var assert				= require('assert');
var _					= require('lodash');

exports.loadMenu						= loadMenu;
exports.getFormConfigByIDAndMap			= getFormConfigByIDAndMap;
exports.handleAction					= handleAction;
exports.handleNext						= handleNext;
exports.applyThemeCustomization			= applyThemeCustomization;

function getMenuConfig(name, cb) {
	var menuConfig;

	async.waterfall(
		[
			function loadMenuJSON(callback) {
				configCache.getModConfig('menu.hjson', function loaded(err, menuJson) {
					callback(err, menuJson);
				});
			},
			function locateMenuConfig(menuJson, callback) {
				if(_.has(menuJson, [ 'menus', name ])) {
					menuConfig = menuJson.menus[name];
					callback(null);
				} else {
					callback(new Error('No menu entry for \'' + name + '\''));
				}
			},
			function loadPromptJSON(callback) {
				if(_.isString(menuConfig.prompt)) {
					configCache.getModConfig('prompt.hjson', function loaded(err, promptJson, reCached) {
						callback(err, promptJson);
					});
				} else {
					callback(null, null);
				}
			},
			function locatePromptConfig(promptJson, callback) {
				if(promptJson) {
					if(_.has(promptJson, [ 'prompts', menuConfig.prompt ])) {
						menuConfig.promptConfig = promptJson.prompts[menuConfig.prompt];
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
				var modAsset	= asset.getModuleAsset(menuConfig.module);
				var modSupplied	= null !== modAsset;

				var modLoadOpts = {
					name		: modSupplied ? modAsset.asset : 'standard_menu',
					path		: (!modSupplied || 'systemModule' === modAsset.type) ? __dirname : Config.paths.mods,
					category	: (!modSupplied || 'systemModule' === modAsset.type) ? null : 'mods',
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
					{ moduleName : modData.name, extraArgs : options.extraArgs, config : modData.config, info : modData.mod.modInfo },
					'Creating menu module instance');

				try {
					var moduleInstance = new modData.mod.getModule(
						{
							menuName	: options.name,
							menuConfig	: modData.config, 
							extraArgs	: options.extraArgs
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
	var mciReqKey = _.filter(_.pluck(_.sortBy(mciMap, 'code'), 'code'), function(mci) {
		return MCIViewFactory.UserViewCodes.indexOf(mci) > -1;
	}).join('');

	Log.trace( { mciKey : mciReqKey }, 'Looking for MCI configuration key');

	//
	//	Exact, explicit match?
	//
	if(_.isObject(formForId[mciReqKey])) {
		Log.trace( { mciKey : mciReqKey }, 'Using exact configuration key match');
		cb(null, formForId[mciReqKey]);
		return;
	} 

	//
	//	Generic match
	//
	if(_.has(formForId, 'mci') || _.has(formForId, 'submit')) {
		Log.trace('Using generic configuration');
		cb(null, formForId);
		return;
	}

	cb(new Error('No matching form configuration found for key \'' + mciReqKey + '\''));
}

//	:TODO: Most of this should be moved elsewhere .... DRY...
function callModuleMenuMethod(client, asset, path, formData, extraArgs) {
	if('' === paths.extname(path)) {
		path += '.js';
	}

	try {
		client.log.trace(
			{ path : path, methodName : asset.asset, formData : formData, extraArgs : extraArgs },
			'Calling menu method');

		var methodMod = require(path);
		methodMod[asset.asset](client.currentMenuModule, formData || { }, extraArgs);
	} catch(e) {
		client.log.error( { error : e.toString(), methodName : asset.asset }, 'Failed to execute asset method');
	}
}

function handleAction(client, formData, conf) {
	assert(_.isObject(conf));
	assert(_.isString(conf.action));

	var actionAsset = asset.parseAsset(conf.action);
	assert(_.isObject(actionAsset));

	switch(actionAsset.type) {
		case 'method' :
		case 'systemMethod' : 
			if(_.isString(actionAsset.location)) {
				callModuleMenuMethod(client, actionAsset, paths.join(Config.paths.mods, actionAsset.location), formData, conf.extraArgs);
			} else {
				if('systemMethod' === actionAsset.type) {
					//	:TODO: Need to pass optional args here -- conf.extraArgs and args between e.g. ()
					//	:TODO: Probably better as system_method.js
					callModuleMenuMethod(client, actionAsset, paths.join(__dirname, 'system_menu_method.js'), formData, conf.extraArgs);
				} else {
					//	local to current module
					var currentModule = client.currentMenuModule;
					if(_.isFunction(currentModule.menuMethods[actionAsset.asset])) {
						currentModule.menuMethods[actionAsset.asset](formData, conf.extraArgs);
					} else {
						client.log.warn( { method : actionAsset.asset }, 'Method does not exist in module');
					}
				}
			}
			break;

		case 'menu' :
			client.gotoMenuModule( { name : actionAsset.asset, formData : formData, extraArgs : conf.extraArgs } );
			break;
	}
}

function handleNext(client, nextSpec, conf) {
	assert(_.isString(nextSpec));

	var nextAsset = asset.getAssetWithShorthand(nextSpec, 'menu');

	conf = conf || {};
	var extraArgs = conf.extraArgs || {};

	switch(nextAsset.type) {
		case 'method' :
		case 'systemMethod' :
			if(_.isString(nextAsset.location)) {
				callModuleMenuMethod(client, nextAsset, paths.join(Config.paths.mods, actionAsset.location), {}, extraArgs);
			} else {
				if('systemMethod' === nextAsset.type) {
					//	:TODO: see other notes about system_menu_method.js here
					callModuleMenuMethod(client, nextAsset, paths.join(__dirname, 'system_menu_method.js'), {}, extraArgs);
				} else {
					//	local to current module
					var currentModule = client.currentMenuModule;
					if(_.isFunction(currentModule.menuMethods[actionAsset.asset])) {
						currentModule.menuMethods[actionAsset.asset]( { }, extraArgs );
					}
				}
			}
			break;

		case 'menu' :
			client.gotoMenuModule( { name : nextAsset.asset, extraArgs : extraArgs } );
			break;

		default :
			client.log.error( { nextSpec : nextSpec }, 'Invalid asset type for "next"');
			break;
	}
}

//	:TODO: custom art needs a way to be themed -- e.g. config.art.someArtThing -- what does this mean exactly?

//	:TODO: Seems better in theme.js, but that includes ViewController...which would then include theme.js
function applyThemeCustomization(options) {
	//
	//	options.name 		: menu/prompt name
	//	options.mci			: menu/prompt .mci section
	//	options.client		: client
	//	options.type		: menu|prompt
	//	options.formId		: (optional) form ID in cases where multiple forms may exist wanting their own customization
	//	options.config		: menu/prompt .config section
	//
	//	In the case of formId, the theme must include the ID as well, e.g.:
	//  {
	//	  ...
	//	  "2" : {
	//      "TL1" : { ... }
	//    }
	//	}
	//
	assert(_.isString(options.name));
	assert("menus" === options.type || "prompts" === options.type);
	assert(_.isObject(options.client));
	
	if(_.isUndefined(options.mci)) {
		options.mci = {};
	}

	if(_.isUndefined(options.config)) {
		options.config = {};
	}

	if(_.has(options.client.currentTheme, [ 'customization', options.type, options.name ])) {
		var themeConfig = options.client.currentTheme.customization[options.type][options.name];

		if(options.formId && _.has(themeConfig, options.formId.toString())) {
			//	form ID found - use exact match
			themeConfig = themeConfig[options.formId];
		}

		if(themeConfig.mci) {
			console.log('>>>>>>>>>>>>>>>>>>>>>>> ' + options.name)
			Object.keys(themeConfig.mci).forEach(function mciEntry(mci) {
				_.defaults(options.mci[mci], themeConfig.mci[mci]);
			});
		}

		if(themeConfig.config) {
			Object.keys(themeConfig.config).forEach(function confEntry(conf) {
				_.defaultsDeep(options.config[conf], themeConfig.config[conf]);
			});
		}
	}

	//	:TODO: apply generic stuff, e.g. "VM" (vs "VM1")
}
