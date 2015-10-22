/* jslint node: true */
'use strict';

//	ENiGMA½
var conf		= require('./config.js');
var logger		= require('./logger.js');
var miscUtil	= require('./misc_util.js');
var database	= require('./database.js');
var clientConns	= require('./client_connections.js');

var paths		= require('path');
var async		= require('async');
var util		= require('util');
var _			= require('lodash');
var assert		= require('assert');

exports.bbsMain			= bbsMain;

function bbsMain() {
	async.waterfall(
		[
			function processArgs(callback) {
				var args = parseArgs();

				var configPath;

				if(args.indexOf('--help') > 0) {
					//	:TODO: display help
				} else {
					var argCount = args.length;
					for(var i = 0; i < argCount; ++i) {
						var arg = args[i];
						if('--config' == arg) {
							configPath = args[i + 1];
						}
					}
				}

				var configPathSupplied = _.isString(configPath);
				callback(null, configPath || conf.getDefaultPath(), configPathSupplied);
			},
			function initConfig(configPath, configPathSupplied, callback) {
				conf.init(configPath, function configInit(err) {

					//
					//	If the user supplied a path and we can't read/parse it 
					//	then it's a fatal error
					//
					if(configPathSupplied && err) {
						if('ENOENT' === err.code) {
							console.error('Configuration file does not existing: ' + configPath);
						} else {
							console.error('Failed parsing configuration: ' + configPath);
						}
						callback(err);
					} else {
						callback(null);
					}
				});
			},
			function initSystem(callback) {
				initialize(function init(err) {
					if(err) {
						console.error('Error initializing: ' + util.inspect(err));
					}
					callback(err);
				});
			}
		],
		function complete(err) {
			if(!err) {
				startListening();
			}
		}
	);
}

function parseArgs() {
	var args = [];
	process.argv.slice(2).forEach(function(val, index, array) {
		args.push(val);
	});

	return args;
}

function initialize(cb) {
	async.series(
		[
			function basicInit(callback) {
				logger.init();

				process.on('SIGINT', function onSigInt() {
					//	:TODO: for any client in |clientConnections|, if 'ready', send a "Server Disconnecting" + semi-gracefull hangup
					//	e.g. client.disconnectNow()

					logger.log.info('Process interrupted, shutting down');
					process.exit();
				});

				//	Init some extensions
				require('iconv-lite').extendNodeEncodings();
				require('string-format').extend(String.prototype, require('./string_util.js').stringFormatExtensions);

				callback(null);
			},
			function initDatabases(callback) {
				database.initializeDatabases();
				callback(null);			
			},
			function initSystemProperties(callback) {
				require('./system_property.js').loadSystemProperties(callback);
			},
			function initThemes(callback) {
				//	Have to pull in here so it's after Config init
				var theme = require('./theme.js');
				theme.initAvailableThemes(function onThemesInit(err, themeCount) {
					logger.log.info({ themeCount : themeCount }, 'Themes initialized');
					callback(err);
				});
			},
			function loadSysOpInformation(callback) {
				//
				//	If user 1 has been created, we have a SysOp. Cache some information
				//	into Config.
				//
				var user = require('./user.js');	//	must late load

				user.getUserName(1, function unLoaded(err, sysOpUsername) {
					if(err) {
						callback(null);	//	non-fatal here
					} else {
						//
						//	Load some select properties to cache
						//
						var propLoadOpts = {
							userId	: 1,
							names	: [ 'real_name', 'sex', 'email_address' ],
						};

						user.loadProperties(propLoadOpts, function propsLoaded(err, props) {
							if(!err) {
								conf.config.general.sysOp = {
									username	: sysOpUsername,
									properties	: props,
								};

								logger.log.info( { sysOp : conf.config.general.sysOp }, 'System Operator information cached');
							}
							callback(null);	//	any error is again, non-fatal here
						});
					}
				});
			}
		],
		function onComplete(err) {
			cb(err);
		}
	);
}

function startListening() {
	if(!conf.config.servers) {
		//	:TODO: Log error ... output to stderr as well. We can do it all with the logger
		logger.log.error('No servers configured');
		return [];
	}

	var moduleUtil = require('./module_util.js');	//	late load so we get Config

	moduleUtil.loadModulesForCategory('servers', function onServerModule(err, module) {
		if(err) {
			logger.log.info(err);
			return;
		}

		var port = parseInt(module.runtime.config.port);
		if(isNaN(port)) {
			logger.log.error( { port : module.runtime.config.port, server : module.moduleInfo.name }, 'Cannot load server (Invalid port)');
			return;
		}

		var moduleInst = new module.getModule();
		var server = moduleInst.createServer();

		//	:TODO: handle maxConnections, e.g. conf.maxConnections

		server.on('client', function newClient(client, clientSock) {									
			//
			//	Start tracking the client. We'll assign it an ID which is
			//	just the index in our connections array.
			//			
			if(_.isUndefined(client.session)) {
				client.session = {};
			}

			client.session.serverName 	= module.moduleInfo.name;
			client.session.isSecure		= module.moduleInfo.isSecure || false;

			clientConns.addNewClient(client, clientSock);

			client.on('ready', function clientReady(readyOptions) {

				client.startIdleMonitor();

				//	Go to module -- use default error handler
				prepareClient(client, function clientPrepared() {
					require('./connect.js').connectEntry(client, readyOptions.firstMenu);
				});
			});

			client.on('end', function onClientEnd() {
				clientConns.removeClient(client);
			});

			client.on('error', function onClientError(err) {
				logger.log.info({ clientId : client.session.id }, 'Connection error: %s' % err.message);
			});

			client.on('close', function onClientClose(hadError) {
				var l = hadError ? logger.log.info : logger.log.debug;
				l( { clientId : client.session.id }, 'Connection closed');
				
				clientConns.removeClient(client);
			});

			client.on('idle timeout', function idleTimeout() {
				client.log.info('User idle timeout expired');				

				client.gotoMenuModule( { name : 'idleLogoff' }, function goMenuRes(err) {
					if(err) {
						//	likely just doesn't exist
						client.term.write('\nIdle timeout expired. Goodbye!\n');
						client.end();
					}			
				});
			});
		});

		server.on('error', function serverErr(err) {
			logger.log.info(err);	//	'close' should be handled after
		});

		server.listen(port);
		logger.log.info({ server : module.moduleInfo.name, port : port }, 'Listening for connections');
	});
}

function prepareClient(client, cb) {
	var theme = require('./theme.js');

	//	:TODO: it feels like this should go somewhere else... and be a bit more elegant.

	if('*' === conf.config.preLoginTheme) {
		client.user.properties.theme_id = theme.getRandomTheme() || '';
	} else {
		client.user.properties.theme_id = conf.config.preLoginTheme;
	}

	theme.loadTheme(client.user.properties.theme_id, function themeLoaded(err, theme) {
		client.currentTheme = theme;
		cb(null);
	});
}