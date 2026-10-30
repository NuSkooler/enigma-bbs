/* jslint node: true */
'use strict';

//  ENiGMA½
const PluginModule = require('./plugin_module.js').PluginModule;
const configModule = require('./config.js');
const logger = require('./logger.js');
const Events = require('./events.js');
const SysProps = require('./system_property.js');
const { Errors } = require('./enig_error.js');

const _ = require('lodash');
const later = require('@breejs/later');
const path = require('path');
const pty = require('node-pty');
const sane = require('sane');
const moment = require('moment');
const paths = require('path');
const fse = require('fs-extra');

//
//  Both read late: config.js replaces |get| once the config is loaded (and
//  tests replace it again), and logger.log is set by Log.init() at runtime.
//
const Config = () => configModule.get();
const Log = () => logger.log;

//
//  StatLog is NOT required at module scope: stat_log.js captures
//  database.js's dbs.system when it loads, so it must not load before
//  initializeDatabases(). See EventSchedulerModule.prototype._statLog().
//

exports.getModule = EventSchedulerModule;
exports.EventSchedulerModule = EventSchedulerModule; //  allow for loadAndStart
exports.getInstance = getInstance;

exports.moduleInfo = {
    name: 'Event Scheduler',
    desc: 'Support for scheduling arbritary events',
    author: 'NuSkooler',
};

const SCHEDULE_REGEXP = /(?:^|or )?(@watch:)([^\0]+)?$/;
const ACTION_REGEXP = /@(method|execute):([^\0]+)?$/;

//  What runNow() can answer
const RunStatus = {
    Started: 'started',
    AlreadyRunning: 'alreadyRunning',
    Unknown: 'unknown',
    Disabled: 'disabled',
};
exports.RunStatus = RunStatus;

//  What stop() can answer
const StopStatus = {
    Killed: 'killed',
    Abandoned: 'abandoned',
    NotRunning: 'notRunning',
    Unknown: 'unknown',
};
exports.StopStatus = StopStatus;

//  @execute output kept for lastRun.outputTail
const OUTPUT_TAIL_LINES = 20;
//  ...and a bound on the raw buffer, for output that never sends a newline
const OUTPUT_TAIL_MAX_CHARS = 8192;

//  The longest delay setTimeout takes; above it the callback runs after 1 ms
const MAX_TIMEOUT_MS = 2147483647;

//  An @execute that ignores the hangup sent on timeout gets SIGKILL this much later
const EXECUTE_KILL_GRACE_MS = 5000;

//  The running instance, set once startup() succeeds; see getInstance()
let instance = null;

function getInstance() {
    return instance;
}

function lastRunStatName(eventName) {
    return `${SysProps.TaskLastRunPrefix}${eventName}`;
}

//
//  Terminal output reduced to plain text: escape sequences (CSI, OSC and
//  two byte ESC forms) and other control characters go, tabs and line
//  breaks stay. A script's colour codes are of no use in a status display
//  and some of them would move the reader's cursor.
//
//  eslint-disable-next-line no-control-regex
const ESCAPE_SEQUENCE_REGEXP =
    /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/g;
//  eslint-disable-next-line no-control-regex
const CONTROL_CHAR_REGEXP = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

function plainText(s) {
    return s.replace(ESCAPE_SEQUENCE_REGEXP, '').replace(CONTROL_CHAR_REGEXP, '');
}

//
//  Keeps the last OUTPUT_TAIL_LINES lines of a process's output
//
class OutputTail {
    constructor() {
        this.buffer = '';
    }

    append(data) {
        this.buffer += data;
        if (this.buffer.length > OUTPUT_TAIL_MAX_CHARS) {
            this.buffer = this.buffer.slice(-OUTPUT_TAIL_MAX_CHARS);
        }
    }

    toString() {
        const lines = plainText(this.buffer).split(/\r\n|\r|\n/);
        while (lines.length > 0 && '' === lines[lines.length - 1].trim()) {
            lines.pop();
        }
        return lines.slice(-OUTPUT_TAIL_LINES).join('\n');
    }
}

//  "byUser" is a name for logs and display; accept a User as well
function userName(byUser) {
    if (!byUser) {
        return null;
    }
    if (_.isString(byUser)) {
        return byUser;
    }
    return byUser.username || String(byUser);
}

