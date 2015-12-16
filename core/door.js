/* jslint node: true */
'use strict';

var spawn			= require('child_process').spawn;
var events			= require('events');

var _				= require('lodash');
var pty				= require('ptyw.js');
var decode 			= require('iconv-lite').decode;
var net				= require('net');
var async			= require('async');

exports.Door		= Door;

function Door(client, exeInfo) {
	events.EventEmitter.call(this);

	this.client			= client;
	this.exeInfo		= exeInfo;

	this.exeInfo.encoding	= this.exeInfo.encoding || 'cp437';

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
}

require('util').inherits(Door, events.EventEmitter);



Door.prototype.run = function() {

	var self = this;

	var doorData = function(data) {
		//	:TODO: skip decoding if we have a match, e.g. cp437 === cp437
		self.client.term.write(decode(data, self.exeInfo.encoding));
	};

	var restore = function(piped) {
		if(self.client.term.output) {
			self.client.term.output.unpipe(piped);
			self.client.term.output.resume();
		}
	};

	var sockServer;

	async.series(
		[
			function prepareServer(callback) {
				if('socket' === self.exeInfo.io) {
					sockServer =  net.createServer(function connected(conn) {

						sockServer.getConnections(function connCount(err, count) {

							//	We expect only one connection from our DOOR/emulator/etc.
							if(!err && count <= 1) {
								self.client.term.output.pipe(conn);
								
								conn.on('data', doorData);

								conn.on('end', function ended() {
									restore(conn);									
								});

								conn.on('error', function error(err) {
									self.client.log.info('Door socket server connection error: ' + err.message);
									restore(conn);
								});
							}
						});
					});

					sockServer.listen(0, function listening() {
						callback(null);
					});
				} else {
					callback(null);
				}
			},
			function launch(callback) {
				//	Expand arg strings, e.g. {dropFile} -> DOOR32.SYS
				var args = _.clone(self.exeInfo.args);	//	we need a copy so the original is not modified

				for(var i = 0; i < args.length; ++i) {
					args[i] = self.exeInfo.args[i].format({
						dropFile		: self.exeInfo.dropFile,
						node			: self.exeInfo.node.toString(),
						//inhSocket		: self.exeInfo.inhSocket.toString(),
						srvPort			: sockServer ? sockServer.address().port.toString() : '-1',
						userId			: self.client.user.userId.toString(),
					});
				}

				var door = pty.spawn(self.exeInfo.cmd, args, {
					cols : self.client.term.termWidth,
					rows : self.client.term.termHeight,
					//	:TODO: cwd
					env	: self.exeInfo.env,
				});				

				if('stdio' === self.exeInfo.io) {
					self.client.log.debug('Using stdio for door I/O');

					self.client.term.output.pipe(door);

					door.on('data', doorData);

					door.on('close', function closed() {
						restore(door);
					});
				} else if('socket' === self.exeInfo.io) {
					self.client.log.debug(
						{ port : sockServer.address().port }, 
						'Using temporary socket server for door I/O');
				}

				door.on('exit', function exited(code) {
					self.client.log.info( { code : code }, 'Door exited');

					if(sockServer) {
						sockServer.close();
					}

					door.removeAllListeners();

					self.emit('finished');
				});
			}
		],
		function complete(err) {
			if(err) {
				self.client.log.warn( { error : err.toString() }, 'Failed executing door');
			}
		}
	);
};