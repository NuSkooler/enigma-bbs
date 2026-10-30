'use strict';

const { strict: assert } = require('assert');
const { EventEmitter } = require('events');

const configModule = require('../core/config.js');
const Events = require('../core/events.js');
const SysEvents = require('../core/system_events.js');

const TaskEvents = [SysEvents.TaskStarted, SysEvents.TaskFinished, SysEvents.TaskOverdue];

//  eslint-disable-next-line no-control-regex
const stripAnsi = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

function makeClient() {
    const client = new EventEmitter();
    client.node = 1;
    client.user = { username: 'Sysop', setVisibility: () => {}, isVisible: () => true };
    client.written = [];
    client.term = {
        termHeight: 25,
        termWidth: 80,
        rawWrite: () => {},
        write: (d, c, cb) => {
            client.written.push(d);
            if (cb) {
                cb();
            }
        },
    };
    client.log = { trace: () => {}, warn: () => {}, debug: () => {}, info: () => {} };
    client.currentTheme = {
        helpers: {
            getDateFormat: () => 'YYYY-MM-DD',
            getTimeFormat: () => 'HH:mm',
            getDateTimeFormat: () => 'YYYY-MM-DD HH:mm',
        },
    };
    client.startIdleMonitor = () => {};
    client.stopIdleMonitor = () => {};
    return client;
}

//  listTasks() rows, as the scheduler hands them out
function row(name, patch = {}) {
    return Object.assign(
        {
            name,
            desc: name,
            schedule: null,
            watchFile: null,
            manualOnly: true,
            nextRun: null,
            actionType: 'method',
            action: '@method:x.js:y',
            args: [],
            running: false,
            startedAt: null,
            overdue: false,
            overdueSince: null,
            stopAction: null,
            lastRun: null,
            runCount: 0,
            confirm: false,
            timeout: null,
        },
        patch
    );
}

function fakeScheduler(rows) {
    const sched = {
        rows,
        runs: [],
        stops: [],
        listCalls: 0,
        listTasks() {
            sched.listCalls++;
            return sched.rows.map(r => Object.assign({}, r));
        },
        runNow(name, opts) {
            sched.runs.push({ name, opts });
            return 'started';
        },
        stop(name, opts) {
            sched.stops.push({ name, opts });
            const r = sched.rows.find(x => x.name === name);
            return r && 'abandon' === r.stopAction ? 'abandoned' : 'killed';
        },
    };
    return sched;
}

function makeWfc(configPatch = {}, rows = []) {
    const WfcModule = require('../core/wfc.js').getModule;
    const client = makeClient();
    const instance = new WfcModule({
        menuName: 'mainMenuWaitingForCaller',
        menuConfig: { config: Object.assign({ acs: 'SCID1', art: {} }, configPatch) },
        client,
    });
    instance._refreshAll = () => {};
    const scheduler = fakeScheduler(rows);
    instance._scheduler = () => scheduler;
    return { instance, client, scheduler };
}

