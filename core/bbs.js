/* jslint node: true */
/* eslint-disable no-console */
'use strict';

//  ENiGMA½
const conf = require('./config.js');
const logger = require('./logger.js');
const database = require('./database.js');
const resolvePath = require('./misc_util.js').resolvePath;
const UserProps = require('./user_property.js');
const SysProps = require('./system_property.js');
const SysLogKeys = require('./system_log.js');
const UserLogNames = require('./user_log_name');

//  deps
const async = require('async');
const util = require('util');
const _ = require('lodash');
const mkdirs = require('fs-extra').mkdirs;
const fs = require('graceful-fs');
const paths = require('path');
const moment = require('moment');

//  our main entry point
exports.main = main;

//  object with various services we want to de-init/shutdown cleanly if possible
const initServices = {};

//  only include bbs.js once @ startup; this should be fine
const COPYRIGHT = fs
    .readFileSync(paths.join(__dirname, '../LICENSE.TXT'), 'utf8')
    .split(/\r?\n/g)[0];

const FULL_COPYRIGHT = `ENiGMA½ ${COPYRIGHT}`;
const HELP = `${FULL_COPYRIGHT}
usage: main.js <args>
eg   : main.js --config /enigma_install_path/config/

valid args:
  --version       : display version
  --help          : displays this help
  --config PATH   : override default config path
`;

function printHelpAndExit() {
    console.info(HELP);
    process.exit();
}

function printVersionAndExit() {
    console.info(require('../package.json').version);
}

function main() {
    let errorDisplayed = false;

    async.waterfall(
        [
            function processArgs(callback) {
                const argv = require('minimist')(process.argv.slice(2));

                if (argv.help) {
                    return printHelpAndExit();
                }

                if (argv.version) {
                    return printVersionAndExit();
                }

                const configOverridePath = argv.config;

                return callback(
                    null,
                    configOverridePath || conf.Config.getDefaultPath(),
                    _.isString(configOverridePath)
                );
            },
            function initConfig(configPath, configPathSupplied, callback) {
                const configFile = configPath + 'config.hjson';

                conf.Config.create(resolvePath(configFile), err => {
                    //
                    //  If the user supplied a path and we can't read/parse it
                    //  then it's a fatal error
                    //
                    if (err) {
                        if ('ENOENT' === err.code) {
                            if (configPathSupplied) {
                                console.error(
                                    'Configuration file does not exist: ' + configFile
                                );
                            } else {
                                configPathSupplied = null; //  make non-fatal; we'll go with defaults
                            }
                        } else {
                            errorDisplayed = true;
                            console.error(`Configuration error: ${err.message}`); //  eslint-disable-line no-console
                            if (err.hint) {
                                console.error(`Hint: ${err.hint}`);
                            }
                            if (err.configPath) {
                                console.error(`Note: ${err.configPath}`);
                            }
                        }
                    }
                    return callback(err);
                });
            },
            function initSystem(callback) {
                initialize(function init(err) {
                    if (err) {
                        console.error('Error initializing: ' + util.inspect(err));
                    }
                    return callback(err);
                });
            },
        ],
        function complete(err) {
            if (!err) {
                //  note this is escaped:
                fs.readFile(
                    paths.join(__dirname, '../misc/startup_banner.asc'),
                    'utf8',
                    (err, banner) => {
                        console.info(FULL_COPYRIGHT);
                        if (!err) {
                            console.info(banner);
                        }
                        console.info('System started!');
                    }
                );
            }

            if (err && !errorDisplayed) {
                console.error('Error initializing: ' + util.inspect(err));
                return process.exit();
            }
        }
    );
}

