/* jslint node: true */
'use strict';

var MenuView		= require('./menu_view.js').MenuView;
var ansi			= require('./ansi_term.js');
var strUtil			= require('./string_util.js');

var util			= require('util');
var assert			= require('assert');
var _				= require('lodash');

exports.ToggleMenuView		= ToggleMenuView;

function ToggleMenuView (options) {
	options.cursor = options.cursor || 'hide';

	MenuView.call(this, options);

	var self = this;

	this.cachePositions = function() {
		self.positionCacheExpired = false;
	};

	this.updateSelection = function() {
		assert(!self.positionCacheExpired);
		assert(this.focusedItemIndex >= 0 && this.focusedItemIndex <= self.items.length);		

		self.redraw();
	};
}

util.inherits(ToggleMenuView, MenuView);

ToggleMenuView.prototype.redraw = function() {
	ToggleMenuView.super_.prototype.redraw.call(this);

	this.cachePositions();

	this.client.term.write(this.getANSIColor(this.hasFocus ? this.getFocusColor() : this.getColor()));

	assert(this.items.length === 2);
	for(var i = 0; i < 2; i++) {
		var item = this.items[i];
		var text = strUtil.stylizeString(
			item.text, i === this.focusedItemIndex && this.hasFocus ? this.focusTextStyle : this.textStyle);
		
		if(1 === i) {
			this.client.term.write(this.getANSIColor(this.getColor()) + ' / ');	//	:TODO: We need a color for this!!!
		}

		this.client.term.write(this.getANSIColor(i === this.focusedItemIndex ? this.getFocusColor() : this.getColor()));
		this.client.term.write(text);
	}
};

ToggleMenuView.prototype.setFocus = function(focused) {
	ToggleMenuView.super_.prototype.setFocus.call(this, focused);

	this.redraw();
};

ToggleMenuView.prototype.onKeyPress = function(key, isSpecial) {	
	if(isSpecial || !this.hotKeys) {
		return;
	}

	assert(1 === key.length);

	var keyIndex = this.hotKeys[this.caseInsensitiveHotKeys ? key.toLowerCase() : key];
	if(!_.isUndefined(keyIndex)) {
		this.focusedItemIndex = keyIndex;
		this.updateSelection();
	}

	ToggleMenuView.super_.prototype.onKeyPress.call(this, key, isSpecial);
};

ToggleMenuView.prototype.onSpecialKeyPress = function(keyName) {

	if(this.isSpecialKeyMapped('right', keyName) || this.isSpecialKeyMapped('down', keyName)) {
		if(this.items.length - 1 === this.focusedItemIndex) {
			this.focusedItemIndex = 0;
		} else {
			this.focusedItemIndex++;
		}
	} else if(this.isSpecialKeyMapped('left', keyName) || this.isSpecialKeyMapped('up', keyName)) {
		if(0 === this.focusedItemIndex) {
			this.focusedItemIndex = this.items.length - 1;
		} else {
			this.focusedItemIndex--;
		}
	}

	this.updateSelection();

	ToggleMenuView.super_.prototype.onSpecialKeyPress.call(this, keyName);
};

ToggleMenuView.prototype.getData = function() {
	return this.focusedItemIndex;
};

ToggleMenuView.prototype.setItems = function(items) {
	ToggleMenuView.super_.prototype.setItems.call(this, items);

	this.items = this.items.splice(0, 2);	//	switch/toggle only works with two elements

	this.dimens.width = this.items.join(' / ').length;	//	:TODO: allow configurable seperator... string & color, e.g. styleColor1 (same as fillChar color)
};
