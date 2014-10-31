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

	if(this.options.maxLength) {
		this.maxLength = this.options.maxLength;
	}

	this.multiLine	= this.options.multiLine || false;
	this.fillChar	= miscUtil.valueWithDefault(this.options.fillChar, ' ').substr(0, 1);

	assert(!this.multiLine);	//	:TODO: not yet supported

	if(!this.multiLine) {
		this.dimens.height = 1;
	}

	this.setText(this.options.text || '');

	if(this.isPasswordTextStyle) {
		this.textMaskChar = miscUtil.valueWithDefault(this.options.textMaskChar, '*').substr(0, 1);
	}
}

util.inherits(TextView, View);

TextView.prototype.redraw = function() {
	TextView.super_.prototype.redraw.call(this);

	var color = this.hasFocus ?	this.getFocusColor() : this.getColor();
	this.client.term.write(this.getANSIColor(color));

	//	:TODO: If using fillChar, don't just pad. switch to non-focus color & fill with |fillChar|
	//	:TODO: Apply justification
	if(this.isPasswordTextStyle) {
		this.client.term.write(strUtil.pad(new Array(this.text.length + 1).join(this.textMaskChar), this.dimens.width));
	} else {
		this.client.term.write(strUtil.pad(this.text, this.dimens.width));
	}
};

TextView.prototype.setFocus = function(focused) {
	TextView.super_.prototype.setFocus.call(this, focused);

	this.redraw();
	this.client.term.write(ansi.goto(this.position.x, this.position.y + this.text.length));
};

TextView.prototype.setText = function(text) {
	this.text = text;

	if(this.maxLength > 0) {
		this.text = this.text.substr(0, this.maxLength);
	}

	this.text = strUtil.stylizeString(this.text, this.textStyle);

	if(!this.multiLine && !this.dimens.width) {
		this.dimens.width = this.text.length;
	}
};