function shutdownSystem() {
    const msg = 'Process interrupted. Shutting down...';
    console.info(msg);
    logger.log.info(msg);

    async.series(
        [
            function closeConnections(callback) {
                const ClientConns = require('./client_connections.js');
                const activeConnections = ClientConns.getActiveConnections(
                    ClientConns.AllConnections
                );
                let i = activeConnections.length;
                while (i--) {
                    const activeTerm = activeConnections[i].term;
                    if (activeTerm) {
                        activeTerm.write(
                            '\n\nServer is shutting down NOW! Disconnecting...\n\n'
                        );
                    }
                    ClientConns.removeClient(activeConnections[i]);
                }
                callback(null);
            },
            function stopListeningServers(callback) {
                return require('./listening_server.js').shutdown(() => {
                    return callback(null); //  ignore err
                });
            },
            function stopEventScheduler(callback) {
                if (initServices.eventScheduler) {
                    return initServices.eventScheduler.shutdown(() => {
                        return callback(null); // ignore err
                    });
                } else {
                    return callback(null);
                }
            },
            function stopFileAreaWeb(callback) {
                require('./file_area_web.js').startup(() => {
                    return callback(null); // ignore err
                });
            },
            function stopMsgNetwork(callback) {
                require('./msg_network.js').shutdown(callback);
            },
        ],
        () => {
            console.info('Goodbye!');
            return process.exit();
        }
    );
}

