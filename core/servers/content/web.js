//  ENiGMA½
const SysLogger = require('../../logger.js').log;
const ServerModule = require('../../server_module.js').ServerModule;
const Config = require('../../config.js').get;
const { Errors } = require('../../enig_error.js');
const { loadModulesForCategory, moduleCategories } = require('../../module_util');
const WebHandlerModule = require('../../web_handler_module');

//  deps
const http = require('http');
const https = require('https');
const _ = require('lodash');
const fs = require('graceful-fs');
const paths = require('path');
const mimeTypes = require('mime-types');
const forEachSeries = require('async/forEachSeries');
const findSeries = require('async/findSeries');
const WebLog = require('../../web_log.js');

class RateLimiter {
    constructor() {
        //  ip+key -> array of timestamps (ms)
        this._windows = new Map();
    }

    //  Returns true if the request is allowed, false if it exceeds the limit.
    //  opts: { windowMs, maxRequests }
    check(ip, key, opts) {
        const now = Date.now();
        const mapKey = `${ip}:${key}`;
        let timestamps = this._windows.get(mapKey) || [];

        //  Prune entries outside the current window
        timestamps = timestamps.filter(t => now - t < opts.windowMs);

        if (timestamps.length >= opts.maxRequests) {
            this._windows.set(mapKey, timestamps);
            return false;
        }

        timestamps.push(now);
        this._windows.set(mapKey, timestamps);
        return true;
    }
}

const ModuleInfo = (exports.moduleInfo = {
    name: 'Web',
    desc: 'Web Server',
    author: 'NuSkooler',
    packageName: 'codes.l33t.enigma.web.server',
});

exports.WellKnownLocations = {
    Rfc5785: '/.well-known', //  https://www.rfc-editor.org/rfc/rfc5785
    Internal: '/_enig', //  location of most enigma provided routes
};

class Route {
    constructor(route) {
        Object.assign(this, route);

        if (this.method) {
            this.method = this.method.toUpperCase();
        }

        try {
            this.pathRegExp = new RegExp(this.path);
        } catch (e) {
            this.log.error({ route: route }, 'Invalid regular expression for route path');
        }
    }

    isValid() {
        return (
            (this.pathRegExp instanceof RegExp &&
                -1 !==
                    [
                        'GET',
                        'HEAD',
                        'POST',
                        'PUT',
                        'DELETE',
                        'CONNECT',
                        'OPTIONS',
                        'TRACE',
                    ].indexOf(this.method)) ||
            !_.isFunction(this.handler)
        );
    }

    matchesRequest(req) {
        return req.method === this.method && this.pathRegExp.test(req.url);
    }

    getRouteKey() {
        return `${this.method}:${this.path}`;
    }
}

