/* jslint node: true */
'use strict';

const TextView		= require('./text_view.js').TextView;
const miscUtil		= require('./misc_util.js');
const util			= require('util');

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
	if(this.isKeyMapped('accept', key.name) || ' ' === ch) {
		this.submitData = 'accept';
		this.emit('action', 'accept');
		delete this.submitData;		
	} else {
		ButtonView.super_.prototype.onKeyPress.call(this, ch, key);
	}
};
/*
ButtonView.prototype.onKeyPress = function(ch, key) {
	//	allow space = submit
	if(' ' === ch) {
		this.emit('action', 'accept');
	}

	ButtonView.super_.prototype.onKeyPress.call(this, ch, key);
};
*/

ButtonView.prototype.getData = function() {
	return this.submitData || null;
};
