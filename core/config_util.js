/* jslint node: true */
'use strict';

var configCache			= require('./config_cache.js');

var paths				= require('path');

exports.getFullConfig	= getFullConfig;

function getFullConfig(filePath, cb) {
	//	|filePath| is assumed to be in 'mods' if it's only a file name
	if('.' === paths.dirname(filePath)) {
		filePath = paths.join(__dirname, '../mods', filePath);
	}

	configCache.getConfig(filePath, function loaded(err, configJson) {
		cb(err, configJson);
	});
}