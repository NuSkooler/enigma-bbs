#!/usr/bin/env node

/* jslint node: true */
/* eslint-disable no-console */
'use strict';

//	ENiGMA½
const config		= require('./core/config.js');
const db			= require('./core/database.js');
const resolvePath	= require('./core/misc_util.js').resolvePath;

//	deps
const _				= require('lodash');
const async			= require('async');
const inq			= require('inquirer');
const mkdirsSync	= require('fs-extra').mkdirsSync;
const fs			= require('fs');
const hjson			= require('hjson');
const paths			= require('path');

const argv 			= require('minimist')(process.argv.slice(2));

const ExitCodes = {
	SUCCESS		: 0,
	ERROR		: -1,
	BAD_COMMAND	: -2,
	BAD_ARGS	: -3,
};

const USAGE_HELP = {
	General :
`usage: optutil.js [--version] [--help]
                   <command> [<args>]

global args:
  --config PATH         : specify config path (${getDefaultConfigPath()})

commands:
  user                  : user utilities
  config                : config file management
  file-base             : file base management

`,
	User : 
`usage: optutil.js user --user USERNAME <args>

valid args:
  --user USERNAME       : specify username for further actions
  --password PASS       : set new password 
  --delete              : delete user
  --activate            : activate user
  --deactivate          : deactivate user
`,

	Config : 
`usage: optutil.js config <args>

valid args:
  --new                 : generate a new/initial configuration
`,
	FileBase :
`usage: oputil.js file-base <args>

valid args:
  --scan AREA_TAG       : (re)scan area specified by AREA_TAG for new files
`
};

function printUsageAndSetExitCode(command, exitCode) {
	if(_.isUndefined(exitCode)) {
		exitCode = ExitCodes.ERROR;
	}
	process.exitCode = exitCode;
	const errMsg = USAGE_HELP[command];
	if(errMsg) {
		console.error(errMsg);
	}
}

function initConfig(cb) {
	const configPath = argv.config ? argv.config : config.getDefaultPath();

	config.init(configPath, cb);
}

function initConfigAndDatabases(cb) {
	async.series(
		[
			function init(callback) {
				initConfig(callback);
			},
			function initDb(callback) {
				db.initializeDatabases(callback);
			},
		],
		err => {
			return cb(err);
		}
	);
}

function getUser(userName, cb) {
	const user = require('./core/user.js');
	user.getUserIdAndName(argv.user, function userNameAndId(err, userId) {
		if(err) {
			process.exitCode = ExitCodes.BAD_ARGS;
			return cb(new Error('Failed to retrieve user'));
		} else {
			let u = new user.User();
			u.userId = userId;
			return cb(null, u);
		}
	});	
}

function initAndGetUser(userName, cb) {
	async.waterfall(
		[
			function init(callback) {
				initConfigAndDatabases(callback);
			},
			function getUserObject(callback) {
				getUser(argv.user, (err, user) => {
					if(err) {
						process.exitCode = ExitCodes.BAD_ARGS;
						return callback(err);
					}
					return callback(null, user);
				});
			} 
		],
		(err, user) => {
			return cb(err, user);
		}
	);
}

function setAccountStatus(userName, active) {
	async.waterfall(
		[
			function init(callback) {
				initAndGetUser(argv.user, callback);
			},
			function activateUser(user, callback) {
				const AccountStatus = require('./core/user.js').User.AccountStatus;
				user.persistProperty('account_status', active ? AccountStatus.active : AccountStatus.inactive, callback);
			}
		],
		err => {
			if(err) {
				console.error(err.message);
			} else {
				console.info('User ' + ((true === active) ? 'activated' : 'deactivated'));
			}
		}
	);	
}

