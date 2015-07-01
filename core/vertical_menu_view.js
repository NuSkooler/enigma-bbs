/* jslint node: true */
'use strict';

var MenuView		= require('./menu_view.js').MenuView;
var ansi			= require('./ansi_term.js');
var strUtil			= require('./string_util.js');
var miscUtil		= require('./misc_util.js');

var util			= require('util');
var assert			= require('assert');
var _				= require('lodash');

exports.VerticalMenuView		= VerticalMenuView;

function VerticalMenuView(options) {
	options.cursor	= options.cursor || 'hide';
	options.justify = options.justify || 'right';	//	:TODO: default to center

	MenuView.call(this, options);

	var self = this;

	this.performAutoScale = function() {
		if(this.autoScale.height) {
			this.dimens.height = (self.items.length * (self.itemSpacing + 1)) - (self.itemSpacing);
			this.dimens.height = Math.min(self.dimens.height, self.client.term.termHeight - self.position.row);
		}

		if(this.autoScale.width) {
			var l = 0;
			self.items.forEach(function item(i) {
				if(i.text.length > l) {
					l = Math.min(i.text.length, self.client.term.termWidth - self.position.col);
				}
			});
			self.dimens.width = l + 1;
		}
	};

	this.performAutoScale();

	this.updateViewVisibleItems = function() {
		self.maxVisibleItems = Math.ceil(self.dimens.height / (self.itemSpacing + 1));

		self.viewWindow = {
			top		: self.focusedItemIndex,
			bottom	: Math.min(self.focusedItemIndex + self.maxVisibleItems, self.items.length) - 1
		};
	};

	this.drawItem = function(index) {
		var item = self.items[index];
		if(!item) {
			return;
		}

		self.client.term.write(ansi.goto(item.row, self.position.col));
		self.client.term.write(index === self.focusedItemIndex ? self.getFocusSGR() : self.getSGR());

		var text = strUtil.stylizeString(item.text, item.focused ? self.focusTextStyle : self.textStyle);

		self.client.term.write(
			strUtil.pad(text, this.dimens.width, this.fillChar, this.justify));
	};
}

util.inherits(VerticalMenuView, MenuView);

VerticalMenuView.prototype.redraw = function() {
	VerticalMenuView.super_.prototype.redraw.call(this);

	//	:TODO: rename positionCacheExpired to something that makese sense; combine methods for such
	if(this.positionCacheExpired) {
		this.performAutoScale();
		this.updateViewVisibleItems();

		this.positionCacheExpired = false;
	}

	var row = this.position.row;
	for(var i = this.viewWindow.top; i <= this.viewWindow.bottom; ++i) {
		this.items[i].row = row;
		row += this.itemSpacing + 1;
		this.items[i].focused = this.focusedItemIndex === i;
		this.drawItem(i);
	}
};

VerticalMenuView.prototype.setHeight = function(height) {
	VerticalMenuView.super_.prototype.setHeight.call(this, height);

	this.positionCacheExpired = true;
};

VerticalMenuView.prototype.setPosition = function(pos) {
	VerticalMenuView.super_.prototype.setPosition.call(this, pos);

	this.positionCacheExpired = true;
};

VerticalMenuView.prototype.setFocus = function(focused) {
	VerticalMenuView.super_.prototype.setFocus.call(this, focused);

	this.redraw();
};

VerticalMenuView.prototype.onKeyPress = function(ch, key) {

	if(key) {
		var prevFocusedItemIndex = this.focusedItemIndex;

		if(this.isSpecialKeyMapped('up', key.name)) {		
			if(0 === this.focusedItemIndex) {
				this.focusedItemIndex = this.items.length - 1;
				
				this.viewWindow = {
					top		: this.items.length - this.maxVisibleItems,
					bottom	: this.items.length - 1
				};
			} else {
				this.focusedItemIndex--;

				if(this.focusedItemIndex < this.viewWindow.top) {
					this.viewWindow.top--;
					this.viewWindow.bottom--;
				}
			}
		} else if(this.isSpecialKeyMapped('down', key.name)) {
			if(this.items.length - 1 === this.focusedItemIndex) {
				this.focusedItemIndex = 0;
				
				this.viewWindow = {
					top		: 0,
					bottom	: Math.min(this.focusedItemIndex + this.maxVisibleItems, this.items.length) - 1
				};
			} else {
				this.focusedItemIndex++;

				if(this.focusedItemIndex > this.viewWindow.bottom) {
					this.viewWindow.top++;
					this.viewWindow.bottom++;
				}
			}
		}

		if(prevFocusedItemIndex !== this.focusedItemIndex) {
			this.redraw();
		}
	}

	VerticalMenuView.super_.prototype.onKeyPress.call(this, ch, key);
};

VerticalMenuView.prototype.getData = function() {
	return this.focusedItemIndex;
};

VerticalMenuView.prototype.setItems = function(items) {
	VerticalMenuView.super_.prototype.setItems.call(this, items);

	this.positionCacheExpired = true;
};

VerticalMenuView.prototype.setItemSpacing = function(itemSpacing) {
	VerticalMenuView.super_.prototype.setItemSpacing.call(this, itemSpacing);

	this.positionCacheExpired = true;
};