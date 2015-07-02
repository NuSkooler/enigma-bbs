/* jslint node: true */
'use strict';

/*
	Portions of this code for key handling heavily inspired from the following:
	https://github.com/chjj/blessed/blob/master/lib/keys.js

	MIT license is as follows:
	--------------------------
	The MIT License (MIT)

	Copyright (c) <year> <copyright holders>

	Permission is hereby granted, free of charge, to any person obtaining a copy
	of this software and associated documentation files (the "Software"), to deal
	in the Software without restriction, including without limitation the rights
	to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
	copies of the Software, and to permit persons to whom the Software is
	furnished to do so, subject to the following conditions:

	The above copyright notice and this permission notice shall be included in
	all copies or substantial portions of the Software.

	THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
	IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
	FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
	AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
	LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
	OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
	THE SOFTWARE.
	--------------------------
*/
var term		= require('./client_term.js');
var miscUtil	= require('./misc_util.js');
var ansi		= require('./ansi_term.js');
var Log			= require('./logger.js').log;
var user		= require('./user.js');
var moduleUtil	= require('./module_util.js');
var menuUtil	= require('./menu_util.js');

var stream		= require('stream');
var assert		= require('assert');
var _			= require('lodash');

exports.Client	= Client;

//	:TODO: Move all of the key stuff to it's own module

//
//	Resources & Standards:
//	* http://www.ansi-bbs.org/ansi-bbs-core-server.html
//

//	:TODO: put this in a common area!!!!
function getIntArgArray(array) {
	var i = array.length;
	while(i--) {
		array[i] = parseInt(array[i], 10);
	}
	return array;
}

