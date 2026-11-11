/* jslint node: true */
'use strict';

//  Late bound as in dropfile.js and file_transfer.js: configModule.get is
//  replaced by the Config bootstrapper, so capturing it here would freeze
//  whichever getter was installed at require time.
const configModule = require('./config.js');
const Config = (...args) => configModule.get(...args);
const art = require('./art.js');
const ansi = require('./ansi_term.js');
const Log = require('./logger.js').log;
const asset = require('./asset.js');
const ViewController = require('./view_controller.js').ViewController;
const Errors = require('./enig_error.js').Errors;
const Events = require('./events.js');
const AnsiPrep = require('./ansi_prep.js');
const UserProps = require('./user_property.js');
const { emulationOf, DEFAULT_EMULATION } = require('./term');

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
exports.getMenuNames = getMenuNames;
exports.getRandomTheme = getRandomTheme;
exports.setClientTheme = setClientTheme;
exports.getThemeEmulation = getThemeEmulation;
exports.getThemeEmulationById = getThemeEmulationById;
exports.getSessionEmulation = getSessionEmulation;
exports.getThemeIdsForEmulation = getThemeIdsForEmulation;
exports.getThemeSetting = getThemeSetting;
exports.getEmulationDefaultThemeId = getEmulationDefaultThemeId;
exports.isThemeCompatible = isThemeCompatible;
exports.getSessionThemeId = getSessionThemeId;
exports.getSelectableThemes = getSelectableThemes;
exports.getThemeIdToPersist = getThemeIdToPersist;
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
        //  every theme.hjson that loaded, including ones _themeLoaded()
        //  went on to reject; validation has more to say about those, not less
        this.loadedThemeConfigs = new Map();
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
                            {
                                themeId,
                                themeName: name,
                                author,
                                group,
                                emulation: getThemeEmulation(themeConfig.get()),
                            },
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
        const menuPath = getConfigPath(Config().general.menuFile);

        this.menuConfig = new ConfigLoader({
            //
            //  Advisory, exactly as for config.hjson and achievements.hjson:
            //  ConfigLoader guards both calls, so nothing here can stop a load
            //  or a reload. Reported to the log rather than the console --
            //  menus load well after Log.init().
            //
            validator: (userConfig, mergedConfig) => {
                const { isEnabled } = require('./config/report.js');
                //  general.configValidation governs every file
                if (!isEnabled(Config())) {
                    return [];
                }

                const { validateConfig } = require('./config/validate.js');
                const { buildMenuSchema } = require('./config/menu_schema.js');
                const {
                    validateMenuReferences,
                    validateMenuModules,
                } = require('./config/refs.js');
                const { defaultModuleResolver } = require('./config/module_resolver.js');

                return [
                    ...validateConfig(userConfig, mergedConfig, buildMenuSchema()),
                    ...validateMenuReferences(mergedConfig),
                    ...validateMenuModules(mergedConfig, defaultModuleResolver(Config())),
                ];
            },
            onValidation: issues => {
                require('./config/report.js').reportIssues(issues, {
                    source: paths.basename(menuPath),
                    logOnly: true,
                });
            },
            onReload: err => {
                if (!err) {
                    //  menu.hjson/includes have changed; this could affect
                    //  all themes, so they must be reloaded
                    Events.emit(Events.getSystemEvents().MenusChanged);

                    this._reloadAllThemes(reloadErr => {
                        if (reloadErr) {
                            Log.warn(
                                { error: reloadErr.message },
                                'Error reloading themes after menu change'
                            );
                        }
                    });
                }
            },
        });

        this.menuConfig.init(menuPath, err => {
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
                            if (!err) {
                                this._validateThemes();
                            }
                            return cb(err);
                        }
                    );
                }
            );
        });
    }

    //
    //  Checked once, after every theme is in, rather than per theme as each
    //  loads: the interesting problem is cross-file -- a customization naming
    //  a menu that does not exist is never consulted by _finalizeTheme(), so
    //  it silently does nothing -- and that needs menu.hjson, which a
    //  per-theme ConfigLoader hook cannot see.
    //
    //  Advisory and self-contained: a throw here would otherwise escape into
    //  the startup series, whose callback would then never fire.
    //
    _validateThemes() {
        try {
            const { isEnabled } = require('./config/report.js');
            if (!isEnabled(Config())) {
                return;
            }

            const { validateConfig } = require('./config/validate.js');
            const { buildThemeSchema } = require('./config/theme_schema.js');
            const { validateThemeReferences } = require('./config/refs.js');
            const { reportIssues } = require('./config/report.js');

            const menuConfig = this.menuConfig.get();
            const names = {
                menuNames: Object.keys(_.get(menuConfig, 'menus') || {}),
                menuPromptNames: Object.keys(_.get(menuConfig, 'prompts') || {}),
            };

            const schema = buildThemeSchema();

            this.loadedThemeConfigs.forEach((themeConfig, themeId) => {
                //  the raw file, not the menu-merged overlay _finalizeTheme builds
                const theme = themeConfig.getRaw();

                const issues = [
                    ...validateConfig(theme, theme, schema),
                    ...validateThemeReferences(theme, names),
                ];

                reportIssues(issues, {
                    source: `${themeId}/theme.hjson`,
                    logOnly: true,
                });
            });
        } catch (e) {
            Log.warn({ error: e.message }, 'Theme validation failed');
        }
    }

    _loadTheme(themeId, cb) {
        const themeConfig = new ConfigLoader({
            onReload: err => {
                if (!err) {
                    //  this particular theme.hjson has changed; re-finalize and notify clients
                    this._themeLoaded(themeId, themeConfig);
                }
            },
        });

        const themeConfigPath = paths.join(Config().paths.themes, themeId, 'theme.hjson');

        themeConfig.init(themeConfigPath, err => {
            if (err) {
                return cb(err);
            }

            this.loadedThemeConfigs.set(themeId, themeConfig);
            this._themeLoaded(themeId, themeConfig);
            return cb(null);
        });
    }

    _themeLoaded(themeId, themeConfig) {
        //  Validate against raw theme.hjson content, not the merged overlay
        const theme = themeConfig.getRaw();

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
        const mergedTheme = structuredClone(this.menuConfig.get());

        //  Use raw theme.hjson data so re-finalizations don't read back a previously
        //  merged overlay and double-apply theme customizations
        const theme = themeConfig.getRaw();

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
                    Object.keys(form),
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
                        //  Deep merge so nested config objects in theme.hjson can partially
                        //  override menu.hjson values without wiping sibling keys
                        mergedThemeMenu.config = _.merge(
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
            //
            //  Shown as the daily time budget runs down. A theme may override
            //  it; "{minutes}" and "{plural}" are substituted, and pipe codes
            //  are honoured.
            //
            //  The shipped wording lives in config_default.js and nowhere
            //  else, so there is no second copy here to drift from it. An
            //  explicit empty string at either layer means what it says --
            //  no warning -- rather than being read as "unset" and quietly
            //  replaced, which is how the "||" in the helpers above treats
            //  one.
            //
            getTimeWarningText: function () {
                const text = _.get(Config(), 'theme.timeWarningText', '');
                return _.get(theme, 'customization.defaults.timeWarningText', text);
            },
            getStatusAvailIndicators: function () {
                const format = Config().theme.statusAvailableIndicators || ['Y', 'N'];
                return _.get(
                    theme,
                    'customization.defaults.statusAvailableIndicators',
                    format
                );
            },
            getStatusVisibleIndicators: function () {
                const format = Config().theme.statusVisibleIndicators || ['Y', 'N'];
                return _.get(
                    theme,
                    'customization.defaults.statusVisibleIndicators',
                    format
                );
            },
        };
    }

    _reloadAllThemes(cb) {
        //  Re-finalize each existing theme against the updated menu config.
        //  Reusing the existing ConfigLoader avoids spawning extra file watchers on
        //  every menu.hjson change and keeps theme.hjson raw data intact.
        async.each(
            [...this.availableThemes.keys()],
            (themeId, nextThemeId) => {
                const themeConfig = this.availableThemes.get(themeId);
                if (themeConfig) {
                    this._themeLoaded(themeId, themeConfig);
                    Log.info({ themeId }, `Theme "${themeId}" reloaded`);
                }
                return nextThemeId(null); //  always proceed; errors logged per theme
            },
            cb
        );
    }
};