//
//  A listener that throws must not take the run with it: from the start of
//  a run it would leave the event marked running for good.
//
function emitTaskEvent(eventName, payload) {
    try {
        Events.emit(eventName, payload);
    } catch (e) {
        Log().warn(
            { eventName: payload.name, error: errorText(e) },
            'A system event listener failed on a scheduled event'
        );
    }
}

function errorText(err) {
    if (!err) {
        return null;
    }
    return err.message || String(err);
}

class ScheduledEvent {
    constructor(events, name) {
        const entry = events[name];

        this.name = name;
        this.isEntryObject = _.isPlainObject(entry);
        this.entry = this.isEntryObject ? entry : {};

        this.scheduleText = this.entry.schedule;
        this.actionText = this.entry.action;
        this.schedule = this.parseScheduleString(this.scheduleText);
        this.action = this.parseActionSpec(this.actionText);
        if (this.action) {
            this.action.args = this.entry.args || [];
        }

        this.desc =
            _.isString(this.entry.desc) && this.entry.desc ? this.entry.desc : name;
        this.confirm = true === this.entry.confirm;
        this.manual = false !== this.entry.manual;
        this.enabled = false !== this.entry.enabled;
        this.timeout =
            _.isFinite(this.entry.timeout) && this.entry.timeout > 0
                ? Math.min(this.entry.timeout, MAX_TIMEOUT_MS)
                : 0;

        //  state
        this.running = false;
        this.startedAt = null;
        this.lastRun = null;
        this.runCount = 0;
        //  the run in progress: { handle, overdueSince, stop(err, stoppedBy) }
        this.currentRun = null;
    }

    get hasSchedule() {
        return !!(this.schedule && (this.schedule.sched || this.schedule.watchFile));
    }

    get isManualOnly() {
        return !this.hasSchedule;
    }

    get isValid() {
        if (!this.isEntryObject || !this.action) {
            return false;
        }

        if ('method' === this.action.type && !this.action.location) {
            return false;
        }

        //
        //  No schedule makes an event manual-only, but a schedule that is
        //  there and does not parse is a mistake: quietly turning it into a
        //  manual-only event would hide it.
        //
        const scheduleGiven =
            undefined !== this.scheduleText &&
            null !== this.scheduleText &&
            '' !== this.scheduleText;
        if (scheduleGiven && !this.hasSchedule) {
            return false;
        }

        return true;
    }

    nextRun() {
        if (!this.schedule || !this.schedule.sched) {
            return null;
        }
        //
        //  The way later.setTimeout() picks it: next(1) may be the start of
        //  the period we are already in ('every 1 hours' gives the top of the
        //  current hour), so take the second occurrence when the first is
        //  not at least a second away.
        //
        const now = Date.now();
        const next = later.schedule(this.schedule.sched).next(2, new Date(now));
        if (!Array.isArray(next) || !(next[0] instanceof Date)) {
            return null;
        }
        if (next[0].getTime() - now < 1000) {
            return next[1] instanceof Date ? next[1] : null;
        }
        return next[0];
    }

    parseScheduleString(schedStr) {
        if (!_.isString(schedStr) || !schedStr) {
            return false;
        }

        let schedule = {};

        const m = SCHEDULE_REGEXP.exec(schedStr);
        if (m) {
            schedStr = schedStr.substr(0, m.index).trim();

            if ('@watch:' === m[1]) {
                schedule.watchFile = m[2];
            }
        }

        if (schedStr.length > 0) {
            const sched = later.parse.text(schedStr);
            if (-1 === sched.error) {
                schedule.sched = sched;
            }
        }

        //  return undefined if we couldn't parse out anything useful
        if (!_.isEmpty(schedule)) {
            return schedule;
        }
    }

    parseActionSpec(actionSpec) {
        if (_.isString(actionSpec) && actionSpec) {
            if ('@' === actionSpec[0]) {
                const m = ACTION_REGEXP.exec(actionSpec);
                if (m) {
                    if (m[2].indexOf(':') > -1) {
                        const parts = m[2].split(':');
                        return {
                            type: m[1],
                            location: parts[0],
                            what: parts[1],
                        };
                    } else {
                        return {
                            type: m[1],
                            what: m[2],
                        };
                    }
                }
            } else {
                return {
                    type: 'execute',
                    what: actionSpec,
                };
            }
        }
    }

