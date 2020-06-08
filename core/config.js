/* jslint node: true */
'use strict';

//  ENiGMA½
const Errors = require('./enig_error.js').Errors;
const DefaultConfig = require('./config_default');

//  deps
const paths = require('path');
const async = require('async');
const _ = require('lodash');
const assert = require('assert');

exports.init                = init;
exports.getDefaultPath      = getDefaultPath;

let currentConfiguration = {};

function hasMessageConferenceAndArea(config) {
    assert(_.isObject(config.messageConferences));  //  we create one ourself!

    const nonInternalConfs = Object.keys(config.messageConferences).filter(confTag => {
        return 'system_internal' !== confTag;
    });

    if(0 === nonInternalConfs.length) {
        return false;
    }

    //  :TODO: there is likely a better/cleaner way of doing this

    let result = false;
    _.forEach(nonInternalConfs, confTag => {
        if(_.has(config.messageConferences[confTag], 'areas') &&
            Object.keys(config.messageConferences[confTag].areas) > 0)
        {
            result = true;
            return false;   //  stop iteration
        }
    });

    return result;
}

const ArrayReplaceKeyPaths = [
    'loginServers.ssh.algorithms.kex',
    'loginServers.ssh.algorithms.cipher',
    'loginServers.ssh.algorithms.hmac',
    'loginServers.ssh.algorithms.compress',
];

const ArrayReplaceKeys = [
    'args',
    'sendArgs', 'recvArgs', 'recvArgsNonBatch',
];

function mergeValidateAndFinalize(config, cb) {
    const defaultConfig = DefaultConfig();

    const arrayReplaceKeyPathsMutable = _.clone(ArrayReplaceKeyPaths);
    const shouldReplaceArray = (arr, key) => {
        if(ArrayReplaceKeys.includes(key)) {
            return true;
        }
        for(let i = 0; i < arrayReplaceKeyPathsMutable.length; ++i) {
            const o = _.get(defaultConfig, arrayReplaceKeyPathsMutable[i]);
            if(_.isEqual(o, arr)) {
                arrayReplaceKeyPathsMutable.splice(i, 1);
                return true;
            }
        }
        return false;
    };

    async.waterfall(
        [
            function mergeWithDefaultConfig(callback) {
                const mergedConfig = _.mergeWith(
                    defaultConfig,
                    config,
                    (defConfig, userConfig, key) => {
                        if(Array.isArray(defConfig) && Array.isArray(userConfig)) {
                            //
                            //  Arrays are special: Some we merge, while others
                            //  we simply replace.
                            //
                            if(shouldReplaceArray(defConfig, key)) {
                                return userConfig;
                            } else {
                                return _.uniq(defConfig.concat(userConfig));
                            }
                        }
                    }
                );

                return callback(null, mergedConfig);
            },
            function validate(mergedConfig, callback) {
                //
                //  Various sections must now exist in config
                //
                //  :TODO: Logic is broken here:
                if(hasMessageConferenceAndArea(mergedConfig)) {
                    return callback(Errors.MissingConfig('Please create at least one message conference and area!'));
                }
                return callback(null, mergedConfig);
            },
            function setIt(mergedConfig, callback) {
                currentConfiguration = mergedConfig;
                exports.get = () => currentConfiguration;
                return callback(null);
            }
        ],
        err => {
            if(cb) {
                return cb(err);
            }
        }
    );
}

function init(configPath, options, cb) {
    if(!cb && _.isFunction(options)) {
        cb = options;
        options = {};
    }

    const changed = ( { fileName, fileRoot } ) => {
        const reCachedPath = paths.join(fileRoot, fileName);
        ConfigCache.getConfig(reCachedPath, (err, config) => {
            if(!err) {
                mergeValidateAndFinalize(config, err => {
                    if(!err) {
                        const Events = require('./events.js');
                        Events.emit(Events.getSystemEvents().ConfigChanged);
                    }
                });
            } else {
                console.stdout(`Configuration ${reCachedPath} is invalid: ${err.message}`); //  eslint-disable-line no-console
            }
        });
    };

    const ConfigCache = require('./config_cache.js');
    const getConfigOptions = {
        filePath    : configPath,
        noWatch     : options.noWatch,
    };
    if(!options.noWatch) {
        getConfigOptions.callback = changed;
    }
    ConfigCache.getConfigWithOptions(getConfigOptions, (err, config) => {
        if(err) {
            return cb(err);
        }

        return mergeValidateAndFinalize(config, cb);
    });
}

function getDefaultPath() {
    //  e.g. /enigma-bbs-install-path/config/
    return './config/';
}
