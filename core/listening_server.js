/* jslint node: true */
'use strict';

//  ENiGMA½
const logger            = require('./logger.js');
const { ErrorReasons }  = require('./enig_error.js');

//  deps
const async             = require('async');

const listeningServers = {};    //  packageName -> info

exports.startup         = startup;
exports.shutdown        = shutdown;
exports.getServer       = getServer;

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

    async.each( [ 'login', 'content' ], (category, next) => {
        moduleUtil.loadModulesForCategory(`${category}Servers`, (module, nextModule) => {
            const moduleInst = new module.getModule();
            try {
                moduleInst.createServer(err => {
                    if(!moduleInst.listen()) {
                        throw new Error('Failed listening');
                    }

                    listeningServers[module.moduleInfo.packageName] = {
                        instance    : moduleInst,
                        info        : module.moduleInfo,
                    };
                    return nextModule(err);
                });
            } catch(e) {
                logger.log.error(e, 'Exception caught creating server!');
                return nextModule(e);
            }
        }, err => {
            return next(err);
        });
    }, err => {
        return cb(err);
    });
}
