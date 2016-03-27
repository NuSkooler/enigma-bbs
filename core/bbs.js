/* jslint node: true */
'use strict';

//var SegfaultHandler = require('segfault-handler');
//SegfaultHandler.registerHandler('enigma-bbs-segfault.log');

//	ENiGMA½
let conf		= require('./config.js');
let logger		= require('./logger.js');
let miscUtil	= require('./misc_util.js');
let database	= require('./database.js');
let clientConns	= require('./client_connections.js');

let paths		= require('path');
let async		= require('async');
let util		= require('util');
let _			= require('lodash');
let assert		= require('assert');
let mkdirp 		= require('mkdirp');

//	our main entry point
exports.bbsMain	= bbsMain;

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
					callback(err);
				});
			},
			function listenConnections(callback) {
				startListening(callback);
			}
		],
		function complete(err) {
			if(err) {
				console.error('Error initializing: ' + util.inspect(err));
			}
		}
	);
}

function initialize(cb) {
	async.series(
		[
			function createMissingDirectories(callback) {
				async.each(Object.keys(conf.config.paths), function entry(pathKey, next) {
					mkdirp(conf.config.paths[pathKey], function dirCreated(err) {
						if(err) {
							console.error('Could not create path: ' + conf.config.paths[pathKey] + ': ' + err.toString());
						}
						next(err);
					});
				}, function dirCreationComplete(err) {
					callback(err);
				});
			},
			function basicInit(callback) {
				logger.init();

				process.on('SIGINT', function onSigInt() {
					logger.log.info('Process interrupted, shutting down...');

					var activeConnections = clientConns.getActiveConnections();
					var i = activeConnections.length;
					while(i--) {
						activeConnections[i].term.write('\n\nServer is shutting down NOW! Disconnecting...\n\n');
						clientConns.removeClient(activeConnections[i]);
					}
					
					process.exit();
				});
			
				//	Init some extensions
				require('string-format').extend(String.prototype, require('./string_util.js').stringFormatExtensions);

				callback(null);
			},			
			function initDatabases(callback) {
				database.initializeDatabases(callback);
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
			},
			function readyMessageNetworkSupport(callback) {
				require('./msg_network.js').startup(callback);	
			}
		],
		function onComplete(err) {
			cb(err);
		}
	);
}

function startListening(cb) {
	if(!conf.config.servers) {
		//	:TODO: Log error ... output to stderr as well. We can do it all with the logger
		//logger.log.error('No servers configured');
		cb(new Error('No servers configured'));
		return;
	}

	let moduleUtil = require('./module_util.js');	//	late load so we get Config

	moduleUtil.loadModulesForCategory('servers', (err, module) => {
		if(err) {
			logger.log.info(err);
			return;
		}

		const port = parseInt(module.runtime.config.port);
		if(isNaN(port)) {
			logger.log.error( { port : module.runtime.config.port, server : module.moduleInfo.name }, 'Cannot load server (Invalid port)');
			return;
		}

		const moduleInst	= new module.getModule();
        let server;
        try {
		    server		= moduleInst.createServer();
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
				var l = hadError ? logger.log.info : logger.log.debug;
				l( { clientId : client.session.id }, 'Connection closed');
				
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
	var theme = require('./theme.js');

	//	:TODO: it feels like this should go somewhere else... and be a bit more elegant.

	if('*' === conf.config.preLoginTheme) {
		client.user.properties.theme_id = theme.getRandomTheme() || '';
	} else {
		client.user.properties.theme_id = conf.config.preLoginTheme;
	}
    
    theme.setClientTheme(client, client.user.properties.theme_id);
    cb(null);   //  note: currently useless to use cb here - but this may change...again...
}