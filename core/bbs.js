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
const { consoleStyle } = require('./server_listen.js');

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

//
//  Banner first, so anything the startup then has to say -- config warnings,
//  which servers bound, a failure -- appears underneath it in the order it
//  actually happened. It used to be printed at the very end, which put the
//  warnings and the server list above it and read backwards.
//
function displayStartupBanner(cb) {
    fs.readFile(
        paths.join(__dirname, '../misc/startup_banner.asc'),
        'utf8',
        (err, banner) => {
            console.info(FULL_COPYRIGHT);
            if (!err) {
                //  note this is escaped:
                console.info(banner);
            }
            console.info(consoleStyle('|07System starting up...'));
            return cb();
        }
    );
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

                return displayStartupBanner(() =>
                    callback(
                        null,
                        configOverridePath || conf.Config.getDefaultPath(),
                        _.isString(configOverridePath)
                    )
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
                        errorDisplayed = true;
                        console.error(`Configuration error: ${err.message}`); //  eslint-disable-line no-console

                        if ('ENOENT' === err.code) {
                            //
                            //  err.configPath names the file that was actually
                            //  missing, which is not necessarily config.hjson:
                            //  a file listed in "includes" that is not there
                            //  fails the whole load in exactly the same way,
                            //  and telling the operator to run "config new"
                            //  would be actively wrong advice for that.
                            //
                            const missingPath = err.configPath || resolvePath(configFile);
                            const isBaseConfig =
                                paths.basename(missingPath).toLowerCase() ===
                                'config.hjson';

                            if (isBaseConfig) {
                                console.error(
                                    `\nConfiguration file does not exist: '${missingPath}'` +
                                        "\n\nIf this is a new installation please run './oputil.js config new' from the enigma-bbs directory"
                                );
                            } else {
                                console.error(
                                    `\nA file listed in "includes" does not exist: '${missingPath}'` +
                                        `\n\nCreate it, or remove it from "includes" in ${resolvePath(
                                            configFile
                                        )}.`
                                );
                            }
                        }

                        if (err.hint) {
                            console.error(`Hint: ${err.hint}`);
                        }
                        if (err.configPath) {
                            console.error(`Note: ${err.configPath}`);
                        }
                    }
                    return callback(err);
                });
            },
            function initSystem(callback) {
                initialize(function init(err) {
                    //  Bind failures and friends have already printed something
                    //  an operator can act on; a util.inspect() dump on top of
                    //  that is just noise.
                    if (err && !err.consoleReported) {
                        console.error('Error initializing: ' + util.inspect(err));
                    }
                    if (err) {
                        errorDisplayed = true;
                    }
                    return callback(err);
                });
            },
        ],
        function complete(err) {
            if (!err) {
                console.info(consoleStyle('|10System started!'));
            }

            if (err) {
                if (!errorDisplayed && !err.consoleReported) {
                    console.error('Error initializing: ' + util.inspect(err));
                }
                //  Always exit non-zero on a startup failure. Previously an
                //  error that had already been displayed fell through here and
                //  the process wound down with status 0, so service managers
                //  and scripts saw a clean exit. See issue #547.
                return process.exit(1);
            }
        }
    );
}

//
//  How long an orderly shutdown may take in all before the process exits
//  anyway, with a non-zero code. Every step below either bounds itself
//  (the listening servers get about 1 s to stop, running Amiga doors about
//  3 s to sync their images) or is quick, so this only fires when one of
//  them hangs. A service manager must allow at least this long before it
//  kills ENiGMA½: see "Stopping" in
//  website/src/content/docs/installation/production.md.
//
const ShutdownTimeoutMs = 15000;

//  SIGINT is ^C at a terminal and what PM2 sends; SIGTERM is what systemd,
//  Docker and a plain kill(1) send
const ShutdownSignals = ['SIGINT', 'SIGTERM'];

//
//  What an orderly shutdown stops, in this order. The listening servers stop
//  accepting connections first, so that nobody new can call in, or start an
//  Amiga door, while the rest stops; connected callers are then told and
//  disconnected, and running Amiga doors get to sync their disk images. Each
//  step calls back without an error.
//
const shutdownSteps = [
    {
        //  About 1 s at most; connections already open are left to the next step
        name: 'stopListeningServers',
        run: cb => require('./listening_server.js').shutdown(() => cb(null)),
    },
    {
        name: 'closeConnections',
        run: cb => {
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
            logger.log.info(
                { callers: activeConnections.length },
                'Disconnected callers'
            );
            return cb(null);
        },
    },
    {
        name: 'stopAmigaDoors',
        //  Best effort, about 3 s at most: running Amiga doors sync their
        //  disk images before the process exits
        run: cb => require('./amiga_door/amiga_door.js').shutdown(() => cb(null)),
    },
    {
        name: 'stopEventScheduler',
        run: cb => {
            if (!initServices.eventScheduler) {
                return cb(null);
            }
            return initServices.eventScheduler.shutdown(() => cb(null));
        },
    },
    {
        name: 'stopFileAreaWeb',
        run: cb => require('./file_area_web.js').shutdown(() => cb(null)),
    },
    {
        name: 'stopMsgNetwork',
        run: cb => require('./msg_network.js').shutdown(() => cb(null)),
    },
];

