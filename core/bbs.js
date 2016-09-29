/* jslint node: true */
/* eslint-disable no-console */
'use strict';

//var SegfaultHandler = require('segfault-handler');
//SegfaultHandler.registerHandler('enigma-bbs-segfault.log');

//	ENiGMA½
const conf			= require('./config.js');
const logger		= require('./logger.js');
const database		= require('./database.js');
const clientConns	= require('./client_connections.js');

//	deps
const async			= require('async');
const util			= require('util');
const _				= require('lodash');
const mkdirs		= require('fs-extra').mkdirs;
const fs			= require('fs');
const paths			= require('path');

//	our main entry point
exports.bbsMain	= bbsMain;

//	object with various services we want to de-init/shutdown cleanly if possible
const initServices = {};

function bbsMain() {
	async.waterfall(
		[
			function processArgs(callback) {
				const args = process.argv.slice(2);

				var configPath;

				if(args.indexOf('--help') > 0) {
					//	:TODO: display help
				} else {
					let argCount = args.length;
					for(let i = 0; i < argCount; ++i) {
						const arg = args[i];
						if('--config' === arg) {
							configPath = args[i + 1];
						}
					}
				}

				callback(null, configPath || conf.getDefaultPath(), _.isString(configPath));
			},
			function initConfig(configPath, configPathSupplied, callback) {
				conf.init(configPath, function configInit(err) {

					//
					//	If the user supplied a path and we can't read/parse it 
					//	then it's a fatal error
					//
					if(err) {
						if('ENOENT' === err.code)  {
							if(configPathSupplied) {
								console.error('Configuration file does not exist: ' + configPath);
							} else {
								configPathSupplied = null;	//	make non-fatal; we'll go with defaults
							}
						} else {
							console.error(err.toString());
						}
					}
					callback(err);
				});
			},
			function initSystem(callback) {
				initialize(function init(err) {
					if(err) {
						console.error('Error initializing: ' + util.inspect(err));
					}
					return callback(err);
				});
			},
			function listenConnections(callback) {
				return startListening(callback);
			}
		],
		function complete(err) {
			//	note this is escaped:
			fs.readFile(paths.join(__dirname, '../misc/startup_banner.asc'), 'utf8', (err, banner) => {
				console.info('ENiGMA½ Copyright (c) 2014-2016 Bryan Ashby');
				if(!err) {					
					console.info(banner);
				}					
				console.info('System started!');
			});

			if(err) {
				console.error('Error initializing: ' + util.inspect(err));
			}
		}
	);
}

function shutdownSystem() {
	const msg = 'Process interrupted. Shutting down...';
	console.info(msg);
	logger.log.info(msg);

	async.series(
		[
			function closeConnections(callback) {
				const activeConnections = clientConns.getActiveConnections();
				let i = activeConnections.length;
				while(i--) {
					activeConnections[i].term.write('\n\nServer is shutting down NOW! Disconnecting...\n\n');
					clientConns.removeClient(activeConnections[i]);
				}
				callback(null);
			},
			function stopEventScheduler(callback) {
				if(initServices.eventScheduler) {
					return initServices.eventScheduler.shutdown( () => {
						callback(null);	// ignore err
					});
				} else {
					return callback(null);
				}
			},
			function stopMsgNetwork(callback) {
				require('./msg_network.js').shutdown(callback);
			} 
		],
		() => {
			console.info('Goodbye!');
			return process.exit();
		}
	);
}

