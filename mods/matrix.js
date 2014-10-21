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
						var un = vc.getView(1).value;
						var pw = vc.getView(2).value;
						console.log('userName: ' + un);
						console.log('password: ' + pw);

						/*
						var user1 = new user.User();
						user.User.generatePasswordDerivedKey('password', function onDk(err, dkInfo) {
							user1.userName = 'NuSkooler';
							user1.properties = {
								pw_pbkdf2_salt : dkInfo.salt,
								pw_pbkdf2_dk : dkInfo.dk,	
							};
							user.User.addNew(user1, function onNewUser(err, id) {
								if(err) {
									console.log(err);
								} else {
									console.log('new user id: ' + id);
								}
							});
						});*/
						


						user.User.loadWithCredentials(un, pw, function onUser(err, user) {
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