function getAvailableThemes() {
    return themeManagerInstance.getAvailableThemes();
}

//
//  Every menu name the system knows, as menu.hjson declares them.
//
//  A theme may customise a menu but never add one: _finalizeTheme() starts
//  from menu.hjson and iterates the keys already there, so this is the whole
//  set regardless of which theme is in play.
//
//  Returns undefined before ThemeManager.create() has run -- an unknown set is
//  a reason to check nothing rather than to report everything as missing.
//
function getMenuNames() {
    if (!themeManagerInstance || !themeManagerInstance.menuConfig) {
        return undefined;
    }

    const menus = _.get(themeManagerInstance.menuConfig.get(), 'menus');
    return _.isPlainObject(menus) ? Object.keys(menus) : undefined;
}

//
//  Themes and terminal emulations (#593)
//
//  A theme is drawn for one emulation, named by |info.emulation| in its
//  theme.hjson; a theme that does not say is ANSI, which every theme was
//  before emulations existed. A session only ever gets a theme of its own
//  emulation (core/term/, |client.term.emulation.name|): handing a PETSCII
//  caller an ANSI theme would send it art and layout it cannot show.
//
//  On a board where every theme and every session is ANSI -- every board so
//  far -- each check below passes and each list below is the full list, so
//  nothing changes.
//

