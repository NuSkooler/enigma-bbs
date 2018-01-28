/* jslint node: true */
'use strict';

//	ENiGMA½
const MenuModule				= require('./menu_module.js').MenuModule;
const resetScreen				= require('./ansi_term.js').resetScreen;
const setSyncTermFontWithAlias	= require('./ansi_term.js').setSyncTermFontWithAlias;

//	deps
const async			= require('async');
const _				= require('lodash');
const net			= require('net');
const EventEmitter	= require('events');
const buffers		= require('buffers');

/*
	Expected configuration block:

	{
		module: telnet_bridge
		...
		config: {
			host: somehost.net
			port: 23
		}
	}
*/

//	:TODO: ENH: Support nodeMax and tooManyArt
exports.moduleInfo = {
	name	: 'Telnet Bridge',
	desc	: 'Connect to other Telnet Systems',
	author	: 'Andrew Pamment',
};

const IAC_DO_TERM_TYPE = new Buffer( [ 255, 253, 24 ] );

class TelnetClientConnection extends EventEmitter {
	constructor(client) {
		super();

		this.client		= client;
	}


	restorePipe() {
		if(!this.pipeRestored) {
			this.pipeRestored = true;

			//	client may have bailed
			if(null !== _.get(this, 'client.term.output', null)) {
				if(this.bridgeConnection) {
					this.client.term.output.unpipe(this.bridgeConnection);
				}
				this.client.term.output.resume();
			}
		}
	}

	connect(connectOpts) {
		this.bridgeConnection = net.createConnection(connectOpts, () => {
			this.emit('connected');

			this.pipeRestored = false;
			this.client.term.output.pipe(this.bridgeConnection);
		});

		this.bridgeConnection.on('data', data => {
			this.client.term.rawWrite(data);

			//
			//	Wait for a terminal type request, and send it eactly once.
			//	This is enough (in additional to other negotiations handled in telnet.js)
			//	to get us in on most systems
			//
			if(!this.termSent && data.indexOf(IAC_DO_TERM_TYPE) > -1) {
				this.termSent = true;
				this.bridgeConnection.write(this.getTermTypeNegotiationBuffer());
			}
		});

		this.bridgeConnection.once('end', () => {
			this.restorePipe();
			this.emit('end');
		});

		this.bridgeConnection.once('error', err => {
			this.restorePipe();
			this.emit('end', err);
		});
	}

	disconnect() {
		if(this.bridgeConnection) {
			this.bridgeConnection.end();
		}
	}

	getTermTypeNegotiationBuffer() {
		//
		//	Create a TERMINAL-TYPE sub negotiation buffer using the
		//	actual/current terminal type.
		//
		let bufs = buffers();

		bufs.push(new Buffer(
			[
				255,	//	IAC
				250,	//	SB
				24,		//	TERMINAL-TYPE
				0,		//	IS
			]
		));

		bufs.push(
			new Buffer(this.client.term.termType),	//	e.g. "ansi"
			new Buffer( [ 255, 240 ] )				//	IAC, SE
		);

		return bufs.toBuffer();
	}

}

exports.getModule = class TelnetBridgeModule extends MenuModule {
	constructor(options) {
		super(options);

		this.config			= Object.assign({}, _.get(options, 'menuConf.config'), options.extraArgs);
		this.config.port	= this.config.port || 23;
	}

	initSequence() {
		let clientTerminated;
		const self = this;

		async.series(
			[
				function validateConfig(callback) {
					if(_.isString(self.config.host) &&
						_.isNumber(self.config.port))
					{
						callback(null);
					} else {
						callback(new Error('Configuration is missing required option(s)'));
					}
				},
				function createTelnetBridge(callback) {
					const connectOpts = {
						port	: self.config.port,
						host	: self.config.host,
					};

					self.client.term.write(resetScreen());
					self.client.term.write(
						`  Connecting to ${connectOpts.host}, please wait...\n`
					);

					const telnetConnection = new TelnetClientConnection(self.client);

					telnetConnection.on('connected', () => {
						self.client.log.info(connectOpts, 'Telnet bridge connection established');

						if(self.config.font) {
							self.client.term.rawWrite(setSyncTermFontWithAlias(self.config.font));
						}

						self.client.once('end', () => {
							self.client.log.info('Connection ended. Terminating connection');
							clientTerminated = true;
							telnetConnection.disconnect();
						});
					});

					telnetConnection.on('end', err => {
						if(err) {
							self.client.log.info(`Telnet bridge connection error: ${err.message}`);
						}

						callback(clientTerminated ? new Error('Client connection terminated') : null);
					});

					telnetConnection.connect(connectOpts);
				}
			],
			err => {
				if(err) {
					self.client.log.warn( { error : err.message }, 'Telnet connection error');
				}

				if(!clientTerminated) {
					self.prevMenu();
				}
			}
		);
	}
};
