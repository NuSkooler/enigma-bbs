const { PluginModule } = require('./plugin_module');
const Config = require('./config').get;

module.exports = class WebHandlerModule extends PluginModule {
    constructor(options) {
        super(options);
    }

    init(cb) {
        // to be implemented!
        return cb(null);
    }

    static isEnabled(handlerName) {
        const config = Config();
        const handlers = config.contentServers?.web?.handlers;
        return handlers && true === handlers[handlerName]?.enabled;
    }

    static getWebServer() {
        const { getServer } = require('./listening_server');
        const WebServerPackageName = require('./servers/content/web').moduleInfo
            .packageName;
        const ws = getServer(WebServerPackageName);
        if (ws) {
            return ws.instance;
        }
    }
};
