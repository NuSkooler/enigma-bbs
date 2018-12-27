/* jslint node: true */
'use strict';

const PluginModule = require('./plugin_module.js').PluginModule;

exports.ServerModule = class ServerModule extends PluginModule {
    constructor(options) {
        super(options);
    }

    createServer(cb) {
        return cb(null);
    }

    listen(cb) {
        return cb(null);
    }
};
