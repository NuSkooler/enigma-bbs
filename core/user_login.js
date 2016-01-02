/* jslint node: true */
'use strict';

var theme				= require('./theme.js');
var clientConnections	= require('./client_connections.js').clientConnections;
var userDb				= require('./database.js').dbs.user;
var sysProp				= require('./system_property.js');
var logger				= require('./logger.js');

var async				= require('async');
var _					= require('lodash');
var assert				= require('assert');

exports.userLogin		= userLogin;

function userLogin(client, username, password, cb) {
	client.user.authenticate(username, password, function authenticated(err) {
		if(err) {
			client.log.info( { username : username }, 'Failed login attempt: %s', err);

			//	:TODO: if username exists, record failed login attempt to properties
			//	:TODO: check Config max failed logon attempts/etc. - set err.maxAttempts = true

			cb(err);
		} else {
			var now		= new Date();
			var user	= client.user;

			//
			//	Ensure this user is not already logged in.
			//	Loop through active connections -- which includes the current --
			//	and check for matching user ID. If the count is > 1, disallow.
			//
			var existingClientConnection;
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
				existingClientConnection.existingConn = true;

				return cb(existingClientConnection);
			}


			//	update client logger with addition of username
			client.log = logger.log.child( { clientId : client.log.fields.clientId, username : user.username });
			client.log.info('Successful login');

			async.parallel(
				[
					function loadThemeConfig(callback) {
						theme.loadTheme(user.properties.theme_id, function themeLoaded(err, theme) {
							client.currentTheme = theme;
							callback(null);	//	always non-fatal
						});
					},
					function updateSystemLoginCount(callback) {
						var sysLoginCount = sysProp.getSystemProperty('login_count') || 0;
						sysLoginCount = parseInt(sysLoginCount, 10) + 1;
						sysProp.persistSystemProperty('login_count', sysLoginCount, callback);
					},
					function recordLastLogin(callback) {
						user.persistProperty('last_login_timestamp', now.toISOString(), function persisted(err) {
							callback(err);
						});
					},
					function updateUserLoginCount(callback) {
						if(!user.properties.login_count) {
							user.properties.login_count = 1;
						} else {
							user.properties.login_count++;
						}
						
						user.persistProperty('login_count', user.properties.login_count, function persisted(err) {
							callback(err);
						});
					},
					function recordLoginHistory(callback) {
						userDb.serialize(function serialized() {
							userDb.run(
								'INSERT INTO user_login_history (user_id, user_name, timestamp) ' +
								'VALUES(?, ?, ?);', [ user.userId, user.username, now.toISOString() ]
							);

							//	keep 30 days of records
							userDb.run(
								'DELETE FROM user_login_history '	+
								'WHERE timestamp <= DATETIME("now", "-30 day");'
								);
						});

						callback(null);
					}
				],
				function complete(err) {
					cb(err);
				}
			);
		}
	});
}