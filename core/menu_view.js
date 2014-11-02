/* jslint node: true */
'use strict';

var View			= require('./view.js').View;
var ansi			= require('./ansi_term.js');
var miscUtil		= require('./misc_util.js');
var util			= require('util');
var assert			= require('assert');

exports.MenuView	= MenuView;

function MenuView(client, options) {
	options.acceptsFocus = miscUtil.valueWithDefault(options.acceptsFocus, true);
	options.acceptsInput = miscUtil.valueWithDefault(options.acceptsInput, true);

	View.call(this, client, options);

	var self = this;

	if(this.options.items) {
		this.setItems(this.options.items);
	} else {
		this.items = [];
	}

	this.focusedItemIndex = this.options.focusedItemIndex || 0;
	this.focusedItemIndex = this.items.length >= this.focusedItemIndex ? this.focusedItemIndex : 0;

	this.itemSpacing	= this.options.itemSpacing || 1;
	this.itemSpacing	= parseInt(this.itemSpacing, 10);

	this.focusPrefix	= this.options.focusPrefix || '';
	this.focusSuffix	= this.options.focusSuffix || '';

	this.fillChar		= miscUtil.valueWithDefault(this.options.fillChar, ' ').substr(0, 1);
	this.justify		= this.options.justify || 'none';
}

util.inherits(MenuView, View);

MenuView.prototype.setItems = function(items) {
	var self = this;
	if(items) {	
		this.items = [];	//	:TODO: better way?
		items.forEach(function onItem(itemText) {
			self.items.push({
				text		: itemText,
				selected	: false,
			});
		});
	}
};

