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
			var attr = ansi.sgr({
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
			}[val] || 'normal');

			result += s.substr(lastIndex, m.index - lastIndex) + attr;
		}

		lastIndex = re.lastIndex;
	}

	return (0 === result.length ? s : result + s.substr(lastIndex));	
}
