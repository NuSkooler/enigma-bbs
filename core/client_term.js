/* jslint node: true */
'use strict';

//	ENiGMA½
var Log				= require('./logger.js').log;
var enigmaToAnsi	= require('./color_codes.js').enigmaToAnsi;
var renegadeToAnsi	= require('./color_codes.js').renegadeToAnsi;

var iconv			= require('iconv-lite');
var assert			= require('assert');
var _				= require('lodash');

exports.ClientTerminal	= ClientTerminal;

function ClientTerminal(output) {
	this.output		= output;

	var self = this;

	var outputEncoding = 'cp437';
	assert(iconv.encodingExists(outputEncoding));

	//	convert line feeds such as \n -> \r\n
	this.convertLF		= true;

	//
	//	Some terminal we handle specially
	//	They can also be found in this.env{}
	//
	var termType		= 'unknown';
	var termHeight		= 0;
	var termWidth		= 0;
	var termClient		= 'unknown';

	this.currentSyncFont	= 'not_set';

	//	Raw values set by e.g. telnet NAWS, ENVIRONMENT, etc.
	this.env			= {};

	Object.defineProperty(this, 'outputEncoding', {
		get : function() {
			return outputEncoding;
		},
		set : function(enc) {
			if(iconv.encodingExists(enc)) {
				outputEncoding = enc;
			} else {
				Log.warn({ encoding : enc }, 'Unknown encoding');
			}
		}
	});

	Object.defineProperty(this, 'termType', {
		get : function() {
			return termType;
		},
		set : function(ttype) {
			termType = ttype.toLowerCase();
			
			if(this.isANSI()) {
				this.outputEncoding = 'cp437';
			} else {
				//	:TODO: See how x84 does this -- only set if local/remote are binary
				this.outputEncoding = 'utf8';
			}

			//	:TODO: according to this: http://mud-dev.wikidot.com/article:telnet-client-identification
			//	Windows telnet will send "VTNT". If so, set termClient='windows'
			//	there are some others on the page as well

			Log.debug( { encoding : this.outputEncoding }, 'Set output encoding due to terminal type change');
		}
	});

	Object.defineProperty(this, 'termWidth', {
		get : function() {
			return termWidth;
		},
		set : function(width) {
			if(width > 0) {
				termWidth = width;
			}
		}
	});

	Object.defineProperty(this, 'termHeight', {
		get : function() {
			return termHeight;
		},
		set : function(height) {
			if(height > 0) {
				termHeight = height;
			}
		}
	});

	Object.defineProperty(this, 'termClient', {
		get : function() {
			return termClient;
		},
		set : function(tc) {
			termClient = tc;

			Log.debug( { termClient : this.termClient }, 'Set known terminal client');
		}
	});
}

ClientTerminal.prototype.disconnect = function() {
	this.output = null;
};

ClientTerminal.prototype.isANSI = function() {
	//
	//	ANSI terminals should be encoded to CP437
	//
	//	Some terminal types provided by Mercyful Fate / Enthral:
	//		ANSI-BBS
	//		PC-ANSI
	//		QANSI
	//		SCOANSI
	//		VT100
	//		QNX
	//
	//	Reports from various terminals
	//
	//	syncterm:
	//		* SyncTERM
	//	
	//	xterm:
	//		* PuTTY
	//
	//	ansi-bbs:
	//		* fTelnet
	//
	//	pcansi:
	//		* ZOC
	//
	//	screen:
	//		* ConnectBot (Android)
	//
	//	linux:
	//		* JuiceSSH (note: TERM=linux also)
	//
	return [ 'ansi', 'pcansi', 'pc-ansi', 'ansi-bbs', 'qansi', 'scoansi', 'syncterm' ].indexOf(this.termType) > -1;
};

//	:TODO: probably need to update these to convert IAC (0xff) -> IACIAC (escape it)

ClientTerminal.prototype.write = function(s, convertLineFeeds, cb) {
	this.rawWrite(this.encode(s, convertLineFeeds), cb);
};

ClientTerminal.prototype.rawWrite = function(s, cb) {
	if(this.output) {
		this.output.write(s, err => {
			if(cb) {
				return cb(err);
			}
			
			if(err) {
				Log.warn( { error : err.message }, 'Failed writing to socket');
			}
		});
	}
};

ClientTerminal.prototype.pipeWrite = function(s, spec, cb) {
	spec = spec || 'renegade';
	
	var conv = {
		enigma		: enigmaToAnsi,
		renegade	: renegadeToAnsi,
	}[spec] || renegadeToAnsi;
	
	this.write(conv(s, this), null, cb);	//	null = use default for |convertLineFeeds|
};

ClientTerminal.prototype.encode = function(s, convertLineFeeds) {
	convertLineFeeds = _.isBoolean(convertLineFeeds) ? convertLineFeeds : this.convertLF;
	
	if(convertLineFeeds && _.isString(s)) {
		s = s.replace(/\n/g, '\r\n');
	}
	return iconv.encode(s, this.outputEncoding);
};

