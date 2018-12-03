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
        moduleUtil.loadModulesForCategory(`${category}Servers`, (err, module) => {
            if(err) {
                if(ErrorReasons.Disabled === err.reasonCode) {
                    logger.log.debug(err.message);
                } else {
                    logger.log.info( { err : err }, 'Failed loading module');
                }
                return;
            }

            const moduleInst = new module.getModule();
            try {
                moduleInst.createServer();
                if(!moduleInst.listen()) {
                    throw new Error('Failed listening');
                }

                listeningServers[module.moduleInfo.packageName] = {
                    instance    : moduleInst,
                    info        : module.moduleInfo,
                };

            } catch(e) {
                logger.log.error(e, 'Exception caught creating server!');
            }
        }, err => {
            return next(err);
        });
    }, err => {
        return cb(err);
    });
}
