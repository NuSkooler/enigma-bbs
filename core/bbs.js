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
		],
		function complete(err) {
			//	note this is escaped:
			fs.readFile(paths.join(__dirname, '../misc/startup_banner.asc'), 'utf8', (err, banner) => {
				console.info('ENiGMA½ Copyright (c) 2014-2017 Bryan Ashby');
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
			function stopListeningServers(callback) {
				return require('./listening_server.js').shutdown( () => {
					//	:TODO: log err
					return callback(null);	//	ignore err
				});
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
			function stopFileAreaWeb(callback) {
				require('./file_area_web.js').startup(err => {
					//	:TODO: Log me if err
					return callback(null);
				});
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
			function listenConnections(callback) {
				return require('./listening_server.js').startup(callback);
			},
			function readyFileAreaWeb(callback) {
				return require('./file_area_web.js').startup(callback);
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
