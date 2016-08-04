/* jslint node: true */
'use strict';

//	ENiGMA½
const View					= require('./view.js').View;
const miscUtil				= require('./misc_util.js');
const ansi					= require('./ansi_term.js');
const padStr				= require('./string_util.js').pad;
const stylizeString			= require('./string_util.js').stylizeString;
const renderSubstr			= require('./string_util.js').renderSubstr;
const renderStringLength	= require('./string_util.js').renderStringLength;
const pipeToAnsi			= require('./color_codes.js').pipeToAnsi;

//	deps
const util			= require('util');
const _				= require('lodash');

exports.TextView			= TextView;

function TextView(options) {
	if(options.dimens) {
		options.dimens.height = 1;	//	force height of 1 for TextView's & sub classes
	}

	View.call(this, options);

	var self = this;

	if(options.maxLength) {
		this.maxLength = options.maxLength;
	} else {
		this.maxLength = this.client.term.termWidth - this.position.col;
	}

	this.fillChar			= miscUtil.valueWithDefault(options.fillChar, ' ').substr(0, 1);
	this.justify			= options.justify || 'right';
	this.resizable			= miscUtil.valueWithDefault(options.resizable, true);
	this.horizScroll		= miscUtil.valueWithDefault(options.horizScroll, true);
	
	if(_.isString(options.textOverflow)) {
		this.textOverflow = options.textOverflow;
	}

	if(_.isString(options.textMaskChar) && 1 === options.textMaskChar.length) {
		this.textMaskChar = options.textMaskChar;
	}

	/*
	this.drawText = function(s) {

		//             
		//                     |<- this.maxLength
		//	 ABCDEFGHIJK
		//	|ABCDEFG|  ^_ this.text.length
		//	        ^-- this.dimens.width
		//
		let textToDraw = _.isString(this.textMaskChar) ? 
			new Array(s.length + 1).join(this.textMaskChar) : 
			stylizeString(s, this.hasFocus ? this.focusTextStyle : this.textStyle);
		
		if(textToDraw.length > this.dimens.width) {
			if(this.hasFocus) {
				if(this.horizScroll) {
					textToDraw = textToDraw.substr(textToDraw.length - this.dimens.width, textToDraw.length);
				}
			} else {
				if(textToDraw.length > this.dimens.width) {
					if(this.textOverflow && 
						this.dimens.width > this.textOverflow.length &&
						textToDraw.length - this.textOverflow.length >= this.textOverflow.length)
					{
						textToDraw = textToDraw.substr(0, this.dimens.width - this.textOverflow.length) + this.textOverflow;
					} else {
						textToDraw = textToDraw.substr(0, this.dimens.width);
					}
				}				
			}
		}

		this.client.term.write(padStr(
			textToDraw,
			this.dimens.width + 1,
			this.fillChar,
			this.justify,
			this.hasFocus ? this.getFocusSGR() : this.getSGR(),
			this.getStyleSGR(1) || this.getSGR()
			), false);
	};
	*/
	this.drawText = function(s) {

		//             
		//                     |<- this.maxLength
		//	 ABCDEFGHIJK
		//	|ABCDEFG|  ^_ this.text.length
		//	        ^-- this.dimens.width
		//
		let renderLength = renderStringLength(s);	//	initial; may be adjusted below:

		let textToDraw = _.isString(this.textMaskChar) ? 
			new Array(renderLength + 1).join(this.textMaskChar) : 
			stylizeString(s, this.hasFocus ? this.focusTextStyle : this.textStyle);
		
		renderLength = renderStringLength(textToDraw);
		
		if(renderLength > this.dimens.width) {
			if(this.hasFocus) {
				if(this.horizScroll) {
					textToDraw = renderSubstr(textToDraw, renderLength - this.dimens.width, renderLength);
				}
			} else {
				if(renderLength > this.dimens.width) {
					if(this.textOverflow && 
						this.dimens.width > this.textOverflow.length &&
						renderLength - this.textOverflow.length >= this.textOverflow.length)
					{
						textToDraw = renderSubstr(textToDraw, 0, this.dimens.width - this.textOverflow.length) + this.textOverflow;						
					} else {
						textToDraw = renderSubstr(textToDraw, 0, this.dimens.width);
					}
				}				
			}
		}

		this.client.term.write(padStr(
			textToDraw,
			this.dimens.width + 1,
			this.fillChar,
			this.justify,
			this.hasFocus ? this.getFocusSGR() : this.getSGR(),
			this.getStyleSGR(1) || this.getSGR()
			), false);
	};

	this.getEndOfTextColumn = function() {
		var offset = Math.min(this.text.length, this.dimens.width);
		return this.position.col + offset;	
	};

	//	:TODO: Whatever needs init here should be done separately from setText() since it redraws/etc.
	this.setText(options.text || '');
}