//  the emulation |theme| (a finalized theme or a raw theme.hjson) is for
function getThemeEmulation(theme) {
    const emulation = _.get(theme, 'info.emulation');
    if (_.isString(emulation) && emulation.trim().length > 0) {
        return emulation.trim().toLowerCase();
    }
    return DEFAULT_EMULATION;
}

function themeManagerReady() {
    return undefined !== themeManagerInstance;
}

//
//  The emulation of the theme called |themeId|. A theme that loaded but is
//  disabled or was rejected still answers from its theme.hjson. An id that
//  names no theme at all is taken to be ANSI: that is what such an id meant
//  before emulations existed (an ANSI session asking for it falls back to
//  the default theme exactly as before), and it keeps a stale id from
//  steering a non-ANSI session.
//
function getThemeEmulationById(themeId) {
    if (!themeManagerReady() || !_.isString(themeId)) {
        return DEFAULT_EMULATION;
    }

    const themeConfig =
        themeManagerInstance.availableThemes.get(themeId) ||
        themeManagerInstance.loadedThemeConfigs.get(themeId);
    if (!themeConfig) {
        return DEFAULT_EMULATION;
    }

    //  available themes answer from the finalized theme, others from the file
    const theme = themeManagerInstance.availableThemes.has(themeId)
        ? themeConfig.get()
        : themeConfig.getRaw();
    return getThemeEmulation(theme);
}

//  the emulation of |client|'s session; ANSI for a stand-in without a term
function getSessionEmulation(client) {
    return emulationOf(_.get(client, 'term')).name;
}

function isThemeCompatible(themeId, emulation) {
    return getThemeEmulationById(themeId) === emulation;
}

//  ids of the available themes for |emulation|, in load order
function getThemeIdsForEmulation(emulation) {
    if (!themeManagerReady()) {
        return [];
    }

    const themeIds = [];
    getAvailableThemes().forEach((themeConfig, themeId) => {
        if (getThemeEmulation(themeConfig.get()) === emulation) {
            themeIds.push(themeId);
        }
    });
    return themeIds;
}

//
//  A theme setting ('default' or 'preLogin') for |emulation|:
//  theme.emulations.<emulation>.<key> when set, otherwise theme.<key>. With no
//  theme.emulations block -- every existing config -- this is theme.<key>,
//  read exactly as before. The value may be "*" or name a theme of another
//  emulation; callers deal with both.
//
function getThemeSetting(emulation, key) {
    const config = Config();
    const perEmulation = _.get(config, ['theme', 'emulations', emulation, key]);
    if (_.isString(perEmulation) && perEmulation.length > 0) {
        return perEmulation;
    }
    return _.get(config, ['theme', key]);
}

//
//  The theme a session of |emulation| falls back to: the configured default
//  if it is available and of that emulation, otherwise the first theme of
//  that emulation. Undefined when there is none.
//
function getEmulationDefaultThemeId(emulation) {
    if (!themeManagerReady()) {
        return undefined;
    }

    const configured = getThemeSetting(emulation, 'default');
    if (
        getAvailableThemes().has(configured) &&
        isThemeCompatible(configured, emulation)
    ) {
        return configured;
    }
    return getThemeIdsForEmulation(emulation)[0];
}

