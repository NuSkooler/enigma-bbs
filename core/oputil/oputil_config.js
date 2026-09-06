/* jslint node: true */

'use strict';

//	ENiGMA½
const resolvePath = require('../../core/misc_util.js').resolvePath;
const {
    printUsageAndSetExitCode,
    getConfigPath,
    argv,
    ExitCodes,
    getAnswers,
    writeConfig,
    HJSONStringifyCommonOpts,
} = require('./oputil_common.js');
const getHelpFor = require('./oputil_help.js').getHelpFor;

//	deps
const async = require('async');
const inq = require('inquirer');
const mkdirsSync = require('fs-extra').mkdirsSync;
const fs = require('graceful-fs');
const hjson = require('hjson');
const paths = require('path');
const _ = require('lodash');
const sanatizeFilename = require('sanitize-filename');

exports.handleConfigCommand = handleConfigCommand;

//
//  Settings taken verbatim from config_default.js rather than left as a
//  XXXXX placeholder in misc/config_template.in.hjson. Exported so a test can
//  reproduce what "config new" writes without duplicating the list -- a copy
//  would drift, and the config it produces is the one thing the validator is
//  required never to complain about.
//
const ConfigIncludeKeys = [
    'theme',
    'users.preAuthIdleLogoutSeconds',
    'users.idleLogoutSeconds',
    'users.newUserNames',
    'users.failedLogin',
    'users.unlockAtEmailPwReset',
    'paths.logs',
    'loginServers',
    'contentServers',
    'fileBase.areaStoragePrefix',
    'logging.rotatingFile',
];

exports.ConfigIncludeKeys = ConfigIncludeKeys;

const QUESTIONS = {
    Intro: [
        {
            name: 'createNewConfig',
            message: 'Create a new configuration?',
            type: 'confirm',
            default: false,
        },
        {
            name: 'configPath',
            message: 'Configuration path:',
            default: getConfigPath(),
            when: answers => answers.createNewConfig,
        },
    ],

    OverwriteConfig: [
        {
            name: 'overwriteConfig',
            message: 'Config file exists. Overwrite?',
            type: 'confirm',
            default: false,
        },
    ],

    Basic: [
        {
            name: 'boardName',
            message: 'BBS name:',
            default: 'New ENiGMA½ BBS',
        },
    ],

    Misc: [
        {
            name: 'loggingLevel',
            message: 'Logging level:',
            type: 'list',
            choices: ['Error', 'Warn', 'Info', 'Debug', 'Trace'],
            default: 2,
            filter: s => s.toLowerCase(),
        },
    ],

    MessageConfAndArea: [
        {
            name: 'msgConfName',
            message: 'First message conference:',
            default: 'Local',
        },
        {
            name: 'msgConfDesc',
            message: 'Conference description:',
            default: 'Local Areas',
        },
        {
            name: 'msgAreaName',
            message: 'First area in message conference:',
            default: 'General',
        },
        {
            name: 'msgAreaDesc',
            message: 'Area description:',
            default: 'General chit-chat',
        },
    ],
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
                    if (!answers.createNewConfig) {
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
                        if (err) {
                            if ('EACCES' === err.code) {
                                ui.log.write(`${configPath} cannot be written to`);
                                callback('exit');
                            } else if ('ENOENT' === err.code) {
                                callback(null, false);
                            }
                        } else {
                            callback(null, true); //	exists + writable
                        }
                    });
                });
            },
            function promptOverwrite(needPrompt, callback) {
                if (needPrompt) {
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
                    const template = hjson.rt.parse(
                        fs.readFileSync(
                            paths.join(__dirname, '../../misc/config_template.in.hjson'),
                            'utf8'
                        )
                    );

                    const direct = {};
                    ConfigIncludeKeys.forEach(keyPath => {
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
                    const confName = makeMsgConfAreaName(answers.msgConfName);
                    const areaName = makeMsgConfAreaName(answers.msgAreaName);

                    config.messageConferences[confName] = {
                        name: answers.msgConfName,
                        desc: answers.msgConfDesc,
                        sort: 1,
                        default: true,
                    };

                    config.messageConferences[confName].areas = {};
                    config.messageConferences[confName].areas[areaName] = {
                        name: answers.msgAreaName,
                        desc: answers.msgAreaDesc,
                        sort: 1,
                        default: true,
                    };

                    return callback(null);
                });
            },
            function misc(callback) {
                getAnswers(QUESTIONS.Misc, answers => {
                    config.logging.rotatingFile.level = answers.loggingLevel;

                    return callback(null);
                });
            },
        ],
        err => {
            return cb(err, configPath, config);
        }
    );
}

