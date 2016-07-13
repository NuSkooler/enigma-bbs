/* jslint node: true */
'use strict';

//	ENiGMA½
const removeClient		= require('./client_connections.js').removeClient;
const ansiNormal		= require('./ansi_term.js').normal;
const userLogin			= require('./user_login.js').userLogin;
const messageArea			= require('./message_area.js');

//	deps
const _					= require('lodash');
const iconv				= require('iconv-lite');

exports.login			= login;
exports.logoff			= logoff;
exports.prevMenu		= prevMenu;
exports.nextMenu		= nextMenu;
exports.prevConf		= prevConf;
exports.nextConf		= nextConf;
exports.prevArea		= prevArea;
exports.nextArea		= nextArea;

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

function prevConf(callingMenu) {
	const confs = messageArea.getSortedAvailMessageConferences(callingMenu.client);

	let curr_idx = confs.findIndex((e) => {
		if (e.confTag === callingMenu.client.user.properties.message_conf_tag) {
			return true;
		}
		return false;
	});

	if (curr_idx === 0) {
		curr_idx = confs.length;
	}
	messageArea.changeMessageConference(callingMenu.client, confs[curr_idx - 1].confTag, err => {
		if (err) {
			//...
		}
		return;
	});
	
	let prevMenu = callingMenu.client.menuStack.pop();
	prevMenu.instance.leave();
	callingMenu.client.menuStack.goto(prevMenu.name);
}

function nextConf(callingMenu) {
	const confs = messageArea.getSortedAvailMessageConferences(callingMenu.client);

	let curr_idx = confs.findIndex((e) => {
		if (e.confTag === callingMenu.client.user.properties.message_conf_tag) {
			return true;
		}
		return false;
	});

	if (curr_idx === confs.length - 1) {
		curr_idx = -1;
	}
	messageArea.changeMessageConference(callingMenu.client, confs[curr_idx + 1].confTag, err => {
		if (err) {
			//...
		}
		return;
	});
	let prevMenu = callingMenu.client.menuStack.pop();
	prevMenu.instance.leave();
	callingMenu.client.menuStack.goto(prevMenu.name);
}

function prevArea(callingMenu) {
	const areas = messageArea.getSortedAvailMessageAreasByConfTag(callingMenu.client.user.properties.message_conf_tag);

	let curr_idx = areas.findIndex((e) => {
		if (e.areaTag === callingMenu.client.user.properties.message_area_tag) {
			return true;
		}
		return false;
	});

	if (curr_idx === 0) {
		curr_idx = areas.length;
	}
	messageArea.changeMessageArea(callingMenu.client, areas[curr_idx - 1].areaTag, err => {
		if (err) {
			//...
		}
		return;
	});

	let prevMenu = callingMenu.client.menuStack.pop();
	prevMenu.instance.leave();
	callingMenu.client.menuStack.goto(prevMenu.name);
}

function nextArea(callingMenu) {
	const areas = messageArea.getSortedAvailMessageAreasByConfTag(callingMenu.client.user.properties.message_conf_tag);

	let curr_idx = areas.findIndex((e) => {
		if (e.areaTag === callingMenu.client.user.properties.message_area_tag) {
			return true;
		}
		return false;
	});

	if (curr_idx === areas.length - 1) {
		curr_idx = -1;
	}
	messageArea.changeMessageArea(callingMenu.client, areas[curr_idx + 1].areaTag, err => {
		if (err) {
			//...
		}
		return;
	});

	let prevMenu = callingMenu.client.menuStack.pop();
	prevMenu.instance.leave();
	callingMenu.client.menuStack.goto(prevMenu.name);
}
