/* jslint node: true */
'use strict';

var Config			= require('./config.js').config;


var _				= require('lodash');
var assert			= require('assert');
var binary			= require('binary');
var fs				= require('fs');
var util			= require('util');

exports.stringFromFTN			= stringFromFTN;
exports.getFormattedFTNAddress	= getFormattedFTNAddress;


function stringFromFTN(buf, encoding) {
	var nullPos = buf.length;
	for(var i = 0; i < buf.length; ++i) {
		if(0x00 === buf[i]) {
			nullPos = i;
			break;
		}
	}

	return buf.slice(0, nullPos).toString(encoding || 'utf-8');
}

function getFormattedFTNAddress3D(zone, net, node) {
	return util.format('%d:%d/%d', zone, net, node);
}

function getFormattedFTNAddress4D(zone, net, node, point) {
	return util.format('%d:%d/%d.%d', zone, net, node, point);
}

function getFormattedFTNAddress5D(zone, net, node, point, domain) {
	//	:TODO:
}

function getFormattedFTNAddress(address, dimensions) {
	var addr = util.format('%d:%d', address.zone, address.net);
	switch(dimensions) {
		case 2 :
		case '2D' :
			//	above
			break;

		case 3 :
		case '3D' :
			addr += util.format('/%d', address.node);
			break;

		case 4 :
		case '4D':
			addr += util.format('.%d', address.point || 0);	//	missing and 0 are equiv for point
			break;

		case 5 :
		case '5D' :
			if(address.domain) {
				addr += util.format('@%s', address.domain);
			}
			break;
	}

	return addr;
}

function getFTNMessageSerialNumber(messageId) {
    return ((Math.floor((Date.now() - Date.UTC(2015, 1, 1)) / 1000) + messageId)).toString(16);
}

function getFTNMessageID(messageId, areaId) {
    return messageId + '.' + areaId + '@' + getFTNAddress() + ' ' + getFTNMessageSerialNumber(messageId)
}

function getFTNOriginLine() {
	//
	//	Specs:
	//	http://ftsc.org/docs/fts-0004.001
	//
	return '  * Origin: ' + Config.general.boardName + '(' + getFidoNetAddress() + ')';
}
