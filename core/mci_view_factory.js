/* jslint node: true */
'use strict';

var TextView		= require('./text_view.js').TextView;
var EditTextView	= require('./edit_text_view.js').EditTextView;
var ButtonView		= require('./button_view.js').ButtonView;
var Config			= require('./config.js').config;
var packageJson 	= require('../package.json');
var assert			= require('assert');

exports.MCIViewFactory		= MCIViewFactory;

function MCIViewFactory(client) {
	this.client = client;
}

MCIViewFactory.prototype.getPredefinedViewLabel = function(name) {
	var label;
	switch(name) {
		case 'BN' : label = Config.bbsName; break;
		case 'VL' : label = 'ENiGMA½ v' + packageJson.version; break;
	}

	return label;
};

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
		case 'TL' : 
			if(mci.args.length > 0) {
				options.textStyle = mci.args[0];
			}

			if(mci.args.length > 1) {
				options.justify = mci.args[1];
			}

			if(mci.args.length > 2) {
				options.maxLength	= mci.args[2];
				options.dimens		= { width : options.maxLength };
			}

			view = new TextView(this.client, options);
			break;

		case 'ET' :
			if(mci.args.length > 0) {
				options.maxLength	= mci.args[0];
				options.dimens		= { width : options.maxLength };
			}

			if(mci.args.length > 1) {
				options.textStyle = mci.args[1];
			}

			view = new EditTextView(this.client, options);
			break;

		case 'PL' : 
			if(mci.args.length > 0) {
				options.text = this.getPredefinedViewLabel(mci.args[0]);
				if(options.text) {
					if(mci.args.length > 1) {
						options.textStyle = mci.args[1];
					}

					if(mci.args.length > 2) {
						options.justify = mci.args[2];
					}

					if(mci.args.length > 3) {
						options.maxLength	= mci.args[3];
						options.dimens		= { width : options.maxLength };
					}

					view = new TextView(this.client, options);
				}
			}
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

