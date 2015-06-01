/* jslint node: true */
'use strict';

var View			= require('./view.js').View;
var miscUtil		= require('./misc_util.js');
var strUtil			= require('./string_util.js');
var ansi			= require('./ansi_term.js');
var TextBuffer		= require('./text_buffer.js').TextBuffer;

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
	//	defualt tabWidth is 8
	//	See the following:
	//	* http://www.ansi-bbs.org/ansi-bbs2/control_chars/
	//	* http://www.bbsdocumentary.com/library/PROGRAMS/GRAPHICS/ANSI/bansi.txt
	//
	this.tabWidth	= _.isNumber(options.tabWidth) ? options.tabWidth : 8;


	this.textBuffer	= new TextBuffer({
		gapSize	: 64
	});

	this.redrawVisibleArea = function() {

	};
}

require('util').inherits(MultiLineEditTextView2, View);

MultiLineEditTextView2.prototype.redraw = function() {
	MultiLineEditTextView2.super_.prototype.redraw.call(this);

	this.redrawVisibleArea();
};

MultiLineEditTextView2.prototype.setText = function(text) {
	this.textBuffer.insertText(0, text);
	console.log(this.textBuffer.getArray());
};