util.inherits(TextView, View);

TextView.prototype.redraw = function() {
	TextView.super_.prototype.redraw.call(this);

	if(_.isString(this.text)) {
		this.drawText(this.text);
	}
};

TextView.prototype.setFocus = function(focused) {
	TextView.super_.prototype.setFocus.call(this, focused);

	this.redraw();
	
	this.client.term.write(ansi.goto(this.position.row, this.getEndOfTextColumn()));
	this.client.term.write(this.getFocusSGR());
};

TextView.prototype.getData = function() {
	return this.text;
};

TextView.prototype.setText = function(text) {
	if(!_.isString(text)) {
		text = text.toString();
	}

	text = pipeToAnsi(text, this.client);	//	expand MCI/etc.	

	var widthDelta = 0;
	if(this.text && this.text !== text) {
		widthDelta = Math.abs(this.text.length - text.length);
	}

	this.text = text;

	if(this.maxLength > 0) {
		this.text = renderSubstr(this.text, 0, this.maxLength);
		//this.text = this.text.substr(0, this.maxLength);
	}

	//	:TODO: it would be nice to be able to stylize strings with MCI and {special} MCI syntax, e.g. "|BN {UN!toUpper}"
	this.text = stylizeString(this.text, this.hasFocus ? this.focusTextStyle : this.textStyle);	

	if(this.autoScale.width) {
		this.dimens.width = this.text.length + widthDelta;
	}

	this.redraw();
};

/*
TextView.prototype.setText = function(text) {
	if(!_.isString(text)) {
		text = text.toString();
	}	

	var widthDelta = 0;
	if(this.text && this.text !== text) {
		widthDelta = Math.abs(this.text.length - text.length);
	}

	this.text = text;

	if(this.maxLength > 0) {
		this.text = this.text.substr(0, this.maxLength);
	}

	this.text = stylizeString(this.text, this.hasFocus ? this.focusTextStyle : this.textStyle);	

	//if(this.resizable) {
	//	this.dimens.width = this.text.length + widthDelta;
	//}

	if(this.autoScale.width) {
		this.dimens.width = this.text.length + widthDelta;
	}

	this.redraw();
};
*/

TextView.prototype.setFormatObject = function(obj) {
	if(!_.isObject(obj) || !this.text) {
		return;
	}

	this.setText(this.text.format(obj));
};

TextView.prototype.clearText = function() {
	this.setText('');
};

TextView.prototype.setPropertyValue = function(propName, value) {
	switch(propName) {
	case 'textMaskChar' : this.textMaskChar = value.substr(0, 1); break;
	case 'textOverflow'	: this.textOverflow = value; break;
	case 'maxLength'	: this.maxLength = parseInt(value, 10); break;
	case 'password'		:
		if(true === value) {
			this.textMaskChar = this.client.currentTheme.helpers.getPasswordChar();
		}
		break;	
	}
	

	TextView.super_.prototype.setPropertyValue.call(this, propName, value);
};
