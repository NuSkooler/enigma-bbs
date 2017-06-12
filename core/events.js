/* jslint node: true */
'use strict';

const Config				= require('./config.js');
const fs					= require('fs');
const path					= require('path');
const events				= require('events');
const logger				= require('./logger.js');

var eventEmitter = new events.EventEmitter();

var self = module.exports = {
	emit: function(eventName, args) {
		logger.log.debug("Emit "+eventName);
		eventEmitter.emit(eventName, args);
	},
	on: function(eventName, listener) {
		logger.log.debug("Register listener for "+eventName);
		eventEmitter.on(eventName, listener);
	},
	remove: function(eventName, listener) {
		logger.log.debug("Remove listener for "+eventName);
		eventEmitter.removeListener(eventName, listener);
	},
	registerModules: function() {
		const moduleUtil = require('./module_util.js');

		moduleUtil.getModulePaths().forEach(function(modulePath) {
			var mods = fs.readdirSync(modulePath);
			mods.forEach(function(item) {
				var modPath = modulePath+item;
				if (item.substr(item.length-3) != '.js') {
					modPath += path.sep+item+'.js';
				}
				if (fs.existsSync(modPath)) {
					var module = require(modPath);

					if (module.registerEvents !== undefined) {
						logger.log.debug(modPath+" calling registerEvents function");
						module.registerEvents();
					} else {
						logger.log.debug(modPath+" has no registerEvents function");
					}
				} else {
					logger.log.debug(modPath+" - file not found");
				}
			});
		});
	}
}