function initialize(cb) {
	async.series(
		[
			function createMissingDirectories(callback) {
				async.each(Object.keys(conf.config.paths), function entry(pathKey, next) {
					mkdirs(conf.config.paths[pathKey], function dirCreated(err) {
						if(err) {
							console.error('Could not create path: ' + conf.config.paths[pathKey] + ': ' + err.toString());
						}
						return next(err);
					});
				}, function dirCreationComplete(err) {
					return callback(err);
				});
			},
			function basicInit(callback) {
				logger.init();
				logger.log.info(
					{ version : require('../package.json').version },
					'**** ENiGMA½ Bulletin Board System Starting Up! ****');

				process.on('SIGINT', shutdownSystem);

				require('later').date.localTime();	//	use local times for later.js/scheduling
			
				return callback(null);
			},			
			function initDatabases(callback) {
				return database.initializeDatabases(callback);
			},
			function initStatLog(callback) {
				return require('./stat_log.js').init(callback);
			},
			function initThemes(callback) {
				//	Have to pull in here so it's after Config init
				require('./theme.js').initAvailableThemes(function onThemesInit(err, themeCount) {
					logger.log.info({ themeCount : themeCount }, 'Themes initialized');
					return callback(err);
				});
			},
			function loadSysOpInformation(callback) {
				//
				//	Copy over some +op information from the user DB -> system propertys.
				//	* Makes this accessible for MCI codes, easy non-blocking access, etc.
				//	* We do this every time as the op is free to change this information just
				//	  like any other user
				//				
				const user		= require('./user.js');

				async.waterfall(
					[
						function getOpUserName(next) {
							return user.getUserName(1, next);
						},
						function getOpProps(opUserName, next) {
							const propLoadOpts = {
								userId	: 1,
								names	: [ 'real_name', 'sex', 'email_address', 'location', 'affiliation' ],
							};
							user.loadProperties(propLoadOpts, (err, opProps) => {
								return next(err, opUserName, opProps);
							});
						}
					],
					(err, opUserName, opProps) => {
						const StatLog = require('./stat_log.js');

						if(err) {
							[ 'username', 'real_name', 'sex', 'email_address', 'location', 'affiliation' ].forEach(v => {
								StatLog.setNonPeristentSystemStat(`sysop_${v}`, 'N/A');
							});
						} else {
							opProps.username = opUserName;

							_.each(opProps, (v, k) => {
								StatLog.setNonPeristentSystemStat(`sysop_${k}`, v); 
							});
						}

						return callback(null);
					}
				);
			},
			function initMCI(callback) {
				return require('./predefined_mci.js').init(callback);
			},
			function readyMessageNetworkSupport(callback) {
				return require('./msg_network.js').startup(callback);	
			},
			function readyEventScheduler(callback) {
				const EventSchedulerModule = require('./event_scheduler.js').EventSchedulerModule;
				EventSchedulerModule.loadAndStart( (err, modInst) => {
					initServices.eventScheduler = modInst;
					return callback(err);
				});
			}
		],
		function onComplete(err) {
			return cb(err);
		}
	);
}

function startListening(cb) {
	if(!conf.config.loginServers) {
		//	:TODO: Log error ... output to stderr as well. We can do it all with the logger
		return cb(new Error('No login servers configured'));
	}

	const moduleUtil = require('./module_util.js');	//	late load so we get Config

	moduleUtil.loadModulesForCategory('loginServers', (err, module) => {
		if(err) {
			if('EENIGMODDISABLED' === err.code) {
				logger.log.debug(err.message);
			} else {
				logger.log.info( { err : err }, 'Failed loading module');
			}
			return;
		}

		const port = parseInt(module.runtime.config.port);
		if(isNaN(port)) {
			logger.log.error( { port : module.runtime.config.port, server : module.moduleInfo.name }, 'Cannot load server (Invalid port)');
			return;
		}

		const moduleInst = new module.getModule();
		let server;
		try {
			server = moduleInst.createServer();
		} catch(e) {
			logger.log.warn(e, 'Exception caught creating server!');
			return;
		}

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
				const logFunc = hadError ? logger.log.info : logger.log.debug;
				logFunc( { clientId : client.session.id }, 'Connection closed');
				
				clientConns.removeClient(client);
			});

			client.on('idle timeout', function idleTimeout() {
				client.log.info('User idle timeout expired');

				client.menuStack.goto('idleLogoff', function goMenuRes(err) {
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

		logger.log.info(
			{ server : module.moduleInfo.name, port : port }, 'Listening for connections');
	}, err => {
		cb(err);
	});
}

function prepareClient(client, cb) {
	const theme = require('./theme.js');

	//	:TODO: it feels like this should go somewhere else... and be a bit more elegant.

	if('*' === conf.config.preLoginTheme) {
		client.user.properties.theme_id = theme.getRandomTheme() || '';
	} else {
		client.user.properties.theme_id = conf.config.preLoginTheme;
	}
    
	theme.setClientTheme(client, client.user.properties.theme_id);
	return cb(null);   //  note: currently useless to use cb here - but this may change...again...
}