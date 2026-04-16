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

        return cb(null);
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
