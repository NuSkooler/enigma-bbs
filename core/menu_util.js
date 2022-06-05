/* jslint node: true */
'use strict';

//  ENiGMA½
const moduleUtil = require('./module_util.js');
const Log = require('./logger.js').log;
const Config = require('./config.js').get;
const asset = require('./asset.js');
const { MCIViewFactory } = require('./mci_view_factory.js');
const { Errors } = require('./enig_error.js');

//  deps
const paths = require('path');
const async = require('async');
const _ = require('lodash');

exports.loadMenu = loadMenu;
exports.getFormConfigByIDAndMap = getFormConfigByIDAndMap;
exports.handleAction = handleAction;
exports.getResolvedSpec = getResolvedSpec;
exports.handleNext = handleNext;

function getMenuConfig(client, name, cb) {
    async.waterfall(
        [
            function locateMenuConfig(callback) {
                const menuConfig = _.get(client.currentTheme, ['menus', name]);
                if (menuConfig) {
                    return callback(null, menuConfig);
                }

                return callback(Errors.DoesNotExist(`No menu entry for "${name}"`));
            },
            function locatePromptConfig(menuConfig, callback) {
                if (_.isString(menuConfig.prompt)) {
                    if (_.has(client.currentTheme, ['prompts', menuConfig.prompt])) {
                        menuConfig.promptConfig =
                            client.currentTheme.prompts[menuConfig.prompt];
                        return callback(null, menuConfig);
                    }
                    return callback(
                        Errors.DoesNotExist(`No prompt entry for "${menuConfig.prompt}"`)
                    );
                }
                return callback(null, menuConfig);
            },
        ],
        (err, menuConfig) => {
            return cb(err, menuConfig);
        }
    );
}

//  :TODO: name/client should not be part of options - they are required always
function loadMenu(options, cb) {
    if (!_.isString(options.name) || !_.isObject(options.client)) {
        return cb(Errors.MissingParam('Missing required options'));
    }

    async.waterfall(
        [
            function getMenuConfiguration(callback) {
                getMenuConfig(options.client, options.name, (err, menuConfig) => {
                    return callback(err, menuConfig);
                });
            },
            function loadMenuModule(menuConfig, callback) {
                menuConfig.config = menuConfig.config || {};
                menuConfig.config.menuFlags = menuConfig.config.menuFlags || [];
                if (!Array.isArray(menuConfig.config.menuFlags)) {
                    menuConfig.config.menuFlags = [menuConfig.config.menuFlags];
                }

                const modAsset = asset.getModuleAsset(menuConfig.module);
                const modSupplied = null !== modAsset;

                const modLoadOpts = {
                    name: modSupplied ? modAsset.asset : 'standard_menu',
                    path:
                        !modSupplied || 'systemModule' === modAsset.type
                            ? __dirname
                            : Config().paths.mods,
                    category:
                        !modSupplied || 'systemModule' === modAsset.type ? null : 'mods',
                };

                moduleUtil.loadModuleEx(modLoadOpts, (err, mod) => {
                    const modData = {
                        name: modLoadOpts.name,
                        config: menuConfig,
                        mod: mod,
                    };

                    return callback(err, modData);
                });
            },
            function createModuleInstance(modData, callback) {
                Log.trace(
                    {
                        moduleName: modData.name,
                        extraArgs: options.extraArgs,
                        config: modData.config,
                        info: modData.mod.modInfo,
                    },
                    'Creating menu module instance'
                );

                let moduleInstance;
                try {
                    moduleInstance = new modData.mod.getModule({
                        menuName: options.name,
                        menuConfig: modData.config,
                        extraArgs: options.extraArgs,
                        client: options.client,
                        lastMenuResult: options.lastMenuResult,
                    });
                } catch (e) {
                    return callback(e);
                }

                return callback(null, moduleInstance);
            },
        ],
        (err, modInst) => {
            return cb(err, modInst);
        }
    );
}

function getFormConfigByIDAndMap(menuConfig, formId, mciMap, cb) {
    if (!_.isObject(menuConfig.form)) {
        return cb(Errors.MissingParam('Invalid or missing "form" member for menu'));
    }

    if (!_.isObject(menuConfig.form[formId])) {
        return cb(Errors.DoesNotExist(`No form found for formId ${formId}`));
    }

    const formForId = menuConfig.form[formId];
    const mciReqKey = _.filter(_.map(_.sortBy(mciMap, 'code'), 'code'), mci => {
        return MCIViewFactory.UserViewCodes.indexOf(mci) > -1;
    }).join('');

    Log.trace({ mciKey: mciReqKey }, 'Looking for MCI configuration key');

    //
    //  Exact, explicit match?
    //
    if (_.isObject(formForId[mciReqKey])) {
        Log.trace({ mciKey: mciReqKey }, 'Using exact configuration key match');
        return cb(null, formForId[mciReqKey]);
    }

    //
    //  Generic match
    //
    if (_.has(formForId, 'mci') || _.has(formForId, 'submit')) {
        Log.trace('Using generic configuration');
        return cb(null, formForId);
    }

    return cb(
        Errors.DoesNotExist(`No matching form configuration found for key "${mciReqKey}"`)
    );
}

