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
	var self = this;

	View.call(this, client, options);

	this.focusedItemIndex = 0;
	

	//// --- TESTING 
	options.items = [ 'Login', 'Apply', 'Logout' ];
	//options.itemSpacing = 2;
	//// --- TESTING 

	this.items = [];
	if(this.options.items) {
		this.options.items.forEach(function onItem(itemText) {
			self.items.push({
				text		: itemText,
				selected	: false,
			});
		});
	}

	this.itemSpacing	= this.options.itemSpacing || 1;
	this.itemSpacing	= parseInt(this.itemSpacing, 10);

	this.focusPrefix	= this.options.focusPrefix || '';
	this.focusSuffix	= this.options.focusSuffix || '';
}

util.inherits(MenuView, View);

