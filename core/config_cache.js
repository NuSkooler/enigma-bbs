/* jslint node: true */
'use strict';

//  deps
const paths = require('path');
const fs = require('graceful-fs');
const hjson = require('hjson');
const sane = require('sane');
const _ = require('lodash');

module.exports = new (class ConfigCache {
    constructor() {
        this.cache = new Map(); //  path->parsed config
    }

    getConfigWithOptions(options, cb) {
        options.hotReload = _.get(options, 'hotReload', true);
        const cached = this.cache.has(options.filePath);

        if (options.forceReCache || !cached) {
            this.recacheConfigFromFile(options.filePath, (err, config) => {
                if (!err && !cached) {
                    if (options.hotReload) {
                        const watcher = sane(paths.dirname(options.filePath), {
                            glob: `**/${paths.basename(options.filePath)}`,
                        });

                        watcher.on('change', (fileName, fileRoot) => {
                            require('./logger.js').log.info(
                                { fileName, fileRoot },
                                'Configuration file changed; re-caching'
                            );

                            this.recacheConfigFromFile(
                                paths.join(fileRoot, fileName),
                                err => {
                                    if (!err) {
                                        if (options.callback) {
                                            options.callback({
                                                fileName,
                                                fileRoot,
                                                configCache: this,
                                            });
                                        }
                                    }
                                }
                            );
                        });
                    }
                }
                return cb(err, config, true);
            });
        } else {
            return cb(null, this.cache.get(options.filePath), false);
        }
    }

    getConfig(filePath, cb) {
        return this.getConfigWithOptions({ filePath }, cb);
    }

    recacheConfigFromFile(path, cb) {
        fs.readFile(path, { encoding: 'utf-8' }, (err, data) => {
            if (err) {
                return cb(err);
            }

            let parsed;
            try {
                parsed = hjson.parse(data);
                this.cache.set(path, parsed);
            } catch (e) {
                try {
                    require('./logger.js').log.error(
                        { filePath: path, error: e.message },
                        'Failed to re-cache'
                    );
                } catch (ignored) {
                    //  nothing - we may be failing to parse the config in which we can't log here!
                }
                return cb(e);
            }

            return cb(null, parsed);
        });
    }
})();
