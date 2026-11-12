'use strict';

//
//  An ATASCII screen model for test/term_atascii_translator.test.js (#593),
//  compared with the ANSI model of test/term_petscii_screens.js (reused as is:
//  it records character, background and inverse per cell, which is all an
//  ATASCII cell can show).
//
//  AtasciiScreen  applies ATASCII bytes as SyncTERM (cterm_atascii.c) and icy
//                 (atascii.rs) do where they agree: glyphs with bit 7 inverse,
//                 ESC quoting, CLEAR homes, END OF LINE (column 0 of the next row,
//                 scrolling on the bottom row), immediate wrap at the last column
//                 and scroll at the bottom-right cell, BELL. It THROWS on every
//                 byte the translator must never send:
//                 *   a cursor byte that would cross an edge (UP on the top row,
//                     DOWN on the bottom row, LEFT in column 0, RIGHT in the last
//                     column): SyncTERM wraps, icy clamps or line-wraps;
//                 *   BACKSPACE, TAB, DELETE / INSERT LINE, CLEAR / SET TAB,
//                     DELETE / INSERT CHARACTER;
//                 *   ESC before a byte that is not a control byte (it would take
//                     SyncTERM's other glyph path for nothing), ESC 0x9B, ESC with
//                     |quoted: false|, an ESC left dangling at the end of a write.
//                 With { edges: 'syncterm' } or { edges: 'icy' } the edge moves are
//                 applied the way that terminal does instead of throwing (for the
//                 unknown-position tests, where the translator cannot avoid them).
//
//  expectedCell() is the translator's documented mapping of an ANSI cell, built
//  from charset.js encode()/decodeCells() rather than the translator's own path.
//

const {
    Controls,
    INVERSE_BIT,
    isControlByte,
    byteToUnicode,
    encode,
    decodeCells,
} = require('../core/term/atascii/charset.js');
const { AnsiScreen } = require('./term_petscii_screens.js');

const C = Controls;

//  never sent as an action
const FORBIDDEN = new Map([
    [C.backspace, 'BACKSPACE'],
    [C.tab, 'TAB'],
    [C.deleteLine, 'DELETE LINE'],
    [C.insertLine, 'INSERT LINE'],
    [C.clearTab, 'CLEAR TAB'],
    [C.setTab, 'SET TAB'],
    [C.deleteChar, 'DELETE CHARACTER'],
    [C.insertChar, 'INSERT CHARACTER'],
]);

class AtasciiScreen {
    constructor(
        cols = 40,
        rows = 24,
        { row = 7, col = 13, quoted = true, edges = 'throw' } = {}
    ) {
        this.cols = cols;
        this.rows = rows;
        this.grid = [];
        for (let r = 0; r < rows; ++r) {
            this.grid.push(Array.from({ length: cols }, () => 0x20));
        }
        this.row = row; //  somewhere arbitrary: the translator must not assume home
        this.col = col;
        this.quoted = quoted;
        this.edges = edges;
        this.quote = false;
        this.scrolls = 0;
        this.bells = 0;
        this.clears = 0;
    }

    scroll() {
        this.grid.shift();
        this.grid.push(Array.from({ length: this.cols }, () => 0x20));
        ++this.scrolls;
    }

    newline() {
        this.col = 0;
        if (this.row === this.rows - 1) this.scroll();
        else ++this.row;
    }

    draw(b) {
        this.grid[this.row][this.col] = b;
        if (++this.col === this.cols) {
            this.newline();
        }
    }

    edge(b, why) {
        if ('syncterm' === this.edges) {
            if (C.cursorUp === b) this.row = this.rows - 1;
            else if (C.cursorDown === b) this.row = 0;
            else if (C.cursorLeft === b) this.col = this.cols - 1;
            else this.col = 0;
            return;
        }
        if ('icy' === this.edges) {
            if (C.cursorLeft === b && this.row > 0) {
                [this.row, this.col] = [this.row - 1, this.cols - 1];
            } else if (C.cursorRight === b) {
                this.newline();
            }
            return; //  UP / DOWN clamp
        }
        throw new Error(`ATASCII model: ${why} at ${this.row},${this.col}`);
    }

