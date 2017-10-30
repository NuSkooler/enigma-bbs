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
const fs			= require('graceful-fs');
const paths			= require('path');
const mimeTypes		= require('mime-types');

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

	matchesRequest(req) {
		return req.method === this.method && this.pathRegExp.test(req.url);
	}

	getRouteKey() { return `${this.method}:${this.path}`; }
}

exports.getModule = class WebServerModule extends ServerModule {
	constructor() {
		super();

		this.enableHttp		= Config.contentServers.web.http.enabled || false;
		this.enableHttps	= Config.contentServers.web.https.enabled || false;

		this.routes = {};

		if(this.isEnabled() && Config.contentServers.web.staticRoot) {
			this.addRoute({
				method		: 'GET',
				path		: '/static/.*$',
				handler		: this.routeStaticFile.bind(this),
			});
		}
	}

	buildUrl(pathAndQuery) {
		//
		//	Create a URL such as
		//	https://l33t.codes:44512/ + |pathAndQuery|
		//
		//	Prefer HTTPS over HTTP. Be explicit about the port
		//	only if non-standard. Allow users to override full prefix in config.
		//
		if(_.isString(Config.contentServers.web.overrideUrlPrefix)) {
			return `${Config.contentServers.web.overrideUrlPrefix}${pathAndQuery}`;
		}

		let schema;
		let port;
		if(Config.contentServers.web.https.enabled) {
			schema	= 'https://';
			port	=  (443 === Config.contentServers.web.https.port) ?
				'' :
				`:${Config.contentServers.web.https.port}`;
		} else {
			schema	= 'http://';
			port	= (80 === Config.contentServers.web.http.port) ?
				'' :
				`:${Config.contentServers.web.http.port}`;
		}
		
		return `${schema}${Config.contentServers.web.domain}${port}${pathAndQuery}`;
	}

	isEnabled() {
		return this.enableHttp || this.enableHttps;
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

			this.httpsServer = https.createServer(options, (req, resp) => this.routeRequest(req, resp) );			
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
			Log.warn( { route : route }, 'Cannot add route: missing or invalid required members' );
			return false;
		}

		const routeKey = route.getRouteKey();
		if(routeKey in this.routes) {
			Log.warn( { route : route, routeKey : routeKey }, 'Cannot add route: duplicate method/path combination exists' );
			return false;
		}

		this.routes[routeKey] = route;
		return true;
	}

	routeRequest(req, resp) {
		const route = _.find(this.routes, r => r.matchesRequest(req) );

		if(!route && '/' === req.url) {
			return this.routeIndex(req, resp);
		}

		return route ? route.handler(req, resp) : this.accessDenied(resp);
	}

	respondWithError(resp, code, bodyText, title) {
		const customErrorPage = paths.join(Config.contentServers.web.staticRoot, `${code}.html`);

		fs.readFile(customErrorPage, 'utf8', (err, data) => {
			resp.writeHead(code, { 'Content-Type' : 'text/html' } );

			if(err) {
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
					</html>`
				);
			}

			return resp.end(data);
		});
	}

	accessDenied(resp) {
		return this.respondWithError(resp, 401, 'Access denied.', 'Access Denied');
	}

	fileNotFound(resp) {
		return this.respondWithError(resp, 404, 'File not found.', 'File Not Found');
	}

	routeIndex(req, resp) {
		const filePath = paths.join(Config.contentServers.web.staticRoot, 'index.html');

		return this.returnStaticPage(filePath, resp);
	}

	routeStaticFile(req, resp) {
		const fileName = req.url.substr(req.url.indexOf('/', 1));
		const filePath = paths.join(Config.contentServers.web.staticRoot, fileName);

		return this.returnStaticPage(filePath, resp);
	}

	returnStaticPage(filePath, resp) {
		const self = this;

		fs.stat(filePath, (err, stats) => {
			if(err) {
				return self.fileNotFound(resp);
			}

			const headers = {
				'Content-Type'		: mimeTypes.contentType(filePath) || mimeTypes.contentType('.bin'),
				'Content-Length'	: stats.size,
			};

			const readStream = fs.createReadStream(filePath);
			resp.writeHead(200, headers);
			return readStream.pipe(resp);
		});
	}

	routeTemplateFilePage(templatePath, preprocessCallback, resp) {
		const self = this;

		fs.readFile(templatePath, 'utf8', (err, templateData) => {
			if(err) {
				return self.fileNotFound(resp);
			}

			preprocessCallback(templateData, (err, finalPage, contentType) => {
				if(err || !finalPage) {
					return self.respondWithError(resp, 500, 'Internal Server Error.', 'Internal Server Error');
				}

				const headers = {
					'Content-Type'		: contentType || mimeTypes.contentType('.html'),
					'Content-Length'	: finalPage.length,
				};

				resp.writeHead(200, headers);
				return resp.end(finalPage);
			});
		});		
	}
};