//  :TODO: Most of this should be moved elsewhere .... DRY...
function callModuleMenuMethod(client, asset, path, formData, extraArgs, cb) {
    if ('' === paths.extname(path)) {
        path += '.js';
    }

    try {
        client.log.trace(
            {
                path: path,
                methodName: asset.asset,
                formData: formData,
                extraArgs: extraArgs,
            },
            'Calling menu method'
        );

        const methodMod = require(path);
        return methodMod[asset.asset](
            client.currentMenuModule,
            formData || {},
            extraArgs,
            cb
        );
    } catch (e) {
        client.log.error(
            { error: e.toString(), methodName: asset.asset },
            'Failed to execute asset method'
        );
        return cb(e);
    }
}

function handleAction(client, formData, conf, cb) {
    if (!_.isObject(conf)) {
        return cb(Errors.MissingParam('Missing config'));
    }

    const action = getResolvedSpec(client, conf.action, 'action'); //  random/conditionals/etc.
    const actionAsset = asset.parseAsset(action);
    if (!_.isObject(actionAsset)) {
        return cb(Errors.Invalid('Unable to parse "conf.action"'));
    }

    switch (actionAsset.type) {
        case 'method':
        case 'systemMethod':
            if (_.isString(actionAsset.location)) {
                return callModuleMenuMethod(
                    client,
                    actionAsset,
                    paths.join(Config().paths.mods, actionAsset.location),
                    formData,
                    conf.extraArgs,
                    cb
                );
            } else if ('systemMethod' === actionAsset.type) {
                //  :TODO: Need to pass optional args here -- conf.extraArgs and args between e.g. ()
                //  :TODO: Probably better as system_method.js
                return callModuleMenuMethod(
                    client,
                    actionAsset,
                    paths.join(__dirname, 'system_menu_method.js'),
                    formData,
                    conf.extraArgs,
                    cb
                );
            } else {
                //  local to current module
                const currentModule = client.currentMenuModule;
                if (_.isFunction(currentModule.menuMethods[actionAsset.asset])) {
                    return currentModule.menuMethods[actionAsset.asset](
                        formData,
                        conf.extraArgs,
                        cb
                    );
                }

                const err = Errors.DoesNotExist('Method does not exist');
                client.log.warn({ method: actionAsset.asset }, err.message);
                return cb(err);
            }

        case 'menu':
            return client.currentMenuModule.gotoMenu(
                actionAsset.asset,
                { formData: formData, extraArgs: conf.extraArgs },
                cb
            );
    }
}

function getResolvedSpec(client, spec, memberName) {
    //
    //  'next', 'action', etc. can come in various flavors:
    //  (1) Simple string:
    //    next: foo
    //  (2) Array of objects with 'acs' checks; any object missing 'acs'
    //    is assumed to be "true":
    //    next: [
    //      {
    //        acs: AR2
    //        next: foo
    //      }
    //      {
    //        next: baz
    //      }
    //    ]
    //  (3) Simple array of strings. A random selection will be made:
    //    next: [ "foo", "baz", "fizzbang" ]
    //
    if (!Array.isArray(spec)) {
        return spec; //  (1) simple string, as-is
    }

    if (_.isObject(spec[0])) {
        return client.acs.getConditionalValue(spec, memberName); //  (2) ACS conditionals
    }

    return spec[Math.floor(Math.random() * spec.length)]; //  (3) random
}

function handleNext(client, nextSpec, conf, cb) {
    nextSpec = getResolvedSpec(client, nextSpec, 'next');
    const nextAsset = asset.getAssetWithShorthand(nextSpec, 'menu');
    //  :TODO: getAssetWithShorthand() can return undefined - handle it!

    conf = conf || {};
    const extraArgs = conf.extraArgs || {};

    //  :TODO: DRY this with handleAction()
    switch (nextAsset.type) {
        case 'method':
        case 'systemMethod':
            if (_.isString(nextAsset.location)) {
                return callModuleMenuMethod(
                    client,
                    nextAsset,
                    paths.join(Config().paths.mods, nextAsset.location),
                    {},
                    extraArgs,
                    cb
                );
            } else if ('systemMethod' === nextAsset.type) {
                //  :TODO: see other notes about system_menu_method.js here
                return callModuleMenuMethod(
                    client,
                    nextAsset,
                    paths.join(__dirname, 'system_menu_method.js'),
                    {},
                    extraArgs,
                    cb
                );
            } else {
                //  local to current module
                const currentModule = client.currentMenuModule;
                if (_.isFunction(currentModule.menuMethods[nextAsset.asset])) {
                    const formData = {}; //   we don't have any
                    return currentModule.menuMethods[nextAsset.asset](
                        formData,
                        extraArgs,
                        cb
                    );
                }

                const err = Errors.DoesNotExist('Method does not exist');
                client.log.warn({ method: nextAsset.asset }, err.message);
                return cb(err);
            }

        case 'menu':
            return client.currentMenuModule.gotoMenu(
                nextAsset.asset,
                { extraArgs: extraArgs },
                cb
            );
    }

    const err = Errors.Invalid('Invalid asset type for "next"');
    client.log.error({ nextSpec: nextSpec }, err.message);
    return cb(err);
}
