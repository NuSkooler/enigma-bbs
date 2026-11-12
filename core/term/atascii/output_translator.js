/* jslint node: true */
'use strict';

//
//  ATASCII output translator (#593).
//
//  ENiGMA is ANSI inside. For an ATASCII session the codec emits UTF-8 text
//  mixed with ANSI / ECMA-48 sequences, and this translator turns that final
//  outbound stream into the bytes an Atari 8-bit ATASCII terminal speaks
//  (SyncTERM "Atari" 40x24 and "Atari XEP80" 80x25, IcyTerm in ATASCII mode).
//  It owns the whole conversion: incremental UTF-8 decode, escape parsing,
//  cursor and attribute tracking, glyph mapping through ./charset.js.
//
//  No ENiGMA imports on purpose (only ./charset.js, ./screen_rules.js and Node
//  built-ins) so this file can move to another package unchanged.
//
//      const t = createAtasciiTranslator({ cols: 40, rows: 24, quoted: true });
//      socket.write(t.translate(buffer));
//
//      translate(data)     Buffer (or string) of UTF-8 + ANSI -> Buffer of ATASCII
//      passThrough(data)   bytes were written around us: the cursor on the
//                          terminal is now unknown
//      writeNative(data, { anchor, startRow })
//                          native ATASCII bytes (.ata art) -> the Buffer to send:
//                          the same bytes, followed so the cursor stays known
//      setSize(cols, rows) the terminal's screen changed size
//      reset()             back to the state of a new connection
//      state()             plain snapshot for tests and debugging
//
//  Input may be split anywhere (mid UTF-8 character, mid escape sequence,
//  between CR and LF). The incomplete tail is held, so translating a stream
//  whole or in pieces gives identical output. One consequence: a CR at the very
//  end of a write is held until the next write (it may be the first half of a
//  CRLF, which is one END OF LINE rather than a run of cursor moves).
//
//  WHAT THE TERMINAL DOES: ./screen_rules.js (SyncTERM cterm_atascii.c, icy_tools
//  atascii.rs + screen.rs). In short: no colour, no home and no goto byte; the
//  four cursor bytes behave differently at the screen edges in SyncTERM (wrap to
//  the opposite edge) and icy (clamp vertically, line-wrap horizontally); writing
//  the last column wraps at once and the bottom-right cell scrolls; END OF LINE
//  (0x9B) is column 0 of the next row and scrolls on the bottom row; CLEAR
//  (0x7D) clears and homes; ESC draws the next byte as a glyph; bit 7 of a glyph
//  byte is inverse video.
//
//  DESIGN CHOICES
//  --------------
//  Cursor        Tracked twice, as in the PETSCII translator: the ANSI cursor
//                (where ENiGMA thinks it is, including the deferred-wrap flag)
//                and the terminal cursor (./screen_rules.js). Every cursor
//                operation is emitted at once as the shorter of: relative moves,
//                or END OF LINE + relative moves (not from the bottom row, where
//                it scrolls). A row written to the last column needs no move
//                before the following CRLF: the terminal is already there.
//
//  Edges         While the position is known, no cursor byte is ever sent at an
//                edge it would cross (UP on the top row, DOWN on the bottom row,
//                LEFT in column 0, RIGHT in the last column): SyncTERM and icy
//                disagree there, so no path relies on edge wrap. The price is
//                longer moves (row 0 to row 23 is 23 DOWNs, not one wrapping UP).
//                TAB (0x7F) is never sent (tab stops belong to the caller's
//                terminal) and BACKSPACE (0x7E) is never used to move (it blanks
//                in SyncTERM, not in icy).
//
//  Bottom-right  The cell is not written when it is written: the glyph is held.
//                If the next thing scrolls the ANSI screen (more text, LF, CRLF,
//                IND, NEL) the held glyph is sent then, and the terminal's own
//                scroll is exactly the scroll ANSI wanted. Anything else (a
//                cursor move, an erase, ...) drops it: the cell stays as it was.
//                Erases never write that cell either. (INSERT CHARACTER could
//                fill it, but icy and SyncTERM shift the row differently.)
//
//  Inverse       The only attribute. A cell is inverse when SGR 7 is on or the
//                background is not black (40-47 and 100-107 except 40, 48;5;n /
//                48;2 nearest to a non-black colour), the same rule the PETSCII
//                translator uses for reverse video. Colours, bold, faint, blink,
//                underline, italic, strike: dropped. Bold is NOT mapped to inverse:
//                about two thirds of the visible cells in the stock theme's art
//                are bright, so it would invert most of every screen. SGR 8
//                (conceal) prints spaces (inverse spaces on a background).
//                Inverse is bit 7 of each glyph byte, so nothing is sent ahead.
//
//  Glyphs        One ANSI cell is one ATASCII cell. A character with a byte uses
//                it; one that exists only as the complement of another glyph
//                (charset.js complementByte: full block, upper/right half blocks,
//                upper triangles, three-quadrant blocks) uses that inverse byte,
//                and inverse video then flips it back (an inverse full block is
//                a space). Otherwise a charset.js fallback that is ONE cell, else
//                '?'. Zero-width code points (combining marks, format characters)
//                and C0 / C1 controls are dropped.
//
//  ESC quoting   A glyph whose byte is a control byte (arrows, the escape glyph,
//                the clear-screen arrow, the two triangles, and their inverse
//                halves) is sent as ESC + byte when |quoted| is on (the default);
//                with |quoted: false| its charset.js fallback is used instead
//                (arrows become ^ v < >).
//
//                |quoted: 'portable'| quotes only what every terminal draws
//                right. SyncTERM's quoted path runs the byte through a screen
//                code conversion that its plain path does not, so ESC + 0x1B-0x1F
//                (the escape glyph and the four arrows) come out there as
//                [ \ ] ^ _ ; ESC + 0x7D-0x7F (the up-left arrow and the two
//                triangles) are not converted and draw correctly. Seen live in
//                SyncTERM against IcyTerm, which draws all eight. In this mode
//                the first five use their fallbacks and the last three are
//                quoted. No glyph ever needs 0x9B; the one that would (the
//                inverse escape glyph) is an inverse '?'.
//
//  Line ends     CRLF is END OF LINE when that is the shortest move, also on the
//                bottom row, where its scroll is the scroll ANSI does. A bare CR is
//                column 0 of the same row (LEFTs, or END OF LINE + UP when that is
//                shorter and not on the bottom row). A bare LF is DOWN, and on the
//                bottom row END OF LINE (the scroll) then RIGHTs back to the column.
//
//  Erase         ED 2 / FF / RIS: CLEAR (0x7D), which also homes; the ANSI cursor
//                is homed too (ANSI-BBS convention). ED 0 at home is a clear as
//                well. Other ED / EL / ECH: plain spaces, then back. An erase never
//                keeps a background colour (an ANSI terminal would paint it; here
//                that would be a block of inverse spaces), as on PETSCII.
//                DELETE / INSERT LINE (0x9C / 0x9D) and DELETE / INSERT CHARACTER
//                (0xFE / 0xFF) are never sent: their cursor and edge behaviour
//                differs between SyncTERM, icy and ANSI, so CSI M / L / P / @ are
//                dropped, as on PETSCII.
//
//  Unknown pos   The position is unknown at the start, after passThrough() and
//                after setSize(). Only CLEAR re-anchors it, so:
//                *   ED 2, FF, RIS: CLEAR, as always.
//                *   CUP / HVP (an absolute goto): CLEAR first, then the moves.
//                    Output positioned on a screen whose cursor is unknown can
//                    only land in the wrong place; a clear costs whatever was on
//                    the screen (typically a door's last page), and everything
//                    after it is right. ENiGMA clears at connect and most menus
//                    clear on entry, so this is rarely reached.
//                *   CRLF: END OF LINE (exact from anywhere).
//                *   Bare CR, CHA: END OF LINE + UP (+ RIGHTs): exact except on the
//                    bottom row, where the END OF LINE scrolls once first.
//                *   Bare LF: END OF LINE (the right row, scrolling as ANSI does,
//                    but column 0); DOWN would wrap to the top in SyncTERM.
//                *   CUU / CUD / CUF / CUB, BS: sent as plain repeats (at most a
//                    screen's worth); at an edge they wrap or clamp depending on
//                    the terminal. Text is sent as is.
//                *   EL, ED 0 / 1, ECH, TAB, VPA, CNL, CPL, restore: dropped.
//                If passThrough() data ends inside an ESC quote, a space goes out
//                first so the quote cannot swallow the next real byte.
//
//  BEL           0x07 becomes BELL (0xFD): no screen effect anywhere.
//
//  Never sent    (by translate(); writeNative() sends native art as it is)
//                0x7E backspace, 0x7F tab, 0x9C / 0x9D / 0x9E / 0x9F (delete and
//                insert line, clear and set tab), 0xFE / 0xFF (delete and insert
//                character) as actions; ESC before anything but a control byte;
//                ESC 0x9B. (0x7E, 0x7F, 0x9C-0x9F and 0xFD-0xFF do go out as the
//                second byte of an ESC quote: glyphs.)
//
//  Dropped       Hide/show cursor, scroll regions, queries (DSR/CPR/DA), private
//                modes, SyncTERM font selection, insert/delete line/char, scroll,
//                any CSI with intermediates or a private marker, any unknown CSI,
//                OSC (an OSC 8 link keeps its text: only the wrapper goes), DCS,
//                APC, PM, SOS, two byte ESC sequences other than 7 8 c D E M.
//
//  Real hardware The E: device's logical lines and 2-column margin are not
//                modelled (neither emulator has them; see ./screen_rules.js).
//
const { StringDecoder } = require('string_decoder');

