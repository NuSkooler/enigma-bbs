'use strict';

//
//  Two small screen models for test/term_petscii_translator.test.js (#593):
//
//  AnsiScreen     applies the subset of ECMA-48 / ANSI-BBS that ENiGMA writes to
//                 a cols x rows grid of { ch, fg, bg, inverse, conceal }. Written
//                 independently of the translator (regex tokenizer, no state
//                 machine) so the two can disagree.
//  PetsciiScreen  applies PETSCII bytes the way SyncTERM (cterm_petscii.c) and
//                 icy (petscii.rs) do: colours, cursor codes with line wrap,
//                 reverse, clear, home, RETURN, immediate wrap and scroll. It
//                 THROWS on any byte the translator must never send: unknown
//                 control bytes, DOWN on the bottom row (icy clamps, SyncTERM
//                 scrolls), UP on the top row, RIGHT from the bottom-right cell,
//                 LEFT at HOME, INSERT / DELETE.
//
//  Conventions the translator documents, mirrored here so a whole screen can be
//  compared:
//  *   ED 2 and FF home the cursor (ANSI-BBS).
//  *   Erases blank with default attributes (the translator erases with reverse
//      off; a background colour is not kept).
//  *   The bottom-right cell is only really written when the screen scrolls right
//      after it; otherwise it is marked |dontCare| (as are erases of it).
//  *   The deferred wrap: writing the last column sets |wrap|; the next glyph
//      wraps first. CR, LF and every cursor move clear it.
//

const {
    Controls,
    Colors,
    AnsiToPetsciiColor,
    unicodeToByte,
    byteToUnicode,
    reverseOnlyByte,
} = require('../core/term/petscii/charset.js');

function blankAnsiCell() {
    return { ch: ' ', fg: 7, bg: 0, inverse: false, conceal: false, dontCare: false };
}

const TOKEN_RE = new RegExp(
    [
        '\\x1b\\[([\\x30-\\x3f]*)([\\x20-\\x2f]*)([\\x40-\\x7e])', //  CSI
        '\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)', //  OSC
        '\\x1b[PX^_][\\s\\S]*?\\x1b\\\\', //  DCS SOS PM APC
        '\\x1b([\\x20-\\x2f]*)([\\x30-\\x7e])', //  two byte ESC
        '\\r\\n',
        '[\\s\\S]',
    ].join('|'),
    'gu'
);

class AnsiScreen {
    constructor(cols = 40, rows = 25) {
        this.cols = cols;
        this.rows = rows;
        this.grid = [];
        for (let r = 0; r < rows; ++r) {
            this.grid.push(Array.from({ length: cols }, blankAnsiCell));
        }
        this.row = 0;
        this.col = 0;
        this.wrap = false;
        this.brHeld = false;
        this.saved = null;
        this.resetSgr();
    }

    resetSgr() {
        this.fg = 7;
        this.fgBoldable = true;
        this.bold = false;
        this.bg = 0;
        this.inverse = false;
        this.conceal = false;
    }

    cell(r, c) {
        return this.grid[r][c];
    }

    clearAll() {
        for (let r = 0; r < this.rows; ++r) {
            this.grid[r] = Array.from({ length: this.cols }, blankAnsiCell);
        }
    }

    scroll() {
        if (this.brHeld && this.wrap) {
            this.grid[this.rows - 1][this.cols - 1].dontCare = false;
        }
        this.brHeld = false;
        this.grid.shift();
        this.grid.push(Array.from({ length: this.cols }, blankAnsiCell));
    }

    //  a move that is not a scroll: the held bottom-right glyph is lost
    settle() {
        this.wrap = false;
        this.brHeld = false;
    }

    goTo(r, c) {
        this.settle();
        this.row = Math.max(0, Math.min(this.rows - 1, r));
        this.col = Math.max(0, Math.min(this.cols - 1, c));
    }

