'use strict';

//  ENiGMA½
const { View } = require('./view.js');
const {
    AnsiCanvas,
    sliceSheet,
    applyTransparency,
    DEFAULT_ATTR,
} = require('./ansi_canvas.js');
const AnsiDiff = require('./ansi_diff.js');
const FrameClock = require('./frame_clock.js');
const { emulationOf } = require('./term/index.js');
const { LAYER_NAME: RIP_LAYER } = require('./term/rip');

//  deps
const async = require('async');
const fs = require('graceful-fs');
const _ = require('lodash');

//
//  AnimationView (%AV) -- frames drawn in a box over a menu's art, on the
//  client's frame clock (core/frame_clock.js), while the menu takes input.
//
//  Placed like any view: %AV20 in the art marks the box's top-left, or an
//  `mci` key with a `position` and no marker (ViewController placement).
//
//      AV20: {
//          width: 8                //  the box; frames are this size
//          height: 12
//          //  one of:
//          frames: [ "|04..", "|12.." ]                 //  inline, pipe coded
//          frames: { art: "fire", row: 1, col: 1, gap: 0, frameCount: 8 }
//                                  //  a sheet: frames stacked vertically
//          frames: { art: [ "fire1", "fire2" ] }       //  one art per frame
//          frameInterval: 120      //  ms each frame shows (default 100)
//          frameDurations: [ 0, 250 ]  //  per frame; overrides frameInterval
//          mode: loop              //  loop | pingpong | once | random
//          startFrame: 3           //  first frame shown (0-based)
//          idle: [ 4000, 9000 ]    //  random wait (ms) at frame 0 before
//                                  //  each run (not for random)
//          transparent: "~"        //  never drawn, if so in every frame
//      }
//
//  Art is found with theme.getThemeArt(), so themes and mods override it.
//  Parsed frame sets (and their transitions) are kept across clients,
//  keyed by the art's resolved path, mtime and size. Frames load in
//  prepare(), which ViewController runs before the form is first drawn; a
//  frame that fails to load leaves the box blank (nothing is drawn: the
//  art under it shows) and logs a warning. It never fails the menu.
//
//  Timing: a frame shows for its frameDurations entry, else frameInterval,
//  never less than menus.animations.minFrameIntervalMs (the clock's floor).
//  With `idle`, frame 0 shows for a random wait in [ min, max ] each time
//  a run starts (the first draw too), instead of its duration. Modes:
//
//      loop        0, 1, .. n-1, 0, ..
//      pingpong    0, 1, .. n-1, n-2, .. 0, 1, ..
//      once        0, 1, .. n-1, then stops on n-1. With `idle`: back to
//                  0 after n-1, rests there for the idle wait, runs again
//      random      any frame but the one showing, each tick
//
//  Not animated -- frame 0 drawn, nothing ticks -- when animations are
//  off (menus.animations.enabled is a hard off; a menu's own
//  config.animations: false turns off just that menu), and on any session that
//  is not plain ANSI (PETSCII, ATASCII, or the RIP layer). Frame 0 then
//  goes out through client.term.write() like any view's output, so the
//  session's translator converts it.
//
//  Drawing: the first draw, redraw() and the draw after forceNextRedraw()
//  or a cover (View.coverMark()) write the whole frame; a tick writes only
//  the cells that change (core/ansi_diff.js), through the clock's
//  background batch. While covered, a tick does not count as drawn, so the
//  next real draw is a full one. Only SGR is written: the iCE mode is
//  whatever the menu's art set.
//
//  Not focusable, takes no input, and is never the implicit submit view
//  (ViewController applyViewConfig()).
//

const DEFAULT_FRAME_INTERVAL_MS = 100;
const DEFAULT_MIN_FRAME_INTERVAL_MS = FrameClock.DEFAULT_MIN_FRAME_INTERVAL_MS;
const MODES = ['loop', 'pingpong', 'once', 'random'];

//  inline frames are parsed this wide, so a line longer than the box is
//  seen (and clipped, with a warning) rather than wrapped onto the next row
const INLINE_PARSE_WIDTH = 1024;

