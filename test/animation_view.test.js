'use strict';

const { strict: assert } = require('assert');
const events = require('events');
const fs = require('fs');
const os = require('os');
const paths = require('path');

const configModule = require('../core/config.js');
const { View } = require('../core/view.js');
const { ViewController } = require('../core/view_controller.js');
const { EditTextView } = require('../core/edit_text_view.js');
const { AnimationView, clearFrameSetCache } = require('../core/animation_view.js');
const FrameClock = require('../core/frame_clock.js');
const { ClientTerminal } = require('../core/client_term.js');
const { selectClientEmulation } = require('../core/term/select.js');
const theme = require('../core/theme.js');

//
//  %AV AnimationView: frame sources, modes and timing on the frame clock,
//  the prepare() step of a form load, covers, the config switch and the
//  emulation gate, placement, the implicit submit choice, pinned bytes.
//

const ESC = '\x1b';
const HIDE = `${ESC}[?25l`;
const SHOW = `${ESC}[?25h`;
const RED = `${ESC}[0;31m`;
const goto = (r, c) => `${ESC}[${r};${c}H`;

const BASE_CONFIG = {
    debug: { assertsEnabled: false },
    menus: { cls: false, animations: { enabled: true, minFrameIntervalMs: 50 } },
    general: { boardName: 'Test' },
    theme: { default: 'luciano_blocktronics' },
    paths: { themes: '/nonexistent/themes', art: '/nonexistent/art' },
    term: { cp437TermList: [], utf8TermList: [] },
};

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
        live() {
            return timers.size;
        },
        pending() {
            return [...timers.values()].map(t => t.at - now);
        },
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

//  Records socket writes; beginWrite() / commitWrite() batch, so one entry
//  is one write
function makeTerm(emulation) {
    const term = { termWidth: 80, termHeight: 25, flushes: [], _batch: null, _depth: 0 };
    if (emulation) {
        term.emulation = emulation;
    }
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
    term.all = () => term.flushes.join('');
    return term;
}

function makeClient(menuConfig = {}, { emulation, term } = {}) {
    const client = new events.EventEmitter();
    client.log = { warns: [] };
    ['trace', 'debug', 'info', 'error', 'fatal'].forEach(level => {
        client.log[level] = () => {};
    });
    client.log.warn = (obj, msg) => client.log.warns.push({ obj, msg });
    client.term = term || makeTerm(emulation);
    client.currentMenuModule = {
        menuName: 'testMenu',
        menuConfig,
        menuMethods: {},
    };
    return client;
}

//  an mciMap entry as art.display() makes one
function mci(code, id, row, col) {
    return { code, id, position: [row, col], args: [], SGR: `${ESC}[0;37m` };
}

function menuWith(mciConf, extra = {}) {
    return Object.assign({ form: { 0: { mci: mciConf } } }, extra);
}

//  load |mciMap| with the menu's form 0; returns { vc, called, error }
function load(client, mciMap) {
    const vc = new ViewController({ client });
    const result = { vc, called: 0, error: undefined };
    vc.loadFromMenuConfig({ mciMap }, err => {
        ++result.called;
        result.error = err;
    });
    return result;
}

//  a two-frame animation, 3x1, at row 5 col 10
const TWO_FRAMES = ['|04abc', '|04aXc'];

function animClient(conf = {}, extraMenu = {}, clientOptions = {}) {
    return makeClient(
        menuWith(
            {
                AV20: Object.assign(
                    { width: 3, height: 1, frames: TWO_FRAMES, frameInterval: 100 },
                    conf
                ),
            },
            extraMenu
        ),
        clientOptions
    );
}

function loadAnim(conf, extraMenu, clientOptions) {
    const client = animClient(conf, extraMenu, clientOptions);
    const r = load(client, { AV20: mci('AV', 20, 5, 10) });
    assert.equal(r.called, 1, 'loaded synchronously (inline frames)');
    assert.ifError(r.error);
    return { client, vc: r.vc, view: r.vc.getView(20) };
}

//  frames as letters, one per frame: '|04A', '|04B', ...
function letterFrames(n) {
    return Array.from({ length: n }, (_, i) => `|04${String.fromCharCode(65 + i)}`);
}

//  the letter each write shows (a 1x1 animation at row 5 col 10)
function lettersWritten(term, from = 0) {
    return term.flushes
        .slice(from)
        .map(s => {
            const m = s.match(/([A-Z])(?:\x1b\[\?25h)?$/); // eslint-disable-line no-control-regex
            return m ? m[1] : '?';
        })
        .join('');
}

describe('AnimationView (%AV)', function () {
    let time;
    let previousConfig;
    const vcs = [];

    beforeEach(function () {
        previousConfig = configModule._pushTestConfig(BASE_CONFIG);
        time = fakeTime();
        clearFrameSetCache();
    });
    afterEach(function () {
        vcs.splice(0).forEach(vc => vc.destroy());
        time.restore();
        configModule._popTestConfig(previousConfig);
    });

    const track = r => {
        vcs.push(r.vc);
        return r;
    };

    describe('pinned bytes', function () {
        it('first draw: the whole frame, inside the form redraw; a tick: changed cells only', function () {
            const { client, view } = track(loadAnim());
            assert.ok(view instanceof AnimationView);
            assert.deepEqual(client.term.flushes, [
                `${HIDE}${goto(5, 10)}${RED}abc${SHOW}`,
            ]);

            time.advance(100);
            assert.deepEqual(client.term.flushes.slice(1), [`${goto(5, 11)}${RED}X`]);
            time.advance(100);
            assert.deepEqual(client.term.flushes.slice(2), [`${goto(5, 11)}${RED}b`]);
        });

        it('never writes iCE (?33h): the art sets it, the animation only SGR', function () {
            const { client } = track(
                loadAnim({ frames: [`${ESC}[5;41mab`, `${ESC}[5;42mab`], width: 2 })
            );
            time.advance(300);
            const all = client.term.all();
            assert.ok(!all.includes('?33'), 'no iCE mode change');
            assert.ok(all.includes(`${ESC}[0;5;41m`), 'blink kept in the SGR');
        });

        it('two animations due on one tick: one write', function () {
            const client = makeClient(
                menuWith({
                    AV20: { width: 3, height: 1, frames: TWO_FRAMES, frameInterval: 100 },
                    AV21: { width: 3, height: 1, frames: TWO_FRAMES, frameInterval: 100 },
                })
            );
            const r = track(
                load(client, { AV20: mci('AV', 20, 5, 10), AV21: mci('AV', 21, 7, 10) })
            );
            assert.equal(r.called, 1);
            const n = client.term.flushes.length;
            time.advance(100);
            assert.deepEqual(client.term.flushes.slice(n), [
                //  each view's change sets its own SGR
                `${goto(5, 11)}${RED}X${goto(7, 11)}${RED}X`,
            ]);
        });

        it('with a focused field: one hide, the frames, the cursor put back', function () {
            const client = makeClient(
                menuWith({
                    ET1: { focus: true, submit: true },
                    AV20: { width: 3, height: 1, frames: TWO_FRAMES, frameInterval: 100 },
                })
            );
            const r = track(
                load(client, { ET1: mci('ET', 1, 20, 5), AV20: mci('AV', 20, 5, 10) })
            );
            assert.equal(r.called, 1);
            const field = r.vc.getView(1);
            assert.ok(field instanceof EditTextView);
            const n = client.term.flushes.length;
            time.advance(100);
            const tick = client.term.flushes.slice(n);
            assert.equal(tick.length, 1);
            assert.ok(tick[0].startsWith(`${HIDE}${goto(5, 11)}${RED}X`));
            assert.ok(tick[0].includes(goto(20, 5)), 'cursor back at the field');
            assert.ok(tick[0].endsWith(SHOW));
        });
    });

    describe('modes and timing', function () {
        let random;
        beforeEach(function () {
            random = Math.random;
        });
        afterEach(function () {
            Math.random = random;
        });

        function letters(conf, ms) {
            const client = makeClient(
                menuWith({
                    AV20: Object.assign(
                        { width: 1, height: 1, frameInterval: 100 },
                        conf
                    ),
                })
            );
            const r = track(load(client, { AV20: mci('AV', 20, 5, 10) }));
            assert.equal(r.called, 1);
            time.advance(ms);
            return { client, view: r.vc.getView(20), seq: lettersWritten(client.term) };
        }

        it('loop', function () {
            assert.equal(letters({ frames: letterFrames(3) }, 500).seq, 'ABCABC');
        });

        it('pingpong', function () {
            assert.equal(
                letters({ frames: letterFrames(3), mode: 'pingpong' }, 600).seq,
                'ABCBABC'
            );
        });

        it('once: plays to the last frame and stops there; no timer left', function () {
            const { seq } = letters({ frames: letterFrames(3), mode: 'once' }, 1000);
            assert.equal(seq, 'ABC');
            assert.equal(time.live(), 0);
        });

        it('once + idle: rests on frame 0 for the idle wait before each run', function () {
            Math.random = () => 0; //  idle wait = min
            const { client } = letters(
                {
                    frames: letterFrames(2),
                    mode: 'once',
                    idle: [1000, 3000],
                    frameDurations: [0, 250],
                },
                0
            );
            const term = client.term;
            assert.equal(lettersWritten(term), 'A');
            time.advance(999);
            assert.equal(lettersWritten(term), 'A', 'still idle');
            time.advance(1);
            assert.equal(lettersWritten(term), 'AB', 'the run');
            time.advance(249);
            assert.equal(lettersWritten(term), 'AB', 'lit for 250 ms');
            time.advance(1);
            assert.equal(lettersWritten(term), 'ABA', 'back to rest');
            time.advance(1000);
            assert.equal(lettersWritten(term), 'ABAB', 'and again');
        });

        it('random: never the frame showing', function () {
            const picks = [0, 0.99, 0.5, 0];
            let i = 0;
            Math.random = () => picks[i++ % picks.length];
            const { seq } = letters({ frames: letterFrames(3), mode: 'random' }, 400);
            assert.equal(seq.length, 5);
            for (let k = 1; k < seq.length; ++k) {
                assert.notEqual(seq[k], seq[k - 1]);
            }
            //  from A: r=0 -> B; from B: r=1 (0.99*2) -> C; from C: r=1 -> B; from B: r=0 -> A
            assert.equal(seq, 'ABCBA');
        });

        it('frameDurations: per frame, frameInterval for the rest', function () {
            const { client } = letters(
                { frames: letterFrames(3), frameDurations: [300, 50] },
                0
            );
            const term = client.term;
            time.advance(299);
            assert.equal(lettersWritten(term), 'A');
            time.advance(1);
            assert.equal(lettersWritten(term), 'AB');
            time.advance(50);
            assert.equal(lettersWritten(term), 'ABC');
            time.advance(99);
            assert.equal(lettersWritten(term), 'ABC');
            time.advance(1);
            assert.equal(lettersWritten(term), 'ABCA');
        });

        it('startFrame: the first frame shown, the second pillar out of step', function () {
            assert.equal(
                letters({ frames: letterFrames(4), startFrame: 2 }, 200).seq,
                'CDA'
            );
            //  past the end: wraps
            assert.equal(letters({ frames: letterFrames(4), startFrame: 5 }, 0).seq, 'B');
        });

        it('the floor: nothing ticks sooner than minFrameIntervalMs', function () {
            const { client } = letters({ frames: letterFrames(2), frameInterval: 5 }, 0);
            assert.deepEqual(time.pending(), [50]);
            time.advance(100);
            assert.equal(lettersWritten(client.term), 'ABA');
        });

        it('the floor comes from menus.animations.minFrameIntervalMs', function () {
            configModule._pushTestConfig(
                Object.assign({}, BASE_CONFIG, {
                    menus: { cls: false, animations: { minFrameIntervalMs: 80 } },
                })
            );
            letters({ frames: letterFrames(2), frameInterval: 10 }, 0);
            assert.deepEqual(time.pending(), [80]);
        });

        it('identical frames: no write at all', function () {
            const { client } = letters({ frames: ['|04A', '|04A', '|04B'] }, 0);
            const n = client.term.flushes.length;
            time.advance(100);
            assert.equal(client.term.flushes.length, n, 'A -> A writes nothing');
            time.advance(100);
            assert.equal(lettersWritten(client.term, n), 'B');
        });
    });

    describe('covers', function () {
        it('covered: no bytes; one full redraw when uncovered; then diffs again', function () {
            const { client, view } = track(loadAnim());
            const term = client.term;
            //  as ClientTerminal's: a covered draw runs, its output dropped
            term.discardOutput = fn => {
                const write = term.write;
                term.write = () => {};
                try {
                    fn();
                } finally {
                    term.write = write;
                }
            };
            const token = View.suspendBackgroundDraw(client);
            const n = term.flushes.length;
            time.advance(500);
            assert.equal(term.flushes.length, n, 'nothing while covered');
            assert.equal(view._drawnIndex, null, 'nothing known on screen');

            View.resumeBackgroundDraw(client, token);
            //  500 ms = 5 ticks: frame 1 is showing
            assert.deepEqual(term.flushes.slice(n), [`${goto(5, 10)}${RED}aXc`]);

            time.advance(100);
            assert.deepEqual(term.flushes.slice(n + 1), [`${goto(5, 11)}${RED}b`]);
        });

        it('a cover that came and went between ticks: the next tick is full', function () {
            const { client } = track(loadAnim());
            const term = client.term;
            const token = View.suspendBackgroundDraw(client);
            View.resumeBackgroundDraw(client, token);
            const n = term.flushes.length;
            time.advance(100);
            assert.deepEqual(term.flushes.slice(n), [`${goto(5, 10)}${RED}aXc`]);
        });

        it('form cover(): no bytes; uncover({ redraw }) draws it whole', function () {
            const { client, vc } = track(loadAnim());
            const term = client.term;
            vc.cover();
            const n = term.flushes.length;
            time.advance(300);
            assert.equal(term.flushes.length, n);
            vc.uncover({ redraw: true });
            assert.equal(term.flushes.length, n + 1);
            assert.ok(term.flushes[n].includes(`${goto(5, 10)}${RED}aXc`));
        });

        it('pauseWhenInactive: no ticks while inactive, one full redraw on activate', function () {
            const { client, vc, view } = track(loadAnim({ pauseWhenInactive: true }));
            const term = client.term;
            vc.deactivate();
            const n = term.flushes.length;
            time.advance(500);
            assert.equal(term.flushes.length, n);
            assert.equal(view._index, 0, 'frames do not move on unseen');
            vc.activate();
            assert.ok(
                term.flushes
                    .slice(n)
                    .join('')
                    .includes(`${goto(5, 10)}${RED}abc`)
            );
        });

        it('forceNextRedraw(): the next tick writes the whole frame', function () {
            const { client, view } = track(loadAnim());
            view.forceNextRedraw();
            const n = client.term.flushes.length;
            time.advance(100);
            assert.deepEqual(client.term.flushes.slice(n), [`${goto(5, 10)}${RED}aXc`]);
        });
    });

    describe('prepare()', function () {
        let saved;
        let pending;
        beforeEach(function () {
            saved = theme.getThemeArt;
            pending = [];
            //  art that loads when the test says
            theme.getThemeArt = (options, cb) => pending.push({ options, cb });
        });
        afterEach(function () {
            theme.getThemeArt = saved;
        });

        const artInfo = data => ({ data, fromPath: null });

        it('the form is drawn once every view has prepared', function () {
            const client = animClient({ frames: { art: ['f1', 'f2'] } });
            const r = track(load(client, { AV20: mci('AV', 20, 5, 10) }));
            assert.equal(r.called, 0, 'waiting on the art');
            assert.equal(client.term.flushes.length, 0, 'nothing drawn yet');
            pending.shift().cb(null, artInfo(`${ESC}[31mabc`));
            pending.shift().cb(null, artInfo(`${ESC}[31maXc`));
            assert.equal(r.called, 1);
            assert.deepEqual(client.term.flushes, [
                `${HIDE}${goto(5, 10)}${RED}abc${SHOW}`,
            ]);
            assert.ok(FrameClock.isRegistered(r.vc.getView(20)));
        });

        it('form destroyed before it finishes: no draw, no timer, the caller still called back', function () {
            const client = animClient({ frames: { art: ['f1', 'f2'] } });
            const r = load(client, { AV20: mci('AV', 20, 5, 10) });
            const view = r.vc.getView(20);
            r.vc.destroy(); //  the menu was left
            pending.shift().cb(null, artInfo('abc'));
            pending.shift().cb(null, artInfo('aXc'));
            assert.equal(r.called, 1);
            assert.ifError(r.error);
            assert.equal(client.term.flushes.length, 0);
            assert.equal(FrameClock.isRegistered(view), false);
            assert.equal(time.live(), 0);
        });

        it('a view destroyed on its own while loading: nothing drawn or started', function () {
            const client = makeClient();
            const view = new AnimationView({
                client,
                id: 20,
                position: { row: 5, col: 10 },
            });
            ['width', 'height'].forEach(p => view.setPropertyValue(p, 3));
            view.setPropertyValue('frames', { art: 'sheet' });
            view.redraw(); //  not prepared: loads first
            view.destroy();
            pending.shift().cb(null, artInfo('abc\r\naXc'));
            assert.equal(client.term.flushes.length, 0);
            assert.equal(time.live(), 0);
        });

        it('load error: the box stays blank, a warning, and the menu still loads', function () {
            const client = makeClient(
                menuWith({
                    TL1: { text: 'hello' },
                    AV20: { width: 3, height: 1, frames: { art: 'missing' } },
                })
            );
            const r = track(
                load(client, { TL1: mci('TL', 1, 2, 2), AV20: mci('AV', 20, 5, 10) })
            );
            pending.shift().cb(new Error('No matching art'));
            assert.equal(r.called, 1);
            assert.ifError(r.error);
            const out = client.term.all();
            assert.ok(out.includes('hello'), 'the rest of the form is drawn');
            assert.ok(!out.includes(goto(5, 10)), 'nothing in the box');
            assert.equal(time.live(), 0);
            assert.ok(
                client.log.warns.some(w => /failed to load/.test(w.msg)),
                'warned'
            );
        });

        it('art whose parse throws (ESC [ u, nothing saved): a load error, the menu still loads', function () {
            //  thrown inside the art's callback, after prepare() returned
            [{ art: ['f1', 'f2'] }, { art: 'sheet' }].forEach(frames => {
                const client = makeClient(
                    menuWith({
                        TL1: { text: 'hello' },
                        AV20: { width: 3, height: 1, frames },
                    })
                );
                const r = track(
                    load(client, { TL1: mci('TL', 1, 2, 2), AV20: mci('AV', 20, 5, 10) })
                );
                while (pending.length > 0) {
                    pending.shift().cb(null, artInfo(`abc${ESC}[u`));
                }
                assert.equal(r.called, 1, JSON.stringify(frames));
                assert.ifError(r.error);
                const out = client.term.all();
                assert.ok(out.includes('hello'), 'the rest of the form is drawn');
                assert.ok(!out.includes(goto(5, 10)), 'nothing in the box');
                assert.ok(
                    client.log.warns.some(w => /failed to load/.test(w.msg)),
                    'warned'
                );
            });
            assert.equal(time.live(), 0);
        });

        it('bad config never fails the menu (no width, no frames, a bad list)', function () {
            theme.getThemeArt = saved;
            [
                { frames: TWO_FRAMES, width: undefined },
                { frames: undefined },
                { frames: [1, 2] },
                { frames: { art: [] } },
                { frames: 'nope' },
            ].forEach(conf => {
                const client = animClient(conf);
                const r = track(load(client, { AV20: mci('AV', 20, 5, 10) }));
                assert.equal(r.called, 1, JSON.stringify(conf));
                assert.ifError(r.error);
                assert.ok(client.log.warns.length > 0, JSON.stringify(conf));
            });
            assert.equal(time.live(), 0);
        });

        it('a form with no prepare() views loads synchronously, as before', function () {
            const client = makeClient(menuWith({ TL1: { text: 'x' } }));
            const r = track(load(client, { TL1: mci('TL', 1, 2, 2) }));
            assert.equal(r.called, 1);
            assert.equal(pending.length, 0);
        });

        it('prompt config loads prepare too', function () {
            const client = makeClient({
                promptConfig: {
                    mci: { AV20: { width: 3, height: 1, frames: { art: ['a', 'b'] } } },
                },
            });
            const vc = new ViewController({ client });
            vcs.push(vc);
            let called = 0;
            vc.loadFromPromptConfig(
                { mciMap: { AV20: mci('AV', 20, 5, 10) } },
                () => ++called
            );
            assert.equal(called, 0);
            pending.shift().cb(null, artInfo('abc'));
            pending.shift().cb(null, artInfo('aXc'));
            assert.equal(called, 1);
            assert.ok(client.term.all().includes(`${goto(5, 10)}${ESC}[0mabc`));
        });
    });

    describe('frame sources', function () {
        let dir;
        before(function () {
            dir = fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-av-'));
        });
        after(function () {
            fs.rmSync(dir, { recursive: true, force: true });
        });

        //  load and wait for the art reads (real files): |done| gets the result
        function loadAsync(client, done) {
            const vc = new ViewController({ client });
            vcs.push(vc);
            const mciMap = { AV20: mci('AV', 20, 5, 10) };
            vc.loadFromMenuConfig({ mciMap }, err => done(err, vc));
        }

        //  real fs, real timers for the reads: put Date/setTimeout back
        function realTime() {
            time.restore();
        }

        it('a sheet, vertical, with a region origin and a gap; cached by path and mtime', function (done) {
            realTime();
            const file = paths.join(dir, 'sheet.ans');
            //  two 3x1 frames at col 2, a blank row between them
            fs.writeFileSync(file, 'xabcx\r\n\r\nxaXcx\r\n');
            const conf = { frames: { art: file, col: 2, gap: 1 } };
            loadAsync(animClient(conf), (err, vc) => {
                assert.ifError(err);
                const view = vc.getView(20);
                assert.equal(view._frameSet.size, 2);
                assert.ok(vc.client.term.all().includes(`${goto(5, 10)}${ESC}[0mabc`));
                const firstSet = view._frameSet;

                //  another client, same file: the same frame set
                loadAsync(animClient(conf), (err, vc2) => {
                    assert.ifError(err);
                    assert.equal(vc2.getView(20)._frameSet, firstSet);

                    //  edited: built again
                    fs.writeFileSync(file, 'xdefx\r\n\r\nxdXfx\r\n');
                    const later = new Date(Date.now() + 5000);
                    fs.utimesSync(file, later, later);
                    loadAsync(animClient(conf), (err, vc3) => {
                        assert.ifError(err);
                        assert.notEqual(vc3.getView(20)._frameSet, firstSet);
                        assert.ok(vc3.client.term.all().includes('def'));
                        done();
                    });
                });
            });
        });

        it('a list of art files, one per frame', function (done) {
            realTime();
            const a = paths.join(dir, 'f1.ans');
            const b = paths.join(dir, 'f2.ans');
            fs.writeFileSync(a, `${ESC}[31mabc`);
            fs.writeFileSync(b, `${ESC}[31maXc`);
            loadAsync(animClient({ frames: { art: [a, b] } }), (err, vc) => {
                assert.ifError(err);
                assert.equal(vc.getView(20)._frameSet.size, 2);
                assert.ok(vc.client.term.all().includes(`${goto(5, 10)}${RED}abc`));
                done();
            });
        });

        it('frames larger than the box are clipped, with a warning', function () {
            const { client, view } = track(
                loadAnim({ frames: ['|04abcdef', '|04aXcdef\n|04zz'] })
            );
            assert.equal(view._frameSet.frames[0].width, 3);
            assert.ok(client.term.all().includes(`${RED}abc${SHOW}`));
            assert.ok(!client.term.all().includes('d'));
            const warns = client.log.warns.filter(w =>
                /larger than the 3x1 box/.test(w.msg)
            );
            assert.equal(warns.length, 2);
        });

        it('transparent in every frame: never drawn', function () {
            const { client } = track(
                loadAnim({ frames: ['|04a~c', '|04X~Y'], transparent: '~' })
            );
            assert.ok(client.term.all().includes(`${goto(5, 10)}${RED}a${ESC}[1Cc`));
            const n = client.term.flushes.length;
            time.advance(100);
            assert.deepEqual(client.term.flushes.slice(n), [
                `${goto(5, 10)}${RED}X${ESC}[1CY`,
            ]);
        });

        it('built frame sets are shared across clients', function () {
            const a = track(loadAnim());
            const b = track(loadAnim());
            assert.equal(a.view._frameSet, b.view._frameSet);
        });
    });

    describe('when not animated: frame 0 once, nothing ticks', function () {
        function assertStill({ client, view }, frame0 = 'abc') {
            assert.ok(client.term.all().includes(`${goto(5, 10)}${RED}${frame0}`));
            assert.equal(FrameClock.isRegistered(view), false);
            assert.equal(time.live(), 0);
            const n = client.term.flushes.length;
            time.advance(1000);
            assert.equal(client.term.flushes.length, n);
        }

        it('menus.animations.enabled false', function () {
            configModule._pushTestConfig(
                Object.assign({}, BASE_CONFIG, {
                    menus: { cls: false, animations: { enabled: false } },
                })
            );
            assertStill(track(loadAnim({ startFrame: 1 })));
        });

        it("the menu's config.animations false; true leaves it on", function () {
            assertStill(track(loadAnim({}, { config: { animations: false } })));

            const on = track(loadAnim({}, { config: { animations: true } }));
            assert.ok(FrameClock.isRegistered(on.view));
        });

        it("the system switch is a hard off: the menu's config.animations true cannot override it", function () {
            configModule._pushTestConfig(
                Object.assign({}, BASE_CONFIG, {
                    menus: { cls: false, animations: { enabled: false } },
                })
            );
            assertStill(
                track(loadAnim({ startFrame: 1 }, { config: { animations: true } }))
            );
        });

        it('PETSCII, ATASCII and RIP sessions', function () {
            [
                { name: 'petscii', hasLayer: () => false },
                { name: 'atascii', hasLayer: () => false },
                { name: 'ansi', hasLayer: name => 'rip' === name },
            ].forEach(emulation => {
                assertStill(track(loadAnim({}, {}, { emulation })));
            });
        });

        [
            ['petscii', 40],
            ['atascii', 40],
        ].forEach(([emulationName, cols]) => {
            it(`${emulationName}: frame 0 goes through the session translator, as any view output`, function () {
                const written = [];
                const output = {
                    writable: true,
                    write(data, cb) {
                        written.push(Buffer.from(data));
                        if (cb) {
                            cb(null);
                        }
                    },
                };
                const term = new ClientTerminal(output);
                const client = makeClient(
                    menuWith({ AV20: { width: 3, height: 1, frames: TWO_FRAMES } }),
                    { term }
                );
                selectClientEmulation(client, {
                    firstMenu: 'telnetConnected',
                    listener: { name: emulationName, emulation: emulationName },
                });
                assert.equal(term.emulation.name, emulationName);
                term.termWidth = cols;
                term.termHeight = 24;
                term.emulation.probes.forEach(probe => probe.run(client, () => {}));
                const before = written.length;

                const r = track(load(client, { AV20: mci('AV', 20, 5, 10) }));
                assert.equal(r.called, 1);
                const wire = Buffer.concat(written.slice(before));
                assert.ok(wire.length > 0, 'frame 0 written');
                assert.equal(
                    wire.indexOf(0x1b),
                    -1,
                    'no ANSI escape reaches the terminal'
                );
                assert.ok(wire.length < 64, 'one small frame, translated');
                assert.equal(FrameClock.isRegistered(r.vc.getView(20)), false);
                assert.equal(time.live(), 0);
            });
        });
    });

    describe('the form', function () {
        it('placed by config position with no marker', function () {
            const client = makeClient(
                menuWith({
                    AV20: {
                        position: { row: 3, col: 4 },
                        width: 3,
                        height: 1,
                        frames: TWO_FRAMES,
                    },
                })
            );
            const r = track(load(client, { TL1: mci('TL', 1, 1, 1) }));
            assert.equal(r.called, 1);
            const view = r.vc.getView(20);
            assert.ok(view instanceof AnimationView);
            assert.deepEqual(view.position, { row: 3, col: 4 });
            assert.ok(client.term.all().includes(`${goto(3, 4)}${RED}abc`));
        });

        it('not focusable and takes no input: left out of focus order and form data', function () {
            const client = makeClient(
                menuWith({
                    ET1: { argName: 'cmd' },
                    //  config cannot make it take focus or input
                    AV20: {
                        width: 3,
                        height: 1,
                        frames: TWO_FRAMES,
                        acceptsFocus: true,
                        acceptsInput: true,
                    },
                })
            );
            const r = track(
                load(client, { ET1: mci('ET', 1, 20, 5), AV20: mci('AV', 20, 5, 10) })
            );
            const view = r.vc.getView(20);
            assert.equal(view.acceptsFocus, false);
            assert.equal(view.acceptsInput, false);
            assert.equal(r.vc.getView(1).nextId, '1');
            assert.deepEqual(Object.keys(r.vc.getFormData().value), ['cmd']);
        });

        it('implicit submit: as without the animation (marker, position, or no view)', function () {
            const forms = {
                marker: [
                    {
                        ET1: {},
                        ET2: {},
                        AV20: { width: 3, height: 1, frames: TWO_FRAMES },
                    },
                    {
                        ET1: mci('ET', 1, 20, 5),
                        ET2: mci('ET', 2, 21, 5),
                        AV20: mci('AV', 20, 5, 10),
                    },
                ],
                position: [
                    {
                        ET1: {},
                        ET2: {},
                        AV20: {
                            position: [3, 3],
                            width: 3,
                            height: 1,
                            frames: TWO_FRAMES,
                        },
                    },
                    { ET1: mci('ET', 1, 20, 5), ET2: mci('ET', 2, 21, 5) },
                ],
                'no view': [
                    {
                        ET1: {},
                        ET2: {},
                        AV20: { width: 3, height: 1, frames: TWO_FRAMES },
                    },
                    { ET1: mci('ET', 1, 20, 5), ET2: mci('ET', 2, 21, 5) },
                ],
                without: [
                    { ET1: {}, ET2: {} },
                    { ET1: mci('ET', 1, 20, 5), ET2: mci('ET', 2, 21, 5) },
                ],
            };
            Object.entries(forms).forEach(([name, [mciConf, mciMap]]) => {
                const r = track(load(makeClient(menuWith(mciConf)), mciMap));
                assert.equal(r.called, 1, name);
                assert.equal(r.vc.getView(2).submit, true, `${name}: ET2 submits`);
                assert.notEqual(r.vc.getView(1).submit, true, name);
                const av = r.vc.getView(20);
                if (av) {
                    assert.notEqual(av.submit, true, `${name}: not the animation`);
                }
            });
        });

        it('an explicit form key still matches with an %AV marker in the art', function () {
            const client = makeClient({
                form: {
                    0: {
                        VM: {
                            mci: {
                                VM1: { items: ['a', 'b'] },
                                AV20: { width: 3, height: 1, frames: TWO_FRAMES },
                            },
                        },
                    },
                },
            });
            const r = track(
                load(client, { VM1: mci('VM', 1, 10, 10), AV20: mci('AV', 20, 5, 10) })
            );
            assert.equal(r.called, 1);
            assert.ok(r.vc.getView(20)._frameSet, 'the VM form config applied to the AV');
        });

        it('menu leave tears it down: off the clock, no timer', function () {
            const { vc, view } = loadAnim();
            assert.ok(FrameClock.isRegistered(view));
            vc.destroy();
            assert.equal(FrameClock.isRegistered(view), false);
            assert.equal(time.live(), 0);
        });
    });
});
