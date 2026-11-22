'use strict';

//
//  frame_clock.js -- one timer per client for views that draw frames on
//  their own (the animation views to come), drawn together in one write.
//
//  ── Design ───────────────────────────────────────────────────────────────────
//
//  API
//
//      const FrameClock = require('./frame_clock.js');
//
//      FrameClock.register(view, {
//          tick,           //  (ctx) => draw | { draw, next, stop } | nothing
//          interval,       //  ms between ticks when tick() does not say
//          delay,          //  ms to the first tick (default: interval)
//      });                 //  -> true, or false (destroyed view, client gone,
//                          //     view without a client)
//      FrameClock.unregister(view);
//      FrameClock.isRegistered(view);
//      FrameClock.getFrameClock(client, { minIntervalMs, coalesceMs });
//
//  tick(ctx) is the view's frame step, as fn() is for View
//  setBackgroundInterval(): it moves the view on and returns a function
//  that draws the change, or nothing. It may also return { draw, next,
//  stop }: |next| is the ms to the following tick (frame durations, a
//  random idle wait), |stop| unregisters the view after this tick. ctx is
//  { now, due }.
//
//  Scheduling
//
//  - One setTimeout per client, armed for the earliest due entry; none
//    while nothing is registered (an idle clock also holds no client
//    listeners; it stays in the WeakMap, which goes with the client).
//  - Every delay is at least |minIntervalMs| (default 50; the config key
//    comes with the animation view). This is the only place the floor is
//    applied. The next due time keeps the view's phase (due + next) so
//    views with the same interval stay together, but is never sooner than
//    now + floor, so a late timer does not cause a burst.
//  - An entry due within |coalesceMs| (default 10) of another, and not
//    sooner than its floor allows, is moved onto it: two animations that
//    registered a few ms apart share their ticks (one write), rather than
//    drawing twice, 3 ms apart, forever.
//
//  One tick
//
//      for each due entry, in registration order:
//          destroyed (View.isDestroyed)  -> dropped, nothing drawn
//          pauseWhenInactive and its form inactive or covered
//                                        -> tick not called, rescheduled,
//                                           marked as owing a redraw
//                                           (View's skipPausedTick())
//          otherwise tick(ctx), and its draw function collected
//      View.drawInBackgroundBatch(client, draws)
//
//  Integration with background drawing: a batch helper, not nesting
//
//  The clock does not decide what may draw. Every collected draw goes
//  through View.drawInBackgroundBatch(), and View.drawInBackground() is now
//  that helper with one item (same bytes, same order; it still throws what
//  drawFn throws). So each view keeps exactly what drawInBackground() gives
//  it today:
//
//  - suspension, per view, at the moment it would draw: the creation
//    order rule, { menu } and { forms } scopes, drips (the drip cover is
//    such a suspend). A covered view's draw runs with its output discarded
//    (term.discardOutput()), and the view is put in the missed set, so it
//    gets the one full redraw (forceNextRedraw() + redraw(), through
//    drawInBackground()) when the last suspend covering it ends;
//  - coverMark and forceNextRedraw() stay the view's business, as for
//    TickerView: a frame view compares View.coverMark() at tick time, and
//    resets its "last drawn" baseline in forceNextRedraw();
//  - pauseWhenInactive: the same skipPausedTick() rule
//    setBackgroundInterval() uses; the redraw owed on activate() (or at the
//    end of a cover) goes through drawInBackground(), not the clock, so a
//    forced redraw still draws;
//  - destroyed views draw nothing (dropped before tick());
//  - the input focus view puts its cursor and SGR back after the batch:
//    one hide before the first draw, one restoreFocusCursor() after the
//    last, in one beginWrite() / commitWrite() batch.
//
//  Why not nest per-view drawInBackground() calls in one outer batch?
//  beginWrite() nests, so that would be one socket write, but each view
//  would still hide the cursor and put it back (goto + SGR + show) between
//  views: N hide/restore pairs per tick instead of one, the bytes growing
//  with every animation on screen, and one throwing draw would end the
//  loop unless each call were wrapped. The helper keeps a single code path
//  for the per-view rules (drawInBackground() is a one-item batch), so the
//  clock cannot drift from them; it only adds what a batch needs: one
//  hide/restore, and a failing draw that costs only its own view (the
//  clock logs it and unregisters that view; drawInBackground() rethrows,
//  as before).
//
//  Lifecycle: no timer outlives its views or its client
//
//  - destroy(): View.markDestroyed() runs the view's destroy hooks
//    (View.onDestroyed(); new). It is called by View.destroy() and by
//    ViewController's teardown even for a destroy() that does not call
//    super, so every way a view goes away unregisters it at once.
//  - menu leave: MenuModule.leave() -> detachViewControllers() ->
//    detachClientEvents() -> tearDownViews() -> destroy() +
//    markDestroyed(), then destroyMenuForms(): covered by the hook.
//    setFocus(false) tears down the same way (it still destroys).
//  - disconnect: Client.end() leaves the top menu (above); the clock also
//    listens for the client's 'end' and 'close' and drops everything, for
//    views on no menu (a mod's bare view), and checks client.clientEnded
//    when its timer fires.
//
//  Reused, not rewritten: drawInBackground()'s rules (now shared with the
//  batch helper), skipPausedTick() (exported from view.js), View.isDestroyed.
//
//  Hooks added to existing code (view.js only):
//  - View.drawInBackgroundBatch(); drawInBackground() delegates to it
//  - View.onDestroyed(view, fn), run by markDestroyed()
//  - export skipPausedTick
//

