/* jslint node: true */
'use strict';

var theme				= require('./theme.js');
var clientConnections	= require('./client_connections.js').clientConnections;
var ansi				= require('./ansi_term.js');
var userDb				= require('./database.js').dbs.user;
var sysProp				= require('./system_property.js');
var userLogin			= require('./user_login.js').userLogin;

var async				= require('async');
var _					= require('lodash');
var iconv				= require('iconv-lite');

exports.login			= login;
exports.logoff			= logoff;
exports.fallbackMenu	= fallbackMenu;

function login(callingMenu, formData, extraArgs) {
	var client = callingMenu.client;

	userLogin(callingMenu.client, formData.value.username, formData.value.password, function authResult(err) {
		if(err) {
			//	login failure
			if(err.existingConn) {
				client.term.rawWrite(ansi.resetScreen());

				var artOpts = {
					client 		: client,
					font		: _.has(callingMenu, 'menuConfig.config.tooNode.font') ? callingMenu.menuConfig.config.tooNode.font : null,
					name		: _.has(callingMenu, 'menuConfig.config.tooNode.art') ? callingMenu.menuConfig.config.tooNode.art : 'TOONODE',
				};

				theme.displayThemeArt(artOpts, function artDisplayed(err) {
					if(err) {
						client.term.write('\nA user by that name is already logged in.\n');		
					}

					setTimeout(function timeout() {
						client.fallbackMenuModule();
					}, 2000);
				});

				return;
			} else {
				//	Other error
				client.fallbackMenuModule();
			}

		} else {
			//	success!
			client.gotoMenuModule( { name : callingMenu.menuConfig.next } );
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
			iconv.decode(require('crypto').randomBytes(Math.floor(Math.random() * 65) + 20), client.term.outputEncoding) + 
			'NO CARRIER');

		client.end();
	}, 500);
}

function fallbackMenu(callingMenu, formData, extraArgs) {
	callingMenu.client.fallbackMenuModule( { extraArgs : extraArgs }, function result(err) {
		if(err) {
			callingMenu.client.log.error( { error : err }, 'Error attempting to fallback!');
		}
	});
}
