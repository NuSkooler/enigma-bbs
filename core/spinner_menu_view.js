/* jslint node: true */
'use strict';

var MenuView		= require('./menu_view.js').MenuView;
var ansi			= require('./ansi_term.js');
var strUtil			= require('./string_util.js');

var util			= require('util');
var assert			= require('assert');
var _				= require('lodash');

exports.SpinnerMenuView	= SpinnerMenuView;

function SpinnerMenuView(options) {
	options.justify	= options.justify || 'center';

	MenuView.call(this, options);
	
	var self = this;

	this.cachePositions = function() {
		if(self.positionCacheExpired) {
			var count = this.items.length;
			//	:TODO: change all xPosition, yPosition -> position.x, .y
			for(var i = 0; i < count; ++i) {
				self.items[i].xPosition = self.position.x;
			}
			self.positionCacheExpired = false;
		}
	};

	this.updateSelection = function() {
		assert(!self.positionCacheExpired);

		assert(this.focusedItemIndex >= 0 && this.focusedItemIndex <= self.items.length);
		
		self.drawItem(this.focusedItemIndex);
	};

	this.drawItem = function() {
		var item = self.items[this.focusedItemIndex];
		if(!item) {
			return;
		}

		this.client.term.write(ansi.goto(this.position.x, this.position.y));
		this.client.term.write(self.getANSIColor(this.hasFocus ? self.getFocusColor() : self.getColor()));

		var text = strUtil.stylizeString(item.text, item.focused ? self.focusTextStyle : self.textStyle);

		self.client.term.write(
			strUtil.pad(text, this.dimens.width + 1, this.fillChar, this.justify));
	};
}

util.inherits(SpinnerMenuView, MenuView);

SpinnerMenuView.prototype.redraw = function() {
	SpinnerMenuView.super_.prototype.redraw.call(this);

	this.cachePositions();
	this.drawItem(this.focusedItemIndex);
};

SpinnerMenuView.prototype.setFocus = function(focused) {
	SpinnerMenuView.super_.prototype.setFocus.call(this, focused);

	this.redraw();
};

SpinnerMenuView.prototype.onSpecialKeyPress = function(keyName) {

	if(this.isSpecialKeyMapped('up', keyName)) {		
		if(0 === this.focusedItemIndex) {
			this.focusedItemIndex = this.items.length - 1;
		} else {
			this.focusedItemIndex--;
		}
	} else if(this.isSpecialKeyMapped('down', keyName)) {
		if(this.items.length - 1 === this.focusedItemIndex) {
			this.focusedItemIndex = 0;
		} else {
			this.focusedItemIndex++;
		}
	}

	this.updateSelection();

	SpinnerMenuView.super_.prototype.onSpecialKeyPress.call(this, keyName);
};

SpinnerMenuView.prototype.getData = function() {
	return this.focusedItemIndex;
};

SpinnerMenuView.prototype.setItems = function(items) {
	SpinnerMenuView.super_.prototype.setItems.call(this, items);

	var longest = 0;
	for(var i = 0; i < this.items.length; ++i) {
		if(longest < this.items[i].text.length) {
			longest = this.items[i].text.length;
		}
	}

	this.dimens.width = longest;
};