//  frame sets kept across clients, least recently used dropped first
const FRAME_SET_CACHE_MAX = 32;
const frameSetCache = new Map();

function cacheGet(key) {
    const entry = frameSetCache.get(key);
    if (entry) {
        frameSetCache.delete(key);
        frameSetCache.set(key, entry);
    }
    return entry;
}

function cachePut(key, entry) {
    frameSetCache.set(key, entry);
    while (frameSetCache.size > FRAME_SET_CACHE_MAX) {
        frameSetCache.delete(frameSetCache.keys().next().value);
    }
}

function clearFrameSetCache() {
    frameSetCache.clear();
}

//  menus.animations, read when used (config.js is not captured at load)
function animationsConfig() {
    const getConfig = require('./config.js').get;
    const config = _.isFunction(getConfig) ? getConfig() : null;
    return _.get(config, 'menus.animations') || {};
}

function minFrameIntervalMs() {
    const ms = Number(animationsConfig().minFrameIntervalMs);
    return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_MIN_FRAME_INTERVAL_MS;
}

//  On for |client|'s current menu? The system switch is a hard off (owner,
//  2026-11-21); a menu can only turn its own animations off, not back on
function animationsEnabled(client) {
    if (false === animationsConfig().enabled) {
        return false;
    }
    const perMenu = _.get(client, 'currentMenuModule.menuConfig.config.animations');
    return false !== perMenu;
}

//  Plain ANSI sessions only: not PETSCII, ATASCII, or the RIP layer
function sessionAnimates(client) {
    //  late: theme.js requires (through ViewController) this module
    const { getSessionEmulation } = require('./theme.js');
    if ('ansi' !== getSessionEmulation(client)) {
        return false;
    }
    const emulation = emulationOf(_.get(client, 'term'));
    return !(_.isFunction(emulation.hasLayer) && emulation.hasLayer(RIP_LAYER));
}

//  True if |canvas| draws anything outside |width| x |height|
function overflowsBox(canvas, width, height) {
    const rows = _.isNumber(canvas.renderedRows) ? canvas.renderedRows : canvas.height;
    if (rows > height) {
        return true;
    }
    for (let r = 0; r < Math.min(rows, canvas.height); ++r) {
        for (let c = width; c < canvas.width; ++c) {
            if (' ' !== canvas.chars[r][c] || DEFAULT_ATTR !== canvas.attrs[r][c]) {
                return true;
            }
        }
    }
    return false;
}

//  |canvas| cut (or padded) to the box; warnings for what it cannot draw
function frameFromCanvas(canvas, width, height, what, warnings) {
    if (overflowsBox(canvas, width, height)) {
        warnings.push(`${what} is larger than the ${width}x${height} box; clipped`);
    }
    if (canvas.mci && canvas.mci.length > 0) {
        warnings.push(
            `${what} holds MCI codes (${canvas.mci.map(m => m.mci).join(', ')}), ` +
                'which animation frames do not support; drawn blank'
        );
    }
    (canvas.warnings || []).forEach(w => warnings.push(`${what}: ${w}`));
    return canvas.crop({ width, height });
}

//  The frame set: { frames, transitions, size, warnings }
function buildFrameSet(frames, transparent, warnings) {
    let mask = null;
    if (transparent) {
        const t = applyTransparency(frames, transparent);
        mask = t.mask;
        t.warnings.forEach(w => warnings.push(w));
    }
    return {
        frames,
        transitions: new AnsiDiff.FrameTransitions(frames, { mask }),
        size: frames.length,
        warnings,
    };
}

