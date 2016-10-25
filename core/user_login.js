/* jslint node: true */
'use strict';

//	ENiGMA½
const setClientTheme	= require('./theme.js').setClientTheme;
const clientConnections	= require('./client_connections.js').clientConnections;
const StatLog			= require('./stat_log.js');
const logger			= require('./logger.js');

//	deps
const async				= require('async');

exports.userLogin		= userLogin;

function userLogin(client, username, password, cb) {
	client.user.authenticate(username, password, function authenticated(err) {
		if(err) {
			client.log.info( { username : username, error : err.message }, 'Failed login attempt');

			//	:TODO: if username exists, record failed login attempt to properties
			//	:TODO: check Config max failed logon attempts/etc. - set err.maxAttempts = true

			return cb(err);
		}
		const user	= client.user;

		//
		//	Ensure this user is not already logged in.
		//	Loop through active connections -- which includes the current --
		//	and check for matching user ID. If the count is > 1, disallow.
		//
		let existingClientConnection = 
		clientConnections.forEach(function connEntry(cc) {
			if(cc.user !== user && cc.user.userId === user.userId) {
				existingClientConnection = cc;
			}
		});

		if(existingClientConnection) {
			client.log.info( {
				existingClientId	: existingClientConnection.session.id, 
				username			: user.username, 
				userId				: user.userId },
				'Already logged in'
			);

			var existingConnError = new Error('Already logged in as supplied user');
			existingConnError.existingConn = true;

			return cb(existingClientConnection);
		}


		//	update client logger with addition of username
		client.log = logger.log.child( { clientId : client.log.fields.clientId, username : user.username });
		client.log.info('Successful login');            

		async.parallel(
			[
				function setTheme(callback) {
					setClientTheme(client, user.properties.theme_id);
					callback(null);
				},
				function updateSystemLoginCount(callback) {
					StatLog.incrementSystemStat('login_count', 1, callback);
				},
				function recordLastLogin(callback) {
					StatLog.setUserStat(user, 'last_login_timestamp', StatLog.now, callback);
				},
				function updateUserLoginCount(callback) {
					StatLog.incrementUserStat(user, 'login_count', 1, callback);						
				},
				function recordLoginHistory(callback) {
					const LOGIN_HISTORY_MAX	= 200;	//	history of up to last 200 callers
					StatLog.appendSystemLogEntry('user_login_history', user.userId, LOGIN_HISTORY_MAX, StatLog.KeepType.Max, callback);
				}
			],
			function complete(err) {
				cb(err);
			}
		);
	});
}