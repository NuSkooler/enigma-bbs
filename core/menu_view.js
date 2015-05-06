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
	/*
	this.moveSelection = function(fromIndex, toIndex) {
		assert(!self.positionCacheExpired);
		assert(fromIndex >= 0 && fromIndex <= self.items.length);
		assert(toIndex >= 0 && toIndex <= self.items.length);

		self.items[fromIndex].focused	= false;
		self.drawItem(fromIndex);

		self.items[toIndex].focused 	= true;
		self.focusedItemIndex			= toIndex;
		self.drawItem(toIndex);
	};
	*/

	/*
	this.cachePositions = function() {
		//	:TODO: implement me!
	};

	this.drawItem = function(index) {
		//	:TODO: implement me!
	};*/
}

util.inherits(MenuView, View);

MenuView.prototype.redrawAllItems = function() {
	MenuView.super_.prototype.redraw.call(this);

	this.cachePositions();

	var count = this.items.length;
	for(var i = 0; i < count; ++i) {
		this.items[i].focused = this.focusedItemIndex === i;
		this.drawItem(i);
	}
};
/*

MenuView.prototype.redraw = function() {
	MenuView.super_.prototype.redraw.call(this);

	this.cachePositions();

	var count = this.items.length;
	for(var i = 0; i < count; ++i) {
		this.items[i].focused = this.focusedItemIndex === i;
		this.drawItem(i);
	}
};*/

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
	assert(_.isNumber(itemSpacing));

	this.itemSpacing			= itemSpacing;
	this.positionCacheExpired	= true;
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

