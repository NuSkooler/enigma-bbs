'use strict';

const { strict: assert } = require('assert');

const { TickerView } = require('../core/ticker_view.js');
const { StatusBarView } = require('../core/status_bar_view.js');
const { MaskEditTextView } = require('../core/mask_edit_text_view.js');
const { EditTextView } = require('../core/edit_text_view.js');
const strUtil = require('../core/string_util.js');

// ─── Test helpers ────────────────────────────────────────────────────────────

//  Minimal client stub — satisfies View base requirements without a real terminal.
function makeClient() {
    return {
        term: {
            termWidth: 80,
            termHeight: 25,
            write: () => {},
            rawWrite: () => {},
        },
    };
}

//  Replaces the real global setInterval / clearInterval with synchronous stubs
//  that allow tests to fire callbacks on demand.  Call restore() when done.
function makeFakeTimers() {
    const timers = new Map();
    let nextId = 1;

    const saved = {
        setInterval: global.setInterval,
        clearInterval: global.clearInterval,
    };

    global.setInterval = (fn, _ms) => {
        const id = nextId++;
        timers.set(id, fn);
        return id;
    };
    global.clearInterval = id => {
        timers.delete(id);
    };

    return {
        /** Synchronously invoke the callback for the given timer id. */
        fire(id) {
            const fn = timers.get(id);
            if (fn) fn();
        },
        /** True if the timer is still registered (not yet cleared). */
        has(id) {
            return timers.has(id);
        },
        /** Number of currently-registered timers. */
        count() {
            return timers.size;
        },
        /** Restore the original global timer functions. */
        restore() {
            global.setInterval = saved.setInterval;
            global.clearInterval = saved.clearInterval;
        },
    };
}

// ─── TickerView ───────────────────────────────────────────────────────────────

