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

	function setOption(pos, name) {
		if(mci.args.length > pos && mci.args[pos].length > 0) {
			options[name] = mci.args[pos];
			return true;
		}
		return false;
	}

	function setFocusOption(pos, name) {
		if(mci.focusArgs && mci.focusArgs.length > pos && mci.focusArgs[pos].length > 0) {
			options[name] = mci.focusArgs[pos];
		}
		return false;
	}

	switch(mci.code) {
		case 'TL' : 
			setOption(0,	'textStyle');
			setOption(1,	'justify');
			if(setOption(2,	'maxLength')) {
				options.maxLength	= parseInt(options.maxLength, 10);
				options.dimens		= { width : options.maxLength };
			}

			view = new TextView(this.client, options);
			break;

		case 'ET' :
			if(setOption(0, 'maxLength')) {
				options.maxLength	= parseInt(options.maxLength, 10);
				options.dimens		= { width : options.maxLength };
			}

			setOption(1, 'textStyle');

			setFocusOption(0, 'focusTextStyle');

			view = new EditTextView(this.client, options);
			break;

		case 'PL' : 
			if(mci.args.length > 0) {
				options.text = this.getPredefinedViewLabel(mci.args[0]);
				if(options.text) {
					setOption(1, 'textStyle');
					setOption(2, 'justify');

					if(setOption(3, 'maxLength')) {
						options.maxLength	= parseInt(options.maxLength, 10);
						options.dimens		= { width : options.maxLength };
					}

					view = new TextView(this.client, options);
				}
			}
			break;

		case 'BN' : 	
			if(mci.args.length > 0) {
				options.dimens = { width : parseInt(mci.args[0], 10) };
			}

			setOption(1, 'textStyle');
			setOption(2, 'justify');

			setFocusOption(0, 'focusTextStyle');

			view = new ButtonView(this.client, options);
			break;

		case 'VM' :
			setOption(0,		'itemSpacing');
			setOption(1, 		'justify');
			setOption(2, 		'textStyle');
			
			setFocusOption(0,	'focusTextStyle');

			view = new VerticalMenuView(this.client, options);
			break;
	}

	return view;
};
