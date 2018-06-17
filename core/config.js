/* jslint node: true */
'use strict';

//	ENiGMA½
const Errors			= require('./enig_error.js').Errors;

//	deps
const paths				= require('path');
const async				= require('async');
const _					= require('lodash');
const assert			= require('assert');

exports.init			= init;
exports.getDefaultPath	= getDefaultPath;

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

function mergeValidateAndFinalize(config, cb) {
	async.waterfall(
		[
			function mergeWithDefaultConfig(callback) {
				const mergedConfig = _.mergeWith(
					getDefaultConfig(),
					config, (conf1, conf2) => {
						//	Arrays should always concat
						if(_.isArray(conf1)) {
							//	:TODO: look for collisions & override dupes
							return conf1.concat(conf2);
						}
					}
				);

				return callback(null, mergedConfig);
			},
			function validate(mergedConfig, callback) {
				//
				//	Various sections must now exist in config
				//
				//	:TODO: Logic is broken here:
				if(hasMessageConferenceAndArea(mergedConfig)) {
					return callback(Errors.MissingConfig('Please create at least one message conference and area!'));
				}
				return callback(null, mergedConfig);
			},
			function setIt(mergedConfig, callback) {
				exports.config = mergedConfig;

				exports.config.get = (path) => {
					return _.get(exports.config, path);
				};

				return callback(null);
			}
		],
		err => {
			if(cb) {
				return cb(err);
			}
		}
	);
}

function init(configPath, options, cb) {
	if(!cb && _.isFunction(options)) {
		cb = options;
		options = {};
	}

	const changed = ( { fileName, fileRoot } ) => {
		const reCachedPath = paths.join(fileRoot, fileName);
		ConfigCache.getConfig(reCachedPath, (err, config) => {
			if(!err) {
				mergeValidateAndFinalize(config);
			}
		});
	};

	const ConfigCache = require('./config_cache.js');
	const getConfigOptions = {
		filePath	: configPath,
		noWatch		: options.noWatch,
	};
	if(!options.noWatch) {
		getConfigOptions.callback = changed;
	}
	ConfigCache.getConfigWithOptions(getConfigOptions, (err, config) => {
		if(err) {
			return cb(err);
		}

		return mergeValidateAndFinalize(config, cb);
	});
}

function getDefaultPath() {
	//	e.g. /enigma-bbs-install-path/config/
	return './config/';
}

