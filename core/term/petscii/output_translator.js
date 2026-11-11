/* jslint node: true */
'use strict';

//
//  PETSCII output translator (#593).
//
//  ENiGMA is ANSI inside. For a PETSCII session the codec emits UTF-8 text
//  mixed with ANSI / ECMA-48 sequences, and this translator turns that final
//  outbound stream into the bytes a Commodore PETSCII terminal speaks (C64
//  40x25 first; SyncTERM and IcyTerm in C64 mode are the test clients). It
//  owns the whole conversion: incremental UTF-8 decode, escape parsing, cursor
//  and attribute tracking, glyph mapping through ./charset.js.
//
//  No ENiGMA imports on purpose (only ./charset.js and Node built-ins) so this
//  file can move to another package unchanged.
//
//      const t = createPetsciiTranslator({ cols: 40, rows: 25, charset: 'lower' });
//      socket.write(t.translate(buffer));
//
//      translate(data)     Buffer (or string) of UTF-8 + ANSI -> Buffer of PETSCII
//      passThrough(data)   bytes were written around us: cursor, colour, reverse
//                          and charset on the terminal are now unknown
//      setSize(cols, rows) the terminal's screen changed size
//      setCharset(cs)      'lower' or 'upper' (charset.js Charsets); the select
//                          byte goes out at the start of the next translate()
//      reset()             back to the state of a new connection
//      state()             plain snapshot for tests and debugging
//
//  Input may be split anywhere (mid UTF-8 character, mid escape sequence,
//  between CR and LF). The incomplete tail is held, so translating a stream
//  whole or in pieces gives identical output. One consequence: a CR at the very
//  end of a write is held until the next write (it may be the first half of a
//  CRLF, which is one PETSCII byte rather than a run of cursor lefts).
//
//  WHAT THE TERMINAL DOES (verified against SyncTERM src/conio/cterm_petscii.c +
//  cterm.c cterm_advance_char, icy_tools icy_parser_core/src/petscii.rs +
//  icy_engine/src/screen.rs, Synchronet src/sbbs3/petscii_term.cpp)
//  -----------------------------------------------------------------------------
//  *   There is no absolute addressing: HOME (0x13), then DOWN / RIGHT.
//  *   Writing a glyph in the last column wraps AT ONCE to column 0 of the next
//      row (ANSI terminals defer the wrap until the next glyph). Writing the
//      bottom-right cell scrolls the screen at once.
//  *   RETURN (0x0D) goes to column 0 of the next row, scrolls on the bottom
//      row, and turns reverse off.
//  *   LEFT (0x9D) at column 0 wraps to the end of the row above (no-op at
//      HOME); RIGHT (0x1D) in the last column wraps to the next row. Both are
//      used deliberately: the cursor is tracked as a linear position.
//  *   UP (0x91) clamps at the top in both terminals. DOWN (0x11) at the bottom
//      row scrolls in SyncTERM but clamps in icy, so it is never sent there.
//  *   0x0A is a carriage return in icy, 0x0F/0x08/0x09 are font/case switches
//      there and 0x94 is INSERT: none of them is ever sent.
//
//  DESIGN CHOICES
//  --------------
//  Cursor        Tracked twice: the ANSI cursor (where ENiGMA thinks it is,
//                including the deferred-wrap flag) and the PETSCII cursor (where
//                the terminal really is). Every cursor operation is emitted at
//                once as the shortest of: relative moves (using LEFT/RIGHT line
//                wrap), HOME + moves, or RETURN + moves. A position that is not
//                known (start, after passThrough or setSize) is reached from HOME.
//                A row written to the last column therefore needs no move before
//                the following CRLF: the terminal is already there.
//
//  Bottom-right  The cell is not written when it is written: the glyph is held.
//                If the next thing scrolls the ANSI screen (more text, LF, CRLF,
//                IND, NEL) the held glyph is sent then, and the terminal's own
//                scroll is exactly the scroll ANSI wanted. Anything else (a
//                cursor move, an erase, ...) drops it: the cell stays as it was.
//                Erases never write that cell either. (A C64 can fill it with
//                the INSERT trick, but that needs a shadow of the row, and INSERT
//                starts insert mode on a real C64; left for later.)
//
//  Colour        SGR 30-37 (+ bold = bright), 90-97 give one of 16 colours via
//                charset.js AnsiToPetsciiColor. 39 / 0 give the default: ANSI
//                colour 7, light grey (0x9B) - SyncTERM's C64 default attribute
//                and what Synchronet sends for "normal". There is no independent
//                background: a non-black background (40-47, 100-107 except 40)
//                is reverse video with THAT colour as the cell colour; the
//                requested foreground is dropped (the glyph shows in the screen
//                colour, black), as Synchronet's xlat_atr does. SGR 7 is reverse
//                with the foreground colour (what an ANSI terminal shows), and it
//                wins over a background colour. 38/48 extended colours (5;n and
//                2;r;g;b) map to the nearest of the 16 ANSI colours (VGA RGB).
//                SGR 8 (conceal) prints spaces. Blink, underline, italic, faint,
//                strike: ignored. Colour and reverse are sent lazily, right before
//                the next glyph that needs them.
//
//  Glyphs        One ANSI cell is one PETSCII cell: a character with a single
//                byte mapping uses it, U+2588 is reverse + 0xA0, anything else
//                (including multi-byte fallbacks) is '?'. Zero-width code points
//                (combining marks, format characters) and C1 controls are dropped.
//
//  Erase         ED 2 / FF / RIS: clear (0x93), which also homes; the ANSI cursor
//                is homed too (ANSI-BBS convention). ED 0 at HOME is a clear as
//                well. Other ED/EL/ECH: spaces with reverse off, then back.
//
//  Unknown pos   CUU/CUD/CUF/CUB are sent as plain repeats; a bare CR or CHA is
//                RETURN + UP (+ RIGHTs; wrong only on the bottom row, where the
//                RETURN scrolls); LF is DOWN; CRLF is RETURN; EL, ED 0/1, ECH, TAB,
//                VPA, CNL, CPL are dropped; text is sent as is. CUP, HOME, ED 2,
//                FF and RIS make the position known again.
//
//  Quote mode    On a real C64 the screen editor toggles "quote mode" on every
//                0x22 and then prints control codes as reverse glyphs. SyncTERM
//                (cterm_dispatch_byte: control bytes always act) and icy
//                (petscii.rs has no quote state) do not implement it, and C64
//                terminal programs turn it off after every received byte (CCGMS
//                terminal.s calls quote_insert_off after each chrout), so '"' is
//                sent as an ordinary glyph.
//
//  Real hardware C64 line linking (a row that wrapped is joined to the next, so
//                RETURN skips both) is not modelled; neither test client has it.
//
//  Dropped       Hide/show cursor, scroll regions, queries (DSR/CPR/DA), private
//                modes, SyncTERM font selection, insert/delete line/char, scroll,
//                any CSI with intermediates or a private marker, any unknown CSI,
//                OSC (an OSC 8 link keeps its text: only the wrapper goes), DCS,
//                APC, PM, SOS, two byte ESC sequences other than 7 8 c D E M.
//
const { StringDecoder } = require('string_decoder');

