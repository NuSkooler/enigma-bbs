/* jslint node: true */
/* eslint-disable no-console */
'use strict';

//	ENiGMA½
const resolvePath				= require('../../core/misc_util.js').resolvePath;
const {
    printUsageAndSetExitCode,
    getConfigPath,
    argv,
    ExitCodes,
    getAnswers,
    writeConfig,
    HJSONStringifyCommonOpts,
}                               = require('./oputil_common.js');
const getHelpFor				= require('./oputil_help.js').getHelpFor;

//	deps
const async			    = require('async');
const inq			    = require('inquirer');
const mkdirsSync	    = require('fs-extra').mkdirsSync;
const fs			    = require('graceful-fs');
const hjson			    = require('hjson');
const paths			    = require('path');
const _				    = require('lodash');
const sanatizeFilename  = require('sanitize-filename');

exports.handleConfigCommand				= handleConfigCommand;

const ConfigIncludeKeys = [
    'theme',
    'users.preAuthIdleLogoutSeconds', 'users.idleLogoutSeconds',
    'users.newUserNames', 'users.failedLogin', 'users.unlockAtEmailPwReset',
    'paths.logs',
    'loginServers',
    'contentServers',
    'fileBase.areaStoragePrefix',
    'logging.rotatingFile',
];

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
            default	: getConfigPath(),
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
                        return callback(answers.overwriteConfig ? null : 'exit');
                    });
                } else {
                    return callback(null);
                }
            },
            function basic(callback) {
                getAnswers(QUESTIONS.Basic, answers => {
                    const defaultConfig = require('../../core/config_default')();

                    //  start by plopping in values we want directly from config.js
                    const template = hjson.rt.parse(fs.readFileSync(paths.join(__dirname, '../../misc/config_template.in.hjson'), 'utf8'));

                    const direct = {};
                    _.each(ConfigIncludeKeys, keyPath => {
                        _.set(direct, keyPath, _.get(defaultConfig, keyPath));
                    });

                    config = _.mergeWith(template, direct);

                    //  we can override/add to it based on user input from this point on...
                    config.general.boardName = answers.boardName;

                    return callback(null);
                });
            },
            function msgConfAndArea(callback) {
                getAnswers(QUESTIONS.MessageConfAndArea, answers => {
                    const confName	= makeMsgConfAreaName(answers.msgConfName);
                    const areaName	= makeMsgConfAreaName(answers.msgAreaName);

                    config.messageConferences[confName] = {
                        name	: answers.msgConfName,
                        desc	: answers.msgConfDesc,
                        sort	: 1,
                        default	: true,
                    };

                    config.messageConferences[confName].areas = {};
                    config.messageConferences[confName].areas[areaName] = {
                        name	: answers.msgAreaName,
                        desc	: answers.msgAreaDesc,
                        sort	: 1,
                        default	: true,
                    };

                    return callback(null);
                });
            },
            function misc(callback) {
                getAnswers(QUESTIONS.Misc, answers => {
                    config.logging.rotatingFile.level = answers.loggingLevel;

                    return callback(null);
                });
            }
        ],
        err => {
            return cb(err, configPath, config);
        }
    );
}

const copyFileSyncSilent = (to, from, flags) => {
    try {
        fs.copyFileSync(to, from, flags);
    } catch(e) {
        /* absorb! */
    }
};

function buildNewConfig() {
    askNewConfigQuestions( (err, configPath, config) => {
        if(err) {            return;
        }

        const boardName = sanatizeFilename(config.general.boardName)
            .replace(/[^a-z0-9_-]/ig, '_')
            .replace(/_+/g, '_')
            .toLowerCase();
        const menuFile = `menus/${boardName}-main.hjson`;

        const mainTemplate = hjson.rt.parse(fs.readFileSync(paths.join(__dirname, '../../misc/menu_templates/main.in.hjson'), 'utf8'));

        const includeFiles = [
            'message_base.in.hjson',
            'private_mail.in.hjson',
            'login.in.hjson',
            'new_user.in.hjson',
            'doors.in.hjson',
            'file_base.in.hjson',
        ];

        includeFiles.forEach(incFile => {
            const outName = `${boardName}-${incFile.replace('.in', '')}`;
            copyFileSyncSilent(
                paths.join(__dirname, '../../misc/menu_templates', incFile),
                paths.join(__dirname, '../../config/menus', outName),
                fs.constants.COPYFILE_EXCL
            );
        });

        mainTemplate.includes = includeFiles.map(incFile => {
            return `${boardName}-${incFile.replace('.in', '')}`;
        });

        if (writeConfig(
            mainTemplate,
            paths.join(__dirname, '../../config/menus', `${boardName}-main.hjson`)))
        {
            config.general.menuFile = menuFile;

            if(writeConfig(config, configPath)) {
                console.info('Configuration generated');
            } else {
                console.error('Failed writing configuration');
            }
        } else {
            console.error('Failed writing configuration');
        }
    });
}

function catCurrentConfig() {
    try {
        const config    = hjson.rt.parse(fs.readFileSync(getConfigPath(), 'utf8'));
        const hjsonOpts = Object.assign({}, HJSONStringifyCommonOpts, {
            colors  : false === argv.colors ? false : true,
            keepWsc : false === argv.comments ? false : true,
        });

        console.log(hjson.stringify(config, hjsonOpts));
    } catch(e) {
        if('ENOENT' == e.code) {
            console.error(`File not found: ${getConfigPath()}`);
        } else {
            console.error(e);
        }
    }
}

function handleConfigCommand() {
    if(true === argv.help) {
        return printUsageAndSetExitCode(getHelpFor('Config'), ExitCodes.ERROR);
    }

    const action = argv._[1];

    switch(action) {
        case 'new'  : return buildNewConfig();
        case 'cat'  : return catCurrentConfig();

        default : return printUsageAndSetExitCode(getHelpFor('Config'), ExitCodes.ERROR);
    }
}