exports.getModule = class WebServerModule extends ServerModule {
    constructor() {
        super();

        this.log = WebLog.createWebLog();

        const config = Config();
        this.enableHttp = config.contentServers.web.http.enabled || false;
        this.enableHttps = config.contentServers.web.https.enabled || false;

        this.routes = {};
        this._rateLimiter = new RateLimiter();
    }

    logger() {
        return this.log;
    }

    isEnabled() {
        return this.enableHttp || this.enableHttps;
    }

    createServer(cb) {
        if (this.enableHttp) {
            this.httpServer = http.createServer((req, resp) => {
                resp.on('error', err => {
                    this.log.error({ error: err.message }, 'Response error');
                });
                this.routeRequest(req, resp);
            });
        }

        const config = Config();
        if (this.enableHttps) {
            const options = {
                cert: fs.readFileSync(config.contentServers.web.https.certPem),
                key: fs.readFileSync(config.contentServers.web.https.keyPem),
            };

            //  additional options
            Object.assign(options, config.contentServers.web.https.options || {});

            this.httpsServer = https.createServer(options, (req, resp) =>
                this.routeRequest(req, resp)
            );
        }

        return cb(null);
    }

    beforeListen(cb) {
        if (!this.isEnabled()) {
            return cb(null);
        }

        loadModulesForCategory(
            moduleCategories.WebHandlers,
            (module, nextModule) => {
                const moduleInst = new module.getModule();
                try {
                    const normalizedName = _.camelCase(module.moduleInfo.name);
                    if (!WebHandlerModule.isEnabled(normalizedName)) {
                        SysLogger.info(
                            { moduleName: normalizedName },
                            'Web handler module not enabled'
                        );
                        return nextModule(null);
                    }

                    SysLogger.info(
                        { moduleName: normalizedName },
                        'Initializing web handler module'
                    );

                    moduleInst.init(this, err => {
                        return nextModule(err);
                    });
                } catch (e) {
                    SysLogger.error(
                        { error: e.message },
                        'Exception caught loading web handler'
                    );
                    return nextModule(e);
                }
            },
            err => {
                return cb(err);
            }
        );
    }

    listen(cb) {
        const config = Config();
        forEachSeries(
            ['http', 'https'],
            (service, nextService) => {
                const name = `${service}Server`;
                if (this[name]) {
                    const port = parseInt(config.contentServers.web[service].port);
                    if (isNaN(port)) {
                        SysLogger.error(
                            {
                                port: config.contentServers.web[service].port,
                                server: ModuleInfo.name,
                            },
                            `Invalid web port (${service})`
                        );
                        return nextService(
                            Errors.Invalid(
                                `Invalid port: ${config.contentServers.web[service].port}`
                            )
                        );
                    }

                    this[name].listen(
                        port,
                        config.contentServers.web[service].address,
                        err => {
                            return nextService(err);
                        }
                    );
                } else {
                    return nextService(null);
                }
            },
            err => {
                return cb(err);
            }
        );
    }

    addRoute(route) {
        route = new Route(route);

        if (!route.isValid()) {
            SysLogger.error({ route: route }, 'Cannot add invalid route');
            return false;
        }

        const routeKey = route.getRouteKey();
        if (routeKey in this.routes) {
            SysLogger.warn(
                { route: route, routeKey: routeKey },
                'Cannot add route: duplicate method/path combination exists'
            );
            return false;
        }

        this.routes[routeKey] = route;
        return true;
    }

    routeRequest(req, resp) {
        this.log.trace({ req }, 'Request');

        let route = _.find(this.routes, r => r.matchesRequest(req));

        if (route) {
            return route.handler(req, resp);
        } else {
            this.tryStaticRoute(req, resp, wasHandled => {
                if (!wasHandled) {
                    this.tryRouteIndex(req, resp, wasHandled => {
                        if (!wasHandled) {
                            return this.fileNotFound(resp);
                        }
                    });
                }
            });
        }
    }

    //  Returns true if the request is within limits; false (and sends 429) if not.
    checkRateLimit(req, resp, key, opts) {
        const ip = req.socket.remoteAddress || 'unknown';
        if (this._rateLimiter.check(ip, key, opts)) {
            return true;
        }
        this.log.warn({ ip, key }, 'Rate limit exceeded');
        return (this.rateLimitExceeded(resp), false);
    }

    rateLimitExceeded(resp) {
        return this.respondWithError(
            resp,
            429,
            'Too many requests.',
            'Too Many Requests'
        );
    }

    respondWithError(resp, code, bodyText, title) {
        const customErrorPage = paths.join(
            Config().contentServers.web.staticRoot,
            `${code}.html`
        );

        fs.readFile(customErrorPage, 'utf8', (err, data) => {
            resp.writeHead(code, { 'Content-Type': 'text/html' });

            if (err) {
                return resp.end(`<!doctype html>
                    <html lang="en">
                        <head>
                        <meta charset="utf-8">
                        <title>${title}</title>
                        <meta name="viewport" content="width=device-width, initial-scale=1">
                        </head>
                        <body>
                            <article>
                                <h2>${bodyText}</h2>
                            </article>
                        </body>
                    </html>`);
            }

            return resp.end(data);
        });
    }

    ok(resp, body = '', headers = { 'Content-Type': 'text/html' }) {
        if (body && !headers['Content-Length']) {
            headers['Content-Length'] = Buffer.from(body).length;
        }
        resp.writeHead(200, 'OK', body ? headers : null);
        return resp.end(body);
    }

    created(resp, body = '', headers = { 'Content-Type': 'text/html' }) {
        resp.writeHead(201, 'Created', body ? headers : null);
        return resp.end(body);
    }

    accepted(resp, body = '', headers = { 'Content-Type': 'text/html' }) {
        resp.writeHead(202, 'Accepted', body ? headers : null);
        return resp.end(body);
    }

    badRequest(resp) {
        return this.respondWithError(resp, 400, 'Bad request.', 'Bad Request');
    }

    accessDenied(resp) {
        return this.respondWithError(resp, 401, 'Access denied.', 'Access Denied');
    }

    fileNotFound(resp) {
        return this.respondWithError(resp, 404, 'File not found.', 'File Not Found');
    }

    resourceNotFound(resp) {
        return this.respondWithError(
            resp,
            404,
            'Resource not found.',
            'Resource Not Found'
        );
    }

    internalServerError(resp, err) {
        if (err) {
            this.log.error({ error: err.message }, 'Internal server error');
        }
        return this.respondWithError(
            resp,
            500,
            'Internal server error.',
            'Internal Server Error'
        );
    }

    notImplemented(resp) {
        return this.respondWithError(resp, 501, 'Not implemented.', 'Not Implemented');
    }

    requestEntityTooLarge(resp) {
        return this.respondWithError(
            resp,
            413,
            'Request entity too large.',
            'Request Entity Too Large'
        );
    }

    tryRouteIndex(req, resp, cb) {
        const tryFiles = Config().contentServers.web.tryFiles || [
            'index.html',
            'index.htm',
        ];

        findSeries(
            tryFiles,
            (tryFile, nextTryFile) => {
                const fileName = paths.join(
                    req.url.substr(req.url.lastIndexOf('/', 1)),
                    tryFile
                );

                this.resolveStaticPath(fileName, (err, filePath) => {
                    if (err || !filePath) {
                        return nextTryFile(null, false);
                    }

                    fs.stat(filePath, (err, stats) => {
                        if (err || !stats.isFile()) {
                            return nextTryFile(null, false);
                        }

                        const headers = {
                            'Content-Type':
                                mimeTypes.contentType(paths.basename(filePath)) ||
                                mimeTypes.contentType('.bin'),
                            'Content-Length': stats.size,
                        };

                        const readStream = fs.createReadStream(filePath);
                        resp.writeHead(200, headers);
                        readStream.pipe(resp);

                        return nextTryFile(null, true);
                    });
                });
            },
            (_, wasHandled) => {
                return cb(wasHandled);
            }
        );
    }

    tryStaticRoute(req, resp, cb) {
        const fileName = req.url.substr(req.url.lastIndexOf('/', 1));

        this.resolveStaticPath(fileName, (err, filePath) => {
            if (err || !filePath) {
                return cb(false);
            }

            fs.stat(filePath, (err, stats) => {
                if (err || !stats.isFile()) {
                    return cb(false);
                }

                const headers = {
                    'Content-Type':
                        mimeTypes.contentType(paths.basename(filePath)) ||
                        mimeTypes.contentType('.bin'),
                    'Content-Length': stats.size,
                };

                const readStream = fs.createReadStream(filePath);
                resp.writeHead(200, headers);
                readStream.pipe(resp);

                return cb(true);
            });
        });
    }

    resolveStaticPath(requestPath, cb) {
        const staticRoot = _.get(Config(), 'contentServers.web.staticRoot');
        //  Ensure the root ends with a separator so '/srv/wwwevil' can't pass
        //  a startsWith('/srv/www') check.
        const rootWithSep = staticRoot.endsWith(paths.sep)
            ? staticRoot
            : staticRoot + paths.sep;
        const candidate = paths.resolve(staticRoot, `.${requestPath}`);

        //  Lexical check first — rejects obvious traversal without touching the FS.
        if (!candidate.startsWith(rootWithSep)) {
            return cb(null, null);
        }

        //  Dereference symlinks so a link inside staticRoot pointing outside
        //  it cannot escape the guard.
        fs.realpath(candidate, (err, real) => {
            if (err) {
                return cb(null, null); //  path doesn't exist — not found
            }
            return cb(null, real.startsWith(rootWithSep) ? real : null);
        });
    }

    resolveTemplatePath(templatePath, cb) {
        if (paths.isAbsolute(templatePath)) {
            //  Absolute paths are operator-supplied from config; use as-is.
            return cb(null, templatePath);
        }

        const staticRoot = _.get(Config(), 'contentServers.web.staticRoot');
        const rootWithSep = staticRoot.endsWith(paths.sep)
            ? staticRoot
            : staticRoot + paths.sep;
        const candidate = paths.resolve(staticRoot, templatePath);

        if (!candidate.startsWith(rootWithSep)) {
            return cb(null, null);
        }

        fs.realpath(candidate, (err, real) => {
            if (err) {
                return cb(null, null);
            }
            return cb(null, real.startsWith(rootWithSep) ? real : null);
        });
    }

    routeTemplateFilePage(templatePath, preprocessCallback, resp) {
        const self = this;

        fs.readFile(templatePath, 'utf8', (err, templateData) => {
            if (err) {
                return self.fileNotFound(resp);
            }

            preprocessCallback(templateData, (err, finalPage, contentType) => {
                if (err || !finalPage) {
                    return self.respondWithError(
                        resp,
                        500,
                        'Internal Server Error.',
                        'Internal Server Error'
                    );
                }

                const headers = {
                    'Content-Type': contentType || mimeTypes.contentType('.html'),
                    'Content-Length': finalPage.length,
                };

                resp.writeHead(200, headers);
                return resp.end(finalPage);
            });
        });
    }
};
