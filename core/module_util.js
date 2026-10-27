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

    return cb(null, mod);
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

function initializeModules(cb) {
    const Events = require('./events.js');

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

                            try {
                                const mod = require(fullModulePath);

                                if (_.isFunction(mod.moduleInitialize)) {
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
                                } else {
                                    return nextModule(null);
                                }
                            } catch (e) {
                                logger.log.warn(
                                    { error: e.message, fullModulePath },
                                    'Exception during "moduleInitialize"'
                                );
                                return nextModule(null);
                            }
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
