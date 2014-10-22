/* jslint node: true */
'use strict';

var View			= require('./view.js').View;
var miscUtil		= require('./misc_util.js');
var strUtil			= require('./string_util.js');
var ansi			= require('./ansi_term.js');
var util			= require('util');
var assert			= require('assert');

exports.TextView			= TextView;

function TextView(client, options) {
	View.call(this, client, options);

	var self = this;

	if(this.options.maxLength) {
		this.maxLength = this.options.maxLength;
	}

	this.textStyle = this.options.textStyle || 'normal';
	this.multiLine = this.options.multiLine || false;

	assert(!this.multiLine);	//	:TODO: not yet supported

	if(!this.multiLine) {
		this.dimens.height = 1;
	}

	this.setText(this.options.text || '');

	this.isPasswordTextStyle = 'P' === self.textStyle || 'password' === self.textStyle;

	if(this.isPasswordTextStyle) {
		this.passwordMaskChar = miscUtil.valueWithDefault(this.options.passwordMaskChar, '*').substr(0, 1);
	}
}

util.inherits(TextView, View);

TextView.prototype.redraw = function() {
	TextView.super_.prototype.redraw.call(this);

	var color = this.hasFocus ?	this.getFocusColor() : this.getColor();
	
	this.client.term.write(ansi.sgr(color.flags, color.fg, color.bg));

	if(this.isPasswordTextStyle) {
		this.client.term.write(strUtil.pad(new Array(this.text.length).join(this.passwordMaskChar), this.dimens.width));
	} else {
		this.client.term.write(strUtil.pad(this.text, this.dimens.width));
	}
};

TextView.prototype.setText = function(text) {
	this.text = text;

	if(this.maxLength > 0) {
		this.text = this.text.substr(0, this.maxLength);
	}

	this.text = strUtil.stylizeString(this.text, this.textStyle);

	if(!this.multiLine) {
		this.dimens.width = this.text.length;
	}
};
