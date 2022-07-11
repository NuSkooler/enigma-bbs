/* jslint node: true */
'use strict';

const Config = require('./config.js').get;
const art = require('./art.js');
const ansi = require('./ansi_term.js');
const Log = require('./logger.js').log;
const asset = require('./asset.js');
const ViewController = require('./view_controller.js').ViewController;
const Errors = require('./enig_error.js').Errors;
const Events = require('./events.js');
const AnsiPrep = require('./ansi_prep.js');
const UserProps = require('./user_property.js');

const ConfigLoader = require('./config_loader');
const { getConfigPath } = require('./config_util');

//  deps
const fs = require('graceful-fs');
const paths = require('path');
const async = require('async');
const _ = require('lodash');
const assert = require('assert');

exports.getThemeArt = getThemeArt;
exports.getAvailableThemes = getAvailableThemes;
exports.getRandomTheme = getRandomTheme;
exports.setClientTheme = setClientTheme;
exports.displayPreparedArt = displayPreparedArt;
exports.displayThemeArt = displayThemeArt;
exports.displayThemedPause = displayThemedPause;
exports.displayThemedPrompt = displayThemedPrompt;
exports.displayThemedAsset = displayThemedAsset;

//  global instance of ThemeManager; see ThemeManager.create()
let themeManagerInstance;

