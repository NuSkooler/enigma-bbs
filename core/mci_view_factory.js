/* jslint node: true */
'use strict';

var TextView		= require('./text_view.js').TextView;
var EditTextView	= require('./edit_text_view.js').EditTextView;
var ButtonView		= require('./button_view.js').ButtonView;
var assert			= require('assert');

exports.MCIViewFactory		= MCIViewFactory;

function MCIViewFactory(client) {
	this.client = client;
}

MCIViewFactory.prototype.createFromMCI = function(mci) {
	assert(mci.code);
	assert(mci.id > 0);
	assert(mci.position);

	var view;
	var options = {
		id			: mci.id,
		color		: mci.color,
		focusColor	: mci.focusColor,
		position	: { x : mci.position[0], y : mci.position[1] },
	};

	switch(mci.code) {
		case 'EV' :
			if(mci.args.length > 0) {
				options.maxLength	= mci.args[0];
				options.dimens		= { width : options.maxLength };
			}

			if(mci.args.length > 1) {
				options.textStyle = mci.args[1];
			}

			view = new EditTextView(this.client, options);
			break;

		case 'BV' : 
			if(mci.args.length > 0) {
				options.text 	= mci.args[0];
				options.dimens	= { width : options.text.length };
			}

			view = new ButtonView(this.client, options);
			break;
	}

	return view;
};

