/* jslint node: true */
'use strict';

var util		= require('util');
var ansi		= require('./ansi_term.js');
var miscUtil	= require('./misc_util.js');
var strUtil		= require('./string_util.js');
var assert		= require('assert');
var events		= require('events');
var logger		= require('./logger.js');

exports.View			= View;
exports.LabelView		= LabelView;
exports.TextEditView	= TextEditView;

exports.ViewsController	= ViewsController;

function View(client, options) {
	events.EventEmitter.call(this);

	var self = this;

	this.client 		= client;
	this.options		= options;
	this.acceptsFocus	= false;
	this.acceptsKeys	= false;
}

util.inherits(View, events.EventEmitter);

View.prototype.place = function(pos) {
	//
	//	We allow [x, y], { x : x, y : y }, or (x, y)
	//
	if(util.isArray(pos)) {
		this.x = pos[0];
		this.y = pos[1];
	} else if(pos.x && pos.y) {
		this.x = pos.x;
		this.y = pos.y;
	} else if(2 === arguments.length) {
		var x = parseInt(arguments[0], 10);
		var y = parseInt(arguments[1], 10);
		if(!isNaN(x) && !isNaN(y)) {
			this.x = x;
			this.y = y;
		}
	}

	assert(this.x > 0 && this.x < this.client.term.termHeight);
	assert(this.y > 0 && this.y < this.client.term.termWidth);

	this.client.term.write(ansi.goto(this.x, this.y));
};

View.prototype.setFocus = function(focused) {
	assert(this.x);
	assert(this.y);
};

View.prototype.getColor = function() {
	return this.options.color;
};

View.prototype.getFocusColor = function() {
	return this.options.focusColor || this.getColor();
};

function LabelView(client, text, options) {
	View.call(this, client);

	var self = this;

	if(options) {
		if(options.maxWidth) {
			text = text.substr(0, options.maxWidth);
		}

		text = strUtil.stylizeString(text, options.style);
	}

	this.value	= text;
	this.height	= 1;
	this.width	= this.value.length;
}

util.inherits(LabelView, View);

LabelView.prototype.place = function(pos) {
	LabelView.super_.prototype.place.apply(this, arguments);
	
	this.client.term.write(this.value);
};

///////////////////////////////////////////////////////////////////////////////

var INTERACTIVE_VIEW_DEFAULT_SPECIAL_KEYSET = {
	enter		: [ 'enter' ],
	exit		: [ 'esc' ],
	backspace	: [ 'backspace', 'del' ],
	next		: [ 'tab' ],
};

function InteractiveView(client, options) {
	View.call(this, client);
	
	this.acceptsFocus	= true;
	this.acceptsKeys	= true;

	if(options) {
		this.options = options;
	} else {
		this.options = {
		};
	}

	this.options.specialKeySet = miscUtil.valueWithDefault(
		options.specialKeySet, INTERACTIVE_VIEW_DEFAULT_SPECIAL_KEYSET
		);

	this.isSpecialKeyFor = function(checkFor, specialKey) {
		return this.options.specialKeySet[checkFor].indexOf(specialKey) > -1;
	};

	this.backspace = function() {
		this.client.term.write('\b \b');
	};
}

util.inherits(InteractiveView, View);

InteractiveView.prototype.setFocus = function(focused) {
	InteractiveView.super_.prototype.setFocus.call(this, focused);

	this.hasFocus = focused;
};

InteractiveView.prototype.setNextView = function(id) {
	this.nextId = id;
};


var TEXT_EDIT_INPUT_TYPES = [
	'normal', 'N',
	'password', 'P',
	'upper', 'U',
	'lower', 'l',
];


function TextEditView(client, options) {
	InteractiveView.call(this, client, options);

	if(!options) {
		this.options.multiLine = false;
	}

	this.options.inputType = miscUtil.valueWithDefault(this.options.inputType, 'normal');
	assert(TEXT_EDIT_INPUT_TYPES.indexOf(this.options.inputType) > -1);

	if('password' === this.options.inputType || 'P' === this.options.inputType) {
		this.options.inputMaskChar = miscUtil.valueWithDefault(this.options.inputMaskChar, '*').substr(0,1);
	}

	this.value = miscUtil.valueWithDefault(options.defaultValue, '');
	

	//	:TODO: hilight, text, etc., should come from options or default for theme if not provided

	//	focus=fg + bg
	//	standard=fg +bg

}

util.inherits(TextEditView, InteractiveView);


TextEditView.prototype.place = function(pos) {
	TextEditView.super_.prototype.place.apply(this, arguments);

	if(!this.options.maxWidth) {
		this.options.maxWidth = this.client.term.termWidth - this.x;
	}

	this.width = this.options.maxWidth;
};

TextEditView.prototype.setFocus = function(focused) {
	TextEditView.super_.prototype.setFocus.call(this, focused);

	this.client.term.write(ansi.goto(this.x, this.y));
	this.redraw();
	this.client.term.write(ansi.goto(this.x, this.y + this.value.length));
};

TextEditView.prototype.redraw = function() {
	var color = this.hasFocus ?	this.getFocusColor() : this.getColor();

	this.client.term.write(ansi.sgr(color.flags, color.fg, color.bg));
	this.client.term.write(strUtil.pad(this.value, this.width));
};

