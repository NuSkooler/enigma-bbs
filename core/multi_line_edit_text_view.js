/* jslint node: true */
'use strict';

var View			= require('./view.js').View;
var miscUtil		= require('./misc_util.js');
var strUtil			= require('./string_util.js');
var ansi			= require('./ansi_term.js');

var assert			= require('assert');
var _				= require('lodash');

exports.MultiLineEditTextView	= MultiLineEditTextView;

//
//	Some resources & comparisons
//	
//	Enthral
//		* https://github.com/M-griffin/Enthral/blob/master/src/msg_fse.cpp
//	
//	x84
//		* https://github.com/jquast/x84/blob/master/x84/bbs/editor.py
//
//	

function MultiLineEditTextView(options) {
	View.call(this, options);

	var self = this;

	this.lines			= [];	//	a given line is text...until EOL
	this.topLineIndex	= 0;

	this.drawViewableText = function() {
		//
		//	v--- position.x/y
		//	+-----------------------------------+ <--- x + width
		//	|                                   |
		//	|                                   |
		//	|                                   |
		//	+-----------------------------------+
		//	^--- position.y + height
		//
		//	A given line in lines[] may need to take up 1:n physical lines
		//	due to wrapping / available space.
		//
		var x = self.position.x;
		var bottom = x + self.dimens.height;
		var lines;
		var idx = self.topLineIndex;

		self.client.term.write(self.getSGR());

		while(x < bottom) {
			lines = self.getWordWrapLines(self.lines[idx]);
			for(var y = 0; y < lines.length && x < bottom; ++y) {
				self.client.term.write(ansi.goto(x, this.position.y));
				self.client.term.write(lines[y]);
				++x;
			}
		}

	};

	this.getWordWrapLines = function(line) {
		//
		//	Similar implementations:
		//	* http://blog.macromates.com/2006/wrapping-text-with-regular-expressions/
		//	* http://james.padolsey.com/snippets/wordwrap-for-javascript/
		//	* http://phpjs.org/functions/wordwrap/
		//	* https://github.com/jonschlinkert/word-wrap
		//
		/*
		var re = new RegExp(
			'(.{1,' + self.dimens.width + '}(\\s|$)|.{' + self.dimens.width + '}|.+$)', 
			'g');
		*/

		var re = new RegExp('.{1,' + self.dimens.width + '}(\\s+|$)|\\S+?(\\s+|$)', 'g');

		//return line.split(re);
		return line.match(re) || [];
	};
}

require('util').inherits(MultiLineEditTextView, View);

MultiLineEditTextView.prototype.redraw = function() {
	MultiLineEditTextView.super_.prototype.redraw.call(this);

	this.drawViewableText();
}

MultiLineEditTextView.prototype.setText = function(text) {
	//	:TODO: text.split(/\r\n|\n|\r/))
	this.lines = text.split(/\r?\n/);
}


