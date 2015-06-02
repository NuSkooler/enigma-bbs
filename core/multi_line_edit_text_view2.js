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

	this.textLines			= [];
	this.topVisibleIndex	= 0;
	this.cursorPos			= { col : 0, row : 0 };

	this.redrawVisibleArea = function() {
		assert(self.topVisibleIndex < self.textLines.length);

		self.client.term.write(self.getSGR());
		self.client.term.write(ansi.hideCursor());

		var bottomIndex = Math.min(self.topVisibleIndex + self.dimens.height, self.textLines.length);
		var row			= self.position.row;
		for(var i = self.topVisibleIndex; i < bottomIndex; i++) {
			self.client.term.write(ansi.goto(row, this.position.col));
			//self.client.term.write(self.getRenderText(self.textLines[i].text));
			self.client.term.write(self.getRenderText(i));
			++row;
		}
		self.client.term.write(ansi.showCursor());
	};

	this.getVisibleText = function(index) {
		return self.textLines[index].text.replace(/\t/g, ' ');	
	};

	this.getRenderText = function(index) {
		var text = self.getVisibleText(index);
		var remain	= self.dimens.width - text.length;
		if(remain > 0) {
			text += new Array(remain).join(' ');
		}
		return text;
	};

	/*
	this.getRenderText = function(text) {
		text = text.replace(/\t/g, ' ');
		var remain = self.dimens.width - text.length;
		if(remain > 0) {
			text += new Array(remain).join(' ');
		}
		return text;
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
		//	note: we cannot simply use \s below as it includes \t
		var re = new RegExp(
			'\t|[ \f\n\r\v​\u00a0\u1680​\u180e\u2000​\u2001\u2002​\u2003\u2004\u2005\u2006​' + 
			'\u2007\u2008​\u2009\u200a​\u2028\u2029​\u202f\u205f​\u3000]+', 'g');
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
				word = s.substring(wordStart, re.lastIndex - 1);

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
		//	:TODO: support row/col insertion point

		if(_.isNumber(row)) {
			if(_.isNumber(col)) {
				//
				//	Modify text to have information from row
				//	before and and after column
				//
				//	:TODO: Need to clean this string (e.g. collapse tabs)
				text = self.textLines

				//	:TODO: Remove original line @ row
			}
		} else {
			row = self.textLines.length;
		}

		var tempLines = text
			.replace(/\b/g, '')
			.split(/\r\n|[\n\v\f\r\x85\u2028\u2029]/g);

		var wrapped;
		
		for(var i = 0; i < tempLines.length; ++i) {
			wrapped = self.wordWrapSingleLine(tempLines[i], self.dimens.width);

			for(var j = 0; j < wrapped.length - 1; ++j) {
				self.textLines.splice(row++, 0, { text : wrapped[j] } );
			}
			self.textLines.splice(row++, 0, { text : wrapped[wrapped.length - 1], eol : true });
		}
	};

	this.getAbsolutePosition = function(row, col) {
		return { row : self.position.row + self.cursorPos.row, col : self.position.col + self.cursorPos.col };
	};

	this.moveClientCusorToCursorPos = function() {
		var absPos = self.getAbsolutePosition(self.cursorPos.row, self.cursorPos.col);
		self.client.term.write(ansi.goto(absPos.row, absPos.col));
	};

	this.cursorUp = function() {
		console.log('up')
	};

	this.cursorDown = function() {
	};

	this.cursorLeft = function() {

	};

	this.cursorRight = function() {
		var colEnd = self.getVisibleText(self.cursorPos.row).length;
		if(self.cursorPos.col < colEnd) {
			self.cursorPos.col++;
			self.client.term.write(ansi.right());
		} else {
			//	:TODO: goto next line; scroll if needed, etc.
		}
	};

	this.cursorHome = function() {
		self.topVisibleIndex	= 0;
		self.cursorPos			= { row : 0, col : 0 };

		self.redraw();
		self.moveClientCusorToCursorPos();
	};

	this.cursorEnd = function() {
		self.topVisibleIndex	= Math.max(self.textLines.length - self.dimens.height, 0);
		var row					= (self.textLines.length - self.topVisibleIndex) - 1;
		
		self.cursorPos			= { 
			row : row,
			col : self.getVisibleText(row).length
		};

		self.redraw();
		self.moveClientCusorToCursorPos();
	};
}

require('util').inherits(MultiLineEditTextView2, View);

MultiLineEditTextView2.prototype.redraw = function() {
	MultiLineEditTextView2.super_.prototype.redraw.call(this);

	this.redrawVisibleArea();
};

MultiLineEditTextView2.prototype.setText = function(text) {
	this.textLines = [];
	//text = 'Supper fluffy bunny test thing\nHello, everyone!\n\nStuff and thing and what nots\r\na\tb\tc\td\te';
	//text = "You. Now \ttomorrow \tthere'll \tbe \ttwo \tsessions, \tof\t course, morning and afternoon.";
	this.insertText(text);//, 0, 0);

	console.log(this.textLines)
};

MultiLineEditTextView2.prototype.onSpecialKeyPress = function(keyName) {

	var self = this;

	[ 'up', 'down', 'left', 'right', 'home', 'end' ].forEach(function key(arrowKey) {
		if(self.isSpecialKeyMapped(arrowKey, keyName)) {
			self['cursor' + arrowKey.substring(0,1).toUpperCase() + arrowKey.substring(1)]();
		}
	});

	MultiLineEditTextView2.super_.prototype.onSpecialKeyPress.call(this, keyName);
};
