/* jslint node: true */
'use strict';

var events		= require('events');
var util		= require('util');
var assert		= require('assert');
var ansi		= require('./ansi_term.js');
var _			= require('lodash');

exports.View							= View;
exports.VIEW_SPECIAL_KEY_MAP_DEFAULT	= VIEW_SPECIAL_KEY_MAP_DEFAULT;

var VIEW_SPECIAL_KEY_MAP_DEFAULT = {
	accept		: [ 'enter' ],
	exit		: [ 'esc' ],
	backspace	: [ 'backspace', 'del' ],
	del			: [ 'del' ],
	next		: [ 'tab' ],
	up			: [ 'up arrow' ],
	down		: [ 'down arrow' ],
	end			: [ 'end' ],
	home		: [ 'home' ],
	left		: [ 'left arrow' ],
	right		: [ 'right arrow' ],
	clearLine	: [ 'end of medium' ],
};

function View(options) {
	events.EventEmitter.call(this);

	assert(_.isObject(options));
	assert(_.isObject(options.client));

	var self			= this;

	this.client			= options.client;
	
	this.cursor			= options.cursor || 'show';
	this.cursorStyle	= options.cursorStyle || 'default';

	this.acceptsFocus	= options.acceptsFocus || false;
	this.acceptsInput	= options.acceptsInput || false;

	this.position 		= { x : 0, y : 0 };
	this.dimens			= { height : 1, width : 0 };

	this.textStyle		= options.textStyle || 'normal';
	this.focusTextStyle	= options.focusTextStyle || this.textStyle;

	if(options.id) {
		this.setId(options.id);
	}

	if(options.position) {
		this.setPosition(options.position);
	}

	if(_.isObject(options.autoScale)) {
		this.autoScale = options.autoScale;
	} else {
		this.autoScale = { height : true, width : true };
	}

	if(options.dimens) {
		this.setDimension(options.dimens);
		this.autoScale = { height : false, width : false };
	} else {
		this.dimens = { width : 0, height : 0 };
	}

	this.ansiSGR		= options.ansiSGR || ansi.getSGRFromGraphicRendition( { fg : 39, bg : 49 }, true);
	this.ansiFocusSGR	= options.ansiFocusSGR || this.ansiSGR;

	this.styleSGR1		= options.styleSGR1 || this.ansiSGR;
	this.styleSGR2		= options.styleSGR2 || this.ansiFocusSGR;

	if(this.acceptsInput) {
		this.specialKeyMap = options.specialKeyMap || VIEW_SPECIAL_KEY_MAP_DEFAULT;
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

	this.hideCusor = function() {
		self.client.term.write(ansi.hideCursor());
	};

	this.restoreCursor = function() {
		//this.client.term.write(ansi.setCursorStyle(this.cursorStyle));
		this.client.term.write('show' === this.cursor ? ansi.showCursor() : ansi.hideCursor());
	};
}

util.inherits(View, events.EventEmitter);

View.prototype.setId = function(id) {
	this.id = id;
};

View.prototype.getId = function() {
	return this.id;
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

View.prototype.setDimension = function(dimens) {
	assert(_.isObject(dimens) && _.isNumber(dimens.height) && _.isNumber(dimens.width));

	this.dimens		= dimens;
	this.autoScale	= { height : false, width : false };
};

View.prototype.setHeight = function(height) {
	this.dimens.height		= height;
	this.autoScale.height	= false;
};

View.prototype.setWidth = function(width) {
	this.dimens.width		= width;
	this.autoScale.width	= false;
};

/*
View.prototype.setColor = function(color, bgColor, flags) {
	if(_.isObject(color)) {
		assert(_.has(color, 'fg'));
		assert(_.has(color, 'bg'));
		assert(_.has(color, 'flags'));

		this.color = color;
	} else {
		if(color) {
			this.color.fg = color;
		}

		if(bgColor) {
			this.color.bg = bgColor;
		}

		if(_.isNumber(flags)) {
			this.color.flags = flags;
		}
	}

	//	allow strings such as 'red', 'black', etc. to be passed
	if(_.isString(this.color.fg)) {
		this.color.fg = ansi.getFGColorValue(this.color.fg);
	}

	if(_.isString(this.color.bg)) {
		this.color.bg = ansi.getBGColorValue(this.color.bg);
	}	
};
*/

View.prototype.getSGR = function() {
	return this.ansiSGR;
};

View.prototype.getFocusSGR = function() {
	return this.ansiFocusSGR;
};

View.prototype.redraw = function() {
	this.client.term.write(ansi.goto(this.position.x, this.position.y));
};

View.prototype.setFocus = function(focused) {
	assert(this.acceptsFocus, 'View does not accept focus');

	this.hasFocus = focused;
	this.restoreCursor();
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

View.prototype.getData = function() {
};