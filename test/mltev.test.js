'use strict';

//  Note: ../core/config.js is patched in test/setup.js (Mocha --require).

const { strict: assert } = require('assert');

const { MultiLineEditTextView } = require('../core/multi_line_edit_text_view.js');

// ─── Test helpers ─────────────────────────────────────────────────────────────

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

//  Creates a view with a real LineBuffer but no-op terminal writes.
//  scrollMode 'top' is used by default so the cursor starts at (0,0).
function makeMltev({ width = 20, height = 5 } = {}) {
    return new MultiLineEditTextView({
        client: makeClient(),
        dimens: { width, height },
    });
}

//  Load text and position cursor explicitly.
function load(view, text, row = 0, col = 0, topVisibleIndex = 0) {
    view.setText(text, { scrollMode: 'top' });
    view.topVisibleIndex = topVisibleIndex;
    view.cursorPos = { row, col };
}

// ─── keyPressBackspace at col 0 ───────────────────────────────────────────────

describe('MultiLineEditTextView — keyPressBackspace at col 0', () => {
    it('is a no-op when cursor is at the very first line of the buffer', () => {
        const v = makeMltev();
        load(v, 'hello\nworld');
        const before = v.buffer.lines.length;

        v.keyPressBackspace();

        assert.strictEqual(v.buffer.lines.length, before, 'line count unchanged');
        assert.strictEqual(v.cursorPos.row, 0);
        assert.strictEqual(v.cursorPos.col, 0);
    });

    it('joins the current line onto the end of the previous line', () => {
        const v = makeMltev();
        load(v, 'hello\nworld', 1, 0); // cursor at line 1 col 0

        v.keyPressBackspace();

        assert.strictEqual(v.buffer.lines.length, 1, 'two lines collapsed to one');
        assert.strictEqual(v.buffer.lines[0].chars, 'helloworld');
    });

    it('lands the cursor at the column equal to the previous line length', () => {
        const v = makeMltev();
        load(v, 'hello\nworld', 1, 0);

        v.keyPressBackspace();

        assert.strictEqual(v.cursorPos.col, 5, 'cursor at end of "hello"');
        assert.strictEqual(v.cursorPos.row, 0, 'cursor moved up one row');
    });

    it('does not merge across a hard-break boundary it did not start on', () => {
        //  Three separate hard-break lines.  Backspace at start of line 1 joins
        //  line 0 + line 1 only; line 2 stays independent.
        const v = makeMltev();
        load(v, 'foo\nbar\nbaz', 1, 0);

        v.keyPressBackspace();

        assert.strictEqual(v.buffer.lines.length, 2, 'three lines → two');
        assert.strictEqual(v.buffer.lines[0].chars, 'foobar');
        assert.strictEqual(v.buffer.lines[1].chars, 'baz');
    });

    it('rewraps when the joined line exceeds view width', () => {
        //  Use a narrow view (width=8) so a join triggers rewrap.
        //  "abcdefg" (7) + "hijklmn" (7) → "abcdefg hijklmn" which wraps at 8.
        const v = makeMltev({ width: 8, height: 5 });
        load(v, 'abcdefg\nhijklmn', 1, 0);

        v.keyPressBackspace();

        //  After join + rewrap the paragraph has > 1 line but the text
        //  roundtrips correctly.
        const text = v.buffer.lines.map(l => l.chars).join('');
        assert.ok(text.includes('abcdefg'), 'first word preserved');
        assert.ok(text.includes('hijklmn'), 'second word preserved');
    });

    it('scrolls the document when the target line is above the visible window', () => {
        //  height=2: can only show 2 lines at once.
        //  Simulate having scrolled down by 1 (topVisibleIndex=1).
        //  Cursor is on visible row 0 → actual buffer index = 1 (= "line1").
        //  Backspace joins "line0" + "line1" and must scroll back up.
        const v = makeMltev({ width: 20, height: 2 });
        load(v, 'line0\nline1\nline2', 0, 0, /* topVisibleIndex= */ 1);

        v.keyPressBackspace();

        assert.strictEqual(v.topVisibleIndex, 0, 'scrolled back to show first line');
        assert.strictEqual(v.cursorPos.row, 0);
        assert.strictEqual(v.cursorPos.col, 5, 'cursor at end of "line0"');
    });
});

// ─── keyPressStartOfDocument / keyPressEndOfDocument ──────────────────────────

describe('MultiLineEditTextView — start/end of document', () => {
    it('Ctrl-Home moves cursor to (0,0) and scrolls to top', () => {
        const v = makeMltev({ width: 20, height: 2 });
        load(v, 'line0\nline1\nline2', 1, 3, 1); //  scrolled down one line

        v.keyPressStartOfDocument();

        assert.strictEqual(v.topVisibleIndex, 0);
        assert.strictEqual(v.cursorPos.row, 0);
        assert.strictEqual(v.cursorPos.col, 0);
    });

    it('Ctrl-End moves cursor to end of last line', () => {
        const v = makeMltev({ width: 20, height: 3 });
        load(v, 'foo\nbar\nbaz', 0, 0, 0);

        v.keyPressEndOfDocument();

        const lastLineIndex = v.buffer.lines.length - 1;
        const lastLineLen = v.buffer.lines[lastLineIndex].chars.length;
        assert.strictEqual(v.cursorPos.col, lastLineLen);
    });
});

