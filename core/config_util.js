/* jslint node: true */
'use strict';

const Config			= require('./config.js').get;
const ConfigCache		= require('./config_cache.js');
const Events			= require('./events.js');

//	deps
const paths				= require('path');
const async				= require('async');

exports.init			= init;
exports.getFullConfig	= getFullConfig;

function getConfigPath(filePath) {
    //	|filePath| is assumed to be in the config path if it's only a file name
    if('.' === paths.dirname(filePath)) {
        filePath = paths.join(Config().paths.config, filePath);
    }
    return filePath;
}

function init(cb) {
    //	pre-cache menu.hjson and prompt.hjson + establish events
    const changed = ( { fileName, fileRoot } ) => {
        const reCachedPath = paths.join(fileRoot, fileName);
        if(reCachedPath === getConfigPath(Config().general.menuFile)) {
            Events.emit(Events.getSystemEvents().MenusChanged);
        } else if(reCachedPath === getConfigPath(Config().general.promptFile)) {
            Events.emit(Events.getSystemEvents().PromptsChanged);
        }
    };

    const config = Config();
    async.series(
        [
            function menu(callback) {
                return ConfigCache.getConfigWithOptions(
                    {
                        filePath : getConfigPath(config.general.menuFile),
                        callback : changed,
                    },
                    callback
                );
            },
            function prompt(callback) {
                return ConfigCache.getConfigWithOptions(
                    {
                        filePath : getConfigPath(config.general.promptFile),
                        callback : changed,
                    },
                    callback
                );
            }
        ],
        err => {
            return cb(err);
        }
    );
}

function getFullConfig(filePath, cb) {
    ConfigCache.getConfig(getConfigPath(filePath), (err, config) => {
        return cb(err, config);
    });
}
