/* jslint node: true */
'use strict';

var util		= require('util');
var ansi		= require('./ansi_term.js');

exports.View			= View;
exports.LabelView		= LabelView;

function View(client) {
	var self = this;

	console.log('View ctor');

	this.client = client;

//	this.width	= width;
//	this.height	= height;
}

//	:TODO: allow pos[] or x, y
View.prototype.draw = function(x, y) {
};

function LabelView(client, text, width) {
	View.call(this, client);

	var self = this;

	this.text	= text;
	this.width	= width || text.length;

}

util.inherits(LabelView, View);

LabelView.prototype.draw = function(x, y) {
	LabelView.super_.prototype.draw.call(this, x, y);

	this.client.term.write(ansi.goto(x, y));
	this.client.term.write(this.text);
};


function MenuView(options) {

}

function VerticalMenuView(options) {

}