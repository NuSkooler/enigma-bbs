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
exports.getRandomTheme			= getRandomTheme;


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
				cb(null, info);
			} catch(e) {
				cb(err);
			}
		}
	});
}

var availableThemes;

function loadAvailableThemes(cb) {
	//	lazy init
	async.waterfall(
		[
			function getDir(callback) {
				fs.readdir(Config.paths.art, function onReadDir(err, files) {
					callback(err, files);
				});
			},
			function filterFiles(files, callback) {
				var filtered = files.filter(function onFilter(file) {
					return fs.statSync(paths.join(Config.paths.art, file)).isDirectory(); 
				});
				callback(null, filtered);
			},
			function populateAvailable(filtered, callback) {
				filtered.forEach(function onTheme(themeId) {
					getThemeInfo(themeId, function onThemeInfo(err, info) {
						if(!err) {
							if(!availableThemes) {
								availableThemes = {};
							}
							availableThemes[themeId] = info;
						}
						callback(null);
					});
				});
			}
		],
		function onComplete(err) {
			if(err) {
				cb(err);
				return;
			}

			if(!availableThemes) {
				cb(new Error('No themes found'));
				return;
			}

			cb(null);
		}
	);
}

function getRandomTheme(cb) {
	var themeIds;
	if(availableThemes) {
		themeIds = Object.keys(availableThemes);
		cb(null, themeIds[Math.floor(Math.random() * themeIds.length)]);
	} else {
		loadAvailableThemes(function onThemes(err) {
			if(err) {
				cb(err);
			} else {
				themeIds = Object.keys(availableThemes);
				cb(null, themeIds[Math.floor(Math.random() * themeIds.length)]);
			}
		});
	}
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