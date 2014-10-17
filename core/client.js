/* jslint node: true */
'use strict';

var stream		= require('stream');
var term		= require('./client_term.js');
var assert		= require('assert');
var miscUtil	= require('./misc_util.js');
var ansi		= require('./ansi_term.js');
var logger		= require('./logger.js');

exports.Client	= Client;

function Client(input, output) {
	stream.call(this);

	var self	= this;

	this.input			= input;
	this.output			= output;
	this.term			= new term.ClientTerminal(this.output);

	self.on('data', function onData(data) {
		console.log('data: ' + data.length);
		handleANSIControlResponse(data);
	});

	function handleANSIControlResponse(data) {
		console.log(data);
		ansi.forEachControlCode(data, function onControlResponse(name, params) {
			var eventName = 'on' + name[0].toUpperCase() + name.substr(1);
			console.log(eventName + ': ' + params);
			self.emit(eventName, params);
		});
	}
}

require('util').inherits(Client, stream);

Client.prototype.end = function () {
	return this.output.end.apply(this.output, arguments);
};

Client.prototype.destroy = function () {
	return this.output.destroy.apply(this.output, arguments);
};

Client.prototype.destroySoon = function () {
	return this.output.destroySoon.apply(this.output, arguments);
};

Client.prototype.getch = function(cb) {
	this.input.once('data', function onData(data) {
		//	:TODO: needs work. What about F keys and the like?
		assert(data.length === 1);
		cb(data);
	});
};

Client.prototype.address = function() {
	return this.input.address();
};

///////////////////////////////////////////////////////////////////////////////
//	Default error handlers
///////////////////////////////////////////////////////////////////////////////

Client.prototype.defaultHandlerMissingMod = function(err) {
	var self = this;

	function handler(err) {
		logger.log.error(err);

		self.term.write('An unrecoverable error has been encountered!\n');
		self.term.write('This has been logged for your SysOp to review.\n');
		self.term.write('\nGoodbye!\n');

		
		//self.term.write(err);

		//if(miscUtil.isDevelopment() && err.stack) {
		//	self.term.write('\n' + err.stack + '\n');
		//}		

		self.end();
	}

	return handler;
};