var RE_DSR_RESPONSE_ANYWHERE		= /(?:\u001b\[)([0-9\;]+)([R])/;
var RE_META_KEYCODE_ANYWHERE		= /(?:\u001b)([a-zA-Z0-9])/;
var RE_META_KEYCODE					= new RegExp('^' + RE_META_KEYCODE_ANYWHERE.source + '$');
var RE_FUNCTION_KEYCODE_ANYWHERE	= new RegExp('(?:\u001b+)(O|N|\\[|\\[\\[)(?:' + [
		'(\\d+)(?:;(\\d+))?([~^$])',
		'(?:M([@ #!a`])(.)(.))',		// mouse stuff
		'(?:1;)?(\\d+)?([a-zA-Z@])'
	].join('|') + ')');

var RE_FUNCTION_KEYCODE				= new RegExp('^' + RE_FUNCTION_KEYCODE_ANYWHERE.source);
var RE_ESC_CODE_ANYWHERE			= new RegExp( [
		RE_FUNCTION_KEYCODE_ANYWHERE.source, 
		RE_META_KEYCODE_ANYWHERE.source, 
		RE_DSR_RESPONSE_ANYWHERE.source,
		/\u001b./.source
	].join('|'));


/*
Convert names to eg 'ctrl-x', 'shift-x',...
https://github.com/chjj/blessed/blob/master/lib/program.js

Look at blessed DSR stuff, etc
Also cursor shape

Key filtering here: https://github.com/chjj/blessed/blob/master/lib/widgets/textarea.js
*/


function Client(input, output) {
	stream.call(this);

	var self	= this;

	this.input				= input;
	this.output				= output;
	this.term				= new term.ClientTerminal(this.output);
	this.user				= new user.User();
	this.currentTheme		= { info : { name : 'N/A', description : 'None' } };	

	//
	//	Peek at incoming |data| and emit events for any special
	//	handling that may include:
	//	*	Keyboard input
	//	*	ANSI CSR's and the like
	//
	//	References:
	//	*	http://www.ansi-bbs.org/ansi-bbs-core-server.html
	//	*	Christopher Jeffrey's Blessed library @ https://github.com/chjj/blessed/
	//
	this.isMouseInput = function(data) {
		return /\x1b\[M/.test(data) ||
		/\u001b\[M([\x00\u0020-\uffff]{3})/.test(data) || 
		/\u001b\[(\d+;\d+;\d+)M/.test(data) ||
		/\u001b\[<(\d+;\d+;\d+)([mM])/.test(data) ||
		/\u001b\[<(\d+;\d+;\d+;\d+)&w/.test(data) || 
		/\u001b\[24([0135])~\[(\d+),(\d+)\]\r/.test(data) ||
		/\u001b\[(O|I)/.test(data);
	};

	this.getKeyComponentsFromCode = function(code) {
		return {
			//	xterm/gnome
			'OP' : { name : 'f1' },
			'OQ' : { name : 'f2' },
			'OR' : { name : 'f3' },
			'OS' : { name : 'f4' },

			'OA' : { name : 'up arrow' },
			'OB' : { name : 'down arrow' },
			'OC' : { name : 'right arrow' },
			'OD' : { name : 'left arrow' },
			'OE' : { name : 'clear' },
			'OF' : { name : 'end' },
			'OH' : { name : 'home' },
			
			//	xterm/rxvt
        	'[11~'	: { name : 'f1' },
        	'[12~'	: { name : 'f2' },
        	'[13~'	: { name : 'f3' },
        	'[14~'	: { name : 'f4' },

        	'[1~'	: { name : 'home' },
        	'[2~'	: { name : 'insert' },
        	'[3~'	: { name : 'delete' },
        	'[4~'	: { name : 'end' },
        	'[5~'	: { name : 'page up' },
        	'[6~'	: { name : 'page down' },

        	//	Cygwin & libuv
        	'[[A'	: { name : 'f1' },
        	'[[B'	: { name : 'f2' },
        	'[[C'	: { name : 'f3' },
        	'[[D'	: { name : 'f4' },
        	'[[E'	: { name : 'f5' },

        	//	Common impls
			'[15~'	: { name : 'f5' },
			'[17~'	: { name : 'f6' },
			'[18~'	: { name : 'f7' },
			'[19~'	: { name : 'f8' },
			'[20~'	: { name : 'f9' },
			'[21~'	: { name : 'f10' },
			'[23~'	: { name : 'f11' },
			'[24~'	: { name : 'f12' },

			//	xterm
			'[A'	: { name : 'up arrow' },
			'[B'	: { name : 'down arrow' },
			'[C'	: { name : 'right arrow' },
			'[D'	: { name : 'left arrow' },
			'[E'	: { name : 'clear' },
			'[F'	: { name : 'end' },
			'[H'	: { name : 'home' },

			//	PuTTY
			'[[5~'	: { name : 'page up' },
			'[[6~'	: { name : 'page down' },

			//	rvxt
        	'[7~'	: { name : 'home' },
			'[8~'	: { name : 'end' },

			//	rxvt with modifiers
			'[a'	: { name : 'up arrow', shift : true },
			'[b'	: { name : 'down arrow', shift : true },
			'[c'	: { name : 'right arrow', shift : true },
			'[d'	: { name : 'left arrow', shift : true },
			'[e'	: { name : 'clear', shift : true },

			'[2$'	: { name : 'insert', shift : true },
			'[3$'	: { name : 'delete', shift : true },
			'[5$'	: { name : 'page up', shift : true },
			'[6$'	: { name : 'page down', shift : true },
			'[7$'	: { name : 'home', shift : true },
			'[8$'	: { name : 'end', shift : true },

			'Oa'	: { name : 'up arrow', ctrl :  true },
			'Ob'	: { name : 'down arrow', ctrl :  true },
			'Oc'	: { name : 'right arrow', ctrl :  true },
			'Od'	: { name : 'left arrow', ctrl :  true },
			'Oe'	: { name : 'clear', ctrl :  true },

			'[2^'	: { name : 'insert', ctrl :  true },
			'[3^'	: { name : 'delete', ctrl :  true },
			'[5^'	: { name : 'page up', ctrl :  true },
			'[6^'	: { name : 'page down', ctrl :  true },
			'[7^'	: { name : 'home', ctrl :  true },
			'[8^'	: { name : 'end', ctrl :  true },

			//	SyncTERM / EtherTerm
			'[K'	: { name : 'end' },
			'[@'	: { name : 'insert' },
			'[V'	: { name : 'page up' },
			'[U'	: { name : 'page down' },

			//	other
			'[Z'	: { name : 'tab', shift : true },
		}[code];
	};

	this.on('data', function clientData(data) {
		//	create a uniform format that can be parsed below
		if(data[0] > 127 && undefined === data[1]) {
			data[0] -= 128;
			data = '\u001b' + data.toString('utf-8');
		} else {
			data = data.toString('utf-8');
		}

		if(self.isMouseInput(data)) {
			return;
		}

		var buf = [];
		var m;
		while((m = RE_ESC_CODE_ANYWHERE.exec(data))) {
			buf = buf.concat(data.slice(0, m.index).split(''));
			buf.push(m[0]);
			data = data.slice(m.index + m[0].length);
		}

		buf = buf.concat(data.split(''));	//	remainder

		buf.forEach(function bufPart(s) {
			var key = {
				seq			: s,
				name		: undefined,
				ctrl		: false,
				meta		: false,
				shift		: false,
			};

			var parts;

			if((parts = RE_DSR_RESPONSE_ANYWHERE.exec(s))) {
				if('R' === parts[2]) {
					var cprArgs = getIntArgArray(parts[1].split(';'));
					if(2 === cprArgs.length) {
						self.emit('cursor position report', cprArgs);
					}
				}
			} else if('\r' === s) {
				key.name = 'return';
			} else if('\n' === s) {
				key.name = 'line feed';
			} else if('\t' === s) {
				key.name = 'tab';
			} else if ('\b' === s || '\x7f' === s || '\x1b\x7f' === s || '\x1b\b' === s) {
				//	backspace, CTRL-H
				key.name	= 'backspace';
				key.meta	= ('\x1b' === s.charAt(0));
			} else if('\x1b' === s || '\x1b\x1b' === s) {
				key.name	= 'escape';
				key.meta	= (2 === s.length);
			} else if (' ' === s || '\x1b ' === s) {
				//	rather annoying that space can come in other than just " "
				key.name	= 'space';
				key.meta	= (2 === s.length);
			} else if(1 === s.length && s <= '\x1a') {
				//	CTRL-<letter>
				key.name	= String.fromCharCode(s.charCodeAt(0) + 'a'.charCodeAt(0) - 1);
				key.ctrl	= true;
			} else if(1 === s.length && s >= 'a' && s <= 'z') {
				//	normal, lowercased letter
				key.name	= s;
			} else if(1 === s.length && s >= 'A' && s <= 'Z') {
				key.name	= s.toLowerCase();
				key.shift	= true;
			} else if ((parts = RE_META_KEYCODE.exec(s))) {
				//	meta with character key
				key.name	= parts[1].toLowerCase();
				key.meta	= true;
				key.shift	= /^[A-Z]$/.test(parts[1]);
			} else if((parts = RE_FUNCTION_KEYCODE.exec(s))) {
				var code = 
					(parts[1] || '') + (parts[2] || '') +
                 	(parts[4] || '') + (parts[9] || '');
                var modifier = (parts[3] || parts[8] || 1) - 1;

                key.ctrl	= !!(modifier & 4);
				key.meta	= !!(modifier & 10);
				key.shift	= !!(modifier & 1);
				key.code	= code;

				_.assign(key, self.getKeyComponentsFromCode(code));
			}

			var ch;
			if(1 === s.length) {
				ch = s;
			} else if('space' === key.name) {
				//	stupid hack to always get space as a regular char
				ch = ' ';
			}

			if(_.isUndefined(key.name)) {
				key = undefined;
			} else {
				//
				//	Adjust name for CTRL/Shift/Meta modifiers
				//
				key.name = 
					(key.ctrl ? 'ctrl + ' : '') +
					(key.meta ? 'meta + ' : '') +
					(key.shift ? 'shift + ' : '') +
					key.name;
			}

			if(key || ch) {
				//Log.trace( { key : key, ch : ch }, 'User keyboard input');
				self.log.trace( { key : key, ch : ch }, 'User keyboard input');

				self.emit('key press', ch, key);
			}
		});
	});

	self.detachCurrentMenuModule = function() {
		if(self.currentMenuModule) {
			self.currentMenuModule.leave();
			self.currentMenuModule = null;
		}
	};
}

require('util').inherits(Client, stream);

Client.prototype.end = function () {
	this.detachCurrentMenuModule();
	
	return this.output.end.apply(this.output, arguments);
};

Client.prototype.destroy = function () {
	return this.output.destroy.apply(this.output, arguments);
};

Client.prototype.destroySoon = function () {
	return this.output.destroySoon.apply(this.output, arguments);
};

Client.prototype.waitForKeyPress = function(cb) {
	this.once('key press', function kp(ch, key) {
		cb(ch, key);
	});
};

Client.prototype.address = function() {
	return this.input.address();
};

Client.prototype.gotoMenuModule = function(options, cb) {
	var self = this;

	assert(options.name);
	
	//	Assign a default missing module handler callback if none was provided
	cb = miscUtil.valueWithDefault(cb, self.defaultHandlerMissingMod());

	self.detachCurrentMenuModule();

	var loadOptions = {
		name	: options.name, 
		client	: self, 
		args	: options.args
	};

	menuUtil.loadMenu(loadOptions, function onMenuModuleLoaded(err, modInst) {
		if(err) {
			cb(err);
		} else {
			Log.debug( { menuName : options.name }, 'Goto menu module');

			modInst.enter(self);

			self.currentMenuModule = modInst;
		}
	});
};

Client.prototype.fallbackMenuModule = function(cb) {

};

///////////////////////////////////////////////////////////////////////////////
//	Default error handlers
///////////////////////////////////////////////////////////////////////////////

//	:TODO: getDefaultHandler(name) -- handlers in default_handlers.js or something
Client.prototype.defaultHandlerMissingMod = function(err) {
	var self = this;

	function handler(err) {
		Log.error(err);

		self.term.write(ansi.resetScreen());
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