function handleUserCommand() {
	if(true === argv.help || !_.isString(argv.user) || 0 === argv.user.length) {
		return printUsageAndSetExitCode('User', ExitCodes.ERROR);
	}

	if(_.isString(argv.password)) {
		if(0 === argv.password.length) {			
			process.exitCode = ExitCodes.BAD_ARGS;
			return console.error('Invalid password');
		}

		async.waterfall(
			[
				function init(callback) {
					initAndGetUser(argv.user, callback);
				},
				function setNewPass(user, callback) {
					user.setNewAuthCredentials(argv.password, function credsSet(err) {
						if(err) {
							process.exitCode = ExitCodes.ERROR;
							callback(new Error('Failed setting password'));
						} else {
							callback(null);
						}
					});
				}
			],
			function complete(err) {
				if(err) {
					console.error(err.message);
				} else {
					console.info('Password set');
				}
			}
		);
	} else if(argv.activate) {
		setAccountStatus(argv.user, true);		
	} else if(argv.deactivate) {
		setAccountStatus(argv.user, false);
	}
}

function getAnswers(questions, cb) {
	inq.prompt(questions).then( answers => {
		return cb(answers);
	});
}

function getDefaultConfigPath() {
	return resolvePath('~/.config/enigma-bbs/config.hjson');
}

const QUESTIONS = {
	Intro		: [
		{
			name	: 'createNewConfig',
			message	: 'Create a new configuration?',
			type	: 'confirm',
			default	: false,
		},
		{
			name	: 'configPath',
			message	: 'Configuration path:',
			default	: argv.config ? argv.config : getDefaultConfigPath(),
			when	: answers => answers.createNewConfig
		},	
	],
	
	OverwriteConfig	: [
		{
			name	: 'overwriteConfig',
			message	: 'Config file exists. Overwrite?',
			type	: 'confirm',
			default	: false,
		}
	],
	
	Basic			: [
		{
			name	: 'boardName',
			message	: 'BBS name:',
			default	: 'New ENiGMA½ BBS',
		},
	],
	
	Misc		: [
		{
			name	: 'loggingLevel',
			message	: 'Logging level:',
			type	: 'list',
			choices	: [ 'Error', 'Warn', 'Info', 'Debug', 'Trace' ],
			default	: 2,
			filter	: s => s.toLowerCase(),
		},
		{
			name	: 'sevenZipExe',
			message	: '7-Zip executable:',
			type	: 'list',
			choices	: [ '7z', '7za', 'None' ]
		}
	],
	
	MessageConfAndArea	: [
		{
			name	: 'msgConfName',
			message	: 'First message conference:',
			default	: 'Local',
		},
		{
			name	: 'msgConfDesc',
			message	: 'Conference description:',
			default	: 'Local Areas',	
		},
		{
			name	: 'msgAreaName',
			message	: 'First area in message conference:',
			default	: 'General',
		},
		{
			name	: 'msgAreaDesc',
			message	: 'Area description:',
			default	: 'General chit-chat',
		}
	]
};

function makeMsgConfAreaName(s) {
	return s.toLowerCase().replace(/\s+/g, '_');
}

