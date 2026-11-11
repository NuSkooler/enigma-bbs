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
const copySync = require('fs-extra').copySync;

exports.handleConfigCommand = handleConfigCommand;
exports.setInstallFilePaths = setInstallFilePaths;
exports.buildNewConfig = buildNewConfig;

//  The install's own config/: where `config new` writes the menus, and where
//  the shipped achievements.hjson lives.
const InstallConfigDir = paths.join(__dirname, '../../config');
exports.InstallConfigDir = InstallConfigDir;

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

//
//  The PETSCII starter (#593): a small menu tree and a theme for Commodore
//  style callers, offered by "config new" and off unless asked for. The
//  theme ships outside art/themes/ and is only copied in on request: any
//  PETSCII theme in the themes directory is given to PETSCII callers, which
//  on a board without these menus would strand them on the stock tree.
//
//  A PETSCII caller on the main telnet port is sent into the starter menus by
//  an ACS branch on the stock connect menu (see addPetsciiConnectBranch()); a
//  dedicated listener can name |firstMenu| instead.
//
const PetsciiStarter = Object.freeze({
    menuTemplate: 'petscii.in.hjson',
    themeSourceDir: paths.join(__dirname, '../../misc/petscii_starter'),
    themeId: 'petscii_starter',
    firstMenu: 'petsciiConnected',
    afterConnectMenu: 'petsciiMatrix',
});

exports.PetsciiStarter = PetsciiStarter;

//  The config.hjson setting that gives PETSCII sessions the starter theme
function applyPetsciiStarterConfig(config) {
    _.set(config, ['theme', 'emulations'], {
        petscii: {
            default: PetsciiStarter.themeId,
            preLogin: PetsciiStarter.themeId,
        },
    });
}

exports.applyPetsciiStarterConfig = applyPetsciiStarterConfig;

//
//  The stock telnetConnected menu in login.in.hjson, exactly as shipped, and
//  the same menu with its |next| branched on the session's terminal
//  emulation: a PETSCII caller goes on to the starter matrix, everyone else
//  to the stock one. Its CONNECT art is in the starter theme too, so a
//  PETSCII caller sees PETSCII art from the first screen.
//
const StockTelnetConnected = `        telnetConnected: {
            desc: Telnet Connect
            art: CONNECT
            next: matrix
            config: { nextTimeout: 1500 }
        }`;

const PetsciiTelnetConnected = `        telnetConnected: {
            desc: Telnet Connect
            art: CONNECT
            next: [
                {
                    //  PETSCII (Commodore) callers: the PETSCII starter menus
                    acs: TE[petscii]
                    next: ${PetsciiStarter.afterConnectMenu}
                }
                {
                    next: matrix
                }
            ]
            config: { nextTimeout: 1500 }
        }`;

//
//  |loginMenuText| (login.in.hjson's text) with the PETSCII branch added to
//  telnetConnected. Throws when the stock entry is not there exactly once:
//  better no file than one that silently lacks the way in.
//
function addPetsciiConnectBranch(loginMenuText) {
    //  a checkout with CRLF line endings has them in the template too
    const eol = loginMenuText.includes('\r\n') ? '\r\n' : '\n';
    const parts = loginMenuText.split(StockTelnetConnected.replace(/\n/g, eol));
    if (2 !== parts.length) {
        throw new Error(
            'telnetConnected in login.in.hjson is not as expected; PETSCII branch not added'
        );
    }
    return parts.join(PetsciiTelnetConnected.replace(/\n/g, eol));
}

exports.addPetsciiConnectBranch = addPetsciiConnectBranch;

//
//  Copy the starter theme into |themesDir|. An existing theme directory of
//  that name is left alone (it may have been customised): returns false
//  then, true when copied.
//
function copyPetsciiStarterTheme(themesDir) {
    const dest = paths.join(themesDir, PetsciiStarter.themeId);
    if (fs.existsSync(dest)) {
        return false;
    }
    copySync(PetsciiStarter.themeSourceDir, dest, {
        overwrite: false,
        errorOnExist: true,
    });
    return true;
}

exports.copyPetsciiStarterTheme = copyPetsciiStarterTheme;

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

    Petscii: [
        {
            name: 'includePetscii',
            message:
                'Include starter menus and theme for PETSCII (Commodore 64/128) callers?',
            type: 'confirm',
            default: false,
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
    const options = {};

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
            function petscii(callback) {
                getAnswers(QUESTIONS.Petscii, answers => {
                    options.includePetscii = true === answers.includePetscii;
                    return callback(null);
                });
            },
        ],
        err => {
            return cb(err, configPath, config, options);
        }
    );
}

