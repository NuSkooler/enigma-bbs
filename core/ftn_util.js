/* jslint node: true */
'use strict';

let Config			= require('./config.js').config;
let Address			= require('./ftn_address.js');
let FNV1a			= require('./fnv1a.js');
let createNamedUUID	= require('./uuid_util.js').createNamedUUID;

let _				= require('lodash');
let assert			= require('assert');
let iconv			= require('iconv-lite');
let moment			= require('moment');
let uuid			= require('node-uuid');
let os				= require('os');

let packageJson 	= require('../package.json');

//	:TODO: Remove "Ftn" from most of these -- it's implied in the module
exports.stringToNullPaddedBuffer	= stringToNullPaddedBuffer;
exports.getMessageSerialNumber		= getMessageSerialNumber;
exports.createMessageUuid			= createMessageUuid;
exports.createMessageUuidAlternate	= createMessageUuidAlternate;
exports.getDateFromFtnDateTime		= getDateFromFtnDateTime;
exports.getDateTimeString			= getDateTimeString;

exports.getMessageIdentifier		= getMessageIdentifier;
exports.getProductIdentifier		= getProductIdentifier;
exports.getUTCTimeZoneOffset		= getUTCTimeZoneOffset;
exports.getOrigin					= getOrigin;
exports.getTearLine					= getTearLine;
exports.getVia						= getVia;
exports.getAbbreviatedNetNodeList	= getAbbreviatedNetNodeList;
exports.parseAbbreviatedNetNodeList	= parseAbbreviatedNetNodeList;
exports.getUpdatedSeenByEntries		= getUpdatedSeenByEntries;
exports.getUpdatedPathEntries		= getUpdatedPathEntries;

exports.getCharacterSetIdentifierByEncoding		= getCharacterSetIdentifierByEncoding;
exports.getEncodingFromCharacterSetIdentifier	= getEncodingFromCharacterSetIdentifier;

exports.getQuotePrefix				= getQuotePrefix;

//
//	Namespace for RFC-4122 name based UUIDs generated from
//	FTN kludges MSGID + AREA
//
const ENIGMA_FTN_MSGID_NAMESPACE 	= uuid.parse('a5c7ae11-420c-4469-a116-0e9a6d8d2654');

//	See list here: https://github.com/Mithgol/node-fidonet-jam

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
	return moment(Date.parse(dateTime));	//	Date.parse() allows funky formats
//	return (new Date(Date.parse(dateTime))).toISOString();
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

//
//	Create a v5 named UUID given a message ID ("MSGID") and
//	FTN area tag ("AREA").
//
//	This is similar to CrashMail
//	See https://github.com/larsks/crashmail/blob/master/crashmail/dupe.c
//
function createMessageUuid(ftnMsgId, ftnArea) {
	assert(_.isString(ftnMsgId));
	assert(_.isString(ftnArea));

	ftnMsgId	= iconv.encode(ftnMsgId, 'CP437');
	ftnArea		= iconv.encode(ftnArea.toUpperCase(), 'CP437');
	
	return uuid.unparse(createNamedUUID(ENIGMA_FTN_MSGID_NAMESPACE, Buffer.concat( [ ftnMsgId, ftnArea ] )));
};

//
//	Create a v5 named UUID given a FTN area tag ("AREA"),
//	create/modified date, subject, and message body
//
//	This method should be used as a backup for when a MSGID is
//	not available in which createMessageUuid() above should be
//	used instead.
//
function createMessageUuidAlternate(ftnArea, modTimestamp, subject, msgBody) {
	assert(_.isString(ftnArea));
	assert(_.isDate(modTimestamp) || moment.isMoment(modTimestamp));
	assert(_.isString(subject));
	assert(_.isString(msgBody));
		
	ftnArea			= iconv.encode(ftnArea.toUpperCase(), 'CP437');
	modTimestamp	= iconv.encode(getDateTimeString(modTimestamp), 'CP437');
	subject			= iconv.encode(subject.toUpperCase().trim(), 'CP437');
	msgBody			= iconv.encode(msgBody.replace(/\r\n|[\n\v\f\r\x85\u2028\u2029]/g, '').trim(), 'CP437');
	
	return uuid.unparse(createNamedUUID(ENIGMA_FTN_MSGID_NAMESPACE, Buffer.concat( [ ftnArea, modTimestamp, subject, msgBody ] )));
}

