'use strict';

const WebHandlerModule = require('../../../web_handler_module');
const { Errors } = require('../../../enig_error');
const { API_BASE, applyCorsHeaders, problemDetail } = require('../../../rest/util');

exports.moduleInfo = {
    name: 'RestApi',
    desc: 'ENiGMA½ REST API v1',
    author: 'NuSkooler',
    packageName: 'codes.l33t.enigma.web.handler.restapi',
};

exports.getModule = class RestApiWebHandler extends WebHandlerModule {
    constructor() {
        super();
    }

    init(webServer, cb) {
        this.webServer = webServer;

        if (!WebHandlerModule.isEnabled('restApi')) {
            return cb(null);
        }

        this.log = webServer.logger().child({ webHandler: 'RestApi' });

        this._registerRoutes(webServer);

        return cb(null);
    }

    _registerRoutes(webServer) {
        const base = API_BASE;

        //  Handle preflight OPTIONS for all API routes
        webServer.addRoute({
            method: 'OPTIONS',
            path: new RegExp(`^${base}/`),
            handler: (req, resp) => {
                applyCorsHeaders(req, resp);
                resp.writeHead(204);
                return resp.end();
            },
        });

        const authRoutes = require('../../../rest/routes/auth');
        authRoutes.register(webServer, this.log);

        const systemRoutes = require('../../../rest/routes/system');
        systemRoutes.register(webServer, this.log);

        const messageRoutes = require('../../../rest/routes/messages');
        messageRoutes.register(webServer, this.log);
    }
};
