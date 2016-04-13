/* jslint node: true */
'use strict';

//	ENiGMA½
const Config	= require('./config.js').config;

//	deps
const fs 		= require('fs');
const paths		= require('path');
const _			= require('lodash');
const assert	= require('assert');
const async		= require('async');

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
		return cb(new Error('Module "' + options.name + '" is disabled'));
	}

	let mod;
	try {		
		mod = require(paths.join(options.path, options.name + '.js'));
	} catch(e) {
		return cb(e);
	}

	if(!_.isObject(mod.moduleInfo)) {
		return cb(new Error('Module is missing "moduleInfo" section'));
	}

	if(!_.isFunction(mod.getModule)) {
		return cb(new Error('Invalid or missing "getModule" method for module!'));
	}

	//	Ref configuration, if any, for convience to the module
	mod.runtime = { config : modConfig };

	cb(null, mod);
}

function loadModule(name, category, cb) {
	const path = Config.paths[category];

	if(!_.isString(path)) {
		return cb(new Error(`Not sure where to look for "${name}" of category "${category}"`));
	}

	loadModuleEx( { name : name, path : path, category : category }, function loaded(err, mod) {
		cb(err, mod);
	});
}

function loadModulesForCategory(category, iterator, complete) {
	
	fs.readdir(Config.paths[category], (err, files) => {
		if(err) {
			return iterator(err);
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
