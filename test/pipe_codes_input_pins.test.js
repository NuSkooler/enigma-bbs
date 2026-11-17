'use strict';

//
//  What the input side draws today, byte for byte: the single-line editor's
//  live colour preview, the multi-line editor, sysop chat's input line and a
//  TextView with an itemFormat (pipe codes PR B, #1022).
//
//  A refactor must leave every pin as it is. A fix that changes what is drawn
//  changes its own pins in the same commit, so the test diff is the record of
//  the change. Pins marked "today:" hold output that is known to be wrong.
//
//  Terminal output is shown with ESC written as ^[ so a pin reads as text.
//

const { strict: assert } = require('assert');

const ESC = String.fromCharCode(27);
const show = s => s.split(ESC).join('^[');

function makeClient() {
    const writes = [];
    return {
        term: {
            termWidth: 80,
            termHeight: 25,
            write: s => writes.push(String(s)),
            rawWrite: s => writes.push(String(s)),
        },
        user: { username: 'Bryan' },
        log: {
            trace() {},
            debug() {},
            info() {},
            warn() {},
            error() {},
            fatal() {},
        },
        writes,
    };
}

function takeWrites(client) {
    const out = show(client.writes.join(''));
    client.writes.length = 0;
    return out;
}

//  setTimeout stand-in: the editors' 300 ms collapse runs on '<tick>' only
function fakeTimers() {
    const pending = new Map();
    let next = 1;
    const saved = { setTimeout: global.setTimeout, clearTimeout: global.clearTimeout };
    global.setTimeout = fn => {
        pending.set(next, fn);
        return next++;
    };
    global.clearTimeout = id => pending.delete(id);
    return {
        tick() {
            const fns = [...pending.values()];
            pending.clear();
            fns.forEach(fn => fn());
        },
        restore() {
            global.setTimeout = saved.setTimeout;
            global.clearTimeout = saved.clearTimeout;
        },
    };
}

const KEYS = {
    '<left>': 'left arrow',
    '<right>': 'right arrow',
    '<home>': 'home',
    '<end>': 'end',
    '<bs>': 'backspace',
    '<del>': 'delete',
};

//  Runs |steps| (characters, '<key>' names, '<tick>', '<focus>', '<redraw>')
//  and returns what each one wrote.
function run(view, client, timers, steps, press = (ch, key) => view.onKeyPress(ch, key)) {
    takeWrites(client);
    return steps.map(step => {
        if ('<tick>' === step) {
            timers.tick();
        } else if ('<focus>' === step) {
            view.setFocus(true);
        } else if ('<redraw>' === step) {
            view.redraw();
        } else if (KEYS[step]) {
            press(null, { name: KEYS[step] });
        } else {
            press(step);
        }
        return takeWrites(client);
    });
}