TextEditView.prototype.onKeyPressed = function(k, isSpecial) {
	assert(this.hasFocus);

	if(isSpecial) {
		return;	//	handled via onSpecialKeyPressed()
	}

	if(this.value.length < this.options.maxWidth) {

		k = strUtil.stylizeString(k, this.options.inputType);

		this.value += k;

		if('P' === this.options.inputType.charAt(0).toUpperCase()) {
			this.client.term.write(this.options.inputMaskChar);
		} else {
			this.client.term.write(k);
		}
	}
};

TextEditView.prototype.onSpecialKeyPressed = function(keyName) {
	assert(this.hasFocus);

	console.log(keyName);

	if(this.isSpecialKeyFor('backspace', keyName)) {
		if(this.value.length > 0) {
			this.value = this.value.substr(0, this.value.length - 1);
			this.backspace();
		}
	} else if(this.isSpecialKeyFor('enter', keyName)) {
		if(this.options.multiLine) {

		} else {
			this.emit('action', 'accepted');
		}
	} else if(this.isSpecialKeyFor('next', keyName)) {
		this.emit('action', 'next');
	}
};


function MenuView(options) {

}

function VerticalMenuView(options) {

}

///////////////////////////////////////////////////////
//	:TODO: Move to view_controller.js
function ViewsController(client) {
	events.EventEmitter.call(this);

	var self = this;

	this.views	= {};
	this.client = client;

	client.on('key press', function onKeyPress(k, isSpecial) {
		if(self.focusedView && self.focusedView.acceptsKeys) {
			self.focusedView.onKeyPressed(k, isSpecial);
		}
	});

	client.on('special key', function onSpecialKey(keyName) {
		if(self.focusedView && self.focusedView.acceptsKeys) {
			self.focusedView.onSpecialKeyPressed(keyName);
		}
	});

	this.onViewAction = function(action) {
		console.log(action + ' @ ' + this.id);

		if('next' === action) {
			self.emit('action', { view : this, action : action });
			self.nextFocus();
		} else if('accepted' === action) {
			if(self.submitViewId == this.id) {
				self.emit('action', { view : this, action : 'submit' });	
			} else {
				self.nextFocus();
			}
		}
		/*
		if(self.submitViewId == this.id) {
			self.emit('action', { view : this, action : 'submit' });
		} else {
			self.emit('action', { view : this, action : action });

			if('accepted' === action || 'next' === action) {
				self.nextFocus();
			}
		}*/
	};

}

util.inherits(ViewsController, events.EventEmitter);

ViewsController.prototype.addView = function(viewInfo) {
	viewInfo.view.id = viewInfo.id;

	this.views[viewInfo.id] = {
		view	: viewInfo.view,
		pos		: viewInfo.pos
	};

	viewInfo.view.place(viewInfo.pos);
};

ViewsController.prototype.viewExists = function(id) {
	return id in this.views;
};

ViewsController.prototype.getView = function(id) {
	return this.views[id].view;
};

ViewsController.prototype.switchFocus = function(id) {
	var view = this.getView(id);

	if(!view) {
		logger.log.warn('Invalid view', { id : id });
		return false;
	}

	if(!view.acceptsFocus) {
		logger.log.warn('View does not accept focus', { id : id });
		return false;
	}

	this.focusedView = view;
	view.setFocus(true);
};

ViewsController.prototype.nextFocus = function() {
	var nextId = this.focusedView.nextId;

	this.focusedView.setFocus(false);

	if(nextId > 0) {
		this.switchFocus(nextId);
	} else {
		this.switchFocus(this.firstId);
	}
};

ViewsController.prototype.setSubmitView = function(id) {
	this.submitViewId = id;
};

ViewsController.prototype.loadFromMCIMap = function(mciMap) {
	var factory = new MCIViewFactory(this.client);
	var view;
	var mci;

	for(var entry in mciMap) {
		mci		= mciMap[entry];
		view	= factory.createFromMCI(mci);

		if(view) {
			this.addView({
				id		: mci.id,
				view	: view,
				pos		: mci.position
			});

			view.on('action', this.onViewAction);
		}
	}
};

ViewsController.prototype.setViewOrder = function(order) {
	var idOrder = [];

	if(order) {
		//	:TODO:
	} else {
		for(var id in this.views) {
			idOrder.push(id);
		}
		//	:TODO: simply sort
		console.log(idOrder);
		this.firstId = idOrder[0];
	}

	var view;
	for(var i = 0; i < idOrder.length - 1; ++i) {
		view = this.getView(idOrder[i]);
		if(view) {
			view.setNextView(idOrder[i + 1]);
		}
	}
};

///////////////////////////////////////////////////

function MCIViewFactory(client, mci) {
	this.client = client;
}

MCIViewFactory.prototype.createFromMCI = function(mci) {
	assert(mci.code);
	assert(mci.id > 0);

	var view;
	var options = {};

	switch(mci.code) {
		case 'EV' :
			if(mci.args.length > 0) {
				options.maxWidth = mci.args[0];
			}

			if(mci.args.length > 1) {
				options.inputType = mci.args[1];
			}

			options.color		= mci.color;
			options.focusColor	= mci.focusColor;

			view = new TextEditView(this.client, options);
			break;
	}

	return view;
};