    lf() {
        if (this.row === this.rows - 1) {
            this.scroll();
        } else {
            ++this.row;
        }
        this.settle();
    }

    blank(from, to) {
        this.settle();
        const last = this.rows * this.cols - 1;
        for (let i = from; i <= to; ++i) {
            const cell = blankAnsiCell();
            cell.dontCare = i === last;
            this.grid[Math.floor(i / this.cols)][i % this.cols] = cell;
        }
    }

    putGlyph(ch) {
        if (this.wrap) {
            this.col = 0;
            if (this.row === this.rows - 1) {
                this.scroll();
            } else {
                ++this.row;
            }
            this.wrap = false;
        }
        const fg = this.fg < 8 && this.fgBoldable && this.bold ? this.fg + 8 : this.fg;
        const isBr = this.row === this.rows - 1 && this.col === this.cols - 1;
        this.grid[this.row][this.col] = {
            ch,
            fg,
            bg: this.bg,
            inverse: this.inverse,
            conceal: this.conceal,
            dontCare: isBr,
        };
        if (isBr) {
            this.brHeld = true;
        }
        if (this.col === this.cols - 1) {
            this.wrap = true;
        } else {
            ++this.col;
        }
    }

    sgr(params) {
        if (0 === params.length) params = [0];
        for (let i = 0; i < params.length; ++i) {
            const p = params[i] || 0;
            if (0 === p) this.resetSgr();
            else if (1 === p) this.bold = true;
            else if (22 === p) this.bold = false;
            else if (7 === p) this.inverse = true;
            else if (27 === p) this.inverse = false;
            else if (8 === p) this.conceal = true;
            else if (28 === p) this.conceal = false;
            else if (p >= 30 && p <= 37) [this.fg, this.fgBoldable] = [p - 30, true];
            else if (39 === p) [this.fg, this.fgBoldable] = [7, true];
            else if (p >= 90 && p <= 97) [this.fg, this.fgBoldable] = [p - 82, false];
            else if (p >= 40 && p <= 47) this.bg = p - 40;
            else if (p >= 100 && p <= 107) this.bg = p - 92;
            else if (49 === p) this.bg = 0;
            else if (38 === p || 48 === p) {
                //  tests only use 5;n with n < 16 and the documented 2;r;g;b cases
                let idx;
                if (5 === params[i + 1]) {
                    idx = params[i + 2];
                    i += 2;
                } else if (2 === params[i + 1]) {
                    idx = params[i + 5]; //  test convention: expected index appended
                    i += 5;
                }
                if (38 === p) [this.fg, this.fgBoldable] = [idx, false];
                else this.bg = idx;
            }
        }
    }

    csi(paramStr, inter, final) {
        if (inter || /[<=>?]/.test(paramStr)) return;
        const params =
            '' === paramStr
                ? []
                : paramStr.split(';').map(p => (p ? parseInt(p, 10) : 0));
        const n = params[0] || 1;
        const at = this.row * this.cols + this.col;
        const lineStart = this.row * this.cols;
        const last = this.rows * this.cols - 1;
        switch (final) {
            case 'A':
                return this.goTo(this.row - n, this.col);
            case 'B':
                return this.goTo(this.row + n, this.col);
            case 'C':
                return this.goTo(this.row, this.col + n);
            case 'D':
                return this.goTo(this.row, this.col - n);
            case 'E':
                return this.goTo(this.row + n, 0);
            case 'F':
                return this.goTo(this.row - n, 0);
            case 'G':
            case '`':
                return this.goTo(this.row, n - 1);
            case 'd':
                return this.goTo(n - 1, this.col);
            case 'H':
            case 'f':
                return this.goTo((params[0] || 1) - 1, (params[1] || 1) - 1);
            case 'J': {
                const mode = params[0] || 0;
                if (2 === mode || (0 === mode && 0 === at)) {
                    this.clearAll();
                    return this.goTo(0, 0);
                }
                if (0 === mode) return this.blank(at, last);
                if (1 === mode) {
                    if (at === last) {
                        this.clearAll();
                        return this.settle();
                    }
                    return this.blank(0, at);
                }
                return;
            }
            case 'K': {
                const mode = params[0] || 0;
                if (0 === mode) return this.blank(at, lineStart + this.cols - 1);
                if (1 === mode) return this.blank(lineStart, at);
                if (2 === mode) return this.blank(lineStart, lineStart + this.cols - 1);
                return;
            }
            case 'X':
                return this.blank(at, Math.min(lineStart + this.cols - 1, at + n - 1));
            case 'm':
                return this.sgr(params);
            case 's':
                this.saved = [this.row, this.col];
                return;
            case 'u':
                if (this.saved) this.goTo(...this.saved);
                return;
        }
    }

