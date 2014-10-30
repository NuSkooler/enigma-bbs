/* jslint node: true */
'use strict';

var events		= require('events');
var util		= require('util');
var assert		= require('assert');
var ansi		= require('./ansi_term.js');

exports.View							= View;
exports.VIEW_SPECIAL_KEY_MAP_DEFAULT	= VIEW_SPECIAL_KEY_MAP_DEFAULT;

var VIEW_SPECIAL_KEY_MAP_DEFAULT = {
	accept		: [ 'enter' ],
	exit		: [ 'esc' ],
	backspace	: [ 'backspace' ],
	del			: [ 'del' ],
	next		: [ 'tab' ],
};

function View(client, options) {
	events.EventEmitter.call(this);

	assert(client);

	var self			= this;

	this.client			= client;
	this.options		= options || {};
	
	this.acceptsFocus	= options.acceptsFocus || false;
	this.acceptsInput	= options.acceptsInput || false;

	this.position 		= { x : 0, y : 0 };
	this.dimens			= { height : 1, width : 0 };

	if(this.options.id) {
		this.setId(this.options.id);
	}

	if(this.options.position) {
		this.setPosition(this.options.position);
	}

	//	:TODO: Don't allow width/height > client.term
	if(this.options.dimens && this.options.dimens.height) {
		this.dimens.height = this.options.dimens.height;
	}

	if(this.options.dimens && this.options.dimens.width) {
		this.dimens.width = this.options.dimens.width;
	}

	this.color			= this.options.color || { flags : 0, fg : 7,  bg : 0 };
	this.focusColor		= this.options.focusColor || this.color;

	if(this.acceptsInput) {
		this.specialKeyMap = this.options.specialKeyMap || VIEW_SPECIAL_KEY_MAP_DEFAULT;
	}

	this.isSpecialKeyMapped = function(keySet, keyName) {
		return this.specialKeyMap[keySet].indexOf(keyName) > -1;
	};

	this.getANSIColor = function(color) {
		var sgr = [ color.flags, color.fg ];
		if(color.bg !== color.flags) {
			sgr.push(color.bg);
		}
		return ansi.sgr(sgr);
	};
}

util.inherits(View, events.EventEmitter);

View.prototype.setId = function(id) {
	this.id = id;
};

View.prototype.setPosition = function(pos) {
	//
	//	We allow [x, y], { x : x, y : y }, or (x, y)
	//
	if(util.isArray(pos)) {
		this.position.x = pos[0];
		this.position.y = pos[1];
	} else if(pos.x && pos.y) {
		this.position.x = pos.x;
		this.position.y = pos.y;
	} else if(2 === arguments.length) {
		this.position.x = parseInt(arguments[0], 10);
		this.position.y = parseInt(arguments[1], 10);
	}
	
	assert(!(isNaN(this.position.x)));
	assert(!(isNaN(this.position.y)));

	assert(
		this.position.x > 0 && this.position.x <= this.client.term.termHeight, 
		'X position ' + this.position.x + ' out of terminal range ' + this.client.term.termHeight);

	assert(
		this.position.y > 0 && this.position.y <= this.client.term.termWidth, 
		'Y position ' + this.position.y + ' out of terminal range ' + this.client.term.termWidth);
};

View.prototype.getColor = function() {
	return this.color;
};

View.prototype.getFocusColor = function() {
	return this.focusColor;
};

View.prototype.redraw = function() {
	this.client.term.write(ansi.goto(this.position.x, this.position.y));
};

View.prototype.setFocus = function(focused) {
	assert(this.acceptsFocus, 'View does not accept focus');

	this.hasFocus = focused;
};

View.prototype.onKeyPress = function(key, isSpecial) {
	assert(this.hasFocus, 'View does not have focus');
	assert(this.acceptsInput, 'View does not accept input');
};

View.prototype.onSpecialKeyPress = function(keyName) {
	assert(this.hasFocus, 'View does not have focus');
	assert(this.acceptsInput, 'View does not accept input');
	assert(this.specialKeyMap, 'No special key map defined');

	if(this.isSpecialKeyMapped('accept', keyName)) {
		this.emit('action', 'accept');
	} else if(this.isSpecialKeyMapped('next', keyName)) {
		this.emit('action', 'next');
	}
};