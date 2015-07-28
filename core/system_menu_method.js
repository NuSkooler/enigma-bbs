/* jslint node: true */
'use strict';

var theme			= require('../core/theme.js');
//var Log				= require('../core/logger.js').log;
var ansi			= require('../core/ansi_term.js');
var userDb			= require('./database.js').dbs.user;

var async			= require('async');

exports.login		= login;
exports.logoff		= logoff;

function login(callingMenu, formData, extraArgs) {
	var client = callingMenu.client;

	client.user.authenticate(formData.value.username, formData.value.password, function authenticated(err) {
		if(err) {
			client.log.info( { username : formData.value.username }, 'Failed login attempt %s', err);

			client.gotoMenuModule( { name : callingMenu.menuConfig.fallback } );
		} else {
			var now		= new Date();
			var user	= callingMenu.client.user;

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
	var client = callingMenu.client;

	//	:TODO: record this.

	setTimeout(function timeout() {
		client.term.write(ansi.normal() + '\nATH0\n');
		client.end();
	}, 500);
}