'use strict';

//
//  core/event_scheduler.js: optional schedules (manual-only tasks), the
//  enabled / manual / timeout keys, runNow(), listTasks(), last run state and
//  its persistence, the TaskStarted / TaskFinished system events, and the
//  overlap guard.
//
//  later.setInterval is replaced so nothing is ever armed for real; the
//  timers it was asked for are recorded and fired by hand.
//

const { strict: assert } = require('assert');
const later = require('@breejs/later');

const configModule = require('../core/config.js');
const loggerModule = require('../core/logger.js');
const Events = require('../core/events.js');
const SystemEvents = require('../core/system_events.js');

const METHODS = 'test/fixtures/event_scheduler/methods.js';
const methods = require('./fixtures/event_scheduler/methods.js');

//  A StatLog stand-in: only the system stat calls the scheduler makes
function fakeStatLog(initial = {}) {
    const stats = Object.assign({}, initial);
    return {
        stats,
        sets: [],
        getSystemStat(name) {
            return stats[name];
        },
        setSystemStat(name, value, cb) {
            stats[name] = value;
            this.sets.push({ name, value });
            if (cb) {
                return cb(null);
            }
        },
    };
}

//  Records every log call; installed over the setup.js stub per test
function recordingLog() {
    const entries = [];
    const record = level => (obj, msg) => {
        entries.push({ level, obj, msg: typeof obj === 'string' ? obj : msg });
    };
    const log = {
        entries,
        trace: record('trace'),
        debug: record('debug'),
        info: record('info'),
        warn: record('warn'),
        error: record('error'),
        fatal: record('fatal'),
        child() {
            return log;
        },
    };
    return log;
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(predicate, timeoutMs = 3000) {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error('timed out waiting');
        }
        await wait(10);
    }
}