describe('WFC task screen', () => {
    let previousConfig;

    before(() => {
        previousConfig = configModule._pushTestConfig({
            menus: { cls: false },
            general: { boardName: 'Test Board' },
        });
    });

    after(() => {
        configModule._popTestConfig(previousConfig);
    });

    describe('row format', () => {
        it('shows a never-run manual task with the manual label and defaults', () => {
            const { instance } = makeWfc();
            const obj = instance._taskFormatObj(row('optimizeDatabases'), 0);

            assert.equal(obj.index, 1);
            assert.equal(obj.desc, 'optimizeDatabases'); //  falls back to name
            assert.equal(obj.schedule, 'manual');
            assert.equal(obj.nextRun, '-');
            assert.equal(obj.status, 'never');
            assert.equal(obj.statusIndicator, '-');
            assert.equal(obj.lastRunAt, 'never');
            assert.equal(obj.lastResult, 'never');
            assert.equal(obj.duration, '');
            assert.equal(obj.runCount, 0);
        });

        it('formats a failed last run', () => {
            const { instance } = makeWfc({ taskDateTimeFormat: 'HH:mm' });
            const start = new Date(2026, 9, 29, 4, 5, 0);
            const obj = instance._taskFormatObj(
                row('backup', {
                    desc: 'Back up databases',
                    schedule: 'at 4:00 am',
                    manualOnly: false,
                    nextRun: new Date(2026, 9, 30, 4, 0, 0),
                    runCount: 3,
                    lastRun: {
                        start,
                        end: new Date(start.getTime() + 245000),
                        durationMs: 245000,
                        ok: false,
                        error: 'Exit code 2',
                        reason: 'wfc',
                        exitCode: 2,
                        byUser: 'Sysop',
                    },
                }),
                1
            );

            assert.equal(obj.desc, 'Back up databases');
            assert.equal(obj.schedule, 'at 4:00 am');
            assert.equal(obj.nextRun, '04:00');
            assert.equal(obj.lastRunAt, '04:05');
            assert.equal(obj.status, 'failed');
            assert.equal(obj.statusIndicator, 'X');
            assert.equal(obj.lastResult, 'failed');
            assert.equal(obj.lastError, 'Exit code 2');
            assert.equal(obj.durationMs, 245000);
            assert.equal(obj.duration, '4m 05s');
            assert.equal(obj.byUser, 'Sysop');
            assert.equal(obj.exitCode, 2);
            assert.equal(obj.runCount, 3);
        });

        it('shows a running overdue task, and what stopping it does', () => {
            const { instance } = makeWfc();
            const obj = instance._taskFormatObj(
                row('slow', {
                    running: true,
                    startedAt: new Date(Date.now() - 1500),
                    overdue: true,
                    overdueSince: new Date(),
                    stopAction: 'abandon',
                }),
                0
            );
            assert.equal(obj.status, 'overdue');
            assert.equal(obj.statusIndicator, '!');
            assert.equal(obj.stopVerb, 'Abandon');
            assert.ok(/^1\.\ds$/.test(obj.elapsed), obj.elapsed);
        });

        it('takes indicators, labels and stop verbs from config', () => {
            const { instance } = makeWfc({
                taskStatusIndicators: { running: '|11R' },
                taskManualScheduleText: 'on demand',
                taskStopVerbs: { kill: 'Terminate' },
            });
            const obj = instance._taskFormatObj(
                row('t', { running: true, stopAction: 'kill', startedAt: new Date() }),
                0
            );
            assert.equal(obj.statusIndicator, '|11R');
            assert.equal(obj.schedule, 'on demand');
            assert.equal(obj.stopVerb, 'Terminate');
            //  unconfigured ones keep their defaults
            assert.equal(
                instance._taskFormatObj(row('u', { lastRun: { ok: true } }), 0)
                    .statusIndicator,
                '+'
            );
        });

        it('formats durations at each scale', () => {
            const { instance } = makeWfc();
            const d = ms =>
                instance._taskFormatObj(
                    row('t', { lastRun: { ok: true, durationMs: ms } }),
                    0
                ).duration;
            assert.equal(d(850), '850ms');
            assert.equal(d(12340), '12.3s');
            assert.equal(d(245000), '4m 05s');
            assert.equal(d(3720000), '1h 02m');
        });
    });

    describe('detail pane', () => {
        it('shows the last run in full, with the output tail', () => {
            const { instance } = makeWfc();
            const text = instance._formatTaskDetailText(
                row('script', {
                    desc: 'My script',
                    schedule: 'every 1 hours',
                    nextRun: new Date(),
                    lastRun: {
                        start: new Date(),
                        durationMs: 1200,
                        ok: false,
                        error: 'stopped by Sysop',
                        reason: 'wfc',
                        byUser: 'Sysop',
                        exitCode: 0,
                        stoppedBy: 'Sysop',
                        overdue: true,
                        outputTail: 'line one\nline |07two',
                    },
                })
            );

            const plain = text.replace(/\|\d\d/g, '');
            [
                'My script (script)',
                'Schedule: every 1 hours',
                'Next run:',
                'Status: idle',
                'Result: failed: stopped by Sysop',
                'Duration: 1.2s',
                'Reason: wfc',
                'By: Sysop',
                'Exit code: 0',
                'Stopped by: Sysop',
                'Overdue: yes',
                'line one',
            ].forEach(want => assert.ok(plain.includes(want), `missing "${want}"`));

            //  output cannot inject colour codes
            assert.ok(text.includes('line ||07two'));
        });

        it('shows a run in progress', () => {
            const { instance } = makeWfc();
            const text = instance._formatTaskDetailText(
                row('slow', {
                    running: true,
                    startedAt: new Date(),
                    overdue: true,
                    overdueSince: new Date(),
                    stopAction: 'kill',
                })
            );
            assert.ok(/Status\|07: running since .+, overdue since /.test(text), text);
            assert.ok(text.includes('kills its process'));
            assert.ok(text.includes('Last run|07: never'));
        });

        it('wraps the text to the view width before handing it over (#968)', () => {
            const {
                MultiLineEditTextView,
            } = require('../core/multi_line_edit_text_view.js');
            const { instance } = makeWfc();
            const view = Object.create(MultiLineEditTextView.prototype);
            view.dimens = { width: 20, height: 5 };
            let handed;
            view.setAnsi = (text, opts) => {
                handed = { text, opts };
            };

            instance._setWrappedText(
                view,
                '|07the quick brown fox jumps over the lazy dog\nsecond line here and more words'
            );

            const lines = stripAnsi(handed.text).split(/\r?\n/);
            assert.ok(lines.length >= 5, `not wrapped: ${JSON.stringify(lines)}`);
            lines.forEach(l =>
                assert.ok(l.length <= 20, `"${l}" is wider than the view`)
            );
            assert.ok(stripAnsi(handed.text).includes('fox'));
            assert.equal(handed.opts.forceLineTerm, true);
        });
    });

    describe('confirm', () => {
        it('asks before running only a task that says so, and always before stopping', () => {
            const { instance } = makeWfc();
            assert.equal(
                instance._taskNeedsConfirm('run', row('a', { confirm: true })),
                true
            );
            assert.equal(
                instance._taskNeedsConfirm('run', row('a', { confirm: false })),
                false
            );
            assert.equal(
                instance._taskNeedsConfirm('stop', row('a', { confirm: false })),
                true
            );
        });

        it('words the question by what stopping will do', () => {
            const { instance } = makeWfc();
            assert.equal(
                instance._taskPromptQuestion(
                    'stop',
                    row('a', { desc: 'A', stopAction: 'kill' })
                ),
                'Kill A?'
            );
            assert.equal(
                instance._taskPromptQuestion(
                    'stop',
                    row('a', { desc: 'A', stopAction: 'abandon' })
                ),
                'Abandon A?'
            );
            assert.equal(
                instance._taskPromptQuestion('run', row('a', { desc: 'A' })),
                'Run A?'
            );

            const custom = makeWfc({ runTaskPromptFormat: 'Go {name} now?' }).instance;
            assert.equal(custom._taskPromptQuestion('run', row('a')), 'Go a now?');
        });

        function openTextScreen(rows, configPatch) {
            const ctx = makeWfc(configPatch, rows);
            ctx.instance._displayTasksPage(() => {});
            assert.equal(ctx.instance._tasksMode, 'text');
            return ctx;
        }

        it('runs a task without confirm straight away, as the op', () => {
            const { instance, client, scheduler } = openTextScreen([row('a')]);
            client.emit('key press', 'r', { name: 'r' });

            assert.deepEqual(scheduler.runs, [
                { name: 'a', opts: { reason: 'wfc', byUser: 'Sysop' } },
            ]);
            assert.ok(instance._taskActionResult.includes('Started'));
            instance._teardownTasks();
        });

        it('runs a confirm task only on yes', () => {
            const { instance, client, scheduler } = openTextScreen([
                row('a', { confirm: true }),
            ]);

            client.emit('key press', '\r', { name: 'return' });
            assert.equal(scheduler.runs.length, 0, 'ran before asking');
            assert.equal(instance._taskPromptActive, true);
            assert.ok(client.written.some(w => stripAnsi(w).includes('Run a?')));

            client.emit('key press', 'n', { name: 'n' });
            assert.equal(scheduler.runs.length, 0, 'ran on no');
            assert.equal(instance._taskPromptActive, false);

            client.emit('key press', 'r', { name: 'r' });
            client.emit('key press', 'y', { name: 'y' });
            assert.equal(scheduler.runs.length, 1);
            instance._teardownTasks();
        });

        it('stops only after asking, and says when there is nothing to stop', () => {
            const { instance, client, scheduler } = openTextScreen([
                row('idle'),
                row('busy', {
                    running: true,
                    startedAt: new Date(),
                    stopAction: 'abandon',
                }),
            ]);

            client.emit('key press', 'x', { name: 'x' });
            assert.equal(instance._taskPromptActive, false, 'asked to stop an idle task');
            assert.ok(instance._taskActionResult.includes('not running'));

            client.emit('key press', null, { name: 'down arrow' });
            assert.equal(instance._selectedTaskName, 'busy');
            client.emit('key press', 'x', { name: 'x' });
            assert.equal(instance._taskPromptActive, true);
            assert.ok(client.written.some(w => stripAnsi(w).includes('Abandon busy?')));
            assert.equal(scheduler.stops.length, 0);

            client.emit('key press', 'y', { name: 'y' });
            assert.deepEqual(scheduler.stops, [
                { name: 'busy', opts: { byUser: 'Sysop' } },
            ]);
            assert.ok(instance._taskActionResult.includes('Abandoned'));
            instance._teardownTasks();
        });

        it('does not stop a run that started after the op was asked', () => {
            const first = new Date(Date.now() - 60000);
            const { instance, client, scheduler } = openTextScreen([
                row('busy', { running: true, startedAt: first, stopAction: 'kill' }),
            ]);

            client.emit('key press', 'x', { name: 'x' });
            assert.equal(instance._taskPromptActive, true);

            //  while the prompt is up the run ends and its schedule starts another
            scheduler.rows = [
                row('busy', { running: true, startedAt: new Date(), stopAction: 'kill' }),
            ];
            client.emit('key press', 'y', { name: 'y' });

            assert.equal(scheduler.stops.length, 0);
            assert.ok(instance._taskActionResult.includes('started again'));
            instance._teardownTasks();
        });

        it('still follows the list selection after a prompt (art)', () => {
            const { instance, client } = makeWfc({}, [
                row('a', { confirm: true }),
                row('b'),
            ]);
            const list = new EventEmitter();
            list.setItems = items => (list.items = items);
            list.setFocusItemIndex = i => (list.focus = i);
            instance.getView = (form, id) => ('tasks' === form && 1 === id ? list : null);
            instance._tasksMode = 'art';
            //  like the real ViewController: losing focus drops every view listener
            instance.viewControllers.tasks = {
                setFocus: focused => {
                    if (!focused) {
                        list.removeAllListeners();
                    }
                },
                detachClientEvents: () => {},
                getView: () => null,
            };
            try {
                instance._bindTaskListIndex();
                instance._refreshTasks();

                //  form 5's R key; 'a' asks first
                instance._requestTaskAction('run', () => {});
                assert.equal(instance._taskPromptActive, true);
                client.emit('key press', 'n', { name: 'n' });
                assert.equal(instance._taskPromptActive, false);

                list.emit('index update', 1);
                assert.equal(instance._selectedTaskName, 'b');
            } finally {
                instance._teardownTasks();
            }
        });

        it('ignores screen keys while the prompt is up', () => {
            const { instance, client, scheduler } = openTextScreen([
                row('a', { confirm: true }),
            ]);
            client.emit('key press', 'r', { name: 'r' });
            //  'q' answers the prompt (no); it must not also leave the screen
            client.emit('key press', 'q', { name: 'q' });
            assert.equal(instance._tasksMode, 'text');
            assert.equal(scheduler.runs.length, 0);
            instance._teardownTasks();
        });
    });

    describe('refresh', () => {
        it('keeps the selection on the same task by name', () => {
            const { instance, scheduler } = makeWfc({}, [row('a'), row('b'), row('c')]);
            instance._displayTasksPage(() => {});
            instance._selectedTaskName = 'b';
            instance._selectedTaskIndex = 1;

            scheduler.rows = [row('new'), row('a'), row('b'), row('c')];
            instance._refreshTasks();
            assert.equal(instance._selectedTaskName, 'b');
            assert.equal(instance._selectedTaskIndex, 2);

            //  gone: same position, clamped
            scheduler.rows = [row('new'), row('a')];
            instance._refreshTasks();
            assert.equal(instance._selectedTaskIndex, 1);
            assert.equal(instance._selectedTaskName, 'a');

            scheduler.rows = [];
            instance._refreshTasks();
            assert.equal(instance._selectedTaskName, null);
            instance._teardownTasks();
        });

        it('keeps the list view on the selected task across a refresh', () => {
            const { instance, scheduler } = makeWfc({}, [row('a'), row('b')]);
            const list = new EventEmitter();
            list.setItems = items => {
                list.items = items;
                list.focus = 0;
            };
            list.setFocusItemIndex = i => (list.focus = i);
            instance.getView = (form, id) => ('tasks' === form && 1 === id ? list : null);
            instance._tasksMode = 'art';
            instance.viewControllers.tasks = {
                detachClientEvents: () => {},
                getView: () => null,
            };

            instance._selectedTaskName = 'b';
            instance._refreshTasks();
            assert.equal(list.focus, 1);

            scheduler.rows = [row('b'), row('a')];
            instance._refreshTasks();
            assert.equal(list.focus, 0);
            assert.equal(list.items[0].name, 'b');
            instance._teardownTasks();
        });

        it('refreshes every second while a task runs, else every five', () => {
            const { instance, scheduler } = makeWfc({}, [row('a')]);
            instance._displayTasksPage(() => {});
            assert.equal(instance._tasksRefreshDelayMs, 5000);

            scheduler.rows = [row('a', { running: true, startedAt: new Date() })];
            instance._refreshTasks();
            assert.equal(instance._tasksRefreshDelayMs, 1000);
            instance._teardownTasks();
        });

        it('refreshes at once on a task event', () => {
            const { instance, scheduler } = makeWfc({}, [row('a')]);
            instance._displayTasksPage(() => {});
            TaskEvents.forEach(eventName => {
                const before = scheduler.listCalls;
                Events.emit(eventName, { name: 'a', desc: 'a', ok: true });
                assert.ok(scheduler.listCalls > before, `${eventName} did not refresh`);
            });
            instance._teardownTasks();
        });

        it('does not paint over the dashboard once the op has gone back', () => {
            const { instance, client, scheduler } = makeWfc({}, [row('a')]);
            instance._displayTasksPage(() => {});
            instance._teardownTasks();
            assert.equal(instance._mainFormOwnsScreen(), false); //  no form 0 in this test

            const listCalls = scheduler.listCalls;
            const writes = client.written.length;
            Events.emit(SysEvents.TaskFinished, { name: 'a', ok: true });
            instance._refreshTasks();
            assert.equal(scheduler.listCalls, listCalls);
            assert.equal(client.written.length, writes);
        });

        it('keeps the dashboard from painting while the task screen is up', () => {
            const { instance } = makeWfc({}, [row('a')]);
            instance.viewControllers.main = { detachClientEvents: () => {} };
            assert.equal(instance._mainFormOwnsScreen(), true);
            instance._displayTasksPage(() => {});
            assert.equal(instance.viewControllers.main, undefined, 'form 0 kept');
            assert.equal(instance._mainFormOwnsScreen(), false);
            instance._teardownTasks();
        });
    });

    describe('cleanup', () => {
        function counts(client) {
            return {
                events: TaskEvents.map(e => Events.listenerCount(e)),
                keys: client.listenerCount('key press'),
            };
        }

        it('removes every listener and timer on the way back to the dashboard', () => {
            const { instance, client } = makeWfc({}, [row('a', { confirm: true })]);
            const before = counts(client);

            for (let i = 0; i < 3; ++i) {
                instance._displayTasksPage(() => {});
                client.emit('key press', 'r', { name: 'r' }); //  leave a prompt up
                assert.ok(instance._tasksRefreshTimer, 'no refresh timer');
                instance._teardownTasks();
            }

            assert.deepEqual(counts(client), before);
            assert.equal(instance._tasksRefreshTimer, undefined);
            assert.equal(instance._tasksMode, null);
        });

        it('removes them in leave() too', () => {
            const { instance, client } = makeWfc({}, [row('a')]);
            const before = counts(client);

            instance._displayTasksPage(() => {});
            assert.notDeepEqual(counts(client), before);
            instance.leave();

            assert.deepEqual(counts(client), before);
            assert.equal(instance._tasksRefreshTimer, undefined);
        });

        it('leaves the screen with q from the text list', () => {
            const { instance, client } = makeWfc({}, [row('a')]);
            let mainShown = false;
            instance._displayMainPage = (clear, cb) => {
                mainShown = true;
                return cb(null);
            };
            const before = counts(client);
            instance._displayTasksPage(() => {});
            client.emit('key press', 'q', { name: 'q' });
            assert.equal(mainShown, true);
            assert.deepEqual(counts(client), before);
        });
    });

    describe('status bar', () => {
        it('counts running tasks in a "tasks" panel, with a default format', () => {
            const { instance } = makeWfc({}, [
                row('a', { running: true }),
                row('b', { running: true }),
                row('c'),
            ]);
            const view = { panels: {} };
            view.getPanelNames = () => ['tasks'];
            view.setPanels = u => Object.assign(view.panels, u);
            instance.getView = (form, id) => ('main' === form && 5 === id ? view : null);

            instance._updateStatusBarPanels();
            assert.equal(view.panels.tasks, 'TASK 2');
        });
    });
});