//
//  Art |name| for |view|, as the menu's art is found. cb(err, { artInfo,
//  key }): |key| is the resolved path, mtime and size (null if the file
//  cannot be stat'd: not cached).
//
function loadArt(view, name, cb) {
    if (!_.isString(name) || 0 === name.length) {
        return cb(new Error('Frame art name must be a non-empty string'));
    }
    const client = view.client;
    const menu = client.currentMenuModule;
    const encodedAs = _.get(menu, 'menuConfig.config.encodedAs');
    //  late: see sessionAnimates()
    const theme = require('./theme.js');
    theme.getThemeArt(
        {
            name,
            client,
            readSauce: true,
            random: false, //  one file per frame name, every time
            modArtPath: _.get(menu, 'modArtPath'),
            encodedAs,
        },
        (err, artInfo) => {
            if (err) {
                return cb(err);
            }
            if (!artInfo || !_.isString(artInfo.data) || artInfo.rip || artInfo.native) {
                return cb(new Error(`Frame art "${name}" is not ANSI art`));
            }
            if (!_.isString(artInfo.fromPath)) {
                return cb(null, { artInfo, key: null });
            }
            fs.stat(artInfo.fromPath, (statErr, stats) => {
                const key = statErr
                    ? null
                    : [artInfo.fromPath, stats.mtimeMs, stats.size, encodedAs || ''].join(
                          '|'
                      );
                return cb(null, { artInfo, key });
            });
        }
    );
}

function canvasFromArt(artInfo) {
    return AnsiCanvas.fromAnsi(artInfo.data, { sauce: artInfo.sauce });
}

//
//  The frame set |view| is configured for. cb(err, frameSet), frameSet null
//  when there is nothing to draw. Built sets are cached; warnings are
//  returned (and logged by the caller) only when a set is built.
//
function loadFrameSet(view, cb) {
    const width = view.boxWidth;
    const height = view.boxHeight;
    const source = view.frames;
    const transparent = view.transparent || '';

    if (!(width > 0) || !(height > 0)) {
        return cb(new Error('Animation needs a "width" and "height" (the box)'));
    }
    const geometry = [width, height, transparent].join('|');

    //  inline, pipe coded
    if (Array.isArray(source)) {
        if (0 === source.length || !source.every(_.isString)) {
            return cb(new Error('Inline "frames" must be a non-empty list of strings'));
        }
        const key = `inline|${geometry}|${JSON.stringify(source)}`;
        const cached = cacheGet(key);
        if (cached) {
            return cb(null, cached, true);
        }
        const warnings = [];
        const frames = source.map((text, i) =>
            frameFromCanvas(
                AnsiCanvas.fromPipe(text, { width: INLINE_PARSE_WIDTH }),
                width,
                height,
                `Frame ${i}`,
                warnings
            )
        );
        const set = buildFrameSet(frames, transparent, warnings);
        cachePut(key, set);
        return cb(null, set);
    }

    if (!_.isObject(source)) {
        return cb(new Error('Animation has no "frames"'));
    }

    //  one art file per frame
    if (Array.isArray(source.art)) {
        if (0 === source.art.length) {
            return cb(new Error('"frames.art" is an empty list'));
        }
        return async.mapSeries(
            source.art,
            (name, next) => loadArt(view, name, next),
            (err, loaded) => {
                if (err) {
                    return cb(err);
                }
                const keys = loaded.map(l => l.key);
                const key = keys.every(Boolean)
                    ? `list|${geometry}|${keys.join('||')}`
                    : null;
                const cached = key && cacheGet(key);
                if (cached) {
                    return cb(null, cached, true);
                }
                const warnings = [];
                const frames = loaded.map((l, i) =>
                    frameFromCanvas(
                        canvasFromArt(l.artInfo),
                        width,
                        height,
                        `Frame art "${source.art[i]}"`,
                        warnings
                    )
                );
                const set = buildFrameSet(frames, transparent, warnings);
                if (key) {
                    cachePut(key, set);
                }
                return cb(null, set);
            }
        );
    }

    //  a sheet: frames stacked vertically
    if (_.isString(source.art)) {
        const sheetSpec = {
            width,
            height,
            row: source.row,
            col: source.col,
            gap: source.gap,
            frameCount: source.frameCount,
        };
        return loadArt(view, source.art, (err, loaded) => {
            if (err) {
                return cb(err);
            }
            const key = loaded.key
                ? `sheet|${geometry}|${JSON.stringify(sheetSpec)}|${loaded.key}`
                : null;
            const cached = key && cacheGet(key);
            if (cached) {
                return cb(null, cached, true);
            }
            const sheet = canvasFromArt(loaded.artInfo);
            const sliced = sliceSheet(sheet, sheetSpec);
            const what = `Frame sheet "${source.art}"`;
            const warnings = sliced.warnings.map(w => `${what}: ${w}`);
            (sheet.warnings || []).forEach(w => warnings.push(`${what}: ${w}`));
            if (sheet.mci && sheet.mci.length > 0) {
                warnings.push(
                    `${what} holds MCI codes, which animation frames do not support; drawn blank`
                );
            }
            if (0 === sliced.frames.length) {
                return cb(new Error(`${what} has no whole frame of ${width}x${height}`));
            }
            const set = buildFrameSet(sliced.frames, transparent, warnings);
            if (key) {
                cachePut(key, set);
            }
            return cb(null, set);
        });
    }

    return cb(new Error('"frames" must be a list, { art: name } or { art: [ names ] }'));
}

