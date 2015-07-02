/* jslint node: true */
'use strict';

var ansi		= require('./ansi_term.js');

var assert		= require('assert');

exports.pipeToAnsi		= exports.renegadeToAnsi		= renegadeToAnsi;
exports.stripPipeCodes	= exports.stripRenegadeCodes	= stripRenegadeCodes;

//	:TODO: Not really happy with the module name of "color_codes". Would like something better



//	Also add:
//	* fromCelerity(): |<case sensitive letter>
//	* fromPCBoard(): (@X<bg><fg>)
//	* fromWildcat(): (@<bg><fg>@ (same as PCBoard without 'X' prefix and '@' suffix)
//	* fromWWIV(): <ctrl-c><0-7>
//	* fromSyncronet(): <ctrl-a><colorCode>
//	See http://wiki.synchro.net/custom:colors
function renegadeToAnsi(s) {
	if(-1 == s.indexOf('|')) {
		return s;	//	no pipe codes present
	}

	var result	= '';
	var re		= /\|(\d{2}|\|)/g;
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

		assert(val >= 0 && val <= 256);	//	:TODO: should be <= 23 I believe

		var attr = '';
		if(7 == val) {
			attr = ansi.sgr('normal');
		} else if (val < 7 || val >= 16) {
			attr = ansi.sgr(['normal', val]);
		} else if (val <= 15) {
			attr = ansi.sgr(['normal', val - 8, 'bold']);
		}

		result += s.substr(lastIndex, m.index - lastIndex) + attr;
        lastIndex = re.lastIndex;
	}

    result = (0 === result.length ? s : result + s.substr(lastIndex));
    
    return result;
}

function stripRenegadeCodes(s) {
    return s.replace(/\|[\d]{2}/g, '');
}

