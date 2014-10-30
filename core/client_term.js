/* jslint node: true */
'use strict';

//	ENiGMA½
var logger		= require('./logger.js');

var iconv		= require('iconv-lite');
var assert		= require('assert');

iconv.extendNodeEncodings();

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
				logger.log.warn({ encoding : enc }, 'Unknown encoding');
			}
		}
	});

	Object.defineProperty(this, 'termType', {
		get : function() {
			return termType;
		},
		set : function(ttype) {
			termType = ttype.toLowerCase();

			//
			//	ANSI terminals should be encoded to CP437
			//
			if('ansi' == termType) {
				this.outputEncoding = 'cp437';
			} else {
				//	:TODO: See how x84 does this -- only set if local/remote are binary
				this.outputEncoding = 'utf8';
			}
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
}

ClientTerminal.prototype.isANSI = function() {
	return 'ansi' === this.termType;
};

ClientTerminal.prototype.write = function(s, convertLineFeeds) {
	convertLineFeeds = typeof convertLineFeeds === 'undefined' ? this.convertLF : convertLineFeeds;
	if(convertLineFeeds && typeof s === 'string') {
		s = s.replace(/\n/g, '\r\n');
	}
	this.output.write(iconv.encode(s, this.outputEncoding));
};