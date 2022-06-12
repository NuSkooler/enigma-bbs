/* jslint node: true */
'use strict';

//  ENiGMA½
const logger = require('./logger.js');

//  deps
const async = require('async');

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
                        moduleInst.createServer(err => {
                            if (err) {
                                return nextModule(err);
                            }

                            moduleInst.listen(err => {
                                if (err) {
                                    return nextModule(err);
                                }

                                listeningServers[module.moduleInfo.packageName] = {
                                    instance: moduleInst,
                                    info: module.moduleInfo,
                                };

                                return nextModule(null);
                            });
                        });
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
