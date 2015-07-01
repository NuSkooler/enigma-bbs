/* jslint node: true */
'use strict';

var MenuView		= require('./menu_view.js').MenuView;
var ansi			= require('./ansi_term.js');
var strUtil			= require('./string_util.js');

var assert			= require('assert');

exports.HorizontalMenuView		= HorizontalMenuView;

function HorizontalMenuView(options) {
	options.cursor	= options.cursor || 'hide';

	MenuView.call(this, options);

	this.dimens.height = 1;	//	always the case

	var self = this;

	this.getSpacer = function() {
		return new Array(self.itemSpacing).join(' ');
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

			self.itemColumns = [];
			for(var i = 0; i < self.items.length; ++i) {
				self.itemColumns[i] = col;
				col += spacer.length + self.items[i].length + spacer.length;
			}
		}

		this.positionCacheExpired = false;
	};

	this.drawItem = function(index) {
		assert(self.itemColumns.length === self.items.length);

		var item = self.items[index];
		if(!item) {
			return;
		}

		self.client.term.write(ansi.goto(item.row, self.itemColumns[index]));
		self.client.term.write(index === self.focusedItemIndex ? self.getFocusSGR() : self.getSGR());

		var text = strUtil.stylizeString(item.text, item.focused ? self.focusTextStyle : self.textStyle);

		var extraPad = self.getSpacer().length * 2;
		self.client.term.write(
			strUtil.pad(text, text.length + extraPad, this.fillChar, 'center'));
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