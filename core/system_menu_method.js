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
exports.prevMenu		= prevMenu;

function login(callingMenu, formData, extraArgs) {
	var client = callingMenu.client;

	userLogin(callingMenu.client, formData.value.username, formData.value.password, function authResult(err) {
		if(err) {
			//	login failure
			if(err.existingConn && _.has(callingMenu, 'menuConfig.config.tooNodeMenu')) {
				callingMenu.gotoMenu(callingMenu.menuConfig.config.tooNodeMenu);
			} else {
				//	Other error
				callingMenu.prevMenu();
			}

		} else {
			//	success!
			callingMenu.nextMenu();
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

function prevMenu(callingMenu, formData, extraArgs) {
	callingMenu.prevMenu(function result(err) {
		if(err) {
			callingMenu.client.log.error( { error : err.toString() }, 'Error attempting to fallback!');
		}
	});
}