describe('TickerView', () => {
    let ft;
    before(() => {
        ft = makeFakeTimers();
    });
    after(() => {
        ft.restore();
    });

    function makeTicker(opts = {}) {
        return new TickerView(
            Object.assign(
                {
                    client: makeClient(),
                    id: 1,
                    position: { row: 1, col: 1 },
                    dimens: { width: 10, height: 1 },
                    text: 'hello',
                    effect: 'normal',
                    motion: 'left',
                },
                opts
            )
        );
    }

    // ── Timer lifecycle ──────────────────────────────────────────────────────

    describe('timer lifecycle', () => {
        it('_timer is set after construction', () => {
            const view = makeTicker();
            assert.ok(view._timer != null, '_timer should be set');
            view.destroy();
        });

        it('_timer is null after destroy()', () => {
            const view = makeTicker();
            view.destroy();
            assert.equal(view._timer, null);
        });

        it('timer is removed from fake registry after destroy()', () => {
            const view = makeTicker();
            const id = view._timer;
            view.destroy();
            assert.ok(!ft.has(id), 'fake timer entry should be gone');
        });

        it('destroy() is idempotent — second call does not throw', () => {
            const view = makeTicker();
            view.destroy();
            assert.doesNotThrow(() => view.destroy());
        });
    });

    // ── Text-style effects ───────────────────────────────────────────────────

    describe('text-style effects (baked at setText time)', () => {
        it('normal — preserves text as-is', () => {
            const view = makeTicker({ text: 'Hello World', effect: 'normal' });
            assert.equal(view._plainText, 'Hello World');
            view.destroy();
        });

        it('upper — converts to ALL CAPS', () => {
            const view = makeTicker({ text: 'hello', effect: 'upper' });
            assert.equal(view._plainText, 'HELLO');
            view.destroy();
        });

        it('lower — converts to all lowercase', () => {
            const view = makeTicker({ text: 'HELLO', effect: 'lower' });
            assert.equal(view._plainText, 'hello');
            view.destroy();
        });

        it('l33t — substitutes a/e/i/o/s/t with numeric equivalents', () => {
            //  SIMPLE_ELITE_MAP: a→4, e→3, i→1, o→0, s→5, t→7
            const view = makeTicker({ text: 'hello', effect: 'l33t' });
            assert.equal(view._plainText, 'h3ll0');
            view.destroy();
        });

        it('setPropertyValue(text) re-bakes _plainText with current effect', () => {
            const view = makeTicker({ text: 'hello', effect: 'upper' });
            view.setPropertyValue('text', 'world');
            assert.equal(view._plainText, 'WORLD');
            view.destroy();
        });
    });

    // ── _getVisiblePlain() ───────────────────────────────────────────────────

    describe('_getVisiblePlain()', () => {
        it('left: at offset 0, text appears at the start of the window', () => {
            const view = makeTicker({
                text: 'abc',
                motion: 'left',
                dimens: { width: 10, height: 1 },
            });
            view._scrollOffset = 0;
            const { plain } = view._getVisiblePlain();
            assert.equal(plain.length, 10);
            assert.ok(plain.startsWith('abc'), `expected "abc..." got "${plain}"`);
            view.destroy();
        });

        it('left: output is always exactly dimens.width characters', () => {
            const view = makeTicker({
                text: 'abcdefgh',
                motion: 'left',
                dimens: { width: 20, height: 1 },
            });
            view._scrollOffset = 5;
            assert.equal(view._getVisiblePlain().plain.length, 20);
            view.destroy();
        });

        it('typewriter: reveals exactly _scrollOffset characters then pads', () => {
            const view = makeTicker({
                text: 'hello',
                motion: 'typewriter',
                dimens: { width: 10, height: 1 },
            });
            view._scrollOffset = 3;
            assert.equal(view._getVisiblePlain().plain, 'hel       ');
            view.destroy();
        });

        it('typewriter: _scrollOffset=0 returns full fill', () => {
            const view = makeTicker({
                text: 'hello',
                motion: 'typewriter',
                dimens: { width: 10, height: 1 },
            });
            view._scrollOffset = 0;
            assert.equal(view._getVisiblePlain().plain, '          ');
            view.destroy();
        });

        it('bounce: text shorter than window — pads to full width', () => {
            const view = makeTicker({
                text: 'hi',
                motion: 'bounce',
                dimens: { width: 10, height: 1 },
            });
            view._scrollOffset = 0;
            assert.equal(view._getVisiblePlain().plain, 'hi        ');
            view.destroy();
        });

        it('reveal: lead fill chars match _scrollOffset, then text follows', () => {
            //  scrollOffset=3 → 3 fill chars, then text 'hello', then remaining fill
            const view = makeTicker({
                text: 'hello',
                motion: 'reveal',
                dimens: { width: 10, height: 1 },
            });
            view._scrollOffset = 3;
            const { plain } = view._getVisiblePlain();
            assert.equal(plain.length, 10);
            assert.equal(plain.slice(0, 3), '   ');
            assert.equal(plain.slice(3, 8), 'hello');
            view.destroy();
        });
    });

    // ── setPropertyValue() ───────────────────────────────────────────────────

    describe('setPropertyValue()', () => {
        it('setting motion updates motion and resets _scrollOffset', () => {
            const view = makeTicker({ motion: 'left' });
            view._scrollOffset = 42;
            view.setPropertyValue('motion', 'bounce');
            assert.equal(view.motion, 'bounce');
            assert.equal(view._scrollOffset, 0);
            view.destroy();
        });

        it('fillChar is stored as a single character', () => {
            const view = makeTicker();
            view.setPropertyValue('fillChar', '*');
            assert.equal(view.fillChar, '*');
            view.destroy();
        });

        it('holdTicks is updated', () => {
            const view = makeTicker({ holdTicks: 20 });
            view.setPropertyValue('holdTicks', '50');
            assert.equal(view.holdTicks, 50);
            view.destroy();
        });
    });
});

// ─── StatusBarView ────────────────────────────────────────────────────────────

