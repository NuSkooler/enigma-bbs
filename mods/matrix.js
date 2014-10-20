/* jslint node: true */
'use strict';

//var art			= require('../core/art.js');
var ansi		= require('../core/ansi_term.js');
var lineEditor	= require('../core/line_editor.js');
var art			= require('../core/art.js');
var user		= require('../core/user.js');

var view		= require('../core/view.js');

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
	art.getArt('MCI_TEST3.ANS', /*'MATRIX_TEST1.ANS'*/ {}, function onArt(err, theArt) {
		if(!err) {

			art.display(theArt.data, { client : client,  mciReplaceChar : ' ' }, function onArtDisplayed(err, mci) {
				if(err) {
					return;					
				}

				var vc = new view.ViewsController(client);
				vc.loadFromMCIMap(mci);
				vc.setViewOrder();
				vc.switchFocus(1);
				vc.setSubmitView(2);

				vc.on('action', function onAction(act) {
					if('submit' === act.action) {
						console.log('userName=' + vc.getView(1).value);
						console.log('password: ' + act.view.value);

						user.User.load(vc.getView(1).value, function onUser(err, user) {
							if(err) {
								console.log(err);
								return;
							}

							console.log(user.id);
						});
					}
				});
			});
		}
	});
}