function initialize(cb) {
    async.series(
        [
            function createMissingDirectories(callback) {
                const Config = conf.get();
                async.each(
                    Object.keys(Config.paths),
                    function entry(pathKey, next) {
                        mkdirs(Config.paths[pathKey], function dirCreated(err) {
                            if (err) {
                                console.error(
                                    'Could not create path: ' +
                                        Config.paths[pathKey] +
                                        ': ' +
                                        err.toString()
                                );
                            }
                            return next(err);
                        });
                    },
                    function dirCreationComplete(err) {
                        return callback(err);
                    }
                );
            },
            function basicInit(callback) {
                logger.init();
                logger.log.info(
                    {
                        version: require('../package.json').version,
                        nodeVersion: process.version,
                    },
                    '**** ENiGMA½ Bulletin Board System Starting Up! ****'
                );

                process.on('SIGINT', shutdownSystem);

                require('@breejs/later').date.localTime(); //  use local times for later.js/scheduling

                return callback(null);
            },
            function initDatabases(callback) {
                return database.initializeDatabases(callback);
            },
            function initMimeTypes(callback) {
                return require('./mime_util.js').startup(callback);
            },
            function initStatLog(callback) {
                return require('./stat_log.js').init(callback);
            },
            function initMenusAndThemes(callback) {
                const { ThemeManager } = require('./theme');
                return ThemeManager.create(callback);
            },
            function loadSysOpInformation(callback) {
                //
                //  Copy over some +op information from the user DB -> system properties.
                //  * Makes this accessible for MCI codes, easy non-blocking access, etc.
                //  * We do this every time as the op is free to change this information just
                //    like any other user
                //
                const User = require('./user.js');

                //  :TODO: use User.getUserInfo() for this!

                const propLoadOpts = {
                    names: [
                        UserProps.RealName,
                        UserProps.Sex,
                        UserProps.EmailAddress,
                        UserProps.Location,
                        UserProps.Affiliations,
                    ],
                };

                async.waterfall(
                    [
                        function getOpUserName(next) {
                            return User.getUserName(User.RootUserID, next);
                        },
                        function getOpProps(opUserName, next) {
                            User.loadProperties(
                                User.RootUserID,
                                propLoadOpts,
                                (err, opProps) => {
                                    return next(err, opUserName, opProps);
                                }
                            );
                        },
                    ],
                    (err, opUserName, opProps) => {
                        const StatLog = require('./stat_log.js');

                        if (err) {
                            propLoadOpts.names.concat('username').forEach(v => {
                                StatLog.setNonPersistentSystemStat(`sysop_${v}`, 'N/A');
                            });
                        } else {
                            opProps.username = opUserName;

                            _.each(opProps, (v, k) => {
                                StatLog.setNonPersistentSystemStat(`sysop_${k}`, v);
                            });
                        }

                        return callback(null);
                    }
                );
            },
            function initSystemLogStats(callback) {
                const StatLog = require('./stat_log.js');

                const filter = {
                    logName: SysLogKeys.UserLoginHistory,
                    resultType: 'count',
                    date: moment(),
                };

                StatLog.findSystemLogEntries(filter, (err, callsToday) => {
                    if (!err) {
                        StatLog.setNonPersistentSystemStat(
                            SysProps.LoginsToday,
                            callsToday
                        );
                    }
                    return callback(null);
                });
            },
            function initUserLogStats(callback) {
                const StatLog = require('./stat_log');

                const entries = [
                    [UserLogNames.UlFiles, [SysProps.FileUlTodayCount, 'count']],
                    [UserLogNames.UlFileBytes, [SysProps.FileUlTodayBytes, 'obj']],
                    [UserLogNames.DlFiles, [SysProps.FileDlTodayCount, 'count']],
                    [UserLogNames.DlFileBytes, [SysProps.FileDlTodayBytes, 'obj']],
                    [UserLogNames.NewUser, [SysProps.NewUsersTodayCount, 'count']],
                ];

                async.each(
                    entries,
                    (entry, nextEntry) => {
                        const [logName, [sysPropName, resultType]] = entry;

                        const filter = {
                            logName,
                            resultType,
                            date: moment(),
                        };

                        StatLog.findUserLogEntries(filter, (err, stat) => {
                            if (!err) {
                                if (resultType === 'obj') {
                                    stat = stat.reduce(
                                        (bytes, entry) =>
                                            bytes + parseInt(entry.log_value) || 0,
                                        0
                                    );
                                }

                                StatLog.setNonPersistentSystemStat(sysPropName, stat);
                            }
                            return nextEntry(null);
                        });
                    },
                    () => {
                        return callback(null);
                    }
                );
            },
            function initLastLogin(callback) {
                const StatLog = require('./stat_log');
                StatLog.getSystemLogEntries(
                    SysLogKeys.UserLoginHistory,
                    'timestamp_desc',
                    1,
                    (err, lastLogin) => {
                        if (err) {
                            return callback(null);
                        }

                        let loginObj;
                        try {
                            loginObj = JSON.parse(lastLogin[0].log_value);
                            loginObj.timestamp = moment(lastLogin[0].timestamp);
                        } catch (e) {
                            return callback(null);
                        }

                        //  For live stats we want to resolve user ID -> name, etc.
                        const User = require('./user');
                        User.getUserInfo(loginObj.userId, (err, props) => {
                            const stat = Object.assign({}, props, loginObj);
                            StatLog.setNonPersistentSystemStat(SysProps.LastLogin, stat);
                            return callback(null);
                        });
                    }
                );
            },
            function initUserCount(callback) {
                const User = require('./user.js');
                User.getUserCount((err, count) => {
                    if (err) {
                        return callback(err);
                    }

                    const StatLog = require('./stat_log');
                    StatLog.setNonPersistentSystemStat(SysProps.TotalUserCount, count);
                    return callback(null);
                });
            },
            function initMessageStats(callback) {
                return require('./message_area.js').startup(callback);
            },
            function initMCI(callback) {
                return require('./predefined_mci.js').init(callback);
            },
            function readyMessageNetworkSupport(callback) {
                return require('./msg_network.js').startup(callback);
            },
            function readyEvents(callback) {
                return require('./events.js').startup(callback);
            },
            function genericModulesInit(callback) {
                return require('./module_util.js').initializeModules(callback);
            },
            function listenConnections(callback) {
                return require('./listening_server.js').startup(callback);
            },
            function readyFileBaseArea(callback) {
                return require('./file_base_area.js').startup(callback);
            },
            function readyFileAreaWeb(callback) {
                return require('./file_area_web.js').startup(callback);
            },
            function readyPasswordReset(callback) {
                const WebPasswordReset =
                    require('./web_password_reset.js').WebPasswordReset;
                return WebPasswordReset.startup(callback);
            },
            function ready2FA_OTPRegister(callback) {
                const User2FA_OTPWebRegister = require('./user_2fa_otp_web_register.js');
                return User2FA_OTPWebRegister.startup(callback);
            },
            function readyEventScheduler(callback) {
                const EventSchedulerModule =
                    require('./event_scheduler.js').EventSchedulerModule;
                EventSchedulerModule.loadAndStart((err, modInst) => {
                    initServices.eventScheduler = modInst;
                    return callback(err);
                });
            },
            function listenUserEventsForStatLog(callback) {
                return require('./stat_log.js').initUserEvents(callback);
            },
        ],
        function onComplete(err) {
            return cb(err);
        }
    );
}
