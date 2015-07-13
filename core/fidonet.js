/* jslint node: true */
'use strict';

var Config			= require('./config.js').config;


var _				= require('lodash');
var assert			= require('assert');
var binary			= require('binary');

function getFTNAddress = function() {
	return 'TODO';
}


function getFTNMessageSerialNumber(messageId) {
    return ((Math.floor((Date.now() - Date.UTC(2015, 01, 01)) / 1000) + messageId)).toString(16);
}

function getFTNMessageID(messageId, areaId) {
    return messageId + '.' + areaId + '@' + getFTNAddress() + ' ' + getFTNMessageSerialNumber(messageId)
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
//	https://github.com/M-griffin/PyPacketMail/blob/master/PyPacketMail.py
//
function extractMessageFromFTNPacketBuffer(options, cb) {
	//	options.networkAddress
	//	options.packetBuffer
	assert(_.isBuffer(options.packetBuffer));

	//	:TODO: check size
	//	:TODO: big/little endian?
	binary.parse(options.packetBuffer)
		.word16('origNode')
		.word16('destNode')
		.word16('year')
		.word16('month')
		.word16('day')
		.word16('hour')
		.word16('minute')
		.word16('second')
		.word16('baud')
		.word16('packetType')
		.word16('originNet')
		.word16('destNet')
		.word8('prodCodeLo')
		.word8('revisionMajor')	//	aka serialNo
		.buffer('password', 8)
		.word16('origZone')
		.word16('destZone')
		//	where is the rest of the spec?
		.word16('auxNet')
		.word16('capWordA')
		.word8('prodCodeHi')
		.word8('revisionMinor')
		.word16('capWordB')
		.word16('originZone2')
		.word16('destZone2')
		.word16('originPoint')
		.word16('destPoint')
		.word32u('prodData')
		.tap(function tapped(vars) {

		}
	);
}

function extractMessagesFromFTNPacketFile(options) {
	//
	//	options.path
	//	options.networkAddress
	//	

}