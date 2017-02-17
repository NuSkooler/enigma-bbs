/* jslint node: true */
/* eslint-disable no-console */
'use strict';

//	ENiGMA½
const resolvePath				= require('../../core/misc_util.js').resolvePath;
const printUsageAndSetExitCode	= require('./oputil_common.js').printUsageAndSetExitCode;
const ExitCodes					= require('./oputil_common.js').ExitCodes;
const argv						= require('./oputil_common.js').argv;
const getDefaultConfigPath		= require('./oputil_common.js').getDefaultConfigPath;
const getHelpFor				= require('./oputil_help.js').getHelpFor;

//	deps
const async			= require('async');
const inq			= require('inquirer');
const mkdirsSync	= require('fs-extra').mkdirsSync;
const fs			= require('fs');
const hjson			= require('hjson');
const paths			= require('path');

exports.handleConfigCommand				= handleConfigCommand;


function getAnswers(questions, cb) {
	inq.prompt(questions).then( answers => {
		return cb(answers);
	});
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
						name	: 'Another Sample Conference',
						desc	: 'Another conf sample. Change me!',

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
		return printUsageAndSetExitCode(getHelpFor('Config'), ExitCodes.ERROR);
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
		return printUsageAndSetExitCode(getHelpFor('Config'), ExitCodes.ERROR);
	}	
}
