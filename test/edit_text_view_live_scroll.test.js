'use strict';

//
//  The single-line editor's live colour preview (an itemFormat) keeps the
//  cursor in the field and draws the same thing whichever path draws it:
//  the live write, or a redraw (pipe codes PR B, #1022).
//

const { strict: assert } = require('assert');

const { charDisplayWidth } = require('../core/display_width.js');

const ESC = String.fromCharCode(27);
const CSI_RE = new RegExp(`^${ESC}\\[([0-9;?]*)([A-Za-z])`);

//  Enough of a terminal for one row: cursor moves, text, SGR ignored
function makeClient() {
    const cells = new Map();
    const cursor = { row: 1, col: 1 };
    const feed = s => {
        for (let i = 0; i < s.length;) {
            const m = CSI_RE.exec(s.slice(i));
            if (m) {
                if ('H' === m[2]) {
                    const [r, c] = m[1].split(';').map(n => parseInt(n, 10));
                    cursor.row = r;
                    cursor.col = c;
                }
                i += m[0].length;
                continue;
            }
            const ch = String.fromCodePoint(s.codePointAt(i));
            cells.set(`${cursor.row},${cursor.col}`, ch);
            cursor.col += charDisplayWidth(ch) || 1;
            i += ch.length;
        }
    };
    return {
        term: {
            termWidth: 80,
            termHeight: 25,
            write: s => feed(String(s)),
            rawWrite() {},
        },
        user: { username: 'Bryan' },
        log: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} },
        cursor,
        //  what the row shows from |col|, |n| columns (wide characters once)
        shown(row, col, n) {
            let out = '';
            for (let c = col; c < col + n; ++c) {
                out += cells.get(`${row},${c}`) || '';
            }
            return out;
        },
        clear() {
            cells.clear();
        },
    };
}

//  the 300 ms collapse runs only when a test says so
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
    '<home>': 'home',
    '<end>': 'end',
    '<left>': 'left arrow',
    '<bs>': 'backspace',
};

describe('EditTextView live colour: scroll and redraw', function () {
    let EditTextView;
    let SysopChatModule;
    let timers;

    before(function () {
        ({ EditTextView } = require('../core/edit_text_view.js'));
        SysopChatModule = require('../core/sysop_chat.js').getModule;
    });

    beforeEach(function () {
        timers = fakeTimers();
    });

    afterEach(function () {
        timers.tick();
        timers.restore();
    });

    function makeEtv(width, { prefixFormat, plain } = {}) {
        const client = makeClient();
        const v = new EditTextView({
            client,
            id: 1,
            position: { row: 3, col: 5 },
            dimens: { width, height: 1 },
        });
        v.maxLength = 200;
        if (plain) {
            //  no itemFormat: drawn as typed
        } else if (undefined === prefixFormat) {
            v.itemFormat = '{text}';
        } else {
            v.prefixFormat = prefixFormat;
            SysopChatModule.prototype._enableLiveColorOnInput.call(
                { client, config: {} },
                v
            );
        }
        v.hasFocus = true;
        v.setFocus(true);
        return { v, client };
    }

    function press(v, keys) {
        for (const k of keys) {
            if ('<tick>' === k) {
                timers.tick();
            } else if (KEYS[k]) {
                v.onKeyPress(null, { name: KEYS[k] });
            } else {
                v.onKeyPress(k);
            }
        }
    }

    //  The same keys twice: one view is redrawn, the other collapses its
    //  shown code with the live write. Both must show the same thing.
    function redrawAgainstCollapse(width, keys, opts) {
        const a = makeEtv(width, opts);
        const b = makeEtv(width, opts);
        press(a.v, keys);
        press(b.v, keys);
        assert.ok(a.v._pipeExpanded, 'a code is shown as typed');
        a.client.clear();
        a.v.redraw();
        a.v._repositionCursor();
        b.client.clear();
        b.v._collapsePipeCodes();
        const view = c => [c.shown(3, 5, width), c.cursor.col];
        assert.deepEqual(view(a.client), view(b.client));
        return view(a.client);
    }

    it('a redraw while a code is shown draws what the live write draws', function () {
        const keys = [...'abcdefghijklm|07'];
        assert.deepEqual(redrawAgainstCollapse(10, keys), ['defghijklm', 15]);
    });

    //  What the row shows and where the cursor is, after |keys| and then
    //  after each of |redraws| redraws: a redraw draws what was drawn.
    function redrawsAfter(width, keys, opts, redraws = 2) {
        const { v, client } = makeEtv(width, opts);
        press(v, keys.slice(0, -1));
        client.clear(); //  the last key draws the whole row
        press(v, keys.slice(-1));
        const views = [[client.shown(3, 5, width), client.cursor.col]];
        for (let n = 0; n < redraws; ++n) {
            client.clear();
            v.redraw();
            v._repositionCursor();
            views.push([client.shown(3, 5, width), client.cursor.col]);
        }
        return views;
    }

    it('wide characters at the left edge: a redraw draws what typing drew', function () {
        //  a field without an itemFormat, as master draws it
        const plain = redrawsAfter(6, [...'中a中b中c中d'], { plain: true });
        assert.deepEqual(plain, [
            ['中c中d', 11],
            ['中c中d', 11],
            ['中c中d', 11],
        ]);
        //  with one: End (the live write's offset) and a redraw agree
        const live = redrawsAfter(4, [...'72||中中10', '<end>']);
        assert.deepEqual(live, [
            ['中10', 9],
            ['中10', 9],
            ['中10', 9],
        ]);
    });

    it('a scroll offset never leaves a wide character half in view, or the cursor out', function () {
        //  a stale shown code (|00) and a wide character at the left edge
        const { v, client } = makeEtv(8);
        const lastCol = 5 + 8; //  just after the field, where the end of the text puts it
        const keys = ['2', '<tick>', '<home>', ...'中||002|0|2'];
        for (const k of keys) {
            press(v, [k]);
            assert.ok(
                client.cursor.col >= 5 && client.cursor.col <= lastCol,
                `cursor at ${client.cursor.col} after ${JSON.stringify(k)}`
            );
        }
        assert.deepEqual(
            [v.lineBuffer.lines[0].chars, client.shown(3, 5, 8), client.cursor.col],
            ['中||002|0|22', '||002|0 ', 12]
        );
    });
});
