/* jslint node: true */
'use strict';

var View			= require('./view.js').View;
var ansi			= require('./ansi_term.js');
var util			= require('util');
var assert			= require('assert');

exports.MenuView	= MenuView;

function MenuView(client, options) {
	View.call(this, client, options);

	this.items = [];
	if(this.options.items) {
		this.options.items.forEach(function onItem(itemText) {
			this.items.push({
				text		: itemText,
				focused		: false,
				selected	: false,
			});
		});
	}

	this.itemSpacing	= this.options.itemSpacing || 1;
	this.focusPrefix	= this.options.focusPrefix || '';
	this.focusSuffix	= this.options.focusSuffix || '';
}

util.inherits(MenuView, View);

