/* jslint node: true */
'use strict';

//
//  /_enig/ws-term/: serves an operator installed copy of enig-term, the
//  browser terminal, from contentServers.web.wsTerm.root.
//
//  Off by default and with no switch of its own: the route answers only while
//  the root directory exists and holds an index.html, so an operator turns it
//  on by copying enig-term's dist/ into place and off by removing it. That is
//  checked per request (a stat or two), so neither needs a restart. Until
//  then every request is a 404, as if the route did not exist.
//
//  ENiGMA½ ships none of enig-term's files. It does provide config.json:
//  unless the operator put one in the root, it is generated from the board's
//  own configuration so the page knows where to connect.
//

//  ENiGMA½
const configModule = require('./config.js');
const { getUrlPath } = require('./web_util.js');

//  deps
const fs = require('graceful-fs');
const paths = require('path');
const { pipeline } = require('stream');
const mimeTypes = require('mime-types');
const _ = require('lodash');

//  Read through the module object: config.js replaces |get| when the config is
//  created, so a reference captured at load would go stale
const Config = () => configModule.get();
const Log = () => require('./logger.js').log;

const RoutePath = '/_enig/ws-term'; //  WellKnownLocations.Internal + '/ws-term'
const ConfigFileName = 'config.json';
const IndexFileName = 'index.html';
const ClientConfigVersion = 1;

//  A relative root is taken from the install directory, as the default is
const InstallDir = paths.join(__dirname, '..');

//  Explicit where it matters: application/wasm is what lets the browser
//  compile while the file is still downloading (instantiateStreaming)
const ContentTypes = {
    '.wasm': 'application/wasm',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
};

exports.RoutePath = RoutePath;
exports.startup = startup;
exports.handleRequest = handleRequest;
exports.getInstallRoot = getInstallRoot;
exports.resolveEndpoint = resolveEndpoint;
exports.generateClientConfig = generateClientConfig;
exports.contentTypeFor = contentTypeFor;

function startup(cb) {
    //  required here, not at load: web.js pulls in the server module stack
    const { getServer } = require('./listening_server.js');
    const webServerPackageName = require('./servers/content/web.js').moduleInfo
        .packageName;

    const webServer = getServer(webServerPackageName);
    if (!webServer || !webServer.instance.isEnabled()) {
        return cb(null); //  not serving web content at all
    }

    //  /_enig/ws-term, /_enig/ws-term/..., with or without a query
    const path = new RegExp(`^${_.escapeRegExp(RoutePath)}(?:[/?#].*)?$`);
    ['GET', 'HEAD'].forEach(method => {
        webServer.instance.addRoute({
            method,
            path,
            handler: (req, resp) => handleRequest(webServer.instance, req, resp),
        });
    });

    return cb(null);
}

function wsTermConfig(config) {
    const wsTerm = _.get(config, 'contentServers.web.wsTerm');
    return _.isPlainObject(wsTerm) ? wsTerm : {};
}

function configuredRoot(config) {
    const root = wsTermConfig(config).root;
    if (!_.isString(root) || !root) {
        return null;
    }
    return paths.resolve(InstallDir, root);
}

//
//  The real path of the install root, or null while enig-term is not
//  installed there -- the root is missing or has no index.html.
//
function getInstallRoot(cb) {
    const root = configuredRoot(Config());
    if (!root) {
        return cb(null);
    }

    //  The root itself may be a symlink (e.g. to a checkout's dist/); what
    //  is served is confined to wherever it points
    fs.realpath(root, (err, realRoot) => {
        if (err) {
            return cb(null);
        }

        fs.stat(paths.join(realRoot, IndexFileName), (err, stats) => {
            return cb(!err && stats.isFile() ? realRoot : null);
        });
    });
}

//
//  The file under |realRoot| that |relPath| (a decoded, '/' separated request
//  path relative to the route) names, or null. Nothing outside the root is
//  ever returned: dot segments -- '..', '.', and dot files such as .git --
//  are refused outright, and the result is checked again after symlinks are
//  resolved.
//
function resolveInRoot(realRoot, relPath, cb) {
    if (relPath.includes('\0')) {
        return cb(null);
    }

    const segments = relPath.split('/');
    if (segments.some(seg => !seg || seg.startsWith('.'))) {
        return cb(null);
    }

    const rootWithSep = realRoot.endsWith(paths.sep) ? realRoot : realRoot + paths.sep;
    const candidate = paths.resolve(realRoot, ...segments);
    if (!candidate.startsWith(rootWithSep)) {
        return cb(null); //  e.g. a backslash separated escape on Windows
    }

    fs.realpath(candidate, (err, real) => {
        if (err || !real.startsWith(rootWithSep)) {
            return cb(null);
        }

        fs.stat(real, (err, stats) => {
            return cb(!err && stats.isFile() ? { filePath: real, stats } : null);
        });
    });
}

function contentTypeFor(filePath) {
    const ext = paths.extname(filePath).toLowerCase();
    if (ContentTypes[ext]) {
        return ContentTypes[ext];
    }
    if (!ext) {
        return 'text/plain; charset=utf-8'; //  LICENSE, NOTICE
    }
    return mimeTypes.contentType(ext) || 'application/octet-stream';
}