    write(str) {
        for (const m of str.matchAll(TOKEN_RE)) {
            const t = m[0];
            if (undefined !== m[3]) {
                this.csi(m[1], m[2], m[3]);
            } else if (undefined !== m[5]) {
                if (m[4]) continue;
                const f = m[5];
                if ('7' === f) this.saved = [this.row, this.col];
                else if ('8' === f && this.saved) this.goTo(...this.saved);
                else if ('c' === f) {
                    this.resetSgr();
                    this.saved = null;
                    this.clearAll();
                    this.goTo(0, 0);
                } else if ('D' === f) this.lf();
                else if ('E' === f) {
                    this.col = 0;
                    this.lf();
                } else if ('M' === f) this.goTo(this.row - 1, this.col);
            } else if (t.startsWith('\x1b')) {
                //  OSC / DCS / ...: nothing
            } else if ('\r\n' === t) {
                this.col = 0;
                this.lf();
            } else if ('\r' === t) {
                this.goTo(this.row, 0);
            } else if ('\n' === t || '\x0b' === t) {
                this.lf();
            } else if ('\x0c' === t) {
                this.clearAll();
                this.goTo(0, 0);
            } else if ('\b' === t) {
                this.goTo(this.row, this.col - 1);
            } else if ('\t' === t) {
                this.goTo(this.row, (Math.floor(this.col / 8) + 1) * 8);
            } else if (t.codePointAt(0) < 0x20 || '\x7f' === t) {
                //  other C0: nothing
            } else {
                this.putGlyph(t);
            }
        }
        return this;
    }

    //  The PETSCII cell this ANSI cell should become, per the translator's rules.
    expected(r, c, charset) {
        const cell = this.grid[r][c];
        const bgColored = 0 !== cell.bg;
        let reverse = cell.inverse || bgColored;
        const idx = cell.inverse ? cell.fg : bgColored ? cell.bg : cell.fg;
        let ch;
        if (cell.conceal) {
            ch = ' ';
        } else if (undefined !== reverseOnlyByte(cell.ch)) {
            ch = byteToUnicode(reverseOnlyByte(cell.ch), charset);
            reverse = true;
        } else {
            const b = unicodeToByte(cell.ch, charset);
            ch = byteToUnicode(undefined === b ? 0x3f : b, charset);
        }
        return { ch, color: AnsiToPetsciiColor[idx], reverse, dontCare: cell.dontCare };
    }
}

const COLOR_BYTES = new Set(Object.values(Colors));

class PetsciiScreen {
    constructor(cols = 40, rows = 25, { row = 7, col = 13 } = {}) {
        this.cols = cols;
        this.rows = rows;
        this.grid = [];
        for (let r = 0; r < rows; ++r) {
            this.grid.push(Array.from({ length: cols }, () => this.blank()));
        }
        this.row = row; //  somewhere arbitrary: the translator must not assume HOME
        this.col = col;
        this.color = Colors.cyan;
        this.reverse = false;
        this.charset = 'upper'; //  C64 power-on set
        this.scrolls = 0;
    }

    blank() {
        return { byte: 0x20, color: Colors.lightBlue, reverse: false };
    }

    scroll() {
        this.grid.shift();
        this.grid.push(Array.from({ length: this.cols }, () => this.blank()));
        ++this.scrolls;
    }

    newline() {
        this.col = 0;
        if (this.row === this.rows - 1) this.scroll();
        else ++this.row;
    }

    apply(b) {
        const fail = why => {
            throw new Error(
                `PETSCII model: ${why} (byte 0x${b.toString(16)} at ${this.row},${this.col})`
            );
        };
        if (COLOR_BYTES.has(b)) {
            this.color = b;
            return;
        }
        switch (b) {
            case Controls.return:
                this.reverse = false;
                return this.newline();
            case Controls.charsetLower:
                this.charset = 'lower';
                return;
            case Controls.charsetUpper:
                this.charset = 'upper';
                return;
            case Controls.cursorDown:
                if (this.row === this.rows - 1) fail('DOWN on the bottom row');
                ++this.row;
                return;
            case Controls.cursorUp:
                if (0 === this.row) fail('UP on the top row');
                --this.row;
                return;
            case Controls.cursorRight:
                if (this.col < this.cols - 1) ++this.col;
                else if (this.row < this.rows - 1) this.newline();
                else fail('RIGHT from the bottom-right cell');
                return;
            case Controls.cursorLeft:
                if (this.col > 0) --this.col;
                else if (this.row > 0)
                    [this.row, this.col] = [this.row - 1, this.cols - 1];
                else fail('LEFT at HOME');
                return;
            case Controls.reverseOn:
                this.reverse = true;
                return;
            case Controls.reverseOff:
                this.reverse = false;
                return;
            case Controls.home:
                [this.row, this.col] = [0, 0];
                return;
            case Controls.clear:
                for (let r = 0; r < this.rows; ++r) {
                    this.grid[r] = Array.from({ length: this.cols }, () => this.blank());
                }
                [this.row, this.col] = [0, 0];
                return;
        }
        if (b < 0x20 || (b >= 0x80 && b <= 0x9f)) {
            fail('unexpected control byte');
        }
        this.grid[this.row][this.col] = {
            byte: b,
            color: this.color,
            reverse: this.reverse,
        };
        if (++this.col === this.cols) {
            this.newline();
        }
    }

    write(buf) {
        for (const b of buf) this.apply(b);
        return this;
    }

    actual(r, c) {
        const cell = this.grid[r][c];
        return {
            ch: byteToUnicode(cell.byte, this.charset),
            color: cell.color,
            reverse: cell.reverse,
        };
    }
}

//  Cell by cell comparison; returns a list of differences (empty = equivalent).
function diffScreens(ansi, pet, { cursor = true } = {}) {
    const diffs = [];
    for (let r = 0; r < ansi.rows; ++r) {
        for (let c = 0; c < ansi.cols; ++c) {
            const e = ansi.expected(r, c, pet.charset);
            if (e.dontCare) continue;
            const a = pet.actual(r, c);
            const colorMatters = e.reverse || ' ' !== e.ch;
            if (
                e.ch !== a.ch ||
                e.reverse !== a.reverse ||
                (colorMatters && e.color !== a.color)
            ) {
                diffs.push(
                    `${r},${c}: want ${JSON.stringify(e.ch)} c=${e.color.toString(16)} ` +
                        `r=${e.reverse}, got ${JSON.stringify(a.ch)} ` +
                        `c=${a.color.toString(16)} r=${a.reverse}`
                );
            }
        }
    }
    if (cursor && !ansi.wrap && (ansi.row !== pet.row || ansi.col !== pet.col)) {
        diffs.push(`cursor: want ${ansi.row},${ansi.col} got ${pet.row},${pet.col}`);
    }
    return diffs;
}

module.exports = { AnsiScreen, PetsciiScreen, diffScreens };
