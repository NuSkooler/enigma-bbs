/* jslint node: true */
'use strict';

var MenuView		= require('./menu_view.js').MenuView;
var ansi			= require('./ansi_term.js');
var strUtil			= require('./string_util.js');

function HorizontalMenuView = function(options) {
	options.cursor	= options.cursor || 'hide';

	MenuView.call(this, options);

	var self = this;
}

require('util').inherits(HorizontalMenuView, MenuView);

HorizontalMenuView.prototype.redraw = function() {
	HorizontalMenuView.super_.prototype.redraw.call(this);
};

HorizontalMenuView.prototype.setPosition = function(pos) {
	HorizontalMenuView.super_.prototype.setPosition.call(this, pos);


};

HorizontalMenuView.prototype.setFocus = function(focused) {
	HorizontalMenuView.super_.prototype.setFocus.call(this, focused);

	this.redraw();
};

HorizontalMenuView.prototype.setItems = function(items) {
	HorizontalMenuView.super_.prototype.setItems.call(this, items);

	//
	//	Styles:
	//	* itemPadding: n
	//	* 
	//
	//	
	//	item1 item2 itemThree itemfour!!!!!
	//              ^^^^^^^^^
	//
	//	item1	item2	itemThree	item!!!!!
	//		   ^^^^^^^


};