    //
    //  Starts the action; |cb(err)| is called when it completes. |run|
    //  collects what the action reports beyond success or failure (exitCode,
    //  output). Returns { killable, abort() }: for a running @execute,
    //  abort() hangs up on the process (SIGKILL after a grace period), which
    //  then exits and calls |cb|. A @method cannot be stopped.
    //
    executeAction(run, cb) {
        const handle = { killable: false, abort: () => {} };

        if ('method' === this.action.type) {
            const modulePath = path.join(__dirname, '../', this.action.location); //  enigma-bbs base + supplied location (path/file.js')
            try {
                const methodModule = require(modulePath);
                const method = methodModule[this.action.what];
                if (!_.isFunction(method)) {
                    throw Errors.DoesNotExist(
                        `No method "${this.action.what}" in ${this.action.location}`
                    );
                }
                method(this.action.args, err => cb(err || null));
            } catch (e) {
                cb(e);
            }
            return handle;
        }

        //  'execute'
        const opts = {
            //  :TODO: cwd
            name: this.name,
            cols: 80,
            rows: 24,
            env: process.env,
        };

        let proc;
        try {
            proc = pty.spawn(this.action.what, this.action.args, opts);
        } catch (e) {
            cb(e);
            return handle;
        }

        run.output = new OutputTail();
        let exited = false;

        proc.onData(data => run.output.append(data));

        proc.onExit(exitEvent => {
            exited = true;
            run.exitCode = exitEvent.exitCode;
            if (exitEvent.exitCode) {
                return cb(Errors.ExternalProcess(`Exit code ${exitEvent.exitCode}`));
            }
            if (exitEvent.signal) {
                return cb(Errors.ExternalProcess(`Killed by signal ${exitEvent.signal}`));
            }
            return cb(null);
        });

        handle.killable = true;
        handle.abort = () => {
            try {
                proc.kill();
            } catch (e) {
                //  already gone
            }

            const killTimer = setTimeout(() => {
                if (!exited) {
                    try {
                        proc.kill('SIGKILL');
                    } catch (e) {
                        //  already gone
                    }
                }
            }, EXECUTE_KILL_GRACE_MS);
            killTimer.unref();
        };

        return handle;
    }
}

function EventSchedulerModule(options) {
    PluginModule.call(this, options);

    const config = Config();
    if (_.has(config, 'eventScheduler')) {
        this.moduleConfig = config.eventScheduler;
    }

    //  tests supply their own; otherwise stat_log.js is required on first use
    this.statLog = options && options.statLog;

    //  name -> ScheduledEvent; valid, enabled entries only
    this.events = new Map();
    //  names of entries with enabled: false
    this.disabledEvents = new Set();
}

//  convienence static method for direct load + start
EventSchedulerModule.loadAndStart = function (cb) {
    const loadModuleEx = require('./module_util.js').loadModuleEx;

    const loadOpts = {
        name: path.basename(__filename, '.js'),
        path: __dirname,
    };

    loadModuleEx(loadOpts, (err, mod) => {
        if (err) {
            return cb(err);
        }

        const modInst = new mod.getModule();
        modInst.startup(err => {
            if (!err) {
                instance = modInst;
            }
            return cb(err, modInst);
        });
    });
};

EventSchedulerModule.prototype._statLog = function () {
    if (!this.statLog) {
        this.statLog = require('./stat_log.js');
    }
    return this.statLog;
};

