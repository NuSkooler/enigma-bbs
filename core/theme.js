/* jslint node: true */
'use strict';

var Config				= require('./config.js').config;
var art					= require('./art.js');
var ansi				= require('./ansi_term.js');
var miscUtil			= require('./misc_util.js');
var Log					= require('./logger.js').log;
var configCache			= require('./config_cache.js');
var getFullConfig		= require('./config_util.js').getFullConfig;
var asset				= require('./asset.js');
var ViewController		= require('./view_controller.js').ViewController;

var fs					= require('fs');
var paths				= require('path');
var async				= require('async');
var _					= require('lodash');
var assert				= require('assert');

exports.getThemeArt				= getThemeArt;
exports.getAvailableThemes		= getAvailableThemes;
exports.getRandomTheme			= getRandomTheme;
exports.setClientTheme          = setClientTheme;
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
	};
}

function loadTheme(themeID, cb) {

	var path = paths.join(Config.paths.themes, themeID, 'theme.hjson');

	configCache.getConfigWithOptions( { filePath : path, forceReCache : true }, function loaded(err, theme) {
		if(err) {
			cb(err);
		} else {
			if(!_.isObject(theme.info) || 
				!_.isString(theme.info.name) ||
				!_.isString(theme.info.author))
			{
				cb(new Error('Invalid or missing "info" section!'));
				return;
			}

			refreshThemeHelpers(theme);

			cb(null, theme, path);
		}
	});
}

var availableThemes = {};

var IMMUTABLE_MCI_PROPERTIES = [
    'maxLength', 'argName', 'submit', 'validate'
];

