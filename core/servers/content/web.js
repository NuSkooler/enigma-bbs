/* jslint node: true */
'use strict';

//	ENiGMA½
const Log			= require('../../logger.js').log;
const ServerModule	= require('../../server_module.js').ServerModule;
const Config		= require('../../config.js').config;

//	deps
const http			= require('http');
const https			= require('https');
const _				= require('lodash');
const fs			= require('fs');

const ModuleInfo = exports.moduleInfo = {
	name		: 'Web',
	desc		: 'Web Server',
	author		: 'NuSkooler',
	packageName	: 'codes.l33t.enigma.web.server',
};

class Route {
	constructor(route) {
		Object.assign(this, route);
		
		if(this.method) {
			this.method = this.method.toUpperCase();
		}

		try {
			this.pathRegExp = new RegExp(this.path);
		} catch(e) {
			Log.debug( { route : route }, 'Invalid regular expression for route path' );
		}
	}

	isValid() {
		return (
			this.pathRegExp instanceof RegExp && 
			( -1 !== [ 'GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'CONNECT', 'OPTIONS', 'TRACE',  ].indexOf(this.method) ) || 
			!_.isFunction(this.handler)
		);
	}

	matchesRequest(req) { return req.method === this.method && this.pathRegExp.test(req.url); }

	getRouteKey() { return `${this.method}:${this.path}`; }
}

exports.getModule = class WebServerModule extends ServerModule {
	constructor() {
		super();

		this.enableHttp		= Config.contentServers.web.http.enabled || true;
		this.enableHttps	= Config.contentServers.web.https.enabled || false;

		this.routes = {};
	}

	createServer() {
		if(this.enableHttp) {
			this.httpServer = http.createServer( (req, resp) => this.routeRequest(req, resp) );
		}

		if(this.enableHttps) {
			const options = {
				cert	: fs.readFileSync(Config.contentServers.web.https.certPem),
				key		: fs.readFileSync(Config.contentServers.web.https.keyPem),
			};

			//	additional options
			Object.assign(options, Config.contentServers.web.https.options || {} );

			this.httpsServer = https.createServer(options, this.routeRequest);			
		}
	}

	listen() {
		let ok = true;

		[ 'http', 'https' ].forEach(service => {
			const name = `${service}Server`;
			if(this[name]) {
				const port = parseInt(Config.contentServers.web[service].port);
				if(isNaN(port)) {
					ok = false;
					return Log.warn( { port : Config.contentServers.web[service].port, server : ModuleInfo.name }, `Invalid port (${service})` );
				}
				return this[name].listen(port);
			} 
		});

		return ok;
	}

	addRoute(route) {
		route = new Route(route);

		if(!route.isValid()) {
			Log( { route : route }, 'Cannot add route: missing or invalid required members' );
			return false;
		}

		const routeKey = route.getRouteKey();
		if(routeKey in this.routes) {
			Log( { route : route }, 'Cannot add route: duplicate method/path combination exists' );
			return false;
		}

		this.routes[routeKey] = route;
		return true;
	}

	routeRequest(req, resp) {
		const route = _.find(this.routes, r => r.matchesRequest(req) );		
		return route ? route.handler(req, resp) : this.accessDenied(resp);
	}

	accessDenied(resp) {
		resp.writeHead(401, { 'Content-Type' : 'text/html' } );
		return resp.end('<html><body>Access denied</body></html>');
	}
}