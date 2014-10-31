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
}

util.inherits(VerticalMenuView, MenuView);

VerticalMenuView.prototype.setPosition = function(pos) {
	VerticalMenuView.super_.prototype.setPosition.call(this, pos);

	this.xPositionCacheExpired = true;
};

VerticalMenuView.prototype.redraw = function() {
	VerticalMenuView.super_.prototype.redraw.call(this);

	var color		= this.getColor();
	var focusColor	= this.getFocusColor();
	console.log(focusColor);
	var x			= this.position.x;
	var y			= this.position.y;

	var count = this.items.length;
	var item;
	var text;

	this.cacheXPositions();

	for(var i = 0; i < count; ++i) {
		item = this.items[i];

		this.client.term.write(ansi.goto(item.xPosition, y));

		this.client.term.write(this.getANSIColor(i === this.focusedItemIndex || item.selected ? focusColor : color));

		text = strUtil.stylizeString(item.text, item.hasFocus ? this.focusTextStyle : this.textStyle);
		this.client.term.write(text);	//	:TODO: apply justify, and style		
	}
};

VerticalMenuView.prototype.setFocus = function(focused) {
	VerticalMenuView.super_.prototype.setFocus.call(this, focused);

	this.redraw();
};