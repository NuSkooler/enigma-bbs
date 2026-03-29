'use strict';

const { strict: assert } = require('assert');

const { TickerView }        = require('../core/ticker_view.js');
const { StatusBarView }     = require('../core/status_bar_view.js');
const { MaskEditTextView }  = require('../core/mask_edit_text_view.js');

// ─── Test helpers ────────────────────────────────────────────────────────────

//  Minimal client stub — satisfies View base requirements without a real terminal.
function makeClient() {
    return {
        term: {
            termWidth:  80,
            termHeight: 25,
            write:    () => {},
            rawWrite: () => {},
        },
    };
}

//  Replaces the real global setInterval / clearInterval with synchronous stubs
//  that allow tests to fire callbacks on demand.  Call restore() when done.
function makeFakeTimers() {
    const timers = new Map();
    let   nextId = 1;

    const saved = {
        setInterval:   global.setInterval,
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
        fire(id)   { const fn = timers.get(id); if (fn) fn(); },
        /** True if the timer is still registered (not yet cleared). */
        has(id)    { return timers.has(id); },
        /** Number of currently-registered timers. */
        count()    { return timers.size; },
        /** Restore the original global timer functions. */
        restore()  {
            global.setInterval   = saved.setInterval;
            global.clearInterval = saved.clearInterval;
        },
    };
}

// ─── TickerView ───────────────────────────────────────────────────────────────

describe('TickerView', () => {
    let ft;
    before(() => { ft = makeFakeTimers(); });
    after(() => { ft.restore(); });

    function makeTicker(opts = {}) {
        return new TickerView(Object.assign({
            client:   makeClient(),
            id:       1,
            position: { row: 1, col: 1 },
            dimens:   { width: 10, height: 1 },
            text:     'hello',
            effect:   'normal',
            motion:   'left',
        }, opts));
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
            const id   = view._timer;
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
            const view = makeTicker({ text: 'abc', motion: 'left', dimens: { width: 10, height: 1 } });
            view._scrollOffset = 0;
            const plain = view._getVisiblePlain();
            assert.equal(plain.length, 10);
            assert.ok(plain.startsWith('abc'), `expected "abc..." got "${plain}"`);
            view.destroy();
        });

        it('left: output is always exactly dimens.width characters', () => {
            const view = makeTicker({ text: 'abcdefgh', motion: 'left', dimens: { width: 20, height: 1 } });
            view._scrollOffset = 5;
            assert.equal(view._getVisiblePlain().length, 20);
            view.destroy();
        });

        it('typewriter: reveals exactly _scrollOffset characters then pads', () => {
            const view = makeTicker({ text: 'hello', motion: 'typewriter', dimens: { width: 10, height: 1 } });
            view._scrollOffset = 3;
            assert.equal(view._getVisiblePlain(), 'hel       ');
            view.destroy();
        });

        it('typewriter: _scrollOffset=0 returns full fill', () => {
            const view = makeTicker({ text: 'hello', motion: 'typewriter', dimens: { width: 10, height: 1 } });
            view._scrollOffset = 0;
            assert.equal(view._getVisiblePlain(), '          ');
            view.destroy();
        });

        it('bounce: text shorter than window — pads to full width', () => {
            const view = makeTicker({ text: 'hi', motion: 'bounce', dimens: { width: 10, height: 1 } });
            view._scrollOffset = 0;
            assert.equal(view._getVisiblePlain(), 'hi        ');
            view.destroy();
        });

        it('reveal: lead fill chars match _scrollOffset, then text follows', () => {
            //  scrollOffset=3 → 3 fill chars, then text 'hello', then remaining fill
            const view = makeTicker({ text: 'hello', motion: 'reveal', dimens: { width: 10, height: 1 } });
            view._scrollOffset = 3;
            const plain = view._getVisiblePlain();
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
    before(() => { ft = makeFakeTimers(); });
    after(() => { ft.restore(); });

    function makeSBView(opts = {}) {
        return new StatusBarView(Object.assign({
            client:          makeClient(),
            id:              1,
            position:        { row: 1, col: 1 },
            dimens:          { width: 40, height: 1 },
            text:            'hello',
            refreshInterval: 0,
        }, opts));
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
            const id   = view._timer;
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
            const id   = view._timer;

            let redrawCount = 0;
            view.redraw = () => { redrawCount++; };

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
            const id   = view._timer;

            let redrawCount = 0;
            view.redraw = () => { redrawCount++; };

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
            const view  = makeSBView({ refreshInterval: 500 });
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
        return new MaskEditTextView(Object.assign({
            client:      makeClient(),
            id:          1,
            position:    { row: 1, col: 1 },
            dimens:      { width: 10, height: 1 },
            maskPattern: '',
        }, opts));
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
            const pa   = view.patternArray;
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
            const re   = view.patternArray[0];
            assert.ok(re instanceof RegExp);
            assert.ok('5'.match(re), 'digit should match @');
            assert.ok('A'.match(re), 'letter should match @');
        });

        it('digit # does not accept letters', () => {
            const view = makeMaskView({ maskPattern: '#' });
            const re   = view.patternArray[0];
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
