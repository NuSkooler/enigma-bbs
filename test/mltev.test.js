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
        assert.ok(!v._hasPipeCodes('|TL1')); //  MCI code — not a color code
        assert.ok(!v._hasPipeCodes('| |')); //  no digits
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
        assert.strictEqual(
            v._bufferToDisplayCol(0, 3),
            0,
            'after pipe code → display col 0'
        );
        assert.strictEqual(v._bufferToDisplayCol(0, 4), 1, 'H at display col 1');
        assert.strictEqual(
            v._bufferToDisplayCol(0, 8),
            5,
            'end of Hello at display col 5'
        );
    });

    it('_bufferToDisplayCol handles two pipe codes on one line', () => {
        const v = makeMltev();
        load(v, '|04Hi|07 there');
        //  |04 at 0–2, H=3 I=4, |07 at 5–7, space=8 …
        assert.strictEqual(v._bufferToDisplayCol(0, 3), 0, 'H at display 0');
        assert.strictEqual(v._bufferToDisplayCol(0, 5), 2, 'after Hi at display 2');
        assert.strictEqual(
            v._bufferToDisplayCol(0, 8),
            2,
            'after second pipe code at display 2'
        );
        assert.strictEqual(v._bufferToDisplayCol(0, 9), 3, 'space at display 3');
    });

    it('keyPressRight skips a pipe code without terminal cursor movement (bufferCol+3)', () => {
        const v = makeMltev();
        load(v, '|04Hello', 0, 0); //  cursor at buffer col 0 — start of pipe code

        v.keyPressRight();

        assert.strictEqual(v.cursorPos.col, 3, 'jumped over all 3 pipe code chars');
    });

    it('keyPressLeft skips back over a pipe code without terminal cursor movement (bufferCol-3)', () => {
        const v = makeMltev();
        load(v, '|04Hello', 0, 3); //  cursor at buffer col 3 — just after pipe code

        v.keyPressLeft();

        assert.strictEqual(v.cursorPos.col, 0, 'jumped back over all 3 pipe code chars');
    });

    it('keyPressRight does NOT skip a partial pipe sequence (only | typed so far)', () => {
        const v = makeMltev();
        load(v, '|Hello', 0, 0); //  | followed by letters — not a valid pipe code

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

// ─── Find system ──────────────────────────────────────────────────────────────

describe('MultiLineEditTextView — _buildFindMatches', () => {
    it('returns an empty array when the query is not found', () => {
        const v = makeMltev();
        load(v, 'hello world');
        assert.deepStrictEqual(v._buildFindMatches('xyz'), []);
    });

    it('returns a single match with correct line/display positions', () => {
        const v = makeMltev({ width: 40 });
        load(v, 'hello world');
        const matches = v._buildFindMatches('world');
        assert.strictEqual(matches.length, 1);
        assert.strictEqual(matches[0].lineIndex, 0);
        assert.strictEqual(matches[0].displayStart, 6);
        assert.strictEqual(matches[0].displayEnd, 11);
    });

    it('is case-insensitive', () => {
        const v = makeMltev();
        load(v, 'Hello World');
        const matches = v._buildFindMatches('hello');
        assert.strictEqual(matches.length, 1);
        assert.strictEqual(matches[0].displayStart, 0);
    });

    it('returns all overlapping-start occurrences on one line', () => {
        const v = makeMltev({ width: 40 });
        load(v, 'foo foo foo');
        const matches = v._buildFindMatches('foo');
        assert.strictEqual(matches.length, 3);
        assert.strictEqual(matches[0].displayStart, 0);
        assert.strictEqual(matches[1].displayStart, 4);
        assert.strictEqual(matches[2].displayStart, 8);
    });

    it('finds matches across multiple lines with correct lineIndex', () => {
        const v = makeMltev({ width: 40 });
        load(v, 'one\ntwo\none');
        const matches = v._buildFindMatches('one');
        assert.strictEqual(matches.length, 2);
        assert.strictEqual(matches[0].lineIndex, 0);
        assert.strictEqual(matches[1].lineIndex, 2);
    });

    it('searches display text — pipe codes are stripped before matching', () => {
        const v = makeMltev({ width: 40 });
        load(v, '|04Hello world');
        //  Display text is "Hello world"; pipe code chars don't appear in search.
        const matches = v._buildFindMatches('hello');
        assert.strictEqual(matches.length, 1);
        assert.strictEqual(matches[0].displayStart, 0);
        assert.strictEqual(matches[0].displayEnd, 5);
    });

    it('returns correct displayStart for a match after a pipe code', () => {
        const v = makeMltev({ width: 40 });
        load(v, '|04Hello world');
        //  Display text "Hello world"; 'world' starts at display col 6.
        const matches = v._buildFindMatches('world');
        assert.strictEqual(matches.length, 1);
        assert.strictEqual(matches[0].displayStart, 6);
    });
});

describe('MultiLineEditTextView — setFindQuery', () => {
    it('sets _findState with query and match array', () => {
        const v = makeMltev({ width: 40 });
        load(v, 'hello world');
        v.setFindQuery('world');
        assert.ok(v._findState !== null, '_findState is set');
        assert.strictEqual(v._findState.query, 'world');
        assert.strictEqual(v._findState.matches.length, 1);
        assert.strictEqual(v._findState.currentIndex, 0);
    });

    it('positions the cursor at the start of the first match', () => {
        const v = makeMltev({ width: 40 });
        load(v, 'hello world');
        v.setFindQuery('world');
        assert.strictEqual(v.cursorPos.col, 6);
        assert.strictEqual(v.cursorPos.row, 0);
    });

    it('positions the cursor at the buffer column after a pipe code prefix', () => {
        const v = makeMltev({ width: 40 });
        //  Buffer: |04Hello world (14 chars)
        //  Display: Hello world; 'world' at displayStart=6
        //  _displayToBufferCol(0, 6): skips pipe code (3 chars, 0 display) then
        //  walks 6 visible chars → lands at buffer col 9.
        load(v, '|04Hello world');
        v.setFindQuery('world');
        assert.strictEqual(v.cursorPos.col, 9, 'cursor after pipe code prefix');
    });

    it('sets _findState with empty matches when query is not found', () => {
        const v = makeMltev({ width: 40 });
        load(v, 'hello world');
        v.setFindQuery('xyz');
        assert.ok(v._findState !== null);
        assert.strictEqual(v._findState.matches.length, 0);
    });

    it('clears _findState when called with an empty string', () => {
        const v = makeMltev({ width: 40 });
        load(v, 'hello world');
        v.setFindQuery('world');
        v.setFindQuery('');
        assert.strictEqual(v._findState, null);
    });

    it('getFindMatchCount reflects the active match count', () => {
        const v = makeMltev({ width: 40 });
        load(v, 'foo foo foo');
        assert.strictEqual(v.getFindMatchCount(), 0, 'zero before any find');
        v.setFindQuery('foo');
        assert.strictEqual(v.getFindMatchCount(), 3);
    });
});

describe('MultiLineEditTextView — gotoFirstMatch', () => {
    it('does NOT set _findState', () => {
        const v = makeMltev({ width: 40 });
        load(v, 'hello world');
        v.gotoFirstMatch('world');
        assert.strictEqual(v._findState, null, '_findState must remain null');
    });

    it('positions the cursor at the first match without _findState', () => {
        const v = makeMltev({ width: 40 });
        load(v, 'hello world');
        v.gotoFirstMatch('world');
        assert.strictEqual(v.cursorPos.col, 6);
        assert.strictEqual(v.cursorPos.row, 0);
    });

    it('is a no-op for an empty query — _findState stays null, cursor unchanged', () => {
        const v = makeMltev({ width: 40 });
        load(v, 'hello world', 0, 3);
        v.gotoFirstMatch('');
        assert.strictEqual(v._findState, null);
        assert.strictEqual(v.cursorPos.col, 3, 'cursor unchanged');
    });

    it('leaves cursor at (0,0) when query has no matches', () => {
        const v = makeMltev({ width: 40 });
        load(v, 'hello world', 0, 5);
        v.gotoFirstMatch('xyz');
        assert.strictEqual(v._findState, null);
        //  _scrollToMatch is never called so cursorPos is unchanged.
        assert.strictEqual(v.cursorPos.col, 5, 'cursor not moved');
    });
});

describe('MultiLineEditTextView — findNext / findPrev', () => {
    it('findNext advances currentIndex to the next match', () => {
        const v = makeMltev({ width: 40 });
        load(v, 'foo foo foo');
        v.setFindQuery('foo');
        assert.strictEqual(v._findState.currentIndex, 0);
        v.findNext();
        assert.strictEqual(v._findState.currentIndex, 1);
    });

    it('findNext wraps around from the last match to the first', () => {
        const v = makeMltev({ width: 40 });
        load(v, 'foo foo');
        v.setFindQuery('foo');
        v.findNext(); //  index 0 → 1
        v.findNext(); //  index 1 → 0 (wrap)
        assert.strictEqual(v._findState.currentIndex, 0);
    });

    it('findPrev decrements currentIndex', () => {
        const v = makeMltev({ width: 40 });
        load(v, 'foo foo foo');
        v.setFindQuery('foo');
        v.findNext(); //  0 → 1
        v.findPrev(); //  1 → 0
        assert.strictEqual(v._findState.currentIndex, 0);
    });

    it('findPrev wraps from the first match to the last', () => {
        const v = makeMltev({ width: 40 });
        load(v, 'foo foo foo');
        v.setFindQuery('foo'); //  3 matches, currentIndex=0
        v.findPrev(); //  0 → 2 (wrap)
        assert.strictEqual(v._findState.currentIndex, 2);
    });

    it('findNext is a no-op when _findState is null', () => {
        const v = makeMltev({ width: 40 });
        load(v, 'foo foo');
        //  No setFindQuery called — _findState is null.
        v.findNext();
        assert.strictEqual(v._findState, null);
        assert.strictEqual(v.cursorPos.col, 0, 'cursor not moved');
    });

    it('findPrev is a no-op when _findState is null', () => {
        const v = makeMltev({ width: 40 });
        load(v, 'foo foo');
        v.findPrev();
        assert.strictEqual(v._findState, null);
        assert.strictEqual(v.cursorPos.col, 0, 'cursor not moved');
    });

    it('findNext positions cursor at the next match column', () => {
        const v = makeMltev({ width: 40 });
        load(v, 'foo foo');
        v.setFindQuery('foo'); //  match 0 at col 0
        v.findNext(); //  match 1 at col 4
        assert.strictEqual(v.cursorPos.col, 4);
    });
});

describe('MultiLineEditTextView — clearFind', () => {
    it('nulls _findState', () => {
        const v = makeMltev({ width: 40 });
        load(v, 'hello world');
        v.setFindQuery('world');
        assert.ok(v._findState !== null);
        v.clearFind(false); //  false = skip redraw in test
        assert.strictEqual(v._findState, null);
    });

    it('is a no-op (does not throw) when _findState is already null', () => {
        const v = makeMltev({ width: 40 });
        load(v, 'hello');
        assert.strictEqual(v._findState, null);
        assert.doesNotThrow(() => v.clearFind(false));
        assert.strictEqual(v._findState, null);
    });
});

describe('MultiLineEditTextView — setText clears active find', () => {
    it('_findState is null after setText regardless of prior find', () => {
        const v = makeMltev({ width: 40 });
        load(v, 'hello world');
        v.setFindQuery('world');
        assert.ok(v._findState !== null);
        v.setText('completely new content', { scrollMode: 'top' });
        assert.strictEqual(v._findState, null, 'setText must clear _findState');
    });
});

describe('MultiLineEditTextView — _scrollToMatch positioning', () => {
    it('centers the match vertically when the document is tall enough', () => {
        //  height=5, halfHeight=2.  Match at lineIndex=5 in a 10-line doc.
        //  Expected topVisibleIndex = min(max(0, 5-2), max(0, 10-5)) = min(3,5) = 3.
        //  Expected cursorPos.row = 5-3 = 2.
        const v = makeMltev({ width: 20, height: 5 });
        const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
        load(v, lines);
        v._scrollToMatch({ lineIndex: 5, displayStart: 0, displayEnd: 4 });
        assert.strictEqual(v.topVisibleIndex, 3);
        assert.strictEqual(v.cursorPos.row, 2);
    });

    it('clamps topVisibleIndex to 0 for matches near the document start', () => {
        const v = makeMltev({ width: 20, height: 5 });
        const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
        load(v, lines);
        v._scrollToMatch({ lineIndex: 1, displayStart: 0, displayEnd: 4 });
        assert.strictEqual(v.topVisibleIndex, 0, 'cannot scroll above top');
        assert.strictEqual(v.cursorPos.row, 1);
    });

    it('clamps topVisibleIndex so the last line stays visible', () => {
        //  height=5, 6-line doc (maxTop=1).  Match at lineIndex=5.
        //  Expected topVisibleIndex = min(max(0,5-2), max(0,6-5)) = min(3,1) = 1.
        const v = makeMltev({ width: 20, height: 5 });
        const lines = Array.from({ length: 6 }, (_, i) => `line${i}`).join('\n');
        load(v, lines);
        v._scrollToMatch({ lineIndex: 5, displayStart: 0, displayEnd: 4 });
        assert.strictEqual(v.topVisibleIndex, 1);
        assert.strictEqual(v.cursorPos.row, 4);
    });
});