const {
    Controls,
    INVERSE_BIT,
    isControlByte,
    unicodeToByte,
    complementByte,
    encode,
} = require('./charset.js');
const { Effect, createScreenState, applyByte, TAB_WIDTH } = require('./screen_rules.js');

const SPACE = 0x20;
const UNMAPPED = 0x3f; //  '?'
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

//  VGA 16 colour palette, ANSI order, for the nearest-colour match of 48;5 / 48;2:
//  only "is it black" matters here
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

//
//  The largest screen accepted. A size comes from the terminal (telnet NAWS
//  lets a caller claim 65535 x 65535), and an erase writes one space per
//  cell, so an unbounded size would let a caller ask for gigabytes of output.
//  Real ATASCII screens are 40x24 and 80x25 (40x25 PAL in icy).
//
const MAX_COLS = 160;
const MAX_ROWS = 100;

//  createAtasciiTranslator({ quoted: PORTABLE }): see "ESC quoting" in the header
const PORTABLE = 'portable';

function checkSize(cols, rows) {
    if (
        !Number.isInteger(cols) ||
        cols < 2 ||
        cols > MAX_COLS ||
        !Number.isInteger(rows) ||
        rows < 2 ||
        rows > MAX_ROWS
    ) {
        throw new RangeError(`Bad ATASCII screen size: ${cols}x${rows}`);
    }
}