describe('StatusBarView', () => {
    let ft;
    before(() => {
        ft = makeFakeTimers();
    });
    after(() => {
        ft.restore();
    });

    function makeSBView(opts = {}) {
        return new StatusBarView(
            Object.assign(
                {
                    client: makeClient(),
                    id: 1,
                    position: { row: 1, col: 1 },
                    dimens: { width: 40, height: 1 },
                    text: 'hello',
                    refreshInterval: 0,
                },
                opts
            )
        );
    }

    // ── Timer lifecycle ──────────────────────────────────────────────────────

    describe('timer lifecycle', () => {
        it('no timer is created when refreshInterval is 0', () => {
            const view = makeSBView({ refreshInterval: 0 });
            assert.equal(view._timer, null);
        });

        it('timer is created when refreshInterval > 0', () => {
            const view = makeSBView({ refreshInterval: 500 });
            assert.ok(view._timer != null, '_timer should be set');
            view.destroy();
        });

        it('destroy() clears the timer', () => {
            const view = makeSBView({ refreshInterval: 500 });
            const id = view._timer;
            view.destroy();
            assert.equal(view._timer, null);
            assert.ok(!ft.has(id), 'fake timer entry should be removed');
        });

        it('destroy() is idempotent — second call does not throw', () => {
            const view = makeSBView({ refreshInterval: 500 });
            view.destroy();
            assert.doesNotThrow(() => view.destroy());
        });
    });

    // ── Format template isolation ────────────────────────────────────────────

    describe('format template isolation', () => {
        it('_format is stored separately from rendered text', () => {
            const view = makeSBView({ text: 'hello' });
            assert.equal(view._format, 'hello');
        });

        it('setPropertyValue(text) updates _format', () => {
            const view = makeSBView({ text: 'old' });
            view.setPropertyValue('text', 'new value');
            assert.equal(view._format, 'new value');
        });
    });

    // ── Skip-redraw on unchanged text ────────────────────────────────────────

    describe('skip-redraw optimisation', () => {
        it('redraws on first tick, skips redraw on second tick when text is unchanged', () => {
            const view = makeSBView({ refreshInterval: 500, text: 'static text' });
            const id = view._timer;

            let redrawCount = 0;
            view.redraw = () => {
                redrawCount++;
            };

            //  First tick: _lastRendered is undefined, text is 'static text' → redraw
            ft.fire(id);
            assert.equal(redrawCount, 1);
            assert.equal(view._lastRendered, 'static text');

            //  Second tick: same text → no redraw
            ft.fire(id);
            assert.equal(redrawCount, 1, 'should not redraw when text has not changed');

            view.destroy();
        });

        it('redraws again when text changes between ticks', () => {
            const view = makeSBView({ refreshInterval: 500, text: 'first' });
            const id = view._timer;

            let redrawCount = 0;
            view.redraw = () => {
                redrawCount++;
            };

            ft.fire(id);
            assert.equal(redrawCount, 1);

            //  Change the format so the next tick produces different text
            view._format = 'second';
            ft.fire(id);
            assert.equal(redrawCount, 2, 'should redraw when text has changed');
            assert.equal(view._lastRendered, 'second');

            view.destroy();
        });
    });

    // ── refreshInterval property update ─────────────────────────────────────

    describe('setPropertyValue(refreshInterval)', () => {
        it('replaces the existing timer when interval changes', () => {
            const view = makeSBView({ refreshInterval: 500 });
            const oldId = view._timer;

            view.setPropertyValue('refreshInterval', '200');

            assert.ok(!ft.has(oldId), 'old timer should be cleared');
            assert.ok(view._timer != null, 'new timer should be registered');
            assert.equal(view.refreshInterval, 200);

            view.destroy();
        });

        it('clears the timer when interval set to 0', () => {
            const view = makeSBView({ refreshInterval: 500 });
            view.setPropertyValue('refreshInterval', '0');
            assert.equal(view._timer, null);
        });
    });
});

// ─── MaskEditTextView ─────────────────────────────────────────────────────────

describe('MaskEditTextView', () => {
    //  MaskEditTextView uses no timers and does not call term.write() in the
    //  paths under test (buildPattern, getData), so no fake timers needed here.

    function makeMaskView(opts = {}) {
        return new MaskEditTextView(
            Object.assign(
                {
                    client: makeClient(),
                    id: 1,
                    position: { row: 1, col: 1 },
                    dimens: { width: 10, height: 1 },
                    maskPattern: '',
                },
                opts
            )
        );
    }

    // ── buildPattern / maxLength ─────────────────────────────────────────────

    describe('buildPattern()', () => {
        it('empty pattern produces empty patternArray and zero maxLength', () => {
            const view = makeMaskView({ maskPattern: '' });
            assert.equal(view.patternArray.length, 0);
            assert.equal(view.maxLength, 0);
        });

        it('date pattern ##/##/#### yields 10 elements', () => {
            const view = makeMaskView({ maskPattern: '##/##/####' });
            assert.equal(view.patternArray.length, 10);
        });

        it('date pattern: positions 0,1,3,4,6,7,8,9 are RegExps', () => {
            const view = makeMaskView({ maskPattern: '##/##/####' });
            const pa = view.patternArray;
            [0, 1, 3, 4, 6, 7, 8, 9].forEach(i =>
                assert.ok(pa[i] instanceof RegExp, `position ${i} should be RegExp`)
            );
        });

        it('date pattern: positions 2 and 5 are literal "/"', () => {
            const view = makeMaskView({ maskPattern: '##/##/####' });
            assert.equal(view.patternArray[2], '/');
            assert.equal(view.patternArray[5], '/');
        });

        it('date pattern: maxLength is 8 (input slots only)', () => {
            const view = makeMaskView({ maskPattern: '##/##/####' });
            assert.equal(view.maxLength, 8);
        });

        it('all-alpha pattern AAAA: maxLength is 4', () => {
            const view = makeMaskView({ maskPattern: 'AAAA' });
            assert.equal(view.maxLength, 4);
            view.patternArray.forEach((el, i) =>
                assert.ok(el instanceof RegExp, `position ${i} should be RegExp`)
            );
        });

        it('alphanumeric @: accepts digit and alpha', () => {
            const view = makeMaskView({ maskPattern: '@' });
            const re = view.patternArray[0];
            assert.ok(re instanceof RegExp);
            assert.ok('5'.match(re), 'digit should match @');
            assert.ok('A'.match(re), 'letter should match @');
        });

        it('digit # does not accept letters', () => {
            const view = makeMaskView({ maskPattern: '#' });
            const re = view.patternArray[0];
            assert.ok(!'a'.match(re), 'letter should not match #');
        });

        it('setMaskPattern() updates pattern and resets lineBuffer', () => {
            const view = makeMaskView({ maskPattern: '##' });
            assert.equal(view.maxLength, 2);

            view.setMaskPattern('###');
            assert.equal(view.maxLength, 3);
            assert.equal(view.patternArray.length, 3);
        });
    });

    // ── getData() ────────────────────────────────────────────────────────────

    describe('getData()', () => {
        it('empty input returns empty string', () => {
            const view = makeMaskView({ maskPattern: '##/##/####' });
            assert.equal(view.getData(), '');
        });

        it('full input interpolates literals into the result', () => {
            const view = makeMaskView({ maskPattern: '##/##/####' });
            //  Simulate input: insert 8 digit characters directly into lineBuffer
            const lb = view.lineBuffer;
            '12032025'.split('').forEach((ch, i) => lb.insertChar(0, i, ch, 0));

            assert.equal(view.getData(), '12/03/2025');
        });

        it('partial input: only filled slots plus interleaved literals', () => {
            const view = makeMaskView({ maskPattern: '##/##/####' });
            const lb = view.lineBuffer;
            //  Only first 4 input slots filled: '1203'
            '1203'.split('').forEach((ch, i) => lb.insertChar(0, i, ch, 0));

            //  Pattern walk stops including slots once rawData is exhausted;
            //  literals before the gap are still included.
            const result = view.getData();
            assert.ok(result.startsWith('12/03'), `expected "12/03..." got "${result}"`);
            assert.ok(!result.includes('2025'), 'unfilled year slots should not appear');
        });

        it('all-digit pattern returns digits only (no literals)', () => {
            const view = makeMaskView({ maskPattern: '####' });
            const lb = view.lineBuffer;
            '1234'.split('').forEach((ch, i) => lb.insertChar(0, i, ch, 0));

            assert.equal(view.getData(), '1234');
        });
    });
});