EventSchedulerModule.prototype.startup = function (cb) {
    this.eventTimers = [];
    this.events = new Map();
    this.disabledEvents = new Set();

    const self = this;

    if (this.moduleConfig && _.has(this.moduleConfig, 'events')) {
        const events = Object.keys(this.moduleConfig.events).map(name => {
            return new ScheduledEvent(this.moduleConfig.events, name);
        });

        events.forEach(schedEvent => {
            if (!schedEvent.enabled) {
                this.disabledEvents.add(schedEvent.name);
                Log().debug({ eventName: schedEvent.name }, 'Scheduled event disabled');
                return;
            }

            if (!schedEvent.isValid) {
                Log().warn(
                    { eventName: schedEvent.name },
                    'Invalid scheduled event entry'
                );
                return;
            }

            this.events.set(schedEvent.name, schedEvent);
            this._loadLastRun(schedEvent);

            const next = schedEvent.nextRun();
            Log().debug(
                {
                    eventName: schedEvent.name,
                    schedule: schedEvent.scheduleText,
                    action: schedEvent.action,
                    next: next
                        ? moment(next).format('ddd, MMM Do, YYYY @ h:m:ss a')
                        : 'N/A',
                },
                'Scheduled event loaded'
            );

            if (schedEvent.isManualOnly) {
                if (!schedEvent.manual) {
                    Log().warn(
                        { eventName: schedEvent.name },
                        'Scheduled event has no schedule and manual: false, so it can never run'
                    );
                }
                return; //  listed and runnable, never armed
            }

            if (schedEvent.schedule.sched) {
                this.eventTimers.push(
                    later.setInterval(() => {
                        self._runEvent(schedEvent, { reason: 'Schedule' });
                    }, schedEvent.schedule.sched)
                );
            }

            if (schedEvent.schedule.watchFile) {
                const watcher = sane(paths.dirname(schedEvent.schedule.watchFile), {
                    glob: `**/${paths.basename(schedEvent.schedule.watchFile)}`,
                });

                //  :TODO: should track watched files & stop watching @ shutdown?

                ['change', 'add', 'delete'].forEach(event => {
                    watcher.on(event, (fileName, fileRoot) => {
                        const eventPath = paths.join(fileRoot, fileName);
                        if (schedEvent.schedule.watchFile === eventPath) {
                            self._runEvent(schedEvent, {
                                reason: `Watch file: ${eventPath}`,
                                watch: true,
                            });
                        }
                    });
                });

                fse.exists(schedEvent.schedule.watchFile, exists => {
                    if (exists) {
                        self._runEvent(schedEvent, {
                            reason: `Watch file: ${schedEvent.schedule.watchFile}`,
                            watch: true,
                        });
                    }
                });
            }
        });

        //  so a forgotten 'schedule' stays visible
        const manualOnly = [...this.events.values()]
            .filter(e => e.isManualOnly)
            .map(e => e.name);
        if (manualOnly.length > 0) {
            Log().info(
                { events: manualOnly },
                `Manual-only scheduled events (no schedule, run on demand): ${manualOnly.join(
                    ', '
                )}`
            );
        }
    }

    cb(null);
};

EventSchedulerModule.prototype.shutdown = function (cb) {
    if (this.eventTimers) {
        this.eventTimers.forEach(et => et.clear());
    }

    if (instance === this) {
        instance = null;
    }

    cb(null);
};

//
//  Runs |name| now, through the same path and overlap guard as a scheduled
//  run. Returns synchronously; the run itself completes later (see the
//  TaskStarted / TaskFinished system events, or listTasks()).
//
//  options: { reason, byUser }
//
EventSchedulerModule.prototype.runNow = function (name, options) {
    options = options || {};

    if (this.disabledEvents.has(name)) {
        return RunStatus.Disabled;
    }

    const schedEvent = this.events.get(name);
    if (!schedEvent) {
        return RunStatus.Unknown;
    }

    if (!schedEvent.manual) {
        return RunStatus.Disabled; //  manual: false -- not for running by hand
    }

    return this._runEvent(schedEvent, {
        reason: options.reason || 'Manual',
        byUser: userName(options.byUser),
        manual: true,
    });
};

//
//  Stops |name|'s run in progress, for an operator. Returns synchronously:
//
//    killed      an @execute process was hung up on (SIGKILL after a grace
//                period); the run finishes, failed, when it exits
//    abandoned   a @method cannot be stopped, so its run is finished now,
//                failed, and the event may run again; the method may well
//                still be working in the background, and whatever it
//                reports later is ignored
//    notRunning  nothing to stop
//    unknown     no such event (or a disabled one)
//
//  options: { byUser }
//
EventSchedulerModule.prototype.stop = function (name, options) {
    options = options || {};

    const schedEvent = this.events.get(name);
    if (!schedEvent) {
        return StopStatus.Unknown;
    }

    const current = schedEvent.currentRun;
    if (!schedEvent.running || !current) {
        return StopStatus.NotRunning;
    }

    const byUser = userName(options.byUser);
    const who = byUser || 'an operator';
    const killing = current.handle && current.handle.killable;

    Log().warn(
        {
            eventName: name,
            byUser,
            startedAt: schedEvent.startedAt,
            overdueSince: current.overdueSince,
        },
        killing
            ? `Stopping scheduled event "${name}" (killing its process)`
            : `Abandoning scheduled event "${name}": it cannot be stopped, and may still be running`
    );

    if (killing) {
        current.kill(`stopped by ${who}`, byUser);
        return StopStatus.Killed;
    }

    current.abandon(`abandoned by ${who}`, byUser);
    return StopStatus.Abandoned;
};