//
//  The inverse-neutral byte of a glyph: bit 7 set means the glyph itself is an
//  inverse cell (a complement glyph); the caller flips bit 7 for inverse video.
//  The result may be a control byte only when |quoted| (it is then sent quoted).
//
//  control bytes whose quoted glyph SyncTERM draws wrongly (and their inverse
//  halves); see "ESC quoting" above
const isMisdrawnWhenQuoted = b => (b & 0x7f) >= 0x1b && (b & 0x7f) <= 0x1f;

function glyphBaseByte(ch, quoted) {
    const exact = unicodeToByte(ch);
    if (PORTABLE === quoted) {
        if (undefined !== exact && isControlByte(exact) && isMisdrawnWhenQuoted(exact)) {
            //  as with quoting off: the one-cell fallback, else '?'
            const plain = encode(ch, { quoted: false, fallbackByte: UNMAPPED });
            return 1 === plain.length && !isControlByte(plain[0]) ? plain[0] : UNMAPPED;
        }
        quoted = true;
    }
    if (undefined !== exact && (quoted || !isControlByte(exact))) {
        return exact;
    }
    const comp = complementByte(ch);
    if (undefined !== comp) {
        return comp;
    }
    //  a charset.js fallback, if it is exactly one cell
    const bytes = encode(ch, { quoted, fallbackByte: UNMAPPED });
    if (1 === bytes.length && !isControlByte(bytes[0])) {
        return bytes[0];
    }
    if (quoted && 2 === bytes.length && ESC === bytes[0] && isControlByte(bytes[1])) {
        return bytes[1];
    }
    return UNMAPPED;
}

