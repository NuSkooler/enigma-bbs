const WebHandlerModule = require('../../../web_handler_module');
const { Errors } = require('../../../enig_error');
const EngiAssert = require('../../../enigma_assert');
const Config = require('../../../config').get;
const packageJson = require('../../../../package.json');
const StatLog = require('../../../stat_log');
const SysProps = require('../../../system_property');
const SysLogKeys = require('../../../system_log');
const { getBaseUrl, getWebDomain } = require('../../../web_util');
const Collection = require('../../activitypub/collection');

// deps
const { get: _get } = require('lodash');
const moment = require('moment');
const async = require('async');

function _buildProtocols(config) {
    const p = [];

    //  Telnet: core BBS protocol; enabled unless explicitly set to false.
    if (_get(config, 'loginServers.telnet.enabled', true)) p.push('telnet');

    if (_get(config, 'loginServers.ssh.enabled', false)) p.push('ssh');

    //  WebSocket (ws/wss share the same NodeInfo2 token).
    if (
        _get(config, 'loginServers.webSocket.ws.enabled', false) ||
        _get(config, 'loginServers.webSocket.wss.enabled', false)
    ) {
        p.push('ws');
    }

    if (_get(config, 'contentServers.gopher.enabled', false)) p.push('gopher');

    //  NNTP: either plain or TLS counts.
    if (
        _get(config, 'contentServers.nntp.nntp.enabled', false) ||
        _get(config, 'contentServers.nntp.nntps.enabled', false)
    ) {
        p.push('nntp');
    }

    if (_get(config, 'contentServers.web.handlers.activityPub.enabled', false)) {
        p.push('activitypub');
    }

    return p;
}

const NodeInfoSchemaBase = 'http://nodeinfo.diaspora.software/ns/schema';

exports.moduleInfo = {
    name: 'NodeInfo2',
    desc: 'A NodeInfo2 Handler implementing https://github.com/jaywink/nodeinfo2',
    author: 'NuSkooler',
    packageName: 'codes.l33t.enigma.web.handler.nodeinfo2',
};

exports.getModule = class NodeInfo2WebHandler extends WebHandlerModule {
    constructor() {
        super();
    }

    init(webServer, cb) {
        // we rely on the web server
        this.webServer = webServer;
        EngiAssert(webServer, 'NodeInfo2 Web Handler init without webServer');

        this.log = webServer.logger().child({ webHandler: 'NodeInfo2' });

        const domain = getWebDomain();
        if (!domain) {
            return cb(Errors.UnexpectedState('Web server does not have "domain" set'));
        }

        this.webServer.addRoute({
            method: 'GET',
            path: /^\/\.well-known\/x-nodeinfo2$/,
            handler: this._nodeInfo2Handler.bind(this),
        });

        this.webServer.addRoute({
            method: 'GET',
            path: /^\/\.well-known\/nodeinfo$/,
            handler: this._nodeInfoDiscoveryHandler.bind(this),
        });

        this.webServer.addRoute({
            method: 'GET',
            path: /^\/_enig\/nodeinfo\/2\.[01]$/,
            handler: this._nodeInfoStandardHandler.bind(this),
        });

        return cb(null);
    }

    _nodeInfoDiscoveryHandler(req, resp) {
        this.log.info('Serving NodeInfo discovery request');

        const base = getBaseUrl();
        const body = JSON.stringify({
            links: [
                {
                    rel: `${NodeInfoSchemaBase}/2.1`,
                    href: `${base}/_enig/nodeinfo/2.1`,
                },
                {
                    rel: `${NodeInfoSchemaBase}/2.0`,
                    href: `${base}/_enig/nodeinfo/2.0`,
                },
            ],
        });

        const headers = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.from(body).length,
        };

        resp.writeHead(200, headers);
        return resp.end(body);
    }

    _nodeInfoStandardHandler(req, resp) {
        //  Detect which schema version was requested from the URL path.
        const version = req.url.endsWith('2.1') ? '2.1' : '2.0';
        this.log.info({ version }, 'Serving standard NodeInfo request');

        this._getNodeInfo(nodeInfo2Data => {
            const config = Config();
            const apEnabled = _get(
                config,
                'contentServers.web.handlers.activityPub.enabled',
                false
            );

            const software = {
                name: 'enigma-bbs',
                version: packageJson.version,
            };
            if (version === '2.1') {
                software.repository = 'https://github.com/NuSkooler/enigma-bbs';
                software.homepage = 'https://enigma-bbs.github.io';
            }

            const doc = {
                version,
                software,
                //  NodeInfo 2.x protocols enum only includes ActivityPub from our set.
                protocols: apEnabled ? ['activitypub'] : [],
                services: { inbound: [], outbound: [] },
                openRegistrations: nodeInfo2Data.openRegistrations,
                usage: {
                    users: {
                        total: nodeInfo2Data.usage.users.total,
                        activeHalfyear: nodeInfo2Data.usage.activeHalfyear || 0,
                        activeMonth: nodeInfo2Data.usage.activeMonth || 0,
                    },
                    localPosts: nodeInfo2Data.usage.localPosts,
                },
                metadata: {
                    nodeName: config.general.boardName,
                },
            };

            const schemaUrl = `${NodeInfoSchemaBase}/${version}#`;
            const body = JSON.stringify(doc);
            const headers = {
                'Content-Type': `application/json; profile="${schemaUrl}"`,
                'Content-Length': Buffer.from(body).length,
            };

            resp.writeHead(200, headers);
            return resp.end(body);
        });
    }

    _nodeInfo2Handler(req, resp) {
        this.log.info('Serving NodeInfo2 request');

        this._getNodeInfo(nodeInfo => {
            const body = JSON.stringify(nodeInfo);
            const headers = {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.from(body).length,
            };

            resp.writeHead(200, headers);
            return resp.end(body);
        });
    }

    _getNodeInfo(cb) {
        //  https://github.com/jaywink/nodeinfo2/tree/master/schemas/1.0
        const config = Config();
        const nodeInfo = {
            version: '1.0',
            server: {
                baseUrl: getBaseUrl(),
                name: config.general.boardName,
                software: 'ENiGMA½ Bulletin Board Software',
                version: packageJson.version,
            },
            protocols: _buildProtocols(config),

            //  ENiGMA does not integrate with any external services (RSS, email, etc.)
            services: { inbound: [], outbound: [] },
            openRegistrations: !config.general.closedSystem,
            usage: {
                users: {
                    total: StatLog.getSystemStatNum(SysProps.TotalUserCount) || 1,
                    // others fetched dynamically below
                },
                localPosts: 0, // updated below
            },
        };

        const setActive = (since, name, next) => {
            const filter = {
                logName: SysLogKeys.UserLoginHistory,
                resultType: 'count',
                dateNewer: moment().subtract(moment.duration(since, 'days')),
            };
            StatLog.findSystemLogEntries(filter, (err, count) => {
                if (!err) {
                    nodeInfo.usage[name] = count;
                }
                return next(null);
            });
        };

        async.series(
            [
                callback => {
                    return setActive(180, 'activeHalfyear', callback);
                },
                callback => {
                    return setActive(30, 'activeMonth', callback);
                },
                callback => {
                    return setActive(7, 'activeWeek', callback);
                },
                callback => {
                    Collection.countLocalPosts((err, count) => {
                        if (!err) {
                            nodeInfo.usage.localPosts = count;
                        }
                        return callback(null); // non-fatal
                    });
                },
            ],
            () => {
                return cb(nodeInfo);
            }
        );
    }
};
