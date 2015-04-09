/* jslint node: true */
'use strict';

var View			= require('./view.js').View;
var miscUtil		= require('./misc_util.js');
var strUtil			= require('./string_util.js');
var ansi			= require('./ansi_term.js');
var util			= require('util');
var assert			= require('assert');

exports.TickerTextView		= TickerTextView;

function TickerTextView(options) {
	View.call(this, options);

	var self = this;

	this.text				= options.text || '';
	this.tickerStyle		= options.tickerStyle || 'rightToLeft';
	assert(this.tickerStyle in TickerTextView.TickerStyles);
	
	//	:TODO: Ticker |text| should have ANSI stripped before calculating any lengths/etc.
	//	strUtil.ansiTextLength(s)
	//	strUtil.pad(..., ignoreAnsi)
	//	strUtil.stylizeString(..., ignoreAnsi)

	this.tickerState = {};
	switch(this.tickerStyle) {
		case 'rightToLeft' :
			this.tickerState.pos = this.position.x + this.dimens.width;
			break;
	}


	self.onTickerInterval = function() {
		switch(self.tickerStyle) {
			case 'rightToLeft' : self.updateRightToLeftTicker(); break;
		}
	};

	self.updateRightToLeftTicker = function() {
		//	if pos < start
		//		drawRemain()
		//	if pos + remain > end
		//		drawRemain(0, spaceFor)
		//	else
		//		drawString() + remainPading
	};

}

util.inherits(TickerTextView, View);

TickerTextView.TickerStyles = {
	leftToRight		: 1,
	rightToLeft		: 2,
	bounce			: 3,
	slamLeft		: 4,
	slamRight		: 5,
	slamBounce		: 6,
	decrypt			: 7,
	typewriter		: 8,
};
Object.freeze(TickerTextView.TickerStyles);

/*
TickerTextView.TICKER_STYLES = [
	'leftToRight',
	'rightToLeft',
	'bounce',
	'slamLeft',
	'slamRight',
	'slamBounce',
	'decrypt',
	'typewriter',
];
*/

TickerTextView.prototype.controllerAttached = function() {
	//	:TODO: call super
};

TickerTextView.prototype.controllerDetached = function() {
	//	:TODO: call super
	
};

TickerTextView.prototype.setText = function(text) {
	this.text = strUtil.stylizeString(text, this.textStyle);

	if(!this.dimens || !this.dimens.width) {
		this.dimens.width = Math.ceil(this.text.length / 2);
	}
};