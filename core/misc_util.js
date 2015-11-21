/* jslint node: true */
'use strict';

var paths					= require('path');

exports.isProduction		= isProduction;
exports.isDevelopment		= isDevelopment;
exports.valueWithDefault	= valueWithDefault;
exports.resolvePath			= resolvePath;

function isProduction() {
	var env = process.env.NODE_ENV || 'dev';
	return 'production' === env;
}

function isDevelopment() {
	return (!(isProduction()));
}

function valueWithDefault(val, defVal) {
	return (typeof val !== 'undefined' ? val : defVal);
}

function resolvePath(path) {
	if(path.substr(0, 2) === '~/') {
		var mswCombined = process.env.HOMEDRIVE + process.env.HOMEPATH;
		path = (process.env.HOME || mswCombined || process.env.HOMEPATH || process.env.HOMEDIR || process.cwd()) + path.substr(1);
	}
	return paths.resolve(path);
}