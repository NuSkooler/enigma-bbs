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

	/*
	this.cachePositions = function() {
		self.positionCacheExpired = false;
	};
	*/

	this.updateSelection = function() {
		//assert(!self.positionCacheExpired);
		assert(this.focusedItemIndex >= 0 && this.focusedItemIndex <= self.items.length);

		self.redraw();
	};
}

util.inherits(ToggleMenuView, MenuView);

ToggleMenuView.prototype.redraw = function() {
	ToggleMenuView.super_.prototype.redraw.call(this);

	//this.cachePositions();

	this.client.term.write(this.hasFocus ? this.getFocusSGR() : this.getSGR());

	assert(this.items.length === 2);
	for(var i = 0; i < 2; i++) {
		var item = this.items[i];
		var text = strUtil.stylizeString(
			item.text, i === this.focusedItemIndex && this.hasFocus ? this.focusTextStyle : this.textStyle);
		
		if(1 === i) {
			//console.log(this.styleColor1)
			//var sepColor = this.getANSIColor(this.styleColor1 || this.getColor());
			//console.log(sepColor.substr(1))
			//var sepColor = '\u001b[0m\u001b[1;30m';	//	:TODO: FIX ME!!!
			//	:TODO: sepChar needs to be configurable!!!
			this.client.term.write(this.styleSGR1 + ' / ');
			//this.client.term.write(sepColor + ' / ');
		}

		this.client.term.write(i === this.focusedItemIndex ? this.getFocusSGR() : this.getSGR());
		this.client.term.write(text);
	}
};

ToggleMenuView.prototype.setFocus = function(focused) {
	ToggleMenuView.super_.prototype.setFocus.call(this, focused);

	this.redraw();
};

ToggleMenuView.prototype.onKeyPress = function(ch, key) {
	if(key) {
		var needsUpdate;
		if(this.isKeyMapped('right', key.name) || this.isKeyMapped('down', key.name)) {
			if(this.items.length - 1 === this.focusedItemIndex) {
				this.focusedItemIndex = 0;
			} else {
				this.focusedItemIndex++;
			}
			needsUpdate = true;
		} else if(this.isKeyMapped('left', key.name) || this.isKeyMapped('up', key.name)) {
			if(0 === this.focusedItemIndex) {
				this.focusedItemIndex = this.items.length - 1;
			} else {
				this.focusedItemIndex--;
			}
			needsUpdate = true;
		}

		if(needsUpdate) {
			this.updateSelection();
			return;
		}
	}

	if(ch && this.hotKeys) {
		var keyIndex = this.hotKeys[this.caseInsensitiveHotKeys ? ch.toLowerCase() : ch];
		if(_.isNumber(keyIndex)) {
			this.focusedItemIndex = keyIndex;
			this.updateSelection();
		}
	}

	ToggleMenuView.super_.prototype.onKeyPress.call(this, ch, key);
};

ToggleMenuView.prototype.getData = function() {
	return this.focusedItemIndex;
};

ToggleMenuView.prototype.setItems = function(items) {
	ToggleMenuView.super_.prototype.setItems.call(this, items);

	this.items = this.items.splice(0, 2);	//	switch/toggle only works with two elements

	this.dimens.width = this.items.join(' / ').length;	//	:TODO: allow configurable seperator... string & color, e.g. styleColor1 (same as fillChar color)
};
