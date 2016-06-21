/* jslint node: true */
'use strict';

let MenuModule			= require('../core/menu_module.js').MenuModule;
let DropFile			= require('../core/dropfile.js').DropFile;
let door				= require('../core/door.js');
let theme				= require('../core/theme.js');
let ansi				= require('../core/ansi_term.js');

let async				= require('async');
let assert				= require('assert');
let paths				= require('path');
let _					= require('lodash');
let mkdirs				= require('fs-extra').mkdirs;

//	:TODO: This should really be a system module... needs a little work to allow for such

exports.getModule		= AbracadabraModule;

let activeDoorNodeInstances = {};

exports.moduleInfo = {
	name	: 'Abracadabra',
	desc	: 'External BBS Door Module',
	author	: 'NuSkooler',
};

/*
	Example configuration for LORD under DOSEMU:

	{
		config: {
			name: PimpWars
			dropFileType: DORINFO
			cmd: qemu-system-i386
			args: [
				"-localtime",
				"freedos.img",
				"-chardev",
				"socket,port={srvPort},nowait,host=localhost,id=s0",
				"-device",
				"isa-serial,chardev=s0"
			]
			io: socket
		}
	}

	listen: socket | stdio

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

	let self = this;

	this.config = options.menuConfig.config;

	//	:TODO: MenuModule.validateConfig(cb) -- validate config section gracefully instead of asserts!
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

					mkdirs(paths.dirname(fullPath), function dirCreated(err) {
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
					self.client.log.warn( { error : err.toString() }, 'Could not start door');
					self.lastError = err;
					self.prevMenu();
				} else {
					self.finishedLoading();
				}
			}
		);
	};

	this.runDoor = function() {

		const exeInfo = {
			cmd			: self.config.cmd,
			args		: self.config.args,
			io			: self.config.io || 'stdio',
			encoding	: self.config.encoding || self.client.term.outputEncoding,
			dropFile	: self.dropFile.fileName,
			node		: self.client.node,
			//inhSocket	: self.client.output._handle.fd,
		};

		const doorInstance = new door.Door(self.client, exeInfo);

		doorInstance.once('finished', () => {
			//
			//	Try to clean up various settings such as scroll regions that may
			//	have been set within the door
			//
			self.client.term.rawWrite(
				ansi.normal() +
				ansi.goto(self.client.term.termHeight, self.client.term.termWidth) +
				ansi.setScrollRegion() +
				ansi.goto(self.client.term.termHeight, 0) +
				'\r\n\r\n'
			);

			self.prevMenu();
		});

		self.client.term.write(ansi.resetScreen());

		doorInstance.run();
	};
}

require('util').inherits(AbracadabraModule, MenuModule);

AbracadabraModule.prototype.leave = function() {
	AbracadabraModule.super_.prototype.leave.call(this);

	if(!this.lastError) {
		activeDoorNodeInstances[this.config.name] -= 1;
	}
};

AbracadabraModule.prototype.finishedLoading = function() {
	this.runDoor();
};