const copyFileSyncSilent = (to, from, flags) => {
    try {
        fs.copyFileSync(to, from, flags);
    } catch (e) {
        /* absorb! */
        console.error(e);
    }
};

function buildNewConfig() {
    askNewConfigQuestions((err, configPath, config) => {
        if (err) {
            return err;
        }

        //  ensure 'menus' exists
        mkdirsSync(paths.join(__dirname, '../../config/menus'));

        const boardName = sanatizeFilename(config.general.boardName)
            .replace(/[^a-z0-9_-]/gi, '_')
            .replace(/_+/g, '_')
            .toLowerCase();

        const includeFilesIn = [
            'message_base.in.hjson',
            'private_mail.in.hjson',
            'login.in.hjson',
            'new_user.in.hjson',
            'doors.in.hjson',
            'file_base.in.hjson',
            'activitypub.in.hjson',
        ];

        let includeFiles = [];
        includeFilesIn.forEach(incFile => {
            const outName = `${boardName}-${incFile.replace('.in', '')}`;
            includeFiles.push(outName);

            copyFileSyncSilent(
                paths.join(__dirname, '../../misc/menu_templates', incFile),
                paths.join(__dirname, '../../config/menus', outName),
                fs.constants.COPYFILE_EXCL
            );
        });

        //  We really only need includes to be replaced
        const mainTemplate = fs
            .readFileSync(
                paths.join(__dirname, '../../misc/menu_templates/main.in.hjson'),
                'utf8'
            )
            .replace(/%INCLUDE_FILES%/g, includeFiles.join('\n\t\t')); //  cheesy, but works!

        const menuFile = `${boardName}-main.hjson`;
        fs.writeFileSync(
            paths.join(__dirname, '../../config/menus', menuFile),
            mainTemplate,
            'utf8'
        );

        config.general.menuFile = paths.join(__dirname, '../../config/menus/', menuFile);

        if (writeConfig(config, configPath)) {
            console.info('Configuration generated');
        } else {
            console.error('Failed writing configuration');
        }
    });
}

function catCurrentConfig() {
    try {
        const config = hjson.rt.parse(fs.readFileSync(getConfigPath(), 'utf8'));
        const hjsonOpts = Object.assign({}, HJSONStringifyCommonOpts, {
            colors: false === argv.colors ? false : true,
            keepWsc: false === argv.comments ? false : true,
        });

        if (argv.meow) {
            console.info(
                `    /\\_/\\
   ( o.o )
    > ^ < ... mrow...`
            );
            return;
        }

        console.log(hjson.stringify(config, hjsonOpts));
    } catch (e) {
        if ('ENOENT' == e.code) {
            console.error(`File not found: ${getConfigPath()}`);
        } else {
            console.error(e);
        }
    }
}

//
//  Check the configuration and say what is wrong with it, without starting
//  anything. A sysop wants to know *before* a restart, not from a log line
//  afterwards -- and unlike the boot time report, this one sets an exit code
//  so it is usable from a script or a systemd ExecStartPre.
//
//  Deliberately uses initConfig() rather than initConfigAndDatabases(): a
//  broken configuration is exactly when the databases are least likely to be
//  reachable, and validation needs none of them.
//
//
//  Colour, unless something says otherwise: --no-colors (as "config cat"
//  spells it) or the --no-color everyone reaches for anyway, the NO_COLOR
//  convention, or output that is not a terminal -- piping to a file or to
//  |tee| should not fill it with escape sequences.
//
function colorPainter() {
    const enabled =
        false !== argv.colors &&
        false !== argv.color &&
        !process.env.NO_COLOR &&
        Boolean(process.stdout.isTTY);

    const wrap = code => text => (enabled ? `\x1b[${code}m${text}\x1b[0m` : text);

    return {
        red: wrap('31'),
        yellow: wrap('33'),
        cyan: wrap('36'),
        bold: wrap('1'),
    };
}

