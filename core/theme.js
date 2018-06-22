/* jslint node: true */
'use strict';

const Config			= require('./config.js').get;
const art				= require('./art.js');
const ansi				= require('./ansi_term.js');
const Log				= require('./logger.js').log;
const ConfigCache		= require('./config_cache.js');
const getFullConfig		= require('./config_util.js').getFullConfig;
const asset				= require('./asset.js');
const ViewController	= require('./view_controller.js').ViewController;
const Errors			= require('./enig_error.js').Errors;
const ErrorReasons		= require('./enig_error.js').ErrorReasons;
const Events			= require('./events.js');

const fs				= require('graceful-fs');
const paths				= require('path');
const async				= require('async');
const _					= require('lodash');
const assert			= require('assert');

exports.getThemeArt				= getThemeArt;
exports.getAvailableThemes		= getAvailableThemes;
exports.getRandomTheme			= getRandomTheme;
exports.setClientTheme          = setClientTheme;
exports.initAvailableThemes		= initAvailableThemes;
exports.displayThemeArt			= displayThemeArt;
exports.displayThemedPause		= displayThemedPause;
exports.displayThemedPrompt		= displayThemedPrompt;
exports.displayThemedAsset		= displayThemedAsset;

function refreshThemeHelpers(theme) {
    //
    //	Create some handy helpers
    //
    theme.helpers = {
        getPasswordChar : function() {
            let pwChar = _.get(
                theme,
                'customization.defaults.general.passwordChar',
                Config().defaults.passwordChar
            );

            if(_.isString(pwChar)) {
                pwChar = pwChar.substr(0, 1);
            } else if(_.isNumber(pwChar)) {
                pwChar = String.fromCharCode(pwChar);
            }

            return pwChar;
        },
        getDateFormat : function(style = 'short') {
            const format = Config().defaults.dateFormat[style] || 'MM/DD/YYYY';
            return _.get(theme, `customization.defaults.dateFormat.${style}`, format);
        },
        getTimeFormat : function(style = 'short') {
            const format = Config().defaults.timeFormat[style] || 'h:mm a';
            return _.get(theme, `customization.defaults.timeFormat.${style}`, format);
        },
        getDateTimeFormat : function(style = 'short') {
            const format = Config().defaults.dateTimeFormat[style] || 'MM/DD/YYYY h:mm a';
            return _.get(theme, `customization.defaults.dateTimeFormat.${style}`, format);
        }
    };
}

function loadTheme(themeId, cb) {
    const path = paths.join(Config().paths.themes, themeId, 'theme.hjson');

    const changed = ( { fileName, fileRoot } ) => {
        const reCachedPath = paths.join(fileRoot, fileName);
        if(reCachedPath === path) {
            reloadTheme(themeId);
        }
    };

    const getOpts = {
        filePath 		: path,
        forceReCache	: true,
        callback		: changed,
    };

    ConfigCache.getConfigWithOptions(getOpts, (err, theme) => {
        if(err) {
            return cb(err);
        }

        if(!_.isObject(theme.info) ||
			!_.isString(theme.info.name) ||
			!_.isString(theme.info.author))
        {
            return cb(Errors.Invalid('Invalid or missing "info" section'));
        }

        if(false === _.get(theme, 'info.enabled')) {
            return cb(Errors.General('Theme is not enalbed', ErrorReasons.ErrNotEnabled));
        }

        refreshThemeHelpers(theme);

        return cb(null, theme, path);
    });
}

const availableThemes = new Map();

