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

//	:TODO: prev/nextConf, prev/nextArea should use a NYI MenuModule.redraw() or such -- avoid pop/goto() hack!
function reloadMenu(menu) {
	const prevMenu = menu.client.menuStack.pop();
	prevMenu.instance.leave();
	menu.client.menuStack.goto(prevMenu.name);
}

function prevConf(callingMenu) {
	const confs		= messageArea.getSortedAvailMessageConferences(callingMenu.client);
	const currIndex = confs.findIndex( e => e.confTag === callingMenu.client.user.properties.message_conf_tag) || confs.length;

	messageArea.changeMessageConference(callingMenu.client, confs[currIndex - 1].confTag, err => {
		if(err) {
			return;	//	logged within changeMessageConference() 
		}

		reloadMenu(callingMenu);
	});
}

function nextConf(callingMenu) {
	const confs		= messageArea.getSortedAvailMessageConferences(callingMenu.client);
	let currIndex	= confs.findIndex( e => e.confTag === callingMenu.client.user.properties.message_conf_tag);

	if(currIndex === confs.length - 1) {
		currIndex = -1;
	}

	messageArea.changeMessageConference(callingMenu.client, confs[currIndex + 1].confTag, err => {
		if(err) {
			return;	//	logged within changeMessageConference()
		}
		
		reloadMenu(callingMenu);
	});
}

function prevArea(callingMenu) {
	const areas		= messageArea.getSortedAvailMessageAreasByConfTag(callingMenu.client.user.properties.message_conf_tag);
	const currIndex = areas.findIndex( e => e.areaTag === callingMenu.client.user.properties.message_area_tag) || areas.length;

	messageArea.changeMessageArea(callingMenu.client, areas[currIndex - 1].areaTag, err => {
		if(err) {
			return;	//	logged within changeMessageArea()
		}
		
		reloadMenu(callingMenu);
	});
}

function nextArea(callingMenu) {
	const areas		= messageArea.getSortedAvailMessageAreasByConfTag(callingMenu.client.user.properties.message_conf_tag);
	let currIndex	= areas.findIndex( e => e.areaTag === callingMenu.client.user.properties.message_area_tag);

	if(currIndex === areas.length - 1) {
		currIndex = -1;
	}

	messageArea.changeMessageArea(callingMenu.client, areas[currIndex + 1].areaTag, err => {
		if(err) {
			return;	//	logged within changeMessageArea()
		}

		reloadMenu(callingMenu);
	});
}