    apply(b) {
        const fail = why => {
            throw new Error(
                `ATASCII model: ${why} (byte 0x${b.toString(16)} at ${this.row},${this.col})`
            );
        };

        if (this.quote) {
            this.quote = false;
            if (!isControlByte(b)) fail('ESC before a glyph byte');
            if (C.eol === b) fail('ESC before END OF LINE');
            return this.draw(b);
        }

        if (!isControlByte(b)) {
            return this.draw(b);
        }
        if (FORBIDDEN.has(b)) {
            fail(`${FORBIDDEN.get(b)} sent`);
        }

        switch (b) {
            case C.escape:
                if (!this.quoted) fail('ESC with quoting off');
                this.quote = true;
                return;
            case C.cursorUp:
                if (0 === this.row) return this.edge(b, 'UP on the top row');
                --this.row;
                return;
            case C.cursorDown:
                if (this.row === this.rows - 1)
                    return this.edge(b, 'DOWN on the bottom row');
                ++this.row;
                return;
            case C.cursorLeft:
                if (0 === this.col) return this.edge(b, 'LEFT in column 0');
                --this.col;
                return;
            case C.cursorRight:
                if (this.col === this.cols - 1)
                    return this.edge(b, 'RIGHT in the last column');
                ++this.col;
                return;
            case C.clear:
                for (let r = 0; r < this.rows; ++r) {
                    this.grid[r] = Array.from({ length: this.cols }, () => 0x20);
                }
                [this.row, this.col] = [0, 0];
                ++this.clears;
                return;
            case C.eol:
                return this.newline();
            case C.bell:
                ++this.bells;
                return;
        }
        fail('unexpected control byte');
    }

    write(buf) {
        for (const b of buf) this.apply(b);
        if (this.quote) {
            throw new Error('ATASCII model: write ends with a dangling ESC');
        }
        return this;
    }

    actual(r, c) {
        const b = this.grid[r][c];
        return { ch: byteToUnicode(b & 0x7f), inverse: b >= INVERSE_BIT };
    }
}

const UNMAPPED = { ch: '?', inverse: false };

//
//  The ATASCII cell an ANSI cell should become: inverse when SGR 7 is on or the
//  background is not black; concealed text is a space; otherwise the one cell
//  charset.js encode() gives for the character ('?' when it gives more or none),
//  in inverse video when wanted. The one glyph that cannot be drawn in inverse
//  (the escape glyph: ESC 0x9B is a newline) is an inverse '?'.
//
function expectedCell(cell, quoted) {
    const want = cell.inverse || 0 !== cell.bg;
    if (cell.conceal) {
        return { ch: ' ', inverse: want, dontCare: cell.dontCare };
    }
    const cells = decodeCells(encode(cell.ch, { quoted }));
    const base = 1 === cells.length && '\n' !== cells[0].char ? cells[0] : null;
    const plain = base ? { ch: base.char, inverse: base.inverse } : UNMAPPED;
    const inverse = plain.inverse !== want;
    if (inverse && '␛' === plain.ch) {
        return { ch: '?', inverse: true, dontCare: cell.dontCare };
    }
    return { ch: plain.ch, inverse, dontCare: cell.dontCare };
}

//  Cell by cell comparison; returns a list of differences (empty = equivalent).
function diffScreens(ansi, ata, { cursor = true, quoted = true } = {}) {
    const diffs = [];
    for (let r = 0; r < ansi.rows; ++r) {
        for (let c = 0; c < ansi.cols; ++c) {
            const e = expectedCell(ansi.grid[r][c], quoted);
            if (e.dontCare) continue;
            const a = ata.actual(r, c);
            if (e.ch !== a.ch || e.inverse !== a.inverse) {
                diffs.push(
                    `${r},${c}: want ${JSON.stringify(e.ch)} inv=${e.inverse}, ` +
                        `got ${JSON.stringify(a.ch)} inv=${a.inverse}`
                );
            }
        }
    }
    if (cursor && !ansi.wrap && (ansi.row !== ata.row || ansi.col !== ata.col)) {
        diffs.push(`cursor: want ${ansi.row},${ansi.col} got ${ata.row},${ata.col}`);
    }
    return diffs;
}

module.exports = { AnsiScreen, AtasciiScreen, expectedCell, diffScreens };