// ─── VerticalMenuView ─────────────────────────────────────────────────────────

describe('VerticalMenuView', () => {
    const { VerticalMenuView } = require('../core/vertical_menu_view.js');

    //  Client stub that records every write/rawWrite call so tests can inspect
    //  exactly which terminal rows were touched.
    function makeCapturingClient() {
        const writes = [];
        return {
            term: {
                termWidth: 80,
                termHeight: 25,
                write: str => writes.push(str),
                rawWrite: str => writes.push(str),
            },
            _writes: writes,
            clearWrites() {
                writes.length = 0;
            },
        };
    }

    //  Parse all ANSI goto row numbers from the captured write buffer.
    //  ansi.goto(row, col) emits ESC [ row ; col H.
    function rowsWritten(client) {
        const rows = new Set();
        const re = /\x1b\[(\d+);\d+H/g;
        for (const w of client._writes) {
            let m;
            while ((m = re.exec(w)) !== null) {
                rows.add(parseInt(m[1], 10));
            }
        }
        return rows;
    }

    //  Build a VerticalMenuView with `count` simple string items.
    //  opts may override any constructor field; client is always capturing.
    function makeView(count, opts = {}) {
        const items = Array.from({ length: count }, (_, i) => `Item ${i}`);
        const client = makeCapturingClient();
        const view = new VerticalMenuView(
            Object.assign(
                {
                    client,
                    id: 1,
                    position: { row: 1, col: 1 },
                    dimens: { width: 20, height: 5 },
                    items,
                },
                opts
            )
        );
        return { view, client };
    }

    // ── _windowFromTop / _windowToBottom ─────────────────────────────────────

    describe('window helpers', () => {
        it('_windowFromTop: bottom clamped to items.length when list is short', () => {
            const { view } = makeView(3, { dimens: { width: 20, height: 5 } });
            view.redraw();
            // maxVisibleItems = 5; items.length = 3
            const w = view._windowFromTop(0);
            assert.equal(w.top, 0);
            assert.equal(w.bottom, 2); // min(0+5, 3)-1 = 2
        });

        it('_windowFromTop: full page when list is long enough', () => {
            const { view } = makeView(10, { dimens: { width: 20, height: 5 } });
            view.redraw();
            const w = view._windowFromTop(2);
            assert.equal(w.top, 2);
            assert.equal(w.bottom, 6); // min(2+5, 10)-1 = 6
        });

        it('_windowToBottom: anchors bottom to last item', () => {
            const { view } = makeView(8, { dimens: { width: 20, height: 5 } });
            view.redraw();
            const w = view._windowToBottom();
            assert.equal(w.bottom, 7); // items.length - 1
            assert.equal(w.top, 3); // max(0, 7-5+1) = 3
        });

        it('_windowToBottom: top is 0 when fewer items than maxVisibleItems', () => {
            const { view } = makeView(3, { dimens: { width: 20, height: 5 } });
            view.redraw();
            const w = view._windowToBottom();
            assert.equal(w.top, 0);
            assert.equal(w.bottom, 2);
        });
    });

    // ── Initial state ─────────────────────────────────────────────────────────

    describe('initial state', () => {
        it('maxVisibleItems = ceil(height / (itemSpacing + 1))', () => {
            const { view } = makeView(10, { dimens: { width: 20, height: 5 } });
            view.redraw();
            assert.equal(view.maxVisibleItems, 5);
        });

        it('maxVisibleItems accounts for itemSpacing', () => {
            const { view } = makeView(10, {
                dimens: { width: 20, height: 6 },
                itemSpacing: 1,
            });
            view.redraw();
            assert.equal(view.maxVisibleItems, 3); // ceil(6 / 2) = 3
        });

        it('viewWindow starts at {top:0, bottom:min(maxVisible,len)-1}', () => {
            const { view } = makeView(10, { dimens: { width: 20, height: 5 } });
            view.redraw();
            assert.equal(view.viewWindow.top, 0);
            assert.equal(view.viewWindow.bottom, 4);
        });

        it('viewWindow.bottom clamped to items.length-1 when fewer items than height', () => {
            const { view } = makeView(3, { dimens: { width: 20, height: 5 } });
            view.redraw();
            assert.equal(view.viewWindow.bottom, 2);
        });

        it('focusedItemIndex starts at 0', () => {
            const { view } = makeView(5);
            assert.equal(view.focusedItemIndex, 0);
        });
    });

    // ── focusNext viewWindow management ──────────────────────────────────────

    describe('focusNext', () => {
        it('within window: increments focusedItemIndex, viewWindow unchanged', () => {
            const { view } = makeView(10);
            view.redraw();
            view.focusNext();
            assert.equal(view.focusedItemIndex, 1);
            assert.equal(view.viewWindow.top, 0);
            assert.equal(view.viewWindow.bottom, 4);
        });

        it('at window bottom: slides viewWindow down by one', () => {
            const { view } = makeView(10);
            view.redraw();
            for (let i = 0; i < 4; i++) view.focusNext();
            assert.equal(view.focusedItemIndex, 4);
            assert.equal(view.viewWindow.bottom, 4);

            view.focusNext();
            assert.equal(view.focusedItemIndex, 5);
            assert.equal(view.viewWindow.top, 1);
            assert.equal(view.viewWindow.bottom, 5);
        });

        it('wrap-around from last item resets to {top:0, bottom:maxVisible-1}', () => {
            const { view } = makeView(5);
            view.redraw();
            for (let i = 0; i < 4; i++) view.focusNext();
            assert.equal(view.focusedItemIndex, 4);

            view.focusNext();
            assert.equal(view.focusedItemIndex, 0);
            assert.equal(view.viewWindow.top, 0);
            assert.equal(view.viewWindow.bottom, 4);
        });
    });

    // ── focusPrevious viewWindow management ──────────────────────────────────

    describe('focusPrevious', () => {
        it('within window: decrements focusedItemIndex, viewWindow unchanged', () => {
            const { view } = makeView(10);
            view.redraw();
            view.focusNext();
            view.focusNext();
            assert.equal(view.focusedItemIndex, 2);
            const { top, bottom } = view.viewWindow;

            view.focusPrevious();
            assert.equal(view.focusedItemIndex, 1);
            assert.equal(view.viewWindow.top, top);
            assert.equal(view.viewWindow.bottom, bottom);
        });

        it('at window top while scrolled: slides viewWindow up by one', () => {
            const { view } = makeView(10);
            view.redraw();
            //  scroll down: focusedItemIndex=5, viewWindow={1,5}
            for (let i = 0; i < 5; i++) view.focusNext();
            assert.equal(view.viewWindow.top, 1);

            //  move within window back to the top item (item 1) — no scroll yet
            for (let i = 0; i < 4; i++) view.focusPrevious();
            assert.equal(view.focusedItemIndex, 1);
            assert.equal(view.viewWindow.top, 1);

            //  now cross the top boundary → window slides up
            view.focusPrevious();
            assert.equal(view.focusedItemIndex, 0);
            assert.equal(view.viewWindow.top, 0);
        });

        it('wrap-around from item 0 uses _windowToBottom', () => {
            const { view } = makeView(8, { dimens: { width: 20, height: 5 } });
            view.redraw();
            assert.equal(view.focusedItemIndex, 0);

            view.focusPrevious();
            assert.equal(view.focusedItemIndex, 7);
            assert.equal(view.viewWindow.bottom, 7);
            assert.equal(view.viewWindow.top, 3); // max(0, 7-5+1) = 3
        });
    });

    // ── Page / first / last navigation ───────────────────────────────────────

    describe('page and edge navigation', () => {
        it('focusNextPageItem jumps by maxVisibleItems', () => {
            const { view } = makeView(15);
            view.redraw();
            assert.equal(view.maxVisibleItems, 5);

            view.focusNextPageItem();
            assert.equal(view.focusedItemIndex, 5);
        });

        it('focusPreviousPageItem jumps by maxVisibleItems — not dimens.height (Bug 4)', () => {
            //  itemSpacing=1 → maxVisibleItems=3, dimens.height=6
            //  The old code used dimens.height (6) not maxVisibleItems (3)
            const { view } = makeView(15, {
                dimens: { width: 20, height: 6 },
                itemSpacing: 1,
            });
            view.redraw();
            assert.equal(view.maxVisibleItems, 3);

            view.focusNextPageItem(); // 0 → 3
            view.focusNextPageItem(); // 3 → 6
            assert.equal(view.focusedItemIndex, 6);

            view.focusPreviousPageItem(); // 6 - 3 = 3
            assert.equal(view.focusedItemIndex, 3);
        });

        it('focusPreviousPageItem at 0 wraps to bottom', () => {
            const { view } = makeView(10);
            view.redraw();
            assert.equal(view.focusedItemIndex, 0);

            view.focusPreviousPageItem();
            assert.equal(view.focusedItemIndex, 9);
        });

        it('focusNextPageItem at last item wraps to top', () => {
            const { view } = makeView(5);
            view.redraw();
            view.focusLast();
            assert.equal(view.focusedItemIndex, 4);

            view.focusNextPageItem();
            assert.equal(view.focusedItemIndex, 0);
        });

        it('focusLast sets bottom-anchored window', () => {
            const { view } = makeView(8, { dimens: { width: 20, height: 5 } });
            view.redraw();

            view.focusLast();
            assert.equal(view.focusedItemIndex, 7);
            assert.equal(view.viewWindow.bottom, 7);
            assert.equal(view.viewWindow.top, 3); // max(0, 7-5+1) = 3
        });

        it('focusFirst resets to top-anchored window', () => {
            const { view } = makeView(10);
            view.redraw();

            view.focusLast();
            view.focusFirst();
            assert.equal(view.focusedItemIndex, 0);
            assert.equal(view.viewWindow.top, 0);
            assert.equal(view.viewWindow.bottom, 4);
        });

        it('setFocusItemIndex near end of list uses bottom-anchored window', () => {
            const { view } = makeView(8, { dimens: { width: 20, height: 5 } });
            view.redraw();

            view.setFocusItemIndex(7);
            assert.equal(view.focusedItemIndex, 7);
            assert.equal(view.viewWindow.bottom, 7);
            assert.equal(view.viewWindow.top, 3);
        });
    });

    // ── Trailing-row blank pass (Bug 2 fix) ───────────────────────────────────

    describe('trailing-row blank pass', () => {
        it('blanks rows below last item when items < maxVisibleItems', () => {
            //  3 items in a 5-row view (position.row=1): items at rows 1,2,3
            //  blank pass must write rows 4 and 5
            const { view, client } = makeView(3, {
                position: { row: 1, col: 1 },
                dimens: { width: 20, height: 5 },
            });
            view.redraw();
            const rows = rowsWritten(client);
            assert.ok(rows.has(4), 'row 4 should be blanked');
            assert.ok(rows.has(5), 'row 5 should be blanked');
        });

        it('does not write beyond the view footprint when items fill it exactly', () => {
            //  5 items in a 5-row view → no row 6
            const { view, client } = makeView(5, {
                position: { row: 1, col: 1 },
                dimens: { width: 20, height: 5 },
            });
            view.redraw();
            const rows = rowsWritten(client);
            assert.ok(!rows.has(6), 'row 6 must not be written');
        });

        it('blanks all rows when item list is empty', () => {
            const { view, client } = makeView(0, {
                position: { row: 1, col: 1 },
                dimens: { width: 20, height: 5 },
            });
            view.redraw();
            const rows = rowsWritten(client);
            for (let r = 1; r <= 5; r++) {
                assert.ok(rows.has(r), `row ${r} should be blanked for empty list`);
            }
        });

        it('blanks trailing rows correctly with itemSpacing > 0', () => {
            //  2 items, itemSpacing=1: item 0 at row 1, item 1 at row 3
            //  height=6 → view spans rows 1-6; blank pass hits rows 5 and 6
            const { view, client } = makeView(2, {
                position: { row: 1, col: 1 },
                dimens: { width: 20, height: 6 },
                itemSpacing: 1,
            });
            view.redraw();
            const rows = rowsWritten(client);
            assert.ok(rows.has(5), 'row 5 should be blanked');
            assert.ok(rows.has(6), 'row 6 should be blanked');
        });
    });

    // ── oldDimens erase covers full old footprint (Bug 1 fix) ─────────────────

    describe('oldDimens erase', () => {
        it('erases all rows of the previous footprint including the last row', () => {
            //  Start with 5 items (rows 1-5), replace with 2 — oldDimens.height=5.
            //  The erase pass must reach row 5 (was row 4 with the height-2 bug).
            const { view, client } = makeView(5, {
                position: { row: 1, col: 1 },
                dimens: { width: 20, height: 5 },
            });
            view.redraw();

            client.clearWrites();
            view.setItems(['A', 'B']);
            view.redraw();

            const rows = rowsWritten(client);
            assert.ok(rows.has(1), 'row 1 must be erased');
            assert.ok(rows.has(5), 'row 5 must be erased (was missed before fix)');
        });
    });

    // ── Focus-only redraw optimization ────────────────────────────────────────

    describe('focus-only redraw optimization (_focusRedraw)', () => {
        it('within-window focusNext writes exactly 2 rows', () => {
            //  5 items in 5-row view — all visible, focus moves within window
            const { view, client } = makeView(5, {
                position: { row: 1, col: 1 },
                dimens: { width: 20, height: 5 },
            });
            view.redraw();
            client.clearWrites();

            view.focusNext(); // item 0 → 1, within window
            const rows = rowsWritten(client);
            assert.equal(rows.size, 2, `expected 2 row writes, got ${rows.size}`);
            assert.ok(rows.has(1), 'row 1 (prev focused item 0) redrawn');
            assert.ok(rows.has(2), 'row 2 (new focused item 1) redrawn');
        });

        it('within-window focusPrevious writes exactly 2 rows', () => {
            const { view, client } = makeView(5, {
                position: { row: 1, col: 1 },
                dimens: { width: 20, height: 5 },
            });
            view.redraw();
            view.focusNext(); // advance to item 1 first

            client.clearWrites();
            view.focusPrevious(); // item 1 → 0, within window
            const rows = rowsWritten(client);
            assert.equal(rows.size, 2, `expected 2 row writes, got ${rows.size}`);
            assert.ok(rows.has(1), 'row 1 (new focused item 0) redrawn');
            assert.ok(rows.has(2), 'row 2 (prev focused item 1) redrawn');
        });

        it('consecutive within-window moves each write exactly 2 rows', () => {
            const { view, client } = makeView(5, {
                position: { row: 1, col: 1 },
                dimens: { width: 20, height: 5 },
            });
            view.redraw();

            for (let step = 0; step < 4; step++) {
                client.clearWrites();
                view.focusNext();
                const rows = rowsWritten(client);
                assert.equal(
                    rows.size,
                    2,
                    `step ${step + 1}: expected 2 rows, got ${rows.size}`
                );
            }
        });

        it('scroll-triggering focusNext performs a full redraw (> 2 rows)', () => {
            //  10 items, 5-row view — advance to window bottom then one more
            const { view, client } = makeView(10, {
                position: { row: 1, col: 1 },
                dimens: { width: 20, height: 5 },
            });
            view.redraw();
            for (let i = 0; i < 4; i++) view.focusNext(); // reach window bottom

            client.clearWrites();
            view.focusNext(); // triggers scroll → full redraw
            const rows = rowsWritten(client);
            assert.ok(
                rows.size > 2,
                `scroll should trigger full redraw; got ${rows.size} rows`
            );
        });

        it('scroll-triggering focusPrevious performs a full redraw (> 2 rows)', () => {
            const { view, client } = makeView(10, {
                position: { row: 1, col: 1 },
                dimens: { width: 20, height: 5 },
            });
            view.redraw();
            //  scroll down to window {1,5}, then move within window to the top item
            for (let i = 0; i < 5; i++) view.focusNext();
            for (let i = 0; i < 4; i++) view.focusPrevious();
            assert.equal(view.focusedItemIndex, 1); // at viewWindow.top

            client.clearWrites();
            view.focusPrevious(); // crosses top boundary → full redraw
            const rows = rowsWritten(client);
            assert.ok(
                rows.size > 2,
                `scroll should trigger full redraw; got ${rows.size} rows`
            );
        });

        it('wrap-around focusNext triggers full redraw', () => {
            const { view, client } = makeView(5, {
                position: { row: 1, col: 1 },
                dimens: { width: 20, height: 5 },
            });
            view.redraw();
            for (let i = 0; i < 4; i++) view.focusNext(); // reach last item

            client.clearWrites();
            view.focusNext(); // wrap-around → full redraw
            const rows = rowsWritten(client);
            assert.ok(
                rows.size > 2,
                `wrap-around should trigger full redraw; got ${rows.size} rows`
            );
        });

        it('wrap-around focusPrevious triggers full redraw', () => {
            const { view, client } = makeView(5, {
                position: { row: 1, col: 1 },
                dimens: { width: 20, height: 5 },
            });
            view.redraw();
            client.clearWrites();
            view.focusPrevious(); // wrap from 0 → full redraw
            const rows = rowsWritten(client);
            assert.ok(
                rows.size > 2,
                `wrap-around should trigger full redraw; got ${rows.size} rows`
            );
        });
    });
});

// ─── EditTextView — wide-character scroll and display fixes ───────────────────

describe('EditTextView — wide-character scroll and display', () => {
    function makeEtv({ width = 20 } = {}) {
        return new EditTextView({
            client: {
                term: {
                    termWidth: 80,
                    termHeight: 25,
                    write: () => {},
                    rawWrite: () => {},
                },
            },
            id: 1,
            position: { row: 1, col: 1 },
            dimens: { width, height: 1 },
        });
    }

    // ── Bug fix: drawText must use display width, not buffer length ───────────

    describe('drawText — wide-char overflow detection', () => {
        it('applies scroll when wide chars exceed display width even if buffer length does not', () => {
            //  dimens.width=4, text='日日日' (3 buffer chars, 6 display cols).
            //  Old condition:  s.length(3) > 4  → false → scroll not applied.
            //  Fixed condition: renderStringLength(6) > 4 → true → scroll applied.
            const v = makeEtv({ width: 4 });
            v.hasFocus = true;
            v.lineBuffer.lines[0].chars = '日日日';
            v.text = '日日日';
            v.cursorPos.col = 3;
            v._scrollOffset = 0;

            v.drawText('日日日');

            assert.ok(
                v._scrollOffset > 0,
                'scroll offset should be non-zero when wide chars overflow the display'
            );
        });

        it('does not apply scroll when wide chars fit exactly within display width', () => {
            //  dimens.width=4: '日日' = 4 display cols, exactly fits.
            const v = makeEtv({ width: 4 });
            v.hasFocus = true;
            v.lineBuffer.lines[0].chars = '日日';
            v.text = '日日';
            v.cursorPos.col = 0;
            v._scrollOffset = 0;

            v.drawText('日日');

            assert.strictEqual(
                v._scrollOffset,
                0,
                'no scroll needed when wide chars exactly fill display width'
            );
        });

        it('slices to display-column boundary, not buffer-char count', () => {
            //  Verify renderSplitPos correctly bounds the visible window.
            //  tail='日日' with width=4: both chars fit (4 display cols exactly).
            const tail = '日日';
            const splitPos = strUtil.renderSplitPos(tail, 4);
            assert.strictEqual(
                splitPos,
                2,
                'renderSplitPos should include both wide chars that exactly fill the window'
            );
            assert.strictEqual(tail.slice(0, splitPos), '日日');
        });
    });

    // ── Bug fix: fast-path notScrolled must use display width ─────────────────

    describe('onKeyPress fast path — notScrolled uses display width', () => {
        it('correctly detects overflow for wide chars: buffer length ≤ width but display > width', () => {
            //  The old fast-path guard was:  newLen <= dimens.width
            //  The fix uses:                 _bufferToDisplayCol(newLen) <= dimens.width
            const v = makeEtv({ width: 4 });
            //  3 CJK chars in buffer: buffer length 3 ≤ 4, but display width 6 > 4.
            v.lineBuffer.lines[0].chars = '日日日';

            const newLen = 3;
            const oldGuard = newLen <= v.dimens.width; //  3 <= 4 → true  (bug)
            const newGuard = v._bufferToDisplayCol(newLen) <= v.dimens.width; //  6 <= 4 → false (fix)

            assert.strictEqual(oldGuard, true, 'old guard incorrectly allowed fast path');
            assert.strictEqual(newGuard, false, 'new guard correctly blocks fast path');
        });

        it('pure ASCII: notScrolled remains true when buffer and display agree', () => {
            const v = makeEtv({ width: 10 });
            v.lineBuffer.lines[0].chars = 'ABCDE';

            const newLen = 5;
            const guard = v._bufferToDisplayCol(newLen) <= v.dimens.width; //  5 <= 10 → true

            assert.strictEqual(guard, true, 'ASCII fast path should not be blocked');
        });
    });
});
