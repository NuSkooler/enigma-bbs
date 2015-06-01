/* jslint node: true */
'use strict';

var View			= require('./view.js').View;
var miscUtil		= require('./misc_util.js');
var strUtil			= require('./string_util.js');
var ansi			= require('./ansi_term.js');
//var TextBuffer		= require('./text_buffer.js').TextBuffer;

var assert			= require('assert');
var _				= require('lodash');

exports.MultiLineEditTextView2	= MultiLineEditTextView2;

function MultiLineEditTextView2(options) {
	if(!_.isBoolean(options.acceptsFocus)) {
		options.acceptsFocus = true;
	}

	if(!_.isBoolean(this.acceptsInput)) {
		options.acceptsInput = true;
	}

	View.call(this, options);

	var self = this;

	//
	//	ANSI seems to want tabs to default to 8 characters. See the following:
	//	* http://www.ansi-bbs.org/ansi-bbs2/control_chars/
	//	* http://www.bbsdocumentary.com/library/PROGRAMS/GRAPHICS/ANSI/bansi.txt
	//
	this.tabWidth	= _.isNumber(options.tabWidth) ? options.tabWidth : 8;


	this.textLines	= [];

	this.redrawVisibleArea = function() {

	};

	/*
	this.wordWrap = function(s, width) {
		var re = new RegExp('.{1,' + width + '}(\\s+|$)|\\S+?(\\s+|$)', 'g');
		return s.match(re) || [];
	};
	*/

	this.expandTab = function(col, expandChar) {
		expandChar = expandChar || ' ';
		var count = self.tabWidth - (col % self.tabWidth);
		return new Array(count).join(expandChar);
	};

	this.wordWrapSingleLine = function(s, width) {
		//
		//	Notes
		//	*	Sublime Text 3 for example considers spaces after a word
		//		part of said word. For example, "word    " would be wraped
		//		in it's entirity.
		//
		//	*	Tabs in Sublime Text 3 are also treated as a word, so, e.g.
		//		"\t" may resolve to "      " and must fit within the space.
		//
		var tabCount = self.dimens.width / self.tabWidth;
		var re = /\t|\s+/g;
		var m;
		var wordStart;
		var wrapped = [ '' ];
		var i = 0;
		var word;

		function addWord() {
			if(wrapped[i].length + word.length > self.dimens.width) {
				wrapped[++i] = word;
			} else {
				wrapped[i] += word;
			}
		}

		do {
			wordStart	= re.lastIndex + (_.isObject(m) ? m[0].length - 1 : 0);
			m			= re.exec(s);

			if(null !== m) {
				word = s.substring(wordStart, re.lastIndex);
				console.log(m)

				switch(m[0].charAt(0)) {
					case ' ' :
						word += m[0];
					break;

					case '\t' :
						//
						//	Expand tab given position
						//
						word += self.expandTab(wrapped[i].length, '\t');
					break;
				}

				addWord();
			}
		} while(0 !== re.lastIndex);

		//
		//	Remainder
		//
		word = s.substring(wordStart);
		addWord();

		return wrapped;
	};

	this.insertText = function(text, row, col) {
		//
		//	Perform the following on |text|:
		//	*	Normalize various line feed formats -> \n
		//	*	Remove some control characters (e.g. \b)
		//	*	Word wrap lines such that they fit in the visible workspace.
		//		Each actual line will then take 1:n elements in textLines[].
		//	*	Each tab will be appropriately expanded and take 1:n \t
		//		characters. This allows us to know when we're in tab space
		//		when doing cursor movement/etc.
		//
		//
		//	Try to handle any possible newline that can be fed to us.
		//	See http://stackoverflow.com/questions/5034781/js-regex-to-split-by-line
		//
		var tempLines = text
			.replace(/\b/g, '')
			.split(/\r\n|[\n\v\f\r\x85\u2028\u2029]/g);

		var wrapped;
		for(var i = 0; i < tempLines.length; ++i) {
			wrapped = self.wordWrapSingleLine(tempLines[i], self.dimens.width);
			console.log(wrapped)
		}
	};
}

require('util').inherits(MultiLineEditTextView2, View);

MultiLineEditTextView2.prototype.redraw = function() {
	MultiLineEditTextView2.super_.prototype.redraw.call(this);

	this.redrawVisibleArea();
};

MultiLineEditTextView2.prototype.setText = function(text) {
	this.textLines = [];
	this.insertText(text, 0, 0);

	console.log(this.textLines)
};