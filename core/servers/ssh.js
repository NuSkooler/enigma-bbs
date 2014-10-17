"use strict";

var libssh		= require('ssh');
var conf		= require('../config.js');

/*
	Notes on getting libssh to work. This will ultimately require some contribs back
	* Can't install without --nodedir= as had to upgrade node on the box for other reasons
	* From ssh dir, node-gyp --nodedir=... configure build
	* nan is out of date and doesn't work with existing node. Had to update. ( was "~0.6.0") (npm update after this)
	* 
*/

exports.moduleInfo = {
	name	: 'SSH',
	desc	: 'SSH Server',
	author	: 'NuSkooler'	
};

function createServer() {
	var server = libssh.createServer(
		conf.config.servers.ssh.rsaPrivateKey,
		conf.config.servers.ssh.dsaPrivateKey);

	server.on('connection', function onConnection(session) {
		console.log('ermergerd')
	});

	return server;
}