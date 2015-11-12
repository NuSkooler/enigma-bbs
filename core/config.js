/* jslint node: true */
'use strict';

var miscUtil			= require('./misc_util.js');

var fs					= require('fs');
var paths				= require('path');
var async				= require('async');
var _					= require('lodash');
var hjson				= require('hjson');

exports.init				= init;
exports.getDefaultPath		= getDefaultPath;

function init(configPath, cb) {
	async.waterfall(
		[
			function loadUserConfig(callback) {
		
				fs.readFile(configPath, { encoding : 'utf8' }, function configData(err, data) {
					if(err) {
						callback(null, { } );
					} else {
						try {
							var configJson = hjson.parse(data);
							callback(null, configJson);
						} catch(e) {
							callback(e);							
						}
					}
				});
			},
			function mergeWithDefaultConfig(configJson, callback) {
				var mergedConfig = _.merge(getDefaultConfig(), configJson, function mergeCustomizer(conf1, conf2) {
					//	Arrays should always concat
					if(_.isArray(conf1)) {
						//	:TODO: look for collisions & override dupes
						return conf1.concat(conf2);
					}
				});

				callback(null, mergedConfig);
			}
		],
		function complete(err, mergedConfig) {
			exports.config = mergedConfig;
			cb(err);
		}
	);
}

function getDefaultPath() {
	var base = miscUtil.resolvePath('~/');
	if(base) {
		//	e.g. /home/users/joeuser/.config/enigma-bbs/config.hjson
		return paths.join(base, '.config', 'enigma-bbs', 'config.hjson');
	}
}

function getDefaultConfig() {
	return {
		general : {
			boardName		: 'Another Fine ENiGMA½ BBS',

			closedSystem	: false,					//	is the system closed to new users?

			loginAttempts	: 3,
		},

		preLoginTheme : '*',

		users : {
			usernameMin			: 2,
			usernameMax			: 16,	//	Note that FidoNet wants 36 max
			usernamePattern		: '^[A-Za-z0-9~!@#$%^&*()\\-\\_+]+$',
			passwordMin			: 6,
			passwordMax			: 128,
			requireActivation	: true,	//	require SysOp activation?
			invalidUsernames	: [],

			groups				: [ 'users', 'sysops' ],		//	built in groups
			defaultGroups		: [ 'users' ],					//	default groups new users belong to

			newUserNames		: [ 'new', 'apply' ],			//	Names reserved for applying

			//	:TODO: Mystic uses TRASHCAN.DAT for this -- is there a reason to support something like that?
			badUserNames		: [ 'sysop', 'admin', 'administrator', 'root', 'all' ],
		},

		//	:TODO: better name for "defaults"... which is redundant here!
		/*
		Concept
		"theme" : {
			"default" : "defaultThemeName", // or "*"
			"preLogin" : "*",
			"passwordChar" : "*",
			...
		}
		*/
		defaults : {
			theme			: 'luciano_blocktronics',
			passwordChar	: '*',		//	TODO: move to user ?
			dateFormat	: {
				short	: 'MM/DD/YYYY',
			},
			timeFormat : {
				short	: 'h:mm a',
			},
			dateTimeFormat : {
				short	: 'MM/DD/YYYY h:mm a',
			}
		},

		menus : {
			cls		: true,	//	Clear screen before each menu by default?
		},	

		paths		: {
			mods				: paths.join(__dirname, './../mods/'),
			servers				: paths.join(__dirname, './servers/'),
			art					: paths.join(__dirname, './../mods/art/'),
			themes				: paths.join(__dirname, './../mods/themes/'),
			logs				: paths.join(__dirname, './../logs/'),	//	:TODO: set up based on system, e.g. /var/logs/enigmabbs or such
			db					: paths.join(__dirname, './../db/'),
			dropFiles			: paths.join(__dirname, './../dropfiles/'),	//	+ "/node<x>/
			misc				: paths.join(__dirname, './../misc/'),
		},
		
		servers : {
			telnet : {
				port			: 8888,
				enabled			: true,
				firstMenu		: 'telnetConnected',
			},
			ssh : {
				port				: 8889,
				enabled				: true,

				//
				//	Private key in PEM format
				//	
				//	Generating your PK:
				//	> openssl genrsa -des3 -out ./misc/ssh_private_key.pem 2048
				//
				//	Then, set servers.ssh.privateKeyPass to the password you use above
				//	in your config.hjson
				//
				privateKeyPem		: paths.join(__dirname, './../misc/ssh_private_key.pem'),
				firstMenu			: 'sshConnected',
				firstMenuNewUser	: 'sshConnectedNewUser',
			}
		},

		messages : {
			areas : [
				{ name : 'private_mail', desc : 'Private Email', groups : [ 'users' ] }
			]
		},

		networks : {
			/*
			networkName : {	//	e.g. fidoNet
				address : {
					zone	: 0,
					net		: 0,
					node	: 0,
					point 	: 0,
					domain	: 'l33t.codes'
				}
			}
			*/
		},

		misc : {
			idleLogoutSeconds	: 60 * 6,	//	6m
		},

		logging : {
			level	: 'debug'
		}
	};
}
