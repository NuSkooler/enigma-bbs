/* jslint node: true */
'use strict';

var events		= require('events');
var util		= require('util');
var miscUtil	= require('./misc_util.js');
var ansi		= require('./ansi_term.js');

exports.ANSIEscapeParser		= ANSIEscapeParser;


function ANSIEscapeParser(options) {
	var self = this;

	events.EventEmitter.call(this);

	this.column		= 1;
	this.row		= 1;
	this.flags		= 0x00;
	this.scrollBack	= 0;

	options = miscUtil.valueWithDefault(options, {
		mciReplaceChar		: '',
		termHeight			: 25,
		termWidth			: 80,
	});

	this.mciReplaceChar		= miscUtil.valueWithDefault(options.mciReplaceChar, '');
	this.termHeight			= miscUtil.valueWithDefault(options.termHeight, 25);
	this.termWidth			= miscUtil.valueWithDefault(options.termWidth, 80);

	function saveLastColor() {
		self.lastFlags		= self.flags;
		self.lastFgCololr	= self.fgColor;
		self.lastBgColor	= self.bgColor;
	}
	
	function getArgArray(array) {
		var i = array.length;
		while(i--) {
			array[i] = parseInt(array[i], 10);
		}
		return array;
	}

	self.moveCursor = function(cols, rows) {
		self.column	+= cols;
		self.row	+= rows;

		self.column	= Math.max(self.column, 1);
		self.column	= Math.min(self.column, self.termWidth);
		self.row	= Math.max(self.row, 1);		
		self.row	= Math.min(self.row, self.termHeight);

		self.emit('move cursor', self.column, self.row);
		self.rowUpdated();
	};

	self.saveCursorPosition = function() {
		self.savedPosition = {
			row		: self.row,
			column	: self.column
		};
	};

	self.restoreCursorPosition = function() {
		self.row	= self.savedPosition.row;
		self.column	= self.savedPosition.column;
		delete self.savedPosition;
		self.rowUpdated();
	};

	self.clearScreen = function() {
		//	:TODO: should be doing something with row/column?
		self.emit('clear screen');
	};

	self.resetColor = function() {
		//self.fgColor	= 7;
		//self.bgColor	= 0;
		self.fgColor	= 39;
		self.bgColor	= 49;
	};

	self.rowUpdated = function() {
		self.emit('row update', self.row + self.scrollBack);
	};

	function literal(text) {
		var CR = 0x0d;
		var LF = 0x0a;
		var charCode;

		var len = text.length;
		for(var i = 0; i < len; i++) {
			charCode = text.charCodeAt(i) & 0xff;	//	ensure 8 bit
			switch(charCode) {
				case CR : 
					self.column = 1;
					break;

				case LF : 
					self.row++;
					self.rowUpdated();		
					break;

				default :
					//	wrap
					if(self.column === self.termWidth) {
						self.column = 1;
						self.row++;
						self.rowUpdated();
					} else {
						self.column++;
					}
					break;
			}

			if(self.row === 26) {	//	:TODO: should be termHeight + 1 ?
				self.scrollBack++;
				self.row--;
				self.rowUpdated();
			}
		}

		self.emit('chunk', text);
	}

	function getProcessedMCI(mci) {
		if(self.mciReplaceChar.length > 0) {
			var eraseColor = ansi.sgr(self.lastFlags, self.lastFgColor, self.lastBgColor);
			return eraseColor + new Array(mci.length + 1).join(self.mciReplaceChar);			
		} else {
			return mci;
		}
	}

	function parseMCI(buffer) {
		var mciRe = /\%([A-Z]{2})([0-9]{1,2})?(?:\(([0-9A-Z,]+)\))*/g;
		var pos = 0;
		var match;
		var mciCode;
		var args;
		var id;

		do {
			pos		= mciRe.lastIndex;
			match	= mciRe.exec(buffer);

			if(null !== match) {
				if(match.index > pos) {
					literal(buffer.slice(pos, match.index));
				}

				mciCode	= match[1];
				id		= match[2] || null;

				if(match[3]) {
					args = match[3].split(',');
				} else {
					args = [];
				}

				
				self.emit('mci', mciCode, id, args);

				if(self.mciReplaceChar.length > 0) {
					escape('m', [self.lastFlags, self.lastFgColor, self.lastBgColor]);
					self.emit('chunk', ansi.sgr(self.lastFlags, self.lastFgColor, self.lastBgColor));
					literal(new Array(match[0].length + 1).join(self.mciReplaceChar));
				} else {
					literal(match[0]);
				}

				//literal(getProcessedMCI(match[0]));

				//self.emit('chunk', getProcessedMCI(match[0]));
			}

		} while(0 !== mciRe.lastIndex);

		if(pos < buffer.length) {
			literal(buffer.slice(pos));
		}
	}

	self.parse = function(buffer, savedRe) {
		//	:TODO: ensure this conforms to ANSI-BBS / CTerm / bansi.txt for movement/etc.
		var re	= /(?:\x1b\x5b)([\?=;0-9]*?)([ABCDHJKfhlmnpsu])/g;
		var pos = 0;
		var match;
		var opCode;
		var args;

		//	ignore anything past EOF marker, if any
		buffer = buffer.split(String.fromCharCode(0x1a), 1)[0];

		do {
			pos		= re.lastIndex;
			match	= re.exec(buffer);

			if(null !== match) {
				if(match.index > pos) {
					parseMCI(buffer.slice(pos, match.index));
				}

				opCode	= match[2];
				args	= getArgArray(match[1].split(';'));

				escape(opCode, args);

				self.emit('chunk', match[0]);
			}

		} while(0 !== re.lastIndex);

		if(pos < buffer.length) {
			parseMCI(buffer.slice(pos));
		}

		self.emit('complete');
	};

	function escape(opCode, args) {
		var arg;
		var i;
		var len;

		switch(opCode) {
			//	cursor up
			case 'A' :
				arg = args[0] || 1;
				self.moveCursor(0, -arg);
				break;

			//	cursor down
			case 'B' :
				arg = args[0] || 1;
				self.moveCursor(0, arg);
				break;

			//	cursor forward/right
			case 'C' :
				arg = args[0] || 1;
				self.moveCursor(arg, 0);
				break;

			//	cursor back/left
			case 'D' :
				arg = args[0] || 1;
				self.moveCursor(-arg, 0);
				break;

			case 'f' :	//	horiz & vertical
			case 'H' :	//	cursor position
				self.row	= args[0] || 1;
				self.column	= args[1] || 1;
				self.rowUpdated();
				break;

			//	save position
			case 's' : 
				self.saveCursorPosition();
				break;

			//	restore position
			case 'u' : 
				self.restoreCursorPosition();
				break;

			//	set graphic rendition
			case 'm' :
				saveLastColor();

				for(i = 0, len = args.length; i < len; ++i) {
					arg = args[i];
					/*if(0x00 === arg) {
						self.flags = 0x00;
						self.resetColor();
					} else {
						switch(Math.floor(arg / 10)) {
							case 0	: self.flags |= arg; break;
							case 3	: self.fgColor = arg; break;
							case 4	: self.bgColor = arg; break;
							//case 3	: self.fgColor = arg - 30; break;
							//case 4	: self.bgColor = arg - 40; break;
						}
					}
					*/
					if(arg >= 30 && arg <= 37) {
						self.fgColor = arg;
					} else if(arg >= 40 && arg <= 47) {
						self.bgColor = arg;
					} else {
						self.flags = arg;
						if(0 === arg) {
							self.resetColor();
						}
					}
				}
				break;

			//	erase display/screen
			case 'J' :
				//	:TODO: Handle others
				if(2 === args[0]) {
					self.clearScreen();
				}
				break;
		}
	}

	this.resetColor();
	saveLastColor();
}

util.inherits(ANSIEscapeParser, events.EventEmitter);