const {
    Charsets,
    DEFAULT_CHARSET,
    Controls,
    AnsiToPetsciiColor,
    isControlByte,
    unicodeToByte,
    reverseOnlyByte,
} = require('./charset.js');

const DEFAULT_FG = 7; //  ANSI light grey
const SPACE = 0x20;
const UNMAPPED = 0x3f; //  '?'
const TAB_WIDTH = 8;
const MAX_CSI_LENGTH = 64; //  parameters + intermediates kept per CSI

const ESC = 0x1b;
const CAN = 0x18;
const SUB = 0x1a;
const BEL = 0x07;

const Mode = Object.freeze({
    Ground: 0,
    Esc: 1,
    EscInter: 2,
    Csi: 3,
    String: 4,
    StringEsc: 5,
});

//  VGA 16 colour palette, ANSI order, for the nearest-colour match of 38/48
const VGA_RGB = [
    [0x00, 0x00, 0x00],
    [0xaa, 0x00, 0x00],
    [0x00, 0xaa, 0x00],
    [0xaa, 0x55, 0x00],
    [0x00, 0x00, 0xaa],
    [0xaa, 0x00, 0xaa],
    [0x00, 0xaa, 0xaa],
    [0xaa, 0xaa, 0xaa],
    [0x55, 0x55, 0x55],
    [0xff, 0x55, 0x55],
    [0x55, 0xff, 0x55],
    [0xff, 0xff, 0x55],
    [0x55, 0x55, 0xff],
    [0xff, 0x55, 0xff],
    [0x55, 0xff, 0xff],
    [0xff, 0xff, 0xff],
];

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