exports.ThemeManager = class ThemeManager {
    constructor() {
        this.availableThemes = new Map();
    }

    static create(cb) {
        themeManagerInstance = new ThemeManager();
        themeManagerInstance.init(err => {
            if (!err) {
                themeManagerInstance
                    .getAvailableThemes()
                    .forEach((themeConfig, themeId) => {
                        const { name, author, group } = themeConfig.get().info;
                        Log.info(
                            { themeId, themeName: name, author, group },
                            'Theme loaded'
                        );
                    });
            }

            return cb(err);
        });
    }

    getAvailableThemes() {
        return this.availableThemes;
    }

    init(cb) {
        this.menuConfig = new ConfigLoader({
            onReload: err => {
                if (!err) {
                    //  menu.hjson/includes have changed; this could affect
                    //  all themes, so they must be reloaded
                    Events.emit(Events.getSystemEvents().MenusChanged);

                    this._reloadAllThemes();
                }
            },
        });

        this.menuConfig.init(getConfigPath(Config().general.menuFile), err => {
            if (err) {
                return cb(err);
            }

            return this._loadThemes(cb);
        });
    }

    _loadThemes(cb) {
        const themeDir = Config().paths.themes;

        fs.readdir(themeDir, (err, files) => {
            if (err) {
                return cb(err);
            }

            async.filter(
                files,
                (filename, nextFilename) => {
                    const fullPath = paths.join(themeDir, filename);
                    fs.stat(fullPath, (err, stats) => {
                        if (err) {
                            return nextFilename(err);
                        }

                        return nextFilename(null, stats.isDirectory());
                    });
                },
                (err, themeIds) => {
                    if (err) {
                        return cb(err);
                    }

                    async.each(
                        themeIds,
                        (themeId, nextThemeId) => {
                            return this._loadTheme(themeId, nextThemeId);
                        },
                        err => {
                            return cb(err);
                        }
                    );
                }
            );
        });
    }

    _loadTheme(themeId, cb) {
        const themeConfig = new ConfigLoader({
            onReload: err => {
                if (!err) {
                    //  this particular theme has changed
                    this._themeLoaded(themeId, themeConfig, err => {
                        if (!err) {
                            Events.emit(Events.getSystemEvents().ThemeChanged, {
                                themeId,
                            });
                        }
                    });
                }
            },
        });

        const themeConfigPath = paths.join(Config().paths.themes, themeId, 'theme.hjson');

        themeConfig.init(themeConfigPath, err => {
            if (err) {
                return cb(err);
            }

            this._themeLoaded(themeId, themeConfig);
            return cb(null);
        });
    }

    _themeLoaded(themeId, themeConfig) {
        const theme = themeConfig.get();

        //  do some basic validation
        //  :TODO: schema validation here
        if (
            !_.isObject(theme.info) ||
            !_.isString(theme.info.name) ||
            !_.isString(theme.info.author)
        ) {
            return Log.warn(
                { themeId },
                'Theme contains invalid or missing "info" section'
            );
        }

        if (false === _.get(theme, 'info.enabled')) {
            Log.info({ themeId }, 'Theme is disabled');
            return this.availableThemes.delete(themeId);
        }

        //  merge menu.hjson+theme.hjson/etc. to the final usable theme
        this._finalizeTheme(themeId, themeConfig);

        //  Theme is valid and enabled; update it in available themes
        this.availableThemes.set(themeId, themeConfig);

        Events.emit(Events.getSystemEvents().ThemeChanged, { themeId });
    }

    _finalizeTheme(themeId, themeConfig) {
        //  These TODOs are left over from the old system - decide what/if to do with them:
        //  :TODO: merge in defaults (customization.defaults{} )
        //  :TODO: apply generic stuff, e.g. "VM" (vs "VM1")

        //  start out with menu.hjson
        const mergedTheme = _.cloneDeep(this.menuConfig.get());

        const theme = themeConfig.get();

        //  some data brought directly over
        mergedTheme.info = Object.assign({}, theme.info, { themeId });
        mergedTheme.achievements = _.get(theme, 'customization.achievements');

        //  Create some helpers for this theme
        this._setThemeHelpers(mergedTheme);

        //  merge customizer to disallow immutable MCI properties
        const ImmutableMCIProperties = ['maxLength', 'argName', 'submit', 'validate'];

        const mciCustomizer = (objVal, srcVal, key) => {
            return ImmutableMCIProperties.indexOf(key) > -1 ? objVal : srcVal;
        };

        const getFormKeys = obj => {
            //  remove all non-numbers
            return _.remove(Object.keys(obj), k => !isNaN(k));
        };

        const mergeMciProperties = (dst, src) => {
            Object.keys(src).forEach(mci => {
                if (dst[mci]) {
                    _.mergeWith(dst[mci], src[mci], mciCustomizer);
                } else {
                    //  theme contains a MCI that's not found in menu
                    dst[mci] = src[mci];
                }
            });
        };

        const applyThemeMciBlock = (dst, src, formKey) => {
            if (_.isObject(src.mci)) {
                mergeMciProperties(dst, src.mci);
            } else if (_.has(src, [formKey, 'mci'])) {
                mergeMciProperties(dst, src[formKey].mci);
            }
        };

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
        const applyToForm = (form, menuTheme, formKey) => {
            if (_.isObject(form.mci)) {
                //   non-explicit: no MCI code(s) key assumed since we found 'mci' directly under form ID
                applyThemeMciBlock(form.mci, menuTheme, formKey);
            } else {
                //  remove anything not uppercase
                const menuMciCodeKeys = _.remove(
                    _.keys(form),
                    k => k === k.toUpperCase()
                );

                menuMciCodeKeys.forEach(mciKey => {
                    const src = _.has(menuTheme, [mciKey, 'mci'])
                        ? menuTheme[mciKey]
                        : menuTheme;

                    applyThemeMciBlock(form[mciKey].mci, src, formKey);
                });
            }
        };

        ['menus', 'prompts'].forEach(sectionName => {
            if (!_.isObject(mergedTheme[sectionName])) {
                return Log.error({ sectionName }, 'Merged theme is missing section');
            }

            Object.keys(mergedTheme[sectionName]).forEach(entryName => {
                let createdFormSection = false;
                const mergedThemeMenu = mergedTheme[sectionName][entryName];

                const menuTheme = _.get(theme, ['customization', sectionName, entryName]);
                if (menuTheme) {
                    if (menuTheme.config) {
                        //  :TODO: should this be _.merge() ?
                        mergedThemeMenu.config = _.assign(
                            mergedThemeMenu.config || {},
                            menuTheme.config
                        );
                    }

                    if ('menus' === sectionName) {
                        if (_.isObject(mergedThemeMenu.form)) {
                            getFormKeys(mergedThemeMenu.form).forEach(formKey => {
                                applyToForm(
                                    mergedThemeMenu.form[formKey],
                                    menuTheme,
                                    formKey
                                );
                            });
                        } else if (_.isObject(menuTheme.mci)) {
                            //
                            //  Not specified at menu level means we apply anything from the
                            //  theme to form.0.mci{}
                            //
                            mergedThemeMenu.form = { 0: { mci: {} } };
                            mergeMciProperties(mergedThemeMenu.form[0], menuTheme);
                            createdFormSection = true;
                        }
                    } else if ('prompts' === sectionName) {
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
                if (
                    'menus' === sectionName &&
                    !_.isString(mergedThemeMenu.prompt) &&
                    (createdFormSection || !_.isObject(mergedThemeMenu.form))
                ) {
                    mergedThemeMenu.runtime = _.merge(mergedThemeMenu.runtime || {}, {
                        autoNext: true,
                    });
                }
            });
        });

        themeConfig.current = mergedTheme;
    }

    _setThemeHelpers(theme) {
        theme.helpers = {
            getPasswordChar: function () {
                let pwChar = _.get(
                    theme,
                    'customization.defaults.passwordChar',
                    Config().theme.passwordChar
                );

                if (_.isString(pwChar)) {
                    pwChar = pwChar.substr(0, 1);
                } else if (_.isNumber(pwChar)) {
                    pwChar = String.fromCharCode(pwChar);
                }

                return pwChar;
            },
            getDateFormat: function (style = 'short') {
                const format = Config().theme.dateFormat[style] || 'MM/DD/YYYY';
                return _.get(theme, `customization.defaults.dateFormat.${style}`, format);
            },
            getTimeFormat: function (style = 'short') {
                const format = Config().theme.timeFormat[style] || 'h:mm a';
                return _.get(theme, `customization.defaults.timeFormat.${style}`, format);
            },
            getDateTimeFormat: function (style = 'short') {
                const format =
                    Config().theme.dateTimeFormat[style] || 'MM/DD/YYYY h:mm a';
                return _.get(
                    theme,
                    `customization.defaults.dateTimeFormat.${style}`,
                    format
                );
            },
        };
    }

    _reloadAllThemes() {
        async.each([...this.availableThemes.keys()], (themeId, nextThemeId) => {
            this._loadTheme(themeId, err => {
                if (!err) {
                    Log.info({ themeId }, 'Theme reloaded');
                }
                return nextThemeId(null); //  always proceed
            });
        });
    }
};

function getAvailableThemes() {
    return themeManagerInstance.getAvailableThemes();
}

function getRandomTheme() {
    const avail = getAvailableThemes();
    if (avail.size > 0) {
        const themeIds = [...avail.keys()];
        return themeIds[Math.floor(Math.random() * themeIds.length)];
    }
}

function setClientTheme(client, themeId) {
    const availThemes = getAvailableThemes();

    let msg;
    let setThemeId;
    const config = Config();
    if (availThemes.has(themeId)) {
        msg = 'Set client theme';
        setThemeId = themeId;
    } else if (availThemes.has(config.theme.default)) {
        msg = 'Failed setting theme by supplied ID; Using default';
        setThemeId = config.theme.default;
    } else {
        msg =
            'Failed setting theme by system default ID; Using the first one we can find';
        setThemeId = availThemes.keys().next().value;
    }

    client.currentTheme = availThemes.get(setThemeId);
    client.log.debug(
        { setThemeId, requestedThemeId: themeId, info: client.currentTheme.info },
        msg
    );
}

function getThemeArt(options, cb) {
    //
    //  options - required:
    //      name
    //
    //  options - optional
    //      client - needed for user's theme/etc.
    //      themeId
    //      asAnsi
    //      readSauce
    //      random
    //
    const config = Config();
    if (
        !options.themeId &&
        _.has(options, ['client', 'user', 'properties', UserProps.ThemeId])
    ) {
        options.themeId = options.client.user.properties[UserProps.ThemeId];
    }

    options.themeId = options.themeId || config.theme.default;

    //  :TODO: replace asAnsi stuff with something like retrieveAs = 'ansi' | 'pipe' | ...
    //  :TODO: Some of these options should only be set if not provided!
    options.asAnsi = true; //  always convert to ANSI
    options.readSauce = _.get(options, 'readSauce', true); //  read SAUCE, if avail
    options.random = _.get(options, 'random', true); //  FILENAME<n>.EXT support

    //
    //  We look for themed art in the following order:
    //  1)  Direct/relative path
    //  2)  Via theme supplied by |themeId|
    //  3)  Via default theme
    //  4)  General art directory
    //
    async.waterfall(
        [
            function fromPath(callback) {
                //
                //  We allow relative (to enigma-bbs) or full paths
                //
                if ('/' === options.name.charAt(0)) {
                    //  just take the path as-is
                    options.basePath = paths.dirname(options.name);
                } else if (options.name.indexOf('/') > -1) {
                    //  make relative to base BBS dir
                    options.basePath = paths.join(
                        __dirname,
                        '../',
                        paths.dirname(options.name)
                    );
                } else {
                    return callback(null, null);
                }

                art.getArt(options.name, options, (err, artInfo) => {
                    return callback(null, artInfo);
                });
            },
            function fromSuppliedTheme(artInfo, callback) {
                if (artInfo) {
                    return callback(null, artInfo);
                }

                options.basePath = paths.join(config.paths.themes, options.themeId);
                art.getArt(options.name, options, (err, artInfo) => {
                    return callback(null, artInfo);
                });
            },
            function fromDefaultTheme(artInfo, callback) {
                if (artInfo || config.theme.default === options.themeId) {
                    return callback(null, artInfo);
                }

                options.basePath = paths.join(config.paths.themes, config.theme.default);
                art.getArt(options.name, options, (err, artInfo) => {
                    return callback(null, artInfo);
                });
            },
            function fromGeneralArtDir(artInfo, callback) {
                if (artInfo) {
                    return callback(null, artInfo);
                }

                options.basePath = config.paths.art;
                art.getArt(options.name, options, (err, artInfo) => {
                    return callback(err, artInfo);
                });
            },
        ],
        function complete(err, artInfo) {
            if (err) {
                const logger = _.get(options, 'client.log') || Log;
                logger.debug({ reason: err.message }, 'Cannot find theme art');
            }
            return cb(err, artInfo);
        }
    );
}

function displayPreparedArt(options, artInfo, cb) {
    const displayOpts = {
        sauce: artInfo.sauce,
        font: options.font,
        trailingLF: options.trailingLF,
        startRow: options.startRow,
    };
    art.display(options.client, artInfo.data, displayOpts, (err, mciMap, extraInfo) => {
        return cb(err, { mciMap: mciMap, artInfo: artInfo, extraInfo: extraInfo });
    });
}

function displayThemeArt(options, cb) {
    assert(_.isObject(options));
    assert(_.isObject(options.client));
    assert(_.isString(options.name));

    async.waterfall(
        [
            function getArt(callback) {
                return getThemeArt(options, callback);
            },
            function prepWork(artInfo, callback) {
                if (_.isObject(options.ansiPrepOptions)) {
                    AnsiPrep(artInfo.data, options.ansiPrepOptions, (err, prepped) => {
                        if (!err && prepped) {
                            artInfo.data = prepped;
                            return callback(null, artInfo);
                        }
                    });
                } else {
                    return callback(null, artInfo);
                }
            },
            function disp(artInfo, callback) {
                return displayPreparedArt(options, artInfo, callback);
            },
        ],
        (err, artData) => {
            return cb(err, artData);
        }
    );
}

function displayThemedPrompt(name, client, options, cb) {
    const usingTempViewController = _.isUndefined(options.viewController);

    async.waterfall(
        [
            function display(callback) {
                const promptConfig = client.currentTheme.prompts[name];
                if (!promptConfig) {
                    return callback(
                        Errors.DoesNotExist(`Missing "${name}" prompt configuration!`)
                    );
                }

                if (options.clearScreen) {
                    client.term.rawWrite(ansi.resetScreen());
                    options.position = { row: 1, column: 1 };
                }

                //
                //  If we did *not* clear the screen, don't let the font change
                //  doing so messes things up -- most terminals that support font
                //  changing can only display a single font at at time.
                //
                const dispOptions = Object.assign({}, options, promptConfig.config);
                //  :TODO: We can use term detection to do nifty things like avoid this kind of kludge:
                // if(!options.clearScreen) {
                //     dispOptions.font = 'not_really_a_font!';    //  kludge :)
                // }

                displayThemedAsset(
                    promptConfig.art,
                    client,
                    dispOptions,
                    (err, artInfo) => {
                        if (err) {
                            return callback(err);
                        }

                        return callback(null, promptConfig, artInfo);
                    }
                );
            },
            function discoverCursorPosition(promptConfig, artInfo, callback) {
                if (!options.clearPrompt) {
                    //  no need to query cursor - we're not gonna use it
                    return callback(null, promptConfig, artInfo);
                }

                if (_.isNumber(options?.position?.row)) {
                    artInfo.startRow = options.position.row;
                    if (
                        client.term.termHeight > 0 &&
                        artInfo.startRow + artInfo.height > client.term.termHeight
                    ) {
                        // in this case, we will have scrolled
                        artInfo.startRow = client.term.termHeight - artInfo.height;
                    }
                }

                return callback(null, promptConfig, artInfo);
            },
            function createMCIViews(promptConfig, artInfo, callback) {
                const assocViewController = usingTempViewController
                    ? new ViewController({ client: client })
                    : options.viewController;

                const loadOpts = {
                    promptName: name,
                    mciMap: artInfo.mciMap,
                    config: promptConfig,
                    submitNotify: options.submitNotify,
                };

                assocViewController.loadFromPromptConfig(loadOpts, () => {
                    return callback(null, artInfo, assocViewController);
                });
            },
            function pauseForUserInput(artInfo, assocViewController, callback) {
                if (!options.pause) {
                    return callback(null, artInfo, assocViewController);
                }

                client.waitForKeyPress(() => {
                    return callback(null, artInfo, assocViewController);
                });
            },
            function clearPauseArt(artInfo, assocViewController, callback) {
                // Only clear with height if clearPrompt is true and if we were able
                // to determine the row
                if (options.clearPrompt && artInfo.startRow) {
                    if (artInfo.startRow && artInfo.height) {
                        client.term.rawWrite(ansi.goto(artInfo.startRow, 1));

                        //  Note: Does not work properly in NetRunner < 2.0b17:
                        client.term.rawWrite(ansi.deleteLine(artInfo.height));
                    } else {
                        client.term.rawWrite(ansi.eraseLine(1));
                    }
                }

                return callback(null, assocViewController, artInfo);
            },
        ],
        (err, assocViewController, artInfo) => {
            if (err) {
                client.log.warn(
                    { error: err.message },
                    `Failed displaying "${name}" prompt`
                );
            }

            if (assocViewController && usingTempViewController) {
                assocViewController.detachClientEvents();
            }

            return cb(null, artInfo);
        }
    );
}

//
//  Pause prompts are a special prompt by the name 'pause'.
//
function displayThemedPause(client, options, cb) {
    if (!cb && _.isFunction(options)) {
        cb = options;
        options = {};
    }

    if (!_.isBoolean(options.clearPrompt)) {
        options.clearPrompt = true;
    }

    const promptOptions = Object.assign({}, options, { pause: true });
    return displayThemedPrompt('pause', client, promptOptions, cb);
}

function displayThemedAsset(assetSpec, client, options, cb) {
    assert(_.isObject(client));

    //  options are... optional
    if (3 === arguments.length) {
        cb = options;
        options = {};
    }

    if (Array.isArray(assetSpec)) {
        const acsCondMember = options.acsCondMember || 'art';
        assetSpec = client.acs.getConditionalValue(assetSpec, acsCondMember);
    }

    const artAsset = asset.getArtAsset(assetSpec);
    if (!artAsset) {
        return cb(new Error('Asset not found: ' + assetSpec));
    }

    const dispOpts = Object.assign({}, options, { client, name: artAsset.asset });
    switch (artAsset.type) {
        case 'art':
            displayThemeArt(dispOpts, function displayed(err, artData) {
                return cb(
                    err,
                    err
                        ? null
                        : { mciMap: artData.mciMap, height: artData.extraInfo.height }
                );
            });
            break;

        case 'method':
            //  :TODO: fetch & render via method
            break;

        case 'inline ':
            //  :TODO: think about this more in relation to themes, etc. How can this come
            //  from a theme (with override from menu.json) ???
            //  look @ client.currentTheme.inlineArt[name] -> menu/prompt[name]
            break;

        default:
            return cb(new Error('Unsupported art asset type: ' + artAsset.type));
    }
}
