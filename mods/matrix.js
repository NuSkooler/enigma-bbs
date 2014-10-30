/* jslint node: true */
'use strict';

//var art			= require('../core/art.js');
var ansi		= require('../core/ansi_term.js');
var lineEditor	= require('../core/line_editor.js');
var art			= require('../core/art.js');
var user		= require('../core/user.js');
var theme		= require('../core/theme.js');

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
	theme.getThemeArt('MATRIX_1', client.user.properties.art_theme_name, function onArt(err, theArt) {

	//art.getArt('MATRIX_1.ANS', {}, function onArt(err, theArt) {
		if(!err) {

			art.display(theArt, { client : client,  mciReplaceChar : ' ' }, function onArtDisplayed(err, mci) {
				if(err) {
					return;					
				}

				console.log(mci);

				user.authenticate('NuSkooler', 'password', client, function onAuth(isValid) {
					console.log(isValid);
				});

				user.createNew({
					userName : 'NuSkooler',
					password : 'password',
					//properties : {
					//	pw_pbkdf2_salt : '81b45dc699c716ac1913039138b64e3057844128cf1f9291c6475d26dab3d4a5',
					//	pw_pbkdf2_dk : '14856dc5d6d277e29c5bb2ca4511695203fc48260128d2a4a611be4eefa1acfa80f8656e80d3361baa3a10ce5918829e9e3a4197b0c552978b6546d2b885d93e933a1270a5e4a81af06818d1fa9f7df830bc46f6f5870f46be818a05114f77b5605477c09e987dc4faf2a939c6869dcf2a28652d5607e5cca2e987ea2003ab4e',
					//}
				}, function onCreated(err, id) {
					if(err) {
						console.log(err);
					} else {
						console.log('new user created: ' + id);
					}
				});

				var vc = new viewController.ViewController(client);
				vc.loadFromMCIMap(mci);
				//vc.getView(3).setText('New');
				//vc.getView(4).setText('Login');
				vc.setViewOrder();
				vc.switchFocus(1);
				//vc.addView(etv);
				//vc.switchFocus(2);

				/*

				client.on('key press', function onKp(key, isSpecial) {
					key = 'string' === typeof key ? key : key.toString();
					etv.onKeyPress(key, isSpecial);
				});

				client.on('special key', function onSK(keyName) {
					etv.onSpecialKeyPress(keyName);
				});
			*/
				
				/*
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

						user.User.loadWithCredentials(un, pw, function onUser(err, user) {
							if(err) {
								console.log(err);
								return;
							}

							console.log(user.id);
						});
					}
				});
				*/
			});
		}
	});
}