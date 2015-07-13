/* jslint node: true */
'use strict';

var Config			= require('./config.js').config;

function getFTNAddress = function() {
	return 'TODO';
}

function getFTNOriginLine = function() {
	//
	//	Specs:
	//	http://ftsc.org/docs/fts-0004.001
	//
	return '  * Origin: ' + Config.general.boardName + '(' + getFidoNetAddress() + ')';
}

//
//	References
//	https://gist.github.com/M-griffin/65a23b7ea3d7529fd725
//
function extractMessagesFromFTNPacket(options) {
	//
	//	options.path
	//	options.networkAddress
	//	
}