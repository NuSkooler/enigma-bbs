/* jslint node: true */
'use strict';

//  ENiGMA½
const Config = require('../../config.js').get;
const TelnetClient = require('./telnet.js').TelnetClient;
const Log = require('../../logger.js').log;
const LoginServerModule = require('../../login_server_module.js');
const { Errors } = require('../../enig_error.js');

//  deps
const _ = require('lodash');
const WebSocketServer = require('ws').Server;
const http = require('http');
const https = require('https');
const fs = require('graceful-fs');
const { Duplex } = require('stream');
const forEachSeries = require('async/forEachSeries');

const ModuleInfo = (exports.moduleInfo = {
    name: 'WebSocket',
    desc: 'WebSocket Server',
    author: 'NuSkooler',
    packageName: 'codes.l33t.enigma.websocket.server',
});

class WebSocketClient extends TelnetClient {
    constructor(ws, req, serverType) {
        //  allow WebSocket to act like a Duplex (socket)
        const wsDuplex = new (class WebSocketDuplex extends Duplex {
            constructor(ws) {
                super();
                this.ws = ws;

                this.ws.on('close', err => this.emit('close', err));
                this.ws.on('error', err => this.emit('error', err));
                this.ws.on('message', data => this._data(data));
            }

            setClient(client, httpRequest) {
                this.client = client;

                //  Support X-Forwarded-For and X-Real-IP headers for proxied connections
                this.resolvedRemoteAddress =
                    (this.client.proxied &&
                        (httpRequest.headers['x-forwarded-for'] ||
                            httpRequest.headers['x-real-ip'])) ||
                    httpRequest.connection.remoteAddress;
            }

            get remoteAddress() {
                return this.resolvedRemoteAddress;
            }

            _write(data, encoding, cb) {
                cb =
                    cb ||
                    (() => {
                        /* eat it up */
                    }); //  handle data writes after close
                return this.ws.send(data, { binary: true }, cb);
            }

            _read() {
                //  dummy
            }

            _data(data) {
                this.push(data);
            }
        })(ws);

        super(wsDuplex);
        wsDuplex.setClient(this, req);

        //  fudge remoteAddress on socket, which is now TelnetSocket
        this.socket.remoteAddress = wsDuplex.remoteAddress;

        wsDuplex.on('close', () => {
            //  we'll remove client connection which will in turn end() via our SocketBridge above
            return this.emit('end');
        });

        this.serverType = serverType;

        //
        //  Monitor connection status with ping/pong
        //
        ws.on('pong', () => {
            Log.trace(`Pong from ${wsDuplex.remoteAddress}`);
            ws.isConnectionAlive = true;
        });

        Log.trace({ headers: req.headers }, 'WebSocket connection headers');

        //
        //  If the config allows it, look for 'x-forwarded-proto' as "https"
        //  to override |isSecure|
        //
        if (
            true === _.get(Config(), 'loginServers.webSocket.proxied') &&
            'https' === req.headers['x-forwarded-proto']
        ) {
            Log.debug(
                `Assuming secure connection due to X-Forwarded-Proto of "${req.headers['x-forwarded-proto']}"`
            );
            this.proxied = true;
        } else {
            this.proxied = false;
        }

        //  start handshake process
        this.banner();
    }

    get isSecure() {
        return 'secure' === this.serverType || true === this.proxied ? true : false;
    }
}

const WSS_SERVER_TYPES = ['insecure', 'secure'];

exports.getModule = class WebSocketLoginServer extends LoginServerModule {
    constructor() {
        super();
    }

    createServer(cb) {
        //
        //  We will actually create up to two servers:
        //  * insecure websocket (ws://)
        //  * secure (tls) websocket (wss://)
        //
        const config = _.get(Config(), 'loginServers.webSocket');
        if (!_.isObject(config)) {
            return cb(null);
        }

        const wsPort = _.get(config, 'ws.port');
        const wssPort = _.get(config, 'wss.port');

        if (true === _.get(config, 'ws.enabled') && _.isNumber(wsPort)) {
            const httpServer = http.createServer((req, resp) => {
                //  dummy handler
                resp.writeHead(200);
                return resp.end('ENiGMA½ BBS WebSocket Server!');
            });

            this.insecure = {
                httpServer: httpServer,
                wsServer: new WebSocketServer({ server: httpServer }),
            };
        }

        if (
            _.isObject(config, 'wss') &&
            true === _.get(config, 'wss.enabled') &&
            _.isNumber(wssPort)
        ) {
            const httpServer = https.createServer({
                key: fs.readFileSync(config.wss.keyPem),
                cert: fs.readFileSync(config.wss.certPem),
            });

            this.secure = {
                httpServer: httpServer,
                wsServer: new WebSocketServer({ server: httpServer }),
            };
        }

        return cb(null);
    }

    listen(cb) {
        //
        //  Send pings every 30s
        //
        setInterval(() => {
            WSS_SERVER_TYPES.forEach(serverType => {
                if (this[serverType]) {
                    this[serverType].wsServer.clients.forEach(ws => {
                        if (false === ws.isConnectionAlive) {
                            Log.debug(
                                'WebSocket connection seems inactive. Terminating.'
                            );
                            return ws.terminate();
                        }

                        ws.isConnectionAlive = false; //  pong will reset this

                        Log.trace('Ping to remote WebSocket client');
                        try {
                            ws.ping('', false); //  false=don't mask
                        } catch (e) {
                            //  don't barf on closing state
                            /* nothing */
                        }
                    });
                }
            });
        }, 30000);

        forEachSeries(
            WSS_SERVER_TYPES,
            (serverType, nextServerType) => {
                const server = this[serverType];
                if (!server) {
                    return nextServerType(null);
                }

                const serverName = `${ModuleInfo.name} (${serverType})`;
                const conf = _.get(Config(), [
                    'loginServers',
                    'webSocket',
                    'secure' === serverType ? 'wss' : 'ws',
                ]);
                const confPort = conf.port;
                const port = parseInt(confPort);

                if (isNaN(port)) {
                    Log.error(
                        { server: serverName, port: confPort },
                        'Cannot load server (invalid port)'
                    );
                    return nextServerType(Errors.Invalid(`Invalid port: ${confPort}`));
                }

                server.httpServer.listen(port, conf.address, err => {
                    if (err) {
                        return nextServerType(err);
                    }

                    server.wsServer.on('connection', (ws, req) => {
                        const webSocketClient = new WebSocketClient(ws, req, serverType);
                        this.handleNewClient(
                            webSocketClient,
                            webSocketClient.socket,
                            ModuleInfo
                        );
                    });

                    Log.info(
                        { server: serverName, port: port },
                        'Listening for connections'
                    );
                    return nextServerType(null);
                });
            },
            err => {
                cb(err);
            }
        );
    }
};
