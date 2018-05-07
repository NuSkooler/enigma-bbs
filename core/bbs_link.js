/* jslint node: true */
'use strict';

const MenuModule	= require('./menu_module.js').MenuModule;
const resetScreen	= require('./ansi_term.js').resetScreen;

const async			= require('async');
const _				= require('lodash');
const http			= require('http');
const net			= require('net');
const crypto		= require('crypto');

const packageJson 	= require('../package.json');

/*
	Expected configuration block:

	{
		module: bbs_link
		...
		config: {
			sysCode: XXXXX
			authCode: XXXXX
			schemeCode: XXXX
			door: lord

			//	default hoss: games.bbslink.net
			host: games.bbslink.net

			//	defualt port: 23
			port: 23
		}
	}
*/

//	:TODO: BUG: When a client disconnects, it's not handled very well -- the log is spammed with tons of errors
//	:TODO: ENH: Support nodeMax and tooManyArt

exports.moduleInfo = {
	name	: 'BBSLink',
	desc	: 'BBSLink Access Module',
	author	: 'NuSkooler',
};

exports.getModule = class BBSLinkModule extends MenuModule {
	constructor(options) {
		super(options);

		this.config			= options.menuConfig.config;
		this.config.host	= this.config.host || 'games.bbslink.net';
		this.config.port	= this.config.port || 23;
	}

	initSequence() {
		let token;
		let randomKey;
		let clientTerminated;
		const self = this;

		async.series(
			[
				function validateConfig(callback) {
					if(_.isString(self.config.sysCode) &&
						_.isString(self.config.authCode) &&
						_.isString(self.config.schemeCode) &&
						_.isString(self.config.door))
					{
						callback(null);
					} else {
						callback(new Error('Configuration is missing option(s)'));
					}
				},
				function acquireToken(callback) {
					//
					//	Acquire an authentication token
					//
					crypto.randomBytes(16, function rand(ex, buf) {
						if(ex) {
							callback(ex);
						} else {
							randomKey = buf.toString('base64').substr(0, 6);
							self.simpleHttpRequest('/token.php?key=' + randomKey, null, function resp(err, body) {
								if(err) {
									callback(err);
								} else {
									token = body.trim();
									self.client.log.trace( { token : token }, 'BBSLink token');
									callback(null);
								}
							});
						}
					});
				},
				function authenticateToken(callback) {
					//
					//	Authenticate the token we acquired previously
					//
					var headers = {
						'X-User'	: self.client.user.userId.toString(),
						'X-System'	: self.config.sysCode,
						'X-Auth'	: crypto.createHash('md5').update(self.config.authCode + token).digest('hex'),
						'X-Code'	: crypto.createHash('md5').update(self.config.schemeCode + token).digest('hex'),
						'X-Rows'	: self.client.term.termHeight.toString(),
						'X-Key'		: randomKey,
						'X-Door'	: self.config.door,
						'X-Token'	: token,
						'X-Type'	: 'enigma-bbs',
						'X-Version'	: packageJson.version,
					};

					self.simpleHttpRequest('/auth.php?key=' + randomKey, headers, function resp(err, body) {
						var status = body.trim();

						if('complete' === status) {
							callback(null);
						} else {
							callback(new Error('Bad authentication status: ' + status));
						}
					});
				},
				function createTelnetBridge(callback) {
					//
					//	Authentication with BBSLink successful. Now, we need to create a telnet
					//	bridge from us to them
					//
					var connectOpts = {
						port	: self.config.port,
						host	: self.config.host,
					};

					var clientTerminated;

					self.client.term.write(resetScreen());
					self.client.term.write('  Connecting to BBSLink.net, please wait...\n');

					var bridgeConnection = net.createConnection(connectOpts, function connected() {
						self.client.log.info(connectOpts, 'BBSLink bridge connection established');

						self.client.term.output.pipe(bridgeConnection);

						self.client.once('end', function clientEnd() {
							self.client.log.info('Connection ended. Terminating BBSLink connection');
							clientTerminated = true;
							bridgeConnection.end();
						});
					});

					var restorePipe = function() {
						self.client.term.output.unpipe(bridgeConnection);
						self.client.term.output.resume();
					};

					bridgeConnection.on('data', function incomingData(data) {
						//	pass along
						//	:TODO: just pipe this as well
						self.client.term.rawWrite(data);
					});

					bridgeConnection.on('end', function connectionEnd() {
						restorePipe();
						callback(clientTerminated ? new Error('Client connection terminated') : null);
					});

					bridgeConnection.on('error', function error(err) {
						self.client.log.info('BBSLink bridge connection error: ' + err.message);
						restorePipe();
						callback(err);
					});
				}
			],
			function complete(err) {
				if(err) {
					self.client.log.warn( { error : err.toString() }, 'BBSLink connection error');
				}

				if(!clientTerminated) {
					self.prevMenu();
				}
			}
		);
	}

	simpleHttpRequest(path, headers, cb) {
		const getOpts = {
			host	: this.config.host,
			path	: path,
			headers	: headers,
		};

		const req = http.get(getOpts, function response(resp) {
			let data = '';

			resp.on('data', function chunk(c) {
				data += c;
			});

			resp.on('end', function respEnd() {
				cb(null, data);
				req.end();
			});
		});

		req.on('error', function reqErr(err) {
			cb(err);
		});
	}
};
