/* jslint node: true */
'use strict';

var Config				= require('./config.js').config;
var art					= require('./art.js');
var miscUtil			= require('./misc_util.js');
var Log					= require('./logger.js').log;

var fs					= require('fs');
var paths				= require('path');
var async				= require('async');
var _					= require('lodash');
var assert				= require('assert');
var stripJsonComments	= require('strip-json-comments');

exports.loadTheme				= loadTheme;
exports.getThemeArt				= getThemeArt;
exports.getRandomTheme			= getRandomTheme;
exports.initAvailableThemes		= initAvailableThemes;
exports.displayThemeArt			= displayThemeArt;

function loadTheme(themeID, cb) {
	var path = paths.join(Config.paths.themes, themeID, 'theme.json');

	fs.readFile(path, { encoding : 'utf8' }, function onData(err, data) {
		if(err) {
			cb(err);
		} else {
			try {
				var theme = JSON.parse(stripJsonComments(data));

				if(!_.isObject(theme.info)) {
					cb(new Error('Invalid theme JSON'));
					return;
				}

				assert(!_.isObject(theme.helpers));	//	we create this on the fly!

				//
				//	Create some handy helpers
				//
				theme.helpers = {
					getPasswordChar : function() {
						var pwChar = Config.defaults.passwordChar;
						if(_.has(theme, 'customization.defaults.general')) {
							var themePasswordChar = theme.customization.defaults.general.passwordChar;
							if(_.isString(themePasswordChar)) {
								pwChar = themePasswordChar.substr(0, 1);
							} else if(_.isNumber(themePasswordChar)) {
								pwChar = String.fromCharCode(themePasswordChar);
							}
						}
						return pwChar;
					}
				}

				cb(null, theme);
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
					loadTheme(themeId, function themeLoaded(err, theme) {
						if(!err) {
							availableThemes[themeId] = theme;
							Log.debug( { info : theme.info }, 'Theme loaded');
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

function getRandomTheme() {
	if(Object.getOwnPropertyNames(availableThemes).length > 0) {
		var themeIds = Object.keys(availableThemes);
		return themeIds[Math.floor(Math.random() * themeIds.length)];
	}
}

function getThemeArt(name, themeID, options, cb) {
	//	allow options to be optional
	if(_.isUndefined(cb)) {
		cb		= options;
		options = {};
	}

	//	set/override some options

	//	:TODO: replace asAnsi stuff with something like retrieveAs = 'ansi' | 'pipe' | ...
	//	:TODO: Some of these options should only be set if not provided!
	options.asAnsi		= true;
	options.readSauce	= true;	//	encoding/fonts/etc.
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

	getThemeArt(options.name, options.client.user.properties.theme_id, function themeArt(err, artInfo) {
		if(err) {
			cb(err);
		} else {
			var dispOptions = {
				art			: artInfo.data,
				sauce		: artInfo.sauce,
				client		: options.client,
				font		: options.font,
			};

			art.display(dispOptions, function displayed(err, mciMap, extraInfo) {
				cb(err, { mciMap : mciMap, artInfo : artInfo, extraInfo : extraInfo } );
			});
		}
	});
}