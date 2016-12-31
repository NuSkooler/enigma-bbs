/* jslint node: true */
'use strict';

//	enigma-bbs
const MenuModule	= require('../core/menu_module.js').MenuModule;
const resetScreen	= require('../core/ansi_term.js').resetScreen;

//	deps
const async			= require('async');
const _				= require('lodash');
const SSHClient		= require('ssh2').Client;

exports.getModule	= DoorPartyModule;

exports.moduleInfo = {
	name	: 'DoorParty',
	desc	: 'DoorParty Access Module',
	author	: 'NuSkooler',
};


function DoorPartyModule(options) {
	MenuModule.call(this, options);
	
	const self	= this;
	
	//	establish defaults
	this.config	= options.menuConfig.config;
	this.config.host		= this.config.host || 'dp.throwbackbbs.com';
	this.config.sshPort 	= this.config.sshPort || 2022;
	this.config.rloginPort	= this.config.rloginPort || 513;	
	
	this.initSequence = function() {
		let clientTerminated;
		
		async.series(
			[
				function validateConfig(callback) {
					if(!_.isString(self.config.username)) {
						return callback(new Error('Config requires "username"!'));
					}
					if(!_.isString(self.config.password)) {
						return callback(new Error('Config requires "password"!'));
					}
					if(!_.isString(self.config.bbsTag)) {
						return callback(new Error('Config requires "bbsTag"!'));
					}
					return callback(null);
				},
				function establishSecureConnection(callback) {
					self.client.term.write(resetScreen());
					self.client.term.write('Connecting to DoorParty, please wait...\n');
									
					const sshClient = new SSHClient();
					
					let pipeRestored = false;
					let pipedStream;
					const restorePipe = function() {
						if(pipedStream && !pipeRestored && !clientTerminated) {
							self.client.term.output.unpipe(pipedStream);						
							self.client.term.output.resume();
						}	
					};										
					
					sshClient.on('ready', () => {
						//	track client termination so we can clean up early
						self.client.once('end', () => {
							self.client.log.info('Connection ended. Terminating DoorParty connection');
							clientTerminated = true;
							sshClient.end();							
						});
						
						//	establish tunnel for rlogin
						sshClient.forwardOut('127.0.0.1', self.config.sshPort, self.config.host, self.config.rloginPort, (err, stream) => {
							if(err) {
								return callback(new Error('Failed to establish tunnel'));
							}

							//
							//	Send rlogin
							//	DoorParty wants the "server username" portion to be in the format of [BBS_TAG]USERNAME, e.g.
							//	[XA]nuskooler
							//
							const rlogin = `\x00${self.client.user.username}\x00[${self.config.bbsTag}]${self.client.user.username}\x00${self.client.term.termType}\x00`; 
							stream.write(rlogin);
							
							pipedStream = stream;	//	:TODO: this is hacky...
							self.client.term.output.pipe(stream);
							
							stream.on('data', d => {
								//	:TODO: we should just pipe this...
								self.client.term.rawWrite(d);
							});
							
							stream.on('close', () => {
								restorePipe();
								sshClient.end();
							});
						});
					});
					
					sshClient.on('close', () => {
						restorePipe();
						callback(null);
					});
										
					sshClient.connect( {
						host 		: self.config.host,
						port		: self.config.sshPort,
						username	: self.config.username,
						password	: self.config.password,
					});
					
					//	note: no explicit callback() until we're finished!
				}		
			],
			err => {
				if(err) {
					self.client.log.warn( { error : err.message }, 'DoorParty error');
				}
				
				//	if the client is stil here, go to previous
				if(!clientTerminated) {
					self.prevMenu();
				}
			}
		);
	};
	
}

require('util').inherits(DoorPartyModule, MenuModule);