/* jslint node: true */
'use strict';

var assert					= require('assert');
var _						= require('lodash');
const renderStringLength	= require('./string_util.js').renderStringLength; 

exports.wordWrapText	= wordWrapText2;

const SPACE_CHARS		= [
	' ', '\f', '\n', '\r', '\v', 
	'​\u00a0', '\u1680', '​\u180e', '\u2000​', '\u2001', '\u2002', '​\u2003', '\u2004',
	'\u2005', '\u2006​', '\u2007', '\u2008​', '\u2009', '\u200a​', '\u2028', '\u2029​', 
	'\u202f', '\u205f​', '\u3000',
];

const REGEXP_WORD_WRAP = new RegExp(`\t|[${SPACE_CHARS.join('')}]`, 'g'); 

/*
//
//	ANSI & pipe codes we indend to strip
//
//	See also https://github.com/chalk/ansi-regex/blob/master/index.js
//
//	:TODO: Consolidate this, regexp's in ansi_escape_parser, and strutil. Need more complete set that includes common standads, bansi, and cterm.txt
//	renderStringLength() from strUtil does not account for ESC[<N>C (e.g. go forward)
const REGEXP_CONTROL_CODES = /(\|[\d]{2})|(?:\x1b\x5b)([\?=;0-9]*?)([ABCDHJKfhlmnpsu])/g;

function getRenderLength(s) {
	let m;
	let pos;
	let len = 0;

	REGEXP_CONTROL_CODES.lastIndex = 0;	//	reset
	
	//
	//	Loop counting only literal (non-control) sequences
	//	paying special attention to ESC[<N>C which means forward <N>
	//	
	do {
		pos	= REGEXP_CONTROL_CODES.lastIndex;
		m	= REGEXP_CONTROL_CODES.exec(s);
		
		if(null !== m) {
			if(m.index > pos) {
				len += s.slice(pos, m.index).length;
			}
			
			if('C' === m[3]) {	//	ESC[<N>C is foward/right
				len += parseInt(m[2], 10) || 0;
			}
		}  
	} while(0 !== REGEXP_CONTROL_CODES.lastIndex);
	
	if(pos < s.length) {
		len += s.slice(pos).length;
	}
	
	return len;
}
*/

function wordWrapText2(text, options) {
	assert(_.isObject(options));
	assert(_.isNumber(options.width));
	
	options.tabHandling	= options.tabHandling || 'expand';
	options.tabWidth	= options.tabWidth || 4;
	options.tabChar		= options.tabChar || ' ';		
	
	const REGEXP_GOBBLE = new RegExp(`.{0,${options.width}}`, 'g');
	
	let m;
	let word;
	let c;
	let renderLen;
	let i			= 0;
	let wordStart	= 0;
	let result		= { wrapped : [ '' ], renderLen : [] };
	
	function expandTab(column) {
		const remainWidth = options.tabWidth - (column % options.tabWidth);
		return new Array(remainWidth).join(options.tabChar);
	}
	
	function appendWord() {
		word.match(REGEXP_GOBBLE).forEach( w => {
			renderLen = renderStringLength(w);
			
			if(result.renderLen[i] + renderLen > options.width) {
				if(0 === i) {
					result.firstWrapRange = { start : wordStart, end : wordStart + w.length };
				}
				
				result.wrapped[++i]	= w;
				result.renderLen[i]	= renderLen;
			} else {
				result.wrapped[i] 	+= w;				
				result.renderLen[i] = (result.renderLen[i] || 0) + renderLen;				
			}
		});
	}
	
	//
	//	Some of the way we word wrap is modeled after Sublime Test 3:
	//
	//	*	Sublime Text 3 for example considers spaces after a word
	//		part of said word. For example, "word    " would be wraped
	//		in it's entirity.
	//
	//	*	Tabs in Sublime Text 3 are also treated as a word, so, e.g.
	//		"\t" may resolve to "      " and must fit within the space.
	//
	//	*	If a word is ultimately too long to fit, break it up until it does.
	//	
	while(null !== (m = REGEXP_WORD_WRAP.exec(text))) {
		word = text.substring(wordStart, REGEXP_WORD_WRAP.lastIndex - 1);
		
		c = m[0].charAt(0);
		if(SPACE_CHARS.indexOf(c) > -1) {
			word += m[0];
		} else if('\t' === c) {
			if('expand' === options.tabHandling) {
				//	Good info here: http://c-for-dummies.com/blog/?p=424
				word += expandTab(result.wrapped[i].length + word.length) + options.tabChar;
			} else {
				word += m[0];
			}
		}
		
		appendWord();
		wordStart = REGEXP_WORD_WRAP.lastIndex + m[0].length - 1;
	}
	
	word = text.substring(wordStart);
	appendWord();
	
	return result;
}

