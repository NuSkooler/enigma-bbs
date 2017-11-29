/* jslint node: true */
'use strict';
const Config	= require('./config.js').config;
const configCache			= require('./config_cache.js');
const paths				= require('path');

exports.getFullConfig	= getFullConfig;

function getFullConfig(filePath, cb) {
	//	|filePath| is assumed to be in the config path if it's only a file name
	if('.' === paths.dirname(filePath)) {
		filePath = paths.join(Config.paths.config, filePath);
	}

	configCache.getConfig(filePath, function loaded(err, configJson) {
		cb(err, configJson);
	});
}