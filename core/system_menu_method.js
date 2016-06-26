/* jslint node: true */
'use strict';

//	ENiGMA½
const removeClient		= require('./client_connections.js').removeClient;
const ansiNormal		= require('./ansi_term.js').normal;
const userLogin			= require('./user_login.js').userLogin;

//	deps
const _					= require('lodash');
const iconv				= require('iconv-lite');

exports.login			= login;
exports.logoff			= logoff;
exports.prevMenu		= prevMenu;
exports.nextMenu		= nextMenu;

function login(callingMenu, formData) {

	userLogin(callingMenu.client, formData.value.username, formData.value.password, err => {
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

function logoff(callingMenu) {
	//
	//	Simple logoff. Note that recording of @ logoff properties/stats
	//	occurs elsewhere!
	//
	const client = callingMenu.client;

	setTimeout( () => {
		//
		//	For giggles...
		//
		client.term.write(
			ansiNormal() +	'\n' +
			iconv.decode(require('crypto').randomBytes(Math.floor(Math.random() * 65) + 20), client.term.outputEncoding) + 
			'NO CARRIER', null, () => {

				//	after data is written, disconnect & remove the client
				return removeClient(client);
			}
		);
	}, 500);
}

function prevMenu(callingMenu) {
	callingMenu.prevMenu( err => {
		if(err) {
			callingMenu.client.log.error( { error : err.toString() }, 'Error attempting to fallback!');
		}
	});
}

function nextMenu(callingMenu) {
	callingMenu.nextMenu( err => {
		if(err) {
			callingMenu.client.log.error( { error : err.toString() }, 'Error attempting to go to next menu!');
		}
	});
}
