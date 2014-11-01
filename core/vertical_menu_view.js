/* jslint node: true */
'use strict';

var MenuView		= require('./menu_view.js').MenuView;
var ansi			= require('./ansi_term.js');
var strUtil			= require('./string_util.js');
var util			= require('util');
var assert			= require('assert');

exports.VerticalMenuView		= VerticalMenuView;

function VerticalMenuView(client, options) {
	MenuView.call(this, client, options);

	var self = this;

	this.cacheXPositions = function() {
		if(self.xPositionCacheExpired) {
			var count = this.items.length;
			var x = self.position.x;
			for(var i = 0; i < count; ++i) {
				if(i > 0) {
					x += self.itemSpacing;
				}

				self.items[i].xPosition = x;
			}
			self.xPositionCacheExpired = false;
		}
	};

	this.drawItem = function(index) {
		assert(!this.xPositionCacheExpired);

		var item = self.items[index];
		if(!item) {
			return;
		}

		self.client.term.write(ansi.goto(item.xPosition, self.position.y));
		this.client.term.write(self.getANSIColor(
			index === self.focusedItemIndex || item.selected ? self.getFocusColor() : self.getColor()));

		var text = strUtil.stylizeString(item.text, item.hasFocus ? self.focusTextStyle : self.textStyle);
		self.client.term.write(text);	//	:TODO: apply justify
	};

	this.moveSelection = function(fromIndex, toIndex) {
		assert(!self.xPositionCacheExpired);
		assert(fromIndex >= 0 && fromIndex <= self.items.length);
		assert(toIndex >= 0 && toIndex <= self.items.length);

		self.items[fromIndex].focused	= false;
		self.drawItem(fromIndex);

		self.items[toIndex].focused 	= true;
		self.focusedItemIndex			= toIndex;
		self.drawItem(toIndex);
	};
}

util.inherits(VerticalMenuView, MenuView);

VerticalMenuView.prototype.setPosition = function(pos) {
	VerticalMenuView.super_.prototype.setPosition.call(this, pos);

	this.xPositionCacheExpired = true;
};

VerticalMenuView.prototype.redraw = function() {
	VerticalMenuView.super_.prototype.redraw.call(this);

	this.cacheXPositions();

	var count = this.items.length;
	for(var i = 0; i < count; ++i) {
		this.drawItem(i);
	}
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