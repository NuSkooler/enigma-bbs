/* jslint node: true */
'use strict';

var MenuModule			= require('../core/menu_module.js').MenuModule;
var DropFile			= require('../core/dropfile.js').DropFile;
var door				= require('../core/door.js');

var async				= require('async');
var assert				= require('assert');
var mkdirp 				= require('mkdirp');
var paths				= require('path');

//	:TODO: This should really be a system module... needs a little work to allow for such

exports.getModule		= AbracadabraModule;

exports.moduleInfo = {
	name	: 'Abracadabra',
	desc	: 'External BBS Door Module',
	author	: 'NuSkooler',
};

function AbracadabraModule(options) {
	MenuModule.call(this, options);

	var self = this;
	this.config	= options.menuConfig.config || {
		dropFileType	: 'DORINFO',
	};

	this.config.args = this.config.args || [];

	/*
		{
			"config" : {
				"name" : "LORD",
				"cmd" : "...",
				"args" : [ ... ],
				"dropFileType" : "dorinfo",				
				"maxNodes" : 32, default=unlimited
				"tooManyArt" : "..." (optional); default = "Too many active" message
				...
				"dropFilePath" : "/.../LORD/", || Config.paths.dropFiles
			}
		}
	*/

	this.initSequence = function() {
		async.series(
			[
				function validateNodeCount(callback) {
					//	:TODO: Check that node count for this door has not been reached
					callback(null);
				},
				function generateDropfile(callback) {					
					self.dropFile	= new DropFile(self.client, self.config.dropFileType);
					var fullPath	= self.dropFile.fullPath;

					mkdirp(paths.dirname(fullPath), function dirCreated(err) {
						if(err) {
							callback(err);
						} else {
							self.dropFile.createFile(function created(err) {
								callback(err);
							});
						}
					});
				}
			],
			function complete(err) {
				self.finishedLoading();
			}
		);
	};

	this.runDOSEmuDoor = function() {

	};
}

require('util').inherits(AbracadabraModule, MenuModule);

AbracadabraModule.prototype.enter = function(client) {
	AbracadabraModule.super_.prototype.enter.call(this, client);

};

AbracadabraModule.prototype.leave = function() {
	Abracadabra.super_.prototype.leave.call(this);

};

AbracadabraModule.prototype.finishedLoading = function() {
	var self = this;

	var exeInfo = {
		cmd		: this.config.cmd,
		args	: this.config.args,
	};

	//	:TODO: this system should probably be generic
	for(var i = 0; i < exeInfo.args.length; ++i) {
		exeInfo.args[i] = exeInfo.args[i].replace(/\{dropfile\}/g,	self.dropFile.fileName);
		exeInfo.args[i] = exeInfo.args[i].replace(/\{node\}/g,		self.client.node.toString());
	}

	var doorInstance = new door.Door(this.client, exeInfo);
	doorInstance.run();
};