// ─── keyPressWordLeft / keyPressWordRight ─────────────────────────────────────

describe('MultiLineEditTextView — word navigation', () => {
    it('word-left from inside a word jumps to word start', () => {
        const v = makeMltev();
        load(v, 'hello world', 0, 8); //  cursor at 'o' of 'world'

        v.keyPressWordLeft();

        assert.strictEqual(v.cursorPos.col, 6, 'cursor at start of "world"');
    });

    it('word-left from between words skips spaces then word', () => {
        const v = makeMltev();
        load(v, 'foo  bar', 0, 5); //  cursor in the spaces between words

        v.keyPressWordLeft();

        assert.strictEqual(v.cursorPos.col, 0, 'cursor at start of "foo"');
    });

    it('word-left at col 0 moves to end of previous line', () => {
        const v = makeMltev();
        load(v, 'hello\nworld', 1, 0);

        v.keyPressWordLeft();

        assert.strictEqual(v.cursorPos.row, 0);
        assert.strictEqual(v.cursorPos.col, 0, 'start of "hello" (no spaces to skip)');
    });

    it('word-left at document start is a no-op', () => {
        const v = makeMltev();
        load(v, 'hello', 0, 0);

        v.keyPressWordLeft();

        assert.strictEqual(v.cursorPos.col, 0);
        assert.strictEqual(v.cursorPos.row, 0);
    });

    it('word-right from inside a word jumps to start of next word', () => {
        const v = makeMltev();
        load(v, 'hello world', 0, 2); //  inside 'hello'

        v.keyPressWordRight();

        assert.strictEqual(v.cursorPos.col, 6, 'start of "world"');
    });

    it('word-right at end of line wraps to next line start', () => {
        const v = makeMltev();
        load(v, 'hello\nworld', 0, 5); //  at EOL of line 0

        v.keyPressWordRight();

        assert.strictEqual(v.cursorPos.row, 1);
        assert.strictEqual(v.cursorPos.col, 0);
    });
});

// ─── keyPressDeleteWordLeft / keyPressDeleteWordRight ────────────────────────

describe('MultiLineEditTextView — delete word', () => {
    it('Ctrl-W deletes from cursor to start of current word', () => {
        const v = makeMltev();
        load(v, 'hello world', 0, 11); //  cursor at EOL

        v.keyPressDeleteWordLeft();

        assert.strictEqual(v.buffer.lines[0].chars, 'hello ');
        assert.strictEqual(v.cursorPos.col, 6);
    });

    it('Ctrl-W with cursor in middle of word deletes back to word start', () => {
        const v = makeMltev();
        load(v, 'hello world', 0, 9); //  cursor at index 9 ('l'); word starts at 6

        v.keyPressDeleteWordLeft();

        //  'wor' (indices 6-8) deleted; remaining: 'hello ld'
        assert.strictEqual(v.buffer.lines[0].chars, 'hello ld');
    });

    it('Ctrl-W at col 0 is a no-op', () => {
        const v = makeMltev();
        load(v, 'hello', 0, 0);

        v.keyPressDeleteWordLeft();

        assert.strictEqual(v.buffer.lines[0].chars, 'hello');
    });

    it('Ctrl-T deletes from cursor to start of next word', () => {
        const v = makeMltev();
        load(v, 'hello world', 0, 0); //  cursor at start

        v.keyPressDeleteWordRight();

        //  Deletes 'hello' + trailing space → 'world' remains
        assert.strictEqual(v.buffer.lines[0].chars, 'world');
    });

    it('Ctrl-T at EOL is a no-op', () => {
        const v = makeMltev();
        load(v, 'hello', 0, 5);

        v.keyPressDeleteWordRight();

        assert.strictEqual(v.buffer.lines[0].chars, 'hello');
    });
});

// ─── keyPressCutLine / keyPressPaste ─────────────────────────────────────────

describe('MultiLineEditTextView — cut/paste (Ctrl-K / Ctrl-U)', () => {
    it('Ctrl-K removes the current line and stores it in cutBuffer', () => {
        const v = makeMltev();
        load(v, 'foo\nbar\nbaz', 0, 0);

        v.keyPressCutLine();

        assert.strictEqual(v.cutBuffer, 'foo');
        assert.strictEqual(v.buffer.lines.length, 2);
    });

    it('sequential Ctrl-K presses accumulate lines', () => {
        const v = makeMltev();
        load(v, 'foo\nbar\nbaz', 0, 0);

        v.keyPressCutLine();
        v._lastWasCut = true; //  simulate sequential press
        v.keyPressCutLine();

        assert.strictEqual(v.cutBuffer, 'foo\nbar');
    });

    it('Ctrl-U pastes cutBuffer at cursor position', () => {
        const v = makeMltev({ width: 40 });
        load(v, 'hello\nworld', 1, 0);
        v.cutBuffer = 'inserted';

        v.keyPressPaste();

        assert.ok(v.buffer.lines.some(l => l.chars.includes('inserted')));
    });

    it('Ctrl-U is a no-op with empty cutBuffer', () => {
        const v = makeMltev();
        load(v, 'hello', 0, 0);
        v.cutBuffer = '';
        const linesBefore = v.buffer.lines.length;

        v.keyPressPaste();

        assert.strictEqual(v.buffer.lines.length, linesBefore);
    });
});

