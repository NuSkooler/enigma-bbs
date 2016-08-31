/* jslint node: true */
'use strict';

//	ENiGMA½
var moduleUtil			= require('./module_util.js');
var Log					= require('./logger.js').log;
var Config				= require('./config.js').config;
var asset				= require('./asset.js');
var MCIViewFactory		= require('./mci_view_factory.js').MCIViewFactory;

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
				getMenuConfig(options.client, options.name, (err, menuConfig) => {
					return callback(err, menuConfig);
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

				moduleUtil.loadModuleEx(modLoadOpts, (err, mod) => {
					const modData = {
						name	: modLoadOpts.name,
						config	: menuConfig,
						mod		: mod,
					};

					return callback(err, modData);
				});
			},		
			function createModuleInstance(modData, callback) {
				Log.debug(
					{ moduleName : modData.name, extraArgs : options.extraArgs, config : modData.config, info : modData.mod.modInfo },
					'Creating menu module instance');

				try {
					const moduleInstance = new modData.mod.getModule({
						menuName		: options.name,
						menuConfig		: modData.config, 
						extraArgs		: options.extraArgs,
						client			: options.client,
						lastMenuResult	: options.lastMenuResult,
					});
					return callback(null, moduleInstance);
				} catch(e) {
					return callback(e);
				}
			}
		],
		(err, modInst) => {
			return cb(err, modInst);
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
function callModuleMenuMethod(client, asset, path, formData, extraArgs, cb) {
	if('' === paths.extname(path)) {
		path += '.js';
	}

	try {
		client.log.trace(
			{ path : path, methodName : asset.asset, formData : formData, extraArgs : extraArgs },
			'Calling menu method');

		const methodMod = require(path);
		return methodMod[asset.asset](client.currentMenuModule, formData || { }, extraArgs, cb);
	} catch(e) {
		client.log.error( { error : e.toString(), methodName : asset.asset }, 'Failed to execute asset method');
		return cb(e);
	}
}

function handleAction(client, formData, conf, cb) {
	assert(_.isObject(conf));
	assert(_.isString(conf.action));

	const actionAsset = asset.parseAsset(conf.action);
	assert(_.isObject(actionAsset));

	switch(actionAsset.type) {
		case 'method' :
		case 'systemMethod' : 
			if(_.isString(actionAsset.location)) {
				return callModuleMenuMethod(
					client, 
					actionAsset, 
					paths.join(Config.paths.mods, actionAsset.location), 
					formData, 
					conf.extraArgs, 
					cb);
			} else if('systemMethod' === actionAsset.type) {
				//	:TODO: Need to pass optional args here -- conf.extraArgs and args between e.g. ()
				//	:TODO: Probably better as system_method.js
				return callModuleMenuMethod(
					client, 
					actionAsset, 
					paths.join(__dirname, 'system_menu_method.js'), 
					formData, 
					conf.extraArgs, 
					cb);
			} else {
				//	local to current module
				const currentModule = client.currentMenuModule;
				if(_.isFunction(currentModule.menuMethods[actionAsset.asset])) {
					return currentModule.menuMethods[actionAsset.asset](formData, conf.extraArgs, cb);
				}
				
				const err = new Error('Method does not exist');
				client.log.warn( { method : actionAsset.asset }, err.message);
				return cb(err);
			}

		case 'menu' :
			return client.currentMenuModule.gotoMenu(actionAsset.asset, { formData : formData, extraArgs : conf.extraArgs }, cb );
	}
}

function handleNext(client, nextSpec, conf, cb) {
	assert(_.isString(nextSpec) || _.isArray(nextSpec));
	
	if(_.isArray(nextSpec)) {
		nextSpec = client.acs.getConditionalValue(nextSpec, 'next');
	}
	
	const nextAsset = asset.getAssetWithShorthand(nextSpec, 'menu');
	//	:TODO: getAssetWithShorthand() can return undefined - handle it!
	
	conf = conf || {};
	const extraArgs = conf.extraArgs || {};

	//	:TODO: DRY this with handleAction()
	switch(nextAsset.type) {
		case 'method' :
		case 'systemMethod' :
			if(_.isString(nextAsset.location)) {
				return callModuleMenuMethod(client, nextAsset, paths.join(Config.paths.mods, nextAsset.location), {}, extraArgs, cb);
			} else if('systemMethod' === nextAsset.type) {
				//	:TODO: see other notes about system_menu_method.js here
				return callModuleMenuMethod(client, nextAsset, paths.join(__dirname, 'system_menu_method.js'), {}, extraArgs, cb);
			} else {
				//	local to current module
				const currentModule = client.currentMenuModule;
				if(_.isFunction(currentModule.menuMethods[nextAsset.asset])) {
					const formData = {};	//	 we don't have any
					return currentModule.menuMethods[nextAsset.asset]( formData, extraArgs, cb );
				}

				const err = new Error('Method does not exist');
				client.log.warn( { method : nextAsset.asset }, err.message);
				return cb(err);	
			}

		case 'menu' :
			return client.currentMenuModule.gotoMenu(nextAsset.asset, { extraArgs : extraArgs }, cb );
	}

	const err = new Error('Invalid asset type for "next"');
	client.log.error( { nextSpec : nextSpec }, err.message);
	return cb(err);
}
