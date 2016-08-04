/* jslint node: true */
'use strict';

//	ENiGMA½
const View			= require('./view.js').View;
const miscUtil		= require('./misc_util.js');

//	deps
const util			= require('util');
const assert		= require('assert');
const _				= require('lodash');

exports.MenuView	= MenuView;

function MenuView(options) {
	options.acceptsFocus = miscUtil.valueWithDefault(options.acceptsFocus, true);
	options.acceptsInput = miscUtil.valueWithDefault(options.acceptsInput, true);

	View.call(this, options);

	const self = this;

	if(options.items) {
		this.setItems(options.items);
	} else {
		this.items = [];
	}

	this.caseInsensitiveHotKeys = miscUtil.valueWithDefault(options.caseInsensitiveHotKeys, true);

	this.setHotKeys(options.hotKeys);

	this.focusedItemIndex = options.focusedItemIndex || 0;
	this.focusedItemIndex = this.items.length >= this.focusedItemIndex ? this.focusedItemIndex : 0;

	this.itemSpacing	= _.isNumber(options.itemSpacing) ? options.itemSpacing : 0;

	//	:TODO: probably just replace this with owner draw / pipe codes / etc. more control, less specialization
	this.focusPrefix	= options.focusPrefix || '';
	this.focusSuffix	= options.focusSuffix || '';

	this.fillChar		= miscUtil.valueWithDefault(options.fillChar, ' ').substr(0, 1);
	this.justify		= options.justify || 'none';

	this.hasFocusItems = function() {
		return !_.isUndefined(self.focusItems);
	};

	this.getHotKeyItemIndex = function(ch) {
		if(ch && self.hotKeys) {
			const keyIndex = self.hotKeys[self.caseInsensitiveHotKeys ? ch.toLowerCase() : ch];
			if(_.isNumber(keyIndex)) {
				return keyIndex;
			}
		}
		return -1;
	};
}

util.inherits(MenuView, View);

MenuView.prototype.setItems = function(items) {
	if(items) {	
		this.items = [];
		items.forEach( itemText => {
			this.items.push( { text : itemText } );
		});
	}
};

MenuView.prototype.getCount = function() {
	return this.items.length;
};

MenuView.prototype.getItems = function() {	
	return this.items.map( item => {
		return item.text;
	});
};

MenuView.prototype.getItem = function(index) {
	return this.items[index].text;
};

MenuView.prototype.focusNext = function() {
	//	nothing @ base currently
	this.emit('index update', this.focusedItemIndex);
};

MenuView.prototype.focusPrevious = function() {
	//	nothign @ base currently
	this.emit('index update', this.focusedItemIndex);
};

MenuView.prototype.setFocusItemIndex = function(index) {
	this.focusedItemIndex = index;
};

MenuView.prototype.onKeyPress = function(ch, key) {
	const itemIndex = this.getHotKeyItemIndex(ch);
	if(itemIndex >= 0) {
		this.setFocusItemIndex(itemIndex);

		if(true === this.hotKeySubmit) {
			this.emit('action', 'accept');
		}
	}

	MenuView.super_.prototype.onKeyPress.call(this, ch, key);
};

MenuView.prototype.setFocusItems = function(items) {
	if(items) {
		this.focusItems = [];
		items.forEach( itemText => {
			this.focusItems.push( { text : itemText } );
		});
	}
};

MenuView.prototype.setItemSpacing = function(itemSpacing) {
	itemSpacing = parseInt(itemSpacing);
	assert(_.isNumber(itemSpacing));

	this.itemSpacing			= itemSpacing;
	this.positionCacheExpired	= true;
};

MenuView.prototype.setPropertyValue = function(propName, value) {
	switch(propName) {
		case 'itemSpacing' 	: this.setItemSpacing(value); break;
		case 'items'		: this.setItems(value); break;
		case 'focusItems'	: this.setFocusItems(value); break;
		case 'hotKeys'		: this.setHotKeys(value); break;
		case 'hotKeySubmit'	: this.hotKeySubmit = value; break;
		case 'justify'		: this.justify = value; break;
	}

	MenuView.super_.prototype.setPropertyValue.call(this, propName, value);
};

MenuView.prototype.setHotKeys = function(hotKeys) {
	if(_.isObject(hotKeys)) {
		if(this.caseInsensitiveHotKeys) {
			this.hotKeys = {};
			for(var key in hotKeys) {
				this.hotKeys[key.toLowerCase()] = hotKeys[key];
			}
		} else {
			this.hotKeys = hotKeys;	
		}
	}
};

