/* jslint node: true */
'use strict';

var Config		= require('./config.js').config;
var art			= require('./art.js');
var miscUtil	= require('./misc_util.js');
var fs			= require('fs');
var paths		= require('path');
var async		= require('async');

exports.getThemeInfo			= getThemeInfo;
exports.getThemeArt				= getThemeArt;


//	getThemeInfo(themeName)
/*
//	getThemeFile(themeShortName, name)
	//	getArt(name, {
		basePath : themeDir,
	}
*/

function getThemeInfo(themeID, cb) {
	var path = paths.join(Config.paths.art, themeID, 'theme_info.json');

	fs.readFile(path, function onData(err, data) {
		if(err) {
			cb(err);
		} else {
			try {
				var info = JSON.parse(data);
				return info;
			} catch(e) {
				cb(err);
			}
		}
	});
}

function getThemeArt(name, themeID, options, cb) {
	//	allow options to be optional
	if(typeof cb === 'undefined') {
		cb		= options;
		options = {};
	}

	//	set/override some options
	options.asAnsi		= true;
	options.readSauce	= true;	//	can help with encoding
	options.random		= miscUtil.valueWithDefault(options.random, true);
	options.basePath	= paths.join(Config.paths.art, themeID);

	art.getArt(name, options, function onThemeArt(err, theArt) {
		if(err) {
			//	try fallback
			options.basePath = Config.paths.art;
			art.getArt(name, options, function onFallbackArt(err, theArt) {
				if(err) {
					cb(err);
				} else {
					cb(null, theArt.data);
				}
			});
		} else {
			cb(null, theArt.data);
		}
	});
}