function getMessageSerialNumber(messageId) {
	const msSinceEnigmaEpoc = (Date.now() - Date.UTC(2016, 1, 1));
	const hash				= Math.abs(new FNV1a(msSinceEnigmaEpoc + messageId).value).toString(16);
	return `00000000${hash}`.substr(-8);
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
	const addrStr = new Address(address).toString('5D');
	return `${message.messageId}.${message.areaTag.toLowerCase()}@${addrStr} ${getMessageSerialNumber(message.messageId)}`;
}

//
//	Return a FSC-0046.005 Product Identifier or "PID"
//	http://ftsc.org/docs/fsc-0046.005
//
//	Note that we use a variant on the spec for <serial>
//	in which (<os>; <arch>; <nodeVer>) is used instead
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
	const origin = _.has(Config, 'messageNetworks.originLine') ? 
		Config.messageNetworks.originLine : 
		Config.general.boardName;

	const addrStr = new Address(address).toString('5D');
	return ` * Origin: ${origin} (${addrStr})`;
}

function getTearLine() {
	const nodeVer = process.version.substr(1);	//	remove 'v' prefix
	return `--- ENiGMA 1/2 v${packageJson.version} (${os.platform()}; ${os.arch()}; ${nodeVer})`;
}

//
//	Return a FRL-1005.001 "Via" line
//	http://ftsc.org/docs/frl-1005.001
//
function getVia(address) {
	/*
		FRL-1005.001 states teh following format:

		^AVia: <FTN Address> @YYYYMMDD.HHMMSS[.Precise][.Time Zone] 
	    <Program Name> <Version> [Serial Number]<CR>
	*/
	const addrStr	= new Address(address).toString('5D');
	const dateTime	= moment().utc().format('YYYYMMDD.HHmmSS.SSSS.UTC');

	const version	= packageJson.version
		.replace(/\-/g, '.')
		.replace(/alpha/,'a')
		.replace(/beta/,'b');

	return `${addrStr} @${dateTime} ENiGMA1/2 ${version}`;
}

function getAbbreviatedNetNodeList(netNodes) {
	let abbrList = '';
	let currNet;
	netNodes.forEach(netNode => {
		if(_.isString(netNode)) {
			netNode = Address.fromString(netNode);
		}
		if(currNet !== netNode.net) {
			abbrList += `${netNode.net}/`;
			currNet = netNode.net;
		}
		abbrList += `${netNode.node} `;
	});

	return abbrList.trim();	//	remove trailing space
}

//
//	Parse an abbreviated net/node list commonly used for SEEN-BY and PATH
//
function parseAbbreviatedNetNodeList(netNodes) {
	const re = /([0-9]+)\/([0-9]+)\s?|([0-9]+)\s?/g;
	let net;
	let m;
	let results = [];	
	while(null !== (m = re.exec(netNodes))) {
		if(m[1] && m[2]) {
			net = parseInt(m[1]);
			results.push(new Address( { net : net, node : parseInt(m[2]) } ));
		} else if(net) {
			results.push(new Address( { net : net, node : parseInt(m[3]) } ));
		}
	}

	return results;
}

