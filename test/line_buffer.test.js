'use strict';

const { strict: assert } = require('assert');

const {
    LineBuffer,
    ColorSource,
    makeAttr,
    parseAttr,
    getFg,
    getBg,
    getColorSrc,
    u32Insert,
    u32Delete,
    u32Concat,
} = require('../core/line_buffer.js');

// ─── Attribute helpers ──────────────────────────────────────────────────────

describe('makeAttr / parseAttr', () => {
    it('round-trips default attr (all zeros except fg=7)', () => {
        const attr   = makeAttr();
        const parsed = parseAttr(attr);
        assert.equal(parsed.fg,            7);
        assert.equal(parsed.bg,            0);
        assert.equal(parsed.bold,          false);
        assert.equal(parsed.blink,         false);
        assert.equal(parsed.underline,     false);
        assert.equal(parsed.italic,        false);
        assert.equal(parsed.strikethrough, false);
        assert.equal(parsed.colorSrc,      ColorSource.DEFAULT);
        assert.equal(parsed.tcFg,          false);
        assert.equal(parsed.tcBg,          false);
    });

    it('round-trips all attribute flags set', () => {
        const attr = makeAttr({
            fg: 255, bg: 128,
            bold: true, blink: true, underline: true,
            italic: true, strikethrough: true,
            colorSrc: ColorSource.PIPE,
            tcFg: true, tcBg: true,
        });
        const p = parseAttr(attr);
        assert.equal(p.fg,            255);
        assert.equal(p.bg,            128);
        assert.equal(p.bold,          true);
        assert.equal(p.blink,         true);
        assert.equal(p.underline,     true);
        assert.equal(p.italic,        true);
        assert.equal(p.strikethrough, true);
        assert.equal(p.colorSrc,      ColorSource.PIPE);
        assert.equal(p.tcFg,          true);
        assert.equal(p.tcBg,          true);
    });

    it('round-trips fg=255 (exercises unsigned 32-bit handling)', () => {
        const attr = makeAttr({ fg: 255, bg: 0 });
        assert.equal(getFg(attr), 255);
        assert.equal(getBg(attr), 0);
    });

    it('round-trips bg=255', () => {
        const attr = makeAttr({ fg: 0, bg: 255 });
        assert.equal(getFg(attr), 0);
        assert.equal(getBg(attr), 255);
    });

    it('getFg / getBg / getColorSrc are consistent with parseAttr', () => {
        const attr = makeAttr({ fg: 42, bg: 13, colorSrc: ColorSource.ANSI });
        assert.equal(getFg(attr),       42);
        assert.equal(getBg(attr),       13);
        assert.equal(getColorSrc(attr), ColorSource.ANSI);
    });

    it('ColorSource.TRUECOLOR (7) round-trips through 3-bit field', () => {
        const attr = makeAttr({ colorSrc: ColorSource.TRUECOLOR });
        assert.equal(getColorSrc(attr), ColorSource.TRUECOLOR);
    });

    it('makeAttr returns an unsigned 32-bit number', () => {
        const attr = makeAttr({ fg: 255, bg: 255, bold: true, blink: true,
                                underline: true, italic: true, strikethrough: true,
                                colorSrc: 7, tcFg: true, tcBg: true });
        assert.ok(attr >= 0, 'attr must not be negative');
        assert.ok(attr <= 0xFFFFFFFF, 'attr must fit in 32 bits');
    });
});

// ─── Uint32Array helpers ────────────────────────────────────────────────────

