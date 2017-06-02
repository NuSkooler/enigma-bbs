/* jslint node: true */
'use strict';

//	ENiGMA½
const Config			= require('../../config.js').config;
const TelnetClient		= require('./telnet.js').TelnetClient;
const Log				= require('../../logger.js').log;
const LoginServerModule	= require('../../login_server_module.js');

//	deps
const _					= require('lodash');
const WebSocketServer	= require('ws').Server;
const http				= require('http');
const https				= require('https');
const fs				= require('graceful-fs');
const EventEmitter		= require('events');

const ModuleInfo = exports.moduleInfo = {
	name		: 'WebSocket',
	desc		: 'WebSocket Server',
	author		: 'NuSkooler',
	packageName	: 'codes.l33t.enigma.websocket.server',
};

function WebSocketClient(ws, req, serverType) {

	Object.defineProperty(this, 'isSecure', {
		get : () => ('secure' === serverType || true === this.proxied) ? true : false,
	});

	const self = this;

	//
	//	This bridge makes accessible various calls that client sub classes
	//	want to access on I/O socket
	//
	this.socketBridge = new class SocketBridge extends EventEmitter {
		constructor(ws) {
			super();
			this.ws = ws;
		}

		end() {
			return ws.terminate();
		}

		write(data, cb) {
			return this.ws.send(data, { binary : true }, cb);
		}

		get remoteAddress() {
			//	Support X-Forwarded-For and X-Real-IP headers for proxied connections
			return (self.proxied && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) || req.connection.remoteAddress;
		}
	}(ws);

	ws.on('message', data => {
		this.socketBridge.emit('data', data);
	});

	ws.on('close', () => {
		this.end();
	});

	//
	//	Montior connection status with ping/pong
	//
	ws.on('pong', () => { 
		Log.trace(`Pong from ${this.socketBridge.remoteAddress}`);
		ws.isConnectionAlive = true;
	});

	TelnetClient.call(this, this.socketBridge, this.socketBridge);

	Log.trace( { headers : req.headers }, 'WebSocket connection headers' );

	//
	//	If the config allows it, look for 'x-forwarded-proto' as "https"
	//	to override |isSecure|
	//
	if(true === _.get(Config, 'loginServers.webSocket.proxied') &&
		'https' === req.headers['x-forwarded-proto'])
	{
		Log.debug(`Assuming secure connection due to X-Forwarded-Proto of "${req.headers['x-forwarded-proto']}"`);
		this.proxied = true;
	} else {
		this.proxied = false;
	}

	//	start handshake process
	this.banner();
}

require('util').inherits(WebSocketClient, TelnetClient);

const WSS_SERVER_TYPES = [ 'insecure', 'secure' ];

exports.getModule = class WebSocketLoginServer extends LoginServerModule {
	constructor() {
		super();
	}

	createServer() {
		//
		//	We will actually create up to two servers:
		//	* insecure websocket (ws://)
		//	* secure (tls) websocket (wss://)
		//
		const config = _.get(Config, 'loginServers.webSocket') || { enabled : false };
		if(!config || true !== config.enabled || !(config.port || config.securePort)) {
			return;
		}

		if(config.port) {
			const httpServer = http.createServer( (req, resp) => {
				//	dummy handler
				resp.writeHead(200);
				return resp.end('ENiGMA½ BBS WebSocket Server!');
			});

			this.insecure = {
				httpServer	: httpServer,
				wsServer	: new WebSocketServer( { server : httpServer } ),
			};
		}

		if(config.securePort) {
			const httpServer = https.createServer({
				key		: fs.readFileSync(Config.loginServers.webSocket.keyPem),
				cert	: fs.readFileSync(Config.loginServers.webSocket.certPem),
			});

			this.secure = {
				httpServer	: httpServer,
				wsServer	: new WebSocketServer( { server : httpServer } ),
			};
		}
	}

	listen() {
		WSS_SERVER_TYPES.forEach(serverType => {
			const server = this[serverType];
			if(!server) {
				return;
			}

			const serverName 	= `${ModuleInfo.name} (${serverType})`;
			const port			= parseInt(_.get(Config, [ 'loginServers', 'webSocket', 'secure' === serverType ? 'securePort' : 'port' ] ));

			if(isNaN(port)) {
				Log.error( { server : serverName, port : port }, 'Cannot load server (invalid port)' );
				return;
			}

			server.httpServer.listen(port);

			server.wsServer.on('connection', (ws, req) => {
				const webSocketClient = new WebSocketClient(ws, req, serverType);
				this.handleNewClient(webSocketClient, webSocketClient.socketBridge, ModuleInfo);
			});

			Log.info( { server : serverName, port : port }, 'Listening for connections' );
		});

		//
		//	Send pings every 30s
		//
		setInterval( () => {
			WSS_SERVER_TYPES.forEach(serverType => {
				if(this[serverType]) {
					this[serverType].wsServer.clients.forEach(ws => {
						if(false === ws.isConnectionAlive) {
							Log.debug('WebSocket connection seems inactive. Terminating.');
							return ws.terminate();
						}

						ws.isConnectionAlive = false;	//	pong will reset this
						
						Log.trace('Ping to remote WebSocket client');
						return ws.ping('', false, true);
					});
				}
			});
		}, 30000);	

		return true;
	}

	webSocketConnection(conn) {
		const webSocketClient = new WebSocketClient(conn);
		this.handleNewClient(webSocketClient, webSocketClient.socketShim, ModuleInfo);
	}
};