//
//  Make the function that shuts the system down when a signal arrives.
//
//  It runs once: a second signal of either kind, while a shutdown is under
//  way, is logged and otherwise ignored, so an impatient second ^C or a
//  service manager that sends SIGINT and then SIGTERM cannot cut the Amiga
//  doors' sync short or exit before the rest has stopped. What ends a
//  shutdown that will not finish is the safety timer, not another signal.
//
//  The timer is deliberately not unref()'d: it exists only while a step has
//  not called back, and is cleared before the normal exit. Unref()'d, a step
//  that hung with nothing else keeping the event loop alive would let the
//  process end on its own with status 0, which a service manager reads as a
//  clean stop.
//
//  Either way out waits, a second at most, for the log file to catch up, so
//  that the shutdown's own lines are not lost to process.exit().
//
//  The options are for tests.
//
function createShutdown({
    steps = shutdownSteps,
    timeoutMs = ShutdownTimeoutMs,
    exit = code => process.exit(code),
    flush = cb => logger.flush(cb),
    log,
    out = console,
} = {}) {
    let inProgress = false;

    return function shutdownSystem(signal = 'a shutdown request') {
        const sysLog = log || logger.log;

        if (inProgress) {
            const msg = `Shutdown already in progress; ignoring ${signal}`;
            out.info(msg);
            sysLog.info({ signal }, msg);
            return;
        }
        inProgress = true;

        const msg = `Received ${signal}. Shutting down...`;
        out.info(msg);
        sysLog.info({ signal }, msg);

        let current = null;
        let finished = false;

        //  Report, flush, exit. Nothing here may stop the exit: a throw would
        //  go to the uncaughtException handler, which logs it and carries on,
        //  and with the safety timer cleared (or already fired) nothing else
        //  would end the process.
        const end = (code, report) => {
            try {
                report();
            } catch (err) {
                //  nowhere left to report it; the exit matters more
            }
            let exited = false;
            const exitOnce = () => {
                if (!exited) {
                    exited = true;
                    return exit(code);
                }
            };
            try {
                return flush(exitOnce);
            } catch (err) {
                return exitOnce();
            }
        };

        const timer = setTimeout(() => {
            finished = true;
            return end(1, () => {
                const stuck = `Shutdown did not finish within ${
                    timeoutMs / 1000
                } s: step "${current}" never completed. Exiting anyway`;
                out.error(stuck);
                sysLog.error({ step: current, timeoutMs }, stuck);
            });
        }, timeoutMs);

        async.eachSeries(
            steps,
            (step, next) => {
                current = step.name;
                let called = false;
                const done = () => {
                    if (!called) {
                        called = true;
                        return next(null);
                    }
                };
                try {
                    return step.run(done);
                } catch (err) {
                    //  one broken step must not stop the ones after it
                    sysLog.warn(
                        { err, step: step.name },
                        'Shutdown step failed; continuing'
                    );
                    return done();
                }
            },
            () => {
                clearTimeout(timer);
                if (finished) {
                    return; //  the safety timer has already exited
                }
                finished = true;
                return end(0, () => {
                    sysLog.info('Shutdown complete');
                    out.info('Goodbye!');
                });
            }
        );
    };
}

const shutdownSystem = createShutdown();

//  |proc| is for tests
function registerShutdownSignals(shutdown = shutdownSystem, proc = process) {
    ShutdownSignals.forEach(signal => {
        proc.on(signal, () => shutdown(signal));
    });
}

//  For tests
exports.createShutdown = createShutdown;
exports.registerShutdownSignals = registerShutdownSignals;
exports.shutdownSteps = shutdownSteps;
exports.ShutdownSignals = ShutdownSignals;
exports.ShutdownTimeoutMs = ShutdownTimeoutMs;

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

                registerShutdownSignals();

                //  Safety net: a single unhandled throw/rejection in one
                //  user's menu method (e.g. a missing cb, a typo in a slash
                //  command) used to terminate the whole BBS process and drop
                //  every connected node. Log with full context and keep
                //  serving. The offending session may be in an inconsistent
                //  state, but other sessions are unaffected.
                process.on('uncaughtException', (err, origin) => {
                    logger.log.fatal(
                        { err, origin },
                        'Uncaught exception — process continuing (session may be broken)'
                    );
                });
                process.on('unhandledRejection', (reason, promise) => {
                    logger.log.fatal(
                        { err: reason, promise: String(promise) },
                        'Unhandled promise rejection — process continuing (session may be broken)'
                    );
                });

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
            function validateDeferredReferences(callback) {
                //
                //  theme.default and loginServers.*.firstMenu name things that
                //  do not exist when config.hjson loads, so they are checked
                //  here, once the themes and menu.hjson are in.
                //
                //  Advisory, like every other configuration check: a theme
                //  that is not there falls back to another one and a bad first
                //  menu breaks that login server, but neither is a reason to
                //  refuse to start. Wrapped because a throw in an async.series
                //  task propagates straight out and the callback never fires.
                //
                try {
                    const Config = require('./config.js').get;
                    const { isEnabled } = require('./config/report.js');

                    if (isEnabled(Config())) {
                        const theme = require('./theme.js');
                        const {
                            validateDeferredReferences,
                        } = require('./config/refs.js');

                        const issues = validateDeferredReferences(Config(), {
                            themeIds: [...theme.getAvailableThemes().keys()],
                            menuNames: theme.getMenuNames(),
                        });

                        require('./config/report.js').reportIssues(issues, {
                            logOnly: true,
                        });
                    }
                } catch (e) {
                    logger.log.warn(
                        { error: e.message },
                        'Deferred configuration validation failed'
                    );
                }

                return callback(null);
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
            function readyWsTerm(callback) {
                return require('./web_ws_term.js').startup(callback);
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
