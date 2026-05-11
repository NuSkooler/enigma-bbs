'use strict';

const { jsonResponse, problemDetail, applyCorsHeaders, API_BASE } = require('../util');
const { resolveAuthenticatedUser } = require('../auth');

const StatLog = require('../../stat_log');
const SysProps = require('../../system_property');
const SysLogKeys = require('../../system_log');
const { getActiveConnectionList, UserVisibleConnections } = require('../../client_connections');
const Config = require('../../config').get;
const packageJson = require('../../../package.json');

const moment = require('moment');
const _ = require('lodash');

const ROUTE_BASE = `${API_BASE}/system`;

exports.register = function register(webServer, log) {
    webServer.addRoute({
        method: 'GET',
        path: new RegExp(`^${ROUTE_BASE}/info$`),
        handler: (req, resp) => _infoHandler(req, resp),
    });

    webServer.addRoute({
        method: 'GET',
        path: new RegExp(`^${ROUTE_BASE}/nodes$`),
        handler: (req, resp) => _nodesHandler(req, resp),
    });

    webServer.addRoute({
        method: 'GET',
        path: new RegExp(`^${ROUTE_BASE}/last-callers$`),
        handler: (req, resp) => _lastCallersHandler(req, resp, log),
    });

    webServer.addRoute({
        method: 'GET',
        path: new RegExp(`^${ROUTE_BASE}/stats$`),
        handler: (req, resp) => _statsHandler(req, resp),
    });
};

function _isPublicEndpoint(endpoint) {
    const config = Config();
    const pub = config.contentServers?.web?.restApi?.system?.public || {};
    //  defaults: info=public, last-callers=public, stats=public, nodes=auth required
    const defaults = { info: true, 'last-callers': true, stats: true, nodes: false };
    return endpoint in pub ? Boolean(pub[endpoint]) : (defaults[endpoint] ?? false);
}

function _requirePublicOrAuth(req, resp, endpoint, cb) {
    if (_isPublicEndpoint(endpoint)) {
        resolveAuthenticatedUser(req, (err, user) => cb(user));
    } else {
        resolveAuthenticatedUser(req, (err, user) => {
            if (!user) {
                return problemDetail(resp, 401, 'Authentication Required');
            }
            return cb(user);
        });
    }
}

function _infoHandler(req, resp) {
    applyCorsHeaders(req, resp);

    _requirePublicOrAuth(req, resp, 'info', () => {
        const config = Config();
        return jsonResponse(resp, 200, {
            boardName: config.general?.boardName || '',
            version: packageJson.version,
            nodeCount: getActiveConnectionList(UserVisibleConnections).length,
            closedSystem: Boolean(config.general?.closedSystem),
        });
    });
}

function _nodesHandler(req, resp) {
    applyCorsHeaders(req, resp);

    _requirePublicOrAuth(req, resp, 'nodes', authedUser => {
        const nodes = getActiveConnectionList(UserVisibleConnections).map(n => {
            const entry = {
                node: n.node,
                authenticated: n.authenticated,
                action: n.action,
                isSecure: n.isSecure,
            };

            if (n.authenticated) {
                entry.username = n.userName;
                entry.location = n.location !== 'N/A' ? n.location : undefined;
                entry.affils = n.affils !== 'N/A' ? n.affils : undefined;
                entry.timeOnMinutes = n.timeOn
                    ? Math.floor(n.timeOn.asMinutes())
                    : 0;
            }

            return entry;
        });

        return jsonResponse(resp, 200, { data: nodes, meta: { count: nodes.length } });
    });
}

function _lastCallersHandler(req, resp, log) {
    applyCorsHeaders(req, resp);

    _requirePublicOrAuth(req, resp, 'last-callers', () => {
        const MAX = 50;

        StatLog.getSystemLogEntries(
            SysLogKeys.UserLoginHistory,
            StatLog.Order.TimestampDesc,
            MAX,
            (err, entries) => {
                if (err) {
                    log.error({ err }, 'Error fetching last callers');
                    return problemDetail(resp, 500, 'Internal Server Error');
                }

                const callers = (entries || [])
                    .map(item => {
                        try {
                            const val = JSON.parse(item.log_value);
                            return {
                                userId: _.isObject(val) ? val.userId : val,
                                timestamp: moment(item.timestamp).toISOString(),
                            };
                        } catch {
                            return null;
                        }
                    })
                    .filter(Boolean);

                return jsonResponse(resp, 200, {
                    data: callers,
                    meta: { count: callers.length },
                });
            }
        );
    });
}

function _statsHandler(req, resp) {
    applyCorsHeaders(req, resp);

    _requirePublicOrAuth(req, resp, 'stats', () => {
        return jsonResponse(resp, 200, {
            totalUsers: StatLog.getSystemStatNum(SysProps.TotalUserCount) || 0,
        });
    });
}
