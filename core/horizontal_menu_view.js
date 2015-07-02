/* jslint node: true */
'use strict';

var MenuView		= require('./menu_view.js').MenuView;
var ansi			= require('./ansi_term.js');
var strUtil			= require('./string_util.js');

var assert			= require('assert');
var _				= require('lodash');

exports.HorizontalMenuView		= HorizontalMenuView;

//	:TODO: Update this to allow scrolling if number of items cannot fit in width (similar to VerticalMenuView)

function HorizontalMenuView(options) {
	options.cursor	= options.cursor || 'hide';

	if(!_.isNumber(options.itemSpacing)) {
		options.itemSpacing = 1;
	}

	MenuView.call(this, options);

	this.dimens.height = 1;	//	always the case

	var self = this;

	this.getSpacer = function() {
		return new Array(self.itemSpacing + 1).join(' ');
	}

	this.performAutoScale = function() {
		if(self.autoScale.width) {
			var spacer	= self.getSpacer();
			var width	= self.items.join(spacer).length + (spacer.length * 2);
			assert(width <= self.client.term.termWidth - self.position.col);
			self.dimens.width = width;
		}
	};

	this.performAutoScale();

	this.cachePositions = function() {
		if(this.positionCacheExpired) {
			var col		= self.position.col;
			var spacer	= self.getSpacer();

			for(var i = 0; i < self.items.length; ++i) {
				self.items[i].col = col;
				col += spacer.length + self.items[i].text.length + spacer.length;
			}
		}

		this.positionCacheExpired = false;
	};

	this.drawItem = function(index) {
		assert(!this.positionCacheExpired);

		var item = self.items[index];
		if(!item) {
			return;
		}

		var text = strUtil.stylizeString(
			item.text, 
			this.hasFocus && item.focused ? self.focusTextStyle : self.textStyle);

		var drawWidth = text.length + self.getSpacer().length * 2;	//	* 2 = sides

		self.client.term.write(
			ansi.goto(self.position.row, item.col) +
			(index === self.focusedItemIndex ? self.getFocusSGR() : self.getSGR()) +
			strUtil.pad(text, drawWidth, self.fillChar, 'center')
			);
	};
}

require('util').inherits(HorizontalMenuView, MenuView);

HorizontalMenuView.prototype.setHeight = function(height) {
	height = parseInt(height, 10);
	assert(1 === height);	//	nothing else allowed here
	HorizontalMenuView.super_.prototype.setHeight(this, height);
};

HorizontalMenuView.prototype.redraw = function() {
	HorizontalMenuView.super_.prototype.redraw.call(this);

	this.cachePositions();

	for(var i = 0; i < this.items.length; ++i) {
		this.items[i].focused = this.focusedItemIndex === i;
		this.drawItem(i);
	}
};

HorizontalMenuView.prototype.setPosition = function(pos) {
	HorizontalMenuView.super_.prototype.setPosition.call(this, pos);

	this.positionCacheExpired = true;
};

HorizontalMenuView.prototype.setFocus = function(focused) {
	HorizontalMenuView.super_.prototype.setFocus.call(this, focused);

	this.redraw();
};

HorizontalMenuView.prototype.setItems = function(items) {
	HorizontalMenuView.super_.prototype.setItems.call(this, items);

	this.positionCacheExpired = true;
};

HorizontalMenuView.prototype.onKeyPress = function(ch, key) {
	if(key) {
		var prevFocusedItemIndex = this.focusedItemIndex;

		if(this.isKeyMapped('left', key.name)) {
			if(0 === this.focusedItemIndex) {
				this.focusedItemIndex = this.items.length - 1;
			} else {
				this.focusedItemIndex--;
			}

		} else if(this.isKeyMapped('right', key.name)) {
			if(this.items.length - 1 === this.focusedItemIndex) {
				this.focusedItemIndex = 0;
			} else {
				this.focusedItemIndex++;
			}
		}

		if(prevFocusedItemIndex !== this.focusedItemIndex) {
			//	:TODO: Optimize this in cases where we only need to redraw two items. Always the case now, somtimes
			//	if this is changed to allow scrolling
			this.redraw();
			return;
		}
	}

	if(ch && this.hotKeys) {
		var keyIndex = this.hotKeys[this.caseInsensitiveHotKeys ? ch.toLowerCase() : ch];
		if(_.isNumber(keyIndex)) {
			this.focusedItemIndex = keyIndex;
			this.redraw();
		}
	}

	HorizontalMenuView.super_.prototype.onKeyPress.call(this, ch, key);
};

HorizontalMenuView.prototype.getData = function() {
	return this.focusedItemIndex;
};