describe('event scheduler', function () {
    let EventScheduler;
    let prevConfig;
    let prevLog;
    let prevSetInterval;
    let armed;
    let log;
    let scheduler;

    before(() => {
        EventScheduler = require('../core/event_scheduler.js');
    });

    beforeEach(() => {
        methods.reset();

        prevSetInterval = later.setInterval;
        armed = [];
        later.setInterval = (fn, sched) => {
            const timer = { fn, sched, cleared: false };
            timer.clear = () => {
                timer.cleared = true;
            };
            armed.push(timer);
            return timer;
        };

        prevLog = loggerModule.log;
        log = recordingLog();
        loggerModule.log = log;
    });

    afterEach(done => {
        later.setInterval = prevSetInterval;
        loggerModule.log = prevLog;
        if (prevConfig) {
            configModule._popTestConfig(prevConfig);
            prevConfig = null;
        }
        if (scheduler) {
            const s = scheduler;
            scheduler = null;
            return s.shutdown(() => done());
        }
        return done();
    });

    function start(events, statLog = fakeStatLog()) {
        prevConfig = configModule._pushTestConfig({ eventScheduler: { events } });
        scheduler = new EventScheduler.EventSchedulerModule({ statLog });
        return new Promise((resolve, reject) => {
            scheduler.startup(err => (err ? reject(err) : resolve(scheduler)));
        });
    }

    const armedNames = () => armed.map(t => t.sched);

    describe('loading', () => {
        it('lists an entry with no schedule but never arms it', async () => {
            await start({
                manualTask: { action: `@method:${METHODS}:ok`, desc: 'A manual task' },
                timedTask: { schedule: 'every 1 hours', action: `@method:${METHODS}:ok` },
            });

            assert.equal(armed.length, 1, 'only the scheduled entry is armed');

            const rows = scheduler.listTasks();
            const manual = rows.find(r => r.name === 'manualTask');
            assert.ok(manual);
            assert.equal(manual.manualOnly, true);
            assert.equal(manual.schedule, null);
            assert.equal(manual.nextRun, null);
            assert.equal(manual.desc, 'A manual task');

            const timed = rows.find(r => r.name === 'timedTask');
            assert.equal(timed.manualOnly, false);
            assert.equal(timed.desc, 'timedTask', 'desc defaults to the name');
        });

        it('logs the manual-only entries once at startup', async () => {
            await start({
                a: { action: `@method:${METHODS}:ok` },
                b: { action: `@method:${METHODS}:ok` },
                c: { schedule: 'every 1 hours', action: `@method:${METHODS}:ok` },
            });

            const lines = log.entries.filter(
                e => 'info' === e.level && /Manual-only/.test(e.msg)
            );
            assert.equal(lines.length, 1);
            assert.deepEqual(lines[0].obj.events, ['a', 'b']);
        });

        it('still rejects an entry without a valid action', async () => {
            await start({
                noAction: { schedule: 'every 1 hours' },
                badMethod: { action: '@method:no_function_here.js' },
                notAnObject: 'every 1 hours',
            });

            assert.deepEqual(scheduler.listTasks(), []);
            const invalid = log.entries.filter(
                e => 'warn' === e.level && /Invalid scheduled event/.test(e.msg)
            );
            assert.deepEqual(invalid.map(e => e.obj.eventName).sort(), [
                'badMethod',
                'noAction',
                'notAnObject',
            ]);
        });

        it('rejects a schedule that does not parse rather than making it manual-only', async () => {
            await start({
                typo: { schedule: 'evry 2 hourz', action: `@method:${METHODS}:ok` },
            });

            assert.deepEqual(scheduler.listTasks(), []);
            assert.equal(armed.length, 0);
        });

        it('ignores enabled: false entries entirely', async () => {
            await start({
                off: {
                    schedule: 'every 1 hours',
                    action: `@method:${METHODS}:ok`,
                    enabled: false,
                },
            });

            assert.equal(armed.length, 0);
            assert.deepEqual(scheduler.listTasks(), []);
            assert.equal(scheduler.runNow('off'), 'disabled');
            assert.equal(methods.state.calls.length, 0);
        });

        it('hides manual: false entries from the list but still arms them', async () => {
            await start({
                hidden: {
                    schedule: 'every 1 hours',
                    action: `@method:${METHODS}:ok`,
                    manual: false,
                },
            });

            assert.equal(armed.length, 1);
            assert.deepEqual(scheduler.listTasks(), []);
            assert.equal(scheduler.runNow('hidden'), 'disabled');

            armed[0].fn();
            assert.equal(methods.state.calls.length, 1, 'the schedule still runs it');
        });

        it('warns about an entry that can never run (no schedule, manual: false)', async () => {
            await start({ dead: { action: `@method:${METHODS}:ok`, manual: false } });

            const warn = log.entries.find(
                e => 'warn' === e.level && /can never run/.test(e.msg)
            );
            assert.equal(warn.obj.eventName, 'dead');
        });

        it('computes nextRun for a timed schedule', async () => {
            await start({
                timed: { schedule: 'every 1 hours', action: `@method:${METHODS}:ok` },
            });

            const [row] = scheduler.listTasks();
            assert.ok(row.nextRun instanceof Date);
            assert.ok(row.nextRun.getTime() > Date.now());
            assert.ok(row.nextRun.getTime() <= Date.now() + 60 * 60 * 1000 + 1000);
            assert.equal(armedNames().length, 1);
        });

        it('describes each task in a listTasks() row', async () => {
            await start({
                t: {
                    action: `@method:${METHODS}:ok`,
                    args: ['x', 'y'],
                    desc: 'Tee',
                    confirm: true,
                    timeout: 5000,
                },
            });

            const [row] = scheduler.listTasks();
            assert.deepEqual(row, {
                name: 't',
                desc: 'Tee',
                schedule: null,
                watchFile: null,
                manualOnly: true,
                nextRun: null,
                actionType: 'method',
                action: `@method:${METHODS}:ok`,
                args: ['x', 'y'],
                running: false,
                startedAt: null,
                overdue: false,
                overdueSince: null,
                stopAction: null,
                lastRun: null,
                runCount: 0,
                confirm: true,
                timeout: 5000,
            });
        });
    });

    describe('getInstance()', () => {
        it('is set by loadAndStart and cleared by shutdown', done => {
            prevConfig = configModule._pushTestConfig({
                eventScheduler: { events: {} },
            });
            //  loadAndStart builds its own instance, which reads the real
            //  StatLog -- with no events it never asks
            EventScheduler.EventSchedulerModule.loadAndStart((err, inst) => {
                assert.ifError(err);
                assert.equal(EventScheduler.getInstance(), inst);
                inst.shutdown(() => {
                    assert.equal(EventScheduler.getInstance(), null);
                    done();
                });
            });
        });
    });

    describe('runNow()', () => {
        it('answers unknown for a name it does not have', async () => {
            await start({ t: { action: `@method:${METHODS}:ok` } });
            assert.equal(scheduler.runNow('nope'), 'unknown');
        });

        it('runs the task and records an ok last run', async () => {
            const statLog = fakeStatLog();
            await start({ t: { action: `@method:${METHODS}:ok`, args: ['a'] } }, statLog);

            assert.equal(
                scheduler.runNow('t', { reason: 'Test', byUser: 'sysop' }),
                'started'
            );
            assert.deepEqual(methods.state.calls, [{ method: 'ok', args: ['a'] }]);

            const [row] = scheduler.listTasks();
            assert.equal(row.running, false);
            assert.equal(row.runCount, 1);
            assert.equal(row.lastRun.ok, true);
            assert.equal(row.lastRun.error, null);
            assert.equal(row.lastRun.reason, 'Test');
            assert.equal(row.lastRun.byUser, 'sysop');
            assert.ok(row.lastRun.start instanceof Date);
            assert.ok(row.lastRun.end instanceof Date);
            assert.equal(typeof row.lastRun.durationMs, 'number');

            assert.equal(statLog.sets.length, 1);
            assert.equal(statLog.sets[0].name, 'task_last_run_t');
            const persisted = JSON.parse(statLog.sets[0].value);
            assert.equal(persisted.ok, true);
            assert.equal(persisted.byUser, 'sysop');

            const started = log.entries.find(
                e => 'info' === e.level && /by hand/.test(e.msg)
            );
            assert.equal(started.obj.byUser, 'sysop');
            assert.equal(started.obj.reason, 'Test');
            const finished = log.entries.find(
                e => 'info' === e.level && /finished/.test(e.msg)
            );
            assert.equal(typeof finished.obj.durationMs, 'number');
        });

        it('takes a user object for byUser', async () => {
            await start({ t: { action: `@method:${METHODS}:ok` } });
            scheduler.runNow('t', { byUser: { username: 'NuSkooler' } });
            assert.equal(scheduler.listTasks()[0].lastRun.byUser, 'NuSkooler');
            assert.equal(scheduler.listTasks()[0].lastRun.reason, 'Manual');
        });

        it('records a failure and logs it at warn', async () => {
            await start({ t: { action: `@method:${METHODS}:fail` } });

            assert.equal(scheduler.runNow('t'), 'started');
            const { lastRun } = scheduler.listTasks()[0];
            assert.equal(lastRun.ok, false);
            assert.equal(lastRun.error, 'boom');

            const warn = log.entries.find(
                e => 'warn' === e.level && /failed/.test(e.msg)
            );
            assert.ok(warn, 'a failure is a warning');
            assert.equal(warn.obj.error, 'boom');
        });

        it('records a missing method as a failure', async () => {
            await start({ t: { action: `@method:${METHODS}:noSuchMethod` } });
            assert.equal(scheduler.runNow('t'), 'started');
            const { lastRun } = scheduler.listTasks()[0];
            assert.equal(lastRun.ok, false);
            assert.match(lastRun.error, /noSuchMethod/);
        });

        it('answers alreadyRunning while a run is in progress', async () => {
            await start({ t: { action: `@method:${METHODS}:hold` } });

            assert.equal(scheduler.runNow('t'), 'started');
            assert.equal(scheduler.listTasks()[0].running, true);
            assert.ok(scheduler.listTasks()[0].startedAt instanceof Date);
            assert.equal(scheduler.runNow('t'), 'alreadyRunning');
            assert.equal(methods.state.calls.length, 1);

            methods.state.pending[0](null);
            assert.equal(scheduler.listTasks()[0].running, false);
            assert.equal(scheduler.runNow('t'), 'started');
            assert.equal(methods.state.calls.length, 2);
        });
    });

    describe('scheduled runs', () => {
        it('logs (at info) a scheduled run skipped because the last is still going', async () => {
            await start({
                t: { schedule: 'every 1 hours', action: `@method:${METHODS}:hold` },
            });

            armed[0].fn();
            armed[0].fn();
            assert.equal(methods.state.calls.length, 1);

            const skipped = log.entries.filter(e => /still running/.test(e.msg));
            assert.equal(skipped.length, 1);
            assert.equal(skipped[0].level, 'info');
            assert.equal(skipped[0].obj.eventName, 't');
        });

        it('shares the overlap guard with runNow()', async () => {
            await start({
                t: { schedule: 'every 1 hours', action: `@method:${METHODS}:hold` },
            });

            armed[0].fn();
            assert.equal(scheduler.runNow('t'), 'alreadyRunning');
        });
    });

    //  Records the task system events for the length of a test
    function recordTaskEvents() {
        const seen = { started: [], finished: [], overdue: [] };
        const listeners = [
            [SystemEvents.TaskStarted, e => seen.started.push(e)],
            [SystemEvents.TaskFinished, e => seen.finished.push(e)],
            [SystemEvents.TaskOverdue, e => seen.overdue.push(e)],
        ];
        listeners.forEach(([event, fn]) => Events.on(event, fn));
        seen.stop = () =>
            listeners.forEach(([event, fn]) => Events.removeListener(event, fn));
        return seen;
    }

    describe('timeout', () => {
        it('keeps an overdue @method running and blocked until it calls back', async () => {
            const statLog = fakeStatLog();
            await start(
                {
                    t: {
                        schedule: 'every 1 hours',
                        action: `@method:${METHODS}:hold`,
                        timeout: 50,
                    },
                },
                statLog
            );

            const seen = recordTaskEvents();
            try {
                assert.equal(scheduler.runNow('t', { byUser: 'sysop' }), 'started');
                await until(() => seen.overdue.length > 0);

                const [overdue] = seen.overdue;
                assert.equal(overdue.name, 't');
                assert.equal(overdue.timeoutMs, 50);
                assert.equal(overdue.byUser, 'sysop');
                assert.ok(overdue.startedAt instanceof Date);

                let [row] = scheduler.listTasks();
                assert.equal(row.running, true, 'still running');
                assert.equal(row.overdue, true);
                assert.ok(row.overdueSince instanceof Date);
                assert.equal(row.stopAction, 'abandon');
                assert.equal(row.lastRun, null, 'not finished');
                assert.equal(seen.finished.length, 0);

                const warn = log.entries.find(
                    e => 'warn' === e.level && /exceeded its timeout of 50 ms/.test(e.msg)
                );
                assert.ok(warn);
                assert.match(warn.msg, /still running/);

                //  still blocked, by hand and on schedule
                assert.equal(scheduler.runNow('t'), 'alreadyRunning');
                armed[0].fn();
                assert.equal(methods.state.calls.length, 1);

                //  the method finally answers: the run finishes as usual
                methods.state.pending[0](null);
                [row] = scheduler.listTasks();
                assert.equal(row.running, false);
                assert.equal(row.overdue, false);
                assert.equal(row.overdueSince, null);
                assert.equal(row.stopAction, null);
                assert.equal(row.lastRun.ok, true);
                assert.equal(row.lastRun.overdue, true);
                assert.equal(seen.finished.length, 1);
                assert.equal(seen.finished[0].overdue, true);
                assert.equal(JSON.parse(statLog.sets[0].value).overdue, true);
            } finally {
                seen.stop();
            }
        });

        it('kills an @execute process on timeout, and records it as overdue', async function () {
            if ('win32' === process.platform) {
                this.skip();
            }
            await start({
                t: { action: '@execute:sleep', args: ['10'], timeout: 100 },
            });

            const seen = recordTaskEvents();
            try {
                const began = Date.now();
                scheduler.runNow('t');
                await until(() => !scheduler.listTasks()[0].running);
                assert.ok(Date.now() - began < 3000);

                const { lastRun } = scheduler.listTasks()[0];
                assert.equal(lastRun.ok, false);
                assert.equal(lastRun.error, 'timed out');
                assert.equal(lastRun.overdue, true);
                assert.equal(seen.overdue.length, 1, 'TaskOverdue before the kill');
                assert.ok(
                    log.entries.find(e => 'warn' === e.level && /killing it/.test(e.msg))
                );
            } finally {
                seen.stop();
            }
        });
    });

    describe('stop()', () => {
        it('answers unknown for a name it does not have, or a disabled one', async () => {
            await start({
                t: { action: `@method:${METHODS}:ok` },
                off: { action: `@method:${METHODS}:ok`, enabled: false },
            });
            assert.equal(scheduler.stop('nope'), 'unknown');
            assert.equal(scheduler.stop('off'), 'unknown');
        });

        it('answers notRunning when nothing is running', async () => {
            await start({ t: { action: `@method:${METHODS}:ok` } });
            assert.equal(scheduler.stop('t'), 'notRunning');
            scheduler.runNow('t');
            assert.equal(scheduler.stop('t'), 'notRunning');
        });

        it('kills a running @execute; the run fails when the process exits', async function () {
            if ('win32' === process.platform) {
                this.skip();
            }
            await start({ t: { action: '@execute:sleep', args: ['10'] } });

            const seen = recordTaskEvents();
            try {
                scheduler.runNow('t');
                assert.equal(scheduler.listTasks()[0].stopAction, 'kill');

                assert.equal(scheduler.stop('t', { byUser: 'sysop' }), 'killed');
                await until(() => !scheduler.listTasks()[0].running);

                const { lastRun } = scheduler.listTasks()[0];
                assert.equal(lastRun.ok, false);
                assert.equal(lastRun.error, 'stopped by sysop');
                assert.equal(lastRun.stoppedBy, 'sysop');
                assert.equal(lastRun.overdue, false);
                assert.equal(seen.finished.length, 1);

                const warn = log.entries.find(
                    e => 'warn' === e.level && /Stopping/.test(e.msg)
                );
                assert.equal(warn.obj.byUser, 'sysop');
            } finally {
                seen.stop();
            }
        });

        it('abandons a running @method, frees the task, and ignores its late callback', async () => {
            const statLog = fakeStatLog();
            await start({ t: { action: `@method:${METHODS}:hold` } }, statLog);

            const seen = recordTaskEvents();
            try {
                scheduler.runNow('t');
                assert.equal(
                    scheduler.stop('t', { byUser: { username: 'sysop' } }),
                    'abandoned'
                );

                let [row] = scheduler.listTasks();
                assert.equal(row.running, false);
                assert.equal(row.lastRun.ok, false);
                assert.equal(row.lastRun.error, 'abandoned by sysop');
                assert.equal(row.lastRun.stoppedBy, 'sysop');
                assert.equal(seen.finished.length, 1);
                assert.ok(
                    log.entries.find(e => 'warn' === e.level && /Abandoning/.test(e.msg))
                );

                //  runnable again; the new run is in progress
                assert.equal(scheduler.runNow('t'), 'started');
                assert.equal(scheduler.listTasks()[0].running, true);

                //  the abandoned method answers late: nothing of either run changes
                methods.state.pending[0](null);
                [row] = scheduler.listTasks();
                assert.equal(row.running, true, 'the newer run is untouched');
                assert.equal(row.lastRun.error, 'abandoned by sysop');
                assert.equal(seen.finished.length, 1);
                assert.equal(statLog.sets.length, 1);

                //  the newer run still finishes normally
                methods.state.pending[1](null);
                [row] = scheduler.listTasks();
                assert.equal(row.running, false);
                assert.equal(row.lastRun.ok, true);
                assert.equal(row.lastRun.stoppedBy, null);
            } finally {
                seen.stop();
            }
        });

        it('abandons an overdue @method', async () => {
            await start({ t: { action: `@method:${METHODS}:hold`, timeout: 30 } });

            scheduler.runNow('t');
            await until(() => scheduler.listTasks()[0].overdue);
            assert.equal(scheduler.stop('t'), 'abandoned');

            const { lastRun } = scheduler.listTasks()[0];
            assert.equal(lastRun.overdue, true);
            assert.equal(lastRun.error, 'abandoned by an operator');
        });
    });

    describe('timeout range', () => {
        it('clamps a timeout setTimeout cannot hold, instead of firing at once', async () => {
            //  above 2^31-1 ms (about 24.8 days) setTimeout runs the callback after 1 ms
            await start({
                t: { action: `@method:${METHODS}:hold`, timeout: 3000000000 },
            });

            assert.equal(scheduler.runNow('t'), 'started');
            await wait(100);
            assert.equal(scheduler.listTasks()[0].running, true);
            assert.equal(scheduler.listTasks()[0].timeout, 2147483647);
            methods.state.pending[0](null);
        });
    });

    describe('@execute', () => {
        it('keeps the last 20 lines of output and the exit code', async function () {
            if ('win32' === process.platform) {
                this.skip();
            }
            await start({
                t: {
                    action: '@execute:sh',
                    args: [
                        '-c',
                        //  colour codes are stripped from the tail
                        'for i in $(seq 1 30); do printf "\\033[1mline$i\\033[0m\\n"; done; exit 3',
                    ],
                },
            });

            scheduler.runNow('t');
            await until(() => scheduler.listTasks()[0].lastRun);

            const { lastRun } = scheduler.listTasks()[0];
            assert.equal(lastRun.ok, false);
            assert.equal(lastRun.exitCode, 3);
            const lines = lastRun.outputTail.split('\n');
            assert.equal(lines.length, 20);
            assert.equal(lines[0], 'line11');
            assert.equal(lines[19], 'line30');
        });
    });

    describe('last run persistence', () => {
        it('restores the last run saved by a previous start', async () => {
            const saved = {
                start: '2026-10-28T10:00:00.000Z',
                end: '2026-10-28T10:00:01.500Z',
                durationMs: 1500,
                ok: false,
                error: 'boom',
                reason: 'Schedule',
                exitCode: null,
                outputTail: null,
                byUser: null,
            };
            await start(
                { t: { action: `@method:${METHODS}:ok` } },
                fakeStatLog({ task_last_run_t: JSON.stringify(saved) })
            );

            const [row] = scheduler.listTasks();
            assert.equal(row.lastRun.ok, false);
            assert.equal(row.lastRun.error, 'boom');
            assert.ok(row.lastRun.start instanceof Date);
            assert.equal(row.lastRun.start.toISOString(), saved.start);
            assert.equal(row.runCount, 0, 'runCount counts runs since startup');
        });

        it('ignores a saved value that does not parse', async () => {
            await start(
                { t: { action: `@method:${METHODS}:ok` } },
                fakeStatLog({ task_last_run_t: '{not json' })
            );
            assert.equal(scheduler.listTasks()[0].lastRun, null);
        });
    });

    describe('a throwing system event listener', () => {
        it('does not leave the task marked running or stop it starting', async () => {
            await start({ t: { action: `@method:${METHODS}:ok` } });

            const boom = () => {
                throw new Error('listener bug');
            };
            Events.on(SystemEvents.TaskStarted, boom);
            try {
                assert.equal(scheduler.runNow('t'), 'started');
            } finally {
                Events.removeListener(SystemEvents.TaskStarted, boom);
            }

            assert.equal(methods.state.calls.length, 1);
            assert.equal(scheduler.listTasks()[0].running, false);
            assert.equal(scheduler.runNow('t'), 'started');
        });
    });

    describe('system events', () => {
        it('emits TaskStarted and TaskFinished', async () => {
            await start({ t: { action: `@method:${METHODS}:fail`, desc: 'Tee' } });

            const seen = [];
            const onStarted = e => seen.push(['started', e]);
            const onFinished = e => seen.push(['finished', e]);
            Events.on(SystemEvents.TaskStarted, onStarted);
            Events.on(SystemEvents.TaskFinished, onFinished);
            try {
                scheduler.runNow('t', { reason: 'Test', byUser: 'sysop' });
            } finally {
                Events.removeListener(SystemEvents.TaskStarted, onStarted);
                Events.removeListener(SystemEvents.TaskFinished, onFinished);
            }

            assert.equal(seen.length, 2);
            assert.deepEqual(seen[0], [
                'started',
                { name: 't', desc: 'Tee', reason: 'Test', byUser: 'sysop' },
            ]);
            assert.equal(seen[1][0], 'finished');
            const finished = seen[1][1];
            assert.equal(finished.name, 't');
            assert.equal(finished.desc, 'Tee');
            assert.equal(finished.ok, false);
            assert.equal(finished.error, 'boom');
            assert.equal(typeof finished.durationMs, 'number');
        });
    });
});

describe('tossInboundNow built-in task', () => {
    let tossInboundNow;

    before(() => {
        tossInboundNow =
            require('../core/misc_scheduled_events.js').tossInboundNowScheduledEvent;
    });

    it('fails, saying why, when nothing is listening for NewInboundBSO', function (done) {
        if (Events.listenerCount(SystemEvents.NewInboundBSO) > 0) {
            //  some other suite left an ftn_bso instance running
            this.skip();
        }
        tossInboundNow([], err => {
            assert.ok(err);
            assert.match(err.message, /not running/);
            done();
        });
    });

    it('emits NewInboundBSO when ftn_bso is listening', done => {
        const emitted = [];
        const listener = info => emitted.push(info);
        Events.on(SystemEvents.NewInboundBSO, listener);
        tossInboundNow([], err => {
            Events.removeListener(SystemEvents.NewInboundBSO, listener);
            assert.ifError(err);
            assert.equal(emitted.length, 1);
            assert.match(emitted[0].reason, /tossInboundNow/);
            done();
        });
    });
});
