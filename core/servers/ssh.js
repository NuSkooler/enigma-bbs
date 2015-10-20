/* jslint node: true */
'use strict';

//	ENiGMA½
var conf			= require('../config.js');
var baseClient		= require('../client.js');
var Log				= require('../logger.js').log;
var ServerModule	= require('../server_module.js').ServerModule;
var userLogin		= require('../user_login.js').userLogin;
var enigVersion 	= require('../../package.json').version;

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

/*
Hello,

If you follow the first server example in the `ssh2` readme and substitute the `session.once('exec', ...)` with `session.once('shell', ...)` 
you should be fine. Just about all ssh clients default to an interactive shell session so that is what you will want to look for. As the 
documentation notes, the `shell` event handler is just passed `accept, reject` with `accept()` returning a duplex stream representing 
stdin/stdout. You can write to stderr by using the `stderr` property of the duplex stream object.

You will probably also want to handle the `pty` event on the session, since most clients (by default) will request a pseudo-TTY before 
requesting an interactive shell. I believe this event may be especially useful in your case because the ssh client can send certain terminal 
modes which can have relevance with your telnet usage. The event info also contains window dimensions which may help in determining layout 
of your display (there is also a `window-change` event that contains these same dimensions whenever the client's screen/window dimensions 
change).

If you are still having problems after making these changes, post your code somewhere and I will see if there is anything out of place. 
Additionally, you can set `debug: console.log` in the server config object to show debug output which may be useful to see what is or isn't 
being sent/received ssh protocol-wise.
*/


function SSHClient(clientConn) {
	baseClient.Client.apply(this, arguments);

	//
	//	WARNING: Until we have emit 'ready', self.input, and self.output and
	//	not yet defined!
	//

	var self = this;

	clientConn.on('authentication', function authentication(ctx) {
		self.log.trace(
			{
				domain		: ctx.domain,
				username	: ctx.username,
				method		: ctx.method,
			}, 'SSH authentication');

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
				self.log.info( { method : ctx.method }, 'Unsupported SSH authentication method');
				ctx.reject();
		}
	});

	clientConn.on('ready', function clientReady() {
		self.log.info('SSH authentication success');

		clientConn.on('session', function sess(accept, reject) {
			
			var session = accept();

			session.on('pty', function pty(accept, reject, info) {
				console.log(info);
				var channel = accept();
				console.log(channel)

			});

			session.on('shell', function shell(accept, reject) {
				var channel = accept();

				self.setInputOutput(channel.stdin, channel.stdout);

				self.emit('ready')
			});

		});
	});

	clientConn.on('end', function clientEnd() {
		//self.emit('end');
	});
}

util.inherits(SSHClient, baseClient.Client);

function SSHServerModule() {
	ServerModule.call(this);
}

util.inherits(SSHServerModule, ServerModule);

SSHServerModule.prototype.createServer = function() {
	SSHServerModule.super_.prototype.createServer.call(this);

	var serverConf = {
		privateKey	: fs.readFileSync(conf.config.servers.ssh.rsaPrivateKey),
		banner		: 'ENiGMA½ BBS ' + enigVersion + ' SSH Server',
		ident		: 'enigma-bbs-' + enigVersion + '-srv',
		debug		: function debugSsh(dbgLine) { 
			if(true === conf.config.servers.ssh.debugConnections) {
				Log.trace('SSH: ' + dbgLine);
			}
		},
	};

	var server = ssh2.Server(serverConf);
	server.on('connection', function onConnection(conn, info) {
		Log.info(info, 'New SSH connection');

		var client = new SSHClient(conn);
		
		this.emit('client', client, conn._sock);
	});

	return server;
};