/* jslint node: true */
'use strict';

var TextView		= require('./text_view.js').TextView;
var util			= require('util');
var assert			= require('assert');

function ButtonView(client, options) {
	options.acceptsFocus = miscUtil.valueWithDefault(options.acceptsFocus, true);
	options.acceptsInput = miscUtil.valueWithDefault(options.acceptsInput, true);

	TextView.call(this, client, options);
}

util.inherits(ButtonView, TextView);

ButtonView.prototype.onKeyPress = function(key, isSpecial) {
	//	we accept input so this must be implemented -- nothing to do here, however
	//	:TODO: Move this to View along with default asserts; update EditTextView to call View 
}

ButtonView.prototype.onSpecialKeyPress = function(keyName) {
	assert(this.hasFocus);
	assert(this.acceptsInput);
	assert(this.specialKeyMap);

	//	:TODO: see notes about making base handle 'enter' key(s)
	//	...just make enter = enter | space for a button by default
}