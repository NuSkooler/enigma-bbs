/* jslint node: true */
'use strict';

//	enigma-bbs
const MenuModule	= require('../core/menu_module.js').MenuModule;
const resetScreen	= require('../core/ansi_term.js').resetScreen;

//	deps
const async			= require('async');
const _				= require('lodash');
const RLogin        = require('rlogin');

exports.moduleInfo = {
	name	: 'CombatNet',
	desc	: 'CombatNet Access Module',
	author	: 'Dave Stephens',
};

exports.getModule = class CombatNetModule extends MenuModule {
	constructor(options) {
		super(options);

		//	establish defaults
		this.config				= options.menuConfig.config;
		this.config.host		= this.config.host || 'bbs.combatnet.us';
		this.config.rloginPort	= this.config.rloginPort || 4513;
	}

	initSequence() {
		const self = this;

		async.series(
			[
				function validateConfig(callback) {
					if(!_.isString(self.config.password)) {
						return callback(new Error('Config requires "password"!'));
					}
					if(!_.isString(self.config.bbsTag)) {
						return callback(new Error('Config requires "bbsTag"!'));
					}
					return callback(null);
				},
				function establishRloginConnection(callback) {
					self.client.term.write(resetScreen());
					self.client.term.write('Connecting to CombatNet, please wait...\n');

					const restorePipeToNormal = function() {
						self.client.term.output.removeListener('data', sendToRloginBuffer);
					};

					const rlogin = new RLogin(
						{	'clientUsername' : self.config.password,
							'serverUsername' : `${self.config.bbsTag}${self.client.user.username}`,
							'host' : self.config.host,
							'port' : self.config.rloginPort,
							'terminalType' : self.client.term.termClient,
							'terminalSpeed' : 57600
						}
					);

					// If there was an error ...
					rlogin.on('error', err => {
						self.client.log.info(`CombatNet rlogin client error: ${err.message}`);
						restorePipeToNormal();
						return callback(err);
					});

					// If we've been disconnected ...
					rlogin.on('disconnect', () => {
						self.client.log.info('Disconnected from CombatNet');
						restorePipeToNormal();
						return callback(null);
					});

					function sendToRloginBuffer(buffer) {
						rlogin.send(buffer);
					}

					rlogin.on('connect',
						/*	The 'connect' event handler will be supplied with one argument,
                            a boolean indicating whether or not the connection was established. */

						function(state) {
							if(state) {
								self.client.log.info('Connected to CombatNet');
								self.client.term.output.on('data', sendToRloginBuffer);

							} else {
								return callback(new Error('Failed to establish establish CombatNet connection'));
							}
						}
					);

					// If data (a Buffer) has been received from the server ...
					rlogin.on('data', (data) => {
						self.client.term.rawWrite(data);
					});

					// connect...
					rlogin.connect();

					//	note: no explicit callback() until we're finished!
				}
			],
			err => {
				if(err) {
					self.client.log.warn( { error : err.message }, 'CombatNet error');
				}

				//	if the client is still here, go to previous
				self.prevMenu();
			}
		);
	}
};
