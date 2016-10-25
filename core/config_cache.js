/* jslint node: true */
'use strict';

var Config				= require('./config.js').config;
var Log					= require('./logger.js').log;

var paths				= require('path');
var fs					= require('fs');
var Gaze				= require('gaze').Gaze;
var events				= require('events');
var util				= require('util');
var assert				= require('assert');
var hjson				= require('hjson');
var _					= require('lodash');

function ConfigCache() {
	events.EventEmitter.call(this);

	var self 	= this;
	this.cache	= {};	//	filePath -> HJSON
	this.gaze	= new Gaze();

	this.reCacheConfigFromFile = function(filePath, cb) {
		fs.readFile(filePath, { encoding : 'utf-8' }, function fileRead(err, data) {
			try {
				self.cache[filePath] = hjson.parse(data);
				cb(null, self.cache[filePath]);
			} catch(e) {
				Log.error( { filePath : filePath, error : e.toString() }, 'Failed recaching');
				cb(e);
			}
		});
	};


	this.gaze.on('error', function gazeErr(err) {

	});

	this.gaze.on('changed', function fileChanged(filePath) {
		assert(filePath in self.cache);

		Log.info( { path : filePath }, 'Configuration file changed; re-caching');

		self.reCacheConfigFromFile(filePath, function reCached(err) {
			if(err) {
				Log.error( { error : err.message, path : filePath } , 'Failed re-caching configuration');
			} else {
				self.emit('recached', filePath);
			}
		});
	});

}

util.inherits(ConfigCache, events.EventEmitter);

ConfigCache.prototype.getConfigWithOptions = function(options, cb) {
	assert(_.isString(options.filePath));

	var self		= this;
	var isCached	= (options.filePath in this.cache);

	if(options.forceReCache || !isCached) {
		this.reCacheConfigFromFile(options.filePath, function fileCached(err, config) {
			if(!err && !isCached) {
				self.gaze.add(options.filePath);
			}
			cb(err, config, true);
		});
	} else {
		cb(null, this.cache[options.filePath], false);
	}
};


ConfigCache.prototype.getConfig = function(filePath, cb) {
	this.getConfigWithOptions( { filePath : filePath }, cb);
};

ConfigCache.prototype.getModConfig = function(fileName, cb) {
	this.getConfig(paths.join(Config.paths.mods, fileName), cb);
};

module.exports = exports = new ConfigCache();