//  deps
const paths = require('path');
const async = require('async');
const moment = require('moment');

const _ = require('lodash');
const mapValuesDeep = require('deepdash/getMapValuesDeep')(_);

module.exports = class ConfigLoader {
    constructor(
        {
            hotReload = true,
            defaultConfig = {},
            defaultsCustomizer = null,
            onReload = null,
            keepWsc = false,
        } = {
            hotReload: true,
            defaultConfig: {},
            defaultsCustomizer: null,
            onReload: null,
            keepWsc: false,
        }
    ) {
        this.current = {};
        this.rawConfig = undefined;

        this.hotReload = hotReload;
        this.defaultConfig = defaultConfig;
        this.defaultsCustomizer = defaultsCustomizer;
        this.onReload = onReload;
        this.keepWsc = keepWsc;

        //  Coalesce rapid/burst file-change events into a single reload.
        //  300 ms absorbs editor atomic-save patterns (write-tmp + rename = 2 events)
        //  without feeling sluggish to operators.
        this._scheduleReload = _.debounce(() => {
            this._reload(this.baseConfigPath, err => {
                if (_.isFunction(this.onReload)) {
                    this.onReload(err);
                }
            });
        }, 300);
    }

    init(baseConfigPath, cb) {
        this.baseConfigPath = baseConfigPath;
        return this._reload(baseConfigPath, cb);
    }

    //  Returns the current effective config.  When theme.js finalises a merged
    //  theme it writes back to this.current directly; get() surfaces that value.
    get() {
        return this.current;
    }

    //  Returns the raw parsed config from disk, unaffected by any external
    //  overlay (e.g. the theme/menu merge written to this.current by ThemeManager).
    getRaw() {
        return this.rawConfig !== undefined ? this.rawConfig : this.current;
    }

    _reload(baseConfigPath, cb) {
        let defaultConfig;
        if (_.isFunction(this.defaultConfig)) {
            defaultConfig = this.defaultConfig();
        } else if (_.isObject(this.defaultConfig)) {
            defaultConfig = this.defaultConfig;
        } else {
            defaultConfig = {};
        }

        //
        //  1 - Fetch base configuration from |baseConfigPath|
        //  2 - Merge with |defaultConfig|
        //  3 - Resolve any includes
        //  4 - Resolve @reference and @environment
        //  5 - Perform any validation
        //
        async.waterfall(
            [
                callback => {
                    return this._loadConfigFile(baseConfigPath, callback);
                },
                (config, callback) => {
                    if (_.isFunction(this.defaultsCustomizer)) {
                        const stack = [];
                        const mergedConfig = _.mergeWith(
                            defaultConfig,
                            config,
                            (defaultVal, configVal, key, target, source) => {
                                let path;
                                while (true) {
                                    //  eslint-disable-line no-constant-condition
                                    if (!stack.length) {
                                        stack.push({ source, path: [] });
                                    }

                                    const prev = stack[stack.length - 1];

                                    if (source === prev.source) {
                                        path = prev.path.concat(key);
                                        stack.push({ source: configVal, path });
                                        break;
                                    }

                                    stack.pop();
                                }

                                path = path.join('.');
                                return this.defaultsCustomizer(
                                    defaultVal,
                                    configVal,
                                    key,
                                    path
                                );
                            }
                        );

                        return callback(null, mergedConfig);
                    }

                    return callback(null, _.merge(defaultConfig, config));
                },
                (config, callback) => {
                    const configRoot = paths.dirname(baseConfigPath);
                    return this._resolveIncludes(configRoot, config, callback);
                },
                (config, callback) => {
                    config = this._resolveAtSpecs(config);
                    return callback(null, config);
                },
            ],
            (err, config) => {
                if (!err) {
                    this.rawConfig = config;
                    this.current = config;
                }
                return cb(err);
            }
        );
    }

    _convertTo(value, type) {
        switch (type) {
            case 'bool':
            case 'boolean':
                value = '1' === value || 'true' === value.toLowerCase();
                break;

            case 'number':
                {
                    const num = parseInt(value);
                    if (!isNaN(num)) {
                        value = num;
                    }
                }
                break;

            case 'object':
                try {
                    value = JSON.parse(value);
                } catch (e) {
                    //  ignored
                }
                break;

            case 'timestamp':
                {
                    const m = moment(value);
                    if (m.isValid()) {
                        value = m;
                    }
                }
                break;
        }

        return value;
    }

    _resolveEnvironmentVariable(spec) {
        const [, varName, type, array] = spec.split(':');
        if (!varName) {
            return;
        }

        let value = process.env[varName];
        if (!value) {
            //  console is about as good as we can do here
            return console.info(
                `WARNING: environment variable "${varName}" from spec "${spec}" not found!`
            );
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
            hotReload: this.hotReload,
            keepWsc: this.keepWsc,
            callback: this._configFileChanged.bind(this),
        };

        ConfigCache.getConfigWithOptions(options, (err, config) => {
            if (err) {
                err.configPath = options.filePath;
            }
            return cb(err, config);
        });
    }

    _configFileChanged({ fileName, fileRoot }) {
        const reCachedPath = paths.join(fileRoot, fileName);
        //  configPaths is set only after the first _resolveIncludes completes;
        //  guard against a watcher firing during the initial async load.
        if (this.configPaths && this.configPaths.includes(reCachedPath)) {
            this._scheduleReload();
        }
    }

    _resolveIncludes(configRoot, config, cb) {
        if (!Array.isArray(config.includes)) {
            this.configPaths = [this.baseConfigPath];
            return cb(null, config);
        }

        //  If a included file is changed, we need to re-cache, so this
        //  must be tracked...
        const includePaths = config.includes.map(inc => paths.join(configRoot, inc));
        async.eachSeries(
            includePaths,
            (includePath, nextIncludePath) => {
                this._loadConfigFile(includePath, (err, includedConfig) => {
                    if (err) {
                        return nextIncludePath(err);
                    }

                    _.defaultsDeep(config, includedConfig);
                    return nextIncludePath(null);
                });
            },
            err => {
                this.configPaths = [this.baseConfigPath, ...includePaths];
                return cb(err, config);
            }
        );
    }

    _resolveAtSpecs(config) {
        return mapValuesDeep(config, value => {
            if (_.isString(value) && '@' === value.charAt(0)) {
                if (value.startsWith('@reference:')) {
                    const refPath = value.slice(11);
                    value = _.get(config, refPath, value);
                } else if (value.startsWith('@environment:')) {
                    value = this._resolveEnvironmentVariable(value) || value;
                }
            }

            return value;
        });
    }
};
