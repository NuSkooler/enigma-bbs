/* jslint node: true */
'use strict';

var ansi		= require('../core/ansi_term.js');
var artwork		= require('../core/art.js');
var modules		= require('../core/modules.js');
var packageJson = require('../package.json');
var util		= require('util');

exports.moduleInfo = {
	name	: 'Connect',
	desc	: 'First module upon connection',
	author	: 'NuSkooler',
};

exports.entryPoint	= entryPoint;

function entryPoint(client) {	
	/*var self	= this;
	this.client = client;
	var term	= this.client.term;*/

	var term = client.term;

	term.write(ansi.normal());

	term.write(ansi.disableVT100LineWrapping());

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

