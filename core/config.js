//  ENiGMA½
const DefaultConfig = require('./config_default');
const ConfigLoader = require('./config_loader');

const _ = require('lodash');

//  Global system configuration instance; see Config.create()
let systemConfigInstance;

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
        ];

        const replaceKeys = ['args', 'sendArgs', 'recvArgs', 'recvArgsNonBatch'];

        const configOptions = Object.assign({}, options, {
            defaultConfig: DefaultConfig,
            defaultsCustomizer: (defaultVal, configVal, key, path) => {
                if (Array.isArray(defaultVal) && Array.isArray(configVal)) {
                    if (replacePaths.includes(path) || replaceKeys.includes(key)) {
                        //  full replacement using user config value
                        return configVal;
                    } else {
                        //  merge user config & default config; keep only unique
                        _.uniq(defaultVal.concat(configVal));
                    }
                }
            },
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

            return cb(null);
        });
    }

    static getDefaultPath() {
        //  e.g. /enigma-bbs-install-path/config/
        return './config/';
    }
};
