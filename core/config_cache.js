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

function ConfigCache() {
	events.EventEmitter.call(this);

	var self 	= this;
	this.cache	= {};	//	filePath -> HJSON
	this.gaze	= new Gaze();

	this.reCacheJSONFromFile = function(filePath, cb) {
		fs.readFile(filePath, { encoding : 'utf-8' }, function fileRead(err, data) {
			try {
				//self.cache[filePath] = JSON.parse(stripJsonComments(data));
				self.cache[filePath] = hjson.parse(data);
				cb(null, self.cache[filePath]);
			} catch(e) {
				console.log(e)
				cb(e);
			}
		});
	};


	this.gaze.on('error', function gazeErr(err) {

	});

	this.gaze.on('changed', function fileChanged(filePath) {
		assert(filePath in self.cache);

		Log.info( { filePath : filePath }, 'JSON file changed; recaching');

		self.reCacheJSONFromFile(filePath, function reCached(err) {
			if(err) {
				Log.error( { error : err, filePath : filePath } , 'Error recaching JSON');
			} else {
				self.emit('recached', filePath);
			}
		});
	});

}

util.inherits(ConfigCache, events.EventEmitter);

ConfigCache.prototype.getConfig = function(filePath, cb) {
	var self		= this;

	if(filePath in this.cache) {
		cb(null, this.cache[filePath], false);
	} else {
		this.reCacheJSONFromFile(filePath, function fileCached(err, json) {
			if(!err) {
				self.gaze.add(filePath);
			}
			cb(err, json, true);
		});
	}
};

ConfigCache.prototype.getModConfig = function(fileName, cb) {
	this.getConfig(paths.join(Config.paths.mods, fileName), cb);
};

module.exports = exports = new ConfigCache();