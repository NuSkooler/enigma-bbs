/* jslint node: true */
'use strict';

var View		= require('./view.js').View;
var TextView	= require('./text_view.js').TextView;

var assert		= require('assert');
var _			= require('lodash');

function StatusBarView(options) {
	View.call(this, options);

	var self = this;


}

require('util').inherits(StatusBarView, View);

StatusBarView.prototype.redraw = function() {

	StatusBarView.super_.prototype.redraw.call(this);

};

StatusBarView.prototype.setPanels = function(panels) {

/*
	"panels" : [
		{
			"text" : "things and stuff",
			"width" 20,
			...
		},
		{
			"width" : 40 // no text, etc... = spacer
		}
	]

	|---------------------------------------------|
	  | stuff |
*/
};