function createAtasciiTranslator(options) {
    const { cols = 40, rows = 24, quoted = true } = options || {};
    checkSize(cols, rows);
    if ('boolean' !== typeof quoted && PORTABLE !== quoted) {
        throw new TypeError(
            `ATASCII quoted must be true, false or 'portable': ${quoted}`
        );
    }

    const geo = { cols, rows, quoted };
    const glyphCache = new Map();
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

            //  the terminal's cursor (valid while |known|) and ESC quote state;
            //  see ./screen_rules.js
            term: createScreenState(),

            //  ANSI attributes that matter: inverse video and conceal
            inverse: false,
            bgColored: false,
            conceal: false,

            //  bottom-right glyph waiting for a scroll: [bytes]
            deferred: null,

            //  passThrough() bytes ended inside an ESC quote (see emit())
            foreignQuote: false,
        };
    }

    st = freshState();

    // ------------------------------------------------------------------
    //  Emitting bytes and the terminal model
    // ------------------------------------------------------------------

    //  Send |b| and apply what the terminal does with it (./screen_rules.js).
    function emit(b) {
        if (st.foreignQuote) {
            //  bytes written around us left the terminal inside an ESC quote:
            //  a space absorbs it, so |b| is not drawn as a glyph instead of acting
            st.foreignQuote = false;
            out.push(SPACE);
            applyByte(st.term, SPACE, geo.cols, geo.rows);
        }
        out.push(b);
        if (applyByte(st.term, b, geo.cols, geo.rows) & Effect.Homed) {
            st.known = true;
        }
    }

    function emitRepeat(b, n) {
        for (let i = 0; i < n; ++i) {
            emit(b);
        }
    }

    //  Moves within the screen from (fromRow, fromCol) to (row, col): never
    //  across an edge, so every terminal agrees.
    function emitRelative(fromRow, fromCol, row, col) {
        const v = row - fromRow;
        const h = col - fromCol;
        emitRepeat(v < 0 ? Controls.cursorUp : Controls.cursorDown, Math.abs(v));
        emitRepeat(h < 0 ? Controls.cursorLeft : Controls.cursorRight, Math.abs(h));
    }

    //  Put the terminal's cursor at (row, col) with the fewest bytes. Only
    //  called while the position is known.
    function moveTo(row, col) {
        const { row: r, col: c } = st.term;
        if (r === row && c === col) {
            return;
        }
        const relCost = Math.abs(row - r) + Math.abs(col - c);
        //  END OF LINE: column 0 of the next row; it scrolls on the bottom row
        const eolCost = r < geo.rows - 1 ? 1 + Math.abs(row - (r + 1)) + col : Infinity;
        if (eolCost < relCost) {
            emit(Controls.eol);
            emitRelative(r + 1, 0, row, col);
        } else {
            emitRelative(r, c, row, col);
        }
    }

    //  Bytes of one cell: [glyph] or [ESC, glyph]
    function emitCell(bytes) {
        for (const b of bytes) {
            emit(b);
        }
    }

    // ------------------------------------------------------------------
    //  Attributes
    // ------------------------------------------------------------------

    function wantInverse() {
        return st.inverse || st.bgColored;
    }

    function resetSgr() {
        st.inverse = false;
        st.bgColored = false;
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
            } else if (7 === p) {
                st.inverse = true;
            } else if (27 === p) {
                st.inverse = false;
            } else if (8 === p) {
                st.conceal = true;
            } else if (28 === p) {
                st.conceal = false;
            } else if (p >= 40 && p <= 47) {
                st.bgColored = 40 !== p;
            } else if (p >= 100 && p <= 107) {
                st.bgColored = true;
            } else if (49 === p) {
                st.bgColored = false;
            } else if (38 === p || 48 === p) {
                //  parsed in full so 38;5;7 is not taken for SGR 7
                const [idx, next] = extendedColor(params, i);
                i = next;
                if (48 === p && undefined !== idx) {
                    st.bgColored = 0 !== idx;
                }
            }
            //  everything else (colours, bold, blink, underline, ...) is dropped
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

    //  Only while known.
    function goTo(row, col) {
        clearWrap();
        st.row = clamp(row, 0, geo.rows - 1);
        st.col = clamp(col, 0, geo.cols - 1);
        moveTo(st.row, st.col);
    }

    //  CUP / HVP: from an unknown position, CLEAR is the only anchor.
    function absoluteGoTo(row, col) {
        if (!st.known) {
            clearScreen();
        }
        goTo(row, col);
    }

    //  Scroll the whole screen up one row; both cursors end on the bottom row.
    function scrollUp() {
        if (st.deferred) {
            //  the held bottom-right glyph: writing it is the scroll
            const d = st.deferred;
            st.deferred = null;
            moveTo(geo.rows - 1, geo.cols - 1);
            emitCell(d);
        } else {
            if (st.term.row !== geo.rows - 1) {
                moveTo(geo.rows - 1, st.term.col);
            }
            emit(Controls.eol);
        }
        st.wrap = false;
    }

    function lineFeed() {
        if (!st.known) {
            emit(Controls.eol);
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
            emit(Controls.eol);
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

    //  column |col| of the current row, from an unknown position
    function unknownColumn(col) {
        emit(Controls.eol);
        emit(Controls.cursorUp);
        emitRepeat(Controls.cursorRight, clamp(col, 0, geo.cols - 1));
    }

    function carriageReturn() {
        if (!st.known) {
            return unknownColumn(0);
        }
        goTo(st.row, 0);
    }

    //  Relative move by (dRow, dCol), clamped, no scrolling.
    function moveBy(dRow, dCol, n) {
        if (!st.known) {
            if (dRow) {
                emitRepeat(
                    dRow < 0 ? Controls.cursorUp : Controls.cursorDown,
                    Math.min(n, geo.rows - 1)
                );
            }
            if (dCol) {
                emitRepeat(
                    dCol < 0 ? Controls.cursorLeft : Controls.cursorRight,
                    Math.min(n, geo.cols - 1)
                );
            }
            return;
        }
        goTo(st.row + dRow * n, st.col + dCol * n);
    }

    function column(col) {
        if (!st.known) {
            return unknownColumn(col);
        }
        goTo(st.row, col);
    }

    function row(r) {
        if (st.known) {
            goTo(r, st.col);
        }
        //  unknown: the column is not known either
    }

    function tab() {
        if (st.known) {
            goTo(st.row, (Math.floor(st.col / TAB_WIDTH) + 1) * TAB_WIDTH);
        }
    }

    function saveCursor() {
        st.saved = st.known ? { row: st.row, col: st.col } : null;
    }

    function restoreCursor() {
        if (st.saved && st.known) {
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

    //  Blank linear cells [from, to] with plain spaces, cursor stays. Only while known.
    function blank(from, to) {
        clearWrap();
        const last = geo.rows * geo.cols - 1;
        to = Math.min(to, last - 1); //  never write the bottom-right cell
        if (to >= from) {
            moveTo(Math.floor(from / geo.cols), from % geo.cols);
            emitRepeat(SPACE, to - from + 1);
        }
        moveTo(st.row, st.col);
    }

    function eraseInLine(mode) {
        if (!st.known) {
            return;
        }
        const start = st.row * geo.cols;
        const at = start + st.col;
        if (0 === mode) blank(at, start + geo.cols - 1);
        else if (1 === mode) blank(start, at);
        else if (2 === mode) blank(start, start + geo.cols - 1);
    }

    function eraseInDisplay(mode) {
        if (2 === mode) {
            return clearScreen();
        }
        if (!st.known) {
            return; //  0 and 1 need a position
        }
        const at = st.row * geo.cols + st.col;
        const last = geo.rows * geo.cols - 1;
        if (0 === mode) {
            if (0 === at) {
                clearScreen();
            } else {
                blank(at, last);
            }
        } else if (1 === mode) {
            if (at === last) {
                clearScreen();
                goTo(geo.rows - 1, geo.cols - 1);
            } else {
                blank(0, at);
            }
        }
        //  3 (scrollback) and others: nothing to do
    }

    function eraseChars(n) {
        if (!st.known) {
            return;
        }
        const at = st.row * geo.cols + st.col;
        const end = st.row * geo.cols + geo.cols - 1;
        blank(at, Math.min(end, at + n - 1));
    }

    // ------------------------------------------------------------------
    //  Text
    // ------------------------------------------------------------------

    //  The bytes that draw |ch| (one cell) with inverse video |inverse|.
    function cellBytes(ch, inverse) {
        let base = glyphCache.get(ch);
        if (undefined === base) {
            base = glyphBaseByte(ch, geo.quoted);
            glyphCache.set(ch, base);
        }
        let b = base ^ (inverse ? INVERSE_BIT : 0);
        if (
            Controls.eol === b ||
            (PORTABLE === geo.quoted && isMisdrawnWhenQuoted(b) && isControlByte(b))
        ) {
            //  the inverse escape glyph would need ESC 0x9B, which is a newline
            b = UNMAPPED | INVERSE_BIT;
        }
        return isControlByte(b) ? [ESC, b] : [b];
    }

    function glyph(ch) {
        if (ZERO_WIDTH_RE.test(ch)) {
            return;
        }

        const inverse = wantInverse();
        const bytes = st.conceal
            ? [inverse ? SPACE | INVERSE_BIT : SPACE]
            : cellBytes(ch, inverse);

        if (!st.known) {
            emitCell(bytes);
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
            st.deferred = bytes;
            st.wrap = true;
            return;
        }

        emitCell(bytes);
        if (st.col === geo.cols - 1) {
            st.wrap = true;
        } else {
            ++st.col;
        }
    }

    // ------------------------------------------------------------------
    //  Parser (the same ECMA-48 state machine as the PETSCII translator)
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
                return absoluteGoTo(r - 1, c - 1);
            }
            case 'J':
                return eraseInDisplay(params[0] || 0);
            case 'K':
                return eraseInLine(params[0] || 0);
            case 'X':
                return eraseChars(count(params));
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
            case BEL:
                return emit(Controls.bell);
        }
        //  NUL and the rest: dropped
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

        //  nothing to write is nothing to write, not the text "null"
        if (undefined === data || null === data) {
            data = '';
        }
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
        const text = st.decoder.write(buf);
        for (const ch of text) {
            feed(ch);
        }

        const result = Buffer.from(out);
        out = null;
        return result;
    }

    //
    //  Bytes were written to the terminal around us (a door, a file transfer):
    //  the cursor is no longer known and a half-parsed tail is discarded. The
    //  bytes are only read to see whether they leave the terminal inside an ESC
    //  quote (see emit()). ENiGMA's ANSI attributes are kept.
    //
    function passThrough(data) {
        st.known = false;
        st.wrap = false;
        st.deferred = null;
        st.saved = null;
        st.mode = Mode.Ground;
        st.csi = '';
        st.pendingCR = false;
        st.decoder = new StringDecoder('utf8');

        //  a string is looked at as the bytes it is written as
        if ('string' === typeof data) {
            data = Buffer.from(data, 'latin1');
        }

        if (data && 'number' === typeof data.length) {
            let quote = st.foreignQuote;
            for (let i = 0; i < data.length; ++i) {
                quote = quote ? false : ESC === data[i];
            }
            st.foreignQuote = quote;
            st.term.quote = false;
        }
    }

    //
    //  Native ATASCII bytes (an .ata art file, MCI codes already replaced) to
    //  go to the terminal as they are. Returns the bytes to send: |data|,
    //  preceded only by what settles the terminal first. Every byte is
    //  followed through ./screen_rules.js (the rules the art parser uses), so
    //  the cursor is known afterwards and ENiGMA's next ANSI output (views
    //  drawn at MCI positions) lands where it should. ENiGMA's own SGR state
    //  (inverse, conceal) is kept: it is per glyph, so nothing needs to be
    //  re-asserted.
    //
    //  Settled first: a CR waiting to see if an LF follows happens now; a
    //  half-parsed sequence or character is dropped; a glyph held for the
    //  bottom-right cell is dropped (as by any cursor move: writing it would
    //  scroll the screen under the art); bytes written around us that ended
    //  inside an ESC quote get their space (emit()).
    //
    //  |anchor| (art.display() sets it): when the position is unknown (after a
    //  door or a transfer, see passThrough()) and the art does not start by
    //  clearing the screen, CLEAR goes first, then END OF LINE down to
    //  |startRow| (1-based, default 1), where the art parser assumed the art
    //  starts. Without it the art would land wherever the cursor happens to be
    //  and every MCI position reported to the views would be wrong; ATASCII has
    //  no other way to reach a known place. The same rule as an absolute goto
    //  from an unknown position (absoluteGoTo()).
    //
    //  An ESC as the last byte would quote the first byte written after the
    //  art: it is treated as bytes written around us that end in a quote (the
    //  next byte out is preceded by a space). art.display() never sends one.
    //
    function writeNative(data, { anchor = false, startRow } = {}) {
        out = [];

        if (st.pendingCR) {
            st.pendingCR = false;
            carriageReturn();
        }
        st.mode = Mode.Ground;
        st.csi = '';
        st.decoder = new StringDecoder('utf8');
        clearWrap();

        //  nothing to write is nothing to write
        if (undefined === data || null === data) {
            data = Buffer.alloc(0);
        }
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);

        if (anchor && !st.known && !clearsFirst(buf)) {
            clearScreen();
            const row = clamp((startRow || 1) - 1, 0, geo.rows - 1);
            if (row > 0) {
                goTo(row, 0);
            }
        }

        for (let i = 0; i < buf.length; ++i) {
            emit(buf[i]);
        }

        if (st.term.quote) {
            st.term.quote = false;
            st.foreignQuote = true;
        }

        //  ENiGMA's cursor is where the art left the terminal's
        if (st.known) {
            st.row = st.term.row;
            st.col = st.term.col;
        }

        const result = Buffer.from(out);
        out = null;
        return result;
    }

    //  Does |buf| put the cursor at a known place before anything that depends
    //  on where it was? (CLEAR first, after nothing but BELLs.)
    function clearsFirst(buf) {
        for (const b of buf) {
            if (Controls.bell !== b) {
                return Controls.clear === b;
            }
        }
        return false;
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

    function reset() {
        st = freshState();
    }

    function state() {
        return {
            cols: geo.cols,
            rows: geo.rows,
            quoted: geo.quoted,
            known: st.known,
            row: st.row,
            col: st.col,
            wrapPending: st.wrap,
            terminalRow: st.term.row,
            terminalCol: st.term.col,
            inverse: wantInverse(),
            conceal: st.conceal,
            heldBottomRight: null !== st.deferred,
        };
    }

    return {
        identity: false,
        translate,
        passThrough,
        writeNative,
        setSize,
        reset,
        state,
    };
}

module.exports = { createAtasciiTranslator, MAX_COLS, MAX_ROWS, PORTABLE };
