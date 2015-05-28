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

	this.getRenderLine = function(line) {
		var replaceTabsRe	= new RegExp('\\t{' + (self.tabWidth - 1) + '}', 'g');
		var tabSpaces		= new Array(self.tabWidth).join(' ');
		return line.replace(replaceTabsRe, tabSpaces).replace(/\n/g, '');
	};

	this.updateRenderBuffer = function() {
		self.renderBuffer = [];
		//	:TODO: optimize this with asArray() taking the slice information
		var lines = self.textBuffer.asArray().slice(self.renderStartIndex, self.renderStartIndex + self.dimens.width * self.dimens.height)
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
			.replace(replaceTabsRe, '\t')
			.slice(0, Math.min(col, self.dimens.width))
			.length;
		return pos;
	};

	this.getLineTextLength = function(row) {
		return self.renderBuffer[row].replace(self.getReplaceTabsRegExp(), '\t').replace(/\n/g, '').length;
		//return self.renderBuffer[row].replace(/\n/g, '').length;
	};

	this.getLineTextLengthToColumn = function(row, col) {
		return self.renderBuffer[row].replace(self.getReplaceTabsRegExp(), '\t').replace(/\n/g, '').slice(0, col).length;
	};

	this.getEndOfLinePosition = function(row) {
		row = row || self.cursorPos.row;
		return self.position.col + self.getLineTextLength(row);
	};

	this.getAbsolutePosition = function(row, col) {
		row = row || self.cursorPos.row;
		col = col || self.cursorPos.col;
		return { row : self.position.row + row, col : self.position.col + col };
	};

	this.getCharAtCursorPosition = function() {
		var pos = self.getTextBufferPosition(self.cursorPos.row, self.cursorPos.col);
		return self.textBuffer.get(pos);
	};

	this.moveCursorTo = function(row, col) {
		var absPos = self.getAbsolutePosition(row, col);
		self.client.term.write(ansi.goto(absPos.row, absPos.col));
	};
	
	this.scrollUp = function(count) {

	};

	this.scrollDown = function(count) {

	};	

	this.cursorUp = function() {
		if(self.cursorPos.row > 0) {
			self.cursorPos.col = self.getLineTextLengthToColumn(self.cursorPos.row, self.cursorPos.col);
			self.cursorPos.row--;
			self.client.term.write(ansi.up());
		} else if(self.topLineIndex > 0) {
			//	:TODO: scroll up if possible to do so
		}

		var endOfLinePos = self.getEndOfLinePosition();
		console.log('col=' + self.cursorPos.col + ' / eolPos=' + endOfLinePos)
		if(self.cursorPos.col > endOfLinePos) {
			self.client.term.write(ansi.right(self.cursorPos.col - endOfLinePos));
			self.cursorPos.col = endOfLinePos;
		}


		//	:TODO: if there is text @ cursor y position we're ok, otherwise,
		//	jump to the end of the line

		
	};

	this.cursorRight = function() {
		var max = Math.min(self.dimens.width, self.getLineTextLength(self.cursorPos.row) - 1);
		if(self.cursorPos.col < max) {
			self.cursorPos.col++;
			self.client.term.write(ansi.right());
			
			//	make tab adjustment if necessary
			if('\t' === self.getCharAtCursorPosition()) {
				self.cursorPos.col++;
				self.client.term.write(ansi.right(self.tabWidth - 1));
			}
		} else {
			if(self.cursorPos.row > 0) {
				self.cursorPos.row--;
				self.cursorPos.col = 0;
				self.moveCursorTo(self.cursorPos.row, self.cursorPos.col);
			}
		}
		
	};

	this.cursorLeft = function() {
		if(self.cursorPos.col > 0) {
			self.cursorPos.col--;
		} else {
			if(self.cursorPos.row > 0) {
				self.cursorPos.row--;
				self.cursorPos.col = self.renderBuffer[self.cursorPos.row].length;
			}
			//self.cursorUp();
		}
	};

	this.getLineIndex = function() {
		return self.topLineIndex + self.cursorPos.row;
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

MultiLineEditTextView.prototype.onSpecialKeyPress = function(keyName) {
	if(this.isSpecialKeyMapped('up', keyName)) {
		this.cursorUp();
	} else if(this.isSpecialKeyMapped('down', keyName)) {

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
