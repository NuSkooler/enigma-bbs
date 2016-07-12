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
	let prev_tag = confs[confs.length - 1].confTag;
	for (var i=0;i<confs.length;i++) {
		if (confs[i].confTag === callingMenu.client.user.properties.message_conf_tag) {
			messageArea.changeMessageConference(callingMenu.client, prev_tag, err => {
				if (err) {
					//...
				}
				return;
			});
			return;
		} else {
			prev_tag = confs[i].confTag;
		}
	}
}

function nextConf(callingMenu) {
	const confs = messageArea.getSortedAvailMessageConferences(callingMenu.client);
	let prev_tag = confs[0].confTag;

	if (confs.length > 1) {
		for (var i=1;i<confs.length;i++) {
			if (prev_tag.confTag === callingMenu.client.user.properties.message_conf_tag) {
				messageArea.changeMessageConference(callingMenu.client, confs[i].confTag, err => {
					if (err) {
						//...
					}
					return;
				});
				return;
			} else {
				prev_tag = confs[i].confTag;
			}
		}
		messageArea.changeMessageConference(callingMenu.client, confs[0].confTag, err => {
			if (err) {
				//...
			}
			return;
		});
	}
}

function prevArea(callingMenu) {
	const areas = messageArea.getSortedAvailMessageAreasByConfTag(callingMenu.client.user.properties.message_conf_tag);
	let prev_tag = areas[areas.length - 1].areaTag;
	for (var i=0;i<areas.length;i++) {
		if (areas[i].areaTag === callingMenu.client.user.properties.message_area_tag) {
			messageArea.changeMessageArea(callingMenu.client, prev_tag, err => {
				if (err) {
					//...
				}
				return;
			});
			return;
		} else {
			prev_tag = areas[i].confTag;
		}
	}
}

function nextArea(callingMenu) {
	const areas = messageArea.getSortedAvailMessageAreasByConfTag(callingMenu.client.user.properties.message_conf_tag);
	let prev_tag = areas[0].areaTag;

	if (areas.length > 1) {
		for (var i=1;i<areas.length;i++) {
			if (prev_tag.areaTag === callingMenu.client.user.properties.message_area_tag) {
				messageArea.changeMessageArea(callingMenu.client, areas[i].areaTag, err => {
					if (err) {
						//...
					}
					return;
				});
				return;
			} else {
				prev_tag = areas[i].confTag;
			}
		}
		messageArea.changeMessageArea(callingMenu.client, areas[0].areaTag, err => {
			if (err) {
				//...
			}
			return;
		});
	}
}
