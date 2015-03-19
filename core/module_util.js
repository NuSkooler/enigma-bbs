/* jslint node: true */
'use strict';

var fs 			= require('fs');
var paths		= require('path');

var conf		= require('./config.js');
var miscUtil	= require('./misc_util.js');

//	exports
exports.loadModule				= loadModule;
exports.loadModulesForCategory	= loadModulesForCategory;

function loadModule(name, category, cb) {
	var config	= conf.config;
	var path	= config.paths[category];

	if(!path) {
		cb(new Error('not sure where to look for "' + name + '" of category "' + category + '"'));
		return;
	}

	//	update conf to point at this module's section, if any
	config = config[category] ? config[category][name] : null;
	
	if(config && false === config.enabled) {
		cb(new Error('module "' + name + '" is disabled'));
		return;
	}

	try {
		var mod = require(paths.join(path, name + '.js'));

		if(!mod.moduleInfo) {
			cb(new Error('module is missing \'moduleInfo\' section'));
			return;
		}

		if(!mod.getModule || typeof mod.getModule !== 'function') {
			cb(new Error('Invalid or missing missing \'getModule\' method'));
			return;
		}

		mod.runtime = {
			config : config
		};

		cb(null, mod);
	} catch(e) {
		cb(e);
	}
}

function loadModulesForCategory(category, cb) {
	var path = conf.config.paths[category];

	fs.readdir(path, function onFiles(err, files) {
		if(err) {
			cb(err);
			return;
		}

		var filtered = files.filter(function onFilter(file) { return '.js' === paths.extname(file); });
		filtered.forEach(function onFile(file) {
			var modName = paths.basename(file, '.js');
			loadModule(paths.basename(file, '.js'), category, cb);
		});
	});
}