//
//  With |emulation|, picks among that emulation's themes only; without it,
//  among all themes as before. On a board whose themes are all ANSI, the two
//  are the same list in the same order.
//
function getRandomTheme(emulation) {
    const themeIds = _.isString(emulation)
        ? getThemeIdsForEmulation(emulation)
        : [...getAvailableThemes().keys()];
    if (themeIds.length > 0) {
        return themeIds[Math.floor(Math.random() * themeIds.length)];
    }
}

//  once per emulation per process: it is a configuration gap, not an event
const warnedNoThemeEmulations = new Set();

function setClientTheme(client, themeId) {
    const availThemes = getAvailableThemes();
    const emulation = getSessionEmulation(client);

    //
    //  A theme for another emulation is not offered to this session at all:
    //  it gets its emulation's default instead, and whatever asked for it --
    //  usually the user's saved theme -- is left as it is (#593).
    //
    let requestedThemeId = themeId;
    if (!isThemeCompatible(themeId, emulation)) {
        client.log.debug(
            {
                requestedThemeId: themeId,
                themeEmulation: getThemeEmulationById(themeId),
                emulation,
            },
            'Theme is not for this terminal emulation; using the emulation default'
        );
        requestedThemeId = undefined;
    }

    const compatible = id => availThemes.has(id) && isThemeCompatible(id, emulation);

    let msg;
    let setThemeId;
    const defaultThemeId = getThemeSetting(emulation, 'default');
    if (compatible(requestedThemeId)) {
        msg = 'Set client theme';
        setThemeId = requestedThemeId;
    } else if (compatible(defaultThemeId)) {
        msg = 'Failed setting theme by supplied ID; Using default';
        setThemeId = defaultThemeId;
    } else if (getThemeIdsForEmulation(emulation).length > 0) {
        msg =
            'Failed setting theme by system default ID; Using the first one we can find';
        setThemeId = getThemeIdsForEmulation(emulation)[0];
    } else {
        //
        //  No theme at all for this emulation. Never leave the session
        //  without one: fall back exactly as before emulations existed.
        //  (With no themes whatsoever there is nothing to warn about here;
        //  that fails below as it always has.)
        //
        if (availThemes.size > 0 && !warnedNoThemeEmulations.has(emulation)) {
            warnedNoThemeEmulations.add(emulation);
            //  the logger as it is now, not as it was when this file loaded
            require('./logger.js').log.warn(
                { emulation },
                'No theme is available for this terminal emulation; using the default theme'
            );
        }

        const config = Config();
        if (availThemes.has(config.theme.default)) {
            msg = 'Failed setting theme by supplied ID; Using default';
            setThemeId = config.theme.default;
        } else {
            msg =
                'Failed setting theme by system default ID; Using the first one we can find';
            setThemeId = availThemes.keys().next().value;
        }
    }

    client.currentTheme = availThemes.get(setThemeId);
    client.log.debug(
        { setThemeId, requestedThemeId: themeId, info: client.currentTheme.info },
        msg
    );
}

//
//  The theme id that art for |client| is looked up under, before the default
//  theme and the general art directory. Undefined if there is none.
//
//  This is the user's theme property, as it always has been, whenever that
//  theme suits the session's emulation -- which on an ANSI-only board is
//  always, including an id that names no theme (looked up, missed, and the
//  default theme used, as before). Reading |client.currentTheme| instead
//  would change two things on such a board: art for a disabled or broken
//  theme still in a user's profile comes from that theme's directory today,
//  and the "already logged in" screen shows art from the theme of the user
//  who tried to log in. Neither is touched here.
//
//  Only when the property names a theme of another emulation -- the session
//  was given its emulation's default instead (see setClientTheme()) -- does
//  art come from the session's theme.
//
function getSessionThemeId(client) {
    const themeId = _.get(client, ['user', 'properties', UserProps.ThemeId]);
    if (isThemeCompatible(themeId, getSessionEmulation(client))) {
        return themeId;
    }
    return _.get(client, 'currentTheme.info.themeId');
}

