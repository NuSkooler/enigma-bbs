/* jslint node: true */
'use strict';

//  ENiGMA½
const logger = require('./logger.js');

//  deps
const async = require('async');
const isFunction = require('lodash/isFunction');

const listeningServers = {}; //  packageName -> info

exports.startup = startup;
exports.shutdown = shutdown;
exports.getServer = getServer;

function startup(cb) {
    return startListening(cb);
}

function shutdown(cb) {
    return cb(null);
}

function getServer(packageName) {
    return listeningServers[packageName];
}

function startListening(cb) {
    const moduleUtil = require('./module_util.js'); //  late load so we get Config

    async.each(
        ['login', 'content', 'chat'],
        (category, next) => {
            moduleUtil.loadModulesForCategory(
                `${category}Servers`,
                (module, nextModule) => {
                    const moduleInst = new module.getModule();
                    try {
                        async.series(
                            [
                                callback => {
                                    return moduleInst.createServer(callback);
                                },
                                callback => {
                                    listeningServers[module.moduleInfo.packageName] = {
                                        instance: moduleInst,
                                        info: module.moduleInfo,
                                    };

                                    if (!isFunction(moduleInst.beforeListen)) {
                                        return callback(null);
                                    }
                                    moduleInst.beforeListen(err => {
                                        return callback(err);
                                    });
                                },
                                callback => {
                                    return moduleInst.listen(callback);
                                },
                                callback => {
                                    if (!isFunction(moduleInst.afterListen)) {
                                        return callback(null);
                                    }
                                    moduleInst.afterListen(err => {
                                        return callback(err);
                                    });
                                },
                            ],
                            err => {
                                if (err) {
                                    delete listeningServers[
                                        module.moduleInfo.packageName
                                    ];
                                    return nextModule(err);
                                }

                                return nextModule(null);
                            }
                        );
                    } catch (e) {
                        logger.log.error(e, 'Exception caught creating server!');
                        return nextModule(e);
                    }
                },
                err => {
                    return next(err);
                }
            );
        },
        err => {
            return cb(err);
        }
    );
}
