/* jslint node: true */
'use strict';

//
//  ATASCII screen rules (#593): what an Atari 8-bit ATASCII terminal does with
//  each byte it is sent, as far as the cursor, the ESC quote and the tab stops
//  go. Screen contents are not modelled; the Effect flags say when they change.
//
//  Shared by the output translator (which follows the terminal while it
//  writes, ./output_translator.js) and a later native art parser (which walks
//  an .ata file to find where its MCI codes land), so the two can never
//  disagree about where the cursor is.
//
//  No ENiGMA imports on purpose (only ./charset.js).
//
//      const s = createScreenState();          //  { row, col, quote, tabs }
//      const fx = applyByte(s, byte, cols, rows);
//      if (fx & Effect.Scrolled) ...
//
//  Rows and columns are 0-based. |quote| is true right after an ESC (the next
//  byte is drawn, not acted on). |tabs| is null for the default stops (every
//  8 columns) or a Set of columns once a set/clear tab byte has been seen.
//
//  THE RULES (SyncTERM src/conio/cterm_atascii.c + cterm.c; icy_tools
//  icy_parser_core/src/atascii.rs + icy_engine/src/screen.rs; see the
//  "ATASCII facts" entry of the project notes)
//  ------------------------------------------------------------------------
//  glyph       every byte that is not a control byte (charset.js Controls) draws
//              one cell; bit 7 is inverse video. Writing the last column wraps AT
//              ONCE to column 0 of the next row; on the bottom row that scrolls
//              the screen up (both emulators).
//  0x1B        ESC: the next byte is drawn as a glyph whatever it is, except
//              0x9B, which stays an end of line (SyncTERM, real Atari; icy draws a
//              glyph for it). ESC ESC draws the escape glyph.
//  0x1C 0x1D   UP, DOWN: SyncTERM wraps to the other edge of the same column, no
//              scroll; icy clamps at the edge.
//  0x1E 0x1F   LEFT, RIGHT: SyncTERM wraps to the other edge of the same row; icy
//              goes to the end of the row above (nothing on the top row) and to
//              column 0 of the next row (scrolling on the bottom row).
//              The rules below follow SyncTERM at all four edges. The output
//              translator never sends a move at an edge while it knows where the
//              cursor is, so the disagreement does not reach it.
//  0x7D        CLEAR: clears the screen and homes (both).
//  0x7E        BACKSPACE: SyncTERM moves left and blanks the cell, nothing at
//              column 0; icy only moves left. Never sent by the translator.
//  0x7F        TAB: the next tab stop to the right; with none left, column 0 of
//              the next row (scrolling on the bottom row). Default stops every 8
//              columns; a caller's terminal can change them (0x9E / 0x9F, or by
//              hand), so the translator never sends it.
//  0x9B        END OF LINE: column 0 of the next row; scrolls on the bottom row.
//  0x9C        DELETE LINE: the row is removed, rows below move up (SyncTERM puts
//              the cursor in column 0).
//  0x9D        INSERT LINE: rows from the cursor move down, a blank row is opened
//              (SyncTERM: cursor to column 0).
//  0x9E 0x9F   CLEAR TAB, SET TAB at the cursor column.
//  0xFD        BELL: no screen effect.
//  0xFE        DELETE CHARACTER: the rest of the row moves left, cursor stays.
//  0xFF        INSERT CHARACTER: the rest of the row moves right, cursor stays.
//
//  A real Atari's E: device also has logical lines (a row written past its end
//  joins the next, and END OF LINE / scrolling act on the whole logical line)
//  and a 2-column left margin. Neither emulator models either; nor does this.
//
const { Controls, isControlByte } = require('./charset.js');

const TAB_WIDTH = 8;

//  flags returned by applyByte()
const Effect = Object.freeze({
    None: 0,
    Glyph: 1, //  a cell was drawn (quoted or not)
    Scrolled: 2, //  the screen scrolled up one row
    Cleared: 4, //  the screen was cleared
    Homed: 8, //  the cursor is at a known place whatever it was before (CLEAR)
    Edited: 16, //  contents moved or were blanked (backspace, insert/delete line/char)
    Bell: 32,
});

function createScreenState({ row = 0, col = 0, quote = false, tabs = null } = {}) {
    return { row, col, quote, tabs };
}

//  next row, scrolling on the bottom one
function nextRow(s, rows) {
    if (s.row < rows - 1) {
        ++s.row;
        return Effect.None;
    }
    s.row = rows - 1;
    return Effect.Scrolled;
}

function draw(s, cols, rows) {
    if (++s.col < cols) {
        return Effect.Glyph;
    }
    s.col = 0;
    return Effect.Glyph | nextRow(s, rows);
}

function tabStops(s, cols) {
    if (null === s.tabs) {
        s.tabs = new Set();
        for (let c = 0; c < cols; c += TAB_WIDTH) {
            s.tabs.add(c);
        }
    }
    return s.tabs;
}

function nextTabStop(s, cols) {
    let best = null;
    if (null === s.tabs) {
        const c = (Math.floor(s.col / TAB_WIDTH) + 1) * TAB_WIDTH;
        return c < cols ? c : null;
    }
    for (const c of s.tabs) {
        if (c > s.col && c < cols && (null === best || c < best)) {
            best = c;
        }
    }
    return best;
}

//  Apply what the terminal does with |b| to |s|; returns Effect flags.
function applyByte(s, b, cols, rows) {
    if (s.quote) {
        s.quote = false;
        if (Controls.eol === b) {
            s.col = 0;
            return nextRow(s, rows);
        }
        return draw(s, cols, rows);
    }

    if (!isControlByte(b)) {
        return draw(s, cols, rows);
    }

    switch (b) {
        case Controls.escape:
            s.quote = true;
            return Effect.None;
        case Controls.cursorUp:
            s.row = s.row > 0 ? s.row - 1 : rows - 1;
            return Effect.None;
        case Controls.cursorDown:
            s.row = s.row < rows - 1 ? s.row + 1 : 0;
            return Effect.None;
        case Controls.cursorLeft:
            s.col = s.col > 0 ? s.col - 1 : cols - 1;
            return Effect.None;
        case Controls.cursorRight:
            s.col = s.col < cols - 1 ? s.col + 1 : 0;
            return Effect.None;
        case Controls.clear:
            s.row = 0;
            s.col = 0;
            return Effect.Cleared | Effect.Homed;
        case Controls.backspace:
            if (s.col > 0) {
                --s.col;
                return Effect.Edited;
            }
            return Effect.None;
        case Controls.tab: {
            const stop = nextTabStop(s, cols);
            if (null !== stop) {
                s.col = stop;
                return Effect.None;
            }
            s.col = 0;
            return nextRow(s, rows);
        }
        case Controls.eol:
            s.col = 0;
            return nextRow(s, rows);
        case Controls.deleteLine:
        case Controls.insertLine:
            s.col = 0;
            return Effect.Edited;
        case Controls.clearTab:
            tabStops(s, cols).delete(s.col);
            return Effect.None;
        case Controls.setTab:
            tabStops(s, cols).add(s.col);
            return Effect.None;
        case Controls.bell:
            return Effect.Bell;
        case Controls.deleteChar:
        case Controls.insertChar:
            return Effect.Edited;
    }
    return Effect.None; //  not reached: every control byte is handled above
}

module.exports = { Effect, createScreenState, applyByte, TAB_WIDTH };
