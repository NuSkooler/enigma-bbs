/* jslint node: true */
'use strict';

var Config				= require('./config.js').config;
var art					= require('./art.js');
var ansi				= require('./ansi_term.js');
var miscUtil			= require('./misc_util.js');
var Log					= require('./logger.js').log;
var jsonCache			= require('./json_cache.js');

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
exports.displayThemePause		= displayThemePause;

//	:TODO: use JSONCache here... may need to fancy it up a bit in order to have events for after re-cache, e.g. to update helpers below:
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
					},
					getDateFormat : function(style) {
						style = style || 'short';

						var format = Config.defaults.dateFormat[style] || 'MM/DD/YYYY';

						if(_.has(theme, 'customization.defaults.dateFormat')) {
							return theme.customization.defaults.dateFormat[style] || format;
						}
						return format;
					},
					getTimeFormat : function(style) {
						style = style || 'short';

						var format = Config.defaults.timeFormat[style] || 'h:mm tt';

						if(_.has(theme, 'customization.defaults.timeFormat')) {
							return theme.customization.defaults.timeFormat[style] || format;
						}
						return format;
					}
				};

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

function displayThemePause(options, cb) {
	//
	//	options.client
	//	options clearPrompt
	//
	assert(_.isObject(options.client));

	if(!_.isBoolean(options.clearPrompt)) {
		options.clearPrompt = true;
	}

	//	:TODO: Support animated pause prompts. Probably via MCI with AnimatedView
	//	:TODO: support prompts with a height > 1
	//	:TODO: Prompt should support MCI codes in general
	//	...this will be more complex due to cursor movement. Will need to track where teh cusor
	//	was before the prompt + filling MCI, then move back and erase correct # of lines

	async.waterfall(
		[
			function loadPromptJSON(callback) {
				jsonCache.getJSON('prompt.json', function loaded(err, promptJson) {
					if(err) {
						callback(err);
					} else {
						if(_.has(promptJson, [ 'prompts', 'pause' ] )) {
							callback(null, promptJson.prompts.pause);
						} else {
							callback(new Error('Missing standard \'pause\' prompt'))
						}
					}					
				});				
			},
			function displayPausePrompt(pausePrompt, callback) {
				displayThemeArt( { client : options.client, name : pausePrompt.art }, function pauseDisplayed(err, mciMap, extraInfo) {
					if(extraInfo) {
						pauseHeight = extraInfo.height;
					}
					callback(null);
				});
			},
			function pauseForUserInput(callback) {
				options.client.waitForKeyPress(function keyPressed() {
					callback(null);
				});
			},
			function clearPauseArt(callback) {
				if(options.clearPrompt) {
					options.client.term.write(ansi.up(1) + ansi.deleteLine());
				}
				callback(null);
			}
			, function debugPause(callback) {
				setTimeout(function to() {
					callback(null);
				}, 4000);
			}

		],
		function complete(err) {
			if(err) {
				Log.error(err);
			}
			cb();
		}
	);
}
