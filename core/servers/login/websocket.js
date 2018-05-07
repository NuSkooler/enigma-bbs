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
const Writable			= require('stream');

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
	this.socketBridge = new class SocketBridge extends Writable {
		constructor(ws) {
			super();
			this.ws = ws;
		}

		end() {
			return ws.close();
		}

		write(data, cb) {
			cb = cb || ( () => { /* eat it up */} );	//	handle data writes after close

			return this.ws.send(data, { binary : true }, cb);
		}

		//	we need to fake some streaming work
		unpipe() {
			Log.trace('WebSocket SocketBridge unpipe()');
		}

		resume() {
			Log.trace('WebSocket SocketBridge resume()');
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
		//	we'll remove client connection which will in turn end() via our SocketBridge above
		return this.emit('end');
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
		const config = _.get(Config, 'loginServers.webSocket');
		if(!_.isObject(config)) {
			return;
		}

		const wsPort 	= _.get(config, 'ws.port');
		const wssPort	= _.get(config, 'wss.port');

		if(true === _.get(config, 'ws.enabled') && _.isNumber(wsPort)) {
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

		if(_.isObject(config, 'wss') && true === _.get(config, 'wss.enabled') && _.isNumber(wssPort)) {
			const httpServer = https.createServer({
				key		: fs.readFileSync(config.wss.keyPem),
				cert	: fs.readFileSync(config.wss.certPem),
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
			const port			= parseInt(_.get(Config, [ 'loginServers', 'webSocket', 'secure' === serverType ? 'wss' : 'ws', 'port' ] ));

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
						return ws.ping('', false);	//	false=don't mask
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
