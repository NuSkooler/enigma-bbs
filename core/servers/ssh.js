/* jslint node: true */
'use strict';

//	ENiGMA½
var conf			= require('../config.js');
var baseClient		= require('../client.js');
var Log				= require('../logger.js').log;
var ServerModule	= require('../server_module.js').ServerModule;
var userLogin		= require('../user_login.js').userLogin;

var ssh2			= require('ssh2');
var fs				= require('fs');
var util			= require('util');
var _				= require('lodash');

exports.moduleInfo = {
	name	: 'SSH',
	desc	: 'SSH Server',
	author	: 'NuSkooler'
};

exports.getModule		= SSHServerModule;

function SSHClient(clientConn) {
	baseClient.Client.apply(this, arguments);

	//
	//	WARNING: Until we have emit 'ready', self.input, and self.output and
	//	not yet defined!
	//

	var self = this;

	clientConn.on('authentication', function authentication(ctx) {
		self.log.trace( { context : ctx }, 'SSH authentication');

		//	:TODO: check Config max failed logon attempts/etc.

		switch(ctx.method) {
			case 'password' :
				//	:TODO: Proper userLogin() here
				self.user.authenticate(ctx.username, ctx.password, self, function authResult(err) {
					if(err) {
						ctx.reject();
					} else {
						ctx.accept();
					}
				});
				break;

			case 'publickey' :
				//	:TODO: 
				ctx.reject();
				break;

			case 'keyboard-interactive' :
				if(!_.isString(ctx.username)) {
					//	:TODO: Let client know a username is required!
					ctx.reject()
				}

				var PASS_PROMPT = { prompt : 'Password: ', echo : false };
				
				ctx.prompt(PASS_PROMPT, function promptResponse(responses) {
					if(0 === responses.length) {
						return ctx.reject( ['keyboard-interactive'] );
					}

					userLogin(self, ctx.username, responses[0], function authResult(err) {
						if(err) {
							if(err.existingConn) {
								//	:TODO: Already logged in - how to let the SSH client know?
								//self.term.write('User already logged in');
								ctx.reject();
							} else {
								PASS_PROMPT.prompt = 'Invalid username or password\nPassword: ';
								ctx.prompt(PASS_PROMPT, promptResponse);
							}
						} else {
							ctx.accept();
						}
					});					
				});
				break;

			default :
				self.log.info( { method : ctx.method }, 'Unsupported SSH authentication method. Rejecting connection.');
				ctx.reject();
		}
	});

	clientConn.on('ready', function clientReady() {
		self.log.info('SSH authentication success');

		clientConn.on('session', function sess(accept, reject) {
			self.input = accept();
			self.output = self.input;
		});
	});

	clientConn.on('end', function clientEnd() {
		self.emit('end');
	});
}

util.inherits(SSHClient, baseClient.Client);

function SSHServerModule() {
	ServerModule.call(this);
}

util.inherits(SSHServerModule, ServerModule);

SSHServerModule.prototype.createServer = function() {
	SSHServerModule.super_.prototype.createServer.call(this);

	//	:TODO: setup all options here. What should the banner, etc. really be????
	var serverConf = {
		privateKey	: fs.readFileSync(conf.config.servers.ssh.rsaPrivateKey),
		banner		: 'ENiGMA½ BBS SSH Server',
		debug		: function debugSsh(dbgLine) { 
			if(true === conf.config.servers.ssh.debugConnections) {
				self.log.trace('SSH: ' + dbgLine);
			}
		}
	};

	var server = ssh2.Server(serverConf);
	server.on('connection', function onConnection(conn, info) {
		Log.info(info, 'New SSH connection');

		var client = new SSHClient(conn);
		this.emit('client', client);
	});

	return server;
};