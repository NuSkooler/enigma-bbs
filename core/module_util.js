/* jslint node: true */
'use strict';

//	ENiGMA½
let Config		= require('./config.js').config;
let miscUtil	= require('./misc_util.js');

//	standard/deps
let fs 			= require('fs');
let paths		= require('path');
let _			= require('lodash');
let assert		= require('assert');
let async		= require('async');

//	exports
exports.loadModuleEx			= loadModuleEx;
exports.loadModule				= loadModule;
exports.loadModulesForCategory	= loadModulesForCategory;

function loadModuleEx(options, cb) {
	assert(_.isObject(options));
	assert(_.isString(options.name));
	assert(_.isString(options.path));

	const modConfig = _.isObject(Config[options.category]) ? Config[options.category][options.name] : null;

	if(_.isObject(modConfig) && false === modConfig.enabled) {
		cb(new Error('Module "' + options.name + '" is disabled'));
		return;
	}

	var mod;
	try {
		mod = require(paths.join(options.path, options.name + '.js'));
	} catch(e) {
		cb(e);
	}

	if(!_.isObject(mod.moduleInfo)) {
		cb(new Error('Module is missing "moduleInfo" section'));
		return;
	}

	if(!_.isFunction(mod.getModule)) {
		cb(new Error('Invalid or missing "getModule" method for module!'));
		return;
	}

	//	Ref configuration, if any, for convience to the module
	mod.runtime = { config : modConfig };

	cb(null, mod);
}

function loadModule(name, category, cb) {
	var path = Config.paths[category];

	if(!_.isString(path)) {
		cb(new Error('Not sure where to look for "' + name + '" of category "' + category + '"'));
		return;
	}

	loadModuleEx( { name : name, path : path, category : category }, function loaded(err, mod) {
		cb(err, mod);
	});
}

function loadModulesForCategory(category, iterator, complete) {
	
	fs.readdir(Config.paths[category], (err, files) => {
		if(err) {
			iterator(err);
			return;
		}

		const jsModules = files.filter(file => {
			return '.js' === paths.extname(file);
		});

		async.each(jsModules, (file, next) => {
			loadModule(paths.basename(file, '.js'), category, (err, mod) => {
				iterator(err, mod);
				next();
			});
		}, err => {
			if(complete) {
				complete(err);
			}
		});
	});
}
