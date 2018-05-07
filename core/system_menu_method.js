/* jslint node: true */
'use strict';

//	ENiGMA½
const removeClient		= require('./client_connections.js').removeClient;
const ansiNormal		= require('./ansi_term.js').normal;
const userLogin			= require('./user_login.js').userLogin;
const messageArea		= require('./message_area.js');

//	deps
const _					= require('lodash');
const iconv				= require('iconv-lite');

exports.login					= login;
exports.logoff					= logoff;
exports.prevMenu				= prevMenu;
exports.nextMenu				= nextMenu;
exports.prevConf				= prevConf;
exports.nextConf				= nextConf;
exports.prevArea				= prevArea;
exports.nextArea				= nextArea;
exports.sendForgotPasswordEmail	= sendForgotPasswordEmail;

function login(callingMenu, formData, extraArgs, cb) {

	userLogin(callingMenu.client, formData.value.username, formData.value.password, err => {
		if(err) {
			//	login failure
			if(err.existingConn && _.has(callingMenu, 'menuConfig.config.tooNodeMenu')) {
				return callingMenu.gotoMenu(callingMenu.menuConfig.config.tooNodeMenu, cb);
			} else {
				//	Other error
				return callingMenu.prevMenu(cb);
			}
		}

		//	success!
		return callingMenu.nextMenu(cb);
	});
}

function logoff(callingMenu, formData, extraArgs, cb) {
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
				removeClient(client);
				return cb(null);
			}
		);
	}, 500);
}

function prevMenu(callingMenu, formData, extraArgs, cb) {

	//	:TODO: this is a pretty big hack -- need the whole key map concep there like other places
	if(formData.key && 'return' === formData.key.name) {
		callingMenu.submitFormData = formData;
	}

	callingMenu.prevMenu( err => {
		if(err) {
			callingMenu.client.log.error( { error : err.message }, 'Error attempting to fallback!');
		}
		return cb(err);
	});
}

function nextMenu(callingMenu, formData, extraArgs, cb) {
	callingMenu.nextMenu( err => {
		if(err) {
			callingMenu.client.log.error( { error : err.message}, 'Error attempting to go to next menu!');
		}
		return cb(err);
	});
}

//	:TODO: prev/nextConf, prev/nextArea should use a NYI MenuModule.redraw() or such -- avoid pop/goto() hack!
function reloadMenu(menu, cb) {
	const prevMenu = menu.client.menuStack.pop();
	prevMenu.instance.leave();
	menu.client.menuStack.goto(prevMenu.name, cb);
}

function prevConf(callingMenu, formData, extraArgs, cb) {
	const confs		= messageArea.getSortedAvailMessageConferences(callingMenu.client);
	const currIndex = confs.findIndex( e => e.confTag === callingMenu.client.user.properties.message_conf_tag) || confs.length;

	messageArea.changeMessageConference(callingMenu.client, confs[currIndex - 1].confTag, err => {
		if(err) {
			return cb(err);	//	logged within changeMessageConference()
		}

		return reloadMenu(callingMenu, cb);
	});
}

function nextConf(callingMenu, formData, extraArgs, cb) {
	const confs		= messageArea.getSortedAvailMessageConferences(callingMenu.client);
	let currIndex	= confs.findIndex( e => e.confTag === callingMenu.client.user.properties.message_conf_tag);

	if(currIndex === confs.length - 1) {
		currIndex = -1;
	}

	messageArea.changeMessageConference(callingMenu.client, confs[currIndex + 1].confTag, err => {
		if(err) {
			return cb(err);	//	logged within changeMessageConference()
		}

		return reloadMenu(callingMenu, cb);
	});
}

function prevArea(callingMenu, formData, extraArgs, cb) {
	const areas		= messageArea.getSortedAvailMessageAreasByConfTag(callingMenu.client.user.properties.message_conf_tag);
	const currIndex = areas.findIndex( e => e.areaTag === callingMenu.client.user.properties.message_area_tag) || areas.length;

	messageArea.changeMessageArea(callingMenu.client, areas[currIndex - 1].areaTag, err => {
		if(err) {
			return cb(err);	//	logged within changeMessageArea()
		}

		return reloadMenu(callingMenu, cb);
	});
}

function nextArea(callingMenu, formData, extraArgs, cb) {
	const areas		= messageArea.getSortedAvailMessageAreasByConfTag(callingMenu.client.user.properties.message_conf_tag);
	let currIndex	= areas.findIndex( e => e.areaTag === callingMenu.client.user.properties.message_area_tag);

	if(currIndex === areas.length - 1) {
		currIndex = -1;
	}

	messageArea.changeMessageArea(callingMenu.client, areas[currIndex + 1].areaTag, err => {
		if(err) {
			return cb(err);	//	logged within changeMessageArea()
		}

		return reloadMenu(callingMenu, cb);
	});
}

function sendForgotPasswordEmail(callingMenu, formData, extraArgs, cb) {
	const username = formData.value.username || callingMenu.client.user.username;

	const WebPasswordReset = require('./web_password_reset.js').WebPasswordReset;

	WebPasswordReset.sendForgotPasswordEmail(username, err => {
		if(err) {
			callingMenu.client.log.warn( { err : err.message }, 'Failed sending forgot password email');
		}

		if(extraArgs.next) {
			return callingMenu.gotoMenu(extraArgs.next, cb);
		}

		return logoff(callingMenu, formData, extraArgs, cb);
	});
}
