/* jslint node: true */
'use strict';

var Config				= require('./config.js').config;
var art					= require('./art.js');
var ansi				= require('./ansi_term.js');
var miscUtil			= require('./misc_util.js');
var Log					= require('./logger.js').log;
var configCache			= require('./config_cache.js');
var asset				= require('./asset.js');
var ViewController		= require('./view_controller.js').ViewController;

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
exports.displayThemedPause		= displayThemedPause;
exports.displayThemedAsset		= displayThemedAsset;

function refreshThemeHelpers(theme) {
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

			var format = Config.defaults.timeFormat[style] || 'h:mm a';

			if(_.has(theme, 'customization.defaults.timeFormat')) {
				return theme.customization.defaults.timeFormat[style] || format;
			}
			return format;
		},
		getDateTimeFormat : function(style) {
			style = style || 'short';

			var format = Config.defaults.dateTimeFormat[style] || 'MM/DD/YYYY h:mm a';

			if(_.has(theme, 'customization.defaults.dateTimeFormat')) {
				return theme.customization.defaults.dateTimeFormat[style] || format;
			}

			return format;
		}
	}
}

function loadTheme(themeID, cb) {

	var path = paths.join(Config.paths.themes, themeID, 'theme.hjson');

	configCache.getConfig(path, function loaded(err, theme) {
		if(err) {
			cb(err);
		} else {
			if(!_.isObject(theme.info)) {
				cb(new Error('Invalid theme or missing \'info\' section'));
				return;
			}

			refreshThemeHelpers(theme);

			cb(null, theme, path);
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
					loadTheme(themeId, function themeLoaded(err, theme, themePath) {
						if(!err) {
							availableThemes[themeId] = theme;

							configCache.on('recached', function recached(path) {
								if(themePath === path) {									
									loadTheme(themeId, function reloaded(err, reloadedTheme) {
										Log.debug( { info : theme.info }, 'Theme recached' );

										availableThemes[themeId] = reloadedTheme;
									});
								}
							});

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
				art				: artInfo.data,
				sauce			: artInfo.sauce,
				client			: options.client,
				font			: options.font,
				omitTrailingLF	: options.omitTrailingLF,
			};

			art.display(dispOptions, function displayed(err, mciMap, extraInfo) {
				cb(err, { mciMap : mciMap, artInfo : artInfo, extraInfo : extraInfo } );
			});
		}
	});
}

//
//	Pause prompts are a special prompt by the name 'pause'.
//	
function displayThemedPause(options, cb) {
	//
	//	options.client
	//	options clearPrompt
	//
	assert(_.isObject(options.client));

	if(!_.isBoolean(options.clearPrompt)) {
		options.clearPrompt = true;
	}

	//	:TODO: Support animated pause prompts. Probably via MCI with AnimatedView

	var artInfo;
	var vc;
	var promptConfig;

	async.series(
		[
			function loadPromptJSON(callback) {
				configCache.getModConfig('prompt.hjson', function loaded(err, promptJson) {
					if(err) {
						callback(err);
					} else {
						if(_.has(promptJson, [ 'prompts', 'pause' ] )) {
							promptConfig = promptJson.prompts.pause;
							callback(_.isObject(promptConfig) ? null : new Error('Invalid prompt config block!'));
						} else {
							callback(new Error('Missing standard \'pause\' prompt'))
						}
					}					
				});
			},
			function displayPausePrompt(callback) {
				displayThemedAsset(
					promptConfig.art, 
					options.client,
					{ font : promptConfig.font, omitTrailingLF : true },
					function displayed(err, artData) {
						artInfo = artData;
						callback(err);
					}
				);
			},
			function discoverCursorPosition(callback) {
				options.client.once('cursor position report', function cpr(pos) {
					artInfo.startRow = pos[0] - artInfo.height;
					callback(null);
				});
				options.client.term.rawWrite(ansi.queryPos());
			},
			function createMCIViews(callback) {
				vc = new ViewController( { client : options.client, noInput : true } );
				vc.loadFromPromptConfig( { promptName : 'pause', mciMap : artInfo.mciMap, config : promptConfig }, function loaded(err) {
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
					if(artInfo.startRow) {
						options.client.term.rawWrite(ansi.goto(artInfo.startRow, 1));
						options.client.term.rawWrite(ansi.deleteLine(artInfo.height));
					} else {
						options.client.term.rawWrite(ansi.up(1) + ansi.deleteLine());
					}
				}
				callback(null);
			}
			/*
			, function debugPause(callback) {
				setTimeout(function to() {
					callback(null);
				}, 4000);
			}
			*/
		],
		function complete(err) {
			if(err) {
				Log.error(err);
			}

			if(vc) {
				vc.detachClientEvents();
			}

			cb();
		}
	);
}

function displayThemedAsset(assetSpec, client, options, cb) {
	assert(_.isObject(client));

	//	options are... optional
	if(3 === arguments.length) {
		cb = options;
		options = {};
	}

	var artAsset = asset.getArtAsset(assetSpec);
	if(!artAsset) {
		cb(new Error('Asset not found: ' + assetSpec));
		return;
	}

	var dispOpts = {
		name			: artAsset.asset,
		client			: client,
		font			: options.font,
		omitTrailingLF	: options.omitTrailingLF,
	};

	switch(artAsset.type) {
		case 'art' :
			displayThemeArt(dispOpts, function displayed(err, artData) {
				cb(err, err ? null : { mciMap : artData.mciMap, height : artData.extraInfo.height } );
			});
			break;

		case 'method' : 
			//	:TODO: fetch & render via method
			break;

		case 'inline ' :
			//	:TODO: think about this more in relation to themes, etc. How can this come
			//	from a theme (with override from menu.json) ???
			//	look @ client.currentTheme.inlineArt[name] -> menu/prompt[name]
			break;

		default :
			cb(new Error('Unsupported art asset type: ' + artAsset.type));
			break;
	}
}