//
//  One file's worth of report. Returns how many of its issues were errors,
//  since only those decide the exit code.
//
function printReport(label, issues, paint) {
    const {
        describeIssue,
        countBySeverity,
        Severity,
    } = require('../../core/config/issue.js');

    if (0 === issues.length) {
        console.info(`${label}: no problems found`);
        return 0;
    }

    const { errors, warnings } = countBySeverity(issues);
    const parts = [];
    if (errors) {
        parts.push(`${errors} error${1 === errors ? '' : 's'}`);
    }
    if (warnings) {
        parts.push(`${warnings} warning${1 === warnings ? '' : 's'}`);
    }

    console.info(
        `${label}: ${issues.length} issue${1 === issues.length ? '' : 's'} (${parts.join(
            ', '
        )})\n`
    );

    //  errors first; they are the ones that will actually misbehave
    const ordered = issues.slice().sort((a, b) => {
        if (a.severity === b.severity) {
            return a.path.localeCompare(b.path);
        }
        return Severity.Error === a.severity ? -1 : 1;
    });

    ordered.forEach(issue => {
        const described = describeIssue(issue);
        const paintSeverity =
            Severity.Error === described.severity ? paint.red : paint.yellow;

        console.info(
            `  ${paintSeverity(described.severity.padEnd(8))} ${paint.cyan(
                described.path
            )}`
        );
        described.message.split('\n').forEach(line => {
            console.info(`           ${line}`);
        });
        console.info('');
    });

    return errors;
}

//
//  achievements.hjson, if the system is configured for one. It goes through
//  the same ConfigLoader the running board uses, so an @reference or an
//  include behaves identically here.
//
function loadAchievementsConfig(cb) {
    const conf = require('../../core/config.js');

    const achievementFile = _.get(conf.get(), 'general.achievementFile');
    if (!achievementFile) {
        return cb(null); //  not configured, which is legal
    }

    const { getConfigPath: qualify } = require('../../core/config_util.js');
    const ConfigLoader = require('../../core/config_loader.js');

    const path = qualify(achievementFile);
    const loader = new ConfigLoader({ hotReload: false });

    loader.init(path, err => {
        return cb(err, path, loader);
    });
}

//
//  The two sets the deferred reference checks need. The running board gets
//  these from ThemeManager, which is not usable here: it logs through a Log
//  that only exists once the BBS has started.
//
//  Both are gathered leniently and hand back undefined when they cannot be
//  gathered at all, because reporting every theme and menu as missing on a
//  correct board would be far worse than checking neither.
//

//
//  A theme is a directory under paths.themes holding a theme.hjson.
//
//  ThemeManager also requires info.name and info.author and honours
//  info.enabled; only the last is applied here. A theme with a malformed info
//  block is skipped by the real loader with a warning, and counting it as
//  present merely means a theme.default pointing at it is not reported --
//  a miss, where the alternative is a false alarm.
//
function gatherThemeIds() {
    const conf = require('../../core/config.js');
    const themeDir = _.get(conf.get(), 'paths.themes');

    if (!themeDir) {
        return undefined;
    }

    let entries;
    try {
        entries = fs.readdirSync(themeDir, { withFileTypes: true });
    } catch (e) {
        return undefined; //  no themes directory at all; say nothing
    }

    const ids = entries
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .filter(id => {
            const themePath = paths.join(themeDir, id, 'theme.hjson');
            try {
                const theme = hjson.parse(fs.readFileSync(themePath, 'utf8'));
                return false !== _.get(theme, 'info.enabled');
            } catch (e) {
                //  unreadable or unparseable: the real loader may still manage
                //  it -- includes and @reference specs are not handled here --
                //  so keep it as a candidate
                return fs.existsSync(themePath);
            }
        });

    return ids.length ? ids : undefined;
}

