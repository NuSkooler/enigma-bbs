/* jslint node: true */
'use strict';

var ansi		= require('./ansi_term.js');

var assert		= require('assert');

exports.connectEntry	= connectEntry;

function ansiQueryTermSizeIfNeeded(client, cb) {
	if(client.term.termHeight > 0 || client.term.termWidth > 0) {
		cb(true);
		return;
	}

	var done = function(res) {
		client.removeListener('cursor position report', cprListener);
		clearTimeout(giveUpTimer);
		cb(res);
	};

	var cprListener = function(pos) {
		//
		//	If we've already found out, disregard
		//
		if(client.term.termHeight > 0 || client.term.termWidth > 0) {
			done(true);
			return;
		}

		assert(2 === pos.length);
		var h = pos[0];
		var w = pos[1];

		//
		//	Netrunner for example gives us 1x1 here. Not really useful. Ignore
		//	values that seem obviously bad.
		//
		if(h < 10 || w < 10) {
			client.log.warn(
				{ height : h, width : w }, 
				'Ignoring ANSI CPR screen size query response due to very small values');
			done(false);
			return;
		}

		client.term.termHeight	= h;
		client.term.termWidth	= w;

		client.log.debug(
			{ 
				termWidth	: client.term.termWidth, 
				termHeight	: client.term.termHeight, 
				source		: 'ANSI CPR' 
			}, 
			'Window size updated'
			);

		done(true);
	};

	client.once('cursor position report', cprListener);

	//	give up after 2s
	var giveUpTimer = setTimeout(function onTimeout() {
		done(false);
	}, 2000);

	//	This causes 
	client.term.rawWrite(ansi.queryScreenSize());
}

function prepareTerminal(term) {
	term.rawWrite(ansi.normal());
	//term.rawWrite(ansi.disableVT100LineWrapping());
	//	:TODO: set xterm stuff -- see x84/others
}

function displayBanner(term) {
	term.pipeWrite(
		'|06Connected to |02EN|10i|02GMA|10½ |06BBS version |12|VN\n'	+
		'|06Copyright (c) 2014-2016 Bryan Ashby |14- |12http://l33t.codes/\n'	+ 
		'|06Updates & source |14- |12https://github.com/NuSkooler/enigma-bbs/\n'			+
		'|00');
}

function connectEntry(client, nextMenu) {
	var term = client.term;

	//	:TODO: Enthral for example queries cursor position & checks if it worked. This might be good
	//	:TODO: How to detect e.g. if show/hide cursor can work? Probably can if CPR is avail

	//
	//	Some terminal clients can be detected using a nonstandard ANSI DSR
	//
	term.rawWrite(ansi.queryDeviceAttributes(0));

	//	:TODO: PuTTY will apparently respond with "PuTTY" if a CTRL-E is sent to it. Add in detection.

	//	
	//	If we don't yet know the client term width/height,
	//	try with a nonstandard ANSI DSR type request.
	//
	ansiQueryTermSizeIfNeeded(client, function ansiCprResult(result) {

		if(!result) {
			//
			//	We still don't have something good for term height/width.
			//	Default to DOS size 80x25. 
			//
			//	:TODO: Netrunner is currenting hitting this and it feels wrong. Why is NAWS/ENV/CPR all failing??? 
			client.log.warn('Failed to negotiate term size; Defaulting to 80x25!');
			
			term.termHeight	= 25;
			term.termWidth	= 80;
		}

		prepareTerminal(term);

		//
		//	Always show an ENiGMA½ banner
		//
		displayBanner(term);

		setTimeout(function onTimeout() {
			client.menuStack.goto(nextMenu);
		}, 500);
	});	
}

