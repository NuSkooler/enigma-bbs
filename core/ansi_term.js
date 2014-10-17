/* jslint node: true */
'use strict';

//
//	ANSI Terminal Support
//	
//	Resources:
//	* http://ansi-bbs.org/
//	* http://www.bbsdocumentary.com/library/PROGRAMS/GRAPHICS/ANSI/ansisys.txt
//	* http://en.wikipedia.org/wiki/ANSI_escape_code
//

var assert		= require('assert');
var binary		= require('binary');
var miscUtil	= require('./misc_util.js');

exports.sgr							= sgr;
exports.clearScreen					= clearScreen;
exports.clearScreenGoHome			= clearScreenGoHome;
exports.normal						= normal;
exports.goHome						= goHome;
exports.disableVT100LineWrapping	= disableVT100LineWrapping;
exports.setSyncTermFont				= setSyncTermFont;
exports.fromPipeCode				= fromPipeCode;
exports.forEachControlCode			= forEachControlCode;


//
//	See also
//	https://github.com/TooTallNate/ansi.js/blob/master/lib/ansi.js

var ESC_CSI 	= '\u001b[';

var CONTROL = {
	up				: 'A',
	down			: 'B',
	forward			: 'C',
	back			: 'D',
	nextLine		: 'E',
	prevLine		: 'F',
	horizAbsolute	: 'G',
	eraseData		: 'J',
	scrollUp		: 'S',
	scrollDown		: 'T',
	savePos			: 's',
	restorePos		: 'u',
	queryPos		: '6n',
	goto			: 'H',	//	row Pr, column Pc -- same as f
	gotoAlt			: 'f'	//	same as H
};

/*
	DECTERM stuff. Probably never need
	hide			: '?25l',
	show			: '?25h',*/

//
//	Select Graphics Rendition
//	See http://cvs.synchro.net/cgi-bin/viewcvs.cgi/*checkout*/src/conio/cterm.txt
//
var SGR = {
	reset			: 0,
	bold			: 1,
	dim				: 2,
	blink			: 5,
	fastBlink		: 6,
	negative		: 7,
	hidden			: 8,

	normal			: 22,
	steady			: 25,
	positive		: 27,

	black			: 30,
	red				: 31,
	green			: 32,
	yellow			: 33,
	blue			: 34,
	magenta			: 35,
	cyan			: 36,
	white			: 37,

	blackBG			: 40,
	redBG			: 41,
	greenBG			: 42,
	yellowBG		: 43,
	blueBG			: 44,
	magentaBG		: 45,
	cyanBG			: 47,
	whiteBG			: 47,
};

//	See http://cvs.synchro.net/cgi-bin/viewcvs.cgi/*checkout*/src/conio/cterm.txt
//	:TODO: document
var SYNC_TERM_FONTS = [
	'cp437',
	'cp1251', 
	'koi8_r', 
	'iso8859_2', 
	'iso8859_4', 
	'cp866',
    'iso8859_9', 
    'haik8', 
    'iso8859_8', 
    'koi8_u', 
    'iso8859_15', 
    'iso8859_4',
    'koi8_r_b', 
    'iso8859_4', 
    'iso8859_5', 
    'ARMSCII_8', 
    'iso8859_15',
    'cp850', 
    'cp850', 
    'cp885', 
    'cp1251', 
    'iso8859_7', 
    'koi8-r_c',
    'iso8859_4', 
    'iso8859_1', 
    'cp866', 
    'cp437', 
    'cp866', 
    'cp885',
    'cp866_u', 
    'iso8859_1', 
    'cp1131', 
    'c64_upper', 
    'c64_lower',
    'c128_upper', 
    'c128_lower', 
    'atari', 
    'pot_noodle', 
    'mo_soul',
    'microknight', 
    'topaz'
];

//	Create methods such as up(), nextLine(),...
Object.keys(CONTROL).forEach(function onControlName(name) {
	var code = CONTROL[name];

	exports[name] = function() {
		var c = code;
		if(arguments.length > 0) {
			//	arguments are array like -- we want an array
			c = Array.prototype.slice.call(arguments).map(Math.round).join(';') + code;
		}
		return ESC_CSI + c;
	};
});

//	Create a reverse map of CONTROL values to their key/names

/*
var CONTROL_REVERSE_MAP = {};
Object.keys(CONTROL).forEach(function onControlName(name) {
	var code = CONTROL[name];

	CONTROL_REVERSE_MAP[code] = name;
});
*/

