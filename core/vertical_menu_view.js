/* jslint node: true */
'use strict';

var MenuView		= require('./menu_view.js').MenuView;
var ansi			= require('./ansi_term.js');
var strUtil			= require('./string_util.js');
var util			= require('util');
var assert			= require('assert');

exports.VerticalMenuView		= VerticalMenuView;

function VerticalMenuView(options) {
	options.cursor = options.cursor || 'hide';

	MenuView.call(this, options);

	var self = this;

	this.itemSpacing = 3;

	this.calculateDimens = function() {
		if(!self.dimens || !self.dimens.width) {
			var l = 0;
			self.items.forEach(function onItem(item) {
				if(item.text.length > l) {
					l = item.text.length;
				}
			});
			self.dimens = self.dimens || {};
			self.dimens.width = l;
		}

		if(this.items.length > 0) {
			this.dimens.height = (self.items.length * self.itemSpacing) - (self.itemSpacing - 1);
		} else {
			this.dimens.height = 0;
		}
	};

	this.calculateDimens();

	this.cachePositions = function() {
		if(self.positionCacheExpired) {
			var count = this.items.length;
			var x = self.position.x;
			for(var i = 0; i < count; ++i) {
				if(i > 0) {
					x += self.itemSpacing;
				}

				self.items[i].xPosition = x;
			}
			self.positionCacheExpired = false;
		}
	};

	this.drawItem = function(index) {
		assert(!this.positionCacheExpired);

		var item = self.items[index];
		if(!item) {
			return;
		}

		self.client.term.write(ansi.goto(item.xPosition, self.position.y));
		this.client.term.write(self.getANSIColor(
			index === self.focusedItemIndex || item.selected ? self.getFocusColor() : self.getColor()));

		var text = strUtil.stylizeString(item.text, item.focused ? self.focusTextStyle : self.textStyle);

		self.client.term.write(
			strUtil.pad(text, this.dimens.width, this.fillChar, this.justify));
	};
}

util.inherits(VerticalMenuView, MenuView);

VerticalMenuView.prototype.setPosition = function(pos) {
	VerticalMenuView.super_.prototype.setPosition.call(this, pos);

	this.positionCacheExpired = true;
};

VerticalMenuView.prototype.setFocus = function(focused) {
	VerticalMenuView.super_.prototype.setFocus.call(this, focused);

	this.redraw();
};

VerticalMenuView.prototype.onSpecialKeyPress = function(keyName) {

	var prevFocusedItemIndex = this.focusedItemIndex;

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

	if(prevFocusedItemIndex !== this.focusedItemIndex) {
		this.moveSelection(prevFocusedItemIndex, this.focusedItemIndex);
	}

	VerticalMenuView.super_.prototype.onSpecialKeyPress.call(this, keyName);
};

VerticalMenuView.prototype.getData = function() {
	return this.focusedItemIndex;
};

VerticalMenuView.prototype.setItems = function(items) {
	VerticalMenuView.super_.prototype.setItems.call(this, items);

	this.positionCacheExpired = true;
	this.cachePositions();
	this.calculateDimens();
};