function getMergedTheme(menuConfig, promptConfig, theme) {
	assert(_.isObject(menuConfig));
	assert(_.isObject(theme));
    
    //  :TODO: merge in defaults (customization.defaults{} )
    //	:TODO: apply generic stuff, e.g. "VM" (vs "VM1")
    
    //
    //  Create a *clone* of menuConfig (menu.hjson) then bring in
    //  promptConfig (prompt.hjson)
    //
	var mergedTheme = _.cloneDeep(menuConfig);
    
    if(_.isObject(promptConfig.prompts)) {
        mergedTheme.prompts = _.cloneDeep(promptConfig.prompts);
    }
    
    //
    //  Add in data we won't be altering directly from the theme
    //
    mergedTheme.info    = theme.info;
    mergedTheme.helpers = theme.helpers;
    
    //
    //  merge customizer to disallow immutable MCI properties
    //	
	var mciCustomizer = function(objVal, srcVal, key) {
		return IMMUTABLE_MCI_PROPERTIES.indexOf(key) > -1 ? objVal : srcVal;
	};
    
    function getFormKeys(fromObj) {
        return _.remove(_.keys(fromObj), function pred(k) {
            return !isNaN(k);    //  remove all non-numbers
        });
    }
    
    function mergeMciProperties(dest, src) {
        Object.keys(src).forEach(function mciEntry(mci) {
            _.merge(dest[mci], src[mci], mciCustomizer);
        });
    }
    
    function applyThemeMciBlock(dest, src, formKey) {
        if(_.isObject(src.mci)) {
            mergeMciProperties(dest, src.mci);
        } else {
            if(_.has(src, [ formKey, 'mci' ])) {
                mergeMciProperties(dest, src[formKey].mci);
            }            
        }
    }
    
    //
    //  menu.hjson can have a couple different structures:
    //  1)  Explicit declaration of expected MCI code(s) under 'form:<id>' before a 'mci' block
    //      (this allows multiple layout types defined by one menu for example)
    //
    //  2)  Non-explicit declaration: 'mci' directly under 'form:<id>'
    //
    //  theme.hjson has it's own mix:
    //  1)  Explicit: Form ID before 'mci' (generally used where there are > 1 forms)
    //
    //  2)  Non-explicit: 'mci' directly under an entry
    //
    //  Additionally, #1 or #2 may be under an explicit key of MCI code(s) to match up
    //  with menu.hjson in #1. 
    //
    //  *   When theming an explicit menu.hjson entry (1), we will use a matching explicit
    //      entry with a matching MCI code(s) key in theme.hjson (e.g. menu="ETVM"/theme="ETVM"
    //      and fall back to generic if a match is not found. 
    //
    //  *   If theme.hjson provides form ID's, use them. Otherwise, we'll apply directly assuming
    //      there is a generic 'mci' block.
    //    
    function applyToForm(form, menuTheme, formKey) {     
        if(_.isObject(form.mci)) {
            //   non-explicit: no MCI code(s) key assumed since we found 'mci' directly under form ID
            applyThemeMciBlock(form.mci, menuTheme, formKey);
            
        } else {
            var menuMciCodeKeys = _.remove(_.keys(form), function pred(k) {
                return k === k.toUpperCase(); //  remove anything not uppercase 
            });
            
            menuMciCodeKeys.forEach(function mciKeyEntry(mciKey) {
                var applyFrom; 
                if(_.has(menuTheme, [ mciKey, 'mci' ])) {
                    applyFrom = menuTheme[mciKey];
                } else {
                    applyFrom = menuTheme;
                }
                
                applyThemeMciBlock(form[mciKey].mci, applyFrom);
            });
        }
    }
    
    [ 'menus', 'prompts' ].forEach(function areaEntry(areaName) {
        _.keys(mergedTheme[areaName]).forEach(function menuEntry(menuName) {
            var createdFormSection = false;
            var mergedThemeMenu = mergedTheme[areaName][menuName];
            
            if(_.has(theme, [ 'customization', areaName, menuName ])) {
                
                if('telnetConnected' === menuName || 'mainMenuLastCallers' === menuName) {
                    console.log('break me')
                }
                
                var menuTheme       = theme.customization[areaName][menuName];
                
                //	config block is direct assign/overwrite
                //  :TODO: should probably be _.merge()
                if(menuTheme.config) {
                    mergedThemeMenu.config = _.assign(mergedThemeMenu.config || {}, menuTheme.config);
                }
            
                if('menus' === areaName) {
                    if(_.isObject(mergedThemeMenu.form)) {
                        getFormKeys(mergedThemeMenu.form).forEach(function formKeyEntry(formKey) {
                            applyToForm(mergedThemeMenu.form[formKey], menuTheme, formKey);
                        });
                    } else {
                        if(_.isObject(menuTheme.mci)) {
                            //
                            //  Not specified at menu level means we apply anything from the
                            //  theme to form.0.mci{}
                            //                            
                            mergedThemeMenu.form = { 0 : { mci : { } } };
                            mergeMciProperties(mergedThemeMenu.form[0], menuTheme);
                            createdFormSection = true;
                        }
                    }
                } else if('prompts' === areaName) {
                    //  no 'form' or form keys for prompts -- direct to mci
                    applyToForm(mergedThemeMenu, menuTheme);
                }                
            }
            
            //
            //  Finished merging for this menu/prompt
            //
            //  If the following conditions are true, set runtime.autoNext to true:
            //  *   This is a menu
            //  *   There is/was no explicit 'form' section
            //  *   There is no 'prompt' specified
            //
            if('menus' === areaName && !_.isString(mergedThemeMenu.prompt) &&
                (createdFormSection || !_.isObject(mergedThemeMenu.form)))
            {
                mergedThemeMenu.runtime = _.merge(mergedThemeMenu.runtime || {}, { autoNext : true } );
            }
        });
    });
	

	return mergedTheme;
}

