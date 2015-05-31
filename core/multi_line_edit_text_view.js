/* jslint node: true */
'use strict';

var View			= require('./view.js').View;
var miscUtil		= require('./misc_util.js');
var strUtil			= require('./string_util.js');
var ansi			= require('./ansi_term.js');

var assert			= require('assert');
var _				= require('lodash');
var GapBuffer		= require('gapbuffer').GapBuffer;

//
//	Notes
//	* options.tabSize can be used to resolve \t
//	* See https://github.com/dominictarr/hipster/issues/15 about insert/delete lines
//
//	Blessed
//		insertLine: CSR(top, bottom) + CUP(y, 0) + IL(1) + CSR(0, height)
//		deleteLine: CSR(top, bottom) + CUP(y, 0) + DL(1) + CSR(0, height)
//	Quick Ansi -- update only what was changed:
//	https://github.com/dominictarr/quickansi
//
//	This thread is awesome:
//	https://github.com/dominictarr/hipster/issues/15
//
//	See Atom's implementations
//	Newer TextDocument
//		https://github.com/atom/text-document
//
//	Older TextBuffer
//		http://www.oscon.com/oscon2014/public/schedule/detail/37593
//
//	Span Skip List could be used for mappings of rows/cols (display) to
//	character offsets in a buffer
//		https://github.com/atom/span-skip-list

//
//	Buffer: Actual text buffer
//	Transform: Display of soft wrap & tab expansion (e.g. tab -> ' ' * tabWidth)
//

//
//	General Design
//	
//	*	Take any existing input & word wrap into lines[] preserving
//		formatting characters.
//	*	When drawing, formatting characters are processed but not shown
//		or processed directly in many cases. E.g., \n is processed but simply
//		causes us to go to our "next line" visibly.
//	*	Empty/blank lines = \n
//
exports.MultiLineEditTextView	= MultiLineEditTextView;

//
//	Some resources & comparisons
//	
//	Enthral @ https://github.com/M-griffin/Enthral/blob/master/src/msg_fse.cpp
//		* Tabs are ignored
//		* Preview/reading mode processes colors, otherwise just text (e.g. editor)
//	
//	x84 @ https://github.com/jquast/x84/blob/master/x84/bbs/editor.py
//
//	Syncronet
//
//
//	Projects of use/interest:
//
//	https://github.com/atom/text-buffer
//	http://danieltao.com/lazy.js/
//	http://www.jbox.dk/downloads/edit.c
//	https://github.com/slap-editor/slap
//	https://github.com/chjj/blessed
//

//	need self.skipTabs(dir): if pos='\t', skip ahead (in dir) until reg char. This can be used @ up, left, right, down

