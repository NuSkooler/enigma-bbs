/* jslint node: true */
'use strict';

var Config			= require('./config.js').config;

var fs				= require('fs');
var paths			= require('path');
var _				= require('lodash');
var async			= require('async');

exports.DropFile	= DropFile;

//
//	Resources
//	* http://goldfndr.home.mindspring.com/dropfile/
//	* https://en.wikipedia.org/wiki/Talk%3ADropfile
//	* http://thoughtproject.com/libraries/bbs/Sysop/Doors/DropFiles/index.htm
//	* http://thebbs.org/bbsfaq/ch06.02.htm

//	http://lord.lordlegacy.com/dosemu/

function DropFile(client, fileType) {

	var self 			= this;
	this.client			= client;
	this.fileType		= (fileType || 'DORINFO').toUpperCase();

	Object.defineProperty(this, 'fullPath', {
		get : function() {
			return paths.join(Config.paths.dropFiles, ('node' + self.client.node), self.fileName);
		}
	});

	Object.defineProperty(this, 'fileName', {
		get : function() {
			return {
				DOOR			: 'DOOR.SYS',					//	GAP BBS, many others
				DOOR32			: 'DOOR32.SYS',					//	EleBBS / Mystic, Syncronet, Maximus, Telegard, AdeptXBBS, ...
				CALLINFO		: 'CALLINFO.BBS',				//	Citadel?
				DORINFO			: self.getDoorInfoFileName(),	//	RBBS, RemoteAccess, QBBS, ...
				CHAIN			: 'CHAIN.TXT',					//	WWIV
				CURRUSER		: 'CURRUSER.BBS',				//	RyBBS
				SFDOORS			: 'SFDOORS.DAT',				//	Spitfire
				PCBOARD			: 'PCBOARD.SYS',				//	PCBoard
				TRIBBS			: 'TRIBBS.SYS',					//	TriBBS
				USERINFO		: 'USERINFO.DAT',				//	Wildcat! 3.0+
				JUMPER			: 'JUMPER.DAT',					//	2AM BBS
				SXDOOR			: 								//	System/X, dESiRE
					'SXDOOR.' + _.pad(self.client.node.toString(), 3, '0'),
				INFO			: 'INFO.BBS',					//	Phoenix BBS
			}[self.fileType];
		}
	});

	Object.defineProperty(this, 'dropFileContents', {
		get : function() {
			return {
				DORINFO			: self.getDoorInfoBuffer(),
			}[self.fileType];
		}
	});

	this.getDoorInfoFileName = function() {
		var x;
		var node = self.client.node;
		if(10 === node) {
			x = 0;
		} else if(node < 10) {
			x = node;
		} else {
			x = String.fromCharCode('a'.charCodeAt(0) + (node - 11));
		}
		return 'DORINFO' + x + '.DEF';
	};

	this.getDoorInfoBuffer = function() {
		//	:TODO: fix time remaining

		//
		//	Resources:
		//	* http://goldfndr.home.mindspring.com/dropfile/dorinfo.htm
		//
		//	Note that usernames are just used for first/last names here
		//
		var opUn	= /[^\s]*/.exec(Config.general.sysOp.username)[0];
		var un		= /[^\s]*/.exec(self.client.user.username)[0];
		return new Buffer([
			Config.general.boardName,						//	"The name of the system."
			opUn,											//	"The sysop's name up to the first space."
			opUn,											//	"The sysop's name following the first space."
			'COM1',											//	"The serial port the modem is connected to, or 0 if logged in on console."
			'57600',										//	"The current port (DTE) rate."
			'0',											//	"The number "0""
			un,												//	"The current user's name, up to the first space."
			un,												//	"The current user's name, following the first space."
			self.client.user.properties.location || '',		//	"Where the user lives, or a blank line if unknown."
			'1',											//	"The number "0" if TTY, or "1" if ANSI."
			self.client.user.isSysOp() ? '100' : '30',		//	"The number 5 for problem users, 30 for regular users, 80 for Aides, and 100 for Sysops."
			'546',											//	"The number of minutes left in the current user's account, limited to 546 to keep from overflowing other software."
			'-1'											//	"The number "-1" if using an external serial driver or "0" if using internal serial routines."
		].join('\r\n') + '\r\n', 'cp437');
	};

}

DropFile.fileTypes = [ 'DORINFO' ];

DropFile.prototype.createFile = function(cb) {
	fs.writeFile(this.fullPath, this.dropFileContents, function written(err) {
		cb(err);
	});
}
