/* jslint node: true */
'use strict';

var TextView		= require('./text_view.js').TextView;
var miscUtil		= require('./misc_util.js');
var strUtil			= require('./string_util.js');
//var ansi			= require('./ansi_term.js');

//var util			= require('util');
var assert			= require('assert');
var _				= require('lodash');

exports.EditTextView	= EditTextView;

function EditTextView(options) {
	options.acceptsFocus 	= miscUtil.valueWithDefault(options.acceptsFocus, true);
	options.acceptsInput	= miscUtil.valueWithDefault(options.acceptsInput, true);
	options.cursorStyle		= miscUtil.valueWithDefault(options.cursorStyle, 'steady block');
	options.resizable		= false;
	
	TextView.call(this, options);

	this.cursorPos = { row : 0, col : 0 };

	this.clientBackspace = function() {
		var fillCharSGR = this.getStyleSGR(1) || this.getSGR();
		this.client.term.write('\b' + fillCharSGR + this.fillChar + '\b' + this.getFocusSGR());
	};
}

require('util').inherits(EditTextView, TextView);

EditTextView.prototype.onKeyPress = function(ch, key) {
	if(key) {
		if(this.isKeyMapped('backspace', key.name)) {
			if(this.text.length > 0) {
				this.text = this.text.substr(0, this.text.length - 1);

				if(this.text.length >= this.dimens.width) {
					this.redraw();
				} else {
					this.cursorPos.col -= 1;
					if(this.cursorPos.col >= 0) {
						this.clientBackspace();
					}
				}
			}
			
			return;
		} else if(this.isKeyMapped('clearLine', key.name)) {
			this.text			= '';
			this.cursorPos.col	= 0;
			this.setFocus(true);	//	resetting focus will redraw & adjust cursor

			return;
		}
	}

	if(ch && strUtil.isPrintable(ch)) {
		if(this.text.length < this.maxLength) {
			ch = strUtil.stylizeString(ch, this.textStyle);

			this.text += ch;

			if(this.text.length > this.dimens.width) {
				//	no shortcuts - redraw the view
				this.redraw();
			} else {
				this.cursorPos.col += 1;

				if(this.textMaskChar) {
					this.client.term.write(this.textMaskChar);
				} else {
					this.client.term.write(ch);
				}
			}
		}
	}

	EditTextView.super_.prototype.onKeyPress.call(this, ch, key);
};

EditTextView.prototype.setText = function(text) {
	//	draw & set |text|
	EditTextView.super_.prototype.setText.call(this, text);

	//	adjust local cursor tracking
	this.cursorPos = { row : 0, col : text.length };
};
