/* jslint node: true */
'use strict';

const MenuModule	= require('../core/menu_module.js').MenuModule;
const resetScreen	= require('../core/ansi_term.js').resetScreen;

const async			= require('async');
const _				= require('lodash');
const net			= require('net');
const EventEmitter	= require('events');

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

//	:TODO: BUG: When a client disconnects, it's not handled very well -- the log is spammed with tons of errors
//	:TODO: ENH: Support nodeMax and tooManyArt

exports.getModule	= TelnetBridgeModule;

exports.moduleInfo = {
	name	: 'Telnet Bridge',
	desc	: 'Connect to other Telnet Systems',
	author	: 'Andrew Pamment',
};

class TelnetClientConnection extends EventEmitter {
	constructor(client) {
		super();

		this.client		= client;
	}

	restorePipe() {
		this.client.term.output.unpipe(this.bridgeConnection);
		this.client.term.output.resume();
	}

	connect(connectOpts) {
		this.bridgeConnection = net.createConnection(connectOpts, () => {
			this.emit('connected');

			this.client.term.output.pipe(this.bridgeConnection);
		});

		this.bridgeConnection.on('data', data => {
			return this.client.term.rawWrite(data);
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

}


function TelnetBridgeModule(options) {
	MenuModule.call(this, options);

	const self	= this;
	this.config = options.menuConfig.config;

	this.initSequence = function() {
		let clientTerminated;

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

					let clientTerminated;

					self.client.term.write(resetScreen());
					self.client.term.write(`  Connecting to ${connectOpts.host}, please wait...\n`);

					const telnetConnection = new TelnetClientConnection(self.client);
					
					telnetConnection.on('connected', () => {
						self.client.log.info(connectOpts, 'Telnet bridge connection established');

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

					/*

					let bridgeConnection = net.createConnection(connectOpts, () => {
						self.client.log.info(connectOpts, 'Telnet bridge connection established');

						self.client.term.output.pipe(bridgeConnection);

						self.client.once('end', () => {
							self.client.log.info('Connection ended. Terminating connection');
							clientTerminated = true;
							return bridgeConnection.end();
						});
					});

					const restorePipe = function() {
						self.client.term.output.unpipe(bridgeConnection);
						self.client.term.output.resume();
					};

					bridgeConnection.on('data', data => {
						//	pass along
						//	:TODO: just pipe this as well
						return self.client.term.rawWrite(data);
					});

					bridgeConnection.once('end', () => {
						restorePipe();
						return callback(clientTerminated ? new Error('Client connection terminated') : null);
					});

					bridgeConnection.once('error', err => {
						self.client.log.info(`Telnet bridge connection error: ${err.message}`);
						restorePipe();
						return callback(err);
					});
					*/
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
	};
}

require('util').inherits(TelnetBridgeModule, MenuModule);
