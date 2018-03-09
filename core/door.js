/* jslint node: true */
'use strict';


const stringFormat	= require('./string_format.js');

const events		= require('events');
const _				= require('lodash');
const pty			= require('node-pty');
const decode 		= require('iconv-lite').decode;
const createServer	= require('net').createServer;

exports.Door		= Door;

function Door(client, exeInfo) {
	events.EventEmitter.call(this);

	const self 				= this;
	this.client				= client;
	this.exeInfo			= exeInfo;
	this.exeInfo.encoding	= (this.exeInfo.encoding || 'cp437').toLowerCase();
	let restored			= false;

	//
	//	Members of exeInfo:
	//	cmd
	//	args[]
	//	env{}
	//	cwd
	//	io
	//	encoding
	//	dropFile
	//	node
	//	inhSocket
	//

	this.doorDataHandler = function(data) {
		self.client.term.write(decode(data, self.exeInfo.encoding));
	};

	this.restoreIo = function(piped) {
		if(!restored && self.client.term.output) {
			self.client.term.output.unpipe(piped);
			self.client.term.output.resume();
			restored = true;
		}
	};

	this.prepareSocketIoServer = function(cb) {
		if('socket' === self.exeInfo.io) {
			const sockServer =  createServer(conn => {

				sockServer.getConnections( (err, count) => {

					//	We expect only one connection from our DOOR/emulator/etc.
					if(!err && count <= 1) {
						self.client.term.output.pipe(conn);

						conn.on('data', self.doorDataHandler);

						conn.once('end', () => {
							return self.restoreIo(conn);
						});

						conn.once('error', err => {
							self.client.log.info( { error : err.toString() }, 'Door socket server connection');
							return self.restoreIo(conn);
						});
					}
				});
			});

			sockServer.listen(0, () => {
				return cb(null, sockServer);
			});
		} else {
			return cb(null);
		}
	};

	this.doorExited = function() {
		self.emit('finished');
	};
}

require('util').inherits(Door, events.EventEmitter);

Door.prototype.run = function() {
	const self = this;

	this.prepareSocketIoServer( (err, sockServer) => {
		if(err) {
			this.client.log.warn( { error : err.toString() }, 'Failed executing door');
			return self.doorExited();
		}

		//	Expand arg strings, e.g. {dropFile} -> DOOR32.SYS
		//	:TODO: Use .map() here
		let args = _.clone(self.exeInfo.args);	//	we need a copy so the original is not modified

		for(let i = 0; i < args.length; ++i) {
			args[i] = stringFormat(self.exeInfo.args[i], {
				dropFile		: self.exeInfo.dropFile,
				node			: self.exeInfo.node.toString(),
				srvPort			: sockServer ? sockServer.address().port.toString() : '-1',
				userId			: self.client.user.userId.toString(),
			});
		}

		const door = pty.spawn(self.exeInfo.cmd, args, {
			cols 		: self.client.term.termWidth,
			rows		: self.client.term.termHeight,
			//	:TODO: cwd
			env			: self.exeInfo.env,
			encoding	: null,	//	we want to handle all encoding ourself
		});

		if('stdio' === self.exeInfo.io) {
			self.client.log.debug('Using stdio for door I/O');

			self.client.term.output.pipe(door);

			door.on('data', self.doorDataHandler);

			door.once('close', () => {
				return self.restoreIo(door);
			});
		} else if('socket' === self.exeInfo.io) {
			self.client.log.debug( { port : sockServer.address().port }, 'Using temporary socket server for door I/O');
		}

		door.once('exit', exitCode => {
			self.client.log.info( { exitCode : exitCode }, 'Door exited');

			if(sockServer) {
				sockServer.close();
			}

			//	we may not get a close
			if('stdio' === self.exeInfo.io) {
				self.restoreIo(door);
			}

			door.removeAllListeners();

			return self.doorExited();
		});
	});
};
