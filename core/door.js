/* jslint node: true */
'use strict';

var spawn			= require('child_process').spawn;
var events			= require('events');

var pty				= require('pty');

exports.Door		= Door;

function Door(client, exeInfo) {
	events.EventEmitter.call(this);

	this.client			= client;
	this.exeInfo		= exeInfo;

	//	exeInfo.cmd
	//	exeInfo.args[]
	//	exeInfo.env{}
	//	exeInfo.cwd
	//	exeInfo.encoding

};

require('util').inherits(Door, events.EventEmitter);



Door.prototype.run = function() {

	var self = this;

	var doorProc = spawn(this.exeInfo.cmd, this.exeInfo.args);

/*
	doorProc.stderr.pipe(self.client.term.output);
	doorProc.stdout.pipe(self.client.term.output);
	doorProc.stdout.on('data', function stdOutData(data) {
		console.log('got data')
		self.client.term.write(data);
	});

	doorProc.stderr.on('data', function stdErrData(data) {
		console.log('got error data')
		self.client.term.write(data);
	});

	doorProc.on('close', function closed(exitCode) {
		console.log('closed')
		self.emit('closed', exitCode);	//	just fwd on
	});
*/
	var door = pty.spawn(this.exeInfo.cmd, this.exeInfo.args, {
		cols : self.client.term.termWidth,
		rows : self.client.term.termHeight,
	});

	//door.pipe(self.client.term.output);
	self.client.term.output.pipe(door);

	//	:TODO: do this with pluggable pipe/filter classes

	door.setEncoding('cp437');
	door.on('data', function doorData(data) {
		self.client.term.write(data);
		//console.log(data);
	});
//*/

	door.on('close', function closed() {
		console.log('closed...')
	});
};