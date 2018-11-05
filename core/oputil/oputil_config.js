/* jslint node: true */
/* eslint-disable no-console */
'use strict';

//	ENiGMA½
const resolvePath				= require('../../core/misc_util.js').resolvePath;
const printUsageAndSetExitCode	= require('./oputil_common.js').printUsageAndSetExitCode;
const ExitCodes					= require('./oputil_common.js').ExitCodes;
const argv						= require('./oputil_common.js').argv;
const getConfigPath				= require('./oputil_common.js').getConfigPath;
const getHelpFor				= require('./oputil_help.js').getHelpFor;
const initConfigAndDatabases	= require('./oputil_common.js').initConfigAndDatabases;
const Errors					= require('../../core/enig_error.js').Errors;

//	deps
const async			= require('async');
const inq			= require('inquirer');
const mkdirsSync	= require('fs-extra').mkdirsSync;
const fs			= require('graceful-fs');
const hjson			= require('hjson');
const paths			= require('path');
const _				= require('lodash');

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
                        rotatingFile : {
                            level : answers.loggingLevel,
                        }
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

function writeConfig(config, path) {
    config = hjson.stringify(config, { bracesSameLine : true, spaces : '\t', keepWsc : true, quotes : 'strings' } );

    try {
        fs.writeFileSync(path, config, 'utf8');
        return true;
    } catch(e) {
        return false;
    }
}

function buildNewConfig() {
    askNewConfigQuestions( (err, configPath, config) => {
        if(err) {
            return;
        }

        if(writeConfig(config, configPath)) {
            console.info('Configuration generated');
        } else {
            console.error('Failed writing configuration');
        }
    });
}

function validateUplinks(uplinks) {
    const ftnAddress = require('../../core/ftn_address.js');
    const valid = uplinks.every(ul => {
        const addr = ftnAddress.fromString(ul);
        return addr;
    });
    return valid;
}

function getMsgAreaImportType(path) {
    if(argv.type) {
        return argv.type.toLowerCase();
    }

    const ext = paths.extname(path).toLowerCase().substr(1);
    return ext;	//	.bbs|.na|...
}

