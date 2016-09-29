/* jslint node: true */
'use strict';

//	enigma-bbs
const MenuModule	= require('./menu_module.js').MenuModule;
const Config		= require('./config.js').config;
const stringFormat	= require('./string_format.js');

//	deps
const async			= require('async');
const _				= require('lodash');
const pty			= require('ptyw.js');

/*
	Resources

	ZModem
		* http://gallium.inria.fr/~doligez/zmodem/zmodem.txt
		* https://github.com/protomouse/synchronet/blob/master/src/sbbs3/zmodem.c
*/

exports.moduleInfo = {
	name	: 'Transfer file',
	desc	: 'Sends or receives a file(s)',
	author	: 'NuSkooler',
};

exports.getModule = class TransferFileModule extends MenuModule {
	constructor(options) {
		super(options);

		this.config = this.menuConfig.config || {};
		this.config.protocol 	= this.config.protocol || 'zmodem8kSz';
		this.config.direction	= this.config.direction || 'send'; 

		this.protocolConfig = Config.fileTransferProtocols[this.config.protocol];

		//	:TODO: bring in extraArgs for path(s) to send when sending; Allow to hard code in config (e.g. for info pack/static downloads)
	}

	restorePipeAfterExternalProc(pipe) {
		if(!this.pipeRestored) {
			this.pipeRestored = true;
			
			this.client.term.output.unpipe(pipe);
			this.client.term.output.resume();
		}
	}

	sendFiles(cb) {
		async.eachSeries(this.sendQueue, (filePath, next) => {
			//	:TODO: built in protocols
			//	:TODO: use protocol passed in
			this.executeExternalProtocolHandler(filePath, err => {
				return next(err);
			});
		}, err => {
			return cb(err);
		});
	}

	executeExternalProtocolHandler(filePath, cb) {
		const external		= this.protocolConfig.external;
		const cmd			= external[`${this.config.direction}Cmd`];
		const args			= external[`${this.config.direction}Args`].map(arg => {
			return stringFormat(arg, {
				filePath	: filePath,
			});
		});

		/*this.client.term.rawWrite(new Buffer(
			[ 
				255, 253, 0,	//	IAC DO TRANSMIT_BINARY
				255, 251, 0,	//	IAC WILL TRANSMIT_BINARY
			]
		));*/

		const externalProc = pty.spawn(cmd, args, {
			cols : this.client.term.termWidth,
			rows : this.client.term.termHeight,
			//	:TODO: cwd
			//	:TODO: anything else??
			//env	: self.exeInfo.env,
		});

		this.client.term.output.pipe(externalProc);

		/*this.client.term.output.on('data', data => {
		//	let tmp = data.toString('binary').replace(/\xff\xff/g, '\xff');
		//	proc.write(new Buffer(tmp, 'binary'));
			proc.write(data);
		});
		*/
		externalProc.on('data', data => {
			//	needed for things like sz/rz
			if(external.escapeTelnet) {
				const tmp = data.toString('binary').replace(/\xff/g, '\xff\xff');
				this.client.term.rawWrite(new Buffer(tmp, 'binary'));
			} else {
				this.client.term.rawWrite(data);
			}
		});

		externalProc.once('close', () => {
			return this.restorePipeAfterExternalProc(externalProc);
		});

		externalProc.once('exit', exitCode => {
			this.restorePipeAfterExternalProc(externalProc);
			externalProc.removeAllListeners();

			return cb(null);
		});	
	}

	initSequence() {
		const self = this;

		async.series(
			[
				function validateConfig(callback) {
					//	:TODO:
					return callback(null);
				},
				function transferFiles(callback) {
					self.sendQueue = [ '/home/nuskooler/Downloads/fdoor100.zip' ];	//	:TODO: testing of course
					return self.sendFiles(callback);
				}
			]
		);
	}
};
