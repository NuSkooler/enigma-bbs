/* jslint node: true */
'use strict';

var View			= require('./view.js').View;
var miscUtil		= require('./misc_util.js');
var strUtil			= require('./string_util.js');
var ansi			= require('./ansi_term.js');
//var TextBuffer		= require('./text_buffer.js').TextBuffer;

var assert			= require('assert');
var _				= require('lodash');

//	:TODO: Determine CTRL-* keys for various things
	//	See http://www.bbsdocumentary.com/library/PROGRAMS/GRAPHICS/ANSI/bansi.txt
	//	http://wiki.synchro.net/howto:editor:slyedit#edit_mode
	//	http://sublime-text-unofficial-documentation.readthedocs.org/en/latest/reference/keyboard_shortcuts_win.html

	/* Mystic
	 [^B]  Reformat Paragraph            [^O]  Show this help file
       [^I]  Insert tab space              [^Q]  Enter quote mode
       [^K]  Cut current line of text      [^V]  Toggle insert/overwrite
       [^U]  Paste previously cut text     [^Y]  Delete current line


                            BASIC MOVEMENT COMMANDS

                  UP/^E       LEFT/^S      PGUP/^R      HOME/^F
                DOWN/^X      RIGHT/^D      PGDN/^C       END/^G
*/

var SPECIAL_KEY_MAP_DEFAULT = {
	lineFeed	: [ 'return' ],
	exit		: [ 'esc' ],
	backspace	: [ 'backspace' ],
	del			: [ 'del' ],
	tabs		: [ 'tab' ],
	up			: [ 'up arrow' ],
	down		: [ 'down arrow' ],
	end			: [ 'end' ],
	home		: [ 'home' ],
	left		: [ 'left arrow' ],
	right		: [ 'right arrow' ],
	clearLine	: [ 'ctrl + y' ],
	pageUp		: [ 'page up' ],
	pageDown	: [ 'page down' ],
};

exports.MultiLineEditTextView2	= MultiLineEditTextView2;