//
//  Menu names, through the same ConfigLoader the board uses, so includes and
//  "@reference:" specs behave identically.
//
function gatherMenuNames(cb) {
    const conf = require('../../core/config.js');

    const menuFile = _.get(conf.get(), 'general.menuFile');
    if (!menuFile) {
        return cb(undefined);
    }

    const { getConfigPath: qualify } = require('../../core/config_util.js');
    const ConfigLoader = require('../../core/config_loader.js');

    const loader = new ConfigLoader({ hotReload: false });

    loader.init(qualify(menuFile), err => {
        if (err) {
            //  menu.hjson itself is not this command's business; the board
            //  will complain loudly enough on its own
            return cb(undefined);
        }

        const menus = _.get(loader.get(), 'menus');
        return cb(_.isPlainObject(menus) ? Object.keys(menus) : undefined);
    });
}

function validateCurrentConfig() {
    const { initConfig } = require('./oputil_common.js');
    const conf = require('../../core/config.js');

    initConfig(err => {
        if (err) {
            console.error(`Failed to load configuration: ${err.message}`);
            if (err.configPath) {
                console.error(`Note: ${err.configPath}`);
            }
            process.exitCode = ExitCodes.ERROR;
            return;
        }

        const { buildSchema } = require('../../core/config/schema.js');
        const { validateConfig } = require('../../core/config/validate.js');
        const {
            validateReferences,
            validateDeferredReferences,
        } = require('../../core/config/refs.js');

        const checkEnv = true === argv['check-env'];
        const paint = colorPainter();

        gatherMenuNames(menuNames => {
            const issues = [
                ...validateConfig(conf.getUserConfig(), conf.get(), buildSchema(), {
                    checkEnv,
                }),
                ...validateReferences(conf.get()),
                //
                //  Themes and menus are not in the configuration, so this is
                //  the only surface besides startup that can check them -- and
                //  the only one that can do it before a restart.
                //
                ...validateDeferredReferences(conf.get(), {
                    themeIds: gatherThemeIds(),
                    menuNames,
                }),
            ];

            let errorCount = printReport(getConfigPath(), issues, paint);

            loadAchievementsConfig((achErr, achPath, achLoader) => {
                if (achErr) {
                    //
                    //  Not an error: module_util.js logs a warning and carries on
                    //  when a system module fails to initialise, so a board with an
                    //  unreadable achievements.hjson still starts -- it simply has
                    //  no achievements. Saying otherwise here would fail a systemd
                    //  ExecStartPre for something the board itself shrugs off.
                    //
                    console.info('');
                    console.info(
                        `${paint.yellow('warning ')} ${paint.cyan(achPath)}\n` +
                            `           cannot be loaded, so achievements will be unavailable\n` +
                            `           ${achErr.message}`
                    );
                } else if (achLoader) {
                    const {
                        buildAchievementSchema,
                    } = require('../../core/config/achievement_schema.js');

                    console.info('');
                    errorCount += printReport(
                        achPath,
                        validateConfig(
                            achLoader.getUserConfig(),
                            achLoader.get(),
                            buildAchievementSchema(),
                            { checkEnv }
                        ),
                        paint
                    );
                }

                //
                //  Warnings alone are not a failure: an unknown key may well be a
                //  mod's own configuration block.
                //
                process.exitCode = errorCount > 0 ? ExitCodes.ERROR : ExitCodes.SUCCESS;
            });
        });
    });
}

function handleConfigCommand() {
    if (true === argv.help) {
        return printUsageAndSetExitCode(getHelpFor('Config'), ExitCodes.ERROR);
    }

    const action = argv._[1];

    switch (action) {
        case 'new':
            return buildNewConfig();
        case 'cat':
            return catCurrentConfig();
        case 'validate':
            return validateCurrentConfig();

        default:
            return printUsageAndSetExitCode(getHelpFor('Config'), ExitCodes.ERROR);
    }
}
