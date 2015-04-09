/* jslint node: true */
'use strict';

var TextView		= require('./text_view.js').TextView;
var miscUtil		= require('./misc_util.js');

var util			= require('util');
var assert			= require('assert');

function MaskEditTextView(client, options) {
	options.acceptsFocus 	= miscUtil.valueWithDefault(options.acceptsFocus, true);
	options.acceptsInput	= miscUtil.valueWithDefault(options.acceptsInput, true);

	TextView.call(this, client, options);

	var self = this;

	this.mask = options.mask || '';

}

util.inherits(MaskEditTextView, TextView);

MaskEditTextView.MaskCharacterRegEx = {
	'#'				: /[0-9]/,
	'?'				: /[a-zA-Z]/,
	'&'				: /[\w\d\s]/,	//	32-126, 128-255
	'A'				: /[0-9a-zA-Z]/,
};

MaskEditTextView.prototype.setMask = function(mask) {
	this.mask = mask;
};

MaskEditTextView.prototype.onKeyPress = function(key, isSpecial) {
	if(isSpecial) {
		return;
	}

	assert(1 === key.length);

	

	MaskEditTextView.super_.prototype.onKeyPress(this, key, isSpecial);
};

MaskEditTextView.prototype.onSpecialKeyPress = function(keyName) {

	if(this.isSpecialKeyMapped('backspace', keyName)) {
		/*
		if(this.text.length > 0) {
			this.text = this.text.substr(0, this.text.length - 1);
			this.clientBackspace();
		}
		*/
	}

	MaskEditTextView.super_.prototype.onSpecialKeyPress.call(this, keyName);
};