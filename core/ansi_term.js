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

var _			= require('lodash');

exports.getFGColorValue				= getFGColorValue;
exports.getBGColorValue				= getBGColorValue;
exports.sgr							= sgr;
exports.clearScreen					= clearScreen;
exports.resetScreen					= resetScreen;
exports.normal						= normal;
exports.goHome						= goHome;
exports.disableVT100LineWrapping	= disableVT100LineWrapping;
exports.setFont						= setFont;
exports.fromPipeCode				= fromPipeCode;


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
	eraseLine		: 'K',
	insertLine		: 'L',
	deleteLine		: 'M',
	scrollUp		: 'S',
	scrollDown		: 'T',
	savePos			: 's',
	restorePos		: 'u',
	queryPos		: '6n',
	queryScreenSize	: '255n',	//	See bansi.txt
	goto			: 'H',	//	row Pr, column Pc -- same as f
	gotoAlt			: 'f',	//	same as H

	blinkToBrightIntensity : '?33h',
	blinkNormal				: '?33l',

	emulationSpeed	: '*r',	//	Set output emulation speed. See cterm.txt

	hideCursor		: '?25l',	//	Nonstandard - cterm.txt
	showCursor		: '?25h',	//	Nonstandard - cterm.txt
};

/*
	DECTERM stuff. Probably never need
	hide			: '?25l',
	show			: '?25h',*/

//
//	Select Graphics Rendition
//	See http://cvs.synchro.net/cgi-bin/viewcvs.cgi/*checkout*/src/conio/cterm.txt
//
var SGRValues = {
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
	
	cyanBG			: 47,
	whiteBG			: 47,
};

function getFGColorValue(name) {
	return SGRValues[name];
}

function getBGColorValue(name) {
	return SGRValues[name + 'BG'];
}



//	See http://cvs.synchro.net/cgi-bin/viewcvs.cgi/*checkout*/src/conio/cterm.txt
//	:TODO: document
//	:TODO: Create mappings for aliases... maybe make this a map to values instead
var FONT_MAP = {
	//	Codepage 437 English
	'cp437'			: 0,
	'ibmpc'			: 0,
	'ibm_pc'		: 0,
	'ibm_vga'		: 0,
	'pc'			: 0,
	'cp437_art'	 	: 0,
	'ibmpcart'		: 0,
	'ibmpc_art'		: 0,
	'ibm_pc_art'	: 0,
	'msdos_art'		: 0,
	'msdosart'		: 0,
	'pc_art'		: 0,
	'pcart'			: 0,

	//	Codepage 1251 Cyrillic, (swiss)
	'cp1251-swiss'	: 1,

	//	Russian koi8-r
	'koi8_r'		: 2,
	'koi8-r'		: 2,
	'koi8r'			: 2,

	//	ISO-8859-2 Central European
	'iso8859_2'		: 3,
	'iso8859-2'		: 3,

	//	ISO-8859-4 Baltic wide (VGA 9bit mapped)
	'iso8859_4-baltic9b'	: 4,

	//	Codepage 866 (c) Russian
	'cp866-c'			: 5,

	'iso8859_9'		: 6, 
    'haik8'			: 7, 
    'iso8859_8'		: 8, 
    'koi8_u'		: 9, 
    'iso8859_15-thin'	: 10, 
    'iso8859_4'		: 11,
    'koi8_r_b'		: 12, 
    'iso8859_4-baltic-wide'	: 13, 
    'iso8859_5'		: 14, 
    'ARMSCII_8'		: 15, 
    'iso8859_15'	: 16,
    'cp850'			: 17, 
    'cp850-thin'			: 18, 
    'cp885-thin'			: 19, 
    'cp1251'		: 20, 
    'iso8859_7'		: 21, 
    'koi8-r_c'		: 22,
    'iso8859_4-baltic'		: 23, 
    'iso8859_1'		: 24, 
    'cp866'			: 25, 
    'cp437-thin'			: 26, 
    'cp866-b'			: 27, 
    'cp885'			: 28,
    'cp866_u'		: 29, 
    'iso8859_1-thin'		: 30, 
    'cp1131'		: 31, 
    'c64_upper'		: 32, 
    'c64_lower'		: 33,
    'c128_upper'	: 34, 
    'c128_lower'	: 35,

    'atari'			: 36,
    'atarist'		: 36,

	'pot_noodle'	: 37,
	'p0tnoodle'		: 37, 
    
    'mo_soul'		: 38,
    'mosoul'		: 38,
    'mO\'sOul'		: 38,

    'microknight_plus'	: 39, 
    
    'topaz_plus'		: 40,
    'topazplus'			: 40,
    'amiga_topaz_2+'	: 40,
    'topaz2plus'		: 40,

    'microknight'		: 41,
    'topaz'				: 42,

};


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
    'microknight_plus', 
    'topaz_plus',
    'microknight',
    'topaz',
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

//	Create various color methods such as white(), yellowBG(), reset(), ...
Object.keys(SGRValues).forEach(function onSgrName(name) {
	var code = SGRValues[name];

	exports[name] = function() {
		return ESC_CSI + code + 'm';
	};
});

function sgr() {
	//
	//	- Allow an single array or variable number of arguments
	//	- Each element can be either a integer or string found in SGRValues
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
			if(args[i] in SGRValues) {
				if(result.length > 0) {
					result += ';';
				}
				result += SGRValues[args[i]];
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

function resetScreen() {
	return exports.goHome() + exports.reset() + exports.eraseData(2);
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

//
//	See http://cvs.synchro.net/cgi-bin/viewcvs.cgi/*checkout*/src/conio/cterm.txt
//
//	:TODO: allow full spec here.
/*
function setFont(name, fontPage) {
	fontPage = miscUtil.valueWithDefault(fontPage, 0);

	assert(fontPage === 0 || fontPage === 1);	//	see spec

	var i = SYNC_TERM_FONTS.indexOf(name);
	if(-1 != i) {
		return ESC_CSI + fontPage + ';' + i + ' D';
	}
	return '';
}
*/

function setFont(name, fontPage) {
	name = name.toLowerCase().replace(/ /g, '_');	//	conform to map

	var p1 = miscUtil.valueWithDefault(fontPage, 0);

	assert(p1 >= 0 && p1 <= 3);

	var p2 = FONT_MAP[name];
	if(_.isNumber(p2)) {
		return ESC_CSI + p1 + ';' + p2 + ' D';
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