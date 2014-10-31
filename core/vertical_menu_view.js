/* jslint node: true */
'use strict';

var MenuView		= require('./menu_view.js').MenuView;
var ansi			= require('./ansi_term.js');
var util			= require('util');
var assert			= require('assert');

function VerticalMenuView(client, options) {
	MenuView.call(this, client, options);
}

util.inherits(VerticalMenuView, MenuView);

VerticalMenuView.prototype.redraw = function() {
	VerticalMenuView.super_.prototype.redraw.call(this);
};