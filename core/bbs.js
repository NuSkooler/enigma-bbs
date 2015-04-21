/* jslint node: true */
'use strict';

//	ENiGMA½
var conf		= require('./config.js');
var logger		= require('./logger.js');
var miscUtil	= require('./misc_util.js');
var database	= require('./database.js');

var iconv		= require('iconv-lite');
var paths		= require('path');
var async		= require('async');
var util		= require('util');
var _			= require('lodash');

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

				iconv.extendNodeEncodings();

				callback(null);
			},
			function initDatabases(callback) {
				database.initializeDatabases();
				callback(null);			
			},
			function initThemes(callback) {
				//	Have to pull in here so it's after Config init
				var theme = require('./theme.js');
				theme.initAvailableThemes(function onThemesInit(err, themeCount) {
					logger.log.info({ themeCount : themeCount }, 'Themes initialized');
					callback(err);
				});
			}
		],
		function onComplete(err) {
			cb(err);
		}
	);
}

var clientConnections  = [];

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
			logger.log.error({ port : module.runtime.config.port, server : module.moduleInfo.name }, 'Cannot load server (Invalid port)');
			return;
		}

		var moduleInst = new module.getModule();
		var server = moduleInst.createServer();

		//	:TODO: handle maxConnections, e.g. conf.maxConnections

		server.on('client', function onClient(client) {									
			//
			//	Start tracking the client. We'll assign it an ID which is
			//	just the index in our connections array.
			//
			if(typeof client.runtime === 'undefined') {
				client.runtime = {};
			}

			addNewClient(client);

			//logger.log.info({ clientId : client.runtime.id, from : client.address(), server : module.moduleInfo.name }, 'Client connected');

			client.on('ready', function onClientReady() {
				//	Go to module -- use default error handler
				prepareClient(client, function onPrepared() {
					require('./connect.js').connectEntry(client);
				});
			});

			client.on('end', function onClientEnd() {
				logger.log.info({ clientId : client.runtime.id }, 'Client disconnected');

				removeClient(client);
			});

			client.on('error', function onClientError(err) {
				logger.log.info({ clientId : client.runtime.id }, 'Connection error: %s' % err.message);
			});

			client.on('close', function onClientClose(hadError) {
				var l = hadError ? logger.log.info : logger.log.debug;
				l({ clientId : client.runtime.id }, 'Connection closed');
				removeClient(client);
			});
		});

		server.listen(port);
		logger.log.info({ server : module.moduleInfo.name, port : port }, 'Listening for connections');
	});
}

function addNewClient(client) {
	var id = client.runtime.id = clientConnections.push(client) - 1;
	logger.log.debug('Connection count is now %d', clientConnections.length);
	return id;
}

function removeClient(client) {
	var i = clientConnections.indexOf(client);
	if(i > -1) {
		clientConnections.splice(i, 1);
		logger.log.debug('Connection count is now %d', clientConnections.length);
	}
}

function prepareClient(client, cb) {
	//	:TODO: it feels like this should go somewhere else... and be a bit more elegant.
	if('*' === conf.config.preLoginTheme) {
		var theme = require('./theme.js');

		async.waterfall(
			[
				function getRandTheme(callback) {
					theme.getRandomTheme(function randTheme(err, themeId) {
						client.user.properties.theme_id = themeId || '';
						callback(null);
					});
				},
				function setCurrentThemeInfo(callback) {
					theme.getThemeInfo(client.user.properties.theme_id, function themeInfo(err, info) {
						client.currentThemeInfo = info;
						callback(null);
					});
				}
			],
			function complete(err) {
				cb(err);
			}
		);
	} else {
		client.user.properties.theme_id = conf.config.preLoginTheme;
		cb(null);
	}
}