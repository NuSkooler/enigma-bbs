/* jslint node: true */
'use strict';

var logger						= require('./logger.js');

exports.getActiveConnections	= getActiveConnections;
exports.addNewClient			= addNewClient;
exports.removeClient			= removeClient;

var clientConnections = [];
exports.clientConnections		= clientConnections;

function getActiveConnections() {
	return clientConnections.length;
}

function addNewClient(client) {
	var id = client.session.id = clientConnections.push(client) - 1;

	//	Create a client specific logger 
	client.log = logger.log.child( { clientId : id } );

	var connInfo = { ip : client.input.remoteAddress };

	if(client.log.debug()) {
		connInfo.port		= client.input.localPort;
		connInfo.family		= client.input.localFamily;
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