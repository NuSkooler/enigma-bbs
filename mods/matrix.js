/* jslint node: true */
'use strict';

//var art			= require('../core/art.js');
var ansi		= require('../core/ansi_term.js');
var lineEditor	= require('../core/line_editor.js');
var art			= require('../core/art.js');

exports.moduleInfo = {
	name	: 'Matrix',
	desc	: 'Standardish Matrix',
	author	: 'NuSkooler',
};

exports.entryPoint	= entryPoint;

function entryPoint(client) {
	var term = client.term;

	term.write(ansi.clearScreenGoHome());	

	//	:TODO: types, random, and others? could come from conf.mods.matrix or such

	//art.getArt('SO-CC1.ANS'/* 'MATRIX'*/, { types: ['.ans'], random: true}, function onArt(err, theArt) {
	art.getArt('DM-ENIG2-MATRIX.ANS', {}, function onArt(err, theArt) {
		if(!err) {
			art.display(theArt.data, { client : client,  mciReplaceChar : ' ' }, function onArtDisplayed(err, mci) {
				if(err) {
					return;
				}

				console.log(mci);
			});
		}
	});
}