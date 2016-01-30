/* jslint node: true */
'use strict';

var logger						= require('./logger.js');

var _							= require('lodash');
var moment						= require('moment');

exports.getActiveConnections	= getActiveConnections;
exports.getActiveNodeList		= getActiveNodeList;
exports.addNewClient			= addNewClient;
exports.removeClient			= removeClient;

var clientConnections = [];
exports.clientConnections		= clientConnections;

function getActiveConnections() {
	return clientConnections;
}

function getActiveNodeList() {
	const now = moment();
	
	return _.map(getActiveConnections(), ac => {
		let entry = {
			node			: ac.node,
			authenticated	: ac.user.isAuthenticated(),
			userId			: ac.user.userId,
			action			: _.has(ac, 'currentMenuModule.menuConfig.desc') ? ac.currentMenuModule.menuConfig.desc : 'Unknown',
		};

		//
		//	There may be a connection, but not a logged in user as of yet
		//		
		if(ac.user.isAuthenticated()) {
			entry.userName	= ac.user.username;
			entry.realName	= ac.user.properties.real_name;
			entry.location	= ac.user.properties.location;
			entry.affils	= ac.user.properties.affiliation;

			const diff 		= now.diff(moment(ac.user.properties.last_login_timestamp), 'minutes');
			entry.timeOn	= moment.duration(diff, 'minutes');			
		}
		return entry;
	});
}

function addNewClient(client, clientSock) {
	var id = client.session.id = clientConnections.push(client) - 1;

	//	Create a client specific logger 
	//	Note that this will be updated @ login with additional information
	client.log = logger.log.child( { clientId : id } );

	var connInfo = {
		ip			: clientSock.remoteAddress,
		serverName	: client.session.serverName,
		isSecure	: client.session.isSecure,
	};

	if(client.log.debug()) {
		connInfo.port		= clientSock.localPort;
		connInfo.family		= clientSock.localFamily;
	}

	client.log.info(connInfo, 'Client connected');

	return id;
}

function removeClient(client) {
	client.end();

	var i = clientConnections.indexOf(client);
	if(i > -1) {
		clientConnections.splice(i, 1);
		
		logger.log.info(
			{ 
				connectionCount	: clientConnections.length,
				clientId		: client.session.id 
			}, 
			'Client disconnected'
			);
	}
}

/* :TODO: make a public API elsewhere
function getActiveClientInformation() {
	var info = {};

	clientConnections.forEach(function connEntry(cc) {

	});

	return info;
}
*/