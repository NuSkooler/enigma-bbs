/* jslint node: true */
'use strict';

var TextView		= require('./text_view.js').TextView;
var miscUtil		= require('./misc_util.js');
var strUtil			= require('./string_util.js');
var util			= require('util');
var assert			= require('assert');
var _				= require('lodash');

exports.EditTextView	= EditTextView;

function EditTextView(options) {
	options.acceptsFocus 	= miscUtil.valueWithDefault(options.acceptsFocus, true);
	options.acceptsInput	= miscUtil.valueWithDefault(options.acceptsInput, true);
	options.resizable		= false;
	
	TextView.call(this, options);

	this.cursorPos = { x : 0 };

	this.clientBackspace = function() {
		this.client.term.write(
			'\b' + this.getANSIColor(this.getColor()) + this.fillChar + '\b' + this.getANSIColor(this.getFocusColor()));
	};
}

util.inherits(EditTextView, TextView);

EditTextView.prototype.onKeyPress = function(key, isSpecial) {	
	if(isSpecial) {
		return;
	}

	assert(1 === key.length);

	if(this.text.length < this.maxLength) {
		key = strUtil.stylizeString(key, this.textStyle);

		this.text += key;

		if(this.text.length > this.dimens.width) {
			//	no shortcuts - redraw the view
			this.redraw();
		} else {
			this.cursorPos.x += 1;

			if(this.textMaskChar) {
				this.client.term.write(this.textMaskChar);
			} else {
				this.client.term.write(key);
			}
		}
	}

	EditTextView.super_.prototype.onKeyPress.call(this, key, isSpecial);
};

EditTextView.prototype.onSpecialKeyPress = function(keyName) {
	if(this.isSpecialKeyMapped('backspace', keyName)) {
		if(this.text.length > 0) {
			this.text = this.text.substr(0, this.text.length - 1);

			if(this.text.length >= this.dimens.width) {
				this.redraw();
			} else {
				this.cursorPos.x -= 1;
				if(this.cursorPos.x >= 0) {
					this.clientBackspace();
				}
			}
		}
	} else if(this.isSpecialKeyMapped('clearLine', keyName)) {
		this.text			= '';
		this.cursorPos.x	= 0;
		this.setFocus(true);	//	resetting focus will redraw & adjust cursor
	}


	EditTextView.super_.prototype.onSpecialKeyPress.call(this, keyName);
};