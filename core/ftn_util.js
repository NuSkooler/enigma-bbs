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
var createHash		= require('crypto').createHash;
var uuid			= require('node-uuid');
var os				= require('os');

var packageJson 	= require('../package.json');

//	:TODO: Remove "Ftn" from most of these -- it's implied in the module
exports.stringFromFTN			= stringFromFTN;
exports.stringToNullPaddedBuffer	= stringToNullPaddedBuffer;
exports.createMessageUuid			= createMessageUuid;
exports.parseAddress			= parseAddress;
exports.formatAddress			= formatAddress;
exports.getDateFromFtnDateTime	= getDateFromFtnDateTime;
exports.getDateTimeString		= getDateTimeString;

exports.getMessageIdentifier	= getMessageIdentifier;
exports.getProductIdentifier	= getProductIdentifier;
exports.getUTCTimeZoneOffset	= getUTCTimeZoneOffset;
exports.getOrigin				= getOrigin;

exports.getQuotePrefix			= getQuotePrefix;

//
//	Namespace for RFC-4122 name based UUIDs generated from
//	FTN kludges MSGID + AREA
//
const ENIGMA_FTN_MSGID_NAMESPACE 	= uuid.parse('a5c7ae11-420c-4469-a116-0e9a6d8d2654');

//	Up to 5D FTN address RegExp
const ENIGMA_FTN_ADDRESS_REGEXP		= /^([0-9]+):([0-9]+)(\/[0-9]+)?(\.[0-9]+)?(@[a-z0-9\-\.]+)?$/i;

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
//	:TODO: Name the next couple methods better - for FTN *packets*
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
	//  	(* 01 Jan 86  02:34:56 *)
	//		DayOfMonth " " Month " " Year " "
	//		" " HH ":" MM ":" SS
	//		Null
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

function createMessageUuid(ftnMsgId, ftnArea) {
	//
	//	v5 UUID generation code based on the work here:
	//	https://github.com/download13/uuidv5/blob/master/uuid.js
	//
	//	Note: CrashMail uses MSGID + AREA, so we go with that as well:
	//	https://github.com/larsks/crashmail/blob/master/crashmail/dupe.c
	//
	if(!Buffer.isBuffer(ftnMsgId)) {
		ftnMsgId = iconv.encode(ftnMsgId, 'CP437');
	}

	ftnArea = ftnArea || '';	//	AREA is optional
	if(!Buffer.isBuffer(ftnArea)) {
		ftnArea = iconv.encode(ftnArea, 'CP437');
	}
	
	const ns = new Buffer(ENIGMA_FTN_MSGID_NAMESPACE);

	let digest = createHash('sha1').update(
		Buffer.concat([ ns, ftnMsgId, ftnArea ])).digest();

	let u = new Buffer(16);

	// bbbb - bb - bb - bb - bbbbbb
	digest.copy(u, 0, 0, 4);			// time_low
	digest.copy(u, 4, 4, 6);			// time_mid
	digest.copy(u, 6, 6, 8);			// time_hi_and_version

	u[6] = (u[6] & 0x0f) | 0x50;		// version, 4 most significant bits are set to version 5 (0101)
	u[8] = (digest[8] & 0x3f) | 0x80;	// clock_seq_hi_and_reserved, 2msb are set to 10
	u[9] = digest[9];
	
	digest.copy(u, 10, 10, 16);

	return uuid.unparse(u);	//	to string
}

function parseAddress(address) {
	const m = ENIGMA_FTN_ADDRESS_REGEXP.exec(address);
	
	if(m) {
		let addr = {
			zone	: parseInt(m[1]),
			net		: parseInt(m[2]),
		};
		
		//
		//	substr(1) on the following to remove the
		//	captured prefix
		//
		if(m[3]) {
			addr.node = parseInt(m[3].substr(1));
		}

		if(m[4]) {
			addr.point = parseInt(m[4].substr(1));
		}

		if(m[5]) {
			addr.domain = m[5].substr(1);
		}

		return addr;
	}	
}

