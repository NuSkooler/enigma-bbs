const WebHandlerModule = require('../../../web_handler_module');
const { Errors } = require('../../../enig_error');
const EngiAssert = require('../../../enigma_assert');
const Config = require('../../../config').get;
const { getFullUrl, getWebDomain } = require('../../../web_util');

// deps
const paths = require('path');
const fs = require('fs');
const mimeTypes = require('mime-types');
const get = require('lodash/get');

exports.moduleInfo = {
    name: 'SystemGeneral',
    desc: 'A general handler for system routes',
    author: 'NuSkooler',
    packageName: 'codes.l33t.enigma.web.handler.general_system',
};

exports.getModule = class SystemGeneralWebHandler extends WebHandlerModule {
    constructor() {
        super();
    }

    init(webServer, cb) {
        // we rely on the web server
        this.webServer = webServer;
        EngiAssert(webServer, 'System General Web Handler init without webServer');

        this.log = webServer.logger().child({ webHandler: 'SysGeneral' });

        const domain = getWebDomain();
        if (!domain) {
            return cb(Errors.UnexpectedState('Web server does not have "domain" set'));
        }

        //  default avatar routing
        this.webServer.addRoute({
            method: 'GET',
            path: /^\/_enig\/users\/.+\/avatar\/.+\.(png|jpg|jpeg|gif|webp)$/,
            handler: this._avatarGetHandler.bind(this),
        });

        return cb(null);
    }

    _avatarGetHandler(req, resp) {
        const url = getFullUrl(req);
        const filename = paths.basename(url.pathname);
        if (!filename) {
            return this.webServer.fileNotFound(resp);
        }

        const storagePath = get(Config(), 'users.avatars.storagePath');
        if (!storagePath) {
            return this.webServer.fileNotFound(resp);
        }

        const localPath = paths.join(storagePath, filename);
        fs.stat(localPath, (err, stats) => {
            if (err || !stats.isFile()) {
                return this.webServer.accessDenied(resp);
            }

            const headers = {
                'Content-Type':
                    mimeTypes.contentType(paths.basename(localPath)) ||
                    mimeTypes.contentType('.png'),
                'Content-Length': stats.size,
            };

            const readStream = fs.createReadStream(localPath);
            resp.writeHead(200, headers);
            readStream.pipe(resp);
        });
    }
};
