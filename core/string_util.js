/* jslint node: true */
'use strict';

var miscUtil	= require('./misc_util.js');


exports.stylizeString	= stylizeString;
exports.pad				= pad;

//	:TODO: create Unicode verison of this
var VOWELS = [ 'a', 'e', 'i', 'o', 'u' ];

VOWELS.forEach(function onVowel(v) {
	VOWELS.push(v.toUpperCase());
});

var SIMPLE_ELITE_MAP = {
	'a' : '4',
	'e' : '3',
	'i' : '1',
	'o' : '0',
	's' : '5',
	't' : '7'
};

function stylizeString(s, style) {
	var len = s.length;
	var c;
	var i;
	var stylized = '';

	switch(style) {
		//	None/normal
		case 'normal' :
		case 'N' : return s;

		//	UPPERCASE
		case 'upper' : 
		case 'U' : return s.toUpperCase();

		//	lowercase
		case 'lower' :
		case 'l' : return s.toLowerCase();

		//	Title Case
		case 'title' :
		case 'T' :
			return s.replace(/\w\S*/g, function onProperCaseChar(t) {
				return t.charAt(0).toUpperCase() + t.substr(1).toLowerCase();
			});

		//	fIRST lOWER
		case 'first lower' :
		case 'f' :
			return s.replace(/\w\S*/g, function onFirstLowerChar(t) {
				return t.charAt(0).toLowerCase() + t.substr(1).toUpperCase();
			});

		//	SMaLL VoWeLS
		case 'small vowels' :
		case 'v' :
			for(i = 0; i < len; ++i) {
				c = s[i];
				if(-1 !== VOWELS.indexOf(c)) {
					stylized += c.toLowerCase();
				} else {
					stylized += c.toUpperCase();
				}
			}
			return stylized;

		//	bIg vOwELS
		case 'big vowels' :
		case 'V' :
			for(i = 0; i < len; ++i) {
				c = s[i];
				if(-1 !== VOWELS.indexOf(c)) {
					stylized += c.toUpperCase();
				} else {
					stylized += c.toLowerCase();
				}
			}
			return stylized;

		//	Small i's: DEMENTiA
		case 'small i' : 
		case 'i' : return s.toUpperCase().replace('I', 'i');

		//	mIxeD CaSE (random upper/lower)
		case 'mixed' :
		case 'M' :
			for(i = 0; i < len; i++) {
				if(Math.random() < 0.5) {
					stylized += s[i].toUpperCase();
				} else {
					stylized += s[i].toLowerCase();
				}
			}
			return stylized;

		//	l337 5p34k
		case 'l33t' :
		case '3' :
			for(i = 0; i < len; ++i) {
				c = SIMPLE_ELITE_MAP[s[i].toLowerCase()];
				stylized += c || s[i];				
			}
			return stylized;
	}

	return s;
}

//	Based on http://www.webtoolkit.info/
function pad(s, len, padChar, dir, stringColor, padColor) {
	len			= miscUtil.valueWithDefault(len, 0);
	padChar		= miscUtil.valueWithDefault(padChar, ' ');
	dir			= miscUtil.valueWithDefault(dir, 'right');
	stringColor	= miscUtil.valueWithDefault(stringColor, '');
	padColor	= miscUtil.valueWithDefault(padColor, '');

	var padlen	= len - s.length;

	switch(dir) {
		case 'L' :
		case 'left' : 
			s = padColor + new Array(padlen).join(padChar) + stringColor + s;
			break;

		case 'C' :
		case 'center' :
		case 'both' : 
			var right	= Math.ceil(padlen / 2);
			var left	= padlen - right;
			s			= padColor + new Array(left + 1).join(padChar) + stringColor + s + padColor + new Array(right + 1).join(padChar);
			break;

		case 'R' : 
		case 'right' :
			s = stringColor + s + padColor + new Array(padlen).join(padChar);
			break;

		default : break;
	}

	return stringColor + s;
}
