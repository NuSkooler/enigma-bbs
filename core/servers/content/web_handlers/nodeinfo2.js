const WebHandlerModule = require('../../../web_handler_module');
const { Errors } = require('../../../enig_error');
const EngiAssert = require('../../../enigma_assert');
const Config = require('../../../config').get;
const packageJson = require('../../../../package.json');
const StatLog = require('../../../stat_log');
const SysProps = require('../../../system_property');
const SysLogKeys = require('../../../system_log');

// deps
const moment = require('moment');
const async = require('async');

exports.moduleInfo = {
    name: 'NodeInfo2',
    desc: 'A NodeInfo2 Handler implementing https://github.com/jaywink/nodeinfo2',
    author: 'NuSkooler',
    packageName: 'codes.l33t.enigma.web.handler.nodeinfo2',
};

exports.getModule = class NodeInfo2WebHadnler extends WebHandlerModule {
    constructor() {
        super();
    }

    init(webServer, cb) {
        // we rely on the web server
        this.webServer = webServer;
        EngiAssert(webServer, 'NodeInfo2 Web Handler init without webServer');

        this.log = webServer.logger().child({ webHandler: 'NodeInfo2' });

        const domain = this.webServer.getDomain();
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
                'Content-Length': Buffer(body).length,
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
                baseUrl: this.webServer.baseUrl(),
                name: config.general.boardName,
                software: 'ENiGMA½ Bulletin Board Software',
                version: packageJson.version,
            },
            //  :TODO: Only list what's enabled
            protocols: ['telnet', 'ssh', 'gopher', 'nntp', 'ws', 'activitypub'],

            //  :TODO: what should we really be doing here???
            // services: {
            //     inbound: [],
            //     outbound: [],
            // },
            openRegistrations: !config.general.closedSystem,
            usage: {
                users: {
                    total: StatLog.getSystemStatNum(SysProps.TotalUserCount) || 1,
                    // others fetched dynamically below
                },

                //  :TODO: pop with local message
                //   select count() from message_meta where meta_name='local_from_user_id';
                localPosts: 0,
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
            ],
            () => {
                return cb(nodeInfo);
            }
        );
    }
};
