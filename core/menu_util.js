/* jslint node: true */
'use strict';

var moduleUtil			= require('./module_util.js');
var theme				= require('./theme.js');
var async				= require('async');

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

	moduleUtil.loadModule(menuConfig.module || 'standard_menu', 'mods', function onModule(err, mod) {
		if(err) {
			cb(err);
		} else {
			var modInst = new mod.getModule(menuConfig);
			cb(null, modInst);
		}
	});
}