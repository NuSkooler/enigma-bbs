/* jslint node: true */
'use strict';

var ansi					= require('./ansi_term.js');
var getPredefinedMCIValue	= require('./predefined_mci.js').getPredefinedMCIValue;

var assert					= require('assert');
var _						= require('lodash');

exports.enigmaToAnsi		= enigmaToAnsi;
exports.stripPipeCodes		= exports.stripEnigmaCodes		= stripEnigmaCodes;
exports.pipeStrLen			= exports.enigmaStrLen			= enigmaStrLen;
exports.pipeToAnsi			= exports.renegadeToAnsi		= renegadeToAnsi;
exports.controlCodesToAnsi	= controlCodesToAnsi;

//	:TODO: Not really happy with the module name of "color_codes". Would like something better




//	Also add:
//	* fromCelerity(): |<case sensitive letter>
//	* fromPCBoard(): (@X<bg><fg>)
//	* fromWildcat(): (@<bg><fg>@ (same as PCBoard without 'X' prefix and '@' suffix)
//	* fromWWIV(): <ctrl-c><0-7>
//	* fromSyncronet(): <ctrl-a><colorCode>
//	See http://wiki.synchro.net/custom:colors

//	:TODO: rid of enigmaToAnsi() -- never really use. Instead, create bbsToAnsi() that supports renegade, PCB, WWIV, etc...
function enigmaToAnsi(s, client) {
	if(-1 == s.indexOf('|')) {
		return s;	//	no pipe codes present
	}

	var result	= '';
	var re		= /\|([A-Z\d]{2}|\|)/g;
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
			//
			//	ENiGMA MCI code? Only available if |client|
			//	is supplied.
			//
			val = getPredefinedMCIValue(client, m[1]) || ('|' + m[1]);	//	value itself or literal
		}

		if(_.isString(val)) {
			result += s.substr(lastIndex, m.index - lastIndex) + val;
		} else {
			assert(val >= 0 && val <= 47);

			var attr = '';
			if(7 == val) {
				attr = ansi.sgr('normal');
			} else if (val < 7 || val >= 16) {
				attr = ansi.sgr(['normal', val]);
			} else if (val <= 15) {
				attr = ansi.sgr(['normal', val - 8, 'bold']);
			}

			result += s.substr(lastIndex, m.index - lastIndex) + attr;
		}

		lastIndex = re.lastIndex;
	}

	result = (0 === result.length ? s : result + s.substr(lastIndex));

	return result;
}

function stripEnigmaCodes(s) {
	return s.replace(/\|[A-Z\d]{2}/g, '');
}

function enigmaStrLen(s) {
	return stripEnigmaCodes(s).length;
}

function ansiSgrFromRenegadeColorCode(cc) {
	return ansi.sgr({
		0	: [ 'reset', 'black' ],
		1	: [ 'reset', 'blue' ],
		2	: [ 'reset', 'green' ],
		3	: [ 'reset', 'cyan' ],
		4	: [ 'reset', 'red' ],
		5	: [ 'reset', 'magenta' ],
		6	: [ 'reset', 'yellow' ],
		7	: [ 'reset', 'white' ],

		8	: [ 'bold', 'black' ],
		9	: [ 'bold', 'blue' ],
		10	: [ 'bold', 'green' ],
		11	: [ 'bold', 'cyan' ],
		12	: [ 'bold', 'red' ],
		13	: [ 'bold', 'magenta' ],
		14	: [ 'bold', 'yellow' ],
		15	: [ 'bold', 'white' ],

		16	: [ 'blackBG' ],
		17 	: [ 'blueBG' ],
		18	: [ 'greenBG' ],
		19	: [ 'cyanBG' ],
		20	: [ 'redBG' ],
		21	: [ 'magentaBG' ],
		22	: [ 'yellowBG' ],
		23	: [ 'whiteBG' ],

		24	: [ 'bold', 'blackBG' ],
		25	: [ 'bold', 'blueBG' ],
		26	: [ 'bold', 'greenBG' ],
		27	: [ 'bold', 'cyanBG' ],
		28	: [ 'bold', 'redBG' ],
		29	: [ 'bold', 'magentaBG' ],
		30	: [ 'bold', 'yellowBG' ],
		31	: [ 'bold', 'whiteBG' ],
	}[cc] || 'normal');
}

function renegadeToAnsi(s, client) {
	if(-1 == s.indexOf('|')) {
		return s;	//	no pipe codes present
	}

	var result	= '';
	var re		= /\|([A-Z\d]{2}|\|)/g;
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
			val = getPredefinedMCIValue(client, m[1]) || ('|' + m[1]);	//	value itself or literal
		}

		if(_.isString(val)) {
			result += s.substr(lastIndex, m.index - lastIndex) + val;
		} else {
			const attr = ansiSgrFromRenegadeColorCode(val);
			result += s.substr(lastIndex, m.index - lastIndex) + attr;
		}

		lastIndex = re.lastIndex;
	}

	return (0 === result.length ? s : result + s.substr(lastIndex));
}

