/* jslint node: true */
'use strict';

var spawn			= require('child_process').spawn;
var events			= require('events');

var _				= require('lodash');
var pty				= require('ptyw.js');
var decode 			= require('iconv-lite').decode;

exports.Door		= Door;

function Door(client, exeInfo) {
	events.EventEmitter.call(this);

	this.client			= client;
	this.exeInfo		= exeInfo;

	this.exeInfo.encoding	= this.exeInfo.encoding || 'cp437';

	//	exeInfo.cmd
	//	exeInfo.args[]
	//	exeInfo.env{}
	//	exeInfo.cwd
	//	exeInfo.encoding

}

require('util').inherits(Door, events.EventEmitter);



Door.prototype.run = function() {

	var self = this;

	var door = pty.spawn(self.exeInfo.cmd, self.exeInfo.args, {
		cols : self.client.term.termWidth,
		rows : self.client.term.termHeight,
		//	:TODO: cwd
		env	: self.exeInfo.env,
		//encoding	: self.client.term.outputEncoding,
	});

	//	:TODO: can we pause the stream, write our own "Loading...", then on resume?

	//door.pipe(self.client.term.output);
	self.client.term.output.pipe(door);
	
	//	:TODO: do this with pluggable pipe/filter classes

	//	:TODO: This causes an error to be thrown when e.g. 'cp437' is used due to Node buffer changes
	//door.setEncoding(this.exeInfo.encoding);
	

	door.on('data', function doorData(data) {
		self.client.term.write(decode(data, self.client.term.outputEncoding));
	});

	door.on('close', function closed() {
		self.client.term.output.unpipe(door);
		self.client.term.output.resume();
	});

	door.on('exit', function exited(code) {
		self.client.log.info( { code : code }, 'Door exited');

		door.removeAllListeners();

		self.emit('finished');
	});
};