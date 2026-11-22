'use strict';

const { strict: assert } = require('assert');
const events = require('events');

const configModule = require('../core/config.js');
const { View } = require('../core/view.js');
const { ViewController } = require('../core/view_controller.js');
const FrameClock = require('../core/frame_clock.js');
const { pipeToAnsi } = require('../core/color_codes.js');

//
//  Animated focused menu items (focusItemFrames) in the MenuView base, for
//  VM, HM, FM and SM: navigation, ticks, the visible window, focus, covers,
//  teardown, the off switches and the emulation gate, the render cache.
//

const ESC = '\x1b';
const HIDE = `${ESC}[?25l`;
const SHOW = `${ESC}[?25h`;
const N = `${ESC}[0;37m`; //  the views' normal SGR (from the art)
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
    term.since = n => term.flushes.slice(n);
    return term;
}

function makeClient(menuConfig = {}, { emulation } = {}) {
    const client = new events.EventEmitter();
    client.log = { warns: [] };
    ['trace', 'debug', 'info', 'error', 'fatal'].forEach(level => {
        client.log[level] = () => {};
    });
    client.log.warn = (obj, msg) => client.log.warns.push({ obj, msg });
    client.term = makeTerm(emulation);
    client.currentMenuModule = {
        menuName: 'testMenu',
        menuConfig,
        menuMethods: {},
    };
    return client;
}

function mci(code, id, row, col) {
    return { code, id, position: [row, col], args: [], SGR: N };
}

const FRAMES = ['|15>{text}', '|11>>{text}', '|03>>>{text}'];
const ITEMS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'];

//  a VM1 at row 5 col 10, 10 wide, 3 high: [ one, two, three ] visible
function vmConf(conf = {}) {
    return Object.assign(
        {
            items: ITEMS,
            focus: true,
            submit: true,
            width: 10,
            height: 3,
            focusItemFrames: FRAMES,
            focusItemFrameInterval: 100,
        },
        conf
    );
}

//  load form 0 of |client|'s menu from |mciMap|
function load(client, mciMap) {
    const vc = new ViewController({ client });
    let called = 0;
    vc.loadFromMenuConfig({ mciMap }, err => {
        assert.ifError(err);
        ++called;
    });
    assert.equal(called, 1, 'loaded synchronously');
    return vc;
}

function loadView(code, conf, { extraMenu = {}, clientOptions, row = 5, col = 10 } = {}) {
    const key = `${code}1`;
    const client = makeClient(
        Object.assign({ form: { 0: { mci: { [key]: conf } } } }, extraMenu),
        clientOptions
    );
    const vc = load(client, { [key]: mci(code, 1, row, col) });
    return { client, vc, view: vc.getView(1), term: client.term };
}

//  VM line: the focused item from |format|, as VM draws it (10 wide)
function vmFocused(row, format, text, col = 10) {
    const rendered = `>${'>'.repeat(format)}${text}`;
    return `${goto(row, col)}${N}${pipeToAnsi(FRAMES[format].slice(0, 3))}${rendered}${N}${' '.repeat(10 - rendered.length)}`;
}

function vmPlain(row, text, col = 10) {
    return `${goto(row, col)}${N}${text}${N}${' '.repeat(10 - text.length)}`;
}

const key = name => ({ name });

//  What a terminal shows after |term|'s writes (from write |from| on):
//  cursor moves (ESC[r;cH) followed, every other escape skipped. row(r) is
//  that row's text; maxCol(r) the rightmost column written on it.
function screen(term, from = 0) {
    const cells = {};
    const maxCols = {};
    let r = 1;
    let c = 1;
    const s = term.since(from).join('');
    for (let i = 0; i < s.length; ++i) {
        if ('\x1b' === s[i]) {
            const m = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(s.slice(i));
            if (m) {
                if ('H' === m[2]) {
                    const [row, col] = m[1].split(';');
                    r = parseInt(row, 10) || 1;
                    c = parseInt(col, 10) || 1;
                }
                i += m[0].length - 1;
                continue;
            }
        }
        cells[`${r},${c}`] = s[i];
        maxCols[r] = Math.max(maxCols[r] || 0, c);
        ++c;
    }
    return {
        row(row, from, to) {
            let text = '';
            for (let col = from; col <= to; ++col) {
                text += cells[`${row},${col}`] || ' ';
            }
            return text;
        },
        maxCol(row) {
            return maxCols[row] || 0;
        },
    };
}

