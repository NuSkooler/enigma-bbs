/* jslint node: true */
'use strict';

var View			= require('./view.js').View;
var miscUtil		= require('./misc_util.js');
var strUtil			= require('./string_util.js');
var ansi			= require('./ansi_term.js');

var assert			= require('assert');
var _				= require('lodash');


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


function MultiLineEditTextView(options) {
	
	if(!_.isBoolean(options.acceptsFocus)) {
		options.acceptsFocus = true;
	}

	if(!_.isBoolean(this.acceptsInput)) {
		options.acceptsInput = true;
	}

	View.call(this, options);

	if(0 !== this.position.col) {
		//	:TODO: experimental - log this as warning if kept
		this.position.col = 0;	
	}
	

	var self = this;

	this.lines			= [];				//	a given line is text...until EOL
	this.topLineIndex	= 0;
	this.cursorPos		= { x : 0, y : 0 };	//	relative to view window

	/*
	this.redrawViewableText = function() {
		//
		//	v--- position.row/y
		//	+-----------------------------------+ <--- x + width
		//	|                                   |
		//	|                                   |
		//	|                                   |
		//	+-----------------------------------+
		//	^--- position.row + height
		//
		//	A given line in lines[] may need to take up 1:n physical lines
		//	due to wrapping / available space.
		//
		var x		= self.position.row;
		var bottom	= x + self.dimens.height;
		var idx		= self.topLineIndex;

		self.client.term.write(self.getSGR());

		var lines;
		while(idx < self.lines.length && x < bottom) {
			if(0 === self.lines[idx].length) {
				++x;
			} else {
				lines = self.wordWrap(self.lines[idx]);
				for(var y = 0; y < lines.length && x < bottom; ++y) {
					self.client.term.write(ansi.goto(x, this.position.col));
					self.client.term.write(lines[y]);
					++x;
				}
			}

			++idx;
		}
	};
	*/

	this.createScrollRegion = function() {
		self.client.term.write(ansi.setScrollRegion(self.position.row, self.position.row + 5));//self.dimens.height));
	};

	this.redrawViewableText = function() {
		var x		= self.position.row;
		var bottom	= x + self.dimens.height;
		var index	= self.topLineIndex;

		self.client.term.write(self.getSGR());

		while(index < self.lines.length && x < bottom) {
			self.client.term.write(ansi.goto(x, this.position.col));
			self.writeLine(self.lines[index]);
			console.log(self.lines[index])
			++x;
			++index;
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

	this.writeLine = function(s) {
		//
		//	Hello, World\n
		//	\tThis is a test, it is only a test!
		//
		//	Loop through |s| finding control characters & processing them
		//	with our own internal handling.

		var clean = s.replace(/[\x00-\x1F\x7F-\x9F]/g, '');
		self.client.term.write(clean);
	};

	this.scrollUp = function(count) {

	};

	this.scrollDown = function(count) {

	};

	this.keyUp = function() {
		if(self.cursorPos.row > 0) {
			self.cursorPos.row--;
			console.log(self.lines[self.getLineIndex()])
		} else if(self.topLineIndex > 0) {
			//	:TODO: scroll 
		}



		//	:TODO: if there is text @ cursor y position we're ok, otherwise,
		//	jump to the end of the line
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

	//this.redrawViewableText();
	this.client.term.write(this.text);
};

/*MultiLineEditTextView.prototype.setFocus = function(focused) {

	MultiLineEditTextView.super_.prototype.setFocus.call(this, focused);
};
*/

MultiLineEditTextView.prototype.setText = function(text) {
	//	:TODO: text.split(/\r\n|\n|\r/))
	//this.lines = text.split(/\r?\n/);

	//this.cursorPos.row = this.position.row + this.dimens.height;
	this.lines = this.wordWrap(text);
	this.createScrollRegion();

	this.text = text;
}

MultiLineEditTextView.prototype.onSpecialKeyPress = function(keyName) {
	if(this.isSpecialKeyMapped('up', keyName)) {
		this.keyUp();
	} else if(this.isSpecialKeyMapped('down', keyName)) {

	} else if(this.isSpecialKeyMapped('left', keyName)) {

	} else if(this.isSpecialKeyMapped('right', keyName)) {

	}

	MultiLineEditTextView.super_.prototype.onSpecialKeyPress.call(this, keyName);
}