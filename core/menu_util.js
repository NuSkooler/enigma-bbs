/* jslint node: true */
'use strict';

//	ENiGMA½
var moduleUtil			= require('./module_util.js');
var Log					= require('./logger.js').log;
var Config				= require('./config.js').config;
var asset				= require('./asset.js');
var getFullConfig		= require('./config_util.js').getFullConfig;
var MCIViewFactory		= require('./mci_view_factory.js').MCIViewFactory;
var acsUtil				= require('./acs_util.js');

var fs					= require('fs');
var paths				= require('path');
var async				= require('async');
var assert				= require('assert');
var _					= require('lodash');

exports.loadMenu						= loadMenu;
exports.getFormConfigByIDAndMap			= getFormConfigByIDAndMap;
exports.handleAction					= handleAction;
exports.handleNext						= handleNext;

function getMenuConfig(client, name, cb) {
	var menuConfig;

	async.waterfall(
		[
			function locateMenuConfig(callback) {
				if(_.has(client.currentTheme, [ 'menus', name ])) {
					menuConfig = client.currentTheme.menus[name];
					callback(null);
				} else {
					callback(new Error('No menu entry for \'' + name + '\''));
				}
			},
			function locatePromptConfig(callback) {
				if(_.isString(menuConfig.prompt)) {
					if(_.has(client.currentTheme, [ 'prompts', menuConfig.prompt ])) {
						menuConfig.promptConfig = client.currentTheme.prompts[menuConfig.prompt];
						callback(null);
					} else {
						callback(new Error('No prompt entry for \'' + menuConfig.prompt + '\''));
					}
				} else {
					callback(null);
				}
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
				getMenuConfig(options.client, options.name, function menuConfigLoaded(err, menuConfig) {
					callback(err, menuConfig);
				});
			},
			function loadMenuModule(menuConfig, callback) {

				const modAsset		= asset.getModuleAsset(menuConfig.module);
				const modSupplied	= null !== modAsset;

				const modLoadOpts = {
					name		: modSupplied ? modAsset.asset : 'standard_menu',
					path		: (!modSupplied || 'systemModule' === modAsset.type) ? __dirname : Config.paths.mods,
					category	: (!modSupplied || 'systemModule' === modAsset.type) ? null : 'mods',
				};

				moduleUtil.loadModuleEx(modLoadOpts, function moduleLoaded(err, mod) {
					const modData = {
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
							extraArgs	: options.extraArgs,
							client      : options.client,
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

	const actionAsset = asset.parseAsset(conf.action);
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
			client.currentMenuModule.gotoMenu(actionAsset.asset, { formData : formData, extraArgs : conf.extraArgs } );
			break;
	}
}

function handleNext(client, nextSpec, conf) {
	assert(_.isString(nextSpec) || _.isArray(nextSpec));
	
	if(_.isArray(nextSpec)) {
		nextSpec = acsUtil.getConditionalValue(client, nextSpec, 'next');
	}
	
	var nextAsset = asset.getAssetWithShorthand(nextSpec, 'menu');
	//	:TODO: getAssetWithShorthand() can return undefined - handle it!
	
	conf = conf || {};
	var extraArgs = conf.extraArgs || {};

	switch(nextAsset.type) {
		case 'method' :
		case 'systemMethod' :
			if(_.isString(nextAsset.location)) {
				callModuleMenuMethod(client, nextAsset, paths.join(Config.paths.mods, nextAsset.location), {}, extraArgs);
			} else {
				if('systemMethod' === nextAsset.type) {
					//	:TODO: see other notes about system_menu_method.js here
					callModuleMenuMethod(client, nextAsset, paths.join(__dirname, 'system_menu_method.js'), {}, extraArgs);
				} else {
					//	local to current module
					var currentModule = client.currentMenuModule;
					if(_.isFunction(currentModule.menuMethods[nextAsset.asset])) {
						currentModule.menuMethods[nextAsset.asset]( { }, extraArgs );
					}
				}
			}
			break;

		case 'menu' :
			client.currentMenuModule.gotoMenu(nextAsset.asset, { extraArgs : extraArgs } );
			break;

		default :
			client.log.error( { nextSpec : nextSpec }, 'Invalid asset type for "next"');
			break;
	}
}
