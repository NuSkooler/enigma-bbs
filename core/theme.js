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
exports.initAvailableThemes		= initAvailableThemes;
exports.displayThemeArt			= displayThemeArt;

function getThemeInfo(themeID, cb) {
	var path = paths.join(Config.paths.themes, themeID, 'theme_info.json');

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

var availableThemes = {};

function initAvailableThemes(cb) {
	async.waterfall(
		[
			function getDir(callback) {
				fs.readdir(Config.paths.themes, function onReadDir(err, files) {					
					callback(err, files);
				});
			},
			function filterFiles(files, callback) {				
				var filtered = files.filter(function onFilter(file) {
					return fs.statSync(paths.join(Config.paths.themes, file)).isDirectory(); 
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
					});
				});
				callback(null);
			}
		],
		function onComplete(err) {
			if(err) {
				cb(err);
				return;
			}

			cb(null, availableThemes.length);
		}
	);
}

function getRandomTheme(cb) {
	if(Object.getOwnPropertyNames(availableThemes).length > 0) {
		var themeIds = Object.keys(availableThemes);
		cb(null, themeIds[Math.floor(Math.random() * themeIds.length)]);
	} else {
		cb(new Error('No themes available'));
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
	options.basePath	= paths.join(Config.paths.themes, themeID);

	art.getArt(name, options, function onThemeArt(err, artInfo) {
		if(err) {
			//	try fallback of art directory
			options.basePath = Config.paths.art;
			art.getArt(name, options, function onFallbackArt(err, artInfo) {
				if(err) {
					cb(err);
				} else {
					cb(null, artInfo);
				}
			});
		} else {
			cb(null, artInfo);
		}
	});
}

function displayThemeArt(name, client, cb) {
	getThemeArt(name, client.user.properties.art_theme_id, function onArt(err, artInfo) {
		if(err) {
			cb(err);
		} else {
			var iceColors = false;
			if(artInfo.sauce && artInfo.sauce.ansiFlags) {
				if(artInfo.sauce.ansiFlags & (1 << 0)) {
					iceColors = true;
				}
			}

			console.log(artInfo.sauce.flags);
			art.display( { art : artInfo.data, client : client, iceColors : iceColors }, function onDisplayed(err, mci) {
				cb(err, mci);
			});
		}
	});
}