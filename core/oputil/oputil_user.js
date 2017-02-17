/* jslint node: true */
/* eslint-disable no-console */
'use strict';

const printUsageAndSetExitCode	= require('./oputil_common.js').printUsageAndSetExitCode;
const ExitCodes					= require('./oputil_common.js').ExitCodes;
const argv						= require('./oputil_common.js').argv;
const initConfigAndDatabases	= require('./oputil_common.js').initConfigAndDatabases;


const async						= require('async');

exports.handleUserCommand		= handleUserCommand;

function handleUserCommand() {
	if(true === argv.help || !_.isString(argv.user) || 0 === argv.user.length) {
		return printUsageAndSetExitCode('User', ExitCodes.ERROR);
	}

	if(_.isString(argv.password)) {
		if(0 === argv.password.length) {			
			process.exitCode = ExitCodes.BAD_ARGS;
			return console.error('Invalid password');
		}

		async.waterfall(
			[
				function init(callback) {
					initAndGetUser(argv.user, callback);
				},
				function setNewPass(user, callback) {
					user.setNewAuthCredentials(argv.password, function credsSet(err) {
						if(err) {
							process.exitCode = ExitCodes.ERROR;
							callback(new Error('Failed setting password'));
						} else {
							callback(null);
						}
					});
				}
			],
			function complete(err) {
				if(err) {
					console.error(err.message);
				} else {
					console.info('Password set');
				}
			}
		);
	} else if(argv.activate) {
		setAccountStatus(argv.user, true);		
	} else if(argv.deactivate) {
		setAccountStatus(argv.user, false);
	}
}

function getUser(userName, cb) {
	const user = require('./core/user.js');
	user.getUserIdAndName(argv.user, function userNameAndId(err, userId) {
		if(err) {
			process.exitCode = ExitCodes.BAD_ARGS;
			return cb(new Error('Failed to retrieve user'));
		} else {
			let u = new user.User();
			u.userId = userId;
			return cb(null, u);
		}
	});	
}

function initAndGetUser(userName, cb) {
	async.waterfall(
		[
			function init(callback) {
				initConfigAndDatabases(callback);
			},
			function getUserObject(callback) {
				getUser(argv.user, (err, user) => {
					if(err) {
						process.exitCode = ExitCodes.BAD_ARGS;
						return callback(err);
					}
					return callback(null, user);
				});
			} 
		],
		(err, user) => {
			return cb(err, user);
		}
	);
}

function setAccountStatus(userName, active) {
	async.waterfall(
		[
			function init(callback) {
				initAndGetUser(argv.user, callback);
			},
			function activateUser(user, callback) {
				const AccountStatus = require('./core/user.js').User.AccountStatus;
				user.persistProperty('account_status', active ? AccountStatus.active : AccountStatus.inactive, callback);
			}
		],
		err => {
			if(err) {
				console.error(err.message);
			} else {
				console.info('User ' + ((true === active) ? 'activated' : 'deactivated'));
			}
		}
	);	
}