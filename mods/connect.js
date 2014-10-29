/* jslint node: true */
'use strict';

var ansi		= require('../core/ansi_term.js');
var artwork		= require('../core/art.js');
var modules		= require('../core/modules.js');
var Log			= require('../core/logger.js').log;
var packageJson = require('../package.json');

var util		= require('util');

exports.moduleInfo = {
	name	: 'Connect',
	desc	: 'First module upon connection',
	author	: 'NuSkooler',
};

exports.entryPoint	= entryPoint;

function ansiQueryTermSizeIfNeeded(client) {
	if(client.term.termHeight > 0 || client.term.termWidth > 0) {
		return;
	}

	var onCPR = function(pos) {
		//
		//	If we've already found out, disregard
		//
		if(client.term.termHeight > 0 || client.term.termWidth > 0) {
			return;
		}

		client.term.termHeight	= pos[0];
		client.term.termWidth	= pos[1];

		Log.debug({ termWidth : client.term.termWidth, termHeight : client.term.termHeight, updateSource : 'ANSI CPR' }, 'Window size updated');
	};

	client.once('cursor position report', onCPR);

	//	give up after 2s
	setTimeout(function onTimeout() {
		client.removeListener('cursor position report', onCPR);
	}, 2000);

	client.term.write(ansi.queryScreenSize());
}

function entryPoint(client) {
	var term = client.term;

	//	
	//	If we don't yet know the client term width/height,
	//	try with a nonstandard ANSI DSR type request.
	//
	ansiQueryTermSizeIfNeeded(client);

	term.write(ansi.normal());

	term.write(ansi.disableVT100LineWrapping());



	//
	//	If we don't yet know the client term width/height, try
	//	a nonstandard ANSI query
	//

	//	:TODO: set xterm stuff -- see x84/others

	//	:TODO: add URL to banner
	term.write(ansi.fromPipeCode(util.format('' + 
		'|33Conected to |32EN|33|01i|32|22GMA|32|01½|00 |33BBS version|31|01 %s\n' +
		'|00|33Copyright (c) 2014 Bryan Ashby\n' + 
		'|00', packageJson.version)));

	setTimeout(function onTimeout() {
		term.write(ansi.clearScreen());

		artwork.getArt('CONNECT', { random : true, readSauce : true }, function onArt(err, art) {
			var timeout = 0;
			
			if(!err) {
				term.write(art.data);
				timeout = 1000;
			}

			setTimeout(function onTimeout() {
				term.write(ansi.clearScreen());
				modules.goto('matrix', client);
			}, timeout);
		});
	}, 500);
}

