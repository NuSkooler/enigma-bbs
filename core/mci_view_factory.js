/* jslint node: true */
'use strict';

var TextView			= require('./text_view.js').TextView;
var EditTextView		= require('./edit_text_view.js').EditTextView;
var ButtonView			= require('./button_view.js').ButtonView;
var VerticalMenuView	= require('./vertical_menu_view.js').VerticalMenuView;
var Config				= require('./config.js').config;
var packageJson 		= require('../package.json');
var assert				= require('assert');

exports.MCIViewFactory		= MCIViewFactory;

function MCIViewFactory(client) {
	this.client = client;
}

MCIViewFactory.prototype.getPredefinedViewLabel = function(name) {
	var label;
	switch(name) {
		case 'BN' : label = Config.bbsName; break;
		case 'VL' : label = 'ENiGMA½ v' + packageJson.version; break;
		case 'VN' : label = packageJson.version; break;
	}

	return label;
};

//	:TODO: probably do something like this and generalize all of this:
/*
var MCI_ARG_MAP = {
	'ET' : { 0 : 'maxLength', 1 : 'textStyle' }
};
*/

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

	//	:TODO: move this stuff out of the switch to their own methods/objects
	function setOption(pos, name) {
		if(mci.args.length > pos && mci.args[pos].length > 0) {
			options[name] = mci.args[pos];
			return true;
		}
		return false;
	}

	switch(mci.code) {
		case 'TL' : 
			//	:TODO: convert to setOption()
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
			if(setOption(0, 'maxLength')) {
				options.dimens = { width : options.maxLength };
			}

			setOption(1, 'textStyle');

			view = new EditTextView(this.client, options);
			break;

		case 'PL' : 
		//	:TODO: convert to setOption()
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
		//	:TODO: convert to setOption()
			if(mci.args.length > 0) {
				options.text 	= mci.args[0];
				options.dimens	= { width : options.text.length };
			}

			view = new ButtonView(this.client, options);
			break;

		case 'VM' :
			setOption(0, 'itemSpacing');
			setOption(1, 'justify');
			setOption(2, 'textStyle');

			view = new VerticalMenuView(this.client, options);
			break;
	}

	return view;
};