function wordWrapText(text, options) {
	//
	//	options.*:
	//		width			: word wrap width
	//		tabHandling		: expand (default=expand)
	//		tabWidth		: tab width if tabHandling is 'expand' (default=4)
	//		tabChar			: character to use for tab expansion
	//
	assert(_.isObject(options),			'Missing options!');
	assert(_.isNumber(options.width),	'Missing options.width!');

	options.tabHandling = options.tabHandling || 'expand';
	
	if(!_.isNumber(options.tabWidth)) {
		options.tabWidth = 4;
	}

	options.tabChar = options.tabChar || ' ';

	//
	//	Notes
	//	*	Sublime Text 3 for example considers spaces after a word
	//		part of said word. For example, "word    " would be wraped
	//		in it's entirity.
	//
	//	*	Tabs in Sublime Text 3 are also treated as a word, so, e.g.
	//		"\t" may resolve to "      " and must fit within the space.
	//
	//	*	If a word is ultimately too long to fit, break it up until it does.
	//
	//	RegExp below is JavaScript '\s' minus the '\t'
	//
	var re = new RegExp(
		'\t|[ \f\n\r\v​\u00a0\u1680​\u180e\u2000​\u2001\u2002​\u2003\u2004\u2005\u2006​' + 
		'\u2007\u2008​\u2009\u200a​\u2028\u2029​\u202f\u205f​\u3000]', 'g');
	var m;
	var wordStart = 0;
	var results = { wrapped : [ '' ] };
	var i = 0;
	var word;
	var wordLen;

	function expandTab(col) {
		var remainWidth = options.tabWidth - (col % options.tabWidth);
		return new Array(remainWidth).join(options.tabChar);
	}

	//	:TODO: support wrapping pipe code text (e.g. ignore color codes, expand MCI codes)

	function addWord() {
		word.match(new RegExp('.{0,' + options.width + '}', 'g')).forEach(function wrd(w) {
			//wordLen = self.getStringLength(w);

			if(results.wrapped[i].length + w.length > options.width) {
			//if(results.wrapped[i].length + wordLen > width) {
				if(0 === i) {
					results.firstWrapRange = { start : wordStart, end : wordStart + w.length };
					//results.firstWrapRange = { start : wordStart, end : wordStart + wordLen };
				}
				//	:TODO: Must handle len of |w| itself > options.width & split how ever many times required (e.g. handle paste)
				results.wrapped[++i] = w;
			} else {
				results.wrapped[i] += w;
			}
		});
	}

	while((m = re.exec(text)) !== null) {
		word = text.substring(wordStart, re.lastIndex - 1);

		switch(m[0].charAt(0)) {
			case ' ' :
				word += m[0];
				break;

			case '\t' :
				//
				//	Expand tab given position
				//
				//	Nice info here: http://c-for-dummies.com/blog/?p=424
				//
				if('expand' === options.tabHandling) {
					word += expandTab(results.wrapped[i].length + word.length) + options.tabChar;
				} else {
					word += m[0];
				}
				break;
		}

		addWord();
		wordStart = re.lastIndex + m[0].length - 1;
	}

	//
	//	Remainder
	//
	word = text.substring(wordStart);
	addWord();

	return results;
}

//const input = 'Hello, |04World! This |08i|02s a test it is \x1b[20Conly a test of the emergency broadcast system. What you see is not a joke!';
//const input = "Lorem Ipsum is simply dummy text of the printing and typesetting industry. Lorem Ipsum has been the industry's standard dummy text ever since the 1500s, when an unknown printer took a galley of type and scrambled it to make a type specimen book. It has survived not only five enturies, but also the leap into electronic typesetting, remaining essentially unchanged. It was popularised in the 1960s with the release of Letraset sheets containing Lorem Ipsum passages, and more recently with desktop publishing software like Aldus PageMaker including versions of Lorem Ipsum.";

/*
const iconv = require('iconv-lite');
const input = iconv.decode(require('graceful-fs').readFileSync('/home/nuskooler/Downloads/msg_out.txt'), 'cp437');

const opts = {
	width : 80,
};

console.log(wordWrapText2(input, opts).wrapped, 'utf8')
*/