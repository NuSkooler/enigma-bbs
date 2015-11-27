/* jslint node: true */
'use strict';

var Config			= require('./config.js').config;

var fs				= require('fs');
var paths			= require('path');
var _				= require('lodash');
var async			= require('async');
var moment			= require('moment');
var iconv			= require('iconv-lite');

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
				DOOR			: self.getDoorSysBuffer(),
				DOOR32			: self.getDoor32Buffer(),
				DORINFO			: self.getDoorInfoDefBuffer(),
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

	this.getDoorSysBuffer = function() {
		var up			= self.client.user.properties;
		var now			= moment();
		var secLevel	= self.client.user.getLegacySecurityLevel().toString();

		//	:TODO: fix time remaining
		//	:TODO: fix default protocol -- user prop: transfer_protocol

		return iconv.encode( [
			'COM1:',											//	"Comm Port - COM0: = LOCAL MODE"
			'57600',											//	"Baud Rate - 300 to 38400" (Note: set as 57600 instead!)
			'8',												//	"Parity - 7 or 8"
			self.client.node.toString(),						//	"Node Number - 1 to 99"
			'57600',											//	"DTE Rate. Actual BPS rate to use. (kg)"
			'Y',												//	"Screen Display - Y=On  N=Off             (Default to Y)"
			'Y',												//	"Printer Toggle - Y=On  N=Off             (Default to Y)"
			'Y',												//	"Page Bell      - Y=On  N=Off             (Default to Y)"
			'Y',												//	"Caller Alarm   - Y=On  N=Off             (Default to Y)"
			up.real_name || self.client.user.username,			//	"User Full Name"
			up.location || 'Anywhere',							//	"Calling From"
			'123-456-7890',										//	"Home Phone"
			'123-456-7890',										//	"Work/Data Phone"
			'NOPE',												//	"Password" (Note: this is never given out or even stored plaintext)
			secLevel,											//	"Security Level"
			up.login_count.toString(),							//	"Total Times On"
			now.format('MM/DD/YY'),								//	"Last Date Called"
			'15360',											//	"Seconds Remaining THIS call (for those that particular)"
			'256',												//	"Minutes Remaining THIS call"
			'GR',												//	"Graphics Mode - GR=Graph, NG=Non-Graph, 7E=7,E Caller"
			self.client.term.termHeight.toString(),				//	"Page Length"
			'N',												//	"User Mode - Y = Expert, N = Novice"
			'1,2,3,4,5,6,7',									//	"Conferences/Forums Registered In  (ABCDEFG)"
			'1',												//	"Conference Exited To DOOR From    (G)"
			'01/01/99',											//	"User Expiration Date              (mm/dd/yy)"
			self.client.user.userId.toString(),					//	"User File's Record Number"
			'Z',												//	"Default Protocol - X, C, Y, G, I, N, Etc."
			//	:TODO: fix up, down, etc. form user properties
			'0',												//	"Total Uploads"
			'0',												//	"Total Downloads"
			'0',												//	"Daily Download "K" Total"
			'999999',											//	"Daily Download Max. "K" Limit"
			moment(up.birthdate).format('MM/DD/YY'),			//	"Caller's Birthdate"
			'X:\\MAIN\\',										//	"Path to the MAIN directory (where User File is)"
			'X:\\GEN\\',										//	"Path to the GEN directory"
			Config.general.sysOp.username,						//	"Sysop's Name (name BBS refers to Sysop as)"
			self.client.user.username,							//	"Alias name"
			'00:05',											//	"Event time                        (hh:mm)" (note: wat?)
			'Y',												//	"If its an error correcting connection (Y/N)"
			'Y',												//	"ANSI supported & caller using NG mode (Y/N)"
			'Y',												//	"Use Record Locking                    (Y/N)"
			'7',												//	"BBS Default Color (Standard IBM color code, ie, 1-15)"
			//	:TODO: fix minutes here also:
			'256',												//	"Time Credits In Minutes (positive/negative)"
			'07/07/90',											//	"Last New Files Scan Date          (mm/dd/yy)"
			//	:TODO: fix last vs now times:
			now.format('hh:mm'),								//	"Time of This Call"
			now.format('hh:mm'),								//	"Time of Last Call                 (hh:mm)"
			'9999',												//	"Maximum daily files available"
			//	:TODO: fix these stats:
			'0',												//	"Files d/led so far today"
			'0',												//	"Total "K" Bytes Uploaded"
			'0',												//	"Total "K" Bytes Downloaded"
			up.user_comment || 'None',							//	"User Comment"
			'0',												//	"Total Doors Opened"
			'0',												//	"Total Messages Left"

			].join('\r\n') + '\r\n', 'cp437');
	};

	this.getDoor32Buffer = function() {
		//
		//	Resources:
		//	* http://wiki.bbses.info/index.php/DOOR32.SYS
		//
		//	:TODO: local/serial/telnet need to be configurable -- which also changes socket handle!
		return iconv.encode([
			'2',						//	:TODO: This needs to be configurable!
			self.client.output._handle.fd.toString(),
			'57600',
			Config.general.boardName,
			self.client.user.userId.toString(),
			self.client.user.properties.real_name || self.client.user.username,
			self.client.user.username,
			self.client.user.getLegacySecurityLevel.toString(),
			'546',	//	:TODO: Minutes left!
			'1',	//	ANSI
			self.client.node.toString(),
		].join('\r\n') + '\r\n', 'cp437');

	};

	this.getDoorInfoDefBuffer = function() {
		//	:TODO: fix time remaining

		//
		//	Resources:
		//	* http://goldfndr.home.mindspring.com/dropfile/dorinfo.htm
		//
		//	Note that usernames are just used for first/last names here
		//
		var opUn		= /[^\s]*/.exec(Config.general.sysOp.username)[0];
		var un			= /[^\s]*/.exec(self.client.user.username)[0];
		var secLevel	= self.client.user.getLegacySecurityLevel().toString();

		return iconv.encode( [
			Config.general.boardName,							//	"The name of the system."
			opUn,												//	"The sysop's name up to the first space."
			opUn,												//	"The sysop's name following the first space."
			'COM1',												//	"The serial port the modem is connected to, or 0 if logged in on console."
			'57600',											//	"The current port (DTE) rate."
			'0',												//	"The number "0""
			un,													//	"The current user's name, up to the first space."
			un,													//	"The current user's name, following the first space."
			self.client.user.properties.location || '',			//	"Where the user lives, or a blank line if unknown."
			'1',												//	"The number "0" if TTY, or "1" if ANSI."
			secLevel,											//	"The number 5 for problem users, 30 for regular users, 80 for Aides, and 100 for Sysops."
			'546',												//	"The number of minutes left in the current user's account, limited to 546 to keep from overflowing other software."
			'-1'												//	"The number "-1" if using an external serial driver or "0" if using internal serial routines."
		].join('\r\n') + '\r\n', 'cp437');
	};

}

DropFile.fileTypes = [ 'DORINFO' ];

DropFile.prototype.createFile = function(cb) {
	fs.writeFile(this.fullPath, this.dropFileContents, function written(err) {
		cb(err);
	});
};

