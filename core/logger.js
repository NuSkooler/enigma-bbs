"use strict";

var bunyan		= require('bunyan');
var miscUtil	= require('./misc_util.js');
var paths		= require('path');
var conf		= require('./config.js');

module.exports	= {
	log		: undefined,

	init	: function() {
		//var ringBufferLimit = miscUtil.valueWithDefault(config.logRingBufferLimit, 100);
		var logPath			= miscUtil.valueWithDefault(conf.config.paths.logs);
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
