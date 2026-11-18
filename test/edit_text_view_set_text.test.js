'use strict';

//
//  An edit field given text with setText() draws, on that first paint, what
//  every later redraw draws: the text as typed, or with an itemFormat the
//  live colour preview. getData() is the text as given (#1034).
//

const { strict: assert } = require('assert');

const { charDisplayWidth } = require('../core/display_width.js');

const ESC = String.fromCharCode(27);
const CSI_RE = new RegExp(`^${ESC}\\[([0-9;?]*)([A-Za-z])`);

//  Enough of a terminal for a few rows: cursor moves and text; the raw
//  writes are kept too, for the colours
function makeClient() {
    const cells = new Map();
    const writes = [];
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
            write: s => {
                writes.push(String(s));
                feed(String(s));
            },
            rawWrite() {},
        },
        //  enough of a user for |UN and {UN} to resolve, as they do on master
        user: {
            username: 'Bryan',
            properties: {},
            getProperty: () => undefined,
        },
        log: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} },
        writes,
        cursor,
        //  what row |row| shows from |col|, |n| columns
        shown(row, col, n) {
            let out = '';
            for (let c = col; c < col + n; ++c) {
                out += cells.get(`${row},${c}`) || '';
            }
            return out;
        },
        clear() {
            cells.clear();
            writes.length = 0;
        },
    };
}

const ROW = 3;
const COL = 5;

