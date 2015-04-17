/* jslint node: true */
'use strict';

var Config		= require('./config.js').config;
var art			= require('./art.js');
var miscUtil	= require('./misc_util.js');
var Log			= require('./logger.js').log;

var fs			= require('fs');
var paths		= require('path');
var async		= require('async');
var _			= require('lodash');
var assert		= require('assert');

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
				//	:TODO: strip comments/etc. ala menu.json
				var info = JSON.parse(data);

				//
				//	Create some handy helpers
				//
				info.getPasswordChar = function() {
					var pwChar = Config.defaults.passwordChar;
					if(_.isObject(info.config)) {
						if(_.isString(info.config.passwordChar)) {
							pwChar = info.config.passwordChar.substr(0, 1);
						} else if(_.isNumber(info.config.passwordChar)) {
							pwChar = String.fromCharCode(info.config.passwordChar);
						}
					}
					return pwChar;
				};

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
							Log.debug( { info : info }, 'Theme loaded');
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
	if(_.isUndefined(cb)) {
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

function displayThemeArt(options, cb) {
	assert(_.isObject(options));
	assert(_.isObject(options.client));
	assert(_.isString(options.name));

	getThemeArt(options.name, options.client.user.properties.art_theme_id, function onArt(err, artInfo) {
		if(err) {
			cb(err);
		} else {
			var iceColors = false;
			if(artInfo.sauce && artInfo.sauce.ansiFlags) {
				if(artInfo.sauce.ansiFlags & (1 << 0)) {
					iceColors = true;
				}
			}

			var dispOptions = {
				art			: artInfo.data,
				sauce		: artInfo.sauce,
				client		: options.client,
				iceColors	: iceColors,
				font		: options.font,
			};


			art.display(dispOptions, function onDisplayed(err, mci) {
				cb(err, mci, artInfo);
			});
		}
	});
}