function askNewConfigQuestions(cb) {
	
	const ui = new inq.ui.BottomBar();
	
	let configPath;
	let config;
	
	async.waterfall(
		[
			function intro(callback) {
				getAnswers(QUESTIONS.Intro, answers => {
					if(!answers.createNewConfig) {
						return callback('exit');
					}
					
					//	adjust for ~ and the like
					configPath = resolvePath(answers.configPath);
					
					const configDir = paths.dirname(configPath);
					mkdirsSync(configDir);
					
					//
					//	Check if the file exists and can be written to
					//
					fs.access(configPath, fs.F_OK | fs.W_OK, err => {
						if(err) {
							if('EACCES' === err.code) {
								ui.log.write(`${configPath} cannot be written to`);
								callback('exit');
							} else if('ENOENT' === err.code) {
								callback(null, false);
							}	
						} else {
							callback(null, true);	//	exists + writable
						}
					});
				});
			},
			function promptOverwrite(needPrompt, callback) {		
				if(needPrompt) {
					getAnswers(QUESTIONS.OverwriteConfig, answers => {
						callback(answers.overwriteConfig ? null : 'exit');
					});
				} else {
					callback(null);
				}
			},
			function basic(callback) {				
				getAnswers(QUESTIONS.Basic, answers => {
					config = {
						general : {
							boardName : answers.boardName,
						},
					};
					
					callback(null);
				});
			},
			function msgConfAndArea(callback) {
				getAnswers(QUESTIONS.MessageConfAndArea, answers => {
					config.messageConferences = {};
					
					const confName	= makeMsgConfAreaName(answers.msgConfName);
					const areaName	= makeMsgConfAreaName(answers.msgAreaName);
					
					config.messageConferences[confName] = {
						name	: answers.msgConfName,
						desc	: answers.msgConfDesc,
						sort	: 1,
						default	: true,
					};
					
					config.messageConferences.another_sample_conf = {
						name	: 'Another Sample Conference',
						desc	: 'Another conference example. Change me!',
						sort	: 2,	
					};
					
					config.messageConferences[confName].areas = {};
					config.messageConferences[confName].areas[areaName] = {
						name	: answers.msgAreaName,
						desc	: answers.msgAreaDesc,
						sort	: 1,
						default	: true,	
					};
					
					config.messageConferences.another_sample_conf = {
						areas :  {
							another_sample_area : {
								name	: 'Another Sample Area',
								desc	: 'Another area example. Change me!',
								sort	: 2
							}
						}
					};
					
					callback(null);
				});
			},
			function misc(callback) {
				getAnswers(QUESTIONS.Misc, answers => {
					if('None' !== answers.sevenZipExe) {
						config.archivers = {
							zip : {
								compressCmd		: answers.sevenZipExe,
								decompressCmd	: answers.sevenZipExe,
							}
						};
					}
					
					config.logging = {
						level : answers.loggingLevel,
					};
					
					callback(null);
				});
			}
		],
		err => {
			cb(err, configPath, config);
		}
	);
}

function handleConfigCommand() {
	if(true === argv.help) {
		return printUsageAndSetExitCode('Config', ExitCodes.ERROR);
	}

	if(argv.new) {
		askNewConfigQuestions( (err, configPath, config) => {
			if(err) {								
				return;
			}
			
			config = hjson.stringify(config, { bracesSameLine : true, spaces : '\t' } );
			
			try {
				fs.writeFileSync(configPath, config, 'utf8');
				console.info('Configuration generated');
			} catch(e) {
				console.error('Exception attempting to create config: ' + e.toString());
			}
		});		
	} else {
		return printUsageAndSetExitCode('Config', ExitCodes.ERROR);
	}	
}

function fileAreaScan() {
	function scanFileIterator(stepInfo, nextScanStep) {
		if('start' === stepInfo.step) {
			console.info(`Scanning ${stepInfo.filePath}...`);
		}
		return nextScanStep(null);
		//	:TODO: add 'finished' step when avail
	}

	async.waterfall(
		[
			function init(callback) {
				return initConfigAndDatabases(callback);
			},
			function getFileArea(callback) {
				const fileAreaMod = require('./core/file_base_area.js');

				const areaInfo = fileAreaMod.getFileAreaByTag(argv.scan);
				if(!areaInfo) {
					return callback(new Error('Invalid file area'));
				}

				return callback(null, fileAreaMod, areaInfo);
			},
			function performScan(fileAreaMod, areaInfo, callback) {
				fileAreaMod.scanFileAreaForChanges(areaInfo, scanFileIterator, err => {
					return callback(err);
				});
			}
		],
		err => {
			if(err) {
				process.exitCode = ExitCodes.ERROR;
				console.error(err.message);
			}
		}
	);
}

function handleFileBaseCommand() {
	if(true === argv.help) {
		return printUsageAndSetExitCode('FileBase', ExitCodes.ERROR);
	}

	if(argv.scan) {
		return fileAreaScan(argv.scan);
	}
}

function main() {

	process.exitCode = ExitCodes.SUCCESS;

	if(true === argv.version) {
		return console.info(require('./package.json').version);
	}

	if(0 === argv._.length ||
		'help' === argv._[0])
	{
		printUsageAndSetExitCode('General', ExitCodes.SUCCESS);
	}

	switch(argv._[0]) {
		case 'user' :
			handleUserCommand();
			break;
			
		case 'config' :
			handleConfigCommand();
			break;

		case 'file-base' :
			handleFileBaseCommand();
			break;

		default:
			printUsageAndSetExitCode('', ExitCodes.BAD_COMMAND);
	}
}

main();