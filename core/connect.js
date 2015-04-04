/* jslint node: true */
'use strict';

var ansi		= require('./ansi_term.js');
var artwork		= require('./art.js');
var moduleUtil	= require('./module_util.js');
var Log			= require('./logger.js').log;
var Config		= require('./config.js').config;
var packageJson = require('../package.json');

var assert		= require('assert');
var util		= require('util');

exports.connectEntry	= connectEntry;

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

		assert(2 === pos.length);
		client.term.termHeight	= pos[0];
		client.term.termWidth	= pos[1];

		Log.debug(
			{ termWidth : client.term.termWidth, termHeight : client.term.termHeight, updateSource : 'ANSI CPR' }, 
			'Window size updated');
	};

	client.once('cursor position report', onCPR);

	//	give up after 2s
	setTimeout(function onTimeout() {
		client.removeListener('cursor position report', onCPR);
	}, 2000);

	client.term.write(ansi.queryScreenSize());
}

function prepareTerminal(term) {
	term.write(ansi.normal());
	term.write(ansi.disableVT100LineWrapping());
	//	:TODO: set xterm stuff -- see x84/others
}

function displayBanner(term) {
	//	:TODO: add URL to banner
	term.write(ansi.fromPipeCode(util.format('' + 
		'|33Conected to |32EN|33|01i|32|22GMA|32|01½|00 |33BBS version|31|01 %s\n' +
		'|00|33Copyright (c) 2014 Bryan Ashby\n' + 
		'|00', packageJson.version)));
}

function connectEntry(client) {
	var term = client.term;

	//	
	//	If we don't yet know the client term width/height,
	//	try with a nonstandard ANSI DSR type request.
	//
	ansiQueryTermSizeIfNeeded(client);

	prepareTerminal(term);
	displayBanner(term);

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
				
				client.gotoMenuModule({ name : Config.entryMod } );
				//moduleUtil.goto(Config.entryMod, client);
			}, timeout);
		});
	}, 500);
}

