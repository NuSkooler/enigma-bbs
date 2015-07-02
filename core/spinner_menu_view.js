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
	options.cursor	= options.cursor || 'hide';

	MenuView.call(this, options);
	
	var self = this;

	/*
	this.cachePositions = function() {
		self.positionCacheExpired = false;
	};
	*/

	this.updateSelection = function() {
		//assert(!self.positionCacheExpired);

		assert(this.focusedItemIndex >= 0 && this.focusedItemIndex <= self.items.length);
		
		self.drawItem(this.focusedItemIndex);
	};

	this.drawItem = function() {
		var item = self.items[this.focusedItemIndex];
		if(!item) {
			return;
		}

		this.client.term.write(ansi.goto(this.position.row, this.position.col));
		this.client.term.write(self.hasFocus ? self.getFocusSGR() : self.getSGR());

		var text = strUtil.stylizeString(item.text, item.focused ? self.focusTextStyle : self.textStyle);

		self.client.term.write(
			strUtil.pad(text, this.dimens.width + 1, this.fillChar, this.justify));
	};
}

util.inherits(SpinnerMenuView, MenuView);

SpinnerMenuView.prototype.redraw = function() {
	SpinnerMenuView.super_.prototype.redraw.call(this);

	//this.cachePositions();
	this.drawItem(this.focusedItemIndex);
};

SpinnerMenuView.prototype.setFocus = function(focused) {
	SpinnerMenuView.super_.prototype.setFocus.call(this, focused);

	this.redraw();
};

SpinnerMenuView.prototype.onKeyPress = function(ch, key) {
	if(key) {
		if(this.isKeyMapped('up', key.name)) {		
			if(0 === this.focusedItemIndex) {
				this.focusedItemIndex = this.items.length - 1;
			} else {
				this.focusedItemIndex--;
			}
			
			this.updateSelection();
			return;
		} else if(this.isKeyMapped('down', key.name)) {
			if(this.items.length - 1 === this.focusedItemIndex) {
				this.focusedItemIndex = 0;
			} else {
				this.focusedItemIndex++;
			}
			
			this.updateSelection();
			return;
		}
	}

	SpinnerMenuView.super_.prototype.onKeyPress.call(this, ch, key);
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