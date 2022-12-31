const { ServerModule } = require('../../../server_module');
const Config = require('../../../config').get;

const WebServerPackageName = require('../web').moduleInfo.packageName;

const _ = require('lodash');

exports.moduleInfo = {
    name: 'WebFinger',
    desc: 'A simple WebFinger Server',
    author: 'NuSkooler',
    packageName: 'codes.l33t.enigma.web.finger.server',
};

exports.getModule = class WebFingerServerModule extends ServerModule {
    constructor() {
        super();
    }

    init(cb) {
        if (!_.get(Config(), 'contentServers.web.handlers.webFinger.enabled')) {
            return cb(null);
        }

        const { getServer } = require('../../../listening_server');

        // we rely on the web server
        this.webServer = getServer(WebServerPackageName);
        if (!this.webServer || !this.webServer.instance.isEnabled()) {
            return cb(null);
            //return cb(Errors.DoesNotExist('Missing dependent server: Web server. Is it enabled?'));
        }

        this.webServer.instance.addRoute({
            method: 'GET',
            path: /^\/\.well-known\/webfinger\/?\?/,
            handler: this._webFingerRequestHandler.bind(this),
        });

        return cb(null);
    }

    _webFingerRequestHandler(req, resp) {
        console.log(req);
    }
};