function nearestAnsiColor(r, g, b) {
    let best = 0;
    let bestDist = Infinity;
    VGA_RGB.forEach(([cr, cg, cb], idx) => {
        const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
        if (d < bestDist) {
            bestDist = d;
            best = idx;
        }
    });
    return best;
}

function xterm256ToAnsi(n) {
    if (n < 16) {
        return n;
    }
    if (n < 232) {
        const v = n - 16;
        return nearestAnsiColor(
            CUBE_LEVELS[Math.floor(v / 36)],
            CUBE_LEVELS[Math.floor(v / 6) % 6],
            CUBE_LEVELS[v % 6]
        );
    }
    const grey = 8 + 10 * (n - 232);
    return nearestAnsiColor(grey, grey, grey);
}

const ZERO_WIDTH_RE = /[\p{Mn}\p{Me}\p{Cf}]/u;

const PETSCII_COLOR_BYTES = new Set(AnsiToPetsciiColor);

function charsetSelectByte(charset) {
    return Charsets.UpperGraphics === charset
        ? Controls.charsetUpper
        : Controls.charsetLower;
}

function checkCharset(charset) {
    if (charset !== Charsets.UpperGraphics && charset !== Charsets.LowerUpper) {
        throw new TypeError(`Unknown PETSCII charset: ${charset}`);
    }
    return charset;
}

function checkSize(cols, rows) {
    if (!Number.isInteger(cols) || cols < 2 || !Number.isInteger(rows) || rows < 2) {
        throw new RangeError(`Bad PETSCII screen size: ${cols}x${rows}`);
    }
}

