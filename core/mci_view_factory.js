/* jslint node: true */
'use strict';

var TextView			= require('./text_view.js').TextView;
var EditTextView		= require('./edit_text_view.js').EditTextView;
var ButtonView			= require('./button_view.js').ButtonView;
var VerticalMenuView	= require('./vertical_menu_view.js').VerticalMenuView;
var Config				= require('./config.js').config;
var packageJson 		= require('../package.json');


var assert				= require('assert');
var os					= require('os');
var _					= require('lodash');

exports.MCIViewFactory		= MCIViewFactory;

function MCIViewFactory(client) {
	this.client = client;
}

MCIViewFactory.prototype.getPredefinedViewLabel = function(code) {
	var label;
	switch(code) {
		//	:TODO: Fix conflict with ButtonView (BN); chagne to BT
		case 'BN' : label = Config.bbsName; break;
		case 'VL' : label = 'ENiGMA½ v' + packageJson.version; break;
		case 'VN' : label = packageJson.version; break;

		case 'UN' : label = this.client.user.username; break;
		case 'UR' : label = this.client.user.properties.real_name; break;
		case 'LO' : label = this.client.user.properties.location; break;

		case 'OS' : 
			switch(os.platform()) {
				case 'linux' : label = 'Linux'; break;
				case 'darwin' : label = 'OS X'; break;
				case 'win32' : label = 'Windows'; break;
				case 'sunos' : label = 'SunOS'; break;
				default : label = os.type(); break;
			}
			break;

		case 'OA' : label = os.arch(); break;
		case 'SC' : label = os.cpus()[0].model; break;
	}

	return label;
};

MCIViewFactory.prototype.createFromMCI = function(mci) {
	assert(mci.code);
	assert(mci.id > 0);
	assert(mci.position);

	var view;
	var options = {
		client		: this.client,
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
		//	Text Label (Text View)
		case 'TL' : 
			setOption(0,	'textStyle');
			setOption(1,	'justify');
			if(setOption(2,	'maxLength')) {
				options.maxLength	= parseInt(options.maxLength, 10);
				options.dimens		= { width : options.maxLength };
			}

			view = new TextView(options);
			break;

		//	Edit Text
		case 'ET' :
			if(setOption(0, 'maxLength')) {
				options.maxLength	= parseInt(options.maxLength, 10);
				options.dimens		= { width : options.maxLength };
			}

			setOption(1, 'textStyle');

			if(options.textStyle === 'P') {
				//	Assign the proper password character / text mask
				assert(_.isObject(this.client.currentThemeInfo));
				options.textMaskChar = this.client.currentThemeInfo.getPasswordChar();
			}

			setFocusOption(0, 'focusTextStyle');

			view = new EditTextView(options);
			break;

		//	Pre-defined Label (Text View)
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

					view = new TextView(options);
				}
			}
			break;

		//	Button
		case 'BT' : 
			if(mci.args.length > 0) {
				options.dimens = { width : parseInt(mci.args[0], 10) };
			}

			setOption(1, 'textStyle');
			setOption(2, 'justify');

			setFocusOption(0, 'focusTextStyle');

			view = new ButtonView(options);
			break;

		//	Vertial Menu
		case 'VM' :
			setOption(0,		'itemSpacing');
			setOption(1, 		'justify');
			setOption(2, 		'textStyle');
			
			setFocusOption(0,	'focusTextStyle');

			view = new VerticalMenuView(options);
			break;

		default :
			options.text = this.getPredefinedViewLabel(mci.code);
			if(options.text) {
				view = new TextView(options);
			}
			break;
	}

	return view;
};