//
//	Return a FTS-0004.001 SEEN-BY entry(s) that include
//	all pre-existing SEEN-BY entries with the addition
//	of |additions|. 
//
//	See http://ftsc.org/docs/fts-0004.001
//	and notes at http://ftsc.org/docs/fsc-0043.002.
//
//	For a great write up, see http://www.skepticfiles.org/aj/basics03.htm
//
//	This method returns an sorted array of values, but
//	not the "SEEN-BY" prefix itself
//
function getUpdatedSeenByEntries(existingEntries, additions) {
	/*
		From FTS-0004:

		"There can  be many  seen-by lines  at the  end of Conference
		Mail messages,  and they  are the real "meat" of the control
		information. They  are used  to  determine  the  systems  to
		receive the exported messages. The format of the line is:

		           SEEN-BY: 132/101 113 136/601 1014/1

		The net/node  numbers correspond  to the net/node numbers of
		the systems having already received the message. In this way
		a message  is never  sent to a system twice. In a conference
		with many  participants the  number of  seen-by lines can be
		very large.   This line is added if it is not already a part
		of the  message, or added to if it already exists, each time
		a message  is exported  to other systems. This is a REQUIRED
		field, and  Conference Mail  will not  function correctly if
		this field  is not put in place by other Echomail compatible
		programs."
    */
	existingEntries = existingEntries || [];
	if(!_.isArray(existingEntries)) {
		existingEntries = [ existingEntries ];
	}
	
	if(!_.isString(additions)) {
		additions = parseAbbreviatedNetNodeList(getAbbreviatedNetNodeList(additions)); 
	}

	additions = additions.sort(Address.getComparator());

	//
	//	For now, we'll just append a new SEEN-BY entry
	//
	//	:TODO: we should at least try and update what is already there in a smart way
	existingEntries.push(getAbbreviatedNetNodeList(additions));
	return existingEntries;
}

function getUpdatedPathEntries(existingEntries, localAddress) {
	//	:TODO: append to PATH in a smart way! We shoudl try to fit at least the last existing line

	existingEntries = existingEntries || [];
	if(!_.isArray(existingEntries)) {
		existingEntries = [ existingEntries ];
	}

	existingEntries.push(getAbbreviatedNetNodeList(
		parseAbbreviatedNetNodeList(localAddress)));

	return existingEntries;
}

//
//	Return FTS-5000.001 "CHRS" value
//	http://ftsc.org/docs/fts-5003.001
//
const ENCODING_TO_FTS_5003_001_CHARS = {
	//	level 1 - generally should not be used
	ascii		: [ 'ASCII', 1 ],
	'us-ascii'	: [ 'ASCII', 1 ],
	
	//	level 2 - 8 bit, ASCII based
	cp437		: [ 'CP437', 2 ],
	cp850		: [ 'CP850', 2 ],
	
	//	level 3 - reserved
	
	//	level 4
	utf8		: [ 'UTF-8', 4 ],
	'utf-8'		: [ 'UTF-8', 4 ],
};


function getCharacterSetIdentifierByEncoding(encodingName) {
	const value = ENCODING_TO_FTS_5003_001_CHARS[encodingName.toLowerCase()];
	return value ? `${value[0]} ${value[1]}` : encodingName.toUpperCase();
}

function getEncodingFromCharacterSetIdentifier(chrs) {
	const ident = chrs.split(' ')[0].toUpperCase();
	
	//	:TODO: fill in the rest!!!
	return {
		//	level 1
		'ASCII'		: 'iso-646-1',
		'DUTCH'		: 'iso-646',
		'FINNISH'	: 'iso-646-10',
		'FRENCH'	: 'iso-646',
		'CANADIAN'	: 'iso-646',
		'GERMAN'	: 'iso-646',
		'ITALIAN'	: 'iso-646',
		'NORWEIG'	: 'iso-646',
		'PORTU'		: 'iso-646',
		'SPANISH'	: 'iso-656',
		'SWEDISH'	: 'iso-646-10',
		'SWISS'		: 'iso-646',
		'UK'		: 'iso-646',
		'ISO-10'	: 'iso-646-10',
		
		//	level 2
		'CP437'		: 'cp437',
		'CP850'		: 'cp850',
		'CP852'		: 'cp852',
		'CP866'		: 'cp866',
		'CP848'		: 'cp848',
		'CP1250'	: 'cp1250',
		'CP1251'	: 'cp1251',
		'CP1252'	: 'cp1252',
		'CP10000'	: 'macroman',
		'LATIN-1'	: 'iso-8859-1',
		'LATIN-2'	: 'iso-8859-2',
		'LATIN-5'	: 'iso-8859-9',
		'LATIN-9'	: 'iso-8859-15',
		
		//	level 4
		'UTF-8'		: 'utf8',
		
		//	deprecated stuff
		'IBMPC'		: 'cp1250',		//	:TODO: validate 
		'+7_FIDO'	: 'cp866',
		'+7'		: 'cp866', 
		'MAC'		: 'macroman',	//	:TODO: validate
		
	}[ident];
}