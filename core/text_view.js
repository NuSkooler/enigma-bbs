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

	this.justify	= this.options.justify || 'right';

	assert(!this.multiLine);	//	:TODO: not yet supported

	if(!this.multiLine) {
		this.dimens.height = 1;
	}

	this.setText(this.options.text || '');

	if(this.isPasswordTextStyle) {
		this.textMaskChar = miscUtil.valueWithDefault(this.textMaskChar, '*').substr(0, 1);
	}
}

util.inherits(TextView, View);

TextView.prototype.redraw = function() {
	TextView.super_.prototype.redraw.call(this);

	var ansiColor = this.getANSIColor(this.hasFocus ? this.getFocusColor() : this.getColor());

	if(this.isPasswordTextStyle) {
		this.client.term.write(strUtil.pad(
			new Array(this.text.length + 1).join(this.textMaskChar), 
			this.dimens.width, 
			this.fillChar, 
			this.justify,
			ansiColor,
			this.getANSIColor(this.getColor())));
	} else {
		var text = strUtil.stylizeString(this.text, this.hasFocus ? this.focusTextStyle : this.textStyle);
		this.client.term.write(strUtil.pad(
			text, 
			this.dimens.width, 
			this.fillChar, 
			this.justify,
			ansiColor,
			this.getANSIColor(this.getColor())));
	}
};

TextView.prototype.setFocus = function(focused) {
	TextView.super_.prototype.setFocus.call(this, focused);

	this.redraw();
	this.client.term.write(ansi.goto(this.position.x, this.position.y + this.text.length));
	this.client.term.write(this.getANSIColor(this.getFocusColor()));
};

TextView.prototype.setText = function(text) {
	this.text = text;

	if(this.maxLength > 0) {
		this.text = this.text.substr(0, this.maxLength);
	}

	this.text = strUtil.stylizeString(this.text, this.hasFocus ? this.focusTextStyle : this.textStyle);

	if(!this.multiLine && !this.dimens.width) {
		this.dimens.width = this.text.length;
	}
};