//  ENiGMA½
const { View, skipPausedTick } = require('./view.js');

//  deps
const _ = require('lodash');

const DEFAULT_MIN_FRAME_INTERVAL_MS = 50;
const DEFAULT_COALESCE_MS = 10;

//  client -> its FrameClock. An idle clock holds no timer and no listeners.
const clocks = new WeakMap();

//  what a thrown value says, for a log: anything may be thrown (undefined too)
function errorMessage(e) {
    return e && e.message ? e.message : String(e);
}

function warn(client, obj, msg) {
    const log = client && client.log;
    if (log && _.isFunction(log.warn)) {
        log.warn(obj, msg);
    }
}

class FrameClock {
    constructor(client, options = {}) {
        this.client = client;
        this.minIntervalMs = DEFAULT_MIN_FRAME_INTERVAL_MS;
        this.coalesceMs = DEFAULT_COALESCE_MS;
        this.entries = new Map(); //  view -> entry, in registration order
        this.timer = null;
        this.timerDue = null;
        this._firing = false;
        this._listening = false;
        this._onClientGone = () => this.dispose();
        this.setOptions(options);
    }

    //  { minIntervalMs, coalesceMs }; applies from each view's next tick
    setOptions(options = {}) {
        if (options.minIntervalMs > 0) {
            this.minIntervalMs = options.minIntervalMs;
        }
        if (options.coalesceMs >= 0) {
            this.coalesceMs = options.coalesceMs;
        }
    }

    //  |ms| as a delay: at least the floor; anything not a number is |fallback|
    _delay(ms, fallback) {
        const n = Number(ms);
        return Math.max(
            this.minIntervalMs,
            Number.isFinite(n) ? n : fallback || this.minIntervalMs
        );
    }

    //  |due| moved onto another entry's due time if that one is within
    //  coalesceMs and not sooner than |earliest| allows
    _coalesce(entry, due, earliest) {
        let best = due;
        let bestGap = Infinity;
        for (const other of this.entries.values()) {
            if (other === entry || other.due < earliest) {
                continue;
            }
            const gap = Math.abs(other.due - due);
            if (gap <= this.coalesceMs && gap < bestGap) {
                best = other.due;
                bestGap = gap;
            }
        }
        return best;
    }