describe('u32Insert / u32Delete / u32Concat', () => {
    it('u32Insert prepends', () => {
        const arr = new Uint32Array([10, 20, 30]);
        const out = u32Insert(arr, 0, 99);
        assert.deepEqual([...out], [99, 10, 20, 30]);
    });

    it('u32Insert appends', () => {
        const arr = new Uint32Array([10, 20, 30]);
        const out = u32Insert(arr, 3, 99);
        assert.deepEqual([...out], [10, 20, 30, 99]);
    });

    it('u32Insert into middle', () => {
        const arr = new Uint32Array([10, 20, 30]);
        const out = u32Insert(arr, 1, 99);
        assert.deepEqual([...out], [10, 99, 20, 30]);
    });

    it('u32Insert into empty array', () => {
        const out = u32Insert(new Uint32Array(0), 0, 42);
        assert.deepEqual([...out], [42]);
    });

    it('u32Delete from start', () => {
        const arr = new Uint32Array([10, 20, 30]);
        const out = u32Delete(arr, 0);
        assert.deepEqual([...out], [20, 30]);
    });

    it('u32Delete from end', () => {
        const arr = new Uint32Array([10, 20, 30]);
        const out = u32Delete(arr, 2);
        assert.deepEqual([...out], [10, 20]);
    });

    it('u32Delete from middle', () => {
        const arr = new Uint32Array([10, 20, 30]);
        const out = u32Delete(arr, 1);
        assert.deepEqual([...out], [10, 30]);
    });

    it('u32Concat two non-empty arrays', () => {
        const a   = new Uint32Array([1, 2]);
        const b   = new Uint32Array([3, 4]);
        const out = u32Concat(a, b);
        assert.deepEqual([...out], [1, 2, 3, 4]);
    });

    it('u32Concat with empty left', () => {
        const out = u32Concat(new Uint32Array(0), new Uint32Array([5, 6]));
        assert.deepEqual([...out], [5, 6]);
    });

    it('u32Concat with empty right', () => {
        const out = u32Concat(new Uint32Array([7, 8]), new Uint32Array(0));
        assert.deepEqual([...out], [7, 8]);
    });
});

// ─── LineBuffer construction ─────────────────────────────────────────────────