//
//	Converts various control codes popular in BBS packages
//	to ANSI escape sequences. Additionaly supports ENiGMA style
//	MCI codes.
//
//	Supported control code formats:
//	* Renegade	: |##
//	* PCBoard	: @X## where the first number/char is FG color, and second is BG
//	* WildCat!	: @##@ the same as PCBoard without the X prefix, but with a @ suffix
//	* WWIV		: ^#
//
//	TODO: Add Synchronet and Celerity format support
//
//	Resources:
//	* http://wiki.synchro.net/custom:colors
//
function controlCodesToAnsi(s, client) {
	const RE = /(\|([A-Z0-9]{2})|\|)|(@X([0-9A-F]{2}))|(@([0-9A-F]{2})@)|(\x03[0-9]|\x03)/g;	//	eslint-disable-line no-control-regex

	let m;
	let result		= '';
	let lastIndex	= 0;
	let v;
	let fg;
	let bg;

	while((m = RE.exec(s))) {
		switch(m[0].charAt(0)) {
			case '|' :
				//	Renegade or ENiGMA MCI
				v = parseInt(m[2], 10);

				if(isNaN(v)) {
					v = getPredefinedMCIValue(client, m[2]) || m[0];	//	value itself or literal
				}

				if(_.isString(v)) {
					result += s.substr(lastIndex, m.index - lastIndex) + v;
				} else {
					v = ansiSgrFromRenegadeColorCode(v);
					result += s.substr(lastIndex, m.index - lastIndex) + v;
				}
				break;

			case '@' :
				//	PCBoard @X## or Wildcat! @##@
				if('@' === m[0].substr(-1)) {
					//	Wildcat!
					v = m[6];
				} else {
					v = m[4];
				}

				fg = {
					0	: [ 'reset', 'black' ],
					1	: [ 'reset', 'blue' ],
					2	: [ 'reset', 'green' ],
					3	: [ 'reset', 'cyan' ],
					4	: [ 'reset', 'red' ],
					5	: [ 'reset', 'magenta' ],
					6	: [ 'reset', 'yellow' ],
					7	: [ 'reset', 'white' ],

					8	: [ 'blink', 'black' ],
					9	: [ 'blink', 'blue' ],
					A	: [ 'blink', 'green' ],
					B	: [ 'blink', 'cyan' ],
					C	: [ 'blink', 'red' ],
					D	: [ 'blink', 'magenta' ],
					E	: [ 'blink', 'yellow' ],
					F	: [ 'blink', 'white' ],
				}[v.charAt(0)] || ['normal'];

				bg = {
					0	: [ 'blackBG' ],
					1 	: [ 'blueBG' ],
					2	: [ 'greenBG' ],
					3	: [ 'cyanBG' ],
					4	: [ 'redBG' ],
					5	: [ 'magentaBG' ],
					6	: [ 'yellowBG' ],
					7	: [ 'whiteBG' ],

					8	: [ 'bold', 'blackBG' ],
					9	: [ 'bold', 'blueBG' ],
					A	: [ 'bold', 'greenBG' ],
					B	: [ 'bold', 'cyanBG' ],
					C	: [ 'bold', 'redBG' ],
					D	: [ 'bold', 'magentaBG' ],
					E	: [ 'bold', 'yellowBG' ],
					F	: [ 'bold', 'whiteBG' ],
				}[v.charAt(1)] || [ 'normal' ];

				v = ansi.sgr(fg.concat(bg));
				result += s.substr(lastIndex, m.index - lastIndex) + v;
				break;

			case '\x03' :
				v = parseInt(m[8], 10);

				if(isNaN(v)) {
					v += m[0];
				} else {
					v = ansi.sgr({
						0	: [ 'reset', 'black' ],
						1	: [ 'bold', 'cyan' ],
						2	: [ 'bold', 'yellow' ],
						3	: [ 'reset', 'magenta' ],
						4	: [ 'bold', 'white', 'blueBG' ],
						5	: [ 'reset', 'green' ],
						6	: [ 'bold', 'blink', 'red' ],
						7	: [ 'bold', 'blue' ],
						8	: [ 'reset', 'blue' ],
						9	: [ 'reset', 'cyan' ],
					}[v] || 'normal');
				}

				result += s.substr(lastIndex, m.index - lastIndex) + v;

				break;
		}

		lastIndex = RE.lastIndex;
	}

	return (0 === result.length ? s : result + s.substr(lastIndex));
}