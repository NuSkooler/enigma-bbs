/* jslint node: true */
'use strict';

var bunyan		= require('bunyan');
var miscUtil	= require('./misc_util.js');
var paths		= require('path');
var fs			= require('fs');

module.exports	= {
	init	: function() {
		var Config = require('./config.js').config;
		//var ringBufferLimit = miscUtil.valueWithDefault(config.logRingBufferLimit, 100);
		var logPath			= Config.paths.logs;

		//
		//	Create something a bit more friendly if the log directory cannot be used
		//
		//	:TODO: this seems cheesy...
		var logPathError;
		try {
			var pathStat = fs.statSync(logPath);
			if(!pathStat.isDirectory()) {
				logPathError = logPath + ' is not a directory!';
			}
		} catch(e) {
			logPathError = e.message;
		}

		if(logPathError) {
			console.error(logPathError);
			process.exit();
		}

		var logFile			= paths.join(logPath, 'enigma-bbs.log');

		//	:TODO: make this configurable --
		//	user should be able to configure rotations, levels to file vs ringBuffer, 
		//	completely disable logging, etc.

		this.log = bunyan.createLogger({
			name	: 'ENiGMA½ BBS',
			streams	: [
				{
					type	: 'rotating-file',
					path	: logFile,
					period	: '1d',
					count	: 3,
					level	: 'trace'
				}
				/*,
				{
					type	: 'raw',
					stream	: ringBuffer,
					level	: 'trace'
				}*/
			]
		});
	}
};
