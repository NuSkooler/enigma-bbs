'use strict';

//
//  core/event_scheduler.js: optional schedules (manual-only tasks), the
//  enabled / manual / timeout keys, runNow(), listTasks(), last run state and
//  its persistence, the TaskStarted / TaskFinished system events, and the
//  overlap guard, and config reload (re-arming on ConfigChanged).
//
//  later.setInterval is replaced so nothing is ever armed for real; the
//  timers it was asked for are recorded and fired by hand.
//

const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
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
                removed: false,
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

        it('stops a run from a TaskStarted listener before its action starts', async () => {
            await start({ t: { action: `@method:${METHODS}:hold` } });

            const results = [];
            const listener = event => results.push(scheduler.stop(event.name));
            Events.on(Events.getSystemEvents().TaskStarted, listener);
            try {
                scheduler.runNow('t');
            } finally {
                Events.removeListener(Events.getSystemEvents().TaskStarted, listener);
            }

            assert.deepEqual(results, ['abandoned']);
            assert.equal(methods.state.calls.length, 0, 'the action never ran');
            const [row] = scheduler.listTasks();
            assert.equal(row.running, false);
            assert.equal(row.lastRun.ok, false);
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

    describe('reload()', () => {
        const cfg = events => ({ eventScheduler: { events } });
        const liveTimers = () => armed.filter(t => !t.cleared);
        const timerOf = name => {
            const e = scheduler.events.get(name);
            return e && e.arming ? e.arming.timer : null;
        };
        const reloadLines = () =>
            log.entries.filter(
                e => 'info' === e.level && /Scheduled events reloaded/.test(e.msg)
            );

        function recordReloads() {
            const seen = [];
            const fn = e => seen.push(e);
            Events.on(SystemEvents.TasksReloaded, fn);
            seen.stop = () => Events.removeListener(SystemEvents.TasksReloaded, fn);
            return seen;
        }

        it('arms added entries, disarms removed ones, re-arms changed ones and leaves the rest', async () => {
            await start({
                keep: { schedule: 'every 1 hours', action: `@method:${METHODS}:ok` },
                gone: { schedule: 'every 2 hours', action: `@method:${METHODS}:ok` },
                edit: { schedule: 'every 3 hours', action: `@method:${METHODS}:ok` },
            });
            const keepTimer = timerOf('keep');
            const goneTimer = timerOf('gone');
            const editTimer = timerOf('edit');

            //  some run state to carry over
            assert.equal(scheduler.runNow('keep'), 'started');
            assert.equal(scheduler.runNow('edit'), 'started');
            const keepLastRun = scheduler
                .listTasks()
                .find(r => r.name === 'keep').lastRun;

            const seen = recordReloads();
            let result;
            try {
                result = scheduler.reload(
                    cfg({
                        keep: {
                            schedule: 'every 1 hours',
                            action: `@method:${METHODS}:ok`,
                        },
                        edit: {
                            schedule: 'every 4 hours',
                            action: `@method:${METHODS}:ok`,
                        },
                        fresh: {
                            schedule: 'every 5 hours',
                            action: `@method:${METHODS}:ok`,
                        },
                        freshManual: { action: `@method:${METHODS}:ok` },
                    })
                );
            } finally {
                seen.stop();
            }

            assert.deepEqual(result, {
                added: ['fresh', 'freshManual'],
                removed: ['gone'],
                changed: ['edit'],
            });

            //  unchanged: the very same timer, still live
            assert.equal(timerOf('keep'), keepTimer);
            assert.equal(keepTimer.cleared, false);
            //  removed: disarmed and gone
            assert.equal(goneTimer.cleared, true);
            assert.equal(scheduler.events.has('gone'), false);
            //  changed: old timer cleared, a new one on the new schedule
            assert.equal(editTimer.cleared, true);
            assert.notEqual(timerOf('edit'), editTimer);
            assert.equal(timerOf('edit').cleared, false);
            //  added: armed (or, manual-only, just listed)
            assert.ok(timerOf('fresh'));
            assert.equal(timerOf('freshManual'), null);
            assert.equal(liveTimers().length, 3);

            const rows = scheduler.listTasks();
            assert.deepEqual(rows.map(r => r.name).sort(), [
                'edit',
                'fresh',
                'freshManual',
                'keep',
            ]);
            const edit = rows.find(r => r.name === 'edit');
            assert.equal(edit.schedule, 'every 4 hours');
            //  runCount and lastRun carry over
            assert.equal(edit.runCount, 1);
            assert.equal(edit.lastRun.ok, true);
            const keep = rows.find(r => r.name === 'keep');
            assert.equal(keep.runCount, 1);
            assert.deepEqual(keep.lastRun, keepLastRun);

            //  one summary line, one event
            const lines = reloadLines();
            assert.equal(lines.length, 1);
            assert.match(lines[0].msg, /added fresh, freshManual/);
            assert.match(lines[0].msg, /removed gone/);
            assert.match(lines[0].msg, /changed edit/);
            assert.deepEqual([...seen], [result]);
        });

        it('treats any of the event keys as a change', async () => {
            const base = { schedule: 'every 1 hours', action: `@method:${METHODS}:ok` };
            const variants = {
                schedule: { schedule: 'every 2 hours' },
                action: { action: `@method:${METHODS}:fail` },
                args: { args: ['x'] },
                timeout: { timeout: 1000 },
                desc: { desc: 'Other' },
                confirm: { confirm: true },
                manual: { manual: false },
            };
            const events = {};
            Object.keys(variants).forEach(k => (events[k] = Object.assign({}, base)));
            await start(events);

            const next = {};
            Object.keys(variants).forEach(
                k => (next[k] = Object.assign({}, base, variants[k]))
            );
            const result = scheduler.reload(cfg(next));
            assert.deepEqual(result.changed.sort(), Object.keys(variants).sort());
            assert.equal(liveTimers().length, Object.keys(variants).length);
        });

        it('does nothing, and says nothing, when nothing changed', async () => {
            const events = {
                a: { schedule: 'every 1 hours', action: `@method:${METHODS}:ok` },
                m: { action: `@method:${METHODS}:ok` },
            };
            await start(events);
            const before = armed.length;

            const seen = recordReloads();
            try {
                //  an equal config, but new objects, as a real reload gives
                const result = scheduler.reload(cfg(JSON.parse(JSON.stringify(events))));
                assert.deepEqual(result, { added: [], removed: [], changed: [] });
            } finally {
                seen.stop();
            }

            assert.equal(armed.length, before, 'nothing re-armed');
            assert.equal(liveTimers().length, 1);
            assert.equal(reloadLines().length, 0);
            assert.equal(seen.length, 0);
        });

        it('disarms an entry now enabled: false, and arms it again when re-enabled', async () => {
            const entry = { schedule: 'every 1 hours', action: `@method:${METHODS}:ok` };
            await start({ t: entry });
            const first = timerOf('t');

            let result = scheduler.reload(
                cfg({ t: Object.assign({ enabled: false }, entry) })
            );
            assert.deepEqual(result.removed, ['t']);
            assert.equal(first.cleared, true);
            assert.equal(scheduler.runNow('t'), 'disabled');
            assert.deepEqual(scheduler.listTasks(), []);

            result = scheduler.reload(cfg({ t: entry }));
            assert.deepEqual(result.added, ['t']);
            assert.equal(liveTimers().length, 1);
            assert.equal(scheduler.runNow('t'), 'started');
        });

        it('lets a running changed task finish as it started; its next run uses the new settings', async () => {
            const statLog = fakeStatLog();
            await start(
                { t: { action: `@method:${METHODS}:hold`, args: ['old'], desc: 'Old' } },
                statLog
            );

            const seen = recordTaskEvents();
            try {
                assert.equal(scheduler.runNow('t'), 'started');
                const result = scheduler.reload(
                    cfg({
                        t: {
                            action: `@method:${METHODS}:hold`,
                            args: ['new'],
                            desc: 'New',
                        },
                    })
                );
                assert.deepEqual(result.changed, ['t']);

                let [row] = scheduler.listTasks();
                assert.equal(row.running, true, 'not interrupted');
                assert.equal(row.desc, 'New');
                assert.equal(row.removed, false);
                assert.equal(scheduler.runNow('t'), 'alreadyRunning', 'still guarded');

                methods.state.pending[0](null);
                [row] = scheduler.listTasks();
                assert.equal(row.running, false);
                assert.equal(row.lastRun.ok, true);
                assert.equal(row.runCount, 1);
                assert.equal(seen.finished.length, 1);
                assert.equal(seen.finished[0].desc, 'Old', 'finished as it started');
                assert.equal(statLog.sets.length, 1);

                assert.equal(scheduler.runNow('t'), 'started');
                assert.deepEqual(methods.state.calls[1].args, ['new']);
                assert.equal(seen.started[1].desc, 'New');
                methods.state.pending[1](null);
            } finally {
                seen.stop();
            }
        });

        it('keeps the timeout a running task started with', async () => {
            await start({ t: { action: `@method:${METHODS}:hold`, timeout: 60000 } });
            scheduler.runNow('t');
            scheduler.reload(
                cfg({ t: { action: `@method:${METHODS}:hold`, timeout: 30 } })
            );
            await wait(100);
            assert.equal(scheduler.listTasks()[0].overdue, false);
            methods.state.pending[0](null);
        });

        it('keeps a removed task listed, marked removed, until its run finishes', async () => {
            const statLog = fakeStatLog();
            await start(
                {
                    t: { schedule: 'every 1 hours', action: `@method:${METHODS}:hold` },
                    other: { action: `@method:${METHODS}:ok` },
                },
                statLog
            );
            const timer = timerOf('t');

            const seen = recordTaskEvents();
            try {
                armed[0].fn();
                const result = scheduler.reload(
                    cfg({ other: { action: `@method:${METHODS}:ok` } })
                );
                assert.deepEqual(result.removed, ['t']);
                assert.equal(timer.cleared, true, 'disarmed at once');

                let row = scheduler.listTasks().find(r => r.name === 't');
                assert.ok(row, 'still listed while it runs');
                assert.equal(row.removed, true);
                assert.equal(row.running, true);
                assert.equal(row.nextRun, null);
                assert.equal(scheduler.runNow('t'), 'alreadyRunning');

                //  a second reload does not report it again
                assert.deepEqual(
                    scheduler.reload(cfg({ other: { action: `@method:${METHODS}:ok` } })),
                    { added: [], removed: [], changed: [] }
                );

                methods.state.pending[0](null);
                assert.equal(seen.finished.length, 1, 'TaskFinished as usual');
                assert.equal(seen.finished[0].ok, true);
                assert.equal(statLog.sets.length, 1, 'lastRun saved as usual');

                row = scheduler.listTasks().find(r => r.name === 't');
                assert.equal(row, undefined, 'gone once finished');
                assert.equal(scheduler.runNow('t'), 'unknown');
            } finally {
                seen.stop();
            }
        });

        it('lets stop() end a removed running task, which then goes', async () => {
            await start({ t: { action: `@method:${METHODS}:hold` } });
            scheduler.runNow('t');
            scheduler.reload(cfg({}));
            assert.equal(scheduler.stop('t', { byUser: 'sysop' }), 'abandoned');
            assert.deepEqual(scheduler.listTasks(), []);
        });

        it('takes back a removed task that returns while its old run is still going', async () => {
            const entry = {
                schedule: 'every 1 hours',
                action: `@method:${METHODS}:hold`,
            };
            await start({ t: entry });
            armed[0].fn();

            scheduler.reload(cfg({}));
            const result = scheduler.reload(cfg({ t: entry }));
            assert.deepEqual(result.added, ['t']);
            assert.equal(liveTimers().length, 1);

            let [row] = scheduler.listTasks();
            assert.equal(row.removed, false);
            assert.equal(row.running, true);

            methods.state.pending[0](null);
            [row] = scheduler.listTasks();
            assert.equal(row.name, 't', 'kept after the old run finished');
            assert.equal(row.runCount, 1);
        });

        it('logs and skips an invalid entry without disarming the rest', async () => {
            await start({
                a: { schedule: 'every 1 hours', action: `@method:${METHODS}:ok` },
                b: { schedule: 'every 2 hours', action: `@method:${METHODS}:ok` },
            });
            const aTimer = timerOf('a');
            const bTimer = timerOf('b');

            const result = scheduler.reload(
                cfg({
                    a: { schedule: 'every 1 hours', action: `@method:${METHODS}:ok` },
                    b: { schedule: 'evry 2 hourz', action: `@method:${METHODS}:ok` },
                    c: { schedule: 'every 3 hours' },
                    d: {
                        schedule: '@watch:/no/such/dir/for/enigma/tests/file',
                        action: `@method:${METHODS}:ok`,
                    },
                })
            );

            assert.equal(aTimer.cleared, false, 'the rest stays armed');
            assert.equal(timerOf('a'), aTimer);
            //  as at startup, an entry that does not load is not there
            assert.equal(bTimer.cleared, true);
            assert.deepEqual(result.removed, ['b']);
            //  an unwatchable file is logged, not thrown
            assert.deepEqual(result.added, ['d']);

            const invalid = log.entries
                .filter(e => 'warn' === e.level && /Invalid scheduled event/.test(e.msg))
                .map(e => e.obj.eventName)
                .sort();
            assert.deepEqual(invalid, ['b', 'c']);
            assert.ok(
                log.entries.find(
                    e => 'warn' === e.level && /Cannot watch the file/.test(e.msg)
                )
            );
        });

        it('leaves one timer after two reloads in a row', async () => {
            const entry = s => ({ schedule: s, action: `@method:${METHODS}:ok` });
            await start({ t: entry('every 1 hours') });

            scheduler.reload(cfg({ t: entry('every 2 hours') }));
            scheduler.reload(cfg({ t: entry('every 3 hours') }));
            scheduler.reload(cfg({ t: entry('every 3 hours') }));

            assert.equal(armed.length, 3);
            assert.equal(liveTimers().length, 1);
            assert.equal(liveTimers()[0], timerOf('t'));
            assert.equal(scheduler.listTasks()[0].schedule, 'every 3 hours');
            assert.equal(reloadLines().length, 2);
        });

        it('reloads when the config changes', async () => {
            await start({});
            let calls = 0;
            scheduler.reload = () => calls++;
            Events.emit(SystemEvents.ConfigChanged);
            assert.equal(calls, 1);

            const s = scheduler;
            scheduler = null;
            await new Promise(resolve => s.shutdown(resolve));
            Events.emit(SystemEvents.ConfigChanged);
            assert.equal(calls, 1, 'not after shutdown');
        });

        describe('@watch watchers', () => {
            let dir;

            beforeEach(() => {
                dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enigma-sched-test-'));
            });

            afterEach(() => {
                fs.rmSync(dir, { recursive: true, force: true });
            });

            const watchEntry = file => ({
                schedule: `@watch:${path.join(dir, file)}`,
                action: `@method:${METHODS}:ok`,
            });
            const watcherOf = name => scheduler.events.get(name).arming.watcher;
            const isClosed = w => 0 === Object.keys(w.watched).length;

            it('closes the watcher of a removed entry', async () => {
                await start({ w: watchEntry('trigger') });
                const arming = scheduler.events.get('w').arming;
                const watcher = arming.watcher;
                await until(() => arming.watcherReady);
                assert.equal(isClosed(watcher), false);

                scheduler.reload(cfg({}));
                assert.equal(isClosed(watcher), true);
            });

            it('closes a watcher removed before it was ready, once it is', async () => {
                fs.mkdirSync(path.join(dir, 'sub'));
                await start({ w: watchEntry('trigger') });
                const watcher = watcherOf('w');

                scheduler.reload(cfg({ w: watchEntry('other') }));
                scheduler.reload(cfg({}));
                await until(() => isClosed(watcher));
                //  closed for good: closing it early would leave the walk of
                //  the tree still in progress to watch 'sub' after this
                await wait(150);
                assert.deepEqual(Object.keys(watcher.watched), []);
            });

            it('closes watchers at shutdown', async () => {
                await start({ w: watchEntry('trigger') });
                const arming = scheduler.events.get('w').arming;
                const watcher = arming.watcher;
                await until(() => arming.watcherReady);

                const s = scheduler;
                scheduler = null;
                await new Promise(resolve => s.shutdown(resolve));
                assert.equal(isClosed(watcher), true);
            });

            it('runs a changed entry for an existing file only when its watch path changed', async () => {
                fs.writeFileSync(path.join(dir, 'a'), '');
                fs.writeFileSync(path.join(dir, 'b'), '');
                await start({ w: watchEntry('a') });
                await until(() => methods.state.calls.length === 1);

                scheduler.reload(
                    cfg({ w: Object.assign({ desc: 'D' }, watchEntry('a')) })
                );
                await wait(50);
                assert.equal(methods.state.calls.length, 1, 'same file: not run again');

                scheduler.reload(cfg({ w: watchEntry('b') }));
                await until(() => methods.state.calls.length === 2);
            });
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
