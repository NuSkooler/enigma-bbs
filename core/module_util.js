/* jslint node: true */
'use strict';

//  ENiGMA½
const configModule = require('./config.js');
//  configModule.get is replaced when the config is created (and by tests), so
//  capturing it at load time would go stale: always read through the module.
const Config = () => configModule.get();
const logger = require('./logger.js'); //  logger.log is set by init(): read it late
const { Errors, ErrorReasons } = require('./enig_error.js');

//  deps
const fs = require('graceful-fs');
const paths = require('path');
const _ = require('lodash');
const assert = require('assert');
const async = require('async');
const { glob } = require('glob');

//  exports
exports.loadModuleEx = loadModuleEx;
exports.loadModule = loadModule;
exports.loadModulesForCategory = loadModulesForCategory;
exports.getModulePaths = getModulePaths;
exports.getModArtPath = getModArtPath;
exports.initializeModules = initializeModules;

exports.moduleCategories = {
    Login: 'login',
    Content: 'content',
    Chat: 'chat',
    ScannerTossers: 'scannerTossers',
    WebHandlers: 'webHandlers',
};

function loadModuleEx(options, cb) {
    assert(_.isObject(options));
    assert(_.isString(options.name));
    assert(_.isString(options.path));

    //
    //  |category| is the config section the module's own block lives in, e.g.
    //  'loginServers' -> loginServers.telnet; "enabled: false" there skips it.
    //
    const config = Config();
    const categoryConfig = options.category ? config[options.category] : null;
    const modConfig = _.isObject(categoryConfig) ? categoryConfig[options.name] : null;

    if (_.isObject(modConfig) && false === modConfig.enabled) {
        return cb(
            Errors.AccessDenied(
                `Module "${options.name}" is disabled`,
                ErrorReasons.Disabled
            )
        );
    }

    //
    //  Modules are allowed to live in /path/to/<moduleName>/<moduleName>.js or
    //  simply in /path/to/<moduleName>.js. This allows for more advanced modules
    //  to have their own containing folder, package.json & dependencies, etc.
    //
    let mod;
    let modPath = paths.join(options.path, `${options.name}.js`); //  general case first
    try {
        mod = require(modPath);
    } catch (e) {
        if ('MODULE_NOT_FOUND' === e.code) {
            modPath = paths.join(options.path, options.name, `${options.name}.js`);
            try {
                mod = require(modPath);
            } catch (e) {
                return cb(e);
            }
        } else {
            return cb(e);
        }
    }

    if (!_.isObject(mod.moduleInfo)) {
        return cb(
            Errors.Invalid(`No exported "moduleInfo" block for module ${modPath}!`)
        );
    }

    if (!_.isFunction(mod.getModule)) {
        return cb(
            Errors.Invalid(`No exported "getModule" method for module ${modPath}!`)
        );
    }

    //  |modPath|: the file that was loaded (see getModArtPath())
    return cb(null, mod, modPath);
}

//
//  The art folder of a folder mod: <path>/<name>/art, when loadModuleEx() with
//  |options| loaded |modPath| from <path>/<name>/<name>.js. Undefined for a
//  single file mod (<path>/<name>.js), which has no folder of its own: it
//  shares <path> with every other mod. Nothing is read from disk; a missing
//  folder is found out by the art lookup itself, which then moves on.
//
function getModArtPath(options, modPath) {
    if (!_.isString(modPath) || !_.isString(options.name) || !_.isString(options.path)) {
        return undefined;
    }
    //  a name that is not a plain file name (`../x`, `a/b`) never yields a
    //  folder, so the art folder is always directly under |options.path|
    if (
        0 === options.name.length ||
        /[\\/]/.test(options.name) ||
        '.' === options.name ||
        '..' === options.name ||
        paths.basename(options.name) !== options.name
    ) {
        return undefined;
    }
    const folder = paths.join(options.path, options.name);
    if (modPath !== paths.join(folder, `${options.name}.js`)) {
        return undefined;
    }
    return paths.join(folder, 'art');
}