function MultiLineEditTextView2(options) {
	if(!_.isBoolean(options.acceptsFocus)) {
		options.acceptsFocus = true;
	}

	if(!_.isBoolean(this.acceptsInput)) {
		options.acceptsInput = true;
	}

	if(!_.isObject(options.specialKeyMap)) {
		options.specialKeyMap = SPECIAL_KEY_MAP_DEFAULT;
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

	//
	//	cursorPos represents zero-based row, col positions
	//	within the editor itself
	//
	this.cursorPos			= { col : 0, row : 0 };

	//	:TODO: Most of the calls to this could be avoided via incrementRow(), decrementRow() that keeps track or such
	this.getTextLinesIndex = function(row) {
		if(!_.isNumber(row)) {
			row = self.cursorPos.row;
		}
		var index = self.topVisibleIndex + row;
		return index;
	};

	this.redrawVisibleArea = function() {
		assert(self.topVisibleIndex < self.textLines.length);

		self.client.term.write(self.getSGR());
		self.client.term.write(ansi.hideCursor());

		var bottomIndex = Math.min(self.topVisibleIndex + self.dimens.height, self.textLines.length);
		var row			= self.position.row;
		for(var i = self.topVisibleIndex; i < bottomIndex; i++) {
			self.client.term.write(ansi.goto(row, this.position.col));
			self.client.term.write(self.getRenderText(i));
			++row;
		}
		self.client.term.write(ansi.showCursor());
	};

	this.getVisibleText = function(index) {
		if(!_.isNumber(index)) {
			index = self.getTextLinesIndex();
		}
		return self.textLines[index].text.replace(/\t/g, ' ');	
	};

	this.getText = function(index) {
		if(!_.isNumber(index)) {
			index = self.getTextLinesIndex();
		}
		return self.textLines[index].text;
	};

	this.getTextEndOfLineColumn = function(index) {
		return Math.max(0, self.getText(index).length - 1);
	};

	this.getRenderText = function(index) {
		var text = self.getVisibleText(index);
		var remain	= self.dimens.width - text.length;
		if(remain > 0) {
			text += new Array(remain).join(' ');
		}
		return text;
	};

	this.replaceCharacterInText = function(c, index, col) {
		self.textLines[index].text = strUtil.replaceAt(
			self.textLines[index].text, col, c);
	};

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

	//	:TODO: Change this to (text, row, col) & make proper adjustments
	this.insertText = function(text, index, col) {
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
		//	:TODO: support index/col insertion point

		if(_.isNumber(index)) {
			if(_.isNumber(col)) {
				//
				//	Modify text to have information from index
				//	before and and after column
				//
				//	:TODO: Need to clean this string (e.g. collapse tabs)
				text = self.textLines

				//	:TODO: Remove original line @ index
			}
		} else {
			index = self.textLines.length;
		}

		var tempLines = text
			.replace(/\b/g, '')
			.split(/\r\n|[\n\v\f\r\x85\u2028\u2029]/g);

		var wrapped;
		
		for(var i = 0; i < tempLines.length; ++i) {
			wrapped = self.wordWrapSingleLine(tempLines[i], self.dimens.width);

			for(var j = 0; j < wrapped.length - 1; ++j) {
				self.textLines.splice(index++, 0, { text : wrapped[j] } );
			}
			self.textLines.splice(index++, 0, { text : wrapped[wrapped.length - 1], eol : true });
		}
	};

	this.getAbsolutePosition = function(row, col) {
		return { row : self.position.row + self.cursorPos.row, col : self.position.col + self.cursorPos.col };
	};

	this.moveClientCusorToCursorPos = function() {
		var absPos = self.getAbsolutePosition(self.cursorPos.row, self.cursorPos.col);
		self.client.term.write(ansi.goto(absPos.row, absPos.col));
	};

	this.keyPressCharacter = function(c, row, col) {

		var index = self.getTextLinesIndex(row);
		if(!_.isNumber(col)) {
			col = self.cursorPos.col;
		}

		//	:TODO: Even in overtypeMode, word wrapping must apply for e.g.
		//	if a user types past bounds

		if(self.overtypeMode) {
			//	:TODO: special handing for insert over eol mark?
			self.replaceCharacterInText(c, index, col);
			self.cursorPos.col++;
			self.client.term.write(c);
		} else {

		}

	};

	this.keyPressUp = function() {
		if(self.cursorPos.row > 0) {
			self.cursorPos.row--;
			self.client.term.write(ansi.up());

			//	:TODO: self.makeTabAdjustment('up')
			self.adjustCursorIfPastEndOfLine(false);
		} else {
			self.scrollDocumentDown();
			self.adjustCursorIfPastEndOfLine(true);
		}
	};

	this.keyPressDown = function() {
		var lastVisibleRow = Math.min(self.dimens.height, self.textLines.length) - 1;
		if(self.cursorPos.row < lastVisibleRow) {
			self.cursorPos.row++;
			self.client.term.write(ansi.down());

			//	:TODO: make tab adjustment if needed

			self.adjustCursorIfPastEndOfLine(false);
		} else {
			self.scrollDocumentUp();
			self.adjustCursorIfPastEndOfLine(true);
		}
	};

	this.keyPressLeft = function() {
		if(self.cursorPos.col > 0) {
			self.cursorPos.col--;
			self.client.term.write(ansi.left());
			//	:TODO: handle landing on a tab
		} else {
			//	:TODO: goto previous line if possible and scroll if needed
		}
	};

	this.keyPressRight = function() {
		var eolColumn = self.getTextEndOfLineColumn();
		if(self.cursorPos.col < eolColumn) {
			self.cursorPos.col++;
			self.client.term.write(ansi.right());

			//	:TODO: handle landing on a tab
		} else {
			//	:TODO: goto next line; scroll if needed, etc.

		}
	};

	this.keyPressHome = function() {
		var firstNonWhitespace = self.getVisibleText().search(/\S/);
		if(-1 !== firstNonWhitespace) {
			self.cursorPos.col = firstNonWhitespace;
		} else {
			self.cursorPos.col = 0;
		}
		console.log(self.getVisibleText())
		self.moveClientCusorToCursorPos();
	};

	this.keyPressEnd = function() {
		self.cursorPos.col = self.getTextEndOfLineColumn();
		self.moveClientCusorToCursorPos();
	};

	this.keyPressPageUp = function() {

	};

	this.keyPressPageDown = function() {

	};

	this.keyPressLineFeed = function() {

	};

	this.adjustCursorIfPastEndOfLine = function(alwaysUpdateCursor) {
		var eolColumn = self.getTextEndOfLineColumn();
		if(self.cursorPos.col > eolColumn) {
			self.cursorPos.col = eolColumn;
			alwaysUpdateCursor = true;
		}

		if(alwaysUpdateCursor) {
			self.moveClientCusorToCursorPos();
		}
	};

	this.cursorStartOfDocument = function() {
		self.topVisibleIndex	= 0;
		self.cursorPos			= { row : 0, col : 0 };

		self.redraw();
		self.moveClientCusorToCursorPos();
	};

	this.cursorEndOfDocument = function() {
		self.topVisibleIndex	= Math.max(self.textLines.length - self.dimens.height, 0);
		self.cursorPos.row		= (self.textLines.length - self.topVisibleIndex) - 1;
		self.cursorPos.col		= self.getTextEndOfLineColumn();

		self.redraw();
		self.moveClientCusorToCursorPos();
	};

	this.scrollDocumentUp = function() {
		//
		//	Note: We scroll *up* when the cursor goes *down* beyond
		//	the visible area!
		//
		var linesBelow = self.textLines.length - (self.topVisibleIndex + self.cursorPos.row) - 1;
		if(linesBelow > 0) {
			self.topVisibleIndex++;
			self.redraw();
		}
	};

	this.scrollDocumentDown = function() {
		//
		//	Note: We scroll *down* when the cursor goes *up* beyond
		//	the visible area!
		//
		if(self.topVisibleIndex > 0) {
			self.topVisibleIndex--;
			self.redraw();
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
	//text = 'Supper fluffy bunny test thing\nHello, everyone!\n\nStuff and thing and what nots\r\na\tb\tc\td\te';
	//text = "You. Now \ttomorrow \tthere'll \tbe \ttwo \tsessions, \tof\t course, morning and afternoon.";
	this.insertText(text);//, 0, 0);
	this.cursorEndOfDocument();

	this.overtypeMode = true;	//	:TODO: remove... testing
};

var HANDLED_SPECIAL_KEYS = [
	'up', 'down', 'left', 'right', 
	'home', 'end',
	'pageUp', 'pageDown',
	'lineFeed',
];

MultiLineEditTextView2.prototype.onKeyPress = function(ch, key) {
	var self = this;
	var handled;

	if(key) {		
		HANDLED_SPECIAL_KEYS.forEach(function aKey(specialKey) {
			if(self.isSpecialKeyMapped(specialKey, key.name)) {
				self[_.camelCase('keyPress ' + specialKey)]();
				handled = true;
			}
		});
	}

	if(ch && strUtil.isPrintable(ch)) {
		this.keyPressCharacter(ch);
	}

	if(!handled) {
		MultiLineEditTextView2.super_.prototype.onSpecialKeyPress.call(this, key.name);
	}
};

/*
MultiLineEditTextView2.prototype.onKeyPress = function(key, isSpecial) {
	if(isSpecial) {
		return;
	}

	this.keyPressCharacter(key);

	MultiLineEditTextView2.super_.prototype.onKeyPress.call(this, key, isSpecial);
};



MultiLineEditTextView2.prototype.onSpecialKeyPress = function(keyName) {

	var self = this;

	console.log(keyName);

	
	var handled = false;
	HANDLED_SPECIAL_KEYS.forEach(function key(arrowKey) {
		if(self.isSpecialKeyMapped(arrowKey, keyName)) {
			self[_.camelCase('keyPress ' + arrowKey)]();
			handled = true;
		}
	});

	if(!handled) {
		MultiLineEditTextView2.super_.prototype.onSpecialKeyPress.call(this, keyName);
	}
};
*/