class AnimationView extends View {
    constructor(options) {
        //  never focused, never typed into
        options = Object.assign({}, options, {
            acceptsFocus: false,
            acceptsInput: false,
        });
        super(options);

        this.boxWidth = _.get(options, 'dimens.width') || 0;
        this.boxHeight = _.get(options, 'dimens.height') || 0;
        this.frames = options.frames || null;
        this.frameInterval = DEFAULT_FRAME_INTERVAL_MS;
        this.frameDurations = null;
        this.mode = 'loop';
        this.startFrame = 0;
        this.idle = null;
        this.transparent = null;

        this._frameSet = null; //  what is drawn; null: nothing (a blank box)
        this._index = 0; //  the frame showing (or to show)
        this._dir = 1; //  pingpong
        this._drawnIndex = null; //  the frame on screen; null: not known
        this._coverMark = View.coverMark(this.client);
        this._animate = false;
        this._stopped = false; //  `once` has played out
        this._prepareState = 'none'; //  'none' | 'pending' | 'done'
        this._prepareWaiters = [];
        this._stale = false; //  config changed while loading
    }

    //  ── Config ──────────────────────────────────────────────────────────────

    setPropertyValue(propName, value) {
        switch (propName) {
            //  never focused, never typed into, whatever the config says
            case 'focus':
            case 'acceptsFocus':
            case 'acceptsInput':
                return;

            //  the frame size, as given: not clamped to the terminal (the
            //  output is clipped when written)
            case 'width':
            case 'height': {
                const n = parseInt(value, 10);
                if (n > 0) {
                    this['width' === propName ? 'boxWidth' : 'boxHeight'] = n;
                    this.dimens[propName] = n;
                    this._invalidate();
                }
                return;
            }
            case 'frames':
                this.frames = value;
                this._invalidate();
                break;
            case 'frameInterval': {
                const n = Number(value);
                if (Number.isFinite(n) && n >= 0) {
                    this.frameInterval = n;
                }
                break;
            }
            case 'frameDurations':
                this.frameDurations = Array.isArray(value) ? value.map(Number) : null;
                break;
            case 'mode':
                if (MODES.includes(value)) {
                    this.mode = value;
                } else {
                    this._warn(
                        { mode: value },
                        `Unknown animation mode; using "${this.mode}"`
                    );
                }
                break;
            case 'startFrame': {
                const n = parseInt(value, 10);
                this.startFrame = n >= 0 ? n : 0;
                break;
            }
            case 'idle':
                this.idle = parseIdle(value);
                break;
            case 'transparent':
                this.transparent =
                    _.isString(value) && value.length > 0 ? [...value][0] : null;
                this._invalidate();
                break;
        }

        super.setPropertyValue(propName, value);
    }

    //  frames (or their size) changed: loaded again before the next draw
    _invalidate() {
        if ('pending' === this._prepareState) {
            this._stale = true;
        } else if ('done' === this._prepareState) {
            this._prepareState = 'none';
            FrameClock.unregister(this);
        }
    }

