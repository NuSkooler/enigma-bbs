const { PluginModule } = require('./plugin_module');

module.exports = class WebHandlerModule extends PluginModule {
    constructor(options) {
        super(options);
    }

    init(cb) {
        // to be implemented!
        return cb(null);
    }
};
