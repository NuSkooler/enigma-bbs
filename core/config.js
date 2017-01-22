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

	let result = false;
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
					return callback(msgAreasErr);
				} else {
					return callback(null, mergedConfig);
				}
			}
		],
		function complete(err, mergedConfig) {
			exports.config = mergedConfig;
			return cb(err);
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
			usernamePattern		: '^[A-Za-z0-9~!@#$%^&*()\\-\\_+ ]+$',

			passwordMin			: 6,
			passwordMax			: 128,

			realNameMax			: 32,
			locationMax			: 32,
			affilsMax			: 32,
			emailMax			: 255,
			webMax				: 255,

			requireActivation	: false,	//	require SysOp activation? false = auto-activate
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
			loginServers		: paths.join(__dirname, './servers/login/'),
			contentServers		: paths.join(__dirname, './servers/content/'),

			scannerTossers		: paths.join(__dirname, './scanner_tossers/'),
			mailers				: paths.join(__dirname, './mailers/')		,

			art					: paths.join(__dirname, './../mods/art/'),
			themes				: paths.join(__dirname, './../mods/themes/'),
			logs				: paths.join(__dirname, './../logs/'),	//	:TODO: set up based on system, e.g. /var/logs/enigmabbs or such
			db					: paths.join(__dirname, './../db/'),
			modsDb				: paths.join(__dirname, './../db/mods/'),				
			dropFiles			: paths.join(__dirname, './../dropfiles/'),	//	+ "/node<x>/
			misc				: paths.join(__dirname, './../misc/'),
		},
		
		loginServers : {
			telnet : {
				port			: 8888,
				enabled			: true,
				firstMenu		: 'telnetConnected',
			},
			ssh : {
				port				: 8889,
				enabled				: false,    //  defualt to false as PK/pass in config.hjson are required

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

		contentServers : {
			web : {
				domain : 'another-fine-enigma-bbs.org',
				
				http : {
					enabled : false,
					port	: 8080,						
				},
				https : {
					enabled	: false,
					port	: 8443,
					certPem	: paths.join(__dirname, './../misc/https_cert.pem'),
					keyPem	: paths.join(__dirname, './../misc/https_cert_key.pem'),
				}
			}
		},
	
		archives : {
			archivers : {
				'7Zip' : {
					compress		: {
						cmd			: '7za',
						args		: [ 'a', '-tzip', '{archivePath}', '{fileList}' ],
					},
					decompress		: {
						cmd			: '7za',
						args		: [ 'e', '-o{extractPath}', '{archivePath}' ]
					},
					list			: {
						cmd			: '7za',
						args		: [ 'l', '{archivePath}' ],
						entryMatch	: '^[0-9]{4}-[0-9]{2}-[0-9]{2}\\s[0-9]{2}:[0-9]{2}:[0-9]{2}\\s[A-Za-z\\.]{5}\\s+([0-9]+)\\s+[0-9]+\\s+([^\\r\\n]+)$',
					},
					extract			: {
						cmd			: '7za',
						args		: [ 'e', '-o{extractPath}', '{archivePath}', '{fileList}' ],
					},
				}
			},
			formats : {
				zip	: {
					sig		: '504b0304',
					offset	: 0,
					exts	: [ 'zip' ],
					handler	: '7Zip',	
					desc	: 'ZIP Archive',
				},
				'7z' : {
					sig		: '377abcaf271c',
					offset	: 0,
					exts	: [ '7z' ],
					handler	: '7Zip',
					desc	: '7-Zip Archive',
				},
				arj : {
					sig		: '60ea',
					offset	: 0,
					exts	: [ 'arj' ],
					handler	: '7Zip',
					desc	: 'ARJ Archive',
				},
				rar :  {
					sig		: '526172211a0700',
					offset	: 0,
					exts	: [ 'rar' ],
					handler	: '7Zip',
					desc	: 'RAR Archive',
				},
				gzip :  {
					sig		: '1f8b',
					offset	: 0,
					exts	: [ 'gz' ],
					handler	: '7Zip',
					desc	: 'Gzip Archive',
				}
			}
		},
		
		fileTransferProtocols : {
			zmodem8kSz : {
				name		: 'ZModem 8k',
				type		: 'external',
				external	: {					
					sendCmd		: 'sz',	//	Avail on Debian/Ubuntu based systems as the package "lrzsz"
					sendArgs	: [
						//	:TODO: try -q
						'--zmodem', '--try-8k', '--binary', '--restricted', '{filePaths}'
					],
					recvCmd		: 'rz',	//	Avail on Debian/Ubuntu based systems as the package "lrzsz"
					recvArgs	: [
						'--zmodem', '--binary', '--restricted', '--keep-uppercase', 	//	dumps to CWD which is set to {uploadDir}
					],
					//	:TODO: can we not just use --escape ?
					escapeTelnet	: true,	//	set to true to escape Telnet codes such as IAC					
					supportsBatch	: true,
				} 
			},

			zmodem8kSexyz : {
				name		: 'ZModem 8k (SEXYZ)',
				type		: 'external',
				external	: {
					//	:TODO: Look into shipping sexyz binaries or at least hosting them somewhere for common systems
					sendCmd		: 'sexyz',
					sendArgs	: [
						'-telnet', '-8', 'sz', '@{fileListPath}'
					],
					recvCmd		: 'sexyz',
					recvArgs	: [
						'-telnet', '-8', 'rz', '{uploadDir}'
					],
					escapeTelnet	: false,	//	-telnet option does this for us
					supportsBatch	: true,
				} 
			}

		},
		
		messageAreaDefaults : {
			//
			//	The following can be override per-area as well
			//
			maxMessages		: 1024,	//	0 = unlimited
			maxAgeDays		: 0,	//	0 = unlimited
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

		fileBase: {
			//	areas with an explicit |storageDir| will be stored relative to |areaStoragePrefix|: 
			areaStoragePrefix	: paths.join(__dirname, './../file_base/'),

			fileNamePatterns: {
				//	These are NOT case sensitive
				//	FILE_ID.DIZ - https://en.wikipedia.org/wiki/FILE_ID.DIZ
				shortDesc		: [ 
					'^FILE_ID\.DIZ$', '^DESC\.SDI$', '^DESCRIPT\.ION$', '^FILE\.DES$', '$FILE\.SDI$', '^DISK\.ID$'
				],

				//	common README filename - https://en.wikipedia.org/wiki/README
				longDesc		: [ 
					'^.*\.NFO$', '^README\.1ST$', '^README\.TXT$', '^READ\.ME$', '^README$', '^README\.md$'
				],
			},

			yearEstPatterns: [
				//
				//	Patterns should produce the year in the first submatch.
				//	The extracted year may be YY or YYYY
				//
				'[0-3]?[0-9][\\-\\/\\.][0-3]?[0-9][\\-\\/\\.]((?:[0-9]{2})?[0-9]{2})',	//	m/d/yyyy, mm-dd-yyyy, etc.
				"\\B('[1789][0-9])\\b",	//	eslint-disable-line quotes
				'[0-3]?[0-9][\\-\\/\\.](?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|may|june|july|august|september|october|november|december)[\\-\\/\\.]((?:[0-9]{2})?[0-9]{2})',				
				'(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|may|june|july|august|september|october|november|december),?\\s[0-9]+(?:st|nd|rd|th)\\s((?:[0-9]{2})?[0-9]{2})',	//	November 29th, 1997
				//	:TODO: DD/MMM/YY, DD/MMMM/YY, DD/MMM/YYYY, etc.
			],

			web : {
				path			: '/f/',
				routePath		: '/f/[a-zA-Z0-9]+$',
				expireMinutes	: 1440,	//	1 day
			},

			//
			//	File area storage location tag/value pairs.
			//	Non-absolute paths are relative to |areaStoragePrefix|.
			// 
			storageTags : {
				sys_msg_attach	: 'msg_attach',
			},

			areas: {
				system_message_attachment : {
					name		: 'Message attachments',
					desc		: 'File attachments to messages',
					storageTags	: 'sys_msg_attach',	//	may be string or array of strings
				}
			}
		},
		
		eventScheduler : {
			
			events : {
				trimMessageAreas : {
					//	may optionally use [or ]@watch:/path/to/file
					schedule	: 'every 24 hours',
					
					//	action:
					//	- @method:path/to/module.js:theMethodName
					//	  (path is relative to engima base dir)
					//
					//	- @execute:/path/to/something/executable.sh 
					//	
					action		: '@method:core/message_area.js:trimMessageAreasScheduledEvent',
				}
			}	
		},

		misc : {
			preAuthIdleLogoutSeconds	: 60 * 3,	//	2m
			idleLogoutSeconds			: 60 * 6,	//	6m
		},

		logging : {
			level	: 'debug',

			rotatingFile	: {	//	set to 'disabled' or false to disable
				type		: 'rotating-file',
				fileName	: 'enigma-bbs.log',
				period		: '1d',
				count		: 3,
				level		: 'debug',
			}

			//	:TODO: syslog - https://github.com/mcavage/node-bunyan-syslog
		},

		debug : {
			assertsEnabled	: false,
		}
	};
}
