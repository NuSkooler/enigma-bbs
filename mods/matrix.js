/* jslint node: true */
'use strict';

var ansi		= require('../core/ansi_term.js');
var art			= require('../core/art.js');
var user		= require('../core/user.js');
var theme		= require('../core/theme.js');
var modules		= require('../core/modules.js');

//var view		= require('../core/view.js');
var textView	= require('../core/text_view.js');
var editTextView	= require('../core/edit_text_view.js');
var ViewController	= require('../core/view_controller.js').ViewController;

var async		= require('async');

exports.moduleInfo = {
	name	: 'Matrix',
	desc	: 'Standardish Matrix',
	author	: 'NuSkooler',
};

exports.entryPoint	= entryPoint;

function entryPoint(client) {

	theme.displayThemeArt('MATRIX', client, function onMatrix(err, mciMap) {
		if(mciMap.ET1 && mciMap.ET2 && mciMap.BN1 && mciMap.BN2 && mciMap.BN3) {
			//
			//	Form via EditTextViews and ButtonViews
			//	* ET1 - userName
			//	* ET2 - password
			//	* BN1 - Login
			//	* BN2 - New
			//	* BN3 - Bye!
			//
		} else if(mciMap.VM1) {
			//
			//	Menu via VerticalMenuView
			//
			//	* VM1 - menu with the following items:
			//		0 - Login
			//		1 - New
			//		2 - Bye!
			//
			var vc = new ViewController(client);

			vc.on('submit', function onSubmit(form) {

			});

			vc.loadFromMCIMap(mciMap);
			vc.setViewOrder();
			//	:TODO: Localize
			vc.getView(1).setItems(['Login', 'New User', 'Goodbye!']);
			vc.switchFocus(1);
		}
	});
}

/*
function entryPoint(client) {
	var term = client.term;

	term.write(ansi.resetScreen());	
	
	//	:TODO: types, random, and others? could come from conf.mods.matrix or such

	theme.getThemeArt('MCI_ET1.ANS', client.user.properties.art_theme_id, function onArt(err, theArt) {

	//art.getArt('MATRIX_1.ANS', {}, function onArt(err, theArt) {
		if(!err) {

			art.display(theArt, { client : client,  mciReplaceChar : ' ' }, function onArtDisplayed(err, mci) {
				if(err) {
					return;					
				}

				user.authenticate('NuSkooler', 'password', client, function onAuth(isValid) {
					console.log(isValid);
				});

				var vc = new viewController.ViewController(client);
				vc.on('submit', function onSubmit(formData) {
					console.log(formData);

					vc.detachClientEvents();
					modules.goto('test_module1', client);
				});

				vc.loadFromMCIMap(mci);
				//vc.getView(3).setText('New');
				//vc.getView(4).setText('Login');
				vc.setViewOrder();
				vc.getView(2).submit = true;
				//vc.getView(1).setItems(['System Login', 'Apply', 'GTFO!']);
				//vc.getView(2).submit = true;
				//vc.getView(3).setText('Apply');
				vc.switchFocus(1);
			});
		}
	});
}
*/