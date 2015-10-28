/* jslint node: true */
'use strict';

var MenuModule			= require('../core/menu_module.js').MenuModule;
var DropFile			= require('../core/dropfile.js').DropFile;
var door				= require('../core/door.js');
var theme				= require('../core/theme.js');
var ansi				= require('../core/ansi_term.js');

var async				= require('async');
var assert				= require('assert');
var mkdirp 				= require('mkdirp');
var paths				= require('path');
var _					= require('lodash');

//	:TODO: This should really be a system module... needs a little work to allow for such

exports.getModule		= AbracadabraModule;

var activeDoorNodeInstances = {};

var doorInstances = {};	//	name -> { count : <instCount>, { <nodeNum> : <inst> } }

exports.moduleInfo = {
	name	: 'Abracadabra',
	desc	: 'External BBS Door Module',
	author	: 'NuSkooler',
};

/*
	Example configuration for LORD under DOSEMU:

	{
		"config" : {
			"name"			: "LORD",
			"dropFileType"	: "DOOR",
			"cmd"			: "/usr/bin/dosemu",
			"args"			: [ "-quiet", "-f", "/etc/dosemu/dosemu.conf", "X:\\PW\\START.BAT {dropfile} {node}" ] ],
			"nodeMax"		: 32,
			"tooManyArt"	: "toomany-lord.ans"
		}
	}

	:TODO: See Mystic & others for other arg options that we may need to support
*/
function AbracadabraModule(options) {
	MenuModule.call(this, options);

	var self = this;

	this.config = options.menuConfig.config;

	assert(_.isString(this.config.name, 		'Config \'name\' is required'));
	assert(_.isString(this.config.dropFileType,	'Config \'dropFileType\' is required'));
	assert(_.isString(this.config.cmd,			'Config \'cmd\' is required'));

	this.config.nodeMax		= this.config.nodeMax || 0;
	this.config.args		= this.config.args || [];

	/*
		:TODO:
		* disconnecting wile door is open leaves dosemu
		* http://bbslink.net/sysop.php support
		* Font support ala all other menus... or does this just work?
	*/

	this.initSequence = function() {
		async.series(
			[
				function validateNodeCount(callback) {
					if(self.config.nodeMax > 0 &&
						_.isNumber(activeDoorNodeInstances[self.config.name]) && 
						activeDoorNodeInstances[self.config.name] + 1 > self.config.nodeMax)
					{
						self.client.log.info( 
							{ 
								name		: self.config.name,
								activeCount : activeDoorNodeInstances[self.config.name]
							},
							'Too many active instances');

						if(_.isString(self.config.tooManyArt)) {
							theme.displayThemeArt( { client : self.client, name : self.config.tooManyArt }, function displayed() {
								theme.displayThemedPause( { client : self.client }, function keyPressed() {
									callback(new Error('Too many active instances'));
								});
							});
						} else {
							self.client.term.write('\nToo many active instances. Try again later.\n');

							theme.displayThemedPause( { client : self.client }, function keyPressed() {
								callback(new Error('Too many active instances'));
							});
						}
					} else {
						//	:TODO: JS elegant way to do this?
						if(activeDoorNodeInstances[self.config.name]) {
							activeDoorNodeInstances[self.config.name] += 1;
						} else {
							activeDoorNodeInstances[self.config.name] = 1;
						}
						
						callback(null);
					}
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
				if(err) {
					self.lastError = err;
					self.client.fallbackMenuModule();
				} else {
					self.finishedLoading();
				}
			}
		);
	};

	this.runDosEmuDoor = function() {

	};

	this.runDoor = function() {

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

		doorInstance.on('finished', function doorFinished() {
			self.client.fallbackMenuModule();
		});

		self.client.term.write(ansi.resetScreen());

		doorInstance.run();
	};
}

require('util').inherits(AbracadabraModule, MenuModule);

AbracadabraModule.prototype.enter = function(client) {
	AbracadabraModule.super_.prototype.enter.call(this, client);

};

AbracadabraModule.prototype.leave = function() {
	AbracadabraModule.super_.prototype.leave.call(this);

	if(!this.lastError) {
		activeDoorNodeInstances[this.config.name] -= 1;
	}
};

AbracadabraModule.prototype.finishedLoading = function() {
	
	this.runDoor();
};