function MultiLineEditTextView(options) {
	
	if(!_.isBoolean(options.acceptsFocus)) {
		options.acceptsFocus = true;
	}

	if(!_.isBoolean(this.acceptsInput)) {
		options.acceptsInput = true;
	}

	View.call(this, options);

	//
	//	defualt tabWidth is 4
	//	See the following:
	//	* http://www.ansi-bbs.org/ansi-bbs2/control_chars/
	//	* http://www.bbsdocumentary.com/library/PROGRAMS/GRAPHICS/ANSI/bansi.txt
	//
	this.tabWidth	= _.isNumber(options.tabWidth) ? options.tabWidth : 8;


	var self = this;

	this.renderBuffer	= [];
	this.textBuffer		= new GapBuffer(1024);

	this.lines			= [];				//	a given line is text...until EOL
	this.topLineIndex	= 0;
	this.cursorPos		= { row : 0, col : 0 };	//	relative to view window
	this.renderStartIndex	= 0;

	this.getTabString = function() {
		return new Array(self.tabWidth).join(' ');
	};

	this.getRenderLine = function(line) {
		//	:TODO: fix tabbing here
		line = line.replace(self.getReplaceTabsRegExp(), self.getTabString()).replace(/\n/g, '');
		var remain = self.dimens.width - line.length;
		if(remain > 0) {
			line += new Array(remain).join(' ');
		}
		return line;
	};

	this.redrawViewableText = function() {
		var row		= self.position.row;
		var bottom	= row + self.dimens.height;
		var i		= self.topLineIndex;

		self.client.term.write(self.getSGR());

		while(i < self.renderBuffer.length && row < bottom) {
			self.client.term.write(ansi.goto(row, this.position.col));
			self.client.term.write(self.getRenderLine(self.renderBuffer[i]));
			++row; 
			++i;
		}
	};

	this.wordWrap = function(line) {
		//
		//	Other implementations:
		//	* http://blog.macromates.com/2006/wrapping-text-with-regular-expressions/
		//	* http://james.padolsey.com/snippets/wordwrap-for-javascript/
		//	* http://phpjs.org/functions/wordwrap/
		//	* https://github.com/jonschlinkert/word-wrap
		//
		var re = new RegExp(
			'.{1,' + self.dimens.width + '}(\\s+|$)|\\S+?(\\s+|$)', 'g');
		return line.match(re) || [];
	};

	this.wordWrap3 = function(line, width) {
		var re = new RegExp('.{1,' + width + '}(\\s+|$)|\\S+?(\\s+|$)', 'g');  
	    return line.replace(/\t/g, new Array(self.tabWidth).join('\t')).match(re) || [];
	};

	this.updateRenderBuffer = function() {
		//
		//	We can estimate what is visible:
		//	* Starting point = start of buffer or previous LF from where we were previously
		//	* Ending point = start + width * height (max chars possible)
		//	If this system is kept, this can be optimized as per above
		//

		self.renderBuffer = [];
		//	:TODO: optimize this with asArray() taking the slice information
		var lines = self.textBuffer.asArray()//.slice(self.renderStartIndex, self.renderStartIndex + self.dimens.width * self.dimens.height)
			.join('')
			.split(/\r\n|\n|\r/g);

		var maxLines = self.dimens.height - self.position.row;
		
		for(var i = 0; i < lines.length && self.renderBuffer.length < maxLines; ++i) {
			if(0 === lines[i].length) {
				self.renderBuffer.push('');
			} else {
				Array.prototype.push.apply(self.renderBuffer, self.wordWrap3(lines[i] + '\n', self.dimens.width));
				
			}
		}
	};

	this.getReplaceTabsRegExp = function() {
		return new RegExp('\\t{' + (self.tabWidth - 1) + '}', 'g');
	};

	this.getTextBufferPosition = function(row, col) {
		var replaceTabsRe	= self.getReplaceTabsRegExp();
		var pos = 0;
		for(var r = 0; r < row; ++r) {
			if(self.renderBuffer[r].length > 0) {
				pos += self.renderBuffer[r].replace(replaceTabsRe, '\t').length;
			} else {
				pos += 1;
			}
		}

		pos += self.renderBuffer[row]
			.slice(0, Math.min(col, self.dimens.width))
			.replace(replaceTabsRe, '\t')			
			.length;

		return pos;
	};

	this.getLineTextLength = function(row) {
		return self.renderBuffer[row].replace(self.getReplaceTabsRegExp(), '\t').replace(/\n/g, '').length;
		//return self.renderBuffer[row].replace(/\n/g, '').length;
	};

	this.getRenderTextLength = function(row) {
		return self.renderBuffer[row].replace(/\n/g, '').length;
	};

	//	:TODO: this name makes no sense...
	this.getLineTextLengthToColumn = function(row, col) {
		return self.renderBuffer[row].replace(self.getReplaceTabsRegExp(), '\t').replace(/\n/g, '').slice(0, col).length;
	};

	this.getEndOfLineColumn = function(row) {
		if(!_.isNumber(row)) {
			row = self.cursorPos.row;
		}
		return self.getLineTextLength(row);
	};

	this.getAbsolutePosition = function(row, col) {
		if(!_.isNumber(row)) {
			row = self.cursorPos.row;
		}
		if(!_.isNumber(col)) {
			col = self.cursorPos.col;
		}
		return { row : self.position.row + row, col : self.position.col + col };
	};

	//	:TODO: rename this to show it is the *buffer*
	this.getCharAtCursorPosition = function() {
		var pos = self.getTextBufferPosition(self.cursorPos.row, self.cursorPos.col);
		return self.textBuffer.get(pos);
	};

	this.getRenderCharAtRowAndColumn = function(row, col) {
		return self.renderBuffer[row][col];
	};

	this.getRenderCharAtCursorPosition = function() {
		return self.getRenderCharAtRowAndColumn(self.cursorPos.row, self.cursorPos.col);
	};

	this.getRemainingRowsFromCurrent = function() {
		return Math.min(self.dimens.height, self.renderBuffer.length) - (self.cursorPos.row + 1);
	};

	this.moveCursorTo = function(row, col) {
		var absPos = self.getAbsolutePosition(row, col);
		self.client.term.write(ansi.goto(absPos.row, absPos.col));
	};
	
	this.scrollUp = function(count) {

	};

	this.scrollDown = function(count) {

	};	


	this.cursorMoveJumpTab = function(cursorDir) {
		if('\t' !== self.getRenderCharAtCursorPosition()) {
			return;	//	nothing to do
		}

		//
		//	A few scenarios:
		//	*	Cursor just moved up or down and we got dumped in the middle of a tab sequence. 
		//		:TODO: document: Jump to nearest tab right/left. This needs some more research
		//	* Cursor moved left or right: We should be on the first \t in either direction & need to jump
		//	* Tabs may expand to start/end of line -- in this case we should move to the next line
		//
		//	Example tab sequence when up/down (tabSize=8)
		//	Actual: Hello\tWorld!
		//	Render: Hello\t\t\t\t\t\t\t\tWorld!
		//                     ^-- cursor up from here
		//
		switch(cursorDir) {
			case 'left' :
				self.cursorPos.col -= (self.tabWidth - 1);
				if(self.cursorPos.col <= 0) {
					self.cursorToEndOfPreviousLine();
				} else {
					self.client.term.write(ansi.left(self.tabWidth - 1));
				}
				break;

			case 'right' :
				self.cursorPos.col += (self.tabWidth - 1);
				if(self.cursorPos.col >= self.dimens.width) {
					self.cursorToStartOfNextLine();
				} else {
					self.client.term.write(ansi.right(self.tabWidth - 1));
				}
				break;

			case 'up' :
			case 'down' :
				//
				//	We're going to move right, but we need to know where we're at in
				//	in the render buffer expanded tabs
				//
				//	:TODO: This is not right -- we need to move to *nearest*. Research how
				//	sublime/etc. treat this
				var col = self.cursorPos.col;
				var prevTabs = 0;
				while('\t' === self.getRenderCharAtRowAndColumn(self.cursorPos.row, col--)) {
					prevTabs++;
				}

				//console.log('prevTabs: ' + prevTabs)
				var adjust = self.tabWidth - prevTabs;
				self.cursorPos.col += adjust;
				self.client.term.write(ansi.right(adjust));
				break;
		}		
	};

	this.adjustColumnToEndOfLine = function() {
		var eolColumn = self.getEndOfLineColumn();
		if(self.cursorPos.col > eolColumn) {			
			self.cursorPos.col = eolColumn;
			var absPos = self.getAbsolutePosition(self.cursorPos.row, eolColumn);
			self.client.term.write(ansi.goto(absPos.row, absPos.col));
		}
	};


	this.cursorUp = function() {
		if(self.cursorPos.row > 0) {
			self.cursorPos.row--;
			self.client.term.write(ansi.up());

			self.cursorMoveJumpTab('up');
		} else if(self.topLineIndex > 0) {
			//	:TODO: scroll up if possible to do so
		}

		//	adjust to EOL position if needed
		self.adjustColumnToEndOfLine();	
	};

	this.cursorDown = function() {
		if(self.getRemainingRowsFromCurrent() > 0) {
			self.cursorPos.row++;
			self.client.term.write(ansi.down());

			self.cursorMoveJumpTab('down');
		} else {
			//	:TODO: scroll if possible
		}

		//	adjust to EOL position if needed
		self.adjustColumnToEndOfLine();
	};

	this.cursorLeft = function() {
		if(self.cursorPos.col > 0) {
			self.cursorPos.col--;
			self.client.term.write(ansi.left());

			self.cursorMoveJumpTab('left');
		} else {
			self.cursorToEndOfPreviousLine();
		}
	};

	this.cursorRight = function() {
		var rowVisibleLen = self.renderBuffer[self.cursorPos.row].replace(/\n/g, '').length;
		var max = Math.min(self.dimens.width, rowVisibleLen - 1);//selfself.getLineTextLength(self.cursorPos.row) - 1);
		console.log('self.dimens.width: ' + self.dimens.width + ' / lineLength: ' + (self.getLineTextLength(self.cursorPos.row) - 1))
		if(self.cursorPos.col < max) {
			self.cursorPos.col++;
			self.client.term.write(ansi.right());
			
			//	make tab adjustment if necessary
			self.cursorMoveJumpTab('right');
		} else {
			self.cursorToStartOfNextLine();			
		}
	};

	this.cursorToEndOfPreviousLine = function() {
		if(self.cursorPos.row > 0) {
			self.cursorPos.row--;
			self.cursorPos.col = self.getRenderTextLength(self.cursorPos.row) - 1;
			self.moveCursorTo(self.cursorPos.row, self.cursorPos.col);
		} else {
			//	can we scroll??!!!
		}
	};

	this.cursorToStartOfNextLine = function() {
		if(self.getRemainingRowsFromCurrent() > 0) {
			self.cursorPos.row++;
			self.cursorPos.col = 0;
			self.moveCursorTo(self.cursorPos.row, self.cursorPos.col);
		} else {
			//	:TODO: can we scroll??
		}
	};

	
	this.getLineIndex = function() {
		return self.topLineIndex + self.cursorPos.row;
	};

	this.insertCharacterAtCurrentPosition = function(c) {
		var pos = self.getTextBufferPosition(self.cursorPos.row, self.cursorPos.col);
		self.cursorPos.col++;
		self.client.term.write(c);
		self.textBuffer.insert(pos, c);
	};

}