    register(view, spec = {}) {
        if (!_.isFunction(spec.tick)) {
            throw new Error('FrameClock.register() needs a tick function');
        }
        if (View.isDestroyed(view) || this.client.clientEnded) {
            return false;
        }

        this.unregister(view); //  registering again replaces

        const now = Date.now();
        const interval = this._delay(spec.interval);
        const entry = {
            view,
            tick: spec.tick,
            interval,
            due: 0,
            removeHook: null,
        };
        const delay = undefined === spec.delay ? interval : this._delay(spec.delay);
        entry.due = this._coalesce(entry, now + delay, now + this.minIntervalMs);
        entry.removeHook = View.onDestroyed(view, () => this.unregister(view));

        this.entries.set(view, entry);
        this._listen();
        this._schedule();
        return true;
    }

    unregister(view) {
        const entry = this.entries.get(view);
        if (!entry) {
            return false;
        }
        this.entries.delete(view);
        if (entry.removeHook) {
            entry.removeHook();
        }
        if (0 === this.entries.size) {
            this.dispose();
        } else {
            this._schedule();
        }
        return true;
    }

    isRegistered(view) {
        return this.entries.has(view);
    }

    //  Everything unregistered, the timer stopped, the client let go of
    dispose() {
        this._clearTimer();
        const entries = [...this.entries.values()];
        this.entries.clear();
        entries.forEach(entry => entry.removeHook && entry.removeHook());
        this._unlisten();
    }

    _listen() {
        const client = this.client;
        if (this._listening || !_.isFunction(client.once)) {
            return;
        }
        this._listening = true;
        client.once('end', this._onClientGone);
        client.once('close', this._onClientGone);
    }

    _unlisten() {
        const client = this.client;
        if (!this._listening) {
            return;
        }
        this._listening = false;
        client.removeListener('end', this._onClientGone);
        client.removeListener('close', this._onClientGone);
    }

    _clearTimer() {
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timer = null;
        this.timerDue = null;
    }

    //  The one timer, for the earliest entry
    _schedule() {
        if (this._firing) {
            return; //  _fire() schedules once every due entry has moved on
        }
        let earliest = Infinity;
        for (const entry of this.entries.values()) {
            earliest = Math.min(earliest, entry.due);
        }
        if (!Number.isFinite(earliest)) {
            return this._clearTimer();
        }
        if (this.timer && this.timerDue === earliest) {
            return;
        }
        this._clearTimer();
        this.timerDue = earliest;
        this.timer = setTimeout(() => this._fire(), Math.max(0, earliest - Date.now()));
    }

    //  |entry| ticked (or skipped) at |now|; its next tick in |next| ms
    _reschedule(entry, next, now) {
        const floor = now + this.minIntervalMs;
        const due = Math.max(entry.due + this._delay(next, entry.interval), floor);
        entry.due = this._coalesce(entry, due, floor);
    }

    _fire() {
        this.timer = null;
        this.timerDue = null;

        const client = this.client;
        if (client.clientEnded) {
            return this.dispose();
        }

        this._firing = true;
        try {
            this._tickDue();
        } finally {
            this._firing = false;
            if (this.entries.size > 0) {
                this._schedule();
            }
        }
    }

