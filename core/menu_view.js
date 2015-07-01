/* jslint node: true */
'use strict';

var View			= require('./view.js').View;
var ansi			= require('./ansi_term.js');
var miscUtil		= require('./misc_util.js');

var util			= require('util');
var assert			= require('assert');
var _				= require('lodash');

exports.MenuView	= MenuView;

function MenuView(options) {
	options.acceptsFocus = miscUtil.valueWithDefault(options.acceptsFocus, true);
	options.acceptsInput = miscUtil.valueWithDefault(options.acceptsInput, true);

	View.call(this, options);

	var self = this;

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
}

util.inherits(MenuView, View);

MenuView.prototype.setItems = function(items) {
	var self = this;
	if(items) {	
		this.items = [];	//	:TODO: better way?
		items.forEach(function onItem(itemText) {
			self.items.push({
				text		: itemText
			});
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
		case 'hotKeys'		: this.setHotKeys(value); break;
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