//
//  [ themeId, themeConfig ] entries a user on |client| may choose between:
//  the available themes for the session's emulation, in load order. On an
//  ANSI-only board, every available theme.
//
//  When there is no theme at all for the emulation, the session is running
//  on the system default theme (see setClientTheme()); the list is then every
//  available theme, never an empty one.
//
function getSelectableThemes(client) {
    const emulation = getSessionEmulation(client);
    const all = [...getAvailableThemes()];
    const matching = all.filter(
        ([, themeConfig]) => getThemeEmulation(themeConfig.get()) === emulation
    );
    return matching.length > 0 ? matching : all;
}

//
//  What to save as the user's theme when they pick |selectedThemeId| from
//  getSelectableThemes(): that id, or undefined to leave the saved one alone.
//
//  The saved theme may be for another emulation -- chosen on another
//  terminal -- and so not in the list; the list then opens on the theme the
//  session was given in its place. Saving with that still selected is not a
//  choice, and must not overwrite the saved one. On an ANSI-only board the
//  saved theme is always for the session's emulation, so this always returns
//  |selectedThemeId|.
//
function getThemeIdToPersist(client, selectedThemeId) {
    const savedThemeId = _.get(client, ['user', 'properties', UserProps.ThemeId]);
    if (
        !isThemeCompatible(savedThemeId, getSessionEmulation(client)) &&
        selectedThemeId === _.get(client, 'currentTheme.info.themeId')
    ) {
        return undefined;
    }
    return selectedThemeId;
}

//  where art falls back to when the session's theme does not have it
function getArtDefaultThemeId(client) {
    const emulation = getSessionEmulation(client);
    if (DEFAULT_EMULATION === emulation || !themeManagerReady()) {
        return Config().theme.default;
    }
    return getEmulationDefaultThemeId(emulation) || Config().theme.default;
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
    if (!options.themeId && options.client) {
        options.themeId = getSessionThemeId(options.client);
    }

    const defaultThemeId = getArtDefaultThemeId(options.client);
    options.themeId = options.themeId || defaultThemeId;

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
                if (artInfo || defaultThemeId === options.themeId) {
                    return callback(null, artInfo);
                }

                options.basePath = paths.join(config.paths.themes, defaultThemeId);
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
        baudRate: options.baudRate,
    };
    if (artInfo.native) {
        //  native art (.seq): see art.display()
        displayOpts.native = artInfo.native;
    }
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
                //  displayPreparedArt() shows native art (.seq) too
                options.acceptNative = true;
                return getThemeArt(options, callback);
            },
            function prepWork(artInfo, callback) {
                //  ANSI preparation does not apply to native art: drawn as it is
                if (_.isObject(options.ansiPrepOptions) && !artInfo.native) {
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
    const usingTempViewController = options.viewController === undefined;

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

                // adjust MCI positions relative to |position|
                if (options.position) {
                    _.forEach(artInfo.mciMap, mci => {
                        if (mci.position) {
                            mci.position[0] = options.position.row;
                            mci.position[1] += options.position.col || 0;
                        }
                    });
                }

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
                    return callback(null, artInfo, assocViewController, null);
                }

                client.waitForKeyPress((ch, key) => {
                    return callback(null, artInfo, assocViewController, { ch, key });
                });
            },
            function clearPauseArt(artInfo, assocViewController, pressedKey, callback) {
                // Only clear with height if clearPrompt is true and if we were able
                // to determine the row
                if (options.clearPrompt && artInfo.startRow) {
                    client.term.rawWrite(ansi.goto(artInfo.startRow, 1));
                    if (artInfo.height) {
                        //  Note: Does not work properly in NetRunner < 2.0b17:
                        client.term.rawWrite(ansi.deleteLine(artInfo.height));
                    } else {
                        //  Single-line prompt (height=0): erase entire line in place
                        client.term.rawWrite(ansi.eraseLine(2));
                    }
                }

                return callback(null, assocViewController, artInfo, pressedKey);
            },
        ],
        (err, assocViewController, artInfo, pressedKey) => {
            if (err) {
                client.log.warn(
                    { error: err.message },
                    `Failed displaying "${name}" prompt`
                );
            }

            if (assocViewController && usingTempViewController) {
                assocViewController.detachClientEvents();
            }

            return cb(null, artInfo, pressedKey);
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

    const promptName = options.promptName || 'pause';
    const promptOptions = Object.assign({}, options, { pause: true });
    return displayThemedPrompt(promptName, client, promptOptions, cb);
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
