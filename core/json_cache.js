/* jslint node: true */
'use strict';

var Config				= require('./config.js').config;
var Log					= require('./logger.js').log;

var paths				= require('path');
var fs					= require('fs');
var Gaze				= require('gaze').Gaze;
var stripJsonComments	= require('strip-json-comments');
var assert				= require('assert');

module.exports = exports = new JSONCache();

function JSONCache() {

	var self 	= this;
	this.cache	= {};	//	filePath -> JSON
	this.gaze	= new Gaze();

	this.reCacheJSONFromFile = function(filePath, cb) {
		fs.readFile(filePath, { encoding : 'utf-8' }, function fileRead(err, data) {
			try {
				self.cache[filePath] = JSON.parse(stripJsonComments(data));
				cb(null, self.cache[filePath]);
			} catch(e) {
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
			}
		});
	});
}

JSONCache.prototype.getJSON = function(fileName, cb) {
	var self		= this;
	var filePath	= paths.join(Config.paths.mods, fileName);

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