//
//  login.in.hjson with the PETSCII branch, never over an existing file (as
//  copyFileSyncSilent() with COPYFILE_EXCL). If the branch cannot be added
//  the stock file is copied as it is: a board without the branch works, one
//  without its login menus does not.
//
const writePetsciiLoginMenu = (from, to) => {
    let text;
    try {
        text = addPetsciiConnectBranch(fs.readFileSync(from, 'utf8'));
    } catch (e) {
        console.error(
            `${e.message}: PETSCII callers on the main port are not sent to the PETSCII menus; see the PETSCII documentation to add the branch to telnetConnected in ${to}`
        );
        return copyFileSyncSilent(from, to, fs.constants.COPYFILE_EXCL);
    }
    try {
        fs.writeFileSync(to, text, { encoding: 'utf8', flag: 'wx' });
    } catch (e) {
        console.error(e);
    }
};

const copyFileSyncSilent = (to, from, flags) => {
    try {
        fs.copyFileSync(to, from, flags);
    } catch (e) {
        /* absorb! */
        console.error(e);
    }
};

//
//  Point a new config at the files `config new` uses in the install's
//  config/, by absolute path. A relative name resolves against paths.config,
//  which is the directory holding config.hjson (#927): written relative, a
//  config.hjson created anywhere but the install's config/ would look for
//  them beside itself instead, and the achievements default
//  ("achievements.hjson") would quietly switch achievements off.
//
function setInstallFilePaths(config, menuFile, installConfigDir = InstallConfigDir) {
    config.general.menuFile = paths.join(installConfigDir, 'menus', menuFile);
    config.general.achievementFile = paths.join(installConfigDir, 'achievements.hjson');
}

