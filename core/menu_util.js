/* jslint node: true */
'use strict';

var moduleUtil			= require('./module_util.js');
var theme				= require('./theme.js');
var async				= require('async');
var Log					= require('./logger.js').log;

var menuJson			= require('../mods/menu.json');

exports.loadMenu		= loadMenu;

function loadMenu(name, client, cb) {
	//	want client.loadMenu(...). Replace current "goto module"/etc. with "switchMenu(...)"
	//	load options/etc -> call menuModule.enter(client, options)

	/*
		* Ensure JSON section exists
		* check access / ACS
		* 
		* ...MenuModule(menuSection) ... .enter(client)
	*/

	if('object' !== typeof menuJson[name] || null === menuJson[name]) {
		cb(new Error('No menu by the name of \'' + name + '\''));
		return;
	}

	var menuConfig = menuJson[name];
	Log.debug(menuConfig, 'Menu config');

	var moduleName = menuConfig.module || 'standard_menu';

	moduleUtil.loadModule(moduleName, 'mods', function onModule(err, mod) {
		if(err) {
			cb(err);
		} else {
			Log.debug( { moduleName : moduleName, moduleInfo : mod.moduleInfo }, 'Loading menu module');

			var modInst = new mod.getModule(menuConfig);
			cb(null, modInst);
		}
	});
}