describe('LineBuffer', () => {
    describe('constructor', () => {
        it('starts with one empty hard-break line', () => {
            const buf = new LineBuffer({ width: 40 });
            assert.equal(buf.lines.length, 1);
            assert.equal(buf.lines[0].chars, '');
            assert.equal(buf.lines[0].eol,   true);
        });

        it('defaults width to 79', () => {
            const buf = new LineBuffer();
            assert.equal(buf.width, 79);
        });
    });

    // ─── insertChar ──────────────────────────────────────────────────────────

    describe('insertChar', () => {
        it('inserts a character at col 0 of an empty line', () => {
            const buf = new LineBuffer({ width: 40 });
            buf.insertChar(0, 0, 'X', 0);
            assert.equal(buf.lines[0].chars, 'X');
            assert.equal(buf.lines[0].attrs.length, 1);
            assert.equal(buf.lines[0].attrs[0], 0);
        });

        it('inserts in the middle of a line', () => {
            const buf = new LineBuffer({ width: 40 });
            buf.lines[0].chars = 'ac';
            buf.lines[0].attrs = new Uint32Array([1, 3]);
            buf.insertChar(0, 1, 'b', 2);
            assert.equal(buf.lines[0].chars, 'abc');
            assert.deepEqual([...buf.lines[0].attrs], [1, 2, 3]);
        });

        it('appends a character at end of line', () => {
            const buf = new LineBuffer({ width: 40 });
            buf.lines[0].chars = 'ab';
            buf.lines[0].attrs = new Uint32Array([0, 0]);
            buf.insertChar(0, 2, 'c', 9);
            assert.equal(buf.lines[0].chars, 'abc');
            assert.equal(buf.lines[0].attrs[2], 9);
        });

        it('does not touch other lines', () => {
            const buf = new LineBuffer({ width: 40 });
            buf.lines.push({ chars: 'second', attrs: new Uint32Array(6), eol: true, initialAttr: 0 });
            buf.insertChar(0, 0, 'X', 0);
            assert.equal(buf.lines[1].chars, 'second');
        });
    });

    // ─── deleteChar ──────────────────────────────────────────────────────────

    describe('deleteChar', () => {
        it('deletes the only character in a line', () => {
            const buf = new LineBuffer({ width: 40 });
            buf.lines[0].chars = 'X';
            buf.lines[0].attrs = new Uint32Array([5]);
            buf.deleteChar(0, 0);
            assert.equal(buf.lines[0].chars, '');
            assert.equal(buf.lines[0].attrs.length, 0);
        });

        it('deletes a character from the middle', () => {
            const buf = new LineBuffer({ width: 40 });
            buf.lines[0].chars = 'abc';
            buf.lines[0].attrs = new Uint32Array([1, 2, 3]);
            buf.deleteChar(0, 1);
            assert.equal(buf.lines[0].chars, 'ac');
            assert.deepEqual([...buf.lines[0].attrs], [1, 3]);
        });

        it('deletes the last character', () => {
            const buf = new LineBuffer({ width: 40 });
            buf.lines[0].chars = 'ab';
            buf.lines[0].attrs = new Uint32Array([1, 2]);
            buf.deleteChar(0, 1);
            assert.equal(buf.lines[0].chars, 'a');
            assert.deepEqual([...buf.lines[0].attrs], [1]);
        });
    });

    // ─── splitLine ───────────────────────────────────────────────────────────

    describe('splitLine', () => {
        it('splits at col 0 (Enter at start of line)', () => {
            const buf = new LineBuffer({ width: 40 });
            buf.lines[0].chars = 'hello';
            buf.lines[0].attrs = new Uint32Array([1, 2, 3, 4, 5]);
            buf.lines[0].eol   = true;
            buf.splitLine(0, 0);

            assert.equal(buf.lines.length, 2);
            assert.equal(buf.lines[0].chars, '');
            assert.equal(buf.lines[0].eol,   true);
            assert.equal(buf.lines[1].chars, 'hello');
            assert.equal(buf.lines[1].eol,   true);
        });

        it('splits at end of line (Enter at end)', () => {
            const buf = new LineBuffer({ width: 40 });
            buf.lines[0].chars = 'hello';
            buf.lines[0].attrs = new Uint32Array([1, 2, 3, 4, 5]);
            buf.lines[0].eol   = true;
            buf.splitLine(0, 5);

            assert.equal(buf.lines.length, 2);
            assert.equal(buf.lines[0].chars, 'hello');
            assert.equal(buf.lines[0].eol,   true);
            assert.equal(buf.lines[1].chars, '');
            assert.equal(buf.lines[1].eol,   true);
        });

        it('splits in the middle', () => {
            const buf = new LineBuffer({ width: 40 });
            buf.lines[0].chars = 'hello world';
            buf.lines[0].attrs = new Uint32Array(11).fill(7);
            buf.lines[0].eol   = true;
            buf.splitLine(0, 5);

            assert.equal(buf.lines.length, 2);
            assert.equal(buf.lines[0].chars, 'hello');
            assert.equal(buf.lines[0].eol,   true);
            assert.equal(buf.lines[1].chars, ' world');
            assert.equal(buf.lines[1].eol,   true);
        });

        it('left line eol becomes true (hard break)', () => {
            const buf = new LineBuffer({ width: 40 });
            buf.lines[0].chars = 'ab';
            buf.lines[0].attrs = new Uint32Array(2);
            buf.lines[0].eol   = false; // was a soft-wrap line
            buf.splitLine(0, 1);

            assert.equal(buf.lines[0].eol, true, 'split left must be hard break');
        });

        it('right line inherits original eol', () => {
            const buf = new LineBuffer({ width: 40 });
            buf.lines[0].chars = 'ab';
            buf.lines[0].attrs = new Uint32Array(2);
            buf.lines[0].eol   = false; // soft wrap
            buf.splitLine(0, 1);

            assert.equal(buf.lines[1].eol, false, 'right half inherits original eol');
        });

        it('attrs are split correctly', () => {
            const buf = new LineBuffer({ width: 40 });
            buf.lines[0].chars = 'abcd';
            buf.lines[0].attrs = new Uint32Array([10, 20, 30, 40]);
            buf.lines[0].eol   = true;
            buf.splitLine(0, 2);

            assert.deepEqual([...buf.lines[0].attrs], [10, 20]);
            assert.deepEqual([...buf.lines[1].attrs], [30, 40]);
        });
    });

    // ─── joinLines ───────────────────────────────────────────────────────────

    describe('joinLines', () => {
        it('joins two lines', () => {
            const buf = new LineBuffer({ width: 40 });
            buf.lines[0] = { chars: 'hello', attrs: new Uint32Array([1,2,3,4,5]), eol: true, initialAttr: 0 };
            buf.lines.push({ chars: ' world', attrs: new Uint32Array([6,7,8,9,10,11]), eol: true, initialAttr: 0 });

            buf.joinLines(0);

            assert.equal(buf.lines.length, 1);
            assert.equal(buf.lines[0].chars, 'hello world');
            assert.deepEqual([...buf.lines[0].attrs], [1,2,3,4,5,6,7,8,9,10,11]);
        });

        it('joined line inherits eol of the second line', () => {
            const buf = new LineBuffer({ width: 40 });
            buf.lines[0] = { chars: 'a', attrs: new Uint32Array(1), eol: true,  initialAttr: 0 };
            buf.lines.push({ chars: 'b', attrs: new Uint32Array(1), eol: false, initialAttr: 0 });

            buf.joinLines(0);

            assert.equal(buf.lines[0].eol, false);
        });

        it('is a no-op on the last line', () => {
            const buf = new LineBuffer({ width: 40 });
            buf.lines[0].chars = 'only';
            buf.joinLines(0);
            assert.equal(buf.lines.length, 1);
            assert.equal(buf.lines[0].chars, 'only');
        });
    });

    // ─── _paragraphRange ─────────────────────────────────────────────────────

    describe('_paragraphRange', () => {
        //  Buffer: [A(soft), B(soft), C(hard)] | [D(soft), E(hard)]
        function makeBuf() {
            const buf = new LineBuffer({ width: 40 });
            buf.lines = [
                { chars: 'A', attrs: new Uint32Array(1), eol: false, initialAttr: 0 },
                { chars: 'B', attrs: new Uint32Array(1), eol: false, initialAttr: 0 },
                { chars: 'C', attrs: new Uint32Array(1), eol: true,  initialAttr: 0 },
                { chars: 'D', attrs: new Uint32Array(1), eol: false, initialAttr: 0 },
                { chars: 'E', attrs: new Uint32Array(1), eol: true,  initialAttr: 0 },
            ];
            return buf;
        }

        it('finds range from first line of paragraph 1', () => {
            const r = makeBuf()._paragraphRange(0);
            assert.deepEqual(r, { start: 0, end: 2 });
        });

        it('finds range from middle of paragraph 1', () => {
            const r = makeBuf()._paragraphRange(1);
            assert.deepEqual(r, { start: 0, end: 2 });
        });

        it('finds range from last line of paragraph 1', () => {
            const r = makeBuf()._paragraphRange(2);
            assert.deepEqual(r, { start: 0, end: 2 });
        });

        it('finds range from first line of paragraph 2', () => {
            const r = makeBuf()._paragraphRange(3);
            assert.deepEqual(r, { start: 3, end: 4 });
        });

        it('finds range from last line of paragraph 2', () => {
            const r = makeBuf()._paragraphRange(4);
            assert.deepEqual(r, { start: 3, end: 4 });
        });

        it('single-line buffer', () => {
            const buf = new LineBuffer({ width: 40 });
            const r   = buf._paragraphRange(0);
            assert.deepEqual(r, { start: 0, end: 0 });
        });
    });

    // ─── rewrapParagraph ─────────────────────────────────────────────────────

    describe('rewrapParagraph', () => {
        it('wraps a long single-line paragraph at word boundary', () => {
            const buf = new LineBuffer({ width: 10 });
            buf.lines[0] = {
                chars: 'hello world',   // 11 chars, needs to wrap at 10
                attrs: new Uint32Array(11),
                eol:   true,
                initialAttr: 0,
            };

            const range = buf.rewrapParagraph(0);

            assert.equal(buf.lines.length, 2);
            assert.equal(buf.lines[0].chars, 'hello');
            assert.equal(buf.lines[0].eol,   false);
            assert.equal(buf.lines[1].chars, 'world');
            assert.equal(buf.lines[1].eol,   true);
            assert.deepEqual(range, { start: 0, end: 1 });
        });

        it('rejoins and re-wraps two soft-wrapped lines', () => {
            const buf = new LineBuffer({ width: 10 });
            buf.lines = [
                { chars: 'hello', attrs: new Uint32Array(5), eol: false, initialAttr: 0 },
                { chars: 'world', attrs: new Uint32Array(5), eol: true,  initialAttr: 0 },
            ];
            //  With width=10, 'hello world' (11 chars) fits on one line if width
            //  is 11, but with width=10 it should stay as two lines.
            buf.rewrapParagraph(0);

            assert.equal(buf.lines.length, 2);
            assert.equal(buf.lines[0].chars, 'hello');
            assert.equal(buf.lines[0].eol,   false);
            assert.equal(buf.lines[1].chars, 'world');
            assert.equal(buf.lines[1].eol,   true);
        });

        it('rejoins into one line when width allows', () => {
            const buf = new LineBuffer({ width: 20 });
            buf.lines = [
                { chars: 'hello', attrs: new Uint32Array(5), eol: false, initialAttr: 0 },
                { chars: 'world', attrs: new Uint32Array(5), eol: true,  initialAttr: 0 },
            ];
            buf.rewrapParagraph(0);

            assert.equal(buf.lines.length, 1);
            assert.equal(buf.lines[0].chars, 'hello world');
            assert.equal(buf.lines[0].eol,   true);
        });

        it('does not merge across hard-break boundaries (paragraph isolation)', () => {
            //  Two hard-break lines: 'short' and 'also short'
            const buf = new LineBuffer({ width: 40 });
            buf.lines = [
                { chars: 'short',      attrs: new Uint32Array(5),  eol: true, initialAttr: 0 },
                { chars: 'also short', attrs: new Uint32Array(10), eol: true, initialAttr: 0 },
            ];
            buf.rewrapParagraph(0);

            assert.equal(buf.lines.length, 2);
            assert.equal(buf.lines[0].chars, 'short');
            assert.equal(buf.lines[1].chars, 'also short');
        });

        it('wraps multi-word line splitting across 3+ lines', () => {
            //  width=5: 'one two three' → ['one', 'two', 'three']
            const buf = new LineBuffer({ width: 5 });
            buf.lines[0] = {
                chars: 'one two three',
                attrs: new Uint32Array(13),
                eol:   true,
                initialAttr: 0,
            };
            buf.rewrapParagraph(0);

            assert.equal(buf.lines.length, 3);
            assert.equal(buf.lines[0].chars, 'one');
            assert.equal(buf.lines[1].chars, 'two');
            assert.equal(buf.lines[2].chars, 'three');
            assert.equal(buf.lines[2].eol,   true);
            assert.equal(buf.lines[0].eol,   false);
            assert.equal(buf.lines[1].eol,   false);
        });

        it('hard-breaks a word that exceeds width (no spaces)', () => {
            const buf = new LineBuffer({ width: 4 });
            buf.lines[0] = {
                chars: 'abcdefgh',
                attrs: new Uint32Array(8),
                eol:   true,
                initialAttr: 0,
            };
            buf.rewrapParagraph(0);

            //  'abcd', 'efgh'
            assert.equal(buf.lines.length, 2);
            assert.equal(buf.lines[0].chars, 'abcd');
            assert.equal(buf.lines[1].chars, 'efgh');
        });
    });

    // ─── setText / getText ────────────────────────────────────────────────────

    describe('setText / getText', () => {
        it('round-trips empty string', () => {
            const buf = new LineBuffer({ width: 40 });
            buf.setText('');
            assert.equal(buf.getText(), '');
            assert.equal(buf.lines.length, 1);
            assert.equal(buf.lines[0].eol, true);
        });

        it('round-trips a short single line', () => {
            const buf = new LineBuffer({ width: 40 });
            buf.setText('hello');
            assert.equal(buf.getText(), 'hello');
        });

        it('round-trips two hard-break lines', () => {
            const buf = new LineBuffer({ width: 40 });
            buf.setText('hello\nworld');
            assert.equal(buf.getText(), 'hello\nworld');
        });

        it('preserves empty lines from double \\n', () => {
            const buf = new LineBuffer({ width: 40 });
            buf.setText('hello\n\nworld');
            assert.equal(buf.getText(), 'hello\n\nworld');
        });

        it('wraps a line that exceeds width', () => {
            const buf = new LineBuffer({ width: 10 });
            buf.setText('hello world');
            //  Should wrap to two lines
            assert.equal(buf.lines.length, 2);
            assert.equal(buf.lines[0].chars, 'hello');
            assert.equal(buf.lines[0].eol,   false);
            assert.equal(buf.lines[1].chars, 'world');
            assert.equal(buf.lines[1].eol,   true);
            //  getText must reconstruct with a space
            assert.equal(buf.getText(), 'hello world');
        });

        it('hard-wrap then getText restores multi-line text', () => {
            const buf = new LineBuffer({ width: 10 });
            buf.setText('line one is long\nshort\nline two is also long');
            assert.equal(buf.getText(), 'line one is long\nshort\nline two is also long');
        });

        it('setText replaces previous content', () => {
            const buf = new LineBuffer({ width: 40 });
            buf.setText('first');
            buf.setText('second');
            assert.equal(buf.getText(), 'second');
            assert.equal(buf.lines.length, 1);
        });

        it('all attrs are zero after setText (plain text)', () => {
            const buf = new LineBuffer({ width: 40 });
            buf.setText('hello');
            for (const line of buf.lines) {
                for (const attr of line.attrs) {
                    assert.equal(attr, 0);
                }
            }
        });
    });

    // ─── setWidth ────────────────────────────────────────────────────────────

    describe('setWidth', () => {
        it('re-wraps a paragraph when width decreases', () => {
            const buf = new LineBuffer({ width: 40 });
            buf.setText('hello world');
            assert.equal(buf.lines.length, 1);

            buf.setWidth(10);
            assert.equal(buf.lines.length, 2);
            assert.equal(buf.lines[0].chars, 'hello');
            assert.equal(buf.lines[1].chars, 'world');
        });

        it('merges lines when width increases', () => {
            const buf = new LineBuffer({ width: 5 });
            buf.setText('hello world');
            assert.equal(buf.lines.length, 2);

            buf.setWidth(40);
            assert.equal(buf.lines.length, 1);
            assert.equal(buf.lines[0].chars, 'hello world');
        });

        it('re-wraps all paragraphs independently', () => {
            const buf = new LineBuffer({ width: 40 });
            //  Use words that fit within width=8 so no character-breaks occur
            buf.setText('first line\nsecond line');

            buf.setWidth(8);

            //  Both paragraphs must have been re-wrapped; getText must reconstruct
            const text = buf.getText();
            assert.equal(text, 'first line\nsecond line');
        });

        it('updates this.width', () => {
            const buf = new LineBuffer({ width: 40 });
            buf.setWidth(20);
            assert.equal(buf.width, 20);
        });
    });
});
