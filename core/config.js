/* jslint node: true */
'use strict';

var miscUtil			= require('./misc_util.js');

var fs					= require('fs');
var paths				= require('path');
var async				= require('async');
var _					= require('lodash');
var hjson				= require('hjson');
var assert              = require('assert');

exports.init				= init;
exports.getDefaultPath		= getDefaultPath;

function hasMessageConferenceAndArea(config) {
    assert(_.isObject(config.messageConferences));  //  we create one ourself!
    
    const nonInternalConfs = Object.keys(config.messageConferences).filter(confTag => {
       return 'system_internal' !== confTag; 
    });
    
    if(0 === nonInternalConfs.length) {
        return false;
    }
    
    //  :TODO: there is likely a better/cleaner way of doing this
    
    var result = false;
    _.forEach(nonInternalConfs, confTag => {
        if(_.has(config.messageConferences[confTag], 'areas') &&
            Object.keys(config.messageConferences[confTag].areas) > 0)
        {            
            result = true;
            return false;   //  stop iteration
        }
    });
    
    return result;
}

function init(configPath, cb) {
	async.waterfall(
		[
			function loadUserConfig(callback) {
				if(_.isString(configPath)) {
					fs.readFile(configPath, { encoding : 'utf8' }, function configData(err, data) {
						if(err) {
							callback(err);
						} else {
							try {
								var configJson = hjson.parse(data);
								callback(null, configJson);
							} catch(e) {
								callback(e);							
							}
						}
					});
				} else {
					callback(null, { } );
				}
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
			},
			function validate(mergedConfig, callback) {
				//
				//	Various sections must now exist in config
				//
                if(hasMessageConferenceAndArea(mergedConfig)) {
                    var msgAreasErr = new Error('Please create at least one message conference and area!');
					msgAreasErr.code = 'EBADCONFIG';
					callback(msgAreasErr);
                } else {
                    callback(null, mergedConfig);
                }
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

			menuFile		: 'menu.hjson',				//	Override to use something else, e.g. demo.hjson. Can be a full path (defaults to ./mods)
			promptFile		: 'prompt.hjson',			//	Override to use soemthing else, e.g. myprompt.hjson. Can be a full path (defaults to ./mods)
		},

		//	:TODO: see notes below about 'theme' section - move this!
		preLoginTheme : 'luciano_blocktronics',

		users : {
			usernameMin			: 2,
			usernameMax			: 16,	//	Note that FidoNet wants 36 max
			usernamePattern		: '^[A-Za-z0-9~!@#$%^&*()\\-\\_+]+$',

			passwordMin			: 6,
			passwordMax			: 128,

			realNameMax			: 32,
			locationMax			: 32,
			affilsMax			: 32,
			emailMax			: 255,
			webMax				: 255,

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

			scannerTossers		: paths.join(__dirname, './scanner_tossers/'),
			mailers				: paths.join(__dirname, './mailers/')		,

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

		archivers : {
			zip : {
				name			: "PKZip",	//	:TODO: Use key for this
				sig				: "504b0304",
				offset			: 0,
				compressCmd		: "7z",
				compressArgs	: [ "a", "-tzip", "{archivePath}", "{fileList}" ],
				decompressCmd	: "7z",
				decompressArgs	: [ "e", "-o{extractDir}", "{archivePath}" ]
			}
		},

		messageConferences : {
			system_internal : {
				name 	: 'System Internal',
				desc 	: 'Built in conference for private messages, bulletins, etc.',
				
				areas : {
					private_mail : {
						name	: 'Private Mail',
						desc	: 'Private user to user mail/email',
					},

					local_bulletin : {
						name	: 'System Bulletins',
						desc	: 'Bulletin messages for all users',
					}
				}
			}
		},
		
		scannerTossers : {
			ftn_bso : {
				paths : {
					outbound	: paths.join(__dirname, './../mail/ftn_out/'),
					inbound		: paths.join(__dirname, './../mail/ftn_in/'),
					secInbound	: paths.join(__dirname, './../mail/ftn_secin/'),
					temp		: paths.join(__dirname, './../mail/ftn_temp'),
				},

				//
				//	Packet and (ArcMail) bundle target sizes are just that: targets.
				//	Actual sizes may be slightly larger when we must place a full
				//	PKT contents *somewhere*
				//
				packetTargetByteSize : 512000,		//	512k, before placing messages in a new pkt
				bundleTargetByteSize : 2048000,		//	2M, before creating another archive
			}
		},

		misc : {
			idleLogoutSeconds	: 60 * 6,	//	6m
		},

		logging : {
			level	: 'debug'
		}
	};
}
