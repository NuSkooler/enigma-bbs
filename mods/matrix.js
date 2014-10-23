/* jslint node: true */
'use strict';

//var art			= require('../core/art.js');
var ansi		= require('../core/ansi_term.js');
var lineEditor	= require('../core/line_editor.js');
var art			= require('../core/art.js');
var user		= require('../core/user.js');

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
	art.getArt('MCI_TEST3.ANS', /*'MATRIX_TEST1.ANS'*/ {}, function onArt(err, theArt) {
		if(!err) {

			art.display(theArt.data, { client : client,  mciReplaceChar : ' ' }, function onArtDisplayed(err, mci) {
				if(err) {
					return;					
				}

				/*
				var tv = new textView.TextView(client, {
					position : [5, 5],
					text : 'Hello, World!',
					textStyle : 'password',
					maxLength : 10,
					id : 1,
				});

				tv.redraw();

				var etv = new editTextView.EditTextView(client, {
					position : [10, 10],
					textStyle : 'upper',
					maxLength : 20,
					dimens : { width : 30 },
					text : 'default',
					color : { flags : 0, fg : 31, bg : 40 },
					focusColor : { flags : 1, fg : 37, bg : 44 },
					id : 2,
				});

				etv.redraw();*/

				var vc = new viewController.ViewController(client);
				vc.loadFromMCIMap(mci);
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