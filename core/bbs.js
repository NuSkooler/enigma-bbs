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
const resolvePath	= require('./misc_util.js').resolvePath;

//	deps
const async			= require('async');
const util			= require('util');
const _				= require('lodash');
const mkdirs		= require('fs-extra').mkdirs;
const fs			= require('graceful-fs');
const paths			= require('path');

//	our main entry point
exports.main	= main;

//	object with various services we want to de-init/shutdown cleanly if possible
const initServices = {};

const ENIGMA_COPYRIGHT	= 'ENiGMA½ Copyright (c) 2014-2017 Bryan Ashby';
const HELP = 
`${ENIGMA_COPYRIGHT}
usage: main.js <args>

valid args:
  --version       : display version
  --help          : displays this help
  --config PATH   : override default config.hjson path
`;

function printHelpAndExit() {
	console.info(HELP);
	process.exit();
}

function main() {
	async.waterfall(
		[
			function processArgs(callback) {
				const argv = require('minimist')(process.argv.slice(2));

				if(argv.help) {
					printHelpAndExit();
				}

				const configOverridePath = argv.config;

				return callback(null, configOverridePath || conf.getDefaultPath(), _.isString(configOverridePath));
			},
			function initConfig(configPath, configPathSupplied, callback) {
				conf.init(resolvePath(configPath), function configInit(err) {

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
				console.info(ENIGMA_COPYRIGHT);
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
					return callback(null);	//	ignore err
				});
			},
			function stopEventScheduler(callback) {
				if(initServices.eventScheduler) {
					return initServices.eventScheduler.shutdown( () => {
						return callback(null);	// ignore err
					});
				} else {
					return callback(null);
				}
			},
			function stopFileAreaWeb(callback) {
				require('./file_area_web.js').startup( () => {
					return callback(null);	// ignore err
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
				const User = require('./user.js');

				async.waterfall(
					[
						function getOpUserName(next) {
							return User.getUserName(1, next);
						},
						function getOpProps(opUserName, next) {
							const propLoadOpts = {
								names	: [ 'real_name', 'sex', 'email_address', 'location', 'affiliation' ],
							};
							User.loadProperties(User.RootUserID, propLoadOpts, (err, opProps) => {
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
			function readyPasswordReset(callback) {
				const WebPasswordReset = require('./web_password_reset.js').WebPasswordReset;
				return WebPasswordReset.startup(callback);
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
