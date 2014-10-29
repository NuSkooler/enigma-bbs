/* jslint node: true */
'use strict';

//	ENiGMA½
var conf		= require('./config.js');
var modules		= require('./modules.js');
var logger		= require('./logger.js');
var miscUtil	= require('./misc_util.js');
var database	= require('./database.js');

var iconv		= require('iconv-lite');
var paths		= require('path');

exports.bbsMain = function() {
	var mainArgs = parseArgs();

	var configPathSupplied = false;
	var configPath = conf.defaultPath();

	if(mainArgs.indexOf('--help') > 0) {
		//	:TODO: display help
	} else {
		var argCount = mainArgs.length;
		for(var i = 0; i < argCount; ++i) {
			var arg = mainArgs[i];
			if('--config' == arg) {
				configPathSupplied = true;
				configPath = mainArgs[i + 1];
			}
		}
	}

	try {
		conf.initFromFile(configPath);
	} catch(e) {
		//
		//	If the user supplied a config and we can't read, parse, whatever
		//	then output a error and bail.
		//
		if(configPathSupplied) {
			if(e.code === 'ENOENT') {
				console.error('Configuration file does not exist: ' + configPath);
			}
			return;
		}

		console.log('No configuration file found, creating defaults.');
		conf.createDefault();
	}

	logger.init();

	process.on('SIGINT', function onSigInt() {
		//	:TODO: for any client in |clientConnections|, if 'ready', send a "Server Disconnecting" + semi-gracefull hangup
		//	e.g. client.disconnectNow()

		logger.log.info('Process interrupted, shutting down');
		process.exit();
	});

	database.initializeDatabases();

	preServingInit();

	startListening();
};

function parseArgs() {
	var args = [];
	process.argv.slice(2).forEach(function(val, index, array) {
		args.push(val);
	});

	return args;
}

function preServingInit() {
	iconv.extendNodeEncodings();
}

var clientConnections  = [];

function startListening() {
	if(!conf.config.servers) {
		//	:TODO: Log error ... output to stderr as well. We can do it all with the logger
		logger.log.error('No servers configured');
		return [];
	}

	modules.loadModulesForCategory('servers', function onServerModule(err, module) {
		if(err) {
			logger.log.info(err);
			return;
		}

		var port = parseInt(module.runtime.config.port);
		if(isNaN(port)) {
			logger.log.error({ port : module.runtime.config.port, server : module.moduleInfo.name }, 'Cannot load server (Invalid port)');
			return;
		}

		var server = module.createServer();

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
			//client.runtime.id = clientConnections.push(client) - 1;

			//logger.log.info({ clientId : client.runtime.id, from : client.address(), server : module.moduleInfo.name }, 'Client connected');

			client.on('ready', function onClientReady() {
				//	Go to module -- use default error handler
				modules.goto(conf.config.entryMod, client);
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