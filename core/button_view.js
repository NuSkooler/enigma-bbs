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

ButtonView.prototype.onKeyPress = function(key, isSpecial) {
	ButtonView.super_.prototype.onKeyPress.call(this, key, isSpecial);

	//	allow spacebar to 'click' buttons
	//	:TODO: need to check configurable mapping here
	if(' ' === key) {
		this.emit('action', 'accept');
	}
};

ButtonView.prototype.getData = function() {
	return null;
};