function formatAddress(address, dimensions) {
	let addr = `${address.zone}:${address.net}`;

	//	allow for e.g. '4D' or 5 
	const dim = parseInt(dimensions.toString()[0]);

	if(dim >= 3) {
		addr += `/${address.node}`;
	}

	//	missing & .0 are equiv for point
	if(dim >= 4 && address.point) {
		addr += `.${addresss.point}`;
	}

	if(5 === dim && address.domain) {
		addr += `@${address.domain.toLowerCase()}`;
	}

	return addr;
}

function getMessageSerialNumber(message) {
    return ('00000000' + ((Math.floor((Date.now() - Date.UTC(2016, 1, 1)) / 1000) + 
    	message.messageId)).toString(16)).substr(-8);
}

//
//	Return a FTS-0009.001 compliant MSGID value given a message
//	See http://ftsc.org/docs/fts-0009.001
//	
//	"A MSGID line consists of the string "^AMSGID:" (where ^A is a
//	control-A (hex 01) and the double-quotes are not part of the
//	string),  followed by a space,  the address of the originating
//	system,  and a serial number unique to that message on the
//	originating system,  i.e.:
//
//		^AMSGID: origaddr serialno
//
//	The originating address should be specified in a form that
//	constitutes a valid return address for the originating network.   
//	If the originating address is enclosed in double-quotes,  the
//	entire string between the beginning and ending double-quotes is 
//	considered to be the orginating address.  A double-quote character
//	within a quoted address is represented by by two consecutive
//	double-quote characters.  The serial number may be any eight
//	character hexadecimal number,  as long as it is unique - no two
//	messages from a given system may have the same serial number
//	within a three years.  The manner in which this serial number is
//	generated is left to the implementor."
//	
//
//	Examples & Implementations
//
//	Synchronet: <msgNum>.<conf+area>@<ftnAddr> <serial>
//		2606.agora-agn_tst@46:1/142 19609217
//		
//	Mystic: <ftnAddress> <serial>
//		46:3/102 46686263
//
//	ENiGMA½: <messageId>.<areaTag>@<5dFtnAddress> <serial>
//
function getMessageIdentifier(message, address) {
	return `${message.messageId}.${message.areaTag.toLowerCase()}@${formatAddress(address, '5D')} ${getMessageSerialNumber(message)}`;
}

//
//	Return a FSC-0046.005 Product Identifier or "PID"
//	http://ftsc.org/docs/fsc-0046.005
//
function getProductIdentifier() {
	const version = packageJson.version
		.replace(/\-/g, '.')
		.replace(/alpha/,'a')
		.replace(/beta/,'b');

	const nodeVer = process.version.substr(1);	//	remove 'v' prefix

	return `ENiGMA1/2 ${version} (${os.platform()}; ${os.arch()}; ${nodeVer})`;
}

//
//	Return a FSC-0030.001 compliant (http://ftsc.org/docs/fsc-0030.001) MESSAGE-ID
//
//	<unique-part@domain-name>
//	
//	:TODO: not implemented to spec at all yet :)
function getFTNMessageID(messageId, areaId) {
    return messageId + '.' + areaId + '@' + getFTNAddress() + ' ' + getMessageSerialNumber(messageId)
}

//
//	Return a FRL-1004 style time zone offset for a 
//	'TZUTC' kludge line
//
//	http://ftsc.org/docs/frl-1004.002
//
function getUTCTimeZoneOffset() {
	return moment().format('ZZ').replace(/\+/, '');
}

//	Get a FSC-0032 style quote prefixes
function getQuotePrefix(name) {
	//	:TODO: Add support for real names (e.g. with spaces) -> initials
	return ' ' + name[0].toUpperCase() + name[1].toLowerCase() + '> ';
}

//
//	Return a FTS-0004 Origin line
//	http://ftsc.org/docs/fts-0004.001
//
function getOrigin(address) {
	const origin = _.has(Config.messageNetworks.originName) ? 
		Config.messageNetworks.originName : 
		Config.general.boardName;

	return `  * Origin: ${origin} (${formatAddress(address, '5D')})`;
}
