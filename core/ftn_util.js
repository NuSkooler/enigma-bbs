/* jslint node: true */
'use strict';

var Config			= require('./config.js').config;


var _				= require('lodash');
var assert			= require('assert');
var binary			= require('binary');
var fs				= require('fs');
var util			= require('util');
var iconv			= require('iconv-lite');
var moment			= require('moment');

//	:TODO: Remove "Ftn" from most of these -- it's implied in the module
exports.stringFromFTN			= stringFromFTN;
exports.stringToNullPaddedBuffer	= stringToNullPaddedBuffer;
exports.getFormattedFTNAddress	= getFormattedFTNAddress;
exports.getDateFromFtnDateTime	= getDateFromFtnDateTime;
exports.getDateTimeString		= getDateTimeString;

exports.getQuotePrefix			= getQuotePrefix;

//	See list here: https://github.com/Mithgol/node-fidonet-jam

//	:TODO: proably move this elsewhere as a general method
function stringFromFTN(buf, encoding) {
	var nullPos = buf.length;
	for(var i = 0; i < buf.length; ++i) {
		if(0x00 === buf[i]) {
			nullPos = i;
			break;
		}
	}

	return iconv.decode(buf.slice(0, nullPos), encoding || 'utf-8');
}

function stringToNullPaddedBuffer(s, bufLen) {	
	let buffer 	= new Buffer(bufLen).fill(0x00);
	let enc		= iconv.encode(s, 'CP437').slice(0, bufLen);
	for(let i = 0; i < enc.length; ++i) {
		buffer[i] = enc[i];
	}
	return buffer;
}

//
//	Convert a FTN style DateTime string to a Date object
//	
function getDateFromFtnDateTime(dateTime) {
	//
	//	Examples seen in the wild (Working):
	//		"12 Sep 88 18:17:59"
	//		"Tue 01 Jan 80 00:00"
	//		"27 Feb 15  00:00:03"
	//
	//	:TODO: Use moment.js here
	return (new Date(Date.parse(dateTime))).toISOString();
}

function getDateTimeString(m) {
	//
	//	From http://ftsc.org/docs/fts-0001.016:
	//	DateTime   = (* a character string 20 characters long *)
	//                             (* 01 Jan 86  02:34:56 *)
	//           DayOfMonth " " Month " " Year " "
	//           " " HH ":" MM ":" SS
	//           Null
	//
	//	DayOfMonth = "01" | "02" | "03" | ... | "31"   (* Fido 0 fills *)
	//	Month      = "Jan" | "Feb" | "Mar" | "Apr" | "May" | "Jun" |
	//	           "Jul" | "Aug" | "Sep" | "Oct" | "Nov" | "Dec"
	//	Year       = "01" | "02" | .. | "85" | "86" | ... | "99" | "00"
	//	HH         = "00" | .. | "23"
	//	MM         = "00" | .. | "59"
	//	SS         = "00" | .. | "59"
	//
	if(!moment.isMoment(m)) {
		m = moment(m);
	}

	return m.format('DD MMM YY  HH:mm:ss');
}

function getFormattedFTNAddress(address, dimensions) {
	//var addr = util.format('%d:%d', address.zone, address.net);
	var addr = '{0}:{1}'.format(address.zone, address.net);
	switch(dimensions) {
		case 2 :
		case '2D' :
			//	above
			break;

		case 3 :
		case '3D' :
			addr += '/{0}'.format(address.node);
			break;

		case 4 :
		case '4D':
			addr += '.{0}'.format(address.point || 0);		//	missing and 0 are equiv for point
			break;

		case 5 :
		case '5D' :
			if(address.domain) {
				addr += '@{0}'.format(address.domain);
			}
			break;
	}

	return addr;
}

function getFtnMessageSerialNumber(messageId) {
    return ((Math.floor((Date.now() - Date.UTC(2015, 1, 1)) / 1000) + messageId)).toString(16);
}

function getFTNMessageID(messageId, areaId) {
    return messageId + '.' + areaId + '@' + getFTNAddress() + ' ' + getFTNMessageSerialNumber(messageId)
}

//	Get a FSC-0032 style quote prefixes
function getQuotePrefix(name) {
	//	:TODO: Add support for real names (e.g. with spaces) -> initials
	return ' ' + name[0].toUpperCase() + name[1].toLowerCase() + '> ';
}


//
//	Specs:
//	* http://ftsc.org/docs/fts-0009.001
//	* 
//	
function getFtnMsgIdKludgeLine(origAddress, messageId) {
	if(_.isObject(origAddress)) {
		origAddress = getFormattedFTNAddress(origAddress, '5D');
	}

	return '\x01MSGID: ' + origAddress + ' ' + getFtnMessageSerialNumber(messageId);
}


function getFTNOriginLine() {
	//
	//	Specs:
	//	http://ftsc.org/docs/fts-0004.001
	//
	return '  * Origin: ' + Config.general.boardName + '(' + getFidoNetAddress() + ')';
}
