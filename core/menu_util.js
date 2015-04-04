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
var _					= require('lodash');

var stripJsonComments	= require('strip-json-comments');

exports.loadMenu		= loadMenu;
exports.getFormConfig	= getFormConfig;

function loadMenu(options, cb) {

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