//
//  Plain snapshot rows, one per event that may be run by hand (manual: false
//  entries are left out). Safe to keep: nothing in a row is live state.
//
EventSchedulerModule.prototype.listTasks = function () {
    return [...this.events.values()]
        .filter(e => e.manual)
        .map(e => {
            const current = e.running ? e.currentRun : null;
            const overdueSince = (current && current.overdueSince) || null;
            let stopAction = null;
            if (current) {
                stopAction =
                    current.handle && current.handle.killable ? 'kill' : 'abandon';
            }

            return {
                name: e.name,
                desc: e.desc,
                schedule: _.isString(e.scheduleText) ? e.scheduleText : null,
                watchFile: (e.schedule && e.schedule.watchFile) || null,
                manualOnly: e.isManualOnly,
                nextRun: e.nextRun(),
                actionType: e.action.type,
                action: e.actionText,
                args: _.clone(e.action.args),
                running: e.running,
                startedAt: e.startedAt,
                overdue: !!overdueSince,
                overdueSince,
                stopAction,
                lastRun: e.lastRun ? _.clone(e.lastRun) : null,
                runCount: e.runCount,
                confirm: e.confirm,
                timeout: e.timeout || null,
            };
        });
};

//
//  The one path every run takes, scheduled or not.
//
//  options: { reason, byUser, manual, watch }
//
EventSchedulerModule.prototype._runEvent = function (schedEvent, options) {
    const { reason, byUser = null, manual = false, watch = false } = options;
    const name = schedEvent.name;

    if (schedEvent.running) {
        const logFields = {
            eventName: name,
            reason,
            startedAt: schedEvent.startedAt,
        };
        if (schedEvent.currentRun && schedEvent.currentRun.overdueSince) {
            logFields.overdueSince = schedEvent.currentRun.overdueSince;
        }
        const message = 'Scheduled event is still running; not starting it again';

        //
        //  A timed run that finds the last one still going is worth an info
        //  line: an event that is slow or hung otherwise just stops happening.
        //  A watch file can fire many times while a run is busy with it, so
        //  those are debug.
        //
        if (manual || watch) {
            Log().debug(logFields, message);
        } else {
            Log().info(logFields, message);
        }
        return RunStatus.AlreadyRunning;
    }

    const start = new Date();
    schedEvent.running = true;
    schedEvent.startedAt = start;
    schedEvent.runCount += 1;

    const run = { exitCode: null, output: null };

    //
    //  What this run's finish depends on beyond the action's own result.
    //  It lives in this closure, so a late callback from an abandoned run can
    //  never touch the state of a newer one.
    //
    const current = {
        handle: null,
        overdueSince: null,
        //  set when the run is being killed: the error it finishes with once
        //  the process exits, whatever the exit looks like
        forcedError: null,
        stoppedBy: null,
    };
    schedEvent.currentRun = current;

    const startFields = { eventName: name, reason, action: schedEvent.action };
    if (manual) {
        startFields.byUser = byUser;
    }
    Log().info(
        startFields,
        manual
            ? `Running event "${name}" by hand${byUser ? ` (${byUser})` : ''}...`
            : `Running scheduled event "${name}"...`
    );

    let done = false;
    let timer = null;

    const finish = err => {
        if (done) {
            //  e.g. a @method calling back after it was abandoned, or twice
            Log().debug(
                { eventName: name, error: errorText(err) },
                'Scheduled event completed after it had already finished; ignored'
            );
            return;
        }
        done = true;

        if (timer) {
            clearTimeout(timer);
            timer = null;
        }

        if (current.forcedError) {
            err = new Error(current.forcedError);
        }

        const end = new Date();
        const lastRun = {
            start,
            end,
            durationMs: end - start,
            ok: !err,
            error: errorText(err),
            reason,
            exitCode: run.exitCode,
            outputTail: run.output ? run.output.toString() : null,
            byUser,
            overdue: !!current.overdueSince,
            stoppedBy: current.stoppedBy,
        };

        schedEvent.running = false;
        schedEvent.startedAt = null;
        schedEvent.lastRun = lastRun;
        if (schedEvent.currentRun === current) {
            schedEvent.currentRun = null;
        }

        const endFields = {
            eventName: name,
            reason,
            durationMs: lastRun.durationMs,
        };
        if (byUser) {
            endFields.byUser = byUser;
        }
        if (null !== run.exitCode) {
            endFields.exitCode = run.exitCode;
        }
        if (lastRun.overdue) {
            endFields.overdue = true;
            endFields.timeoutMs = schedEvent.timeout;
        }
        if (lastRun.stoppedBy) {
            endFields.stoppedBy = lastRun.stoppedBy;
        }

        if (err) {
            endFields.error = lastRun.error;
            Log().warn(endFields, `Scheduled event "${name}" failed`);
        } else {
            Log().info(endFields, `Scheduled event "${name}" finished`);
        }

        this._persistLastRun(schedEvent);

        emitTaskEvent(Events.getSystemEvents().TaskFinished, {
            name,
            desc: schedEvent.desc,
            reason,
            byUser,
            ok: lastRun.ok,
            error: lastRun.error,
            durationMs: lastRun.durationMs,
            overdue: lastRun.overdue,
        });
    };

    //  Hang up on an @execute; the run finishes with |error| once it exits
    current.kill = (error, stoppedBy) => {
        if (done) {
            return;
        }
        if (!current.forcedError) {
            current.forcedError = error;
            current.stoppedBy = stoppedBy || null;
        }
        current.handle.abort();
    };

    //  Give up on a @method now; what it reports later is ignored
    current.abandon = (error, stoppedBy) => {
        if (done) {
            return;
        }
        current.forcedError = error;
        current.stoppedBy = stoppedBy || null;
        finish(null);
    };

    //  Emitted once stop() can act on the run; a listener may stop it here
    emitTaskEvent(Events.getSystemEvents().TaskStarted, {
        name,
        desc: schedEvent.desc,
        reason,
        byUser,
    });
    if (done) {
        return;
    }

    try {
        current.handle = schedEvent.executeAction(run, finish);
    } catch (e) {
        finish(e);
    }

    if (!done && schedEvent.timeout) {
        timer = setTimeout(() => {
            timer = null;
            if (done) {
                return;
            }

            current.overdueSince = new Date();
            const killing = current.handle && current.handle.killable;

            Log().warn(
                {
                    eventName: name,
                    reason,
                    byUser,
                    timeoutMs: schedEvent.timeout,
                    startedAt: start,
                },
                killing
                    ? `Scheduled event "${name}" exceeded its timeout of ${schedEvent.timeout} ms; killing it`
                    : `Scheduled event "${name}" exceeded its timeout of ${schedEvent.timeout} ms and is still running`
            );

            emitTaskEvent(Events.getSystemEvents().TaskOverdue, {
                name,
                desc: schedEvent.desc,
                reason,
                byUser,
                timeoutMs: schedEvent.timeout,
                startedAt: start,
            });

            //
            //  A process can be ended, so it is, and its exit frees the event.
            //  A @method cannot: the event stays running, and so blocked,
            //  until it calls back or an operator abandons it (stop()).
            //
            if (killing) {
                current.kill('timed out');
            }
        }, schedEvent.timeout);
        timer.unref();
    }

    return RunStatus.Started;
};