    _warn(obj, msg) {
        const log = this.client && this.client.log;
        if (log && _.isFunction(log.warn)) {
            log.warn(
                Object.assign(
                    {
                        viewId: this.id,
                        mciCode: 'AV',
                        menuName: _.get(this.client, 'currentMenuModule.menuName'),
                    },
                    obj
                ),
                msg
            );
        }
    }

    //  ── Loading ─────────────────────────────────────────────────────────────

    //
    //  Load the frames, before the first draw (ViewController runs it
    //  between applyViewConfig() and redrawAll()). cb() always, never with
    //  an error: a frame that fails to load leaves the box blank. A view
    //  destroyed meanwhile draws nothing and starts no timer.
    //
    prepare(cb) {
        cb = _.isFunction(cb) ? cb : () => {};
        if (View.isDestroyed(this) || 'done' === this._prepareState) {
            return cb(null);
        }
        this._prepareWaiters.push(cb);
        if ('pending' === this._prepareState) {
            return;
        }
        this._prepareState = 'pending';
        this._load();
    }

    _load() {
        this._animate = animationsEnabled(this.client) && sessionAnimates(this.client);
        let called = false;
        const done = (err, frameSet, fromCache) => {
            if (called) {
                return;
            }
            called = true;
            this._loaded(err, frameSet, fromCache);
        };
        try {
            loadFrameSet(this, done);
        } catch (e) {
            done(e);
        }
    }

    _loaded(err, frameSet, fromCache) {
        if (!View.isDestroyed(this) && this._stale) {
            this._stale = false;
            return this._load();
        }

        this._prepareState = 'done';
        this._frameSet = null;
        this._drawnIndex = null;
        this._stopped = false;
        this._dir = 1;
        this._index = 0;

        if (err) {
            this._warn(
                { error: err.message, frames: this.frames },
                'Animation frames failed to load; the box is left blank'
            );
        } else if (frameSet) {
            this._frameSet = frameSet;
            if (!fromCache) {
                frameSet.warnings.forEach(w => this._warn({}, w));
            }
            if (this._animate) {
                this._index = this.startFrame % frameSet.size;
            }
        }

        const waiters = this._prepareWaiters;
        this._prepareWaiters = [];
        //  A waiter goes on with its form's load (the redraw, focus): what
        //  that throws is logged, not thrown out of an fs callback, and the
        //  other waiters still run
        waiters.forEach(fn => {
            try {
                fn(null);
            } catch (e) {
                const log = this.client && this.client.log;
                if (log && _.isFunction(log.error)) {
                    log.error(
                        { error: e && e.message, stack: e && e.stack, viewId: this.id },
                        'Failed continuing after animation frames loaded'
                    );
                }
            }
        });
    }

    //  ── Drawing ─────────────────────────────────────────────────────────────

    //
    //  The whole current frame. Not loaded yet (a view drawn outside a
    //  ViewController load): loaded first, then drawn in the background.
    //
    redraw() {
        if (View.isDestroyed(this)) {
            return;
        }
        if ('done' !== this._prepareState) {
            let sync = true;
            this.prepare(() => {
                if (!sync && !View.isDestroyed(this)) {
                    this.drawInBackground(() => this.redraw());
                }
            });
            sync = false;
            if ('done' !== this._prepareState) {
                return;
            }
        }

        if (this._frameSet) {
            this._write(this._frameSet.transitions.full(this._index));
            //  drawn over by whatever covers the screen, if covered
            this._drawnIndex = this.isBackgroundDrawSuspended() ? null : this._index;
            this._coverMark = View.coverMark(this.client);
        }
        this._start();
    }

    //  The frame on screen may have been drawn over: the next draw is full
    forceNextRedraw() {
        this._drawnIndex = null;
    }

    _write(t) {
        const term = this.client.term;
        AnsiDiff.write(term, t, {
            origin: this.position,
            termWidth: term.termWidth,
            termHeight: term.termHeight,
        });
    }

    //  For the clock: |target| drawn from what is on screen
    _drawTo(target) {
        if (View.isDestroyed(this) || !this._frameSet) {
            return;
        }
        if (this.isBackgroundDrawSuspended()) {
            //  the output is discarded: nothing is known to be on screen,
            //  and the redraw owed when uncovered is a full one
            this._drawnIndex = null;
            return;
        }
        const coverMark = View.coverMark(this.client);
        const from = coverMark === this._coverMark ? this._drawnIndex : null;
        this._write(this._frameSet.transitions.get(from, target));
        this._drawnIndex = target;
        this._coverMark = coverMark;
    }

    //  ── Timing ──────────────────────────────────────────────────────────────

    //  ms frame |i| shows for (the clock applies the floor)
    _waitFor(i) {
        if (this.idle && 0 === i && 'random' !== this.mode) {
            const [min, max] = this.idle;
            return min + Math.floor(Math.random() * (max - min + 1));
        }
        const d = this.frameDurations && this.frameDurations[i];
        return Number.isFinite(d) && d >= 0 ? d : this.frameInterval;
    }

    //  On the clock, if this view animates and has not played out
    _start() {
        const set = this._frameSet;
        if (
            !this._animate ||
            !set ||
            set.size < 2 ||
            this._stopped ||
            FrameClock.isRegistered(this) ||
            View.isDestroyed(this)
        ) {
            return;
        }
        if ('once' === this.mode && !this.idle && this._index >= set.size - 1) {
            this._stopped = true; //  nothing left to play
            return;
        }
        FrameClock.getFrameClock(this.client, {
            minIntervalMs: minFrameIntervalMs(),
        }).register(this, {
            tick: () => this._tick(),
            interval: this.frameInterval,
            delay: this._waitFor(this._index),
        });
    }

    //  The next frame index, and whether the animation stops after it
    _advance() {
        const n = this._frameSet.size;
        const i = this._index;
        switch (this.mode) {
            case 'pingpong':
                if (i + this._dir < 0 || i + this._dir >= n) {
                    this._dir = -this._dir;
                }
                return { next: i + this._dir, stop: false };
            case 'random': {
                const r = Math.floor(Math.random() * (n - 1));
                return { next: r >= i ? r + 1 : r, stop: false };
            }
            case 'once': {
                const next = i + 1 >= n ? 0 : i + 1;
                return { next, stop: !this.idle && next >= n - 1 };
            }
            default:
                return { next: (i + 1) % n, stop: false };
        }
    }

    //  The clock's tick: move on a frame; draw it unless nothing changes
    _tick() {
        const set = this._frameSet;
        if (!set || View.isDestroyed(this)) {
            return { stop: true };
        }
        const { next, stop } = this._advance();
        this._index = next;
        if (stop) {
            this._stopped = true;
        }

        const target = next;
        const wait = this._waitFor(target);
        //  covered: still offered, so the cover owes this view a redraw
        if (!this.isBackgroundDrawSuspended()) {
            const sameCover = View.coverMark(this.client) === this._coverMark;
            if (sameCover && null !== this._drawnIndex) {
                if (
                    this._drawnIndex === target ||
                    0 === set.transitions.get(this._drawnIndex, target).runs.length
                ) {
                    this._drawnIndex = target; //  the same cells: nothing to write
                    return { next: wait, stop };
                }
            }
        }
        return { draw: () => this._drawTo(target), next: wait, stop };
    }

    destroy() {
        FrameClock.unregister(this);
        super.destroy();
    }
}

//  [ min, max ] ms from [ min, max ] or one number; null if neither
function parseIdle(value) {
    let min;
    let max;
    if (Array.isArray(value)) {
        [min, max] = value.map(Number);
        if (undefined === value[1]) {
            max = min;
        }
    } else {
        min = max = Number(value);
    }
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < 0) {
        return null;
    }
    return min <= max ? [min, max] : [max, min];
}

function isAnimationView(view) {
    return view instanceof AnimationView;
}

exports.AnimationView = AnimationView;
exports.isAnimationView = isAnimationView;
exports.clearFrameSetCache = clearFrameSetCache;
exports.DEFAULT_FRAME_INTERVAL_MS = DEFAULT_FRAME_INTERVAL_MS;
exports.ANIMATION_MODES = MODES;
