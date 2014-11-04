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
var viewController	= require('../core/view_controller.js');

exports.moduleInfo = {
	name	: 'Matrix',
	desc	: 'Standardish Matrix',
	author	: 'NuSkooler',
};

exports.entryPoint	= entryPoint;

function entryPoint(client) {
	var term = client.term;

	term.write(ansi.resetScreen());	
	
	//	:TODO: types, random, and others? could come from conf.mods.matrix or such

	//art.getArt('SO-CC1.ANS'/* 'MATRIX'*/, { types: ['.ans'], random: true}, function onArt(err, theArt) {
	//client.user.properties.art_theme_id = '';
	theme.getThemeArt('MATRIX_1.ANS', client.user.properties.art_theme_id, function onArt(err, theArt) {

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