const IMMUTABLE_MCI_PROPERTIES = [
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
    const mergedTheme = _.cloneDeep(menuConfig);

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
    const mciCustomizer = function(objVal, srcVal, key) {
        return IMMUTABLE_MCI_PROPERTIES.indexOf(key) > -1 ? objVal : srcVal;
    };

    function getFormKeys(fromObj) {
        return _.remove(_.keys(fromObj), function pred(k) {
            return !isNaN(k);    //  remove all non-numbers
        });
    }

    function mergeMciProperties(dest, src) {
        Object.keys(src).forEach(function mciEntry(mci) {
            _.mergeWith(dest[mci], src[mci], mciCustomizer);
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
            const menuMciCodeKeys = _.remove(_.keys(form), function pred(k) {
                return k === k.toUpperCase(); //  remove anything not uppercase
            });

            menuMciCodeKeys.forEach(function mciKeyEntry(mciKey) {
                let applyFrom;
                if(_.has(menuTheme, [ mciKey, 'mci' ])) {
                    applyFrom = menuTheme[mciKey];
                } else {
                    applyFrom = menuTheme;
                }

                applyThemeMciBlock(form[mciKey].mci, applyFrom, formKey);
            });
        }
    }

    [ 'menus', 'prompts' ].forEach(function areaEntry(sectionName) {
        _.keys(mergedTheme[sectionName]).forEach(function menuEntry(menuName) {
            let createdFormSection = false;
            const mergedThemeMenu = mergedTheme[sectionName][menuName];

            if(_.has(theme, [ 'customization', sectionName, menuName ])) {
                const menuTheme = theme.customization[sectionName][menuName];

                //	config block is direct assign/overwrite
                //  :TODO: should probably be _.merge()
                if(menuTheme.config) {
                    mergedThemeMenu.config = _.assign(mergedThemeMenu.config || {}, menuTheme.config);
                }

                if('menus' === sectionName) {
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
                } else if('prompts' === sectionName) {
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
            if('menus' === sectionName && !_.isString(mergedThemeMenu.prompt) &&
				(createdFormSection || !_.isObject(mergedThemeMenu.form)))
            {
                mergedThemeMenu.runtime = _.merge(mergedThemeMenu.runtime || {}, { autoNext : true } );
            }
        });
    });


    return mergedTheme;
}

function reloadTheme(themeId) {
    const config = Config();
    async.waterfall(
        [
            function loadMenuConfig(callback) {
                getFullConfig(config.general.menuFile, (err, menuConfig) => {
                    return callback(err, menuConfig);
                });
            },
            function loadPromptConfig(menuConfig, callback) {
                getFullConfig(config.general.promptFile, (err, promptConfig) => {
                    return callback(err, menuConfig, promptConfig);
                });
            },
            function loadIt(menuConfig, promptConfig, callback) {
                loadTheme(themeId, (err, theme) => {
                    if(err) {
                        if(ErrorReasons.NotEnabled !== err.reasonCode) {
                            Log.warn( { themeId : themeId, err : err.message }, 'Failed loading theme');
                            return;
                        }
                        return callback(err);
                    }

                    Object.assign(theme.info, { themeId } );
                    availableThemes.set(themeId, getMergedTheme(menuConfig, promptConfig, theme));

                    Events.emit(
                        Events.getSystemEvents().ThemeChanged,
                        { themeId }
                    );

                    return callback(null, theme);
                });
            }
        ],
        (err, theme) => {
            if(err) {
                Log.warn( { themeId, error : err.message }, 'Failed to reload theme');
            } else {
                Log.debug( { info : theme.info }, 'Theme recached' );
            }
        }
    );
}

function reloadAllThemes()
{
    async.each([ ...availableThemes.keys() ], themeId => reloadTheme(themeId));
}

function initAvailableThemes(cb) {
    const config = Config();
    async.waterfall(
        [
            function loadMenuConfig(callback) {
                getFullConfig(config.general.menuFile, (err, menuConfig) => {
                    return callback(err, menuConfig);
                });
            },
            function loadPromptConfig(menuConfig, callback) {
                getFullConfig(config.general.promptFile, (err, promptConfig) => {
                    return callback(err, menuConfig, promptConfig);
                });
            },
            function getThemeDirectories(menuConfig, promptConfig, callback) {
                fs.readdir(config.paths.themes, (err, files) =>  {
                    if(err) {
                        return callback(err);
                    }

                    return callback(
                        null,
                        menuConfig,
                        promptConfig,
                        files.filter( f => {
                            //	sync normally not allowed -- initAvailableThemes() is a startup-only method, however
                            return fs.statSync(paths.join(config.paths.themes, f)).isDirectory();
                        })
                    );
                });
            },
            function populateAvailable(menuConfig, promptConfig, themeDirectories, callback) {
                async.each(themeDirectories, (themeId, nextThemeDir) => {	//	theme dir = theme ID
                    loadTheme(themeId, (err, theme) => {
                        if(err) {
                            if(ErrorReasons.NotEnabled !== err.reasonCode) {
                                Log.warn( { themeId : themeId, err : err.message }, 'Failed loading theme');
                            }

                            return nextThemeDir(null);	//	try next
                        }

                        Object.assign(theme.info, { themeId } );
                        availableThemes.set(themeId, getMergedTheme(menuConfig, promptConfig, theme));
                        return nextThemeDir(null);
                    });
                }, err => {
                    return callback(err);
                });
            },
            function initEvents(callback) {
                Events.on(Events.getSystemEvents().MenusChanged, () => {
                    return reloadAllThemes();
                });
                Events.on(Events.getSystemEvents().PromptsChanged, () => {
                    return reloadAllThemes();
                });

                return callback(null);
            }
        ],
        err => {
            return cb(err, availableThemes.size);
        }
    );
}

function getAvailableThemes() {
    return availableThemes;
}

function getRandomTheme() {
    if(availableThemes.size > 0) {
        const themeIds = [ ...availableThemes.keys() ];
        return themeIds[Math.floor(Math.random() * themeIds.length)];
    }
}

function setClientTheme(client, themeId) {
    const availThemes = getAvailableThemes();

    let msg;
    let setThemeId;
    const config = Config();
    if(availThemes.has(themeId)) {
        msg = 'Set client theme';
        setThemeId = themeId;
    } else if(availThemes.has(config.defaults.theme)) {
        msg = 'Failed setting theme by supplied ID; Using default';
        setThemeId = config.defaults.theme;
    } else {
        msg = 'Failed setting theme by system default ID; Using the first one we can find';
        setThemeId = availThemes.keys().next().value;
    }

    client.currentTheme = availThemes.get(setThemeId);
    client.log.debug( { setThemeId, requestedThemeId : themeId, info : client.currentTheme.info }, msg);
}

function getThemeArt(options, cb) {
    //
    //	options - required:
    //		name
    //
    //	options - optional
    //		client - needed for user's theme/etc.
    //		themeId
    //		asAnsi
    //		readSauce
    //		random
    //
    const config = Config();
    if(!options.themeId && _.has(options, 'client.user.properties.theme_id')) {
        options.themeId = options.client.user.properties.theme_id;
    } else {
        options.themeId = config.defaults.theme;
    }

    //	:TODO: replace asAnsi stuff with something like retrieveAs = 'ansi' | 'pipe' | ...
    //	:TODO: Some of these options should only be set if not provided!
    options.asAnsi		= true;	//	always convert to ANSI
    options.readSauce	= true;	//	read SAUCE, if avail
    options.random		= _.get(options, 'random', true);	//	FILENAME<n>.EXT support

    //
    //	We look for themed art in the following order:
    //	1)	Direct/relative path
    //	2)	Via theme supplied by |themeId|
    //	3)	Via default theme
    //	4)	General art directory
    //
    async.waterfall(
        [
            function fromPath(callback) {
                //
                //	We allow relative (to enigma-bbs) or full paths
                //
                if('/' === options.name.charAt(0)) {
                    //	just take the path as-is
                    options.basePath = paths.dirname(options.name);
                } else if(options.name.indexOf('/') > -1) {
                    //	make relative to base BBS dir
                    options.basePath = paths.join(__dirname, '../', paths.dirname(options.name));
                } else {
                    return callback(null, null);
                }

                art.getArt(options.name, options, (err, artInfo) => {
                    return callback(null, artInfo);
                });
            },
            function fromSuppliedTheme(artInfo, callback) {
                if(artInfo) {
                    return callback(null, artInfo);
                }

                options.basePath = paths.join(config.paths.themes, options.themeId);
                art.getArt(options.name, options, (err, artInfo) => {
                    return callback(null, artInfo);
                });
            },
            function fromDefaultTheme(artInfo, callback) {
                if(artInfo || config.defaults.theme === options.themeId) {
                    return callback(null, artInfo);
                }

                options.basePath = paths.join(config.paths.themes, config.defaults.theme);
                art.getArt(options.name, options, (err, artInfo) => {
                    return callback(null, artInfo);
                });
            },
            function fromGeneralArtDir(artInfo, callback) {
                if(artInfo) {
                    return callback(null, artInfo);
                }

                options.basePath = config.paths.art;
                art.getArt(options.name, options, (err, artInfo) => {
                    return callback(err, artInfo);
                });
            }
        ],
        function complete(err, artInfo) {
            if(err) {
                const logger = _.get(options, 'client.log') || Log;
                logger.debug( { reason : err.message }, 'Cannot find theme art');
            }
            return cb(err, artInfo);
        }
    );
}

function displayThemeArt(options, cb) {
    assert(_.isObject(options));
    assert(_.isObject(options.client));
    assert(_.isString(options.name));

    getThemeArt(options, (err, artInfo) => {
        if(err) {
            return cb(err);
        }
        //	:TODO: just use simple merge of options -> displayOptions
        const displayOpts = {
            sauce		: artInfo.sauce,
            font		: options.font,
            trailingLF	: options.trailingLF,
        };

        art.display(options.client, artInfo.data, displayOpts, (err, mciMap, extraInfo) => {
            return cb(err, { mciMap : mciMap, artInfo : artInfo, extraInfo : extraInfo } );
        });
    });
}

function displayThemedPrompt(name, client, options, cb) {

    const useTempViewController = _.isUndefined(options.viewController);

    async.waterfall(
        [
            function display(callback) {
                const promptConfig = client.currentTheme.prompts[name];
                if(!promptConfig) {
                    return callback(Errors.DoesNotExist(`Missing "${name}" prompt configuration!`));
                }

                if(options.clearScreen) {
                    client.term.rawWrite(ansi.resetScreen());
                }

                //
                //	If we did *not* clear the screen, don't let the font change
                //	doing so messes things up -- most terminals that support font
                //	changing can only display a single font at at time.
                //
                //	:TODO: We can use term detection to do nifty things like avoid this kind of kludge:
                const dispOptions = Object.assign( {}, promptConfig.options );
                if(!options.clearScreen) {
                    dispOptions.font = 'not_really_a_font!';	//	kludge :)
                }

                displayThemedAsset(
                    promptConfig.art,
                    client,
                    dispOptions,
                    (err, artInfo) => {
                        if(err) {
                            return callback(err);
                        }

                        return callback(null, promptConfig, artInfo);
                    }
                );
            },
            function discoverCursorPosition(promptConfig, artInfo, callback) {
                if(!options.clearPrompt) {
                    //	no need to query cursor - we're not gonna use it
                    return callback(null, promptConfig, artInfo);
                }

                client.once('cursor position report', pos => {
                    artInfo.startRow = pos[0] - artInfo.height;
                    return callback(null, promptConfig, artInfo);
                });

                client.term.rawWrite(ansi.queryPos());
            },
            function createMCIViews(promptConfig, artInfo, callback) {
                const tempViewController = useTempViewController ? new ViewController( { client : client } ) : options.viewController;

                const loadOpts = {
                    promptName	: name,
                    mciMap		: artInfo.mciMap,
                    config		: promptConfig,
                };

                tempViewController.loadFromPromptConfig(loadOpts, () => {
                    return callback(null, artInfo, tempViewController);
                });
            },
            function pauseForUserInput(artInfo, tempViewController, callback) {
                if(!options.pause) {
                    return callback(null, artInfo, tempViewController);
                }

                client.waitForKeyPress( () => {
                    return callback(null, artInfo, tempViewController);
                });
            },
            function clearPauseArt(artInfo, tempViewController, callback) {
                if(options.clearPrompt) {
                    if(artInfo.startRow && artInfo.height) {
                        client.term.rawWrite(ansi.goto(artInfo.startRow, 1));

                        //	Note: Does not work properly in NetRunner < 2.0b17:
                        client.term.rawWrite(ansi.deleteLine(artInfo.height));
                    } else {
                        client.term.rawWrite(ansi.eraseLine(1));
                    }
                }

                return callback(null, tempViewController);
            }
        ],
        (err, tempViewController) => {
            if(err) {
                client.log.warn( { error : err.message }, `Failed displaying "${name}" prompt` );
            }

            if(tempViewController && useTempViewController) {
                tempViewController.detachClientEvents();
            }

            return cb(null);
        }
    );
}

//
//	Pause prompts are a special prompt by the name 'pause'.
//
function displayThemedPause(client, options, cb) {

    if(!cb && _.isFunction(options)) {
        cb = options;
        options = {};
    }

    if(!_.isBoolean(options.clearPrompt)) {
        options.clearPrompt = true;
    }

    const promptOptions = Object.assign( {}, options, { pause : true } );
    return displayThemedPrompt('pause', client, promptOptions, cb);
}

function displayThemedAsset(assetSpec, client, options, cb) {
    assert(_.isObject(client));

    //	options are... optional
    if(3 === arguments.length) {
        cb = options;
        options = {};
    }

    if(Array.isArray(assetSpec) && _.isString(options.acsCondMember)) {
        assetSpec = client.acs.getConditionalValue(assetSpec, options.acsCondMember);
    }

    const artAsset = asset.getArtAsset(assetSpec);
    if(!artAsset) {
        return cb(new Error('Asset not found: ' + assetSpec));
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
                return cb(err, err ? null : { mciMap : artData.mciMap, height : artData.extraInfo.height } );
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
            return cb(new Error('Unsupported art asset type: ' + artAsset.type));
    }
}