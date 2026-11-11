/* jslint node: true */
'use strict';

//
//  PETSCII screen rules (#593): what a Commodore PETSCII terminal does with
//  each byte it is sent, as far as the cursor, colour, reverse video and the
//  character set go. Screen contents are not modelled.
//
//  Shared by the output translator (which follows the terminal while it
//  writes, ./output_translator.js) and the native art parser (which walks a
//  .seq file to find where its MCI codes land, ./art_parser.js), so the two
//  can never disagree about where the cursor is.
//
//  No ENiGMA imports on purpose (only ./charset.js).
//
//      const s = createScreenState();          //  { row, col, color, reverse, charset }
//      const fx = applyByte(s, byte, cols, rows);
//      if (fx & Effect.Scrolled) ...
//
//  Rows and columns are 0-based. |color| is a PETSCII colour byte, |reverse| a
//  boolean and |charset| a charset.js Charsets value; any of them may be null
//  (unknown) until a byte sets it.
//
//  THE RULES (SyncTERM src/conio/cterm.c / cterm_petscii.c, icy_tools
//  icy_parser_core/src/petscii.rs, the C64 KERNAL screen editor)
//  ------------------------------------------------------------------------
//  glyph       any byte that is not a control (0x20-0x7F, 0xA0-0xFF) draws one
//              cell. Writing the last column wraps AT ONCE to column 0 of the
//              next row; on the bottom row that scrolls the screen up.
//  0x0D        RETURN: column 0 of the next row (scrolls on the bottom row),
//              reverse off.
//  0x8D        shift-RETURN: as RETURN, reverse unchanged.
//  0x11        DOWN: next row; scrolls on the bottom row (C64, SyncTERM; icy
//              clamps instead).
//  0x91        UP: previous row, clamped at the top.
//  0x1D        RIGHT: next column; from the last column to column 0 of the
//              next row, and from the bottom-right cell that scrolls (C64).
//  0x9D, 0x14  LEFT, DELETE: previous column; from column 0 to the last column
//              of the row above; nothing at HOME. (DELETE also pulls the rest
//              of the row left; contents are not modelled.)
//  0x94        INSERT: the cursor stays; the rest of the row moves right.
//  0x13        HOME: row 0, column 0.
//  0x93        CLEAR: clears the screen and homes. Colour, reverse and the
//              character set are kept.
//  0x12, 0x92  reverse on, off.
//  0x0E, 0x8E  lower/upper, upper/graphics character set (whole screen).
//  colours     the 16 colour bytes (charset.js Colors) set the colour.
//  others      every other control byte (0x0A, 0x07, ...) is ignored.
//
//  The translator never sends DOWN on the bottom row or RIGHT from the
//  bottom-right cell, so the terminals' disagreement there does not reach it;
//  in native art those are the artist's choice, taken here as the C64 does.
//
const { Charsets, Controls, AnsiToPetsciiColor, isControlByte } = require('./charset.js');

const COLOR_BYTES = new Set(AnsiToPetsciiColor);

//  flags returned by applyByte()
const Effect = Object.freeze({
    None: 0,
    Glyph: 1, //  a cell was drawn
    Scrolled: 2, //  the screen scrolled up one row
    Cleared: 4, //  the screen was cleared
    Homed: 8, //  the cursor is at a known place whatever it was before (HOME, CLEAR)
    Inserted: 16, //  INSERT: the row from the cursor moved right one cell
});

function createScreenState({
    row = 0,
    col = 0,
    color = null,
    reverse = null,
    charset = null,
} = {}) {
    return { row, col, color, reverse, charset };
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

function left(s, cols) {
    if (s.col > 0) {
        --s.col;
    } else if (s.row > 0) {
        s.col = cols - 1;
        --s.row;
    }
}

//  Apply what the terminal does with |b| to |s|; returns Effect flags.
function applyByte(s, b, cols, rows) {
    if (!isControlByte(b)) {
        if (++s.col < cols) {
            return Effect.Glyph;
        }
        s.col = 0;
        return Effect.Glyph | nextRow(s, rows);
    }

    switch (b) {
        case Controls.return:
            s.reverse = false;
            s.col = 0;
            return nextRow(s, rows);
        case Controls.shiftReturn:
            s.col = 0;
            return nextRow(s, rows);
        case Controls.cursorDown:
            return nextRow(s, rows);
        case Controls.cursorUp:
            if (s.row > 0) {
                --s.row;
            }
            return Effect.None;
        case Controls.cursorRight:
            if (++s.col < cols) {
                return Effect.None;
            }
            s.col = 0;
            return nextRow(s, rows);
        case Controls.cursorLeft:
        case Controls.delete:
            left(s, cols);
            return Effect.None;
        case Controls.insert:
            return Effect.Inserted;
        case Controls.home:
            s.row = 0;
            s.col = 0;
            return Effect.Homed;
        case Controls.clear:
            s.row = 0;
            s.col = 0;
            return Effect.Cleared | Effect.Homed;
        case Controls.reverseOn:
            s.reverse = true;
            return Effect.None;
        case Controls.reverseOff:
            s.reverse = false;
            return Effect.None;
        case Controls.charsetLower:
            s.charset = Charsets.LowerUpper;
            return Effect.None;
        case Controls.charsetUpper:
            s.charset = Charsets.UpperGraphics;
            return Effect.None;
    }

    if (COLOR_BYTES.has(b)) {
        s.color = b;
    }
    return Effect.None;
}

module.exports = { Effect, createScreenState, applyByte };