//
//  The public wss:// URL the page should connect to:
//
//  1. wsTerm.endpoint, when set. Required behind a TLS proxy whose public
//     port differs from the one ENiGMA½ listens on.
//  2. wss://<contentServers.web.domain>:<loginServers.webSocket.wss.port>
//     when the secure WebSocket server is enabled.
//  3. null: enig-term then asks the caller for a host.
//
//  Plain ws:// is never derived: browsers connect over wss:// only.
//
function resolveEndpoint(config) {
    const configured = wsTermConfig(config).endpoint;
    if (_.isString(configured) && configured.trim()) {
        return configured.trim();
    }

    const wss = _.get(config, 'loginServers.webSocket.wss');
    const domain = _.get(config, 'contentServers.web.domain');
    if (_.isPlainObject(wss) && true === wss.enabled && _.isString(domain) && domain) {
        const port = parseInt(wss.port, 10);
        if (!isNaN(port)) {
            return 443 === port ? `wss://${domain}` : `wss://${domain}:${port}`;
        }
    }

    return null;
}

//  { version, endpoint, title, ...wsTerm.client }
//  With an endpoint the page is locked to it, so a crafted link
//  (?endpoint=wss://elsewhere&connect=1) cannot point this board's own page at
//  another host. wsTerm.client can still set lockEndpoint: false.
function generateClientConfig(config) {
    const client = wsTermConfig(config).client;
    const endpoint = resolveEndpoint(config);
    return Object.assign(
        {
            version: ClientConfigVersion,
            endpoint,
            lockEndpoint: null !== endpoint,
            title: _.get(config, 'general.boardName') || null,
        },
        _.isPlainObject(client) ? client : {}
    );
}

let warnedNoEndpoint = false;

function warnNoEndpointOnce(clientConfig) {
    if (null !== clientConfig.endpoint || warnedNoEndpoint) {
        return;
    }
    warnedNoEndpoint = true;
    Log().warn(
        'enig-term has no endpoint: set contentServers.web.wsTerm.endpoint, or enable loginServers.webSocket.wss. The page will ask callers for a host.'
    );
}

//  Revalidated on every load: enig-term's file names carry no content hash,
//  and its JS glue must match the .wasm exactly, so a cached half of an
//  upgrade would break the page. The ETag makes revalidation a 304.
const CacheControl = 'no-cache';

function etagFor(stats) {
    return `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
}

function isNotModified(req, etag, stats) {
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch) {
        //  weak comparison (RFC 9110 13.1.2): W/"x" and "x" match
        const bare = etag.replace(/^W\//, '');
        return ifNoneMatch
            .split(',')
            .map(tag => tag.trim())
            .some(tag => '*' === tag || tag.replace(/^W\//, '') === bare);
    }

    const ifModifiedSince = Date.parse(req.headers['if-modified-since'] || '');
    return (
        !isNaN(ifModifiedSince) &&
        Math.floor(stats.mtimeMs / 1000) * 1000 <= ifModifiedSince
    );
}

function serveFile(req, resp, { filePath, stats }) {
    const etag = etagFor(stats);
    const headers = {
        'Cache-Control': CacheControl,
        ETag: etag,
        'Last-Modified': stats.mtime.toUTCString(),
        'X-Content-Type-Options': 'nosniff',
    };

    if (isNotModified(req, etag, stats)) {
        resp.writeHead(304, headers);
        return resp.end();
    }

    headers['Content-Type'] = contentTypeFor(filePath);
    headers['Content-Length'] = stats.size;
    resp.writeHead(200, headers);

    if ('HEAD' === req.method) {
        return resp.end();
    }

    //  pipeline(), not pipe(): when the caller goes away mid-download the file
    //  must be closed too, or every aborted request of a large .wasm leaks a
    //  descriptor. A file that grew since the stat is cut at the length that
    //  was promised.
    if (0 === stats.size) {
        return resp.end();
    }
    const readStream = fs.createReadStream(filePath, { start: 0, end: stats.size - 1 });
    return pipeline(readStream, resp, () => {
        /* an error or early close has already torn both ends down */
    });
}

function serveGeneratedConfig(req, resp) {
    const clientConfig = generateClientConfig(Config());
    warnNoEndpointOnce(clientConfig);

    const body = Buffer.from(JSON.stringify(clientConfig, null, 4) + '\n', 'utf8');
    resp.writeHead(200, {
        'Content-Type': ContentTypes['.json'],
        'Content-Length': body.length,
        'Cache-Control': CacheControl,
        'X-Content-Type-Options': 'nosniff',
    });
    return resp.end('HEAD' === req.method ? undefined : body);
}

function handleRequest(webServer, req, resp) {
    let urlPath;
    try {
        urlPath = decodeURIComponent(getUrlPath(req.url));
    } catch (e) {
        return webServer.fileNotFound(resp); //  malformed escape
    }

    if (urlPath !== RoutePath && !urlPath.startsWith(`${RoutePath}/`)) {
        return webServer.fileNotFound(resp);
    }

    getInstallRoot(realRoot => {
        if (!realRoot) {
            return webServer.fileNotFound(resp); //  not installed
        }

        //  the page loads its assets relative to itself, so it needs the slash
        if (urlPath === RoutePath) {
            const queryAt = req.url.indexOf('?');
            const query = queryAt > -1 ? req.url.slice(queryAt) : '';
            resp.writeHead(301, { Location: `${RoutePath}/${query}` });
            return resp.end();
        }

        let relPath = urlPath.slice(RoutePath.length + 1);
        if (!relPath || relPath.endsWith('/')) {
            relPath += IndexFileName;
        }

        resolveInRoot(realRoot, relPath, found => {
            if (found) {
                //  includes an operator's own config.json, served as-is
                return serveFile(req, resp, found);
            }

            if (ConfigFileName === relPath) {
                return serveGeneratedConfig(req, resp);
            }

            return webServer.fileNotFound(resp);
        });
    });
}

//  for tests
exports._resetWarnings = () => {
    warnedNoEndpoint = false;
};
