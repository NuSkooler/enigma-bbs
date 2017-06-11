/* jslint node: true */
'use strict';

//	ENiGMA½
const ansi		= require('./ansi_term.js');
const events    = require('./events.js');

//	deps
const async		= require('async');

exports.connectEntry	= connectEntry;

function ansiDiscoverHomePosition(client, cb) {
	//
	//	We want to find the home position. ANSI-BBS and most terminals
	//	utilize 1,1 as home. However, some terminals such as ConnectBot
	//	think of home as 0,0. If this is the case, we need to offset
	//	our positioning to accomodate for such.
	//
	const done = function(err) {
		client.removeListener('cursor position report', cprListener);
		clearTimeout(giveUpTimer);
		return cb(err);
	};

	const cprListener = function(pos) {
		const h = pos[0];
		const w = pos[1];

		//
		//	We expect either 0,0, or 1,1. Anything else will be filed as bad data
		//
		if(h > 1 || w > 1) {
			client.log.warn( { height : h, width : w }, 'Ignoring ANSI home position CPR due to unexpected values');
			return done(new Error('Home position CPR expected to be 0,0, or 1,1'));
		}

		if(0 === h & 0 === w) {
			//
			//	Store a CPR offset in the client. All CPR's from this point on will offset by this amount
			//
			client.log.info('Setting CPR offset to 1');
			client.cprOffset = 1;
		}

		return done(null);
	};

	client.once('cursor position report', cprListener);

	const giveUpTimer = setTimeout( () => {
		return done(new Error('Giving up on home position CPR'));
	}, 3000);	//	3s

	client.term.write(`${ansi.goHome()}${ansi.queryPos()}`);	//	go home, query pos
}

function ansiQueryTermSizeIfNeeded(client, cb) {
	if(client.term.termHeight > 0 || client.term.termWidth > 0) {
		return cb(null);
	}

	const done = function(err) {
		client.removeListener('cursor position report', cprListener);
		clearTimeout(giveUpTimer);
		return cb(err);
	};

	const cprListener = function(pos) {
		//
		//	If we've already found out, disregard
		//
		if(client.term.termHeight > 0 || client.term.termWidth > 0) {
			return done(null);
		}

		const h = pos[0];
		const w = pos[1];

		//
		//	Netrunner for example gives us 1x1 here. Not really useful. Ignore
		//	values that seem obviously bad.
		//
		if(h < 10 || w < 10) {
			client.log.warn(
				{ height : h, width : w },
				'Ignoring ANSI CPR screen size query response due to very small values');
			return done(new Error('Term size <= 10 considered invalid'));
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

		return done(null);
	};

	client.once('cursor position report', cprListener);

	//	give up after 2s
	const giveUpTimer = setTimeout( () => {
		return done(new Error('No term size established by CPR within timeout'));
	}, 2000);

	//	Start the process: Query for CPR
	client.term.rawWrite(ansi.queryScreenSize());
}

function prepareTerminal(term) {
	term.rawWrite(ansi.normal());
	//term.rawWrite(ansi.disableVT100LineWrapping());
	//	:TODO: set xterm stuff -- see x84/others
}

function displayBanner(term) {
	//	note: intentional formatting:
	term.pipeWrite(`
|06Connected to |02EN|10i|02GMA|10½ |06BBS version |12|VN
|06Copyright (c) 2014-2017 Bryan Ashby |14- |12http://l33t.codes/
|06Updates & source |14- |12https://github.com/NuSkooler/enigma-bbs/
|00`
	);
}

function connectEntry(client, nextMenu) {
	const term = client.term;

	async.series(
		[
			function basicPrepWork(callback) {
				term.rawWrite(ansi.queryDeviceAttributes(0));
				return callback(null);
			},
			function discoverHomePosition(callback) {
				ansiDiscoverHomePosition(client, () => {
					//	:TODO: If CPR for home fully fails, we should bail out on the connection with an error, e.g. ANSI support required
					return callback(null);	//	we try to continue anyway
				});
			},
			function queryTermSizeByNonStandardAnsi(callback) {
				ansiQueryTermSizeIfNeeded(client, err => {
					if(err) {
						//
						//	Check again; We may have got via NAWS/similar before CPR completed.
						//
						if(0 === term.termHeight || 0 === term.termWidth) {
							//
							//	We still don't have something good for term height/width.
							//	Default to DOS size 80x25.
							//
							//	:TODO: Netrunner is currenting hitting this and it feels wrong. Why is NAWS/ENV/CPR all failing???
							client.log.warn( { reason : err.message }, 'Failed to negotiate term size; Defaulting to 80x25!');

							term.termHeight	= 25;
							term.termWidth	= 80;
						}
					}

					return callback(null);
				});
			},
		],
		() => {
			prepareTerminal(term);

			//
			//	Always show an ENiGMA½ banner
			//
			displayBanner(term);

            // fire event
            events.emit('codes.l33t.enigma.system.connect', {'client': client});

			setTimeout( () => {
				return client.menuStack.goto(nextMenu);
			}, 500);
		}
	);
}