require('util').inherits(MultiLineEditTextView, View);

MultiLineEditTextView.prototype.setPosition = function(pos) {
	MultiLineEditTextView.super_.prototype.setPosition.call(this, pos);

	
};

MultiLineEditTextView.prototype.redraw = function() {
	MultiLineEditTextView.super_.prototype.redraw.call(this);

	this.redrawViewableText();
	//this.client.term.write(this.text);
};

MultiLineEditTextView.prototype.setFocus = function(focused) {

	MultiLineEditTextView.super_.prototype.setFocus.call(this, focused);

	this.moveCursorTo(this.cursorPos.row, this.cursorPos.col);
	this.client.term.write(this.getSGR());
};


MultiLineEditTextView.prototype.setText = function(text) {
	//this.cursorPos.row = this.position.row + this.dimens.height;
	//this.lines = this.wordWrap(text);

	if(this.textBuffer.length > 0) {	//	:TODO: work around GapBuffer bug: if it's already empty this will cause gapEnd to be undefined
		this.textBuffer.clear();
	}

	//this.textBuffer.insertAll(0, text);
	text = text.replace(/\b/g, '');

	this.textBuffer.insertAll(0, text);

	this.updateRenderBuffer();

	console.log(this.renderBuffer)
	/*
	var idx = this.getTextBufferPosition(4, 0);
	for(var i = idx; i < idx + 4; ++i) {
		console.log(i + ' = "' + this.textBuffer.asArray()[i] + '"');
	}
	this.cursorPos.row = 15;
	this.cursorPos.col = 0;
	*/

	this.cursorPos.row = 14;
	this.cursorPos.col = 0;
};