//
//  |dirs| is for tests only: { installConfigDir, themesDir }, defaulting to
//  the install's config/ and the default themes directory.
//
function buildNewConfig(dirs = {}, done = _.noop) {
    const InstallConfigDir = dirs.installConfigDir || exports.InstallConfigDir;
    const themesDir =
        dirs.themesDir || require('../../core/config_default')().paths.themes;

    askNewConfigQuestions((err, configPath, config, options) => {
        if (err) {
            done(err);
            return err;
        }

        //  ensure 'menus' exists
        mkdirsSync(paths.join(InstallConfigDir, 'menus'));

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

            //  with the PETSCII starter, the connect menu branches to it (#593)
            if (options.includePetscii && 'login.in.hjson' === incFile) {
                return writePetsciiLoginMenu(
                    paths.join(__dirname, '../../misc/menu_templates', incFile),
                    paths.join(InstallConfigDir, 'menus', outName)
                );
            }

            copyFileSyncSilent(
                paths.join(__dirname, '../../misc/menu_templates', incFile),
                paths.join(InstallConfigDir, 'menus', outName),
                fs.constants.COPYFILE_EXCL
            );
        });

        //  PETSCII starter menus and theme, only when asked for (#593)
        if (options.includePetscii) {
            const outName = `${boardName}-${PetsciiStarter.menuTemplate.replace('.in', '')}`;
            includeFiles.push(outName);

            copyFileSyncSilent(
                paths.join(
                    __dirname,
                    '../../misc/menu_templates',
                    PetsciiStarter.menuTemplate
                ),
                paths.join(InstallConfigDir, 'menus', outName),
                fs.constants.COPYFILE_EXCL
            );

            const themeDest = paths.join(themesDir, PetsciiStarter.themeId);
            try {
                if (!copyPetsciiStarterTheme(themesDir)) {
                    console.info(`${themeDest} exists; left as it is`);
                }
            } catch (e) {
                console.error(e);
            }

            applyPetsciiStarterConfig(config);
        }

        //  We really only need includes to be replaced
        const mainTemplate = fs
            .readFileSync(
                paths.join(__dirname, '../../misc/menu_templates/main.in.hjson'),
                'utf8'
            )
            .replace(/%INCLUDE_FILES%/g, includeFiles.join('\n\t\t')); //  cheesy, but works!

        const menuFile = `${boardName}-main.hjson`;
        fs.writeFileSync(
            paths.join(InstallConfigDir, 'menus', menuFile),
            mainTemplate,
            'utf8'
        );

        setInstallFilePaths(config, menuFile, InstallConfigDir);

        if (writeConfig(config, configPath)) {
            console.info('Configuration generated');
        } else {
            console.error('Failed writing configuration');
        }
        return done(null, configPath);
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
//  A bug in a validator is not the operator's problem, and it must not stop
//  the other files being checked.
//
//  The boot and hot reload paths are covered by ConfigLoader._validate()'s own
//  try/catch, but this command calls the validators directly -- so without
//  this a single throw kills the process with a raw stack trace, skips every
//  remaining file, and leaves process.exitCode as Node's uncaught-exception
//  code rather than the one the command meant to set.
//
function collectIssues(label, produce) {
    try {
        return produce();
    } catch (e) {
        console.error(`  (could not check ${label}: ${e.message})`);
        return [];
    }
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

function loadMenuConfig(cb) {
    const conf = require('../../core/config.js');

    const menuFile = _.get(conf.get(), 'general.menuFile');
    if (!menuFile) {
        return cb(null);
    }

    const { getConfigPath: qualify } = require('../../core/config_util.js');
    const ConfigLoader = require('../../core/config_loader.js');

    const path = qualify(menuFile);
    const loader = new ConfigLoader({ hotReload: false });

    loader.init(path, err => {
        //  a menu.hjson that will not load is the board's problem to announce,
        //  not this command's; say nothing rather than guess at why
        return cb(err ? null : { path, loader });
    });
}

//
//  Every theme, parsed straight from disk. ThemeManager cannot be used here --
//  it logs through a Log that only exists once the BBS has started -- so this
//  reads the files itself, and skips any it cannot parse rather than reporting
//  them as broken: the real loader resolves includes and "@reference:" specs
//  that a bare parse does not.
//
function gatherThemes() {
    const conf = require('../../core/config.js');
    const themeDir = _.get(conf.get(), 'paths.themes');

    if (!themeDir) {
        return [];
    }

    let entries;
    try {
        entries = fs.readdirSync(themeDir, { withFileTypes: true });
    } catch (e) {
        return [];
    }

    return entries
        .filter(entry => entry.isDirectory())
        .map(entry => {
            const path = paths.join(themeDir, entry.name, 'theme.hjson');
            try {
                return {
                    themeId: entry.name,
                    path,
                    theme: hjson.parse(fs.readFileSync(path, 'utf8')),
                };
            } catch (e) {
                return undefined;
            }
        })
        .filter(Boolean);
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

        loadMenuConfig(menu => {
            const themes = gatherThemes();
            const themeIds = themes.map(t => t.themeId);

            const menuConfig = menu ? menu.loader.get() : undefined;
            const menuNames = _.isPlainObject(_.get(menuConfig, 'menus'))
                ? Object.keys(menuConfig.menus)
                : undefined;
            const menuPromptNames = _.isPlainObject(_.get(menuConfig, 'prompts'))
                ? Object.keys(menuConfig.prompts)
                : undefined;

            const issues = collectIssues('config.hjson', () => [
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
                    themeIds: themeIds.length ? themeIds : undefined,
                    menuNames,
                }),
            ]);

            let errorCount = printReport(getConfigPath(), issues, paint);

            //  menu.hjson, then each theme
            if (menu) {
                const { buildMenuSchema } = require('../../core/config/menu_schema.js');
                const {
                    validateMenuReferences,
                    validateMenuModules,
                } = require('../../core/config/refs.js');
                const {
                    defaultModuleResolver,
                } = require('../../core/config/module_resolver.js');

                console.info('');
                errorCount += printReport(
                    menu.path,
                    collectIssues(menu.path, () => [
                        ...validateConfig(
                            menu.loader.getUserConfig(),
                            menuConfig,
                            buildMenuSchema(),
                            { checkEnv }
                        ),
                        ...validateMenuReferences(menuConfig),
                        ...validateMenuModules(
                            menuConfig,
                            defaultModuleResolver(conf.get())
                        ),
                    ]),
                    paint
                );
            }

            if (themes.length) {
                const { buildThemeSchema } = require('../../core/config/theme_schema.js');
                const { validateThemeReferences } = require('../../core/config/refs.js');

                const themeSchema = buildThemeSchema();

                themes.forEach(({ path, theme }) => {
                    console.info('');
                    errorCount += printReport(
                        path,
                        collectIssues(path, () => [
                            ...validateConfig(theme, theme, themeSchema, { checkEnv }),
                            ...validateThemeReferences(theme, {
                                menuNames,
                                menuPromptNames,
                            }),
                        ]),
                        paint
                    );
                });
            }

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
                        collectIssues(achPath, () =>
                            validateConfig(
                                achLoader.getUserConfig(),
                                achLoader.get(),
                                buildAchievementSchema(),
                                { checkEnv }
                            )
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
