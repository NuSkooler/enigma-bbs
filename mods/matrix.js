/* jslint node: true */
'use strict';

//var art			= require('../core/art.js');
var ansi		= require('../core/ansi_term.js');
var lineEditor	= require('../core/line_editor.js');
var art			= require('../core/art.js');

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

	//-------------
	/*
	client.on('position', function onPos(pos) {
		console.log(pos);
	});

	term.write('Hello, world!');
	term.write(ansi.queryPos());
	term.write(ansi.goto(5,5));
	term.write('Yehawww a bunch of text incoming.... maybe that is what breaks it... hrm... who knows.\nHave to do more testing ;(\n');
	term.write(ansi.queryPos());
	return;
	*/

	//-------------

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
			});
		}
	});
}