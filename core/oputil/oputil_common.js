/* jslint node: true */
/* eslint-disable no-console */
'use strict';

const resolvePath		= require('../misc_util.js').resolvePath;

const config			= require('../../core/config.js');
const db				= require('../../core/database.js');

const _					= require('lodash');
const async				= require('async');

exports.printUsageAndSetExitCode		= printUsageAndSetExitCode;
exports.getDefaultConfigPath			= getDefaultConfigPath;
exports.getConfigPath					= getConfigPath;
exports.initConfigAndDatabases			= initConfigAndDatabases;
exports.getAreaAndStorage				= getAreaAndStorage;

const exitCodes = exports.ExitCodes = {
	SUCCESS		: 0,
	ERROR		: -1,
	BAD_COMMAND	: -2,
	BAD_ARGS	: -3,
};

const argv = exports.argv = require('minimist')(process.argv.slice(2), {
	alias : {
		h	 	: 'help',
		v		: 'version',
		c		: 'config',
		n		: 'no-prompt',
	}
});

function printUsageAndSetExitCode(errMsg, exitCode) {
	if(_.isUndefined(exitCode)) {
		exitCode = exitCodes.ERROR;
	}

	process.exitCode = exitCode;

	if(errMsg) {
		console.error(errMsg);
	}
}

function getDefaultConfigPath() {
    return './config/config.hjson';
}

function getConfigPath() {
	return argv.config ? argv.config : config.getDefaultPath();
}

function initConfig(cb) {
	const configPath = getConfigPath();

	config.init(configPath, { keepWsc : true }, cb);
}

function initConfigAndDatabases(cb) {
	async.series(
		[
			function init(callback) {
				initConfig(callback);
			},
			function initDb(callback) {
				db.initializeDatabases(callback);
			},
		],
		err => {
			return cb(err);
		}
	);
}

function getAreaAndStorage(tags) {
	return tags.map(tag => {
		const parts = tag.toString().split('@');
		const entry = {
			areaTag	: parts[0],
		};
		entry.pattern = entry.areaTag;	//	handy
		if(parts[1]) {
			entry.storageTag = parts[1];
		}
		return entry;
	});
}