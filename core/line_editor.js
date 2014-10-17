"use strict";

var assert		= require('assert');
var miscUtil	= require('./misc_util.js');

exports.LineEditor	= LineEditor;

var STANDARD_KEYSET = {
	refresh	: [ 12 ],
	backspace	: [ 8, 127 ],
	backword	: [ 23 ],
	enter		: [ 10 ],
	exit		: [ 27 ],
};

//	:TODO: Rename to TextEdit
//	:TODO: TextEdit should be single or multi line


function LineEditor(client, options) {
	var self = this;

	self.client 	= client;
	self.valueText	= '';

	if(typeof options !== 'undefined') {
		self.options.keyset = miscUtil.valueWithDefault(options.keyset, STANDARD_KEYSET);
	} else {
		self.options = {
			keyset	: STANDARD_KEYSET,
		};
	}


	this.client.on('data', function onData(data) {
		assert(1 === data.length);
		self.onCh(data);

	});
};

LineEditor.prototype.isKey = function(setName, ch) {
	return this.options.keyset[setName].indexOf(ch) > -1;
}

LineEditor.prototype.onCh = function(ch) {
	if(this.isKey('refresh', ch)) {

	} else if(this.isKey('backspace', ch)) {

	} else if(this.isKey('backword', ch)) {

	} else if(this.isKey('enter', ch)) {

	} else if(this.isKey('exit', ch)) {

	} else {

		//	:TODO: filter out chars
		//	:TODO: check max width
		this.valueText += ch;
		this.client.term.write(ch);
	}
};