function createPetsciiTranslator({
    cols = 40,
    rows = 25,
    charset = DEFAULT_CHARSET,
} = {}) {
    checkSize(cols, rows);
    checkCharset(charset);

    const geo = { cols, rows, charset };
    let st;
    let out; //  bytes produced by the current translate() call

    function freshState() {
        return {
            //  parser
            decoder: new StringDecoder('utf8'),
            mode: Mode.Ground,
            csi: '',
            pendingCR: false,

            //  where ENiGMA's ANSI cursor is; |wrap| is the deferred-wrap flag
            row: 0,
            col: 0,
            wrap: false,
            known: false, //  false: neither cursor is known
            saved: null,

            //  where the terminal's cursor is (valid while |known|)
            prow: 0,
            pcol: 0,

            //  ANSI attributes
            fg: DEFAULT_FG,
            fgBoldable: true, //  30-37 / 39 brighten with bold; 90-97 / 38 do not
            bold: false,
            bg: null, //  null or 0 = black
            inverse: false,
            conceal: false,

            //  what the terminal has (null = unknown)
            termColor: null,
            termReverse: null,
            charsetSent: false,

            //  bottom-right glyph waiting for a scroll: { byte, attrs }
            deferred: null,
        };
    }

    st = freshState();

    // ------------------------------------------------------------------
    //  Emitting bytes and the terminal model
    // ------------------------------------------------------------------

    //  Send |b| and apply what the terminal does with it.
    function emit(b) {
        out.push(b);

        switch (b) {
            case Controls.return:
                st.termReverse = false;
                if (st.known) {
                    st.pcol = 0;
                    st.prow = Math.min(st.prow + 1, geo.rows - 1); //  scrolls at the bottom
                }
                return;
            case Controls.cursorDown:
                if (st.known) st.prow = Math.min(st.prow + 1, geo.rows - 1);
                return;
            case Controls.cursorUp:
                if (st.known) st.prow = Math.max(st.prow - 1, 0);
                return;
            case Controls.cursorRight:
                if (st.known) {
                    if (st.pcol < geo.cols - 1) {
                        ++st.pcol;
                    } else if (st.prow < geo.rows - 1) {
                        st.pcol = 0;
                        ++st.prow;
                    }
                }
                return;
            case Controls.cursorLeft:
                if (st.known) {
                    if (st.pcol > 0) {
                        --st.pcol;
                    } else if (st.prow > 0) {
                        st.pcol = geo.cols - 1;
                        --st.prow;
                    }
                }
                return;
            case Controls.home:
            case Controls.clear:
                st.known = true;
                st.prow = 0;
                st.pcol = 0;
                return;
            case Controls.reverseOn:
                st.termReverse = true;
                return;
            case Controls.reverseOff:
                st.termReverse = false;
                return;
            case Controls.charsetLower:
            case Controls.charsetUpper:
                return;
        }

        if (PETSCII_COLOR_BYTES.has(b)) {
            st.termColor = b;
            return;
        }

        //  a glyph: immediate wrap, scroll at the bottom-right
        if (st.known) {
            if (++st.pcol >= geo.cols) {
                st.pcol = 0;
                st.prow = Math.min(st.prow + 1, geo.rows - 1);
            }
        }
    }

    function emitRepeat(b, n) {
        for (let i = 0; i < n; ++i) {
            emit(b);
        }
    }

    //
    //  Moves from (fromRow, fromCol) to (row, col) as [vertical byte, count,
    //  horizontal byte, count], trying to land on the row above, the row itself
    //  and the row below and then going the rest of the way with line-wrapping
    //  LEFT / RIGHT. Never sends DOWN on the bottom row, UP on the top row, or
    //  RIGHT from the bottom-right cell.
    //
    function relativeMoves(fromRow, fromCol, row, col) {
        const target = row * geo.cols + col;
        let best = null;
        for (let r = row - 1; r <= row + 1; ++r) {
            if (r < 0 || r >= geo.rows) {
                continue;
            }
            const v = r - fromRow;
            const h = target - (r * geo.cols + fromCol);
            const cost = Math.abs(v) + Math.abs(h);
            if (!best || cost < best.cost) {
                best = { cost, v, h };
            }
        }
        return best;
    }

    function emitRelative(m) {
        emitRepeat(m.v < 0 ? Controls.cursorUp : Controls.cursorDown, Math.abs(m.v));
        emitRepeat(m.h < 0 ? Controls.cursorLeft : Controls.cursorRight, Math.abs(m.h));
    }

    //  Put the terminal's cursor at (row, col) with the fewest bytes.
    function moveTo(row, col) {
        if (st.known && st.prow === row && st.pcol === col) {
            return;
        }

        const home = relativeMoves(0, 0, row, col);
        const candidates = [{ cost: 1 + home.cost, lead: Controls.home, m: home }];

        if (st.known) {
            const rel = relativeMoves(st.prow, st.pcol, row, col);
            candidates.unshift({ cost: rel.cost, lead: null, m: rel });
            if (st.prow < geo.rows - 1) {
                const cr = relativeMoves(st.prow + 1, 0, row, col);
                candidates.push({ cost: 1 + cr.cost, lead: Controls.return, m: cr });
            }
        }

        //  first wins a tie: relative, then HOME, then RETURN (turns reverse off)
        const best = candidates.reduce((a, c) => (c.cost < a.cost ? c : a));
        if (null !== best.lead) {
            emit(best.lead);
        }
        emitRelative(best.m);
    }

    function sendCharsetIfNeeded() {
        if (!st.charsetSent) {
            emit(charsetSelectByte(geo.charset));
            st.charsetSent = true;
        }
    }

    // ------------------------------------------------------------------
    //  Attributes
    // ------------------------------------------------------------------

    function desiredAttrs() {
        const fg = st.fg < 8 && st.fgBoldable && st.bold ? st.fg + 8 : st.fg;
        const bgColored = null !== st.bg && 0 !== st.bg;
        const reverse = st.inverse || bgColored;
        const idx = st.inverse ? fg : bgColored ? st.bg : fg;
        return { color: AnsiToPetsciiColor[idx], reverse };
    }

    function syncReverse(reverse) {
        if (st.termReverse !== reverse) {
            emit(reverse ? Controls.reverseOn : Controls.reverseOff);
        }
    }

    function syncAttrs(attrs) {
        syncReverse(attrs.reverse);
        if (st.termColor !== attrs.color) {
            emit(attrs.color);
        }
    }

    function resetSgr() {
        st.fg = DEFAULT_FG;
        st.fgBoldable = true;
        st.bold = false;
        st.bg = null;
        st.inverse = false;
        st.conceal = false;
    }

    //  Extended colour at params[i] (the 38/48): returns [ansiIndex|undefined, next i]
    function extendedColor(params, i) {
        const kind = params[i + 1];
        if (5 === kind) {
            const n = params[i + 2];
            return [
                Number.isInteger(n) && n >= 0 && n <= 255 ? xterm256ToAnsi(n) : undefined,
                i + 2,
            ];
        }
        if (2 === kind) {
            const [r, g, b] = [params[i + 2], params[i + 3], params[i + 4]].map(v =>
                Math.min(255, Math.max(0, v || 0))
            );
            return [nearestAnsiColor(r, g, b), i + 4];
        }
        return [undefined, i + 1];
    }

    function sgr(params) {
        if (0 === params.length) {
            params = [0];
        }
        for (let i = 0; i < params.length; ++i) {
            const p = undefined === params[i] ? 0 : params[i];
            if (0 === p) {
                resetSgr();
            } else if (1 === p) {
                st.bold = true;
            } else if (22 === p) {
                st.bold = false;
            } else if (7 === p) {
                st.inverse = true;
            } else if (27 === p) {
                st.inverse = false;
            } else if (8 === p) {
                st.conceal = true;
            } else if (28 === p) {
                st.conceal = false;
            } else if (p >= 30 && p <= 37) {
                st.fg = p - 30;
                st.fgBoldable = true;
            } else if (39 === p) {
                st.fg = DEFAULT_FG;
                st.fgBoldable = true;
            } else if (p >= 90 && p <= 97) {
                st.fg = p - 90 + 8;
                st.fgBoldable = false;
            } else if (p >= 40 && p <= 47) {
                st.bg = p - 40;
            } else if (p >= 100 && p <= 107) {
                st.bg = p - 100 + 8;
            } else if (49 === p) {
                st.bg = null;
            } else if (38 === p || 48 === p) {
                const [idx, next] = extendedColor(params, i);
                i = next;
                if (undefined !== idx) {
                    if (38 === p) {
                        st.fg = idx;
                        st.fgBoldable = false;
                    } else {
                        st.bg = idx;
                    }
                }
            }
            //  everything else (blink, underline, italic, faint, ...) is ignored
        }
    }

    // ------------------------------------------------------------------
    //  Cursor operations (ANSI semantics -> terminal)
    // ------------------------------------------------------------------

    function clamp(v, lo, hi) {
        return Math.min(hi, Math.max(lo, v));
    }

    //  The deferred wrap is cleared without a scroll: a held bottom-right glyph is lost.
    function clearWrap() {
        st.wrap = false;
        st.deferred = null;
    }

    function goTo(row, col) {
        clearWrap();
        st.row = clamp(row, 0, geo.rows - 1);
        st.col = clamp(col, 0, geo.cols - 1);
        moveTo(st.row, st.col);
        st.known = true;
    }

    //  Scroll the whole screen up one row; both cursors end on the bottom row.
    function scrollUp() {
        if (st.deferred) {
            //  the held bottom-right glyph: writing it is the scroll
            const d = st.deferred;
            st.deferred = null;
            moveTo(geo.rows - 1, geo.cols - 1);
            syncAttrs(d.attrs);
            emit(d.byte);
        } else {
            if (st.prow !== geo.rows - 1) {
                moveTo(geo.rows - 1, st.pcol);
            }
            emit(Controls.return);
        }
        st.wrap = false;
    }

    function lineFeed() {
        if (!st.known) {
            emit(Controls.cursorDown);
            return;
        }
        if (st.row < geo.rows - 1) {
            clearWrap();
            ++st.row;
        } else {
            scrollUp();
        }
        moveTo(st.row, st.col);
    }

    function carriageReturnLineFeed() {
        if (!st.known) {
            emit(Controls.return);
            return;
        }
        if (st.row < geo.rows - 1) {
            clearWrap();
            ++st.row;
        } else {
            scrollUp();
        }
        st.col = 0;
        moveTo(st.row, 0);
    }

    function carriageReturn() {
        if (!st.known) {
            emit(Controls.return);
            emit(Controls.cursorUp);
            return;
        }
        goTo(st.row, 0);
    }

    //  Relative move by (dRow, dCol), clamped, no scrolling.
    function moveBy(dRow, dCol, n) {
        if (!st.known) {
            if (dRow)
                emitRepeat(
                    dRow < 0 ? Controls.cursorUp : Controls.cursorDown,
                    Math.min(n, geo.rows - 1)
                );
            if (dCol)
                emitRepeat(
                    dCol < 0 ? Controls.cursorLeft : Controls.cursorRight,
                    Math.min(n, geo.cols - 1)
                );
            return;
        }
        goTo(st.row + dRow * n, st.col + dCol * n);
    }

    function column(col) {
        if (!st.known) {
            emit(Controls.return);
            emit(Controls.cursorUp);
            emitRepeat(Controls.cursorRight, clamp(col, 0, geo.cols - 1));
            return;
        }
        goTo(st.row, col);
    }

    function row(r) {
        if (!st.known) {
            return; //  the column is not known either
        }
        goTo(r, st.col);
    }

    function tab() {
        if (!st.known) {
            return;
        }
        goTo(st.row, (Math.floor(st.col / TAB_WIDTH) + 1) * TAB_WIDTH);
    }

    function saveCursor() {
        st.saved = st.known ? { row: st.row, col: st.col } : null;
    }

    function restoreCursor() {
        if (st.saved) {
            goTo(st.saved.row, st.saved.col);
        }
    }

    // ------------------------------------------------------------------
    //  Erase
    // ------------------------------------------------------------------

    function clearScreen() {
        clearWrap();
        emit(Controls.clear);
        st.row = 0;
        st.col = 0;
    }

    //  Blank linear cells [from, to] with spaces (reverse off), cursor stays.
    function blank(from, to) {
        if (!st.known) {
            return;
        }
        clearWrap();
        const last = geo.rows * geo.cols - 1;
        to = Math.min(to, last - 1); //  never write the bottom-right cell
        if (to >= from) {
            moveTo(Math.floor(from / geo.cols), from % geo.cols);
            syncReverse(false);
            emitRepeat(SPACE, to - from + 1);
        }
        moveTo(st.row, st.col);
    }

    function eraseInLine(mode) {
        const start = st.row * geo.cols;
        const at = start + st.col;
        if (0 === mode) blank(at, start + geo.cols - 1);
        else if (1 === mode) blank(start, at);
        else if (2 === mode) blank(start, start + geo.cols - 1);
    }

    function eraseInDisplay(mode) {
        const at = st.row * geo.cols + st.col;
        const last = geo.rows * geo.cols - 1;
        if (2 === mode || (0 === mode && st.known && 0 === at)) {
            clearScreen();
        } else if (0 === mode) {
            blank(at, last);
        } else if (1 === mode) {
            if (st.known && at === last) {
                clearScreen();
                goTo(geo.rows - 1, geo.cols - 1);
            } else {
                blank(0, at);
            }
        }
        //  3 (scrollback) and others: nothing to do
    }

    // ------------------------------------------------------------------
    //  Text
    // ------------------------------------------------------------------

    function glyph(ch) {
        const cp = ch.codePointAt(0);
        if (ZERO_WIDTH_RE.test(ch)) {
            return;
        }

        const attrs = desiredAttrs();
        let byte;
        if (st.conceal) {
            byte = SPACE;
        } else {
            byte = unicodeToByte(cp, geo.charset);
            if (undefined === byte || isControlByte(byte)) {
                const rev = reverseOnlyByte(cp);
                if (undefined !== rev) {
                    byte = rev;
                    attrs.reverse = true;
                } else {
                    byte = UNMAPPED;
                }
            }
        }

        if (!st.known) {
            syncAttrs(attrs);
            emit(byte);
            return;
        }

        if (st.wrap) {
            //  ANSI's deferred wrap happens now
            st.col = 0;
            if (st.row < geo.rows - 1) {
                clearWrap();
                ++st.row;
            } else {
                scrollUp();
            }
        }

        moveTo(st.row, st.col);
        if (st.row === geo.rows - 1 && st.col === geo.cols - 1) {
            st.deferred = { byte, attrs };
            st.wrap = true;
            return;
        }

        syncAttrs(attrs);
        emit(byte);
        if (st.col === geo.cols - 1) {
            st.wrap = true;
        } else {
            ++st.col;
        }
    }

    // ------------------------------------------------------------------
    //  Parser
    // ------------------------------------------------------------------

    function parseParams(s) {
        if ('' === s) {
            return [];
        }
        return s.split(/[;:]/).map(p => (/^\d+$/.test(p) ? parseInt(p, 10) : undefined));
    }

    function count(params) {
        const n = params[0];
        return undefined === n || 0 === n ? 1 : n;
    }

    function dispatchCsi(final) {
        const body = st.csi;
        st.csi = '';
        if (body.length > MAX_CSI_LENGTH || /[<=>?\x20-\x2f]/.test(body)) {
            return; //  private marker, intermediates, or overlong: dropped
        }
        const params = parseParams(body);

        switch (final) {
            case 'A':
                return moveBy(-1, 0, count(params));
            case 'B':
                return moveBy(1, 0, count(params));
            case 'C':
                return moveBy(0, 1, count(params));
            case 'D':
                return moveBy(0, -1, count(params));
            case 'E':
                if (st.known) goTo(st.row + count(params), 0);
                return;
            case 'F':
                if (st.known) goTo(st.row - count(params), 0);
                return;
            case 'G':
            case '`':
                return column(count(params) - 1);
            case 'd':
                return row(count(params) - 1);
            case 'H':
            case 'f': {
                const r = undefined === params[0] || 0 === params[0] ? 1 : params[0];
                const c = undefined === params[1] || 0 === params[1] ? 1 : params[1];
                return goTo(r - 1, c - 1);
            }
            case 'J':
                return eraseInDisplay(params[0] || 0);
            case 'K':
                return st.known ? eraseInLine(params[0] || 0) : undefined;
            case 'X': {
                if (!st.known) return;
                const at = st.row * geo.cols + st.col;
                const end = st.row * geo.cols + geo.cols - 1;
                return blank(at, Math.min(end, at + count(params) - 1));
            }
            case 'm':
                return sgr(params);
            case 's':
                return 0 === params.length ? saveCursor() : undefined;
            case 'u':
                return 0 === params.length ? restoreCursor() : undefined;
        }
        //  anything else: dropped
    }

    function escFinal(ch) {
        switch (ch) {
            case '7':
                return saveCursor();
            case '8':
                return restoreCursor();
            case 'c':
                resetSgr();
                st.saved = null;
                return clearScreen();
            case 'D':
                return lineFeed();
            case 'E':
                return carriageReturnLineFeed();
            case 'M':
                return moveBy(-1, 0, 1); //  RI; cannot scroll down: clamps at the top
        }
    }

    function control(c) {
        switch (c) {
            case 0x0a:
            case 0x0b:
                return lineFeed();
            case 0x0c:
                return clearScreen();
            case 0x08:
                return moveBy(0, -1, 1);
            case 0x09:
                return tab();
        }
        //  BEL, NUL and the rest: dropped
    }

    function feed(ch) {
        const c = ch.codePointAt(0);

        switch (st.mode) {
            case Mode.Ground:
                if (st.pendingCR) {
                    st.pendingCR = false;
                    if (0x0a === c) {
                        return carriageReturnLineFeed();
                    }
                    carriageReturn();
                }
                if (ESC === c) {
                    st.mode = Mode.Esc;
                } else if (0x0d === c) {
                    st.pendingCR = true;
                } else if (c < 0x20) {
                    control(c);
                } else if (0x7f === c || (c >= 0x80 && c <= 0x9f)) {
                    //  DEL and C1 controls: dropped
                } else {
                    glyph(ch);
                }
                return;

            case Mode.Esc:
                if ('[' === ch) {
                    st.csi = '';
                    st.mode = Mode.Csi;
                } else if (
                    ']' === ch ||
                    'P' === ch ||
                    'X' === ch ||
                    '^' === ch ||
                    '_' === ch
                ) {
                    st.mode = Mode.String;
                } else if (ESC === c) {
                    //  stay
                } else if (c >= 0x20 && c <= 0x2f) {
                    st.mode = Mode.EscInter;
                } else {
                    st.mode = Mode.Ground;
                    if (c >= 0x30 && c <= 0x7e) {
                        escFinal(ch);
                    }
                }
                return;

            case Mode.EscInter:
                if (c >= 0x20 && c <= 0x2f) {
                    return;
                }
                st.mode = ESC === c ? Mode.Esc : Mode.Ground; //  final byte or abort: dropped
                return;

            case Mode.Csi:
                if (c >= 0x40 && c <= 0x7e) {
                    st.mode = Mode.Ground;
                    dispatchCsi(ch);
                } else if (c >= 0x20 && c <= 0x3f) {
                    if (st.csi.length <= MAX_CSI_LENGTH) {
                        st.csi += ch;
                    }
                } else if (ESC === c) {
                    st.csi = '';
                    st.mode = Mode.Esc;
                } else if (CAN === c || SUB === c || c > 0x7e) {
                    st.csi = '';
                    st.mode = Mode.Ground;
                }
                //  other C0 inside a CSI: ignored
                return;

            case Mode.String:
                if (ESC === c) {
                    st.mode = Mode.StringEsc;
                } else if (BEL === c || CAN === c || SUB === c) {
                    st.mode = Mode.Ground;
                }
                return;

            case Mode.StringEsc:
                if ('\\' === ch) {
                    st.mode = Mode.Ground;
                } else if (ESC !== c) {
                    //  no ST: the string ends and this ESC starts a sequence
                    st.mode = Mode.Esc;
                    feed(ch);
                }
                return;
        }
    }

    // ------------------------------------------------------------------
    //  Public interface
    // ------------------------------------------------------------------

    function translate(data) {
        out = [];
        sendCharsetIfNeeded();

        const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
        const text = st.decoder.write(buf);
        for (const ch of text) {
            feed(ch);
        }

        const result = Buffer.from(out);
        out = null;
        return result;
    }

    //  Terminal state is untrusted; ENiGMA's ANSI attributes are kept and
    //  re-asserted with the next glyph. A half-parsed tail is discarded.
    function forgetTerminal() {
        st.known = false;
        st.wrap = false;
        st.deferred = null;
        st.saved = null;
        st.termColor = null;
        st.termReverse = null;
        st.charsetSent = false;
        st.mode = Mode.Ground;
        st.csi = '';
        st.pendingCR = false;
        st.decoder = new StringDecoder('utf8');
    }

    function passThrough() {
        forgetTerminal();
    }

    function setSize(newCols, newRows) {
        checkSize(newCols, newRows);
        geo.cols = newCols;
        geo.rows = newRows;
        //  the terminal may have cleared or moved: positions are no longer known
        st.known = false;
        st.wrap = false;
        st.deferred = null;
        st.saved = null;
    }

    function setCharset(cs) {
        geo.charset = checkCharset(cs);
        st.charsetSent = false;
    }

    function reset() {
        st = freshState();
    }

    function state() {
        return {
            cols: geo.cols,
            rows: geo.rows,
            charset: geo.charset,
            known: st.known,
            row: st.row,
            col: st.col,
            wrapPending: st.wrap,
            terminalRow: st.prow,
            terminalCol: st.pcol,
            colour: desiredAttrs().color,
            reverse: desiredAttrs().reverse,
            terminalColour: st.termColor,
            terminalReverse: st.termReverse,
            charsetSent: st.charsetSent,
            heldBottomRight: null !== st.deferred,
        };
    }

    return {
        identity: false,
        translate,
        passThrough,
        setSize,
        setCharset,
        reset,
        state,
    };
}

module.exports = { createPetsciiTranslator };
