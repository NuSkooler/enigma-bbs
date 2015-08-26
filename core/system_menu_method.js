/* jslint node: true */
'use strict';

var theme				= require('./theme.js');
var clientConnections	= require('./client_connections.js').clientConnections;
var ansi				= require('./ansi_term.js');
var userDb				= require('./database.js').dbs.user;

var async				= require('async');

exports.login			= login;
exports.logoff			= logoff;

function login(callingMenu, formData, extraArgs) {
	var client = callingMenu.client;

	client.user.authenticate(formData.value.username, formData.value.password, function authenticated(err) {
		if(err) {
			client.log.info( { username : formData.value.username }, 'Failed login attempt %s', err);

			//	:TODO: if username exists, record failed login attempt to properties
			//	:TODO: check Config max failed logon attempts/etc.

			client.gotoMenuModule( { name : callingMenu.menuConfig.fallback } );
		} else {
			var now		= new Date();
			var user	= callingMenu.client.user;

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
					existingClientId	: existingClientConnection.runtime.id, 
					username			: user.username, 
					userId				: user.userId },
					'Already logged in'
				);

				//	:TODO: display custom message if present
				
				client.term.write('\nA user by that name is already logged in.\n');

				setTimeout(function timeout() {
					client.gotoMenuModule( { name : callingMenu.menuConfig.fallback } );					
				}, 500);

				return;
			}


			//	use client.user so we can get correct case
			client.log.info( { username : user.username }, 'Successful login');

			async.parallel(
				[
					function loadThemeConfig(callback) {
						theme.loadTheme(user.properties.theme_id, function themeLoaded(err, theme) {
							client.currentTheme = theme;
							callback(null);	//	always non-fatal
						});
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
				function complete(err, results) {
					if(err) {
						client.log.error(err);
						//	:TODO: drop the connection?
					}
					client.gotoMenuModule( { name : callingMenu.menuConfig.next } );
				}
			);
		}
	});
}

function logoff(callingMenu, formData, extraArgs) {
	//
	//	Simple logoff. Note that recording of @ logoff properties/stats
	//	occurs elsewhere!
	//
	var client = callingMenu.client;

	setTimeout(function timeout() {
		//
		//	For giggles...
		//
		client.term.write(
			ansi.normal() +	'\n' +
			require('crypto').randomBytes(Math.floor(Math.random() * 35) + 10).toString(client.term.outputEncoding) + 
			'NO CARRIER');

		client.end();
	}, 500);
}