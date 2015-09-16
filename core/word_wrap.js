/* jslint node: true */
'use strict';

var assert				= require('assert');
var _					= require('lodash');

exports.wordWrapText	= wordWrapText;

function wordWrapText(text, options) {
	//
	//	options.*:
	//		width			: word wrap width
	//		tabHandling		: expand (default=expand)
	//		tabWidth		: tab width if tabHandling is 'expand' (default=4)
	//
	assert(_.isObject(options),			'Missing options!');
	assert(_.isNumber(options.width),	'Missing options.width!');

	options.tabHandling = options.tabHandling || 'expand';
	
	if(!_.isNumber(options.tabWidth)) {
		options.tabWidth = 4;
	}

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
		return new Array(remainWidth).join('\t');
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
					word += expandTab(results.wrapped[i].length + word.length) + '\t';
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