function importAreas() {
    const importPath = argv._[argv._.length - 1];
    if(argv._.length < 3 || !importPath || 0 === importPath.length) {
        return printUsageAndSetExitCode(getHelpFor('Config'), ExitCodes.ERROR);
    }

    const importType = getMsgAreaImportType(importPath);
    if('na' !== importType && 'bbs' !== importType) {
        return console.error(`"${importType}" is not a recognized import file type`);
    }

    //	optional data - we'll prompt if for anything not found
    let confTag		= argv.conf;
    let networkName	= argv.network;
    let uplinks		= argv.uplinks;
    if(uplinks) {
        uplinks = uplinks.split(/[\s,]+/);
    }

    let importEntries;

    async.waterfall(
        [
            function readImportFile(callback) {
                fs.readFile(importPath, 'utf8', (err, importData) => {
                    if(err) {
                        return callback(err);
                    }

                    importEntries = getImportEntries(importType, importData);
                    if(0 === importEntries.length) {
                        return callback(Errors.Invalid('Invalid or empty import file'));
                    }

                    //	We should have enough to validate uplinks
                    if('bbs' === importType) {
                        for(let i = 0; i < importEntries.length; ++i) {
                            if(!validateUplinks(importEntries[i].uplinks)) {
                                return callback(Errors.Invalid('Invalid uplink(s)'));
                            }
                        }
                    } else {
                        if(!validateUplinks(uplinks)) {
                            return callback(Errors.Invalid('Invalid uplink(s)'));
                        }
                    }

                    return callback(null);
                });
            },
            function init(callback) {
                return initConfigAndDatabases(callback);
            },
            function validateAndCollectInput(callback) {
                const msgArea	= require('../../core/message_area.js');
                const sysConfig	= require('../../core/config.js').get();

                let msgConfs = msgArea.getSortedAvailMessageConferences(null, { noClient : true } );
                if(!msgConfs) {
                    return callback(Errors.DoesNotExist('No conferences exist in your configuration'));
                }

                msgConfs = msgConfs.map(mc => {
                    return {
                        name	: mc.conf.name,
                        value	: mc.confTag,
                    };
                });

                if(confTag && !msgConfs.find(mc => {
                    return confTag === mc.value;
                }))
                {
                    return callback(Errors.DoesNotExist(`Conference "${confTag}" does not exist`));
                }

                let existingNetworkNames = [];
                if(_.has(sysConfig, 'messageNetworks.ftn.networks')) {
                    existingNetworkNames = Object.keys(sysConfig.messageNetworks.ftn.networks);
                }

                if(0 === existingNetworkNames.length) {
                    return callback(Errors.DoesNotExist('No FTN style networks exist in your configuration'));
                }

                if(networkName && !existingNetworkNames.find(net => networkName === net)) {
                    return callback(Errors.DoesNotExist(`FTN style Network "${networkName}" does not exist`));
                }

                getAnswers([
                    {
                        name		: 'confTag',
                        message		: 'Message conference:',
                        type		: 'list',
                        choices		: msgConfs,
                        pageSize	: 10,
                        when		: !confTag,
                    },
                    {
                        name		: 'networkName',
                        message		: 'Network name:',
                        type		: 'list',
                        choices		: existingNetworkNames,
                        when		: !networkName,
                    },
                    {
                        name		: 'uplinks',
                        message		: 'Uplink(s) (comma separated):',
                        type		: 'input',
                        validate	: (input) => {
                            const inputUplinks = input.split(/[\s,]+/);
                            return validateUplinks(inputUplinks) ? true : 'Invalid uplink(s)';
                        },
                        when		: !uplinks && 'bbs' !== importType,
                    }
                ],
                answers => {
                    confTag			= confTag || answers.confTag;
                    networkName		= networkName || answers.networkName;
                    uplinks			= uplinks || answers.uplinks;

                    importEntries.forEach(ie => {
                        ie.areaTag = ie.ftnTag.toLowerCase();
                    });

                    return callback(null);
                });
            },
            function confirmWithUser(callback) {
                const sysConfig	= require('../../core/config.js').get();

                console.info(`Importing the following for "${confTag}" - (${sysConfig.messageConferences[confTag].name} - ${sysConfig.messageConferences[confTag].desc})`);
                importEntries.forEach(ie => {
                    console.info(`  ${ie.ftnTag} - ${ie.name}`);
                });

                console.info('');
                console.info('Importing will NOT create required FTN network configurations.');
                console.info('If you have not yet done this, you will need to complete additional steps after importing.');
                console.info('See docs/msg_networks.md for details.');
                console.info('');

                getAnswers([
                    {
                        name	: 'proceed',
                        message	: 'Proceed?',
                        type	: 'confirm',
                    }
                ],
                answers => {
                    return callback(answers.proceed ? null : Errors.General('User canceled'));
                });

            },
            function loadConfigHjson(callback) {
                const configPath = getConfigPath();
                fs.readFile(configPath, 'utf8', (err, confData) => {
                    if(err) {
                        return callback(err);
                    }

                    let config;
                    try {
                        config = hjson.parse(confData, { keepWsc : true } );
                    } catch(e) {
                        return callback(e);
                    }
                    return callback(null, config);

                });
            },
            function performImport(config, callback) {
                const confAreas = { messageConferences : {} };
                confAreas.messageConferences[confTag] = { areas : {} };

                const msgNetworks = { messageNetworks : { ftn : { areas : {} } } };

                importEntries.forEach(ie => {
                    const specificUplinks = ie.uplinks || uplinks;	//	AREAS.BBS has specific uplinks per area

                    confAreas.messageConferences[confTag].areas[ie.areaTag] = {
                        name : ie.name,
                        desc : ie.name,
                    };

                    msgNetworks.messageNetworks.ftn.areas[ie.areaTag] = {
                        network	: networkName,
                        tag		: ie.ftnTag,
                        uplinks	: specificUplinks
                    };
                });


                const newConfig = _.defaultsDeep(config, confAreas, msgNetworks);
                const configPath = getConfigPath();

                if(!writeConfig(newConfig, configPath)) {
                    return callback(Errors.UnexpectedState('Failed writing configuration'));
                }

                return callback(null);
            }
        ],
        err => {
            if(err) {
                console.error(err.reason ? err.reason : err.message);
            } else {
                const addFieldUpd = 'bbs' === importType ? '"name" and "desc"' : '"desc"';
                console.info('Configuration generated.');
                console.info(`You may wish to validate changes made to ${getConfigPath()}`);
                console.info(`as well as update ${addFieldUpd} fields, sorting, etc.`);
                console.info('');
            }
        }
    );

}

function getImportEntries(importType, importData) {
    let importEntries = [];

    if('na' === importType) {
        //
        //	parse out
        //	TAG		DESC
        //
        const re = /^([^\s]+)\s+([^\r\n]+)/gm;
        let m;

        while( (m = re.exec(importData) )) {
            importEntries.push({
                ftnTag		: m[1],
                name		: m[2],
            });
        }
    } else if ('bbs' === importType) {
        //
        //	Various formats for AREAS.BBS seem to exist. We want to support as much as possible.
        //
        //	SBBS http://www.synchro.net/docs/sbbsecho.html#AREAS.BBS
        //	CODE	TAG		UPLINKS
        //
        //	VADV https://www.vadvbbs.com/products/vadv/support/docs/docs_vfido.php#AREAS.BBS
        //	TAG		UPLINKS
        //
        //	Misc
        //	PATH|OTHER	TAG		UPLINKS
        //
        //	Assume the second item is TAG and 1:n UPLINKS (space and/or comma sep) after (at the end)
        //
        const re = /^[^\s]+\s+([^\s]+)\s+([^\n]+)$/gm;
        let m;
        while ( (m = re.exec(importData) )) {
            const tag = m[1];

            importEntries.push({
                ftnTag		: tag,
                name		: `Area: ${tag}`,
                uplinks		: m[2].split(/[\s,]+/),
            });
        }
    }

    return importEntries;
}

function handleConfigCommand() {
    if(true === argv.help) {
        return printUsageAndSetExitCode(getHelpFor('Config'), ExitCodes.ERROR);
    }

    const action = argv._[1];

    switch(action) {
        case 'new' 			: return buildNewConfig();
        case 'import-areas' : return importAreas();

        default : return printUsageAndSetExitCode(getHelpFor('Config'), ExitCodes.ERROR);
    }
}