MultiLineEditTextView.prototype.onKeyPress = function(key, isSpecial) {
	if(isSpecial) {
		return;
	}

	assert(1 === key.length);

	this.insertCharacterAtCurrentPosition(key);
	this.updateRenderBuffer();

	//	:TODO: is save/restore supported enough? Should we do it ourselves?
	this.client.term.write(ansi.savePos());
	//	:TODO: Just draw from position onward
	this.redraw();
	this.client.term.write(ansi.restorePos());


	MultiLineEditTextView.super_.prototype.onKeyPress.call(this, key, isSpecial);
};

MultiLineEditTextView.prototype.onSpecialKeyPress = function(keyName) {
	if(this.isSpecialKeyMapped('up', keyName)) {
		this.cursorUp();
	} else if(this.isSpecialKeyMapped('down', keyName)) {
		this.cursorDown();
	} else if(this.isSpecialKeyMapped('left', keyName)) {
		this.cursorLeft();
	} else if(this.isSpecialKeyMapped('right', keyName)) {
		this.cursorRight();
	}

	console.log(
		'row=' + this.cursorPos.row + ' / col=' + this.cursorPos.col + 
		' / abs=' + JSON.stringify(this.getAbsolutePosition()) + 
		': ' + this.getCharAtCursorPosition() + '( ' + this.getCharAtCursorPosition().charCodeAt(0) + ')')

	MultiLineEditTextView.super_.prototype.onSpecialKeyPress.call(this, keyName);
};