describe('WFC ticker task events', () => {
    let previousConfig;

    before(() => {
        previousConfig = configModule._pushTestConfig({
            menus: { cls: false },
            general: { boardName: 'Test Board' },
        });
    });

    after(() => {
        configModule._popTestConfig(previousConfig);
    });

    function feed(configPatch, emit) {
        const { instance } = makeWfc(configPatch);
        instance._startActivityFeed();
        try {
            emit();
        } finally {
            instance._stopActivityFeed();
        }
        return instance.tickerFeed || [];
    }

    it('shows a failed run and an overdue one by default', () => {
        const items = feed({}, () => {
            Events.emit(SysEvents.TaskFinished, {
                name: 'backup',
                desc: 'Back up',
                ok: false,
                error: 'disk full',
                durationMs: 10,
            });
            Events.emit(SysEvents.TaskOverdue, { name: 'slow', desc: 'Slow one' });
        });
        assert.equal(items.length, 2);
        assert.ok(items[0].includes('Back up') && items[0].includes('disk full'));
        assert.ok(items[1].includes('Slow one') && items[1].includes('overdue'));
    });

    it('keeps a pipe in an error from becoming a colour code', () => {
        const items = feed({}, () => {
            Events.emit(SysEvents.TaskFinished, {
                name: 'x',
                desc: 'A|12B',
                ok: false,
                error: 'bad |07 pipe',
            });
        });
        assert.ok(items[0].includes('A||12B'));
        assert.ok(items[0].includes('bad ||07 pipe'));
    });

    it('keeps starts and good finishes off by default', () => {
        const items = feed({}, () => {
            Events.emit(SysEvents.TaskStarted, { name: 'a', desc: 'a' });
            Events.emit(SysEvents.TaskFinished, { name: 'a', desc: 'a', ok: true });
        });
        assert.equal(items.length, 0);
    });

    it('shows them when configured, with task tokens', () => {
        const items = feed(
            {
                ticker: {
                    events: {
                        taskStarted: '{taskDesc} by {byUser}',
                        taskFinished: '{taskName} done in {duration}',
                    },
                },
            },
            () => {
                Events.emit(SysEvents.TaskStarted, {
                    name: 'a',
                    desc: 'Task A',
                    byUser: 'Sysop',
                });
                Events.emit(SysEvents.TaskFinished, {
                    name: 'a',
                    ok: true,
                    durationMs: 1500,
                });
            }
        );
        assert.deepEqual(items, ['Task A by Sysop', 'a done in 1.5s']);
    });

    it('falls back to taskFinished for a failure when taskFailed is switched off', () => {
        const items = feed(
            { ticker: { events: { taskFailed: '', taskFinished: '{taskName} ended' } } },
            () => Events.emit(SysEvents.TaskFinished, { name: 'a', ok: false })
        );
        assert.deepEqual(items, ['a ended']);
    });
});