describe('Pipe code input pins', function () {
    let EditTextView;
    let TextView;
    let ButtonView;
    let MultiLineEditTextView;
    let SysopChatModule;
    let timers;

    before(function () {
        ({ EditTextView } = require('../core/edit_text_view.js'));
        ({ TextView } = require('../core/text_view.js'));
        ({ ButtonView } = require('../core/button_view.js'));
        ({ MultiLineEditTextView } = require('../core/multi_line_edit_text_view.js'));
        SysopChatModule = require('../core/sysop_chat.js').getModule;
    });

    beforeEach(function () {
        timers = fakeTimers();
    });

    afterEach(function () {
        timers.tick(); //  nothing left pending
        timers.restore();
    });

    function makeEtv({ width = 10, itemFormat } = {}) {
        const client = makeClient();
        const v = new EditTextView({
            client,
            id: 1,
            position: { row: 3, col: 5 },
            dimens: { width, height: 1 },
        });
        if (itemFormat) {
            v.itemFormat = itemFormat;
        }
        v.hasFocus = true;
        return { v, client };
    }

    //  sysop chat sets the input view up itself: drive the real code with a
    //  module that has only what it reads
    function makeChatInput({ width = 20, prefixFormat } = {}) {
        const { v, client } = makeEtv({ width });
        const module = { client, config: {} };
        if (undefined !== prefixFormat) {
            v.prefixFormat = prefixFormat;
        }
        SysopChatModule.prototype._enableLiveColorOnInput.call(module, v);
        return { v, client };
    }

    //  Checks |got| against |want| step by step, so a failure names the step
    function assertSteps(steps, got, want) {
        assert.equal(got.length, want.length);
        got.forEach((g, n) => assert.equal(g, want[n], `step ${n} (${steps[n]})`));
    }

    describe('EditTextView helpers', function () {
        it('finds complete and partial colour codes', function () {
            const { v } = makeEtv({ itemFormat: '{text}' });
            const has = [
                '|07',
                'a|07b',
                '|0',
                'ab|',
                '|0a',
                '|AA',
                '|7',
                'x|07|',
                '',
            ].map(s => v._hasPipeCodes(s));
            assert.deepEqual(has, [
                true,
                true,
                true,
                true,
                false,
                false,
                true,
                true,
                false,
            ]);

            const near = [
                ['ab|07', 5],
                ['ab|07', 4],
                ['ab|07', 3],
                ['ab|0', 4],
                ['ab|', 3],
                ['ab|07c', 6],
                ['|0|07', 5],
                ['|0|07', 2],
                ['|a', 2],
            ].map(([s, col]) => [
                v._codeStartNearCursor(s, col),
                v._cursorNearCompleteCode(s, col),
                v._cursorNearPipeCode(s, col),
            ]);
            assert.deepEqual(near, [
                [2, true, true],
                [2, false, true],
                [2, false, true],
                [2, false, true],
                [2, false, true],
                [-1, false, false],
                [2, true, true],
                [0, false, true],
                [-1, false, false],
            ]);
        });

        it('renders collapsed and expanded lines', function () {
            const { v } = makeEtv({ itemFormat: '{text}' });
            const collapsed = [
                'ab|07cd',
                '||07',
                '|0|077',
                '|0707',
                '|1A|UN|CF05',
                'x|',
                '|99|00',
                '|15|16|31|32',
                'plain',
            ].map(s => show(v._renderLineCollapsed(s)));
            assert.deepEqual(collapsed, [
                'ab^[[22;37mcd',
                '|^[[22;37m',
                '|0^[[22;37m7',
                '^[[22;37m07',
                '|1A|UN|CF05',
                'x|',
                '^[[22m^[[22;30m',
                '^[[1;37m^[[40m^[[5;47m^[[22m',
                'plain',
            ]);

            const expanded = [
                ['ab|07cd', 2],
                ['ab|07cd|04e', 7],
                ['ab|07cd|04e', 2],
                ['|07|0', 3], //  partial right after the last code: base SGR
                ['|0', 0], //  partial at 0: base SGR
                ['x|0', 1], //  partial elsewhere: none
                ['|07x|', 4],
                ['ab|07cd', 0],
            ].map(([s, near]) => show(v._renderLineExpanded(s, near)));
            assert.deepEqual(expanded, [
                'ab^[[22;37m|07cd',
                'ab^[[22;37mcd^[[22;31m|04e',
                'ab^[[22;37m|07cd^[[22;31me',
                '^[[22;37m^[[0;39;49m|0',
                '^[[0;39;49m|0',
                'x|0',
                '^[[22;37mx|',
                'ab^[[22;37mcd',
            ]);
        });

        it('slices and indexes by visible characters', function () {
            const { v } = makeEtv({ itemFormat: '{text}' });
            const s = 'ab|07cd|04ef|1|';
            const slices = [
                [0, 3],
                [1, 3],
                [2, 2],
                [3, 10],
                [6, 4],
                [0, 0],
            ].map(([off, n]) => v._visSliceRaw(s, off, n));
            assert.deepEqual(slices, [
                'ab|07c',
                'b|07cd',
                '|07cd',
                'd|04ef|1|',
                '|1|',
                '',
            ]);
            const idx = [0, 1, 2, 3, 4, 6, 7, 20].map(off => v._visToBufferIdx(s, off));
            assert.deepEqual(idx, [0, 1, 2, 6, 7, 12, 13, 15]);
            //  today: one unit per UTF-16 code unit, not per column
            assert.deepEqual(
                [v._visSliceRaw('日本|07語x', 1, 2), v._visToBufferIdx('日本|07語x', 2)],
                ['本|07語', 2]
            );
        });

        it('maps buffer columns to display columns', function () {
            const live = makeEtv({ itemFormat: '{text}' }).v;
            const asTyped = makeEtv().v;
            const s = 'ab|07日d';
            live.setText(s, false);
            asTyped.setText(s, false);
            const cols = [0, 1, 2, 3, 4, 5, 6, 7, 20];
            assert.deepEqual(
                cols.map(c => live._bufferToDisplayCol(c)),
                [0, 1, 2, 2, 2, 2, 4, 5, 5]
            );
            assert.deepEqual(
                cols.map(c => asTyped._bufferToDisplayCol(c)),
                [0, 1, 2, 3, 4, 5, 7, 8, 8]
            );
        });
    });

    describe('EditTextView live colour (itemFormat)', function () {
        it('types, collapses, backspaces into a code and moves', function () {
            const { v, client } = makeEtv({ itemFormat: '{text}' });
            const steps = [
                '<focus>',
                ...'ab|07cd',
                '<tick>',
                '<left>',
                '<left>',
                '<bs>',
                '7',
                'x',
                '<tick>',
                '<home>',
                '<end>',
                '<redraw>',
            ];
            assertSteps(steps, run(v, client, timers, steps), [
                '^[[?25h^[[3;5H^[[0;39;49m^[[0;39;49m^[[0;39;49m          ^[[3;5H^[[0;39;49m^[[0;39;49m',
                '^[[?25l^[[3;5Ha^[[0;39;49m         ^[[3;6H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5Hab^[[0;39;49m        ^[[3;7H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5Hab|^[[0;39;49m       ^[[3;8H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5Hab|0^[[0;39;49m      ^[[3;9H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5Hab^[[22;37m|07^[[0;39;49m        ^[[3;7H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5Hab^[[22;37m|07c^[[0;39;49m       ^[[3;8H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5Hab^[[22;37m|07cd^[[0;39;49m      ^[[3;9H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5Hab^[[22;37mcd^[[0;39;49m      ^[[3;9H^[[0;39;49m^[[?25h',
                '^[[3;8H^[[0;39;49m',
                '^[[3;7H^[[0;39;49m',
                '^[[3;5H^[[0;39;49m^[[0;39;49mab|0cd^[[0;39;49m    ^[[3;9H^[[0;39;49m',
                '^[[?25l^[[3;5Hab^[[22;37m|07cd^[[0;39;49m      ^[[3;7H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5Hab^[[22;37m|07xcd^[[0;39;49m     ^[[3;8H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5Hab^[[22;37mxcd^[[0;39;49m     ^[[3;8H^[[0;39;49m^[[?25h',
                '^[[3;5H^[[0;39;49m^[[0;39;49mab^[[22;37mxcd^[[0;39;49m     ^[[3;5H^[[0;39;49m',
                '^[[3;5H^[[0;39;49m^[[0;39;49mab^[[22;37mxcd^[[0;39;49m     ^[[3;10H^[[0;39;49m',
                '^[[3;5H^[[0;39;49m^[[0;39;49mab^[[22;37mxcd^[[0;39;49m     ',
            ]);
        });

        it('a code typed at the right edge (today: fills 3 cells past the field)', function () {
            //  changes when the expanded code is measured as drawn
            const { v, client } = makeEtv({ itemFormat: '{text}' });
            const steps = [...'abcde|07', 'f', '<tick>'];
            assertSteps(steps, run(v, client, timers, steps), [
                '^[[?25l^[[3;5Ha^[[0;39;49m         ^[[3;6H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5Hab^[[0;39;49m        ^[[3;7H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5Habc^[[0;39;49m       ^[[3;8H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5Habcd^[[0;39;49m      ^[[3;9H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5Habcde^[[0;39;49m     ^[[3;10H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5Habcde|^[[0;39;49m    ^[[3;11H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5Habcde|0^[[0;39;49m   ^[[3;12H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5Habcde^[[22;37m|07^[[0;39;49m     ^[[3;10H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5Habcde^[[22;37m|07f^[[0;39;49m    ^[[3;11H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5Habcde^[[22;37mf^[[0;39;49m    ^[[3;11H^[[0;39;49m^[[?25h',
            ]);
        });

        it('scrolls a long coloured line (today: the window is cut in buffer units)', function () {
            //  The live write takes dimens.width buffer units from the scroll
            //  offset, so each code in the window hides a character at the
            //  right edge ('h' at step 13), and an expanded code is not
            //  counted where the cursor goes (steps 9-12).
            const { v, client } = makeEtv({ itemFormat: '{text}' });
            const steps = [
                ...'|04abcdefgh|07ijklm',
                '<tick>',
                '<home>',
                '<right>',
                '<right>',
                '<right>',
                '<end>',
                '<left>',
                '<left>',
                '<left>',
                '<left>',
                '<left>',
                '<left>',
                '<del>',
            ];
            assertSteps(steps, run(v, client, timers, steps), [
                '^[[?25l^[[3;5H|^[[0;39;49m         ^[[3;6H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H|0^[[0;39;49m        ^[[3;7H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[22;31m|04^[[0;39;49m          ^[[3;5H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[22;31m|04a^[[0;39;49m         ^[[3;6H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[22;31m|04ab^[[0;39;49m        ^[[3;7H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[22;31m|04abc^[[0;39;49m       ^[[3;8H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[22;31m|04abcd^[[0;39;49m      ^[[3;9H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[22;31m|04abcde^[[0;39;49m     ^[[3;10H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[22;31m|04abcdef^[[0;39;49m    ^[[3;11H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[22;31m|04abcdefg^[[0;39;49m   ^[[3;12H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[22;31m|04abcdefg^[[0;39;49m   ^[[3;13H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[22;31m|04abcdefg^[[0;39;49m   ^[[3;14H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[22;31m|04abcdefg^[[0;39;49m   ^[[3;15H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[22;31mabcdefg^[[0;39;49m   ^[[3;13H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[22;31mabcdefg^[[0;39;49m   ^[[3;14H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[22;31mabcdefg^[[0;39;49m   ^[[3;15H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5Hcdefgh^[[22;37m|07i^[[0;39;49m   ^[[3;14H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5Hdefgh^[[22;37m|07ij^[[0;39;49m   ^[[3;14H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5Hefgh^[[22;37m|07ijk^[[0;39;49m   ^[[3;14H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5Hefgh^[[22;37mijk^[[0;39;49m   ^[[3;14H^[[0;39;49m^[[?25h',
                '^[[3;5H^[[0;39;49m^[[0;39;49m^[[22;31mabcdefgh^[[22;37mij^[[0;39;49m^[[3;5H^[[0;39;49m',
                '^[[3;5H^[[0;39;49m',
                '^[[3;5H^[[0;39;49m',
                '^[[3;5H^[[0;39;49m',
                '^[[3;5H^[[0;39;49m^[[0;39;49mdefgh^[[22;37mijklm^[[0;39;49m^[[3;15H^[[0;39;49m',
                '^[[3;14H^[[0;39;49m',
                '^[[3;13H^[[0;39;49m',
                '^[[3;12H^[[0;39;49m',
                '^[[3;11H^[[0;39;49m',
                '^[[3;10H^[[0;39;49m',
                '^[[3;10H^[[0;39;49m',
                '^[[?25l^[[3;5Hdefgh|0ijk^[[3;12H^[[0;39;49m^[[?25h',
            ]);
        });

        it('wide characters', function () {
            const { v, client } = makeEtv({ itemFormat: '{text}' });
            const steps = [...'日本|07語xyz', '<tick>', '<home>', '<end>'];
            assertSteps(steps, run(v, client, timers, steps), [
                '^[[?25l^[[3;5H日^[[0;39;49m        ^[[3;7H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H日本^[[0;39;49m      ^[[3;9H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H日本|^[[0;39;49m     ^[[3;10H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H日本|0^[[0;39;49m    ^[[3;11H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H日本^[[22;37m|07^[[0;39;49m      ^[[3;9H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H日本^[[22;37m|07語^[[0;39;49m    ^[[3;11H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H日本^[[22;37m|07語x^[[0;39;49m   ^[[3;12H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H日本^[[22;37m|07語xy^[[0;39;49m  ^[[3;13H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H日本^[[22;37m|07語xyz^[[0;39;49m ^[[3;14H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H日本^[[22;37m語xyz^[[0;39;49m ^[[3;14H^[[0;39;49m^[[?25h',
                '^[[3;5H^[[0;39;49m^[[0;39;49m日本^[[22;37m語xyz^[[0;39;49m ^[[3;5H^[[0;39;49m',
                '^[[3;5H^[[0;39;49m^[[0;39;49m日本^[[22;37m語xyz^[[0;39;49m ^[[3;14H^[[0;39;49m',
            ]);
        });

        it('a typed || (today: shown || while typing and | after a redraw)', function () {
            //  changes when an itemFormat renders its text once
            const { v, client } = makeEtv({ itemFormat: '{text}' });
            const steps = [...'a||b', '<home>', '<redraw>'];
            assertSteps(steps, run(v, client, timers, steps), [
                '^[[?25l^[[3;5Ha^[[0;39;49m         ^[[3;6H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5Ha|^[[0;39;49m        ^[[3;7H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5Ha||^[[0;39;49m       ^[[3;8H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5Ha||b^[[0;39;49m      ^[[3;9H^[[0;39;49m^[[?25h',
                '^[[3;5H^[[0;39;49m^[[0;39;49ma|b^[[0;39;49m       ^[[3;5H^[[0;39;49m',
                '^[[3;5H^[[0;39;49m^[[0;39;49ma|b^[[0;39;49m       ',
            ]);
        });
    });

    describe('EditTextView without an itemFormat', function () {
        it('draws the text as typed', function () {
            const { v, client } = makeEtv();
            const steps = [
                '<focus>',
                ...'ab|07cdefghij',
                '<home>',
                '<right>',
                '<bs>',
                '<end>',
            ];
            assertSteps(steps, run(v, client, timers, steps), [
                '^[[?25h^[[3;5H^[[0;39;49m^[[0;39;49m^[[0;39;49m          ^[[3;5H^[[0;39;49m^[[0;39;49m',
                'a',
                'b',
                '|',
                '0',
                '7',
                'c',
                'd',
                'e',
                'f',
                'g',
                '^[[3;5H^[[0;39;49m^[[0;39;49mb|07cdefgh^[[0;39;49m^[[3;15H^[[0;39;49m',
                '^[[3;5H^[[0;39;49m^[[0;39;49m|07cdefghi^[[0;39;49m^[[3;15H^[[0;39;49m',
                '^[[3;5H^[[0;39;49m^[[0;39;49m07cdefghij^[[0;39;49m^[[3;15H^[[0;39;49m',
                '^[[3;5H^[[0;39;49m^[[0;39;49mab|07cdefg^[[0;39;49m^[[3;5H^[[0;39;49m',
                '^[[3;6H^[[0;39;49m',
                '^[[3;5H^[[0;39;49m^[[0;39;49mb|07cdefgh^[[0;39;49m^[[3;5H^[[0;39;49m',
                '^[[3;5H^[[0;39;49m^[[0;39;49m07cdefghij^[[0;39;49m^[[3;15H^[[0;39;49m',
            ]);
        });
    });

    describe('sysop chat input', function () {
        it('the shipped prefix, ASCII with codes, then scrolled', function () {
            const { v, client } = makeChatInput({ prefixFormat: '|11{userName} |14> ' });
            const steps = [
                '<focus>',
                ...'hi |04there|07 ok',
                '<tick>',
                ...' and more',
                '<tick>',
                '<home>',
                '<right>',
                '<right>',
                '<end>',
                '<left>',
                '<bs>',
                '<redraw>',
            ];
            assertSteps(steps, run(v, client, timers, steps), [
                '^[[?25h^[[3;5H^[[0;39;49m^[[0;39;49m^[[1;36mBryan ^[[1;33m> ^[[0;39;49m            ^[[3;13H^[[0;39;49m^[[0;39;49m',
                '^[[?25l^[[3;5H^[[1;36mBryan ^[[1;33m> h^[[0;39;49m           ^[[3;14H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[1;36mBryan ^[[1;33m> hi^[[0;39;49m          ^[[3;15H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[1;36mBryan ^[[1;33m> hi ^[[0;39;49m         ^[[3;16H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[1;36mBryan ^[[1;33m> hi |^[[0;39;49m        ^[[3;17H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[1;36mBryan ^[[1;33m> hi |0^[[0;39;49m       ^[[3;18H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[1;36mBryan ^[[1;33m> hi ^[[22;31m|04^[[0;39;49m         ^[[3;16H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[1;36mBryan ^[[1;33m> hi ^[[22;31m|04t^[[0;39;49m        ^[[3;17H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[1;36mBryan ^[[1;33m> hi ^[[22;31m|04th^[[0;39;49m       ^[[3;18H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[1;36mBryan ^[[1;33m> hi ^[[22;31m|04the^[[0;39;49m      ^[[3;19H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[1;36mBryan ^[[1;33m> hi ^[[22;31m|04ther^[[0;39;49m     ^[[3;20H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[1;36mBryan ^[[1;33m> hi ^[[22;31m|04there^[[0;39;49m    ^[[3;21H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[1;36mBryan ^[[1;33m> hi ^[[22;31m|04there|^[[0;39;49m   ^[[3;22H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[1;36mBryan ^[[1;33m> hi ^[[22;31m|04there|0^[[0;39;49m  ^[[3;23H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[1;36mBryan ^[[1;33m> hi ^[[22;31mthere^[[22;37m|07^[[0;39;49m    ^[[3;21H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[1;36mBryan ^[[1;33m> hi ^[[22;31mthere^[[22;37m|07 ^[[0;39;49m   ^[[3;22H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[1;36mBryan ^[[1;33m> hi ^[[22;31mthere^[[22;37m|07 o^[[0;39;49m  ^[[3;23H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[1;36mBryan ^[[1;33m> hi ^[[22;31mthere^[[22;37m|07 ok^[[0;39;49m ^[[3;24H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[1;36mBryan ^[[1;33m> hi ^[[22;31mthere^[[22;37m ok^[[0;39;49m ^[[3;24H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[1;36mBryan ^[[1;33m> hi ^[[22;31mthere^[[22;37m ok ^[[3;25H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[1;36mBryan ^[[1;33m> i ^[[22;31mthere^[[22;37m ok a^[[3;25H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[1;36mBryan ^[[1;33m>  ^[[22;31mthere^[[22;37m ok an^[[3;25H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[1;36mBryan ^[[1;33m> ^[[22;31mthere^[[22;37m ok and^[[3;25H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[1;36mBryan ^[[1;33m> here^[[22;37m ok and ^[[3;25H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[1;36mBryan ^[[1;33m> ere^[[22;37m ok and m^[[3;25H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[1;36mBryan ^[[1;33m> re^[[22;37m ok and mo^[[3;25H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[1;36mBryan ^[[1;33m> e^[[22;37m ok and mor^[[3;25H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[1;36mBryan ^[[1;33m> ^[[22;37m ok and more^[[3;25H^[[0;39;49m^[[?25h',
                '',
                '^[[3;5H^[[0;39;49m^[[0;39;49m^[[1;36mBryan ^[[1;33m> hi ^[[22;31mthere^[[22;37m ok ^[[0;39;49m^[[3;13H^[[0;39;49m',
                '^[[3;14H^[[0;39;49m',
                '^[[3;15H^[[0;39;49m',
                '^[[3;5H^[[0;39;49m^[[0;39;49m^[[1;36mBryan ^[[1;33m> ^[[22;37m ok and more^[[0;39;49m^[[3;25H^[[0;39;49m',
                '^[[3;24H^[[0;39;49m',
                '^[[?25l^[[3;5H^[[1;36mBryan ^[[1;33m> e^[[22;37m ok and moe^[[3;24H^[[0;39;49m^[[?25h',
                '^[[3;5H^[[0;39;49m^[[0;39;49m^[[1;36mBryan ^[[1;33m> e^[[22;37m ok and moe^[[0;39;49m',
            ]);
            assert.deepEqual(
                [v._scrollOffset, v._computeScrollOffset(), v._prefixW],
                [7, 7, 8]
            );
        });

        it('a prefix with literal pipes (today: measured one column short)', function () {
            //  changes when the prefix is measured as rendered
            const { v, client } = makeChatInput({ prefixFormat: '[|14||||]' });
            const steps = ['<focus>', ...'ab|04c', '<tick>', '<redraw>'];
            assertSteps(steps, run(v, client, timers, steps), [
                '^[[?25h^[[3;5H^[[0;39;49m^[[0;39;49m[^[[1;33m|]^[[0;39;49m                 ^[[3;8H^[[0;39;49m^[[0;39;49m',
                '^[[?25l^[[3;5H[^[[1;33m||]a^[[0;39;49m                ^[[3;9H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H[^[[1;33m||]ab^[[0;39;49m               ^[[3;10H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H[^[[1;33m||]ab|^[[0;39;49m              ^[[3;11H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H[^[[1;33m||]ab|0^[[0;39;49m             ^[[3;12H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H[^[[1;33m||]ab^[[22;31m|04^[[0;39;49m               ^[[3;10H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H[^[[1;33m||]ab^[[22;31m|04c^[[0;39;49m              ^[[3;11H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H[^[[1;33m||]ab^[[22;31mc^[[0;39;49m              ^[[3;11H^[[0;39;49m^[[?25h',
                '^[[3;5H^[[0;39;49m^[[0;39;49m[^[[1;33m|]ab^[[22;31mc^[[0;39;49m              ',
            ]);
            assert.deepEqual(
                [show(v._resolvedPrefix), v._prefixW, show(v.itemFormat)],
                ['[^[[1;33m||]', 3, '[^[[1;33m||]{text}']
            );
        });

        it('no prefix, codes scrolled out (today: sliced in the wrong unit)', function () {
            //  changes when sysop chat says which unit its scroll offset is in
            const { v, client } = makeChatInput({ width: 10 });
            const steps = [
                '<focus>',
                ...'|04abc|07defgh|02ijklm',
                '<tick>',
                '<home>',
                '<end>',
                '<redraw>',
            ];
            assertSteps(steps, run(v, client, timers, steps), [
                '^[[?25h^[[3;5H^[[0;39;49m^[[0;39;49m^[[0;39;49m          ^[[3;5H^[[0;39;49m^[[0;39;49m',
                '^[[?25l^[[3;5H|^[[0;39;49m         ^[[3;6H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H|0^[[0;39;49m        ^[[3;7H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[22;31m|04^[[0;39;49m          ^[[3;5H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[22;31m|04a^[[0;39;49m         ^[[3;6H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[22;31m|04ab^[[0;39;49m        ^[[3;7H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[22;31m|04abc^[[0;39;49m       ^[[3;8H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[22;31m|04abc|^[[0;39;49m      ^[[3;9H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[22;31m|04abc|0^[[0;39;49m     ^[[3;10H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[22;31mabc^[[22;37m|07^[[0;39;49m       ^[[3;8H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[22;31mabc^[[22;37m|07d^[[0;39;49m      ^[[3;9H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[22;31mabc^[[22;37m|07d^[[0;39;49m      ^[[3;10H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[22;31mabc^[[22;37m|07d^[[0;39;49m      ^[[3;11H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[22;31mabc^[[22;37m|07d^[[0;39;49m      ^[[3;12H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[22;31mabc^[[22;37m|07d^[[0;39;49m      ^[[3;13H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[22;31mabc^[[22;37m|07d^[[0;39;49m      ^[[3;14H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[22;31mabc^[[22;37m|07d^[[0;39;49m      ^[[3;15H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[22;31mabc^[[22;37md^[[0;39;49m      ^[[3;13H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[22;31mabc^[[22;37md^[[0;39;49m      ^[[3;14H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[22;31mabc^[[22;37md^[[0;39;49m      ^[[3;15H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H04abc^[[22;37mde^[[0;39;49m   ^[[3;15H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H4abc^[[22;37mdef^[[0;39;49m   ^[[3;15H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5Habc^[[22;37mdefg^[[0;39;49m   ^[[3;15H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5Habc^[[22;37mdefg^[[0;39;49m   ^[[3;15H^[[0;39;49m^[[?25h',
                '^[[3;5H^[[0;39;49m^[[0;39;49m^[[22;31mabc^[[22;37mdefgh^[[22;32mij^[[0;39;49m^[[3;5H^[[0;39;49m',
                '^[[3;5H^[[0;39;49m^[[0;39;49m^[[22;37mdefgh^[[22;32mijklm^[[0;39;49m^[[3;15H^[[0;39;49m',
                '^[[3;5H^[[0;39;49m^[[0;39;49m^[[22;37mdefgh^[[22;32mijklm^[[0;39;49m',
            ]);
            assert.deepEqual([v._scrollOffset, v._prefixW], [3, 0]);
        });

        it('wide characters (today: counted in UTF-16 units)', function () {
            //  changes when sysop chat input is measured in display columns
            const { v, client } = makeChatInput({ width: 14, prefixFormat: '|11> ' });
            const steps = [
                '<focus>',
                ...'日本|07語xyz日本',
                '<tick>',
                '<home>',
                '<end>',
                '<redraw>',
            ];
            assertSteps(steps, run(v, client, timers, steps), [
                '^[[?25h^[[3;5H^[[0;39;49m^[[0;39;49m^[[1;36m> ^[[0;39;49m            ^[[3;7H^[[0;39;49m^[[0;39;49m',
                '^[[?25l^[[3;5H^[[1;36m> 日^[[0;39;49m          ^[[3;8H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[1;36m> 日本^[[0;39;49m        ^[[3;9H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[1;36m> 日本|^[[0;39;49m       ^[[3;10H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[1;36m> 日本|0^[[0;39;49m      ^[[3;11H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[1;36m> 日本^[[22;37m|07^[[0;39;49m        ^[[3;9H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[1;36m> 日本^[[22;37m|07語^[[0;39;49m      ^[[3;10H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[1;36m> 日本^[[22;37m|07語x^[[0;39;49m     ^[[3;11H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[1;36m> 日本^[[22;37m|07語xy^[[0;39;49m    ^[[3;12H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[1;36m> 日本^[[22;37m|07語xyz^[[0;39;49m   ^[[3;13H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[1;36m> 日本^[[22;37m|07語xyz日^[[0;39;49m ^[[3;14H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[1;36m> 日本^[[22;37m|07語xyz日本^[[3;15H^[[0;39;49m^[[?25h',
                '^[[?25l^[[3;5H^[[1;36m> 日本^[[22;37m語xyz日本^[[3;15H^[[0;39;49m^[[?25h',
                '^[[3;5H^[[0;39;49m^[[0;39;49m^[[1;36m 日本^[[22;37m語xyz日本^[[0;39;49m^[[3;7H^[[0;39;49m',
                '^[[3;5H^[[0;39;49m^[[0;39;49m^[[1;36m 日本^[[22;37m語xyz日本^[[0;39;49m^[[3;15H^[[0;39;49m',
                '^[[3;5H^[[0;39;49m^[[0;39;49m^[[1;36m 日本^[[22;37m語xyz日本^[[0;39;49m',
            ]);
            assert.deepEqual([v._scrollOffset, v._computeScrollOffset()], [0, 0]);
        });
    });

    describe('TextView family with an itemFormat', function () {
        function drawn(make) {
            const client = makeClient();
            const v = make(client);
            v.setText('a||07b', false);
            takeWrites(client);
            v.redraw();
            return [show(v.text), takeWrites(client)];
        }

        it('TextView (today: a literal pipe in the text is read as a code again)', function () {
            //  changes when an itemFormat renders its text once
            const opts = client => ({
                client,
                position: { row: 2, col: 1 },
                dimens: { width: 10, height: 1 },
            });
            const plain = drawn(client => new TextView(opts(client)));
            const formatted = drawn(client => {
                const v = new TextView(opts(client));
                v.itemFormat = '<{text}>';
                return v;
            });
            assert.deepEqual(
                [plain, formatted],
                [
                    ['a|07b', '^[[2;1H^[[0;39;49m^[[0;39;49ma|07b^[[0;39;49m     '],
                    [
                        'a|07b',
                        '^[[2;1H^[[0;39;49m^[[0;39;49m<a^[[22;37mb>^[[0;39;49m      ',
                    ],
                ]
            );
        });

        it('ButtonView with the shipped BT7 format (today: as TextView)', function () {
            //  changes when an itemFormat renders its text once
            const got = drawn(client => {
                const v = new ButtonView({
                    client,
                    position: { row: 2, col: 1 },
                    dimens: { width: 14, height: 1 },
                });
                v.setPropertyValue('itemFormat', '|00|08[ |03{text} |08]');
                return v;
            });
            assert.deepEqual(got, [
                'a|07b',
                '^[[2;1H^[[0;39;49m^[[0;39;49m    ^[[0;39;49m^[[22;30m^[[1;30m[ ^[[22;36ma^[[22;37mb ^[[1;30m]^[[0;39;49m    ',
            ]);
        });
    });

    describe('MultiLineEditTextView live colour', function () {
        function makeMle() {
            const client = makeClient();
            const v = new MultiLineEditTextView({
                client,
                position: { row: 5, col: 3 },
                dimens: { width: 12, height: 3 },
            });
            v.hasFocus = true;
            return { v, client };
        }

        it('types, collapses, backspaces into a code and moves', function () {
            const { v, client } = makeMle();
            const steps = [
                ...'ab|07cd',
                '<tick>',
                '<left>',
                '<left>',
                '<bs>',
                '7',
                'x',
                '<tick>',
                '<home>',
                '<right>',
                '<right>',
                '<right>',
                '<end>',
            ];
            const got = run(v, client, timers, steps, (ch, key) =>
                v._handleKeyPress(ch, key)
            );
            assertSteps(steps, got, [
                '^[[?25l^[[0;39;49m^[[5;3Ha           ^[[5;4H^[[?25h',
                '^[[?25l^[[0;39;49m^[[5;4Hb          ^[[5;5H^[[?25h',
                '^[[?25l^[[0;39;49m^[[5;3Hab|         ^[[5;6H^[[?25h',
                '^[[?25l^[[0;39;49m^[[5;3Hab|0        ^[[5;7H^[[?25h',
                '^[[?25l^[[0;39;49m^[[5;3Hab^[[22;37m|07^[[0;39;49m       ^[[5;8H^[[?25h',
                '^[[?25l^[[0;39;49m^[[5;3Hab^[[22;37m|07c^[[0;39;49m      ^[[5;9H^[[?25h',
                '^[[?25l^[[0;39;49m^[[5;3Hab^[[22;37m|07cd^[[0;39;49m     ^[[5;10H^[[?25h',
                '^[[?25l^[[0;39;49m^[[5;3Hab^[[22;37mcd^[[0;39;49m        ^[[5;7H^[[?25h',
                '^[[5;6H',
                '^[[5;5H',
                '^[[0;39;49m^[[?25l^[[5;3H^[[0;39;49mab|0cd      ^[[0;39;49m^[[?25h^[[5;7H',
                '^[[?25l^[[0;39;49m^[[5;3Hab^[[22;37m|07cd^[[0;39;49m     ^[[5;8H^[[?25h',
                '^[[?25l^[[0;39;49m^[[5;3Hab^[[22;37m|07xcd^[[0;39;49m    ^[[5;9H^[[?25h',
                '^[[?25l^[[0;39;49m^[[5;3Hab^[[22;37mxcd^[[0;39;49m       ^[[5;6H^[[?25h',
                '^[[5;3H',
                '^[[5;4H',
                '^[[5;5H',
                '^[[5;5H',
                '^[[5;8H',
            ]);
        });

        it('a partial code and a wrapped coloured line', function () {
            const { v, client } = makeMle();
            const steps = [
                ...'|0',
                '<tick>',
                ...'4abc |12defgh |1',
                '<tick>',
                '<bs>',
                '<bs>',
            ];
            const got = run(v, client, timers, steps, (ch, key) =>
                v._handleKeyPress(ch, key)
            );
            assertSteps(steps, got, [
                '^[[?25l^[[0;39;49m^[[5;3H|           ^[[5;4H^[[?25h',
                '^[[?25l^[[0;39;49m^[[5;3H|0          ^[[5;5H^[[?25h',
                '',
                '^[[?25l^[[0;39;49m^[[5;3H^[[22;31m|04^[[0;39;49m         ^[[5;6H^[[?25h',
                '^[[?25l^[[0;39;49m^[[5;3H^[[22;31m|04a^[[0;39;49m        ^[[5;7H^[[?25h',
                '^[[?25l^[[0;39;49m^[[5;3H^[[22;31m|04ab^[[0;39;49m       ^[[5;8H^[[?25h',
                '^[[?25l^[[0;39;49m^[[5;3H^[[22;31m|04abc^[[0;39;49m      ^[[5;9H^[[?25h',
                '^[[?25l^[[0;39;49m^[[5;3H^[[22;31m|04abc ^[[0;39;49m     ^[[5;10H^[[?25h',
                '^[[?25l^[[0;39;49m^[[5;3H^[[22;31m|04abc |^[[0;39;49m    ^[[5;11H^[[?25h',
                '^[[?25l^[[0;39;49m^[[5;3H^[[22;31m|04abc |1^[[0;39;49m   ^[[5;12H^[[?25h',
                '^[[?25l^[[0;39;49m^[[5;3H^[[22;31mabc ^[[1;31m|12^[[0;39;49m     ^[[5;10H^[[?25h',
                '^[[?25l^[[0;39;49m^[[5;3H^[[22;31mabc ^[[1;31m|12d^[[0;39;49m    ^[[5;11H^[[?25h',
                '^[[?25l^[[0;39;49m^[[5;3H^[[22;31mabc ^[[1;31m|12de^[[0;39;49m   ^[[5;12H^[[?25h',
                '^[[?25l^[[0;39;49m^[[5;3H^[[22;31mabc ^[[1;31m|12def^[[0;39;49m  ^[[5;13H^[[?25h',
                '^[[?25l^[[0;39;49m^[[5;3H^[[22;31mabc ^[[1;31m|12defg^[[0;39;49m ^[[5;14H^[[?25h',
                '^[[?25l^[[0;39;49m^[[5;3H^[[22;31mabc ^[[1;31m|12defgh^[[0;39;49m^[[5;15H^[[?25h',
                '^[[?25l^[[0;39;49m^[[5;3H^[[22;31mabc ^[[1;31m|12defgh ^[[0;39;49m^[[5;16H^[[?25h',
                '^[[?25l^[[0;39;49m^[[5;3H^[[22;31mabc ^[[1;31m|12defgh |^[[0;39;49m^[[5;17H^[[?25h',
                '^[[?25l^[[0;39;49m^[[5;3H^[[22;31mabc ^[[1;31m|12defgh |1^[[0;39;49m^[[5;18H^[[?25h',
                '^[[?25l^[[0;39;49m^[[5;3H^[[22;31mabc ^[[1;31mdefgh |1^[[0;39;49m^[[5;15H^[[?25h',
                '^[[?25l^[[0;39;49m^[[5;3H^[[22;31mabc ^[[1;31mdefgh |^[[0;39;49m ^[[5;14H^[[?25h',
                '^[[?25l^[[0;39;49m^[[5;3H^[[22;31mabc ^[[1;31mdefgh ^[[0;39;49m  ^[[5;13H^[[?25h',
            ]);
            assert.deepEqual(
                v.buffer.lines.map(l => l.chars),
                ['|04abc |12defgh ']
            );
        });
    });
});
