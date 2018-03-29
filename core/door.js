/* jslint node: true */
'use strict';

const stringFormat	= require('./string_format.js');
const { Errors }	= require('./enig_error.js');

const pty			= require('node-pty');
const decode 		= require('iconv-lite').decode;
const createServer	= require('net').createServer;

module.exports = class Door {
	constructor(client) {
		this.client		= client;
		this.restored	= false;
	}

	prepare(ioType, cb) {
		this.io = ioType;

		//	we currently only have to do any real setup for 'socket'
		if('socket' !== ioType) {
			return cb(null);
		}

		this.sockServer = createServer(conn => {
			this.sockServer.getConnections( (err, count) => {

				//	We expect only one connection from our DOOR/emulator/etc.
				if(!this && count <= 1) {
					this.client.term.output.pipe(conn);

					conn.on('data', this.doorDataHandler.bind(this));

					conn.once('end', () => {
						return this.restoreIo(conn);
					});

					conn.once('error', err => {
						this.client.log.info( { error : err.message }, 'Door socket server connection');
						return this.restoreIo(conn);
					});
				}
			});
		});

		this.sockServer.listen(0, () => {
			return cb(null);
		});
	}

	run(exeInfo, cb) {
		this.encoding = (exeInfo.encoding || 'cp437').toLowerCase();

		if('socket' === this.io && !this.sockServer) {
			return cb(Errors.UnexpectedState('Socket server is not running'));
		}

		const formatObj = {
			dropFile		: exeInfo.dropFile,
			dropFilePath	: exeInfo.dropFilePath,
			node			: exeInfo.node.toString(),
			srvPort			: this.sockServer ? this.sockServer.address().port.toString() : '-1',
			userId			: this.client.user.userId.toString(),
			srvSocketFd		: exeInfo.srvSocketFd ? exeInfo.srvSocketFd.toString() : '-1',
		};

		const args = exeInfo.args.map( arg => stringFormat(arg, formatObj) );

		const door = pty.spawn(exeInfo.cmd, args, {
			cols 		: this.client.term.termWidth,
			rows		: this.client.term.termHeight,
			//	:TODO: cwd
			env			: exeInfo.env,
			encoding	: null,	//	we want to handle all encoding ourself
		});

		if('stdio' === this.io) {
			this.client.log.debug('Using stdio for door I/O');

			this.client.term.output.pipe(door);

			door.on('data', this.doorDataHandler.bind(this));

			door.once('close', () => {
				return this.restoreIo(door);
			});
		} else if('socket' === this.io) {
			this.client.log.debug(
				{ srvPort : this.sockServer.address().port, srvSocketFd : this.sockServerSocket },
				'Using temporary socket server for door I/O'
			);
		}

		door.once('exit', exitCode => {
			this.client.log.info( { exitCode : exitCode }, 'Door exited');

			if(this.sockServer) {
				this.sockServer.close();
			}

			//	we may not get a close
			if('stdio' === this.io) {
				this.restoreIo(door);
			}

			door.removeAllListeners();

			return cb(null);
		});
	}

	doorDataHandler(data) {
		this.client.term.write(decode(data, this.encoding));
	}

	restoreIo(piped) {
		if(!this.restored && this.client.term.output) {
			this.client.term.output.unpipe(piped);
			this.client.term.output.resume();
			this.restored = true;
		}
	}
};

/*
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
*/