describe('EditTextView setText(): first paint and repaint agree', function () {
    let EditTextView;
    let MaskEditTextView;
    let MenuModule;

    before(function () {
        ({ EditTextView } = require('../core/edit_text_view.js'));
        ({ MaskEditTextView } = require('../core/mask_edit_text_view.js'));
        ({ MenuModule } = require('../core/menu_module.js'));
    });

    function makeEtv({ width = 20, itemFormat, maxLength } = {}) {
        const client = makeClient();
        const v = new EditTextView({
            client,
            id: 1,
            position: { row: ROW, col: COL },
            dimens: { width, height: 1 },
            maxLength,
        });
        if (itemFormat) {
            v.itemFormat = itemFormat;
        }
        return { v, client };
    }

    //  What the field shows after |fn| draws it
    function paint(v, client, fn) {
        client.clear();
        fn();
        return {
            cells: client.shown(ROW, COL, v.dimens.width),
            sgr: client.writes.join(''),
        };
    }

    //  The first paint, then a redraw, a focus and a blur
    function paints(v, client, text) {
        return [
            paint(v, client, () => v.setText(text, true)),
            paint(v, client, () => v.redraw()),
            paint(v, client, () => v.setFocus(true)),
            paint(v, client, () => v.setFocus(false)),
        ];
    }

    it('without an itemFormat: the codes as typed, every time', function () {
        const { v, client } = makeEtv();
        const seen = paints(v, client, '|04hi there');
        seen.forEach((p, n) =>
            assert.equal(p.cells.trimEnd(), '|04hi there', `paint ${n}`)
        );
        assert.equal(v.getData(), '|04hi there');
    });

    it('with an itemFormat: the colour preview, every time', function () {
        const { v, client } = makeEtv({ itemFormat: '{text}' });
        const seen = paints(v, client, '|04hi there |UN');
        seen.forEach((p, n) => {
            assert.equal(p.cells.trimEnd(), 'hi there |UN', `paint ${n}`);
            assert.match(p.sgr, /\[(?:\d+;)*31m/, `paint ${n} is red`);
        });
        assert.equal(v.getData(), '|04hi there |UN');
    });

    it('MCI codes are the text being edited, not resolved', function () {
        const { v, client } = makeEtv({ width: 30 });
        const seen = paints(v, client, 'hi |UN {UN}');
        seen.forEach((p, n) =>
            assert.equal(p.cells.trimEnd(), 'hi |UN {UN}', `paint ${n}`)
        );
        assert.equal(v.getData(), 'hi |UN {UN}');
    });

    //  The window is worked out from the new text before it is drawn; the
    //  first paint used to show the start while the cursor was at the end.
    //  (Which of two windows a redraw at the end of an overflowing line
    //  settles on is #1060, so the exact cells are not compared here.)
    it('a focused field longer than its width: the first paint shows the end', function () {
        const { v, client } = makeEtv({ width: 10, maxLength: 100 });
        v.setFocus(true);
        const first = paint(v, client, () =>
            v.setText('abcdefghijklmnopqrstuvwxyz', true)
        );
        assert.ok(first.cells.includes('xyz'), first.cells);
        assert.ok(!first.cells.includes('abc'), first.cells);
        assert.equal(v.cursorPos.col, 26);
    });

    it('a new text starts its own scroll window', function () {
        const { v, client } = makeEtv({ width: 10, maxLength: 100 });
        v.setFocus(true);
        v.setText('abcdefghijklmnopqrstuvwxyz', true);
        //  also longer than the field, but shorter than the old window's start
        const first = paint(v, client, () => v.setText('ABCDEFGHIJKL', true));
        assert.ok(first.cells.includes('JKL'), first.cells);
        const short = paint(v, client, () => v.setText('short', true));
        assert.equal(short.cells.trimEnd(), 'short');
    });

    it('line breaks are dropped and maxLength holds, as typing does', function () {
        const { v, client } = makeEtv({ maxLength: 8 });
        const first = paint(v, client, () => v.setText('ab\r\ncd\nefghij'));
        assert.equal(v.getData(), 'abcdefgh');
        assert.equal(first.cells.trimEnd(), 'abcdefgh', 'setText() draws by default');
    });

    it('a focused field: the cursor goes to the edit position, where typing echoes', function () {
        const { v, client } = makeEtv();
        v.setFocus(true);
        v.setText('ab');
        assert.deepEqual(client.cursor, { row: ROW, col: COL + 2 });
        v.onKeyPress('c');
        assert.equal(client.shown(ROW, COL, 3), 'abc');
        assert.equal(v.getData(), 'abc');
    });

    it('setText(text, false) stores the text and writes nothing', function () {
        const { v, client } = makeEtv();
        client.clear();
        v.setText('|04abc', false);
        assert.equal(client.writes.length, 0);
        assert.equal(v.getData(), '|04abc');
        assert.equal(v.text, '|04abc');
    });

    it('a code shown as typed, and its collapse timer, end with the old text', function () {
        const pending = new Map();
        let next = 1;
        const saved = {
            setTimeout: global.setTimeout,
            clearTimeout: global.clearTimeout,
        };
        global.setTimeout = fn => {
            pending.set(next, fn);
            return next++;
        };
        global.clearTimeout = id => pending.delete(id);
        try {
            const { v } = makeEtv({ itemFormat: '{text}' });
            v.setFocus(true);
            for (const ch of 'ab|04x') {
                v.onKeyPress(ch);
            }
            assert.ok(v._pipeExpanded, 'the |04 is shown as typed');
            assert.equal(pending.size, 1, 'and its collapse is pending');

            v.setText('zz', false); //  not drawn: setText() itself ends them
            assert.equal(v._pipeExpanded, false);
            assert.equal(v._pipeTimer, null);
            assert.equal(pending.size, 0);
        } finally {
            global.setTimeout = saved.setTimeout;
            global.clearTimeout = saved.clearTimeout;
        }
    });

    describe('MaskEditTextView', function () {
        function makeMev(maskPattern = '##/##/####') {
            const client = makeClient();
            const v = new MaskEditTextView({
                client,
                id: 2,
                position: { row: ROW, col: COL },
                maskPattern,
            });
            return { v, client };
        }

        it('a value with its literals: the first paint is the redraw', function () {
            const { v, client } = makeMev();
            const first = paint(v, client, () => v.setText('12/34/5678', true));
            const again = paint(v, client, () => v.redraw());
            assert.equal(first.cells, '12/34/5678');
            assert.equal(again.cells, '12/34/5678');
            assert.equal(v.getData(), '12/34/5678');
        });

        it('pipe-coded text draws what it stores, without tripping the mask', function () {
            const { v, client } = makeMev();
            const first = paint(v, client, () => v.setText('|0412/34/5678', true));
            const again = paint(v, client, () => v.redraw());
            assert.equal(first.cells, again.cells);
            assert.equal(v.getData(), '');
        });
    });

    it('a custom view that is an edit field draws the same on every refresh', function () {
        const client = makeClient();
        const v = new EditTextView({
            client,
            id: 10,
            position: { row: ROW, col: COL },
            dimens: { width: 20, height: 1 },
        });
        const mod = Object.create(MenuModule.prototype);
        mod.client = client;
        mod.menuConfig = { config: { mainInfoFormat10: '|04{name}' } };
        mod.viewControllers = {
            main: {
                getView: id => (10 === id ? v : undefined),
                getFocusedView: () => null,
            },
        };
        const first = paint(v, client, () =>
            mod.updateCustomViewTextsWithFilter('main', 10, { name: 'Bob' })
        );
        const second = paint(v, client, () =>
            mod.updateCustomViewTextsWithFilter('main', 10, { name: 'Bob' })
        );
        assert.equal(first.cells, second.cells);
        assert.equal(first.cells.trimEnd(), '|04Bob');
    });
});
