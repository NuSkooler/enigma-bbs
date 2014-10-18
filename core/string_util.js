/* jslint node: true */
'use strict';

exports.stylizeString	= stylizeString;

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
		//	UPPERCASE
		case 'U' : return s.toUpperCase();

		//	lowercase
		case 'l' : return s.toLowerCase();

		//	Proper Case
		case 'P' :
			return s.replace(/\w\S*/g, function onProperCaseChar(t) {
				return t.charAt(0).toUpperCase() + t.substr(1).toLowerCase();
			});

		//	fIRST lOWER
		case 'f' :
			return s.replace(/\w\S*/g, function onFirstLowerChar(t) {
				return t.charAt(0).toLowerCase() + t.substr(1).toUpperCase();
			});

		//	SMaLL VoWeLS
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
		case 'i' : return s.toUpperCase().replace('I', 'i');

		//	mIxeD CaSE (random upper/lower)
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
		case '3' :
			for(i = 0; i < len; ++i) {
				c = SIMPLE_ELITE_MAP[s[i].toLowerCase()];
				stylized += c || s[i];				
			}
			return stylized;
	}

	return s;
}