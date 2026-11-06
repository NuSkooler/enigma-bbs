//  ENiGMA½
const DefaultConfig = require('./config_default');
const ConfigLoader = require('./config_loader');
const { routeArchiversToUnarc } = require('./config/unarc_archivers');

const _ = require('lodash');
const paths = require('path');

//  Global system configuration instance; see Config.create()
let systemConfigInstance;

//
//  Built from config_default.js and config/meta.js, both static for the life
//  of the process: a hot reload changes the operator's data, never the shape
//  it is checked against. Built lazily so that merely requiring this module
//  costs nothing.
//
let schemaInstance;
function getSchema() {
    if (!schemaInstance) {
        schemaInstance = require('./config/schema.js').buildSchema();
    }
    return schemaInstance;
}

//
//  The defaults as this process runs them: config_default.js with
//  ENIGMA_UNARC_ARCHIVERS applied and, given the config.hjson being loaded,
//  paths.config pointed at the directory holding it. Both are applied here
//  and never in config_default.js itself, which the schema, `oputil.js config
//  new` and the reference checks are built from and which must not vary with
//  the environment or the command line. See config/unarc_archivers.js.
//
//  paths.config (#927): relative names such as general.menuFile, the
//  achievements file and the offline mail bulletins resolve against it, while
//  "includes" always resolved beside config.hjson. Defaulting it to that same
//  directory gives both one rule, so a board started with --config elsewhere
//  finds its files next to its config.hjson. For the stock layout the two are
//  the same directory and nothing changes.
//
//  It is a *default*: the operator's config.hjson is merged over it, so a
//  paths.config written there always wins, whatever its value -- including
//  the old install directory default, which after the merge would be
//  indistinguishable from it. Nothing has to tell the two apart afterwards.
//
function effectiveDefaults({ baseConfigPath } = {}) {
    const defaults = routeArchiversToUnarc(DefaultConfig());
    if (_.isString(baseConfigPath) && baseConfigPath) {
        defaults.paths.config = configDirOf(baseConfigPath);
    }
    return defaults;
}
exports.effectiveDefaults = effectiveDefaults;

//  The directory holding |baseConfigPath|, absolute, with a trailing separator
//  as config_default.js writes it. Absolute because oputil passes the path as
//  given on its command line, which may be relative to wherever it was run.
function configDirOf(baseConfigPath) {
    return paths.join(paths.resolve(paths.dirname(baseConfigPath)), paths.sep);
}

exports.Config = class Config extends ConfigLoader {
    constructor(options) {
        super(options);
    }

    static create(baseConfigPath, options, cb) {
        if (!cb && _.isFunction(options)) {
            cb = options;
            options = {};
        }

        const replacePaths = [
            'loginServers.ssh.algorithms.kex',
            'loginServers.ssh.algorithms.cipher',
            'loginServers.ssh.algorithms.hmac',
            'loginServers.ssh.algorithms.compress',
            //  a merge could never narrow the default trusted ranges
            'trustedProxies',
        ];

        const replaceKeys = ['args', 'sendArgs', 'recvArgs', 'recvArgsNonBatch'];

        options = options || {};

        //
        //  oputil's "config validate" runs the validator itself so it can
        //  choose its own formatting and exit code; without this it would also
        //  get the boot time report and say everything twice.
        //
        const reportValidation = false !== options.reportValidation;

        const configOptions = Object.assign({}, _.omit(options, 'reportValidation'), {
            //  called afresh on every load, hot reloads included, so the
            //  derived paths.config default is never lost
            defaultConfig: () => effectiveDefaults({ baseConfigPath }),
            defaultsCustomizer: (defaultVal, configVal, key, path) => {
                if (Array.isArray(defaultVal) && Array.isArray(configVal)) {
                    if (replacePaths.includes(path) || replaceKeys.includes(key)) {
                        //  full replacement using user config value
                        return configVal;
                    } else {
                        //  merge user config & default config; keep only unique
                        return [...new Set(defaultVal.concat(configVal))];
                    }
                }
            },
            //
            //  Advisory only: nothing here can stop a boot or fail a reload.
            //  ConfigLoader guards both calls, so a bug in any of this cannot
            //  take the board down.
            //
            validator: (userConfig, mergedConfig) => {
                const { isEnabled } = require('./config/report.js');
                if (!isEnabled(mergedConfig)) {
                    return [];
                }

                const { validateConfig } = require('./config/validate.js');
                const { validateReferences } = require('./config/refs.js');

                return [
                    ...validateConfig(userConfig, mergedConfig, getSchema()),
                    ...validateReferences(mergedConfig),
                ];
            },
            onValidation: reportValidation
                ? (issues, context) => {
                      require('./config/report.js').reportIssues(issues, context);
                  }
                : null,
            onReload: err => {
                if (!err) {
                    const Events = require('./events.js');
                    Events.emit(Events.getSystemEvents().ConfigChanged);
                }
            },
        });

        systemConfigInstance = new Config(configOptions);
        systemConfigInstance.init(baseConfigPath, err => {
            if (err) {
                return cb(err);
            }

            //  late bind an exported get method to the global Config
            //  instance we just created
            exports.get = systemConfigInstance.get.bind(systemConfigInstance);
            exports.reload = systemConfigInstance.reload.bind(systemConfigInstance);
            exports.getUserConfig =
                systemConfigInstance.getUserConfig.bind(systemConfigInstance);

            return cb(null);
        });
    }

    //  Path to config.hjson as loaded; undefined until create() has run.
    //  Anything generating a config include needs this to know where to
    //  write it.
    static getBasePath() {
        return systemConfigInstance ? systemConfigInstance.baseConfigPath : undefined;
    }

    static getDefaultPath() {
        //  e.g. /enigma-bbs-install-path/config/
        return './config/';
    }
};

// ── Test helpers ──────────────────────────────────────────────────────────────
// Replace exports.get with a function that returns |cfg|; returns the old getter
// so the caller can restore it with _popTestConfig.
exports._pushTestConfig = function (cfg) {
    const prev = exports.get;
    exports.get = () => cfg;
    return prev;
};

exports._popTestConfig = function (prev) {
    exports.get = prev;
};