// ─── Live pipe code editing ───────────────────────────────────────────────────

describe('MultiLineEditTextView — live pipe codes', () => {
    it('_hasPipeCodes detects |## and ignores non-numeric |XX', () => {
        const v = makeMltev();
        assert.ok(v._hasPipeCodes('|04Hello'));
        assert.ok(v._hasPipeCodes('Hello |14 world'));
        assert.ok(!v._hasPipeCodes('Hello world'));
        assert.ok(!v._hasPipeCodes('|TL1'));      //  MCI code — not a color code
        assert.ok(!v._hasPipeCodes('| |'));       //  no digits
    });

    it('_renderLineForDisplay replaces |## with ANSI SGR and leaves other text', () => {
        const v = makeMltev();
        const result = v._renderLineForDisplay('Hello |04World');
        //  Pipe code must be gone; text must survive; result must contain ESC
        assert.ok(!result.includes('|04'), 'pipe code stripped from render');
        assert.ok(result.includes('Hello'), 'leading text preserved');
        assert.ok(result.includes('World'), 'trailing text preserved');
        assert.ok(result.includes('\x1b['), 'ANSI escape present');
    });

    it('_renderLineForDisplay leaves non-numeric |XX sequences as literals', () => {
        const v = makeMltev();
        const result = v._renderLineForDisplay('|TL1 some text');
        assert.ok(result.includes('|TL1'), 'MCI-style code passed through literally');
    });

    it('_bufferToDisplayCol returns buffer col unchanged when no pipe codes', () => {
        const v = makeMltev();
        load(v, 'Hello world');
        assert.strictEqual(v._bufferToDisplayCol(0, 5), 5);
        assert.strictEqual(v._bufferToDisplayCol(0, 0), 0);
    });

    it('_bufferToDisplayCol skips complete pipe codes (0 display width)', () => {
        const v = makeMltev();
        load(v, '|04Hello');
        //  Buffer cols 0–2 are the pipe code (|, 0, 4); display col 0
        assert.strictEqual(v._bufferToDisplayCol(0, 0), 0);
        assert.strictEqual(v._bufferToDisplayCol(0, 3), 0, 'after pipe code → display col 0');
        assert.strictEqual(v._bufferToDisplayCol(0, 4), 1, 'H at display col 1');
        assert.strictEqual(v._bufferToDisplayCol(0, 8), 5, 'end of Hello at display col 5');
    });

    it('_bufferToDisplayCol handles two pipe codes on one line', () => {
        const v = makeMltev();
        load(v, '|04Hi|07 there');
        //  |04 at 0–2, H=3 I=4, |07 at 5–7, space=8 …
        assert.strictEqual(v._bufferToDisplayCol(0, 3), 0, 'H at display 0');
        assert.strictEqual(v._bufferToDisplayCol(0, 5), 2, 'after Hi at display 2');
        assert.strictEqual(v._bufferToDisplayCol(0, 8), 2, 'after second pipe code at display 2');
        assert.strictEqual(v._bufferToDisplayCol(0, 9), 3, 'space at display 3');
    });

    it('keyPressRight skips a pipe code without terminal cursor movement (bufferCol+3)', () => {
        const v = makeMltev();
        load(v, '|04Hello', 0, 0);   //  cursor at buffer col 0 — start of pipe code

        v.keyPressRight();

        assert.strictEqual(v.cursorPos.col, 3, 'jumped over all 3 pipe code chars');
    });

    it('keyPressLeft skips back over a pipe code without terminal cursor movement (bufferCol-3)', () => {
        const v = makeMltev();
        load(v, '|04Hello', 0, 3);   //  cursor at buffer col 3 — just after pipe code

        v.keyPressLeft();

        assert.strictEqual(v.cursorPos.col, 0, 'jumped back over all 3 pipe code chars');
    });

    it('keyPressRight does NOT skip a partial pipe sequence (only | typed so far)', () => {
        const v = makeMltev();
        load(v, '|Hello', 0, 0);     //  | followed by letters — not a valid pipe code

        v.keyPressRight();

        assert.strictEqual(v.cursorPos.col, 1, 'moved one buffer col normally');
    });

    it('getData() returns raw pipe codes — round-trips unchanged', () => {
        const v = makeMltev({ width: 40 });
        const original = '|04Hello |07world';
        load(v, original);

        const data = v.getData();

        assert.ok(data.includes('|04Hello'), 'pipe codes preserved in getData');
        assert.ok(data.includes('|07world'));
    });
});
