/* jslint node: true */
'use strict';

//	ENiGMA½
const logger			= require('./logger.js');
const events            = require('./events.js');

//	deps
const _					= require('lodash');
const moment			= require('moment');

exports.getActiveConnections	= getActiveConnections;
exports.getActiveNodeList		= getActiveNodeList;
exports.addNewClient			= addNewClient;
exports.removeClient			= removeClient;
exports.getConnectionByUserId	= getConnectionByUserId;

const clientConnections = [];
exports.clientConnections		= clientConnections;

function getActiveConnections() { return clientConnections; }

function getActiveNodeList(authUsersOnly) {

	if(!_.isBoolean(authUsersOnly)) {
		authUsersOnly = true;
	}

	const now = moment();

	const activeConnections = getActiveConnections().filter(ac => {
		return ((authUsersOnly && ac.user.isAuthenticated()) || !authUsersOnly);
	});

	return _.map(activeConnections, ac => {
		const entry = {
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
	const id			= client.session.id		= clientConnections.push(client) - 1;
	const remoteAddress = client.remoteAddress	= clientSock.remoteAddress;

	//	Create a client specific logger
	//	Note that this will be updated @ login with additional information
	client.log = logger.log.child( { clientId : id } );

	const connInfo = {
		remoteAddress	: remoteAddress,
		serverName		: client.session.serverName,
		isSecure		: client.session.isSecure,
	};

	if(client.log.debug()) {
		connInfo.port		= clientSock.localPort;
		connInfo.family		= clientSock.localFamily;
	}

	client.log.info(connInfo, 'Client connected');

	events.emit('codes.l33t.enigma.system.connected', {'client': client});

	return id;
}

function removeClient(client) {
	client.end();

	const i = clientConnections.indexOf(client);
	if(i > -1) {
		clientConnections.splice(i, 1);

		logger.log.info(
			{
				connectionCount	: clientConnections.length,
				clientId		: client.session.id
			},
			'Client disconnected'
			);

		events.emit('codes.l33t.enigma.system.disconnected', {'client': client});
	}
}

function getConnectionByUserId(userId) {
	return getActiveConnections().find( ac => userId === ac.user.userId );
}
