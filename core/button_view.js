/* jslint node: true */
'use strict';

var TextView		= require('./text_view.js').TextView;
var miscUtil		= require('./misc_util.js');
var util			= require('util');
var assert			= require('assert');

exports.ButtonView			= ButtonView;

function ButtonView(options) {
	options.acceptsFocus	= miscUtil.valueWithDefault(options.acceptsFocus, true);
	options.acceptsInput	= miscUtil.valueWithDefault(options.acceptsInput, true);
	options.justify			= miscUtil.valueWithDefault(options.justify, 'center');
	options.cursor 			= miscUtil.valueWithDefault(options.cursor, 'hide');

	TextView.call(this, options);
}

util.inherits(ButtonView, TextView);

ButtonView.prototype.onKeyPress = function(ch, key) {
	if(' ' === ch) {
		this.emit('action', 'accept');
	}

	ButtonView.super_.prototype.onKeyPress.call(this, ch, key);
};

ButtonView.prototype.getData = function() {
	return null;
};