    _tickDue() {
        const client = this.client;
        const now = Date.now();
        const dueEntries = [...this.entries.values()].filter(e => e.due <= now);
        const draws = [];

        for (const entry of dueEntries) {
            const view = entry.view;
            if (this.entries.get(view) !== entry) {
                continue; //  unregistered (or registered again) by an earlier tick
            }
            if (View.isDestroyed(view)) {
                this.unregister(view);
                continue;
            }
            //  pauseWhenInactive, form inactive or covered: no tick at all
            if (skipPausedTick(view)) {
                this._reschedule(entry, entry.interval, now);
                continue;
            }

            let result;
            try {
                result = entry.tick({ now, due: entry.due });
            } catch (e) {
                warn(
                    client,
                    { error: errorMessage(e), viewId: view.id },
                    'Frame tick failed; view taken off the frame clock'
                );
                this.unregister(view);
                continue;
            }
            if (this.entries.get(view) !== entry) {
                continue; //  the tick unregistered it
            }

            let draw = null;
            let next = entry.interval;
            let stop = false;
            if (_.isFunction(result)) {
                draw = result;
            } else if (_.isObject(result)) {
                draw = _.isFunction(result.draw) ? result.draw : null;
                if (undefined !== result.next && null !== result.next) {
                    next = result.next;
                }
                stop = true === result.stop;
            }

            if (stop) {
                this.unregister(view);
            } else {
                this._reschedule(entry, next, now);
            }
            if (draw) {
                draws.push({ view, draw });
            }
        }

        if (draws.length > 0) {
            this._draw(draws);
        }
    }

    //  Every draw of this tick in one batch: one write
    _draw(draws) {
        const client = this.client;
        const term = client.term;
        const pendingBytes = () =>
            term && Array.isArray(term._writeBuf)
                ? term._writeBuf.reduce((n, chunk) => n + chunk.length, 0)
                : 0;
        //  an outer batch, only to count this tick's bytes before they go
        const batch =
            term && _.isFunction(term.beginWrite) && _.isFunction(term.commitWrite);

        let result;
        let bytes = 0;
        try {
            if (batch) {
                term.beginWrite();
            }
            const before = pendingBytes();
            try {
                result = View.drawInBackgroundBatch(client, draws);
                bytes = pendingBytes() - before;
            } finally {
                if (batch) {
                    term.commitWrite();
                }
            }
        } catch (e) {
            //  The drawing machinery itself threw (each draw's own throw is
            //  in result.failed), e.g. putting the focus cursor back. Not
            //  out of the timer callback: which draw is to blame is unknown,
            //  so every view of this tick is taken off, as a failing draw
            //  is, rather than failing (and warning) again on every frame.
            warn(
                client,
                {
                    error: errorMessage(e),
                    viewIds: draws.map(({ view }) => view.id),
                },
                'Frame clock draw failed; views taken off the frame clock'
            );
            draws.forEach(({ view }) => this.unregister(view));
            return;
        }

        result.failed.forEach(({ view, error }) => {
            warn(
                client,
                { error: errorMessage(error), viewId: view.id },
                'Frame draw failed; view taken off the frame clock'
            );
            this.unregister(view);
        });

        const log = client.log;
        if (log && _.isFunction(log.trace)) {
            log.trace(
                {
                    drawn: result.drawn.length,
                    covered: result.covered.length,
                    failed: result.failed.length,
                    bytes,
                },
                'Frame clock tick'
            );
        }
    }
}

//  |client|'s frame clock, made on first use. |options| (minIntervalMs,
//  coalesceMs) are applied to it.
function getFrameClock(client, options) {
    let clock = clocks.get(client);
    if (!clock) {
        clock = new FrameClock(client, options);
        clocks.set(client, clock);
    } else if (options) {
        clock.setOptions(options);
    }
    return clock;
}

//  false, and nothing registered, for a view with no client (one not set up
//  yet, or a stand-in): there is no client to keep a clock for
function register(view, spec) {
    if (!view || !_.isObject(view.client)) {
        return false;
    }
    return getFrameClock(view.client).register(view, spec);
}

function unregister(view) {
    const clock = view && clocks.get(view.client);
    return clock ? clock.unregister(view) : false;
}

function isRegistered(view) {
    const clock = view && clocks.get(view.client);
    return clock ? clock.isRegistered(view) : false;
}

exports.FrameClock = FrameClock;
exports.getFrameClock = getFrameClock;
exports.register = register;
exports.unregister = unregister;
exports.isRegistered = isRegistered;
exports.DEFAULT_MIN_FRAME_INTERVAL_MS = DEFAULT_MIN_FRAME_INTERVAL_MS;
