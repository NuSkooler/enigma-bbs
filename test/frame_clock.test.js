'use strict';

const { strict: assert } = require('assert');
const events = require('events');

const configModule = require('../core/config.js');
const { View } = require('../core/view.js');
const { Client } = require('../core/client.js');
const { ViewController } = require('../core/view_controller.js');
const { EditTextView } = require('../core/edit_text_view.js');
const FrameClock = require('../core/frame_clock.js');
const { ClientTerminal } = require('../core/client_term.js');

//
//  The per-client frame clock: one timer per client, every view due on a
//  tick drawn in one batch (one hide/restore, one socket write), the
//  minimum interval, and exactly drawInBackground()'s rules per view:
//  covers (creation order, { menu }, { forms }), one redraw owed after a
//  cover, pauseWhenInactive, destroyed views, the focus cursor. No timer
//  survives destroy, menu leave or disconnect.
//

const MENU_CONFIG = {
    debug: { assertsEnabled: false },
    menus: { cls: false },
    general: { boardName: 'Test' },
};

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

//  setTimeout / clearTimeout / Date.now under the test's control
function fakeTime() {
    const saved = {
        setTimeout: global.setTimeout,
        clearTimeout: global.clearTimeout,
        now: Date.now,
    };
    let now = 1000000;
    let nextId = 0;
    const timers = new Map();
    global.setTimeout = (fn, ms) => {
        const timer = { id: ++nextId, at: now + Math.max(0, Number(ms) || 0), fn };
        timers.set(timer.id, timer);
        return timer;
    };
    global.clearTimeout = timer => {
        if (timer) {
            timers.delete(timer.id);
        }
    };
    Date.now = () => now;
    return {
        get now() {
            return now;
        },
        //  timers still pending
        live() {
            return timers.size;
        },
        //  delays of the pending timers, from now
        pending() {
            return [...timers.values()].map(t => t.at - now);
        },
        //  move time on by |ms| without firing anything (a busy event loop)
        jump(ms) {
            now += ms;
        },
        //  move time on by |ms|, firing timers as they come due
        advance(ms) {
            const end = now + ms;
            for (;;) {
                let next = null;
                for (const t of timers.values()) {
                    if (t.at <= end && (!next || t.at < next.at)) {
                        next = t;
                    }
                }
                if (!next) {
                    break;
                }
                timers.delete(next.id);
                now = Math.max(now, next.at);
                next.fn();
            }
            now = end;
        },
        restore() {
            global.setTimeout = saved.setTimeout;
            global.clearTimeout = saved.clearTimeout;
            Date.now = saved.now;
        },
    };
}

//  Records socket writes; beginWrite() / commitWrite() batch as
//  ClientTerminal's do, so one entry is one write
function makeTerm() {
    const term = { termWidth: 80, termHeight: 25, flushes: [], _batch: null, _depth: 0 };
    const out = s => {
        s = Buffer.isBuffer(s) ? s.toString('latin1') : String(s);
        if (term._batch) {
            term._batch.push(s);
        } else {
            term.flushes.push(s);
        }
    };
    term.write = out;
    term.rawWrite = out;
    term.beginWrite = () => {
        if (!term._batch) {
            term._batch = [];
            term._depth = 0;
        }
        ++term._depth;
    };
    term.commitWrite = () => {
        if (!term._batch || --term._depth > 0) {
            return;
        }
        const data = term._batch.join('');
        term._batch = null;
        if (data) {
            term.flushes.push(data);
        }
    };
    term.since = n => term.flushes.slice(n);
    return term;
}

function makeClient() {
    const client = new events.EventEmitter();
    client.log = { warns: [], traces: [] };
    ['debug', 'info', 'error', 'fatal'].forEach(level => {
        client.log[level] = () => {};
    });
    client.log.warn = (obj, msg) => client.log.warns.push({ obj, msg });
    client.log.trace = (obj, msg) => client.log.traces.push({ obj, msg });
    client.term = makeTerm();
    client.captureInput = Client.prototype.captureInput;
    client.releaseInput = Client.prototype.releaseInput;
    client.hasInputCapture = Client.prototype.hasInputCapture;
    client.waitForKeyPress = Client.prototype.waitForKeyPress;
    return client;
}

