/* jslint node: true */
'use strict';

//  ENiGMA½
var PluginModule = require('./plugin_module.js').PluginModule;

exports.MessageScanTossModule = MessageScanTossModule;

function MessageScanTossModule() {
    PluginModule.call(this);
}

require('util').inherits(MessageScanTossModule, PluginModule);

MessageScanTossModule.prototype.startup = function (cb) {
    return cb(null);
};

MessageScanTossModule.prototype.shutdown = function (cb) {
    return cb(null);
};

MessageScanTossModule.prototype.record = function (/*message*/) {};