function loadModule(name, category, cb) {
    const path = Config().paths[category];

    if (!_.isString(path)) {
        return cb(
            Errors.DoesNotExist(
                `Not sure where to look for module "${name}" of category "${category}"`
            )
        );
    }

    loadModuleEx(
        { name: name, path: path, category: category },
        function loaded(err, mod) {
            return cb(err, mod);
        }
    );
}

function loadModulesForCategory(category, iterator, complete) {
    fs.readdir(Config().paths[category], (err, files) => {
        if (err) {
            return iterator(err);
        }

        const jsModules = files.filter(file => {
            return '.js' === paths.extname(file);
        });

        async.each(
            jsModules,
            (file, next) => {
                loadModule(paths.basename(file, '.js'), category, (err, mod) => {
                    if (err) {
                        if (ErrorReasons.Disabled === err.reasonCode) {
                            logger.log.info(
                                { module: paths.basename(file, '.js'), category },
                                'Module disabled in configuration; not loading'
                            );
                        } else {
                            logger.log.info({ err: err }, 'Failed loading module');
                        }
                        return next(null); //  continue no matter what
                    }
                    return iterator(mod, next);
                });
            },
            err => {
                if (complete) {
                    return complete(err);
                }
            }
        );
    });
}

function getModulePaths() {
    const config = Config();
    return [
        config.paths.mods,
        config.paths.loginServers,
        config.paths.contentServers,
        config.paths.chatServers,
        config.paths.scannerTossers,
    ];
}

//
//  Requires every module and calls, for each that exports them:
//
//    registerFileScanners(registry, cb?)   file scanners; see core/file_scanner.js
//    moduleInitialize(initInfo, cb)
//
//  in that order, so a mod's scanners are registered before anything else it
//  does. For mods under paths.mods that has already happened, earlier in
//  startup (bbs.js, file_scanner.js loadModFileScanners(), the way oputil
//  does it), and registerModFileScanners() skips them here.
//
function initializeModules(cb) {
    const Events = require('./events.js');
    const FileScanner = require('./file_scanner.js');

    const modulePaths = getModulePaths().concat(__dirname);

    async.each(
        modulePaths,
        (modulePath, nextPath) => {
            glob('*{.js,/*.js}', { cwd: modulePath })
                .then(files => {
                    const ourPath = paths.join(__dirname, __filename);

                    async.each(
                        files,
                        (moduleName, nextModule) => {
                            const fullModulePath = paths.join(modulePath, moduleName);
                            if (ourPath === fullModulePath) {
                                return nextModule(null);
                            }

                            let mod;
                            try {
                                mod = require(fullModulePath);
                            } catch (e) {
                                logger.log.warn(
                                    { error: e.message, fullModulePath },
                                    'Exception during "moduleInitialize"'
                                );
                                return nextModule(null);
                            }

                            const initialize = () => {
                                if (!_.isFunction(mod.moduleInitialize)) {
                                    return nextModule(null);
                                }

                                try {
                                    const initInfo = {
                                        events: Events,
                                    };

                                    mod.moduleInitialize(initInfo, err => {
                                        if (err) {
                                            logger.log.warn(
                                                {
                                                    error: err.message,
                                                    modulePath: fullModulePath,
                                                },
                                                'Error during "moduleInitialize"'
                                            );
                                        }
                                        return nextModule(null);
                                    });
                                } catch (e) {
                                    logger.log.warn(
                                        { error: e.message, fullModulePath },
                                        'Exception during "moduleInitialize"'
                                    );
                                    return nextModule(null);
                                }
                            };

                            //  never fails: a mod that throws is logged
                            return FileScanner.registerModFileScanners(
                                mod,
                                fullModulePath,
                                initialize
                            );
                        },
                        err => {
                            return nextPath(err);
                        }
                    );
                })
                .catch(err => {
                    return nextPath(err);
                });
        },
        err => {
            return cb(err);
        }
    );
}
