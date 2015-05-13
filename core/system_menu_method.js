/* jslint node: true */
'use strict';

var theme			= require('../core/theme.js');
var Log				= require('../core/logger.js').log;
var ansi			= require('../core/ansi_term.js');

var async			= require('async');

exports.login		= login;
exports.logoff		= logoff;

function login(callingMenu, formData, extraArgs) {
	var client = callingMenu.client;

	client.user.authenticate(formData.value.username, formData.value.password, function authenticated(err) {
		if(err) {
			Log.info( { username : formData.value.username }, 'Failed login attempt %s', err);

			client.gotoMenuModule( { name : callingMenu.menuConfig.fallback } );
		} else {
			//	use client.user so we can get correct case
			Log.info( { username : callingMenu.client.user.username }, 'Successful login');

			async.parallel(
				[
					function loadThemeConfig(callback) {
						theme.loadTheme(client.user.properties.theme_id, function themeLoaded(err, theme) {
							client.currentTheme = theme;
							callback(null);	//	always non-fatal
						});
					}
				],
				function complete(err, results) {
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