//  A view that draws numbered frames: what an animation view does
class FrameView extends View {
    constructor(options) {
        super(options);
        this.frame = 0;
        this.ticks = 0;
        this.redraws = 0;
        this.forced = 0;
    }
    redraw() {
        ++this.redraws;
        this.client.term.write(`<${this.id} full ${this.frame}>`);
    }
    forceNextRedraw() {
        ++this.forced;
    }
    //  the clock's tick: next frame, and the draw for it
    tick() {
        ++this.ticks;
        this.frame += 1;
        const frame = this.frame;
        return () => this.client.term.write(`<${this.id}:${frame}>`);
    }
}

function frameView(client, id, row = 2) {
    return new FrameView({ client, id, position: { row, col: 10 } });
}

function register(view, spec = {}) {
    return FrameClock.register(
        view,
        Object.assign({ tick: ctx => view.tick(ctx), interval: 100 }, spec)
    );
}

//  a focused command field on |vc|
function addField(client, vc) {
    const field = new EditTextView({
        client,
        id: 1,
        position: { row: 20, col: 5 },
        dimens: { width: 30 },
        maxLength: 30,
    });
    vc.addView(field);
    vc.setViewOrder();
    vc.redrawAll();
    vc.switchFocus(1);
    return field;
}

function makeModule(client, name = 'testMenu') {
    const { MenuModule } = require('../core/menu_module.js');
    const mod = new MenuModule({
        menuName: name,
        menuConfig: { config: {}, art: null },
        client,
    });
    client.currentMenuModule = mod;
    return mod;
}

describe('FrameClock', function () {
    let time;
    let previousConfig;

    before(function () {
        previousConfig = configModule._pushTestConfig(MENU_CONFIG);
    });
    after(function () {
        configModule._popTestConfig(previousConfig);
    });
    beforeEach(function () {
        time = fakeTime();
    });
    afterEach(function () {
        time.restore();
    });

    describe('scheduling', function () {
        it('runs no timer while nothing is registered', function () {
            const client = makeClient();
            FrameClock.getFrameClock(client);
            assert.equal(time.live(), 0);

            const view = frameView(client, 5);
            register(view);
            assert.equal(time.live(), 1);
            FrameClock.unregister(view);
            assert.equal(time.live(), 0);
            assert.equal(
                client.listenerCount('end'),
                0,
                'no client listeners while idle'
            );
        });

        it('one timer for any number of views, armed for the earliest', function () {
            const client = makeClient();
            register(frameView(client, 5), { interval: 300 });
            register(frameView(client, 6), { interval: 120 });
            register(frameView(client, 7), { interval: 200 });
            assert.deepEqual(time.pending(), [120]);
        });

        it('two views due on one tick: one batch, one write', function () {
            const client = makeClient();
            const a = frameView(client, 5);
            const b = frameView(client, 6, 4);
            register(a);
            register(b);

            const n = client.term.flushes.length;
            time.advance(100);
            assert.deepEqual(client.term.since(n), ['<5:1><6:1>']);
            time.advance(100);
            assert.deepEqual(client.term.since(n), ['<5:1><6:1>', '<5:2><6:2>']);
        });

        it('views registered a few ms apart share their ticks (coalesced)', function () {
            const client = makeClient();
            const a = frameView(client, 5);
            const b = frameView(client, 6);
            register(a);
            time.advance(3);
            register(b);

            const n = client.term.flushes.length;
            time.advance(400);
            assert.deepEqual(client.term.since(n), [
                '<5:1><6:1>',
                '<5:2><6:2>',
                '<5:3><6:3>',
                '<5:4><6:4>',
            ]);
        });

        it('views on different intervals draw on their own ticks', function () {
            const client = makeClient();
            register(frameView(client, 5), { interval: 100 });
            register(frameView(client, 6), { interval: 150 });
            const n = client.term.flushes.length;
            time.advance(300);
            assert.deepEqual(client.term.since(n), [
                '<5:1>',
                '<6:1>',
                '<5:2>',
                '<5:3><6:2>',
            ]);
        });

        it('applies the floor (default 50 ms) to every delay', function () {
            const client = makeClient();
            const view = frameView(client, 5);
            register(view, { interval: 10, delay: 0 });
            assert.deepEqual(time.pending(), [50]);
            time.advance(200);
            assert.equal(view.ticks, 4);
        });

        it('the floor is a parameter', function () {
            const client = makeClient();
            FrameClock.getFrameClock(client, { minIntervalMs: 120 });
            const view = frameView(client, 5);
            register(view, { interval: 50 });
            time.advance(360);
            assert.equal(view.ticks, 3);
            assert.equal(FrameClock.DEFAULT_MIN_FRAME_INTERVAL_MS, 50);
        });

        it('a late timer does not burst: the next tick is at least the floor away', function () {
            const client = makeClient();
            const view = frameView(client, 5);
            register(view, { interval: 60 });
            time.jump(560); //  the event loop was busy: the 60 ms timer fires 500 ms late
            time.advance(0);
            assert.equal(view.ticks, 1);
            assert.deepEqual(time.pending(), [50]);
            time.advance(100);
            assert.equal(view.ticks, 2, 'back on its interval');
        });

        it('tick() can set the next delay ({ next }) and stop ({ stop })', function () {
            const client = makeClient();
            const view = frameView(client, 5);
            const durations = [0, 250, 80];
            let i = 0;
            const at = [];
            register(view, {
                interval: 100,
                tick: () => {
                    at.push(time.now - 1000000);
                    const next = durations[i++ % durations.length];
                    return {
                        draw: () => client.term.write(`<${i}>`),
                        next,
                        stop: i === 4,
                    };
                },
            });
            time.advance(1000);
            //  first at the interval, then 0 -> floor (50), 250, 80; stopped
            assert.deepEqual(at, [100, 150, 400, 480]);
            assert.equal(FrameClock.isRegistered(view), false);
            assert.equal(time.live(), 0);
            assert.equal(
                client.term.flushes.slice(-1)[0],
                '<4>',
                'the last tick still drew'
            );
        });

        it('a tick that returns nothing draws nothing, and keeps ticking', function () {
            const client = makeClient();
            const view = frameView(client, 5);
            let ticks = 0;
            register(view, { tick: () => void ++ticks });
            const n = client.term.flushes.length;
            time.advance(300);
            assert.equal(ticks, 3);
            assert.deepEqual(client.term.since(n), []);
        });

        it('a tick or draw that throws costs only its own view (warned, unregistered)', function () {
            const client = makeClient();
            const good = frameView(client, 5);
            const badTick = frameView(client, 6);
            const badDraw = frameView(client, 7);
            register(good);
            register(badTick, {
                tick: () => {
                    throw new Error('tick broke');
                },
            });
            register(badDraw, {
                tick: () => () => {
                    throw new Error('draw broke');
                },
            });
            const n = client.term.flushes.length;
            time.advance(200);
            assert.deepEqual(client.term.since(n), ['<5:1>', '<5:2>']);
            assert.deepEqual(
                client.log.warns.map(w => w.obj.error),
                ['tick broke', 'draw broke']
            );
            assert.equal(FrameClock.isRegistered(badTick), false);
            assert.equal(FrameClock.isRegistered(badDraw), false);
        });

        it('a draw that throws a falsy value is warned and unregistered too', function () {
            const client = makeClient();
            const good = frameView(client, 5);
            const bad = frameView(client, 6);
            register(good);
            register(bad, {
                tick: () => () => {
                    throw undefined; // eslint-disable-line no-throw-literal
                },
            });
            const n = client.term.flushes.length;
            time.advance(100);
            assert.deepEqual(client.term.since(n), ['<5:1>']);
            assert.deepEqual(
                client.log.warns.map(w => w.obj.error),
                ['undefined']
            );
            assert.equal(FrameClock.isRegistered(bad), false);
            assert.equal(FrameClock.isRegistered(good), true);
        });

        it('the drawing machinery throwing does not escape the timer; the clock stays usable', function () {
            const client = makeClient();
            const vc = new ViewController({ client });
            const a = frameView(client, 5);
            const b = frameView(client, 6);
            vc.addView(a);
            const field = addField(client, vc);
            const restore = field.restoreFocusCursor;
            field.restoreFocusCursor = () => {
                throw new Error('cursor broke');
            };
            register(a);
            register(b, { interval: 300 });
            time.advance(100); //  would throw out of the timer callback before
            assert.deepEqual(
                client.log.warns.map(w => [w.obj.error, w.obj.viewIds]),
                [['cursor broke', [5]]]
            );
            assert.equal(FrameClock.isRegistered(a), false, 'its view taken off');
            assert.equal(FrameClock.isRegistered(b), true, 'the others keep ticking');
            assert.equal(time.live(), 1, 'one timer, for b');

            field.restoreFocusCursor = restore;
            assert.equal(register(a), true);
            const n = client.term.flushes.length;
            time.advance(100);
            assert.equal(client.term.since(n).length, 1);
            assert.equal(a.ticks, 2);
        });

        it('register() on a view with no client is a no-op returning false', function () {
            const view = { id: 1 };
            assert.equal(FrameClock.register(view, { tick: () => {} }), false);
            assert.equal(FrameClock.isRegistered(view), false);
            assert.equal(FrameClock.unregister(view), false);
            assert.equal(time.live(), 0);
        });

        it('a real ClientTerminal: one socket write per tick; trace logs its bytes', function () {
            const client = makeClient();
            const socketWrites = [];
            client.term = new ClientTerminal({
                writable: true,
                write(data, cb) {
                    socketWrites.push(Buffer.from(data).toString('latin1'));
                    if (cb) {
                        cb(null);
                    }
                },
            });
            client.term.outputEncoding = 'cp437';
            register(frameView(client, 5));
            register(frameView(client, 6));
            time.advance(100);
            assert.deepEqual(socketWrites, ['<5:1><6:1>']);
            const trace = client.log.traces.find(t => t.msg === 'Frame clock tick');
            assert.deepEqual(trace.obj, {
                drawn: 2,
                covered: 0,
                failed: 0,
                bytes: '<5:1><6:1>'.length,
            });
        });
    });

    describe('focus cursor', function () {
        it('one hide and one restore per tick; the same bytes as drawInBackground()', function () {
            const client = makeClient();
            const vc = new ViewController({ client });
            const a = frameView(client, 5);
            const b = frameView(client, 6);
            vc.addView(a);
            vc.addView(b);
            addField(client, vc);

            //  drawInBackground() for one view: HIDE, draw, restore
            let n = client.term.flushes.length;
            a.drawInBackground(() => client.term.write('<A>'));
            const [single] = client.term.since(n);
            assert.ok(single.startsWith(`${HIDE_CURSOR}<A>`));
            const restore = single.slice(`${HIDE_CURSOR}<A>`.length);
            assert.ok(restore.endsWith(SHOW_CURSOR), 'field cursor shown again');

            register(a);
            register(b);
            n = client.term.flushes.length;
            time.advance(100);
            assert.deepEqual(client.term.since(n), [
                `${HIDE_CURSOR}<5:1><6:1>${restore}`,
            ]);
        });

        it('with no focused field the cursor is left where the draws leave it', function () {
            const client = makeClient();
            register(frameView(client, 5));
            const n = client.term.flushes.length;
            time.advance(100);
            assert.deepEqual(client.term.since(n), ['<5:1>']);
        });

        it('a draw that throws still gets the cursor back', function () {
            const client = makeClient();
            const vc = new ViewController({ client });
            const a = frameView(client, 5);
            vc.addView(a);
            addField(client, vc);
            register(a, {
                tick: () => () => {
                    client.term.write('<half');
                    throw new Error('broke');
                },
            });
            const n = client.term.flushes.length;
            time.advance(100);
            const [out] = client.term.since(n);
            assert.ok(out.startsWith(`${HIDE_CURSOR}<half`));
            assert.ok(out.endsWith(SHOW_CURSOR));
        });
    });

    describe('covers (background draw suspends)', function () {
        it('a suspended view draws nothing; one full redraw when it ends', function () {
            const client = makeClient();
            const a = frameView(client, 5);
            const b = frameView(client, 6);
            register(a);
            register(b);
            const token = View.suspendBackgroundDraw(client);

            const n = client.term.flushes.length;
            time.advance(300);
            assert.deepEqual(client.term.since(n), [], 'no bytes while covered');
            assert.equal(a.ticks, 3, 'ticks still run (as drawInBackground runs drawFn)');

            View.resumeBackgroundDraw(client, token);
            assert.deepEqual(client.term.since(n), ['<5 full 3>', '<6 full 3>']);
            assert.equal(a.forced, 1);
            assert.equal(a.redraws, 1);

            time.advance(100);
            assert.deepEqual(client.term.since(n).slice(-1), ['<5:4><6:4>']);
        });

        it('creation order: a view made inside the cover (a pause prompt) still draws', function () {
            const client = makeClient();
            const covered = frameView(client, 5);
            register(covered);
            const token = View.suspendBackgroundDraw(client);
            const inside = frameView(client, 6);
            register(inside);

            const n = client.term.flushes.length;
            time.advance(100);
            assert.deepEqual(client.term.since(n), ['<6:1>']);
            View.resumeBackgroundDraw(client, token);
            assert.deepEqual(client.term.since(n), ['<6:1>', '<5 full 1>']);
        });

        it('coverScreen(): nothing drawn under the cover, one redraw after', function (done) {
            const client = makeClient();
            const menu = makeModule(client);
            const vc = menu.addViewController('main', new ViewController({ client }));
            const view = frameView(client, 5);
            vc.addView(view);
            register(view);
            let n;
            menu.coverScreen(
                {},
                finish => {
                    n = client.term.flushes.length;
                    time.advance(300);
                    assert.deepEqual(client.term.since(n), []);
                    finish(null);
                },
                err => {
                    assert.ifError(err);
                    assert.deepEqual(client.term.since(n), ['<5 full 3>']);
                    FrameClock.unregister(view);
                    done();
                }
            );
        });

        it('the realtime interrupt { menu } cover: a form built under it does not draw', function () {
            const client = makeClient();
            const menu = makeModule(client);
            const token = View.suspendBackgroundDraw(client, { menu });
            //  art that finished loading under the interrupt
            const late = menu.addViewController('late', new ViewController({ client }));
            const view = frameView(client, 5);
            late.addView(view);
            register(view);
            //  a theme's temporary pause prompt inside the cover still animates
            const prompt = new ViewController({ client });
            const pauseAnim = frameView(client, 6);
            prompt.addView(pauseAnim);
            register(pauseAnim);

            const n = client.term.flushes.length;
            time.advance(100);
            assert.deepEqual(client.term.since(n), ['<6:1>']);
            View.resumeBackgroundDraw(client, token);
            assert.deepEqual(client.term.since(n), ['<6:1>', '<5 full 1>']);
            prompt.destroy();
        });

        it('a { forms } cover (vc.cover()) suspends only that form', function () {
            const client = makeClient();
            const coveredVc = new ViewController({ client });
            const otherVc = new ViewController({ client });
            const a = frameView(client, 5);
            const b = frameView(client, 6);
            coveredVc.addView(a);
            otherVc.addView(b);
            register(a);
            register(b);

            coveredVc.cover();
            const n = client.term.flushes.length;
            time.advance(100);
            assert.deepEqual(client.term.since(n), ['<6:1>']);
            coveredVc.uncover();
            assert.deepEqual(client.term.since(n), ['<6:1>', '<5 full 1>']);
        });

        it('a drip (baud emulated art) covers the views drawn before it', function () {
            const client = makeClient();
            let cover = null;
            client.term.setDripCover = c => (cover = c);
            const view = frameView(client, 5);
            register(view);
            const token = cover.begin();
            const n = client.term.flushes.length;
            time.advance(100);
            assert.deepEqual(client.term.since(n), []);
            cover.end(token);
            assert.deepEqual(client.term.since(n), ['<5 full 1>']);
        });

        it('a view destroyed under the cover is owed nothing', function () {
            const client = makeClient();
            const view = frameView(client, 5);
            register(view);
            const token = View.suspendBackgroundDraw(client);
            time.advance(100);
            view.destroy();
            const n = client.term.flushes.length;
            View.resumeBackgroundDraw(client, token);
            assert.deepEqual(client.term.since(n), []);
            assert.equal(time.live(), 0);
        });
        it('coverMark: a cover that came and went between ticks makes the next frame full', function () {
            const client = makeClient();
            const view = frameView(client, 5);
            view.mark = View.coverMark(client);
            //  as TickerView: compare the mark at tick time; a tick under a
            //  cover does not count as drawn, so it leaves the mark alone
            register(view, {
                tick: () => {
                    const mark = View.coverMark(client);
                    const full = mark !== view.mark;
                    if (!view.isBackgroundDrawSuspended()) {
                        view.mark = mark;
                    }
                    return () => client.term.write(full ? '<full>' : '<step>');
                },
            });
            const n = client.term.flushes.length;
            time.advance(100);
            const token = View.suspendBackgroundDraw(client);
            View.resumeBackgroundDraw(client, token); //  nothing missed: no redraw
            time.advance(100);
            time.advance(100);
            assert.deepEqual(client.term.since(n), ['<step>', '<full>', '<step>']);
        });

        it('a TickerView ticked by the clock writes what its own timer writes', function () {
            const { TickerView } = require('../core/ticker_view.js');
            function screen() {
                const client = makeClient();
                const vc = new ViewController({ client });
                const ticker = new TickerView({
                    client,
                    id: 9,
                    position: { row: 2, col: 10 },
                    dimens: { width: 12, height: 1 },
                    text: 'Welcome to the board',
                    motion: 'left',
                });
                ticker._stopTicker(); //  its own timer is driven by hand below
                vc.addView(ticker);
                addField(client, vc);
                return { client, ticker };
            }
            const own = screen();
            const clocked = screen();
            register(clocked.ticker, {
                interval: 100,
                tick: () => {
                    clocked.ticker._advanceMotion();
                    return clocked.ticker._tickDraw();
                },
            });

            const n1 = own.client.term.flushes.length;
            const n2 = clocked.client.term.flushes.length;
            for (let i = 0; i < 5; ++i) {
                own.ticker._advanceMotion(); //  what setBackgroundInterval() runs
                own.ticker._tick();
                time.advance(100);
            }
            //  and across a cover: nothing while covered, one redraw after
            const t1 = View.suspendBackgroundDraw(own.client);
            const t2 = View.suspendBackgroundDraw(clocked.client);
            own.ticker._advanceMotion();
            own.ticker._tick();
            time.advance(100);
            View.resumeBackgroundDraw(own.client, t1);
            View.resumeBackgroundDraw(clocked.client, t2);
            own.ticker._advanceMotion();
            own.ticker._tick();
            time.advance(100);

            const ownOut = own.client.term.since(n1);
            assert.equal(ownOut.length, 7);
            assert.deepEqual(clocked.client.term.since(n2), ownOut);
            FrameClock.unregister(clocked.ticker);
        });
    });

    describe('pauseWhenInactive', function () {
        it('no ticks while the form is inactive; one redraw on activate; then ticking again', function () {
            const client = makeClient();
            const vc = new ViewController({ client });
            const view = frameView(client, 5);
            vc.addView(view);
            view.setPropertyValue('pauseWhenInactive', true);
            vc.attachClientEvents();
            register(view);

            time.advance(100);
            assert.equal(view.ticks, 1);

            vc.deactivate();
            const n = client.term.flushes.length;
            time.advance(300);
            assert.equal(
                view.ticks,
                1,
                'tick() not called: the animation does not move on unseen'
            );
            assert.deepEqual(client.term.since(n), []);

            vc.activate();
            assert.deepEqual(
                client.term.since(n),
                ['<5 full 1>'],
                'the forced redraw draws'
            );
            time.advance(100);
            assert.equal(view.ticks, 2);
            assert.deepEqual(client.term.since(n).slice(-1), ['<5:2>']);
        });

        it('a view without it keeps ticking on an inactive form', function () {
            const client = makeClient();
            const vc = new ViewController({ client });
            const view = frameView(client, 5);
            vc.addView(view);
            vc.attachClientEvents();
            register(view);
            vc.deactivate();
            time.advance(200);
            assert.equal(view.ticks, 2);
        });
    });

    describe('lifecycle: no timer survives', function () {
        it('destroy() unregisters the view at once', function () {
            const client = makeClient();
            const view = frameView(client, 5);
            register(view);
            view.destroy();
            assert.equal(FrameClock.isRegistered(view), false);
            assert.equal(time.live(), 0);
        });

        it('a form teardown unregisters, even when destroy() does not call super', function () {
            const client = makeClient();
            const vc = new ViewController({ client });
            const view = frameView(client, 5);
            view.destroy = () => {}; //  a mod's view that forgot super.destroy()
            vc.addView(view);
            vc.attachClientEvents();
            register(view);
            vc.setFocus(false); //  still tears down, as it always has
            assert.equal(FrameClock.isRegistered(view), false);
            assert.equal(time.live(), 0);
        });

        it('a destroyed view cannot register', function () {
            const client = makeClient();
            const view = frameView(client, 5);
            view.destroy();
            assert.equal(register(view), false);
            assert.equal(time.live(), 0);
        });

        it('leaving the menu (MenuModule.leave()) unregisters its views', function () {
            const client = makeClient();
            const menu = makeModule(client);
            const vc = menu.addViewController('main', new ViewController({ client }));
            const a = frameView(client, 5);
            const b = frameView(client, 6);
            vc.addView(a);
            vc.addView(b);
            addField(client, vc);
            register(a);
            register(b);
            assert.equal(time.live(), 1);

            menu.leave();
            assert.equal(FrameClock.isRegistered(a), false);
            assert.equal(FrameClock.isRegistered(b), false);
            assert.equal(time.live(), 0);
            const n = client.term.flushes.length;
            time.advance(500);
            assert.deepEqual(client.term.since(n), []);
        });

        it("the client's end or close drops every view, on a menu or not", function () {
            ['end', 'close'].forEach(event => {
                const client = makeClient();
                const view = frameView(client, 5); //  a mod's bare view
                register(view);
                client.emit(event);
                assert.equal(FrameClock.isRegistered(view), false, event);
                assert.equal(time.live(), 0, event);
                assert.equal(client.listenerCount('end'), 0);
                assert.equal(client.listenerCount('close'), 0);
            });
        });

        it('a timer that fires after Client.end() draws nothing and stops', function () {
            const client = makeClient();
            const view = frameView(client, 5);
            register(view);
            client.clientEnded = true; //  end() ran, no event seen yet
            const n = client.term.flushes.length;
            time.advance(100);
            assert.deepEqual(client.term.since(n), []);
            assert.equal(view.ticks, 0);
            assert.equal(time.live(), 0);
            assert.equal(register(view), false, 'nothing registers for an ended client');
        });

        it('a view destroyed by an earlier draw in the same tick is not drawn', function () {
            const client = makeClient();
            const a = frameView(client, 5);
            const b = frameView(client, 6);
            register(a, {
                tick: () => {
                    b.destroy();
                    return () => client.term.write('<5>');
                },
            });
            register(b);
            const n = client.term.flushes.length;
            time.advance(100);
            assert.deepEqual(client.term.since(n), ['<5>']);
        });
    });

    describe('View.drawInBackgroundBatch()', function () {
        it('covered views are noted for a redraw; the rest draw in one write', function () {
            const client = makeClient();
            const covered = frameView(client, 5);
            const token = View.suspendBackgroundDraw(client);
            const live = frameView(client, 6);
            const n = client.term.flushes.length;
            const result = View.drawInBackgroundBatch(client, [
                { view: covered, draw: () => client.term.write('<covered>') },
                { view: live, draw: () => client.term.write('<live>') },
            ]);
            assert.deepEqual(client.term.since(n), ['<live>']);
            assert.deepEqual(result.drawn, [live]);
            assert.deepEqual(result.covered, [covered]);
            View.resumeBackgroundDraw(client, token);
            assert.deepEqual(client.term.since(n), ['<live>', '<5 full 0>']);
        });

        it('nothing to draw: no write, no cursor bytes', function () {
            const client = makeClient();
            const vc = new ViewController({ client });
            const view = frameView(client, 5);
            vc.addView(view);
            addField(client, vc);
            const token = View.suspendBackgroundDraw(client);
            const n = client.term.flushes.length;
            View.drawInBackgroundBatch(client, [{ view, draw: () => {} }]);
            View.drawInBackgroundBatch(client, []);
            assert.deepEqual(client.term.since(n), []);
            View.resumeBackgroundDraw(client, token, { redrawMissed: false });
        });

        it('drawInBackground() still throws what drawFn throws, after restoring', function () {
            const client = makeClient();
            const vc = new ViewController({ client });
            const view = frameView(client, 5);
            vc.addView(view);
            addField(client, vc);
            const n = client.term.flushes.length;
            assert.throws(
                () =>
                    view.drawInBackground(() => {
                        throw new Error('boom');
                    }),
                /boom/
            );
            const [out] = client.term.since(n);
            assert.ok(out.startsWith(HIDE_CURSOR) && out.endsWith(SHOW_CURSOR));
        });
    });

    describe('drawInBackground(): the same as before the batch helper', function () {
        //  a focused field, so the hide / restore path runs
        function setup() {
            const client = makeClient();
            const vc = new ViewController({ client });
            const view = frameView(client, 5);
            vc.addView(view);
            addField(client, vc);
            return { client, view };
        }

        //  what |fn| threw, and whether it threw at all
        function thrownBy(fn) {
            try {
                fn();
            } catch (e) {
                return { threw: true, error: e };
            }
            return { threw: false };
        }

        it('a falsy throw (undefined, 0, null) is still thrown, after restoring', function () {
            const { client, view } = setup();
            [undefined, 0, null].forEach(value => {
                const n = client.term.flushes.length;
                const got = thrownBy(() =>
                    view.drawInBackground(() => {
                        throw value;
                    })
                );
                assert.deepEqual(got, { threw: true, error: value });
                const [out] = client.term.since(n);
                assert.ok(out.startsWith(HIDE_CURSOR) && out.endsWith(SHOW_CURSOR));
            });
        });

        it('the draw function is called bare, with no this', function () {
            const { client, view } = setup();
            const seen = [];
            view.drawInBackground(function () {
                seen.push(this);
            });
            View.drawInBackgroundBatch(client, [
                {
                    view,
                    draw: function () {
                        seen.push(this);
                    },
                },
            ]);
            assert.deepEqual(seen, [undefined, undefined]);
        });

        it('a draw that is not a function fails with a TypeError, after restoring', function () {
            const { client, view } = setup();
            const n = client.term.flushes.length;
            const got = thrownBy(() => view.drawInBackground('not a function'));
            assert.equal(got.threw, true);
            assert.ok(got.error instanceof TypeError);
            const [out] = client.term.since(n);
            assert.ok(out.startsWith(HIDE_CURSOR) && out.endsWith(SHOW_CURSOR));
        });

        it('a destroyed view still draws, as it always has', function () {
            const { client, view } = setup();
            view.destroy();
            const n = client.term.flushes.length;
            view.drawInBackground(() => client.term.write('<drawn>'));
            assert.ok(client.term.since(n)[0].includes('<drawn>'));
        });

        it('a batch skips a view an earlier draw of the batch destroyed', function () {
            const client = makeClient();
            const a = frameView(client, 5);
            const b = frameView(client, 6);
            const c = frameView(client, 7);
            const n = client.term.flushes.length;
            const result = View.drawInBackgroundBatch(client, [
                {
                    view: a,
                    draw: () => {
                        b.destroy();
                        client.term.write('<a>');
                    },
                },
                { view: b, draw: () => client.term.write('<b>') },
                { view: c, draw: () => client.term.write('<c>') },
            ]);
            assert.deepEqual(client.term.since(n), ['<a><c>']);
            assert.deepEqual(result.drawn, [a, c]);
            assert.deepEqual(result.failed, []);
        });
    });

    describe('View.onDestroyed()', function () {
        it('runs once, from destroy() or the form teardown, and can be removed', function () {
            const client = makeClient();
            const view = frameView(client, 5);
            let runs = 0;
            View.onDestroyed(view, () => ++runs);
            const remove = View.onDestroyed(view, () => ++runs);
            remove();
            view.destroy();
            View.markDestroyed(view); //  the form's teardown after destroy()
            assert.equal(runs, 1);
            assert.equal(
                View.onDestroyed(view, () => ++runs),
                null
            );
        });
    });
});
