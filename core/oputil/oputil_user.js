/* jslint node: true */
/* eslint-disable no-console */
'use strict';

const printUsageAndSetExitCode	= require('./oputil_common.js').printUsageAndSetExitCode;
const ExitCodes					= require('./oputil_common.js').ExitCodes;
const argv						= require('./oputil_common.js').argv;
const initConfigAndDatabases	= require('./oputil_common.js').initConfigAndDatabases;
const getHelpFor				= require('./oputil_help.js').getHelpFor;
const Errors					= require('../enig_error.js').Errors;

const async						= require('async');
const _							= require('lodash');

exports.handleUserCommand		= handleUserCommand;

function getUser(userName, cb) {
	const User = require('../../core/user.js');
	User.getUserIdAndName(userName, (err, userId) => {
		if(err) {
			process.exitCode = ExitCodes.BAD_ARGS;
			return cb(err);
		}
		const u = new User();
		u.userId = userId;
		return cb(null, u);
	});	
}

function initAndGetUser(userName, cb) {
	async.waterfall(
		[
			function init(callback) {
				initConfigAndDatabases(callback);
			},
			function getUserObject(callback) {
				getUser(userName, (err, user) => {
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

function setAccountStatus(user, status) {
	if(argv._.length < 3) {
		return printUsageAndSetExitCode(getHelpFor('User'), ExitCodes.ERROR);
	}

	const AccountStatus = require('../../core/user.js').AccountStatus;
	const statusDesc = _.invert(AccountStatus)[status];
	user.persistProperty('account_status', status, err => {
		if(err) {
			process.exitCode = ExitCodes.ERROR;
			console.error(err.message);
		} else {
			console.info(`User status set to ${statusDesc}`);
		}
	});
}

function setUserPassword(user) {
	if(argv._.length < 4) {
		return printUsageAndSetExitCode(getHelpFor('User'), ExitCodes.ERROR);
	}

	async.waterfall(
		[
			function validate(callback) {
				//	:TODO: prompt if no password provided (more secure, no history, etc.)
				const password = argv._[argv._.length - 1];
				if(0 === password.length) {
					return callback(Errors.Invalid('Invalid password'));
				}
				return callback(null, password);
			},
			function set(password, callback) {
				user.setNewAuthCredentials(password, err => {
					if(err) {
						process.exitCode = ExitCodes.BAD_ARGS;
					}
					return callback(err);
				});
			}
		],
		err => {
			if(err) {
				console.error(err.message);
			} else {
				console.info('New password set');
			}
		}
	);
}

function removeUser(user) {
	console.error('NOT YET IMPLEMENTED');
}

function modUserGroups(user) {
	if(argv._.length < 3) {
		return printUsageAndSetExitCode(getHelpFor('User'), ExitCodes.ERROR);
	}

	let groupName = argv._[argv._.length - 1].toString().replace(/["']/g, '');	//	remove any quotes - necessary to allow "-foo"
	let action = groupName[0];	//	+ or -

	if('-' === action || '+' === action) {
		groupName = groupName.substr(1);
	}

	action = action || '+';

	if(0 === groupName.length) {
		return printUsageAndSetExitCode(getHelpFor('User'), ExitCodes.ERROR);
	}

	//
	//	Groups are currently arbritary, so do a slight validation
	//
	if(!/[A-Za-z0-9]+/.test(groupName)) {
		process.exitCode = ExitCodes.BAD_ARGS;
		return console.error('Bad group name');
	}

	function done(err) {
		if(err) {
			process.exitCode = ExitCodes.BAD_ARGS;
			console.error(err.message);
		} else {
			console.info('User groups modified');
		}
	}

	const UserGroup = require('../../core/user_group.js');
	if('-' === action) {
		UserGroup.removeUserFromGroup(user.userId, groupName, done);
	} else {
		UserGroup.addUserToGroup(user.userId, groupName, done);
	}
}

function activateUser(user) {
	const AccountStatus = require('../../core/user.js').AccountStatus;
	return setAccountStatus(user, AccountStatus.active);
}

function deactivateUser(user) {
	const AccountStatus = require('../../core/user.js').AccountStatus;
	return setAccountStatus(user, AccountStatus.inactive);
}

function disableUser(user) {
	const AccountStatus = require('../../core/user.js').AccountStatus;
	return setAccountStatus(user, AccountStatus.disabled);
}

function handleUserCommand() {
	function errUsage()  {
		return printUsageAndSetExitCode(getHelpFor('User'), ExitCodes.ERROR);
	}

	if(true === argv.help) {
		return errUsage();
	}

	const action		= argv._[1];
	const usernameIdx	= [ 'pass', 'passwd', 'password', 'group' ].includes(action) ? argv._.length - 2 : argv._.length - 1;
	const userName		= argv._[usernameIdx];

	if(!userName) {
		return errUsage();
	}

	initAndGetUser(userName, (err, user) => {
		if(err) {
			process.exitCode = ExitCodes.ERROR;
			return console.error(err.message);
		}

		return ({
			pass		: setUserPassword,
			passwd		: setUserPassword,
			password	: setUserPassword,

			rm			: removeUser,
			remove		: removeUser,
			del			: removeUser,
			delete		: removeUser,

			activate	: activateUser,
			deactivate	: deactivateUser,
			disable		: disableUser,

			group		: modUserGroups,
		}[action] || errUsage)(user);
	});
}