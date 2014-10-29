/* jslint node: true */
'use strict';

var stream		= require('stream');
var term		= require('./client_term.js');
var assert		= require('assert');
var miscUtil	= require('./misc_util.js');
var ansi		= require('./ansi_term.js');
var logger		= require('./logger.js');

exports.Client	= Client;

//var ANSI_CONTROL_REGEX	= /(?:(?:\u001b\[)|\u009b)(?:(?:[0-9]{1,3})?(?:(?:;[0-9]{0,3})*)?[A-M|f-m])|\u001b[A-M]/g;

//	:TODO: Move all of the key stuff to it's own module
var ANSI_KEY_NAME_MAP = {
	0x08	: 'backspace',
	0x09	: 'tab',
	0x7f	: 'del',
	0x1b	: 'esc',
	0x0d	: 'enter',
};

var ANSI_KEY_CSI_NAME_MAP = {
	0x40	: 'insert',			//	@
	0x41	: 'up arrow',		//	A
	0x42	: 'down arrow',		//	B
	0x43	: 'right arrow',	//	C
	0x44	: 'left arrow',		//	D

	0x48	: 'home',			//	H
	0x4b	: 'end',			//	K

	0x56	: 'page up',		//	V
	0x55	: 'page down',		//	U
};

var ANSI_F_KEY_NAME_MAP_1 = {
	0x50	: 'F1',
	0x51	: 'F2',
	0x52	: 'F3',
	0x53	: 'F4',
	0x74	: 'F5',
};

var ANSI_F_KEY_NAME_MAP_2 = {
	//	rxvt
	11		: 'F1',
	12		: 'F2',
	13		: 'F3',
	14		: 'F4',	
	15		: 'F5',

	//	SyncTERM
	17		: 'F6',
	18		: 'F7',
	19		: 'F8',
	20		: 'F9',
	21		: 'F10',
	23		: 'F11',
	24		: 'F12',
};

//	:TODO: put this in a common area!!!!
function getIntArgArray(array) {
	var i = array.length;
	while(i--) {
		array[i] = parseInt(array[i], 10);
	}
	return array;
}

function Client(input, output) {
	stream.call(this);

	var self	= this;

	this.input			= input;
	this.output			= output;
	this.term			= new term.ClientTerminal(this.output);

	self.on('data', function onData1(data) {
		//console.log(data);

		onData(data);
		//handleANSIControlResponse(data);
	});

	function handleANSIControlResponse(data) {
		//console.log(data);
		ansi.forEachControlCode(data, function onControlResponse(name, params) {
			var eventName = 'on' + name[0].toUpperCase() + name.substr(1);
			console.log(eventName + ': ' + params);
			self.emit(eventName, params);
		});
	}

	//
	//	Peek at |data| and emit for any specialized handling
	//	such as ANSI control codes or user/keyboard input
	//
	function onData(data) {
		var len = data.length;
		var c;
		var name;

		if(1 === len) {
			c = data[0];
			
			if(0x00 === c) {
				//	ignore single NUL
				return;
			}

			name = ANSI_KEY_NAME_MAP[c];
			if(name) {
				self.emit('special key', name);
				self.emit('key press', data, true);
			} else {
				self.emit('key press', data, false);
			}
		}

		if(0x1b !== data[0]) {
			return;
		}

		if(3 === len) {
			if(0x5b === data[1]) {
				name = ANSI_KEY_CSI_NAME_MAP[data[2]];
				if(name) {
					self.emit('special key', name);
					self.emit('key press', data, true);
				}
			} else if(0x4f === data[1]) {
				name = ANSI_F_KEY_NAME_MAP_1[data[2]];
				if(name) {
					self.emit('special key', name);
					self.emit('key press', data, true);
				}
			}
		} else if(5 === len && 0x5b === data[1] && 0x7e === data[4]) {
			var code = parseInt(data.slice(2,4), 10);

			if(!isNaN(code)) {
				name = ANSI_F_KEY_NAME_MAP_2[code];
				if(name) {
					self.emit('special key', name);
					self.emit('key press', data, true);
				}
			}
		} else if(len > 3) {
			//	:TODO: Implement various responses to DSR's & such
			//	See e.g. http://www.vt100.net/docs/vt100-ug/chapter3.html
			var dsrResponseRe = /\u001b\[([0-9\;]+)([R])/g;
			var match;
			var args;
			do {
				match = dsrResponseRe.exec(data);

				if(null !== match) {
					switch(match[2]) {
						case 'R' :
							args = getIntArgArray(match[1].split(';'));
							if(2 === args.length) {
								//	:TODO: rename to 'cpr' or 'cursor position report'
								self.emit('onPosition', args);
							}
							break;
					}
				}
			} while(0 !== dsrResponseRe.lastIndex);
			//	:TODO: Look for various DSR responses such as cursor position
		}
	}
}

require('util').inherits(Client, stream);

Client.prototype.end = function () {
	return this.output.end.apply(this.output, arguments);
};

Client.prototype.destroy = function () {
	return this.output.destroy.apply(this.output, arguments);
};

Client.prototype.destroySoon = function () {
	return this.output.destroySoon.apply(this.output, arguments);
};

Client.prototype.waitForKeyPress = function(cb) {
	this.once('key press', function onKeyPress(kp) {
		cb(kp);
	});
};

Client.prototype.address = function() {
	return this.input.address();
};

///////////////////////////////////////////////////////////////////////////////
//	Default error handlers
///////////////////////////////////////////////////////////////////////////////

Client.prototype.defaultHandlerMissingMod = function(err) {
	var self = this;

	function handler(err) {
		logger.log.error(err);

		self.term.write('An unrecoverable error has been encountered!\n');
		self.term.write('This has been logged for your SysOp to review.\n');
		self.term.write('\nGoodbye!\n');

		
		//self.term.write(err);

		//if(miscUtil.isDevelopment() && err.stack) {
		//	self.term.write('\n' + err.stack + '\n');
		//}		

		self.end();
	}

	return handler;
};