function getDefaultConfig() {
	return {
		general : {
			boardName		: 'Another Fine ENiGMA½ BBS',

			closedSystem	: false,					//	is the system closed to new users?

			loginAttempts	: 3,

			menuFile		: 'menu.hjson',				//	Override to use something else, e.g. demo.hjson. Can be a full path (defaults to ./config)
			promptFile		: 'prompt.hjson',			//	Override to use soemthing else, e.g. myprompt.hjson. Can be a full path (defaults to ./config)
		},

		//	:TODO: see notes below about 'theme' section - move this!
		preLoginTheme : 'luciano_blocktronics',

		users : {
			usernameMin			: 2,
			usernameMax			: 16,	//	Note that FidoNet wants 36 max
			usernamePattern		: '^[A-Za-z0-9~!@#$%^&*()\\-\\_+ ]+$',

			passwordMin			: 6,
			passwordMax			: 128,
			badPassFile			: paths.join(__dirname, '../misc/10_million_password_list_top_10000.txt'),	//	https://github.com/danielmiessler/SecLists

			realNameMax			: 32,
			locationMax			: 32,
			affilsMax			: 32,
			emailMax			: 255,
			webMax				: 255,

			requireActivation	: false,	//	require SysOp activation? false = auto-activate

			groups				: [ 'users', 'sysops' ],		//	built in groups
			defaultGroups		: [ 'users' ],					//	default groups new users belong to

			newUserNames		: [ 'new', 'apply' ],			//	Names reserved for applying

			badUserNames		: [
				'sysop', 'admin', 'administrator', 'root', 'all',
				'areamgr', 'filemgr', 'filefix', 'areafix', 'allfix'
			],
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
				long	: 'ddd, MMMM Do, YYYY',
			},
			timeFormat : {
				short	: 'h:mm a',
			},
			dateTimeFormat : {
				short	: 'MM/DD/YYYY h:mm a',
				long	: 'ddd, MMMM Do, YYYY, h:mm a',
			}
		},

		menus : {
			cls		: true,	//	Clear screen before each menu by default?
		},

		paths		: {
			config				: paths.join(__dirname, './../config/'),
			mods				: paths.join(__dirname, './../mods/'),
			loginServers		: paths.join(__dirname, './servers/login/'),
			contentServers		: paths.join(__dirname, './servers/content/'),

			scannerTossers		: paths.join(__dirname, './scanner_tossers/'),
			mailers				: paths.join(__dirname, './mailers/')		,

			art					: paths.join(__dirname, './../art/general/'),
			themes				: paths.join(__dirname, './../art/themes/'),
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
				enabled				: false,    //  default to false as PK/pass in config.hjson are required

				//
				//	Private key in PEM format
				//
				//	Generating your PK:
				//	> openssl genrsa -des3 -out ./config/ssh_private_key.pem 2048
				//
				//	Then, set servers.ssh.privateKeyPass to the password you use above
				//	in your config.hjson
				//
				privateKeyPem		: paths.join(__dirname, './../config/ssh_private_key.pem'),
				firstMenu			: 'sshConnected',
				firstMenuNewUser	: 'sshConnectedNewUser',
			},
			webSocket : {
				ws : {
					//	non-secure ws://
					enabled			: false,
					port			: 8810,
				},
				wss : {
					//	secure ws://
					//	must provide valid certPem and keyPem
					enabled			: false,
					port			: 8811,
					certPem			: paths.join(__dirname, './../config/https_cert.pem'),
					keyPem			: paths.join(__dirname, './../config/https_cert_key.pem'),
				},
			},
		},

		contentServers : {
			web : {
				domain : 'another-fine-enigma-bbs.org',

				staticRoot : paths.join(__dirname, './../www'),

				resetPassword : {
					//
					//	The following templates have these variables available to them:
					//
					//	* %BOARDNAME%		: Name of BBS
					//	* %USERNAME%		: Username of whom to reset password
					//	* %TOKEN%			: Reset token
					//	* %RESET_URL%		: In case of email, the link to follow for reset. In case of landing page,
					//						  URL to POST submit reset form.

					//	templates for pw reset *email*
					resetPassEmailText	: paths.join(__dirname, '../misc/reset_password_email.template.txt'),	//	plain text version
					resetPassEmailHtml	: paths.join(__dirname, '../misc/reset_password_email.template.html'),	//	HTML version

					//	tempalte for pw reset *landing page*
					//
					resetPageTemplate	: paths.join(__dirname, './../www/reset_password.template.html'),
				},

				http : {
					enabled : false,
					port	: 8080,
				},
				https : {
					enabled	: false,
					port	: 8443,
					certPem	: paths.join(__dirname, './../config/https_cert.pem'),
					keyPem	: paths.join(__dirname, './../config/https_cert_key.pem'),
				}
			}
		},

		infoExtractUtils : {
			Exiftool2Desc :  {
				cmd			: `${__dirname}/../util/exiftool2desc.js`,	//	ensure chmod +x
			},
			Exiftool : {
				cmd			: 'exiftool',
				args		: [
					'-charset', 'utf8', '{filePath}',
					//	exclude the following:
					'--directory', '--filepermissions', '--exiftoolversion', '--filename', '--filesize',
					'--filemodifydate', '--fileaccessdate', '--fileinodechangedate', '--createdate', '--modifydate',
					'--metadatadate', '--xmptoolkit'
				]
			},
			XDMS2Desc : {
				//	http://manpages.ubuntu.com/manpages/trusty/man1/xdms.1.html
				cmd		: 'xdms',
				args	: [ 'd', '{filePath}' ]
			},
			XDMS2LongDesc : {
				//	http://manpages.ubuntu.com/manpages/trusty/man1/xdms.1.html
				cmd		: 'xdms',
				args	: [ 'f', '{filePath}' ]
			}
		},

		fileTypes : {
			//
			//	File types explicitly known to the system. Here we can configure
			//	information extraction, archive treatment, etc.
			//
			//	MIME types can be found in mime-db: https://github.com/jshttp/mime-db
			//
			//	Resources for signature/magic bytes:
			//	* http://www.garykessler.net/library/file_sigs.html
			//
			//
			//	:TODO: text/x-ansi -> SAUCE extraction for .ans uploads
			//	:TODO: textual : bool -- if text, we can view.
			//	:TODO: asText : { cmd, args[] } -> viewable text

			//
			//	Audio
			//
			'audio/mpeg' : {
				desc 			: 'MP3 Audio',
				shortDescUtil	: 'Exiftool2Desc',
				longDescUtil	: 'Exiftool',
			},
			'application/pdf' : {
				desc			: 'Adobe PDF',
				shortDescUtil	: 'Exiftool2Desc',
				longDescUtil	: 'Exiftool',
			},
			//
			//	Video
			//
			'video/mp4' : {
				desc			: 'MPEG Video',
				shortDescUtil	: 'Exiftool2Desc',
				longDescUtil	: 'Exiftool',
			},
			'video/x-matroska ' : {
				desc			: 'Matroska Video',
				shortDescUtil	: 'Exiftool2Desc',
				longDescUtil	: 'Exiftool',
			},
			'video/x-msvideo' : {
				desc			: 'Audio Video Interleave',
				shortDescUtil	: 'Exiftool2Desc',
				longDescUtil	: 'Exiftool',
			},
			//
			//	Images
			//
			'image/jpeg'	: {
				desc			: 'JPEG Image',
				shortDescUtil	: 'Exiftool2Desc',
				longDescUtil	: 'Exiftool',
			},
			'image/png'	: {
				desc			: 'Portable Network Graphic Image',
				shortDescUtil	: 'Exiftool2Desc',
				longDescUtil	: 'Exiftool',
			},
			'image/gif' : {
				desc			: 'Graphics Interchange Format Image',
				shortDescUtil	: 'Exiftool2Desc',
				longDescUtil	: 'Exiftool',
			},
			'image/webp' :  {
				desc			: 'WebP Image',
				shortDescUtil	: 'Exiftool2Desc',
				longDescUtil	: 'Exiftool',
			},
			//
			//	Archives
			//
			'application/zip' : {
				desc			: 'ZIP Archive',
				sig				: '504b0304',
				offset			: 0,
				archiveHandler	: '7Zip',
			},
			/*
			'application/x-cbr' : {
				desc			: 'Comic Book Archive',
				sig				: '504b0304',
			},
			*/
			'application/x-arj' : {
				desc			: 'ARJ Archive',
				sig				: '60ea',
				offset			: 0,
				archiveHandler	: 'Arj',
			},
			'application/x-rar-compressed' : {
				desc			: 'RAR Archive',
				sig				: '526172211a0700',
				offset			: 0,
				archiveHandler	: 'Rar',
			},
			'application/gzip' : {
				desc			: 'Gzip Archive',
				sig				: '1f8b',
				offset			: 0,
				archiveHandler	: 'TarGz',
			},
			//	:TODO: application/x-bzip
			'application/x-bzip2' : {
				desc			: 'BZip2 Archive',
				sig				: '425a68',
				offset			: 0,
				archiveHandler	: '7Zip',
			},
			'application/x-lzh-compressed' : {
				desc			: 'LHArc Archive',
				sig				: '2d6c68',
				offset			: 2,
				archiveHandler	: 'Lha',
			},
			'application/x-lzx' : {
				desc			: 'LZX Archive',
				sig				: '4c5a5800',
				offset			: 0,
				archiveHandler	: 'Lzx',
			},
			'application/x-7z-compressed' : {
				desc			: '7-Zip Archive',
				sig				: '377abcaf271c',
				offset			: 0,
				archiveHandler	: '7Zip',
			},

			//
			//	Generics that need further mapping
			//
			'application/octet-stream' : [
				{
					desc			: 'Amiga DISKMASHER',
					sig				: '444d5321',	//	DMS!
					ext				: '.dms',
					shortDescUtil	: 'XDMS2Desc',
					longDescUtil	: 'XDMS2LongDesc',
				}
			]
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
						args		: [ 'e', '-o{extractPath}', '{archivePath}' ]	//	:TODO: should be 'x'?
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
				},

				Lha : {
					//
					//	'lha' command can be obtained from:
					//	* apt-get: lhasa
					//
					//	(compress not currently supported)
					//
					decompress		: {
						cmd			: 'lha',
						args		: [ '-efw={extractPath}', '{archivePath}' ],
					},
					list			: {
						cmd			: 'lha',
						args		: [ '-l', '{archivePath}' ],
						entryMatch	: '^[\\[a-z\\]]+(?:\\s+[0-9]+\\s+[0-9]+|\\s+)([0-9]+)\\s+[0-9]{2}\\.[0-9]\\%\\s+[A-Za-z]{3}\\s+[0-9]{1,2}\\s+[0-9]{4}\\s+([^\\r\\n]+)$',
					},
					extract			: {
						cmd			: 'lha',
						args		: [ '-efw={extractPath}', '{archivePath}', '{fileList}' ]
					}
				},

				Lzx : {
					//
					//	'unlzx' command can be obtained from:
					//	* Debian based: https://launchpad.net/~rzr/+archive/ubuntu/ppa/+build/2486127 (amd64/x86_64)
					//	* RedHat: https://fedora.pkgs.org/28/rpm-sphere/unlzx-1.1-4.1.x86_64.rpm.html
					//	* Source: http://xavprods.free.fr/lzx/
					//
					decompress		: {
						cmd			: 'unlzx',
						//	unzlx doesn't have a output dir option, but we'll cwd to the temp output dir first
						args		: [ '-x', '{archivePath}' ],
					},
					list			: {
						cmd			: 'unlzx',
						args		: [ '-v', '{archivePath}' ],
						entryMatch	: '^\\s+([0-9]+)\\s+[^\\s]+\\s+[0-9]{2}:[0-9]{2}:[0-9]{2}\\s+[0-9]{1,2}-[a-z]{3}-[0-9]{4}\\s+[a-z\\-]+\\s+\\"([^"]+)\\"$',
					}
				},

				Arj : {
					//
					//	'arj' command can be obtained from:
					//	* apt-get: arj
					//
					decompress		: {
						cmd			: 'arj',
						args		: [ 'x', '{archivePath}', '{extractPath}' ],
					},
					list			: {
						cmd				: 'arj',
						args			: [ 'l', '{archivePath}' ],
						entryMatch		: '^([^\\s]+)\\s+([0-9]+)\\s+[0-9]+\\s[0-9\\.]+\\s+[0-9]{2}\\-[0-9]{2}\\-[0-9]{2}\\s[0-9]{2}\\:[0-9]{2}\\:[0-9]{2}\\s+(?:[^\\r\\n]+)$',
						entryGroupOrder	: {	//	defaults to { byteSize : 1, fileName : 2 }
							fileName	: 1,
							byteSize	: 2,
						}
					},
					extract			: {
						cmd			: 'arj',
						args		: [ 'e', '{archivePath}', '{extractPath}', '{fileList}' ],
					}
				},

				Rar : {
					decompress		: {
						cmd			: 'unrar',
						args		: [ 'x', '{archivePath}', '{extractPath}' ],
					},
					list			: {
						cmd			: 'unrar',
						args		: [ 'l', '{archivePath}' ],
						entryMatch	: '^\\s+[\\.A-Z]+\\s+([\\d]+)\\s{2}[0-9]{2}\\-[0-9]{2}\\-[0-9]{2}\\s[0-9]{2}\\:[0-9]{2}\\s{2}([^\\r\\n]+)$',
					},
					extract			: {
						cmd			: 'unrar',
						args		: [ 'e', '{archivePath}', '{extractPath}', '{fileList}' ],
					}
				},

				TarGz : {
					decompress		: {
						cmd			: 'tar',
						args		: [ '-xf', '{archivePath}', '-C', '{extractPath}', '--strip-components=1' ],
					},
					list			: {
						cmd			: 'tar',
						args		: [ '-tvf', '{archivePath}' ],
						entryMatch	: '^[drwx\\-]{10}\\s[A-Za-z0-9\\/]+\\s+([0-9]+)\\s[0-9]{4}\\-[0-9]{2}\\-[0-9]{2}\\s[0-9]{2}\\:[0-9]{2}\\s([^\\r\\n]+)$',
					},
					extract			: {
						cmd			: 'tar',
						args		: [ '-xvf', '{archivePath}', '-C', '{extractPath}', '{fileList}' ],
					}
				}
			},
		},

		fileTransferProtocols : {
			//
			//	See http://www.synchro.net/docs/sexyz.txt for information on SEXYZ
			//
			zmodem8kSexyz : {
				name		: 'ZModem 8k (SEXYZ)',
				type		: 'external',
				sort		: 1,
				external	: {
					//	:TODO: Look into shipping sexyz binaries or at least hosting them somewhere for common systems
					sendCmd				: 'sexyz',
					sendArgs			: [ '-telnet', '-8', 'sz', '@{fileListPath}' ],
					recvCmd				: 'sexyz',
					recvArgs			: [ '-telnet', '-8', 'rz', '{uploadDir}' ],
					recvArgsNonBatch	: [ '-telnet', '-8', 'rz', '{fileName}' ],
				}
			},

			xmodemSexyz : {
				name		: 'XModem (SEXYZ)',
				type		: 'external',
				sort		: 3,
				external	: {
					sendCmd				: 'sexyz',
					sendArgs			: [ '-telnet', 'sX', '@{fileListPath}' ],
					recvCmd				: 'sexyz',
					recvArgsNonBatch	: [ '-telnet', 'rC', '{fileName}' ]
				}
			},

			ymodemSexyz : {
				name		: 'YModem (SEXYZ)',
				type		: 'external',
				sort		: 4,
				external	: {
					sendCmd				: 'sexyz',
					sendArgs			: [ '-telnet', 'sY', '@{fileListPath}' ],
					recvCmd				: 'sexyz',
					recvArgs			: [ '-telnet', 'ry', '{uploadDir}' ],
				}
			},

			zmodem8kSz : {
				name		: 'ZModem 8k',
				type		: 'external',
				sort		: 2,
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
						name					: 'Private Mail',
						desc					: 'Private user to user mail/email',
						maxExternalSentAgeDays	: 30,	//	max external "outbox" item age
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
					outbound		: paths.join(__dirname, './../mail/ftn_out/'),
					inbound			: paths.join(__dirname, './../mail/ftn_in/'),
					secInbound		: paths.join(__dirname, './../mail/ftn_secin/'),
					reject			: paths.join(__dirname, './../mail/reject/'),	//	bad pkt, bundles, TIC attachments that fail any check, etc.
					//outboundNetMail	: paths.join(__dirname, './../mail/ftn_netmail_out/'),
					//	set 'retain' to a valid path to keep good pkt files
				},

				//
				//	Packet and (ArcMail) bundle target sizes are just that: targets.
				//	Actual sizes may be slightly larger when we must place a full
				//	PKT contents *somewhere*
				//
				packetTargetByteSize	: 512000,		//	512k, before placing messages in a new pkt
				bundleTargetByteSize	: 2048000,		//	2M, before creating another archive
				packetMsgEncoding		: 'utf8',		//	default packet encoding. Override per node if desired.
				packetAnsiMsgEncoding	: 'cp437',		//	packet encoding for *ANSI ART* messages

				tic : {
					secureInOnly	: true,				//	only bring in from secure inbound (|secInbound| path, password protected)
					uploadBy		: 'ENiGMA TIC',		//	default upload by username (override @ network)
					allowReplace	: false,			//	use "Replaces" TIC field
					descPriority	: 'diz',			//	May be diz=.DIZ/etc., or tic=from TIC Ldesc
				}
			}
		},

		fileBase: {
			//	areas with an explicit |storageDir| will be stored relative to |areaStoragePrefix|:
			areaStoragePrefix	: paths.join(__dirname, './../file_base/'),

			maxDescFileByteSize			: 471859,	//	~1/4 MB
			maxDescLongFileByteSize		: 524288,	//	1/2 MB

			fileNamePatterns: {
				//	These are NOT case sensitive
				//	FILE_ID.DIZ - https://en.wikipedia.org/wiki/FILE_ID.DIZ
				//	Some groups include a FILE_ID.ANS. We try to use that over FILE_ID.DIZ if available.
				desc		: [
					'^[^/\]*FILE_ID\.ANS$', '^[^/\]*FILE_ID\.DIZ$', '^[^/\]*DESC\.SDI$', '^[^/\]*DESCRIPT\.ION$', '^[^/\]*FILE\.DES$', '^[^/\]*FILE\.SDI$', '^[^/\]*DISK\.ID$'	//	eslint-disable-line no-useless-escape
				],

				//	common README filename - https://en.wikipedia.org/wiki/README
				descLong		: [
					'^[^/\]*\.NFO$', '^[^/\]*README\.1ST$', '^[^/\]*README\.NOW$', '^[^/\]*README\.TXT$', '^[^/\]*READ\.ME$', '^[^/\]*README$', '^[^/\]*README\.md$'	//	eslint-disable-line no-useless-escape
				],
			},

			yearEstPatterns: [
				//
				//	Patterns should produce the year in the first submatch.
				//	The extracted year may be YY or YYYY
				//
				'\\b((?:[1-2][0-9][0-9]{2}))[\\-\\/\\.][0-3]?[0-9][\\-\\/\\.][0-3]?[0-9]\\b',	//	yyyy-mm-dd, yyyy/mm/dd, ...
				'\\b[0-3]?[0-9][\\-\\/\\.][0-3]?[0-9][\\-\\/\\.]((?:[1-2][0-9][0-9]{2}))\\b',	//	mm/dd/yyyy, mm.dd.yyyy, ...
				'\\b((?:[1789][0-9]))[\\-\\/\\.][0-3]?[0-9][\\-\\/\\.][0-3]?[0-9]\\b',			//	yy-mm-dd, yy-mm-dd, ...
				'\\b[0-3]?[0-9][\\-\\/\\.][0-3]?[0-9][\\-\\/\\.]((?:[1789][0-9]))\\b',			//	mm-dd-yy, mm/dd/yy, ...
				//'\\b((?:[1-2][0-9][0-9]{2}))[\\-\\/\\.][0-3]?[0-9][\\-\\/\\.][0-3]?[0-9]|[0-3]?[0-9][\\-\\/\\.][0-3]?[0-9][\\-\\/\\.]((?:[0-9]{2})?[0-9]{2})\\b',	//	yyyy-mm-dd, m/d/yyyy, mm-dd-yyyy, etc.
				//"\\b('[1789][0-9])\\b",	//	eslint-disable-line quotes
				'\\b[0-3]?[0-9][\\-\\/\\.](?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|may|june|july|august|september|october|november|december)[\\-\\/\\.]((?:[0-9]{2})?[0-9]{2})\\b',
				'\\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|may|june|july|august|september|october|november|december),?\\s[0-9]+(?:st|nd|rd|th)?,?\\s((?:[0-9]{2})?[0-9]{2})\\b',	//	November 29th, 1997
				'\\(((?:19|20)[0-9]{2})\\)',	//	(19xx) or (20xx) -- with parens -- do this before 19xx 20xx such that this has priority
				'\\b((?:19|20)[0-9]{2})\\b',	//	simple 19xx or 20xx with word boundaries
				'\\b\'([17-9][0-9])\\b',		//	'95, '17, ...
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
				sys_msg_attach		: 'sys_msg_attach',
				sys_temp_download	: 'sys_temp_download',
			},

			areas: {
				system_message_attachment : {
					name		: 'System Message Attachments',
					desc		: 'File attachments to messages',
					storageTags	: [ 'sys_msg_attach' ],
				},

				system_temporary_download : {
					name		: 'System Temporary Downloads',
					desc		: 'Temporary downloadables',
					storageTags	: [ 'sys_temp_download' ],
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
				},

				updateFileAreaStats : {
					schedule	: 'every 1 hours',
					action		: '@method:core/file_base_area.js:updateAreaStatsScheduledEvent',
				},

				forgotPasswordMaintenance : {
					schedule	: 'every 24 hours',
					action		: '@method:core/web_password_reset.js:performMaintenanceTask',
					args		: [ '24 hours' ]	//	items older than this will be removed
				},

				//
				//	Enable the following entry in your config.hjson to periodically create/update
				//	DESCRIPT.ION files for your file base
				//
				/*
				updateDescriptIonFiles : {
					schedule	: 'on the last day of the week',
					action		: '@method:core/file_base_list_export.js:updateFileBaseDescFilesScheduledEvent',
				}
				*/
			}
		},

		misc : {
			preAuthIdleLogoutSeconds	: 60 * 3,	//	3m
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
