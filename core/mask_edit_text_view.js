/* jslint node: true */
'use strict';

var TextView		= require('./text_view.js').TextView;
var miscUtil		= require('./misc_util.js');

var util			= require('util');
var assert			= require('assert');

exports.MaskEditTextView	= MaskEditTextView;

//	##/##/#### <--styleSGR2 if fillChar
//	  ^- styleSGR1
//	buildPattern -> [ RE, RE, '/', RE, RE, '/', RE, RE, RE, RE ]
//	patternIndex -----^

function MaskEditTextView(options) {
	options.acceptsFocus 	= miscUtil.valueWithDefault(options.acceptsFocus, true);
	options.acceptsInput	= miscUtil.valueWithDefault(options.acceptsInput, true);
	options.cursorStyle		= miscUtil.valueWithDefault(options.cursorStyle, 'steady block');
	options.resizable		= false;

	TextView.call(this, options);

	this.cursorPos = { x : 0 };

	var self = this;

	this.maskPattern = options.maskPattern || '';

	this.buildPattern = function(pattern) {
		this.patternArray = [];
		for(var i = 0; i < pattern.length; i++) {
			if(pattern[i] in MaskEditTextView.maskPatternCharacterRegEx) {
				this.patternArray.push(MaskEditTextView.maskPatternCharacterRegEx[pattern[i]]);
			} else {
				this.patternArray.push(pattern[i]);
			}
		}
		console.log(this.patternArray)
	};

	this.buildPattern(this.maskPattern);

}

util.inherits(MaskEditTextView, TextView);

MaskEditTextView.maskPatternCharacterRegEx = {
	'#'				: /[0-9]/,
	'?'				: /[a-zA-Z]/,
	'&'				: /[\w\d\s]/,	//	32-126, 128-255
	'A'				: /[0-9a-zA-Z]/,
};

MaskEditTextView.prototype.setMaskPattern = function(pattern) {
	this.buildPattern(pattern);
};

MaskEditTextView.prototype.onKeyPress = function(key, isSpecial) {
	if(isSpecial) {
		return;
	}

	assert(1 === key.length);

	if(this.text.length < this.maxLength) {
		key = strUtil.stylizeString(key, this.textStyle);

		/*this.text += key;

		if(this.text.length > this.dimens.width) {
			//	no shortcuts - redraw the view
			this.redraw();
		} else {
			this.cursorPos.x += 1;

			if(this.maskPatternChar) {
				this.client.term.write(this.maskPatternChar);
			} else {
				this.client.term.write(key);
			}
		}
		*/
	}
	

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