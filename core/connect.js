/* jslint node: true */
'use strict';

var ansi		= require('./ansi_term.js');
var colorCodes	= require('./color_codes.js');
var theme		= require('./theme.js');
var moduleUtil	= require('./module_util.js');
//var Log			= require('./logger.js').log;
var Config		= require('./config.js').config;


var packageJson = require('../package.json');

var assert		= require('assert');
var util		= require('util');

exports.connectEntry	= connectEntry;

function ansiQueryTermSizeIfNeeded(client, cb) {
	if(client.term.termHeight > 0 || client.term.termWidth > 0) {
		cb(true);
		return;
	}

	var cprListener = function(pos) {
		//
		//	If we've already found out, disregard
		//
		if(client.term.termHeight > 0 || client.term.termWidth > 0) {
			cb(true);
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
			cb(false);
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

		cb(true);
	};

	client.once('cursor position report', cprListener);

	//	give up after 2s
	setTimeout(function onTimeout() {
		client.removeListener('cursor position report', cprListener);
		cb(false);
	}, 2000);

	client.term.write(ansi.queryScreenSize());
}

function prepareTerminal(term) {
	term.write(ansi.normal());
	term.write(ansi.disableVT100LineWrapping());
	//	:TODO: set xterm stuff -- see x84/others
}

function displayBanner(term) {
	//	:TODO: add URL(s) to banner
	term.write(colorCodes.pipeToAnsi(util.format(
		'|33Conected to |32EN|33|01i|00|32|22GMA|32|01½|00 |33BBS version|31|01 %s\n' +
		'|00|33Copyright (c) 2014-2015 Bryan Ashby\n' + 
		'|00', packageJson.version)));
}

function connectEntry(client) {
	var term = client.term;

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
		//	Always show a ENiGMA½ banner
		//
		displayBanner(term);

		setTimeout(function onTimeout() {
			client.gotoMenuModule( { name : Config.firstMenu });
		}, 500);
	});	
}