function initAvailableThemes(cb) {
    var menuConfig;
    var promptConfig;
   
	async.waterfall(
		[
            function loadMenuConfig(callback) {
                getFullConfig(Config.general.menuFile, function gotConfig(err, mc) {
                    menuConfig = mc;
                    callback(err);
                });
            },
            function loadPromptConfig(callback) {
                getFullConfig(Config.general.promptFile, function gotConfig(err, pc) {
                    promptConfig = pc;
                    callback(err); 
                });
            },
			function getDir(callback) {
				fs.readdir(Config.paths.themes, function dirRead(err, files) {
					callback(err, files);
				});
			},
			function filterFiles(files, callback) {				
				var filtered = files.filter(function filter(file) {
					return fs.statSync(paths.join(Config.paths.themes, file)).isDirectory(); 
				});
				callback(null, filtered);
			},
			function populateAvailable(filtered, callback) {
                //  :TODO: this is a bit broken with callback placement and configCache.on() handler
                
				filtered.forEach(function themeEntry(themeId) {
					loadTheme(themeId, function themeLoaded(err, theme, themePath) {
						if(!err) {
                            availableThemes[themeId] = getMergedTheme(menuConfig, promptConfig, theme);

							configCache.on('recached', function recached(path) {
								if(themePath === path) {									
									loadTheme(themeId, function reloaded(err, reloadedTheme) {
										Log.debug( { info : theme.info }, 'Theme recached' );

										availableThemes[themeId] = reloadedTheme;
									});
								}
							});

							Log.debug( { info : theme.info }, 'Theme loaded');
						} else {
							Log.warn( { themeId : themeId, error : err.toString() }, 'Failed to load theme');
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

function getAvailableThemes() {
	return availableThemes;
}

function getRandomTheme() {
	if(Object.getOwnPropertyNames(availableThemes).length > 0) {
		var themeIds = Object.keys(availableThemes);
		return themeIds[Math.floor(Math.random() * themeIds.length)];
	}
}

function setClientTheme(client, themeId) {
    var desc;
    
    try {
        client.currentTheme = getAvailableThemes()[themeId];
        desc = 'Set client theme';        
    } catch(e) {
        client.currentTheme = getAvailableThemes()[Config.defaults.theme];
        desc = 'Failed setting theme by supplied ID; Using default';
    }
    
    client.log.debug( { themeId : themeId, info : client.currentTheme.info }, desc);
}

function getThemeArt(options, cb) {
	//
	//	options - required:
	//	name
	//	client
	//	
	//	options - optional
	//	themeId
	//	asAnsi
	//	readSauce
	//	random
	//
	if(!options.themeId && _.has(options.client, 'user.properties.theme_id')) {
		options.themeId = options.client.user.properties.theme_id;
	} else {
		options.themeId = Config.defaults.theme;
	}

	//	:TODO: replace asAnsi stuff with something like retrieveAs = 'ansi' | 'pipe' | ...
	//	:TODO: Some of these options should only be set if not provided!
	options.asAnsi		= true;	//	always convert to ANSI
	options.readSauce	= true;	//	read SAUCE, if avail
	options.random		= _.isBoolean(options.random) ? options.random : true;	//	FILENAME<n>.EXT support

	//
	//	We look for themed art in the following manor:
	//	* Supplied theme via |themeId|
	//	* Fallback 1: Default theme (if different than |themeId|)
	//	* General art directory
	//
	async.waterfall(
		[
			function fromSuppliedTheme(callback) {
				options.basePath = paths.join(Config.paths.themes, options.themeId);

				art.getArt(options.name, options, function artLoaded(err, artInfo) {
					callback(null, artInfo);
				});
			},
			function fromDefaultTheme(artInfo, callback) {
				if(artInfo || Config.defaults.theme === options.themeId) {
					callback(null, artInfo);
				} else {
					options.basePath = paths.join(Config.paths.themes, Config.defaults.theme);

					art.getArt(options.name, options, function artLoaded(err, artInfo) {
						callback(null, artInfo);
					});
				}
			},
			function fromGeneralArtDir(artInfo, callback) {
				if(artInfo) {
					callback(null, artInfo);
				} else {
					options.basePath = Config.paths.art;

					art.getArt(options.name, options, function artLoaded(err, artInfo) {
						callback(err, artInfo);
					});
				}
			}
		],
		function complete(err, artInfo) {
			if(err) {
				options.client.log.debug( { error : err }, 'Cannot find art');
			}
			cb(err, artInfo);
		}
	);
}

function displayThemeArt(options, cb) {
	assert(_.isObject(options));
	assert(_.isObject(options.client));
	assert(_.isString(options.name));

	getThemeArt(options, function themeArt(err, artInfo) {
		if(err) {
			cb(err);
		} else {
			//	:TODO: just use simple merge of options -> displayOptions
			var dispOptions = {
				art				: artInfo.data,
				sauce			: artInfo.sauce,
				client			: options.client,
				font			: options.font,
				trailingLF		: options.trailingLF,
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
							callback(new Error('Missing standard \'pause\' prompt'));
						}
					}					
				});
			},
			function displayPausePrompt(callback) {
				//
				//	Override .font so it doesn't change from current setting
				//
				var dispOptions = promptConfig.options;
				dispOptions.font = 'not_really_a_font!';

				displayThemedAsset(
					promptConfig.art, 
					options.client,
					dispOptions,
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
					if(artInfo.startRow && artInfo.height) {
						options.client.term.rawWrite(ansi.goto(artInfo.startRow, 1));
						//	:TODO: This will not work with NetRunner:
						options.client.term.rawWrite(ansi.deleteLine(artInfo.height));
					} else {
						options.client.term.rawWrite(ansi.eraseLine(1))
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

	//	:TODO: just use simple merge of options -> displayOptions
	var dispOpts = {
		name			: artAsset.asset,
		client			: client,
		font			: options.font,
		trailingLF		: options.trailingLF,
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