describe('Animated focused menu items (focusItemFrames)', function () {
    let time;
    let previousConfig;
    const vcs = [];

    beforeEach(function () {
        previousConfig = configModule._pushTestConfig(BASE_CONFIG);
        time = fakeTime();
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

    describe('VerticalMenuView', function () {
        it('focused: frame 0 drawn; each tick draws only the focused item, the cursor kept hidden', function () {
            const { term, view } = track(loadView('VM', vmConf()));
            assert.ok(term.all().includes(vmFocused(5, 0, 'one')));
            assert.ok(FrameClock.isRegistered(view));

            const n = term.flushes.length;
            time.advance(99);
            assert.equal(term.flushes.length, n, 'frame 0 shows for the interval');
            time.advance(1);
            assert.deepEqual(term.since(n), [`${HIDE}${vmFocused(5, 1, 'one')}${HIDE}`]);
            time.advance(100);
            assert.deepEqual(term.since(n + 1), [
                `${HIDE}${vmFocused(5, 2, 'one')}${HIDE}`,
            ]);
            time.advance(100);
            assert.deepEqual(term.since(n + 2), [
                `${HIDE}${vmFocused(5, 0, 'one')}${HIDE}`,
            ]);
            assert.ok(
                !term.since(n).join('').includes(SHOW),
                'the list never shows the cursor'
            );
        });

        it('navigation draws frame 0 at once, mid-cycle; the next tick draws the new index', function () {
            const { term, view } = track(loadView('VM', vmConf()));
            time.advance(150); //  frame 1 showing on "one", 50 ms in
            const n = term.flushes.length;
            view.onKeyPress(null, key('down arrow'));
            //  synchronously, in the key handler: no tick waited for
            assert.deepEqual(
                term.since(n).join(''),
                [vmPlain(5, 'one'), vmFocused(6, 0, 'two')].join('')
            );

            const m = term.flushes.length;
            time.advance(99);
            assert.equal(
                term.flushes.length,
                m,
                'the cycle starts again: a full frame 0'
            );
            time.advance(1);
            assert.deepEqual(term.since(m), [`${HIDE}${vmFocused(6, 1, 'two')}${HIDE}`]);
        });

        it('scrolling: the frame 0 draw is part of the redraw; ticks follow the new window', function () {
            const { term, view } = track(loadView('VM', vmConf()));
            view.onKeyPress(null, key('down arrow'));
            view.onKeyPress(null, key('down arrow'));
            const n = term.flushes.length;
            view.onKeyPress(null, key('down arrow')); //  "four": the window scrolls
            assert.ok(
                term
                    .since(n)
                    .join('')
                    .includes(vmFocused(7, 0, 'four'))
            );
            const m = term.flushes.length;
            time.advance(100);
            assert.deepEqual(term.since(m), [`${HIDE}${vmFocused(7, 1, 'four')}${HIDE}`]);
        });

        it('a jump to an item never drawn (end): frame 0 drawn and cached as frame 0', function () {
            const { term, view } = track(loadView('VM', vmConf()));
            time.advance(100); //  frame 1 showing
            assert.equal(view.renderCache[6], undefined, '"seven" never drawn');
            const n = term.flushes.length;
            view.onKeyPress(null, key('end'));
            assert.ok(
                term
                    .since(n)
                    .join('')
                    .includes(vmFocused(7, 0, 'seven'))
            );
            assert.ok(view.renderCache[6]['focus#0'].includes('>seven'));
            assert.equal(view.renderCache[6]['focus#1'], undefined);
            const m = term.flushes.length;
            time.advance(100);
            assert.deepEqual(term.since(m), [
                `${HIDE}${vmFocused(7, 1, 'seven')}${HIDE}`,
            ]);
        });

        it('the focused item outside the visible window: the tick draws nothing', function () {
            const { term, view } = track(loadView('VM', vmConf()));
            //  moved without a redraw (as a module might): not on screen
            view.focusedItemIndex = 5;
            const n = term.flushes.length;
            time.advance(500);
            assert.equal(term.flushes.length, n);
            assert.ok(FrameClock.isRegistered(view), 'still cycling');
            //  drawn again: in the window, ticking there
            view.setFocusItemIndex(5);
            const m = term.flushes.length;
            time.advance(100);
            assert.equal(term.flushes.length, m + 1);
            assert.ok(term.flushes[m].includes('>>six'));
        });

        it('blur stops the cycle and draws the static format; focus starts it again at frame 0', function () {
            const { term, view } = track(loadView('VM', vmConf()));
            time.advance(100);
            let n = term.flushes.length;
            view.setFocus(false);
            assert.equal(FrameClock.isRegistered(view), false);
            assert.equal(time.live(), 0);
            assert.ok(
                term
                    .since(n)
                    .join('')
                    .includes(vmFocused(5, 0, 'one'))
            );
            n = term.flushes.length;
            time.advance(1000);
            assert.equal(term.flushes.length, n, 'nothing ticks while blurred');

            view.setFocus(true);
            assert.ok(
                term
                    .since(n)
                    .join('')
                    .includes(vmFocused(5, 0, 'one'))
            );
            const m = term.flushes.length;
            time.advance(100);
            assert.deepEqual(term.since(m), [`${HIDE}${vmFocused(5, 1, 'one')}${HIDE}`]);
        });

        it('blurred, focusItemFormat set: the static format is focusItemFormat', function () {
            const { term, view } = track(
                loadView('VM', vmConf({ focusItemFormat: '|14[{text}]' }))
            );
            assert.ok(term.all().includes(vmFocused(5, 0, 'one')), 'focused: frames');
            const n = term.flushes.length;
            view.setFocus(false);
            assert.ok(
                term
                    .since(n)
                    .join('')
                    .includes(`${goto(5, 10)}${N}${pipeToAnsi('|14')}[one]${N}     `)
            );
        });

        it('complex items: frames format their members, as focusItemFormat does', function () {
            const items = ITEMS.map((text, i) => ({ text, data: `d${i}`, tag: `#${i}` }));
            const { term } = track(
                loadView(
                    'VM',
                    vmConf({
                        items,
                        itemFormat: '{text}',
                        focusItemFrames: ['|15{text}{tag}', '|11{tag}{text}'],
                    })
                )
            );
            assert.ok(term.all().includes(`${pipeToAnsi('|15')}one#0`));
            time.advance(100);
            assert.ok(term.all().includes(`${pipeToAnsi('|11')}#0one`));
        });

        it('render cache: one entry per frame; nothing formatted again on later cycles', function () {
            const { view } = track(loadView('VM', vmConf()));
            let formatted = 0;
            const render = view.renderFocusItemFrame.bind(view);
            view.renderFocusItemFrame = (...args) => {
                ++formatted;
                return render(...args);
            };
            time.advance(300); //  frames 1, 2, 0
            assert.equal(formatted, 2, 'frames 1 and 2 (0 was cached by the first draw)');
            assert.deepEqual(Object.keys(view.renderCache[0]).sort(), [
                'focus#0',
                'focus#1',
                'focus#2',
            ]);
            time.advance(600);
            assert.equal(formatted, 2, 'cached from then on');

            //  invalidated exactly as the focus cache is
            view.setPropertyValue('itemFormat', '{text}');
            assert.deepEqual(view.renderCache, {});
            time.advance(100);
            assert.equal(formatted, 3);
        });

        it('focusItemFrameDurations: per frame, the interval for the rest', function () {
            const { term } = track(
                loadView('VM', vmConf({ focusItemFrameDurations: [300, null, 200] }))
            );
            const n = term.flushes.length;
            time.advance(299);
            assert.equal(term.flushes.length, n);
            time.advance(1);
            assert.equal(term.flushes.length, n + 1, 'frame 0: 300');
            time.advance(99);
            assert.equal(term.flushes.length, n + 1);
            time.advance(1);
            assert.equal(term.flushes.length, n + 2, 'frame 1: the interval');
            time.advance(199);
            assert.equal(term.flushes.length, n + 2);
            time.advance(1);
            assert.equal(term.flushes.length, n + 3, 'frame 2: 200');
            assert.ok(term.flushes[n + 1].includes('>>>one'), 'frame 2 drawn');
        });

        it('the floor: nothing ticks sooner than menus.animations.minFrameIntervalMs', function () {
            configModule._pushTestConfig(
                Object.assign({}, BASE_CONFIG, {
                    menus: {
                        cls: false,
                        animations: { enabled: true, minFrameIntervalMs: 80 },
                    },
                })
            );
            const { term } = track(
                loadView('VM', vmConf({ focusItemFrameInterval: 10 }))
            );
            const n = term.flushes.length;
            time.advance(79);
            assert.equal(term.flushes.length, n);
            time.advance(1);
            assert.equal(term.flushes.length, n + 1);
            time.advance(80);
            assert.equal(term.flushes.length, n + 2);
        });

        it('pingpong: 0, 1, 2, 1, 0, 1', function () {
            const { term } = track(
                loadView('VM', vmConf({ focusItemFrameMode: 'pingpong' }))
            );
            const n = term.flushes.length;
            time.advance(500);
            const frames = term
                .since(n)
                .map(s => (s.match(/(>+)one/) || [])[1].length - 1);
            assert.deepEqual(frames, [1, 2, 1, 0, 1]);
        });

        it('an unknown mode is warned and loop is used', function () {
            const { client, term } = track(
                loadView('VM', vmConf({ focusItemFrameMode: 'bounce' }))
            );
            assert.ok(client.log.warns.some(w => /focusItemFrameMode/.test(w.msg)));
            const n = term.flushes.length;
            time.advance(300);
            const frames = term
                .since(n)
                .map(s => (s.match(/(>+)one/) || [])[1].length - 1);
            assert.deepEqual(frames, [1, 2, 0]);
        });

        it('one frame: drawn while focused, nothing ticks', function () {
            const { term, view } = track(
                loadView('VM', vmConf({ focusItemFrames: ['|15>{text}'] }))
            );
            assert.ok(term.all().includes(vmFocused(5, 0, 'one')));
            assert.equal(FrameClock.isRegistered(view), false);
            assert.equal(time.live(), 0);
        });

        it('with per-item focusItems: focusItems drawn, frames ignored, warned once', function () {
            const { client, term, view } = track(
                loadView('VM', vmConf({ focusItems: ITEMS.map(t => `|14*${t}`) }))
            );
            assert.ok(term.all().includes(`${pipeToAnsi('|14')}*one`));
            assert.equal(FrameClock.isRegistered(view), false);
            assert.equal(time.live(), 0);
            const warns = client.log.warns.filter(w => /focusItems/.test(w.msg));
            assert.equal(warns.length, 1);
        });
    });

    describe('covers and teardown', function () {
        it('covered: no bytes; one full redraw when uncovered, with the current frame', function () {
            const { client, term } = track(loadView('VM', vmConf()));
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
            time.advance(400); //  frames 1, 2, 0, 1
            assert.equal(term.flushes.length, n, 'nothing while covered');

            View.resumeBackgroundDraw(client, token);
            assert.equal(term.flushes.length, n + 1, 'one write: the full redraw');
            const redraw = term.flushes[n];
            assert.ok(redraw.includes(vmFocused(5, 1, 'one')));
            assert.ok(redraw.includes(vmPlain(6, 'two')));
            assert.ok(redraw.includes(vmPlain(7, 'three')));

            time.advance(100);
            assert.deepEqual(term.since(n + 1), [
                `${HIDE}${vmFocused(5, 2, 'one')}${HIDE}`,
            ]);
        });

        it('form cover(): no bytes; uncover({ redraw }) draws it whole', function () {
            const { term, vc } = track(loadView('VM', vmConf()));
            vc.cover();
            const n = term.flushes.length;
            time.advance(300);
            assert.equal(term.flushes.length, n);
            vc.uncover({ redraw: true });
            assert.ok(term.since(n).join('').includes(vmPlain(7, 'three')));
        });

        it('pauseWhenInactive: no ticks while the form is inactive', function () {
            const { term, vc, view } = track(
                loadView('VM', vmConf({ pauseWhenInactive: true }))
            );
            vc.deactivate();
            const n = term.flushes.length;
            time.advance(500);
            assert.equal(term.flushes.length, n);
            assert.equal(view._focusFrame, 0, 'frames do not move on unseen');
            vc.activate();
            assert.ok(
                term
                    .since(n)
                    .join('')
                    .includes(vmFocused(5, 0, 'one'))
            );
        });

        it('destroy(), menu leave and disconnect leave no timer', function () {
            const a = loadView('VM', vmConf());
            assert.ok(FrameClock.isRegistered(a.view));
            a.view.destroy();
            assert.equal(FrameClock.isRegistered(a.view), false);
            assert.equal(time.live(), 0);
            a.vc.destroy();

            const b = loadView('VM', vmConf());
            b.vc.destroy(); //  MenuModule.leave() -> detachViewControllers()
            assert.equal(FrameClock.isRegistered(b.view), false);
            assert.equal(time.live(), 0);

            const c = loadView('VM', vmConf());
            c.client.emit('end');
            assert.equal(FrameClock.isRegistered(c.view), false);
            assert.equal(time.live(), 0);
            c.vc.destroy();
        });
    });

    describe('when not animated: one static format, nothing ticks', function () {
        function assertStatic({ term, view }, line) {
            assert.ok(term.all().includes(line), 'static format drawn');
            assert.equal(FrameClock.isRegistered(view), false);
            assert.equal(time.live(), 0);
            const n = term.flushes.length;
            time.advance(1000);
            assert.equal(term.flushes.length, n);
            //  navigation still draws the static format at once
            view.onKeyPress(null, key('down arrow'));
            assert.equal(time.live(), 0);
        }

        it('menus.animations.enabled false: frame 0, or focusItemFormat if set', function () {
            configModule._pushTestConfig(
                Object.assign({}, BASE_CONFIG, {
                    menus: { cls: false, animations: { enabled: false } },
                })
            );
            assertStatic(track(loadView('VM', vmConf())), vmFocused(5, 0, 'one'));
            assertStatic(
                track(loadView('VM', vmConf({ focusItemFormat: '|14[{text}]' }))),
                `${goto(5, 10)}${N}${pipeToAnsi('|14')}[one]${N}     `
            );
        });

        it("the menu's config.animations false", function () {
            assertStatic(
                track(
                    loadView('VM', vmConf(), {
                        extraMenu: { config: { animations: false } },
                    })
                ),
                vmFocused(5, 0, 'one')
            );
        });

        it('PETSCII, ATASCII and RIP sessions', function () {
            [
                { name: 'petscii', hasLayer: () => false },
                { name: 'atascii', hasLayer: () => false },
                { name: 'ansi', hasLayer: name => 'rip' === name },
            ].forEach(emulation => {
                assertStatic(
                    track(loadView('VM', vmConf(), { clientOptions: { emulation } })),
                    vmFocused(5, 0, 'one')
                );
            });
        });
    });

    describe('FullMenuView', function () {
        //  8 items, 2 rows a column, 10 wide: columns of 5 chars + spacing,
        //  so a page holds 2 columns (4 items)
        const fmConf = (conf = {}) =>
            Object.assign(
                {
                    items: ['aa', 'bb', 'cc', 'dd', 'ee', 'ff', 'gg', 'hh'],
                    focus: true,
                    submit: true,
                    width: 10,
                    height: 2,
                    itemHorizSpacing: 2,
                    focusItemFrames: ['|15{text}', '|11{text}'],
                    focusItemFrameInterval: 100,
                },
                conf
            );

        it('ticks the focused item; navigation draws frame 0 at once', function () {
            const { term, view } = track(loadView('FM', fmConf()));
            assert.ok(view.pages.length > 1, 'more than one page');
            let n = term.flushes.length;
            time.advance(100);
            assert.equal(term.flushes.length, n + 1);
            assert.ok(term.flushes[n].includes(`${pipeToAnsi('|11')}aa`));

            n = term.flushes.length;
            view.onKeyPress(null, key('down arrow'));
            assert.ok(
                term
                    .since(n)
                    .join('')
                    .includes(`${pipeToAnsi('|15')}bb`)
            );
            n = term.flushes.length;
            time.advance(100);
            assert.equal(term.flushes.length, n + 1);
            assert.ok(term.flushes[n].includes(`${pipeToAnsi('|11')}bb`));
        });

        it('the focused item on another page: the tick draws nothing', function () {
            const { term, view } = track(loadView('FM', fmConf()));
            const last = view.pages[view.pages.length - 1];
            view.focusedItemIndex = last.end; //  not drawn: page 0 is on screen
            const n = term.flushes.length;
            time.advance(500);
            assert.equal(term.flushes.length, n);

            view.onKeyPress(null, key('end')); //  to that page, drawn
            const m = term.flushes.length;
            time.advance(100);
            assert.equal(term.flushes.length, m + 1);
            assert.ok(term.flushes[m].includes(`${pipeToAnsi('|11')}hh`));
        });
    });

    describe('HorizontalMenuView', function () {
        it('ticks the focused item, padded to its widest frame; left/right draw frame 0 at once', function () {
            const { term, view } = track(
                loadView('HM', {
                    items: ['aa', 'bb', 'cc'],
                    focus: true,
                    submit: true,
                    focusItemFrames: ['|15<{text}>', '|11{text}'],
                    focusItemFrameInterval: 100,
                })
            );
            //  every slot as wide as the widest frame (4) plus the spacing,
            //  so no frame overlaps the next item
            assert.deepEqual(
                view.items.map(item => item.col),
                [10, 16, 22]
            );
            assert.ok(
                term
                    .all()
                    .includes(
                        `${goto(5, 10)}${N} ${pipeToAnsi('|15')}<aa> ` +
                            `${goto(5, 16)}${N}  bb  ${goto(5, 22)}${N}  cc  `
                    )
            );
            const n = term.flushes.length;
            time.advance(100);
            //  a narrow frame covers the wide one
            assert.deepEqual(term.since(n), [
                `${HIDE}${goto(5, 10)}${N}  ${pipeToAnsi('|11')}aa  ${HIDE}`,
            ]);

            const m = term.flushes.length;
            view.onKeyPress(null, key('right arrow'));
            assert.equal(
                term.since(m).join(''),
                `${goto(5, 10)}${goto(5, 10)}${N}  aa  ` +
                    `${goto(5, 16)}${N} ${pipeToAnsi('|15')}<bb> ` +
                    `${goto(5, 22)}${N}  cc  `
            );
            const k = term.flushes.length;
            time.advance(100);
            assert.deepEqual(term.since(k), [
                `${HIDE}${goto(5, 16)}${N}  ${pipeToAnsi('|11')}bb  ${HIDE}`,
            ]);
        });
    });

    describe('SpinnerMenuView', function () {
        it('ticks the shown item while focused; up/down draw frame 0 at once; blurred: the normal look', function () {
            const { term, view } = track(
                loadView('SM', {
                    items: ['aa', 'bb', 'cc'],
                    focus: true,
                    submit: true,
                    width: 6,
                    focusItemFrames: ['|15>{text}', '|11>>{text}'],
                    focusItemFrameInterval: 100,
                })
            );
            assert.ok(term.all().includes(`${pipeToAnsi('|15')}>aa`));
            let n = term.flushes.length;
            time.advance(100);
            assert.equal(term.flushes.length, n + 1);
            assert.ok(term.flushes[n].includes(`${pipeToAnsi('|11')}>>aa`));

            n = term.flushes.length;
            view.onKeyPress(null, key('down arrow')); //  nothing cached for "bb" yet
            assert.ok(
                term
                    .since(n)
                    .join('')
                    .includes(`${pipeToAnsi('|15')}>bb`)
            );

            n = term.flushes.length;
            view.setFocus(false);
            assert.ok(term.since(n).join('').includes(`${N}bb`));
            assert.equal(time.live(), 0);
        });
    });

    describe('frame widths: columns, the view edge, the terminal edge', function () {
        it('FM: a column is as wide as its widest frame, so no frame runs into the next', function () {
            const conf = {
                items: ['aaaa', 'bbbb', 'cccc', 'dddd', 'eeee', 'ffff'],
                focus: true,
                submit: true,
                width: 30,
                height: 3,
                itemHorizSpacing: 2,
                focusItemFrameInterval: 100,
            };
            //  without frames: columns from the item text, as before
            const plain = track(loadView('FM', conf));
            assert.deepEqual(
                plain.view.items.map(item => item.fixedLength),
                [4, 4, 4, 4, 4, 4]
            );
            assert.equal(plain.view.items[3].col, 16);
            plain.vc.destroy();

            const { term, view } = track(
                loadView(
                    'FM',
                    Object.assign({}, conf, {
                        focusItemFrames: ['|15>{text}', '|11>>{text}', '|03>>>>{text}'],
                    })
                )
            );
            assert.deepEqual(
                view.items.map(item => item.fixedLength),
                [8, 8, 8, 8, 8, 8]
            );
            assert.equal(view.items[3].col, 20);
            const rows = ['>aaaa', '>>aaaa', '>>>>aaaa', '>aaaa'];
            rows.forEach((focused, tick) => {
                if (tick > 0) {
                    time.advance(100);
                }
                assert.equal(
                    screen(term).row(5, 10, 29),
                    `${focused.padEnd(10)}dddd      `,
                    `tick ${tick}`
                );
            });
            assert.equal(screen(term).row(6, 10, 29), `${'bbbb'.padEnd(10)}eeee      `);
        });

        it('FM: changing the frames lays the columns out again', function () {
            const { view } = track(
                loadView('FM', {
                    items: ['aaaa', 'bbbb', 'cccc', 'dddd'],
                    focus: true,
                    width: 30,
                    height: 2,
                    itemHorizSpacing: 2,
                    focusItemFrames: ['{text}'],
                })
            );
            assert.equal(view.items[2].col, 16);
            view.setPropertyValue('focusItemFrames', ['>>>>{text}']);
            view.redraw();
            assert.equal(view.items[2].col, 20);
        });

        it('VM: a frame wider than the view is cut at its edge', function () {
            const { term } = track(
                loadView(
                    'VM',
                    vmConf({ focusItemFrames: ['>>>>>>>>>>{text}', '{text}'] })
                )
            );
            assert.equal(screen(term).row(5, 10, 19), '>>>>>>>>>>');
            assert.equal(screen(term).maxCol(5), 19);
            time.advance(100);
            assert.equal(screen(term).row(5, 10, 19), 'one       ');
            assert.equal(screen(term).maxCol(5), 19);
        });

        it('SM: a frame wider than the view is cut at its edge', function () {
            const { term } = track(
                loadView('SM', {
                    items: ['aa', 'bb'],
                    focus: true,
                    width: 6,
                    focusItemFrames: ['>>>>>>{text}', '{text}'],
                    focusItemFrameInterval: 100,
                })
            );
            assert.equal(screen(term).row(5, 10, 15), '>>>>>>');
            assert.equal(screen(term).maxCol(5), 15);
            time.advance(100);
            assert.equal(screen(term).row(5, 10, 15), 'aa    ');
        });

        it('FM: a column wider than the view (the first) is cut at its edge', function () {
            const { term } = track(
                loadView('FM', {
                    items: ['aa', 'bb'],
                    focus: true,
                    width: 12,
                    height: 2,
                    focusItemFrames: ['>>>>>>>>>>>>{text}', '{text}'],
                    focusItemFrameInterval: 100,
                })
            );
            assert.equal(screen(term).row(5, 10, 21), '>>>>>>>>>>>>');
            assert.equal(screen(term).maxCol(5), 21);
            time.advance(100);
            assert.equal(screen(term).row(5, 10, 21), 'aa          ');
        });

        it('HM: frames are cut at the terminal edge; an item past it neither draws nor ticks', function () {
            const { term, view } = track(
                loadView(
                    'HM',
                    {
                        items: ['aa', 'bb', 'cc'],
                        focus: true,
                        focusItemFrames: ['|15<{text}>', '|11{text}'],
                        focusItemFrameInterval: 100,
                    },
                    { col: 70 }
                )
            );
            assert.deepEqual(
                view.items.map(item => item.col),
                [70, 76, 82]
            );
            //  (an unfocused item is drawn whole wherever it is, as before)
            let n = term.flushes.length;
            view.onKeyPress(null, key('right arrow')); //  "bb": 76-81, cut at 80
            assert.ok(
                term
                    .since(n)
                    .join('')
                    .includes(`${goto(5, 76)}${N} ${pipeToAnsi('|15')}<bb>${N}`)
            );
            n = term.flushes.length;
            time.advance(100);
            assert.equal(term.flushes.length, n + 1);
            assert.equal(screen(term, n).row(5, 76, 80), '  bb ');
            assert.equal(screen(term, n).maxCol(5), 80);

            n = term.flushes.length;
            view.onKeyPress(null, key('right arrow')); //  "cc": off the terminal
            assert.ok(!term.since(n).join('').includes(pipeToAnsi('|15')));
            n = term.flushes.length;
            time.advance(500);
            assert.equal(term.flushes.length, n, 'no ticks for it');
        });
    });

    describe('the items change', function () {
        it('removeItem(): no cached frame or row of another item is drawn again', function () {
            const { term, view } = track(loadView('VM', vmConf()));
            view.onKeyPress(null, key('down arrow')); //  "two"
            time.advance(300); //  every frame of "two" cached
            view.onKeyPress(null, key('down arrow')); //  "three"
            time.advance(150);
            view.removeItem(0); //  "three" is index 1 now, where "two" was
            view.redraw();
            const n = term.flushes.length;
            time.advance(300);
            const ticks = term.since(n).join('');
            assert.ok(ticks.includes('>>three'));
            assert.ok(!ticks.includes('two'), 'the removed neighbour never ticks');

            //  rows after the removed one: drawn from their own item
            const r = track(
                loadView('VM', vmConf({ items: ['a', 'b', 'c', 'd', 'e'], height: 4 }))
            );
            r.view.removeItem(1);
            r.view.redraw();
            assert.deepEqual(
                [5, 6, 7, 8].map(row => screen(r.term).row(row, 10, 13)),
                ['>a  ', 'c   ', 'd   ', 'e   ']
            );
        });

        it('the same index after setItems() starts again at frame 0', function () {
            const { term, view } = track(loadView('VM', vmConf()));
            time.advance(150); //  frame 1 of "one"
            view.setItems(['uno', 'dos']);
            view.redraw();
            assert.equal(screen(term).row(5, 10, 19), '>uno      ');
            const n = term.flushes.length;
            time.advance(99);
            assert.equal(term.flushes.length, n, 'a full frame 0');
            time.advance(1);
            assert.deepEqual(term.since(n), [`${HIDE}${vmFocused(5, 1, 'uno')}${HIDE}`]);
        });

        it('back at the same index after a move with no draw (a hot key): frame 0', function () {
            const { term, view } = track(
                loadView('HM', {
                    items: ['aa', 'bb', 'cc'],
                    focus: true,
                    hotKeys: { b: 1 },
                    focusItemFrames: ['|15<{text}>', '|11{text}', '|03-{text}-'],
                    focusItemFrameInterval: 100,
                })
            );
            time.advance(100); //  frame 1 of "aa"
            view.onKeyPress('b', key('b')); //  index 1, nothing drawn
            const n = term.flushes.length;
            view.onKeyPress(null, key('left arrow')); //  back to "aa", drawn
            assert.ok(
                term
                    .since(n)
                    .join('')
                    .includes(`${pipeToAnsi('|15')}<aa>`)
            );
        });

        it('an emptied list stops ticking; items back and drawn, it ticks again', function () {
            const { term, view } = track(loadView('VM', vmConf()));
            time.advance(120);
            view.setItems([]);
            view.redraw();
            assert.equal(FrameClock.isRegistered(view), false);
            assert.equal(time.live(), 0);

            view.setItems(['uno', 'dos']);
            view.redraw();
            assert.ok(FrameClock.isRegistered(view));
            const n = term.flushes.length;
            time.advance(100);
            assert.deepEqual(term.since(n), [`${HIDE}${vmFocused(5, 1, 'uno')}${HIDE}`]);

            view.removeItem(1);
            view.removeItem(0);
            view.redraw();
            assert.equal(FrameClock.isRegistered(view), false);
            assert.equal(time.live(), 0);
        });

        it('SM: after setItems() or removeItem(), nothing ticks until it is drawn again', function () {
            const { term, view } = track(
                loadView('SM', {
                    items: ['aa', 'bb', 'cc'],
                    focus: true,
                    width: 6,
                    focusItemFrames: ['|15>{text}', '|11>>{text}'],
                    focusItemFrameInterval: 100,
                })
            );
            time.advance(50);
            view.setItems(['xx', 'yy']);
            let n = term.flushes.length;
            time.advance(300);
            assert.equal(term.flushes.length, n, 'the new item waits for the redraw');
            view.redraw();
            assert.ok(
                term
                    .since(n)
                    .join('')
                    .includes(`${pipeToAnsi('|15')}>xx`)
            );
            n = term.flushes.length;
            time.advance(100);
            assert.ok(
                term
                    .since(n)
                    .join('')
                    .includes(`${pipeToAnsi('|11')}>>xx`)
            );

            view.removeItem(0);
            n = term.flushes.length;
            time.advance(300);
            assert.equal(term.flushes.length, n);
            view.redraw();
            assert.ok(
                term
                    .since(n)
                    .join('')
                    .includes(`${pipeToAnsi('|15')}>yy`)
            );
        });
    });

    describe('switched off while animating', function () {
        it('menus.animations.enabled set false: the next tick draws the static format and stops', function () {
            const { term, view } = track(
                loadView('VM', vmConf({ focusItemFormat: '|14[{text}]' }))
            );
            time.advance(100); //  frame 1
            configModule._pushTestConfig(
                Object.assign({}, BASE_CONFIG, {
                    menus: { cls: false, animations: { enabled: false } },
                })
            );
            const n = term.flushes.length;
            time.advance(100);
            assert.equal(term.flushes.length, n + 1);
            assert.ok(
                term.flushes[n].includes(
                    `${goto(5, 10)}${N}${pipeToAnsi('|14')}[one]${N}`
                )
            );
            assert.equal(FrameClock.isRegistered(view), false);
            assert.equal(time.live(), 0);
            time.advance(1000);
            assert.equal(term.flushes.length, n + 1);

            //  navigation draws the static format
            view.onKeyPress(null, key('down arrow'));
            assert.ok(screen(term).row(6, 10, 19).startsWith('[two]'));
            assert.equal(time.live(), 0);
        });

        it("the menu's config.animations set false: stops at the next tick", function () {
            const { client, term, view } = track(loadView('VM', vmConf()));
            time.advance(100);
            client.currentMenuModule.menuConfig.config = { animations: false };
            const n = term.flushes.length;
            time.advance(100);
            assert.deepEqual(term.since(n), [`${HIDE}${vmFocused(5, 0, 'one')}${HIDE}`]);
            assert.equal(FrameClock.isRegistered(view), false);
            assert.equal(time.live(), 0);
        });
    });

    describe('two animated lists on one screen', function () {
        it('only the focused one ticks; moving focus moves the cycle', function () {
            const client = makeClient({
                form: {
                    0: {
                        mci: {
                            VM1: vmConf(),
                            VM2: vmConf({ focus: false }),
                        },
                    },
                },
            });
            const vc = load(client, {
                VM1: mci('VM', 1, 5, 10),
                VM2: mci('VM', 2, 5, 30),
            });
            vcs.push(vc);
            const [one, two] = [vc.getView(1), vc.getView(2)];
            assert.ok(FrameClock.isRegistered(one));
            assert.equal(FrameClock.isRegistered(two), false);
            const term = client.term;
            let n = term.flushes.length;
            time.advance(300);
            assert.equal(term.flushes.length, n + 3);
            assert.ok(term.since(n).every(s => !s.includes(goto(5, 30))));

            vc.switchFocus(2);
            assert.equal(FrameClock.isRegistered(one), false);
            assert.ok(FrameClock.isRegistered(two));
            n = term.flushes.length;
            time.advance(100);
            assert.deepEqual(term.since(n), [
                `${HIDE}${vmFocused(5, 1, 'one', 30)}${HIDE}`,
            ]);
        });
    });

    describe('not supported (out of v1)', function () {
        it('ToggleMenuView: warned, ignored, nothing ticks', function () {
            const { client, view } = track(
                loadView('TM', {
                    items: ['yes', 'no'],
                    focus: true,
                    submit: true,
                    focusItemFrames: FRAMES,
                })
            );
            assert.equal(view.hasFocusItemFrames(), false);
            assert.equal(time.live(), 0);
            assert.ok(client.log.warns.some(w => /not supported/.test(w.msg)));
        });
    });
});
