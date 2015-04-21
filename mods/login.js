/* jslint node: true */
'use strict';

var theme			= require('../core/theme.js');
var Log				= require('../core/logger.js').log;

var async			= require('async');

exports.login	= login;

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
						theme.getThemeInfo(client.user.properties.theme_id, function themeInfo(err, info) {
							client.currentThemeInfo = info;
							callback(null);
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