EventSchedulerModule.prototype._persistLastRun = function (schedEvent) {
    const statName = lastRunStatName(schedEvent.name);
    try {
        this._statLog().setSystemStat(
            statName,
            JSON.stringify(schedEvent.lastRun),
            err => {
                if (err) {
                    Log().warn(
                        { eventName: schedEvent.name, error: err.message },
                        'Failed to save scheduled event last run'
                    );
                }
            }
        );
    } catch (e) {
        Log().warn(
            { eventName: schedEvent.name, error: e.message },
            'Failed to save scheduled event last run'
        );
    }
};

EventSchedulerModule.prototype._loadLastRun = function (schedEvent) {
    let raw;
    try {
        raw = this._statLog().getSystemStat(lastRunStatName(schedEvent.name));
    } catch (e) {
        return;
    }

    if (!raw) {
        return;
    }

    let lastRun;
    try {
        lastRun = _.isString(raw) ? JSON.parse(raw) : raw;
    } catch (e) {
        Log().debug(
            { eventName: schedEvent.name, error: e.message },
            'Ignoring unreadable scheduled event last run'
        );
        return;
    }

    if (!_.isPlainObject(lastRun)) {
        return;
    }

    ['start', 'end'].forEach(key => {
        if (lastRun[key]) {
            const d = new Date(lastRun[key]);
            lastRun[key] = isNaN(d.getTime()) ? null : d;
        }
    });

    schedEvent.lastRun = lastRun;
};
