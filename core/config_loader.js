//  deps
const paths = require('path');
const async = require('async');

const _ = require('lodash');
const reduceDeep = require('deepdash/getReduceDeep')(_);

module.exports = class ConfigLoader {
    constructor(options) {
        this.current = {};
        this.hotReload = _.get(options, 'hotReload', true);
    }

    static create(basePath, options, cb) {
        const config = new ConfigLoader(options);
        config._init(
            basePath,
            options,
            err => {
                return cb(err, config);
            }
        );
    }

    get() {
        return this.current;
    }

    _convertTo(value, type) {
        switch (type) {
            case 'bool' :
            case 'boolean' :
                value = 'true' === value.toLowerCase();
                break;

            case 'number' :
                {
                    const num = parseInt(value);
                    if (!isNaN(num)) {
                        value = num;
                    }
                }
                break;

            case 'object' :
                try {
                    value = JSON.parse(value);
                } catch(e) { }
                break;

            case 'date' :
            case 'time' :
            case 'datetime' :
            case 'timestamp' :
                {
                    const m = moment(value);
                    if (m.isValid()) {
                        value = m;
                    }
                }
                break;

            case 'regex' :
                //	:TODO: What flags to use, etc.?
                break;
        }

        return value;
    }

    _resolveEnvironmentVariable(spec) {
        const [prefix, varName, type, array] = spec.split(':');
        if (!varName) {
            return;
        }

        let value = process.env[varName];
        if (!value) {
            return;
        }

        if ('array' === array) {
            value = value.split(',').map(v => this._convertTo(v, type));
        } else {
            value = this._convertTo(value, type);
        }

        return value;
    }

    _loadConfigFile(filePath, cb) {
        const ConfigCache = require('./config_cache');

        const options = {
            filePath,
            hotReload   : this.hotReload,
            callback    : this._configFileChanged.bind(this),
        };

        ConfigCache.getConfigWithOptions(options, (err, config) => {
            return cb(err, config);
        });
    }

    _configFileChanged({fileName, fileRoot}) {
        const reCachedPath = paths.join(fileRoot, fileName);
        ConfigCache.getConfig(reCachedPath, (err, config) => {
            /*
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
            */
        });
    }

    _init(basePath, options, cb) {
        options.defaultConfig = options.defaultConfig || {};

        //
        //  1 - Fetch base configuration from |basePath|
        //  2 - Merge with |defaultConfig|, if any
        //  3 - Resolve any includes
        //  4 - Resolve @reference and @environment
        //  5 - Perform any validation
        //
        async.waterfall(
            [
                (callback) => {
                    return this._loadConfigFile(basePath, callback);
                },
                (config, callback) => {
                    if (_.isFunction(options.defaultsCustomizer)) {
                        const stack = [];
                        const mergedConfig = _.mergeWith(
                            options.defaultConfig,
                            config,
                            (defaultVal, configVal, key, target, source) => {
                                var path;
                                while (true) {
                                    if (!stack.length) {
                                        stack.push({source, path : []});
                                    }

                                    const prev = stack[stack.length - 1];

                                    if (source === prev.source) {
                                        path = prev.path.concat(key);
                                        stack.push({source : configVal, path});
                                        break;
                                    }

                                    stack.pop();
                                }

                                path = path.join('.');
                                return options.defaultsCustomizer(defaultVal, configVal, key, path);
                            }
                        );

                        return callback(null, mergedConfig);
                    }

                    //  :TODO: correct?
                    return callback(null, _.merge(options.defaultConfig, config));
                },
                (config, callback) => {
                    const configRoot = paths.dirname(basePath);
                    return this._resolveIncludes(configRoot, config, callback);
                },
                (config, callback) => {
                    config = this._resolveAtSpecs(config);
                    return callback(null, config);
                },
            ],
            (err, config) => {
                if (!err) {
                    this.current = config;
                }
                return cb(err);
            }
        );
    }

    _resolveIncludes(configRoot, config, cb) {
        if (!Array.isArray(config.includes)) {
            return cb(null, config);
        }

        //  If a included file is changed, we need to re-cache, so this
        //  must be tracked...
        const includePaths = config.includes.map(inc => paths.join(configRoot, inc));
        async.eachSeries(includePaths, (includePath, nextIncludePath) => {
            this._loadConfigFile(includePath, (err, includedConfig) => {
                if (err) {
                    return nextIncludePath(err);
                }

                _.defaultsDeep(config, includedConfig);
                return nextIncludePath(null);
            });
        },
        err => {
            return cb(err, config);
        });
    }

    _resolveAtSpecs(config) {
        //  :TODO: mapValuesDeep may be better here
        return reduceDeep(
            config,
            (acc, value, key, parent, ctx) => {
                //	resolve self references; there may be a better way...
                if (_.isString(value) && '@' === value.charAt(0)) {
                    if (value.startsWith('@reference:')) {
                        value = value.slice(11);
                        const ref = _.get(acc, value);
                        if (ref) {
                            _.set(acc, ctx.path, ref);
                        }
                    } else if (value.startsWith('@environment:')) {
                        value = this._resolveEnvironmentVariable(value);
                        if (!_.isUndefined(value)) {
                            _.set(acc, ctx.path, value);
                        }
                    }
                }
                return acc;
            }
        );
    }
};
