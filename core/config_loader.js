//  deps
const paths = require('path');
const fs = require('fs');
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
            validator = null,
            onValidation = null,
        } = {
            hotReload: true,
            defaultConfig: {},
            defaultsCustomizer: null,
            onReload: null,
            keepWsc: false,
            validator: null,
            onValidation: null,
        }
    ) {
        this.current = {};
        this.rawConfig = undefined;
        //  what the operator wrote, before defaults; see _reload()
        this.userConfig = {};
        this.lastIssues = [];
        this._hasLoaded = false;

        this.validator = validator;
        this.onValidation = onValidation;

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

    //
    //  Reload from disk right now, bypassing the file watcher and its debounce.
    //
    //  For a caller that has just written a config include and needs the new
    //  values live before it can continue, waiting on the ConfigChanged event
    //  is not safe: that event is emitted only on a *successful* reload, so a
    //  bad include leaves the previous config in place, emits nothing, and an
    //  unguarded await never returns.  Here the error comes straight back.
    //
    reload(cb) {
        //
        //  Read from disk, not from ConfigCache.  Without this, a caller that
        //  has just written an include gets the *previous* parsed copy back:
        //  the cache is only refreshed by the file watcher, which arrives
        //  later and on its own schedule.  An explicit reload has to mean
        //  what it says.
        //
        this._forceReCache = true;
        return this._reload(this.baseConfigPath, err => {
            this._forceReCache = false;

            if (_.isFunction(this.onReload)) {
                this.onReload(err);
            }
            return cb(err);
        });
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

    //  What the operator wrote -- the base file unioned with anything its
    //  "includes" pulled in -- with no defaults merged over it. Note that
    //  this copy is taken before @reference/@environment/@file are resolved,
    //  since it exists to answer questions about keys rather than values.
    getUserConfig() {
        return this.userConfig;
    }

    //  Issues from the most recent load; empty unless a validator was supplied.
    getIssues() {
        return this.lastIssues;
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
        //  4 - Resolve @reference, @environment, and @file
        //  5 - Perform any validation
        //
        async.waterfall(
            [
                callback => {
                    return this._loadConfigFile(baseConfigPath, (err, config) => {
                        if (err) {
                            return callback(err);
                        }

                        //
                        //  Keep what the operator actually wrote, before the
                        //  defaults are merged over the top of it. Afterwards
                        //  there is no way to tell a deliberate setting from a
                        //  default, so a misspelled key -- which lands beside
                        //  the correctly spelled default rather than replacing
                        //  it -- becomes invisible. Validation needs this copy
                        //  to see it.
                        //
                        this.userConfig = _.cloneDeep(config);

                        return callback(null, config);
                    });
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
                (config, callback) => {
                    this._validate(config);
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

    //
    //  Step 5 of the waterfall. Validation is advisory: it reports, and the
    //  configuration is applied either way.
    //
    //  Both calls are guarded because a *synchronous* throw inside an
    //  async.waterfall task does not reach the waterfall's callback -- it
    //  propagates straight out. _reload() runs from the file watcher, so an
    //  unguarded throw here would be an uncaught exception that takes the
    //  board down mid-session, on nothing worse than a bad config edit. A
    //  validator bug must never be able to do that.
    //
    _validate(config) {
        let issues = [];

        try {
            if (_.isFunction(this.validator)) {
                issues = this.validator(this.userConfig, config) || [];
            }
        } catch (e) {
            //  console: this can run before logger.init()
            console.info(`WARNING: configuration validation failed: ${e.message}`); //  eslint-disable-line no-console
        }

        this.lastIssues = issues;

        try {
            if (_.isFunction(this.onValidation)) {
                this.onValidation(issues, { initialLoad: !this._hasLoaded });
            }
        } catch (e) {
            console.info(
                `WARNING: configuration validation reporting failed: ${e.message}`
            ); //  eslint-disable-line no-console
        }

        this._hasLoaded = true;
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

    _resolveFileValue(spec) {
        //  spec format: @file:/path/to/secret  (or @file:relative/path)
        const filePath = spec.slice(6); //  strip "@file:"
        if (!filePath) {
            return console.info(`WARNING: empty path in spec "${spec}"`);
        }

        const resolvedPath = paths.isAbsolute(filePath)
            ? filePath
            : paths.join(paths.dirname(this.baseConfigPath), filePath);

        try {
            return fs.readFileSync(resolvedPath, 'utf8').trim();
        } catch (e) {
            return console.info(
                `WARNING: could not read file "${resolvedPath}" from spec "${spec}": ${e.message}`
            );
        }
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
            //  set for the duration of an explicit reload(); see above
            forceReCache: true === this._forceReCache,
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

                    //  an include is operator content too, so it belongs in
                    //  the pre-merge copy validation reads
                    if (_.isObject(this.userConfig)) {
                        _.defaultsDeep(this.userConfig, _.cloneDeep(includedConfig));
                    }

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
                } else if (value.startsWith('@file:')) {
                    value = this._resolveFileValue(value) || value;
                }
            }

            return value;
        });
    }
};