var CONTROL_RESPONSE = {
	'R'			: 'position',
};

//	:TODO: move this to misc utils or such -- use here & parser
function getIntArgArray(array) {
	var i = array.length;
	while(i--) {
		array[i] = parseInt(array[i], 10);
	}
	return array;
}

//	:TODO: rename this
function forEachControlCode(data, cb) {
	//var re = /\u001b\[([0-9\;])*[R]/g;

	var len = data.length;
	var pos = 0;

	while(pos < len) {
		if(0x1b !== data[pos++] || 0x5b !== data[pos++]) {
			continue;
		}

		var params = '';

		while(pos < len) {
			var c = data[pos++];
					
			if(((c > 64) && (c <  91)) || ((c > 96) && (c < 123))) {
				c = String.fromCharCode(c);
				var name = CONTROL_RESPONSE[c];
				if(name) {
					params = getIntArgArray(params.split(';'));
					cb(name, params);
				}
			}

			params += String.fromCharCode(c);
		}
	}
}

//	Create various color methods such as white(), yellowBG(), reset(), ...
Object.keys(SGR).forEach(function onSgrName(name) {
	var code = SGR[name];

	exports[name] = function() {
		return ESC_CSI + code + 'm';
	};
});

function sgr() {
	//
	//	- Allow an single array or variable number of arguments
	//	- Each element can be either a integer or string found in SGR
	//	  which in turn maps to a integer
	//
	if(arguments.length <= 0) {
		return '';
	}
	
	var result = '';

	//	:TODO: this method needs a lot of cleanup!

	var args = Array.isArray(arguments[0]) ? arguments[0] : arguments;
	for(var i = 0; i < args.length; i++) {
		if(typeof args[i] === 'string') {
			if(args[i] in SGR) {
				if(result.length > 0) {
					result += ';';
				}
				result += SGR[args[i]];
			}
		} else if(typeof args[i] === 'number') {
			if(result.length > 0) {
				result += ';';
			}
			result += args[i];
		}
	}
	return ESC_CSI + result + 'm';
}

///////////////////////////////////////////////////////////////////////////////
//	Shortcuts for common functions
///////////////////////////////////////////////////////////////////////////////

function clearScreen() {
	return exports.eraseData(2);
}

function clearScreenGoHome() {
	return exports.goto(1,1) + exports.eraseData(2);
}

function normal() {
	return sgr(['normal', 'reset']);
}

function goHome() {
	return exports.goto();	//	no params = home = 1,1
}

//
//	See http://www.termsys.demon.co.uk/vtANSI_BBS.htm
//
function disableVT100LineWrapping() {
	return ESC_CSI + '7l';
}

function setSyncTermFont(name, fontPage) {
	fontPage = miscUtil.valueWithDefault(fontPage, 0);

	assert(fontPage === 0 || fontPage === 1);	//	see spec

	var i = SYNC_TERM_FONTS.indexOf(name);
	if(-1 != i) {
		return ESC_CSI + fontPage + ';' + i + ' D';
	}
	return '';
}

//	Also add:
//	* fromRenegade(): |<0-23>
//	* fromCelerity(): |<case sensitive letter>
//	* fromPCBoard(): (@X<bg><fg>@)
//	* fromWildcat(): (@<bg><fg>@ (same as PCBoard without 'X' prefix)
//	* fromWWIV(): <ctrl-c><0-7>
//	* fromSyncronet(): <ctrl-a><colorCode>
//	See http://wiki.synchro.net/custom:colors
function fromPipeCode(s) {
    if(-1 == s.indexOf('|')) {
		return s;	//	no pipe codes present
	}

	var result = '';
	var re = /\|(\d{2,3}|\|)/g;
	var m;
    var lastIndex = 0;
	while((m = re.exec(s))) {
		var val = m[1];

		if('|' == val) {
			result += '|';
			continue;
		}

		//	convert to number
		val = parseInt(val, 10);
		if(isNaN(val)) {
			val = 0;
		}

		assert(val >= 0 && val <= 256);

		var attr = '';
		if(7 == val) {
			attr = sgr('normal');
		} else if (val < 7 || val >= 16) {
			attr = sgr(['normal', val]);
		} else if (val <= 15) {
			attr = sgr(['normal', val - 8, 'bold']);
		}

		result += s.substr(lastIndex, m.index - lastIndex) + attr;
        lastIndex = re.lastIndex;
	}

    result = (0 === result.length ? s : result + s.substr(lastIndex));
    
    return result;
}