/* jslint node: true */
'use strict';

//
//  Native ATASCII art parser (#593): the counterpart of
//  core/ansi_escape_parser.js for .ata art (raw ATASCII streams, as Icy Draw
//  saves them and Atari BBS software sends them).
//
//  It walks the art's bytes with a tracked cursor on a cols x rows screen,
//  using the same rules as the output translator (./screen_rules.js), and
//  emits what art.display() needs, with the event names and payloads of
//  ANSIEscapeParser (and ../petscii/art_parser.js):
//
//      'literal'        (Buffer)  a run of glyph cells, as they are (an
//                                 ESC-quoted glyph is its two bytes)
//      'control'        (Buffer)  a run of control bytes, as they are
//      'mci'            ({ position: [row, col], mci, id, args, SGR, atascii })
//                       an MCI code found at 1-based |position|; the code's bytes
//                       are not emitted: |mciReplaceChar| (one byte per cell of
//                       the code, in that cell's inverse state) goes out in their
//                       place, or the code's own bytes when |mciReplaceChar| is ''
//      'clear screen'   ()        CLEAR (0x7D)
//      'scroll'         (1)       the screen scrolled up a row
//      'delete line'    (row, 1)  DELETE LINE (0x9C)
//      'erase row'      (rows, rows) then 'insert line' (row, 1)
//                                 INSERT LINE (0x9D): the bottom row is lost,
//                                 rows from the cursor move down
//      'insert columns' (row, col, 1)  INSERT CHARACTER (0xFF)
//      'delete columns' (row, col, 1)  DELETE CHARACTER (0xFE): the rest of the
//                                 row moves left
//      'complete'       ({ row, column, extent })  final 1-based cursor
//                       position; |extent| is { rows, cols }, the furthest row
//                       and column a glyph was drawn in
//
//  |row| and |column| are also kept on the parser (1-based), as on
//  ANSIEscapeParser.
//
//  CELLS, NOT BYTES. ESC (0x1B) makes the next byte a glyph whatever it is, so
//  the art is first cut into units: a glyph byte, ESC + byte (one glyph cell;
//  ESC + 0x9B is still an end of line, as on a real Atari and in SyncTERM), or
//  a control byte. An ESC that is the last byte of the file quotes nothing: it
//  is dropped, so it cannot swallow the first byte ENiGMA writes after the art.
//
//  MCI CODES are ordinary characters in the art (%TL1, %VM1(2,3), ...), matched
//  on what each cell draws whatever its inverse bit (an artist may type a code
//  inside an inverse bar) and in either letter case (reported upper case). A
//  code is a run of glyph cells: a control byte, an end of line included, ends
//  it.
//
//  INVERSE AT AN MCI CODE is the inverse bit of the code's first cell, reported
//  as |atascii| { inverse } and as |SGR|: '\x1b[0;7m' or '\x1b[0m', which the
//  output translator turns back into exactly that state (ATASCII has nothing
//  else a view's style could carry: no colour). The replacement cells keep
//  the inverse bit of the cells they replace, so an inverse bar stays whole.
//
//  CURSOR BYTES AT AN EDGE wrap to the opposite edge of the same row or column,
//  as a real Atari and SyncTERM do (IcyTerm clamps). Art that moves the cursor
//  across an edge therefore looks different in IcyTerm, and positions after it
//  follow SyncTERM. TAB follows the default stops (every 8 columns) and any
//  SET / CLEAR TAB in the art; a caller's terminal may have stops of its own.
//  DELETE / INSERT LINE leave the cursor in column 0 (SyncTERM).
//
//  No ENiGMA imports on purpose (only ./charset.js, ./screen_rules.js and
//  Node built-ins).
//
const { EventEmitter } = require('events');

const {
    Controls,
    INVERSE_BIT,
    isControlByte,
    byteToUnicode,
    unicodeToByte,
    decodeCells,
} = require('./charset.js');
const { Effect, createScreenState, applyByte } = require('./screen_rules.js');

const SPACE = 0x20;
const MCI_RE = /^%([A-Za-z]{2})([0-9]{1,2})?(?:\(([0-9A-Za-z,]+)\))*/;
const MCI_MAX_CELLS = 64; //  cells looked at for one code

const SGR_NORMAL = '\x1b[0m';
const SGR_INVERSE = '\x1b[0;7m';

//  ANSI SGR that the output translator maps back to |inverse|
function sgrFor(inverse) {
    return inverse ? SGR_INVERSE : SGR_NORMAL;
}

//
//  The art cut into units { start, end, byte, glyph }: |byte| is what acts or
//  is drawn (the second byte of an ESC quote), |glyph| whether it draws a cell.
//  A dangling ESC at the very end is left out.
//
function unitsOf(buf) {
    const units = [];
    for (let i = 0; i < buf.length; ++i) {
        const b = buf[i];
        if (Controls.escape === b) {
            if (i + 1 >= buf.length) {
                break; //  quotes nothing
            }
            const q = buf[i + 1];
            units.push({ start: i, end: i + 2, byte: q, glyph: Controls.eol !== q });
            ++i;
            continue;
        }
        units.push({ start: i, end: i + 1, byte: b, glyph: !isControlByte(b) });
    }
    return units;
}

class AtasciiArtParser extends EventEmitter {
    //
    //  options:
    //      termWidth, termHeight   screen size (default 40 x 24)
    //      startRow                1-based row the art starts on (default 1)
    //      mciReplaceChar          what replaces each cell of an MCI code
    //                              (default ''; art.display passes ' ')
    //      trailingLF              'default' | 'omit' | 'no' | false | 'yes':
    //                              as ANSIEscapeParser, for a final END OF LINE.
    //                              'default' drops it when it would scroll
    //
    constructor(options = {}) {
        super();
        this.termWidth = options.termWidth > 0 ? options.termWidth : 40;
        this.termHeight = options.termHeight > 0 ? options.termHeight : 24;
        this.startRow = options.startRow;
        this.mciReplaceChar =
            undefined === options.mciReplaceChar ? '' : String(options.mciReplaceChar);
        this.trailingLF =
            undefined === options.trailingLF ? 'default' : options.trailingLF;
        this.reset(Buffer.alloc(0));
    }

    get row() {
        return this.state.row + 1;
    }

    get column() {
        return this.state.col + 1;
    }

    reset(input) {
        const startRow = Math.min(this.startRow || 1, this.termHeight);
        this.state = createScreenState({ row: Math.max(startRow, 1) - 1, col: 0 });
        this.extent = { rows: 0, cols: 0 };
        this.buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
        this.stopped = false;
    }

    stop() {
        this.stopped = true;
    }

    parse(input) {
        if (input) {
            this.reset(input);
        }
        this.stopped = false;

        const buf = this.buffer;
        const units = unitsOf(buf);
        let end = units.length;
        const finalEol = end > 0 && Controls.eol === units[end - 1].byte;
        if (finalEol) {
            --end;
        }

        let pos = 0;
        for (let i = 0; i < end; ++i) {
            if (this.stopped) {
                return;
            }
            if (!units[i].glyph || '%' !== byteToUnicode(units[i].byte)) {
                continue;
            }
            this._advance(buf, units, pos, i);
            pos = i;

            const mci = this._matchMci(units, i, end);
            if (mci) {
                this._mci(mci, buf, units, i);
                i += mci.cells - 1;
                pos = i + 1;
            }
        }
        this._advance(buf, units, pos, end);

        if (finalEol && this._keepFinalEol()) {
            this._advance(buf, units, end, end + 1);
        }

        this.emit('complete', {
            row: this.row,
            column: this.column,
            extent: Object.assign({}, this.extent),
        });
    }

    _keepFinalEol() {
        switch (this.trailingLF) {
            case 'default':
                return this.state.row < this.termHeight - 1;
            case 'omit':
            case 'no':
            case false:
                return false;
            default:
                return true;
        }
    }

    //  Apply units[from, to) to the screen, emitting runs and screen events.
    _advance(buf, units, from, to) {
        if (to <= from) {
            return;
        }
        let runStart = units[from].start;
        let runIsControl = null;

        const flush = upTo => {
            if (upTo > runStart) {
                this.emit(
                    runIsControl ? 'control' : 'literal',
                    buf.slice(runStart, upTo)
                );
            }
            runStart = upTo;
        };

        for (let u = from; u < to; ++u) {
            const unit = units[u];
            const isControl = !unit.glyph;
            if (isControl !== runIsControl) {
                flush(unit.start);
                runIsControl = isControl;
            }

            const { row, col } = this.state;
            let fx = Effect.None;
            for (let i = unit.start; i < unit.end; ++i) {
                fx |= applyByte(this.state, buf[i], this.termWidth, this.termHeight);
            }

            if (fx & Effect.Glyph) {
                this.extent.rows = Math.max(this.extent.rows, row + 1);
                this.extent.cols = Math.max(this.extent.cols, col + 1);
            }

            const edit = isControl && fx & Effect.Edited ? unit.byte : null;
            if (fx & (Effect.Cleared | Effect.Scrolled) || null !== edit) {
                flush(unit.end);
                if (fx & Effect.Cleared) {
                    this.emit('clear screen');
                }
                if (fx & Effect.Scrolled) {
                    this.emit('scroll', 1);
                }
                this._edited(edit, row, col);
            }
        }
        flush(units[to - 1].end);
    }

    //  What an edit byte did to the screen around (row, col), 0-based.
    _edited(b, row, col) {
        switch (b) {
            case Controls.deleteLine:
                this.emit('delete line', row + 1, 1);
                break;
            case Controls.insertLine:
                this.emit('erase row', this.termHeight, this.termHeight);
                this.emit('insert line', row + 1, 1);
                break;
            case Controls.insertChar:
                this.emit('insert columns', row + 1, col + 1, 1);
                break;
            case Controls.deleteChar:
                this.emit('delete columns', row + 1, col + 1, 1);
                break;
            //  BACKSPACE blanks a cell in SyncTERM only: nothing moves
        }
    }

    //  An MCI code starting at units[at] (a '%'), or null.
    _matchMci(units, at, end) {
        const stop = Math.min(end, at + MCI_MAX_CELLS);
        let text = '';
        for (let u = at; u < stop && units[u].glyph; ++u) {
            text += byteToUnicode(units[u].byte);
        }
        const m = MCI_RE.exec(text);
        if (!m) {
            return null;
        }
        return {
            cells: m[0].length, //  one UTF-16 unit per cell (charset.js)
            mci: m[1].toUpperCase(),
            id: m[2] ? parseInt(m[2], 10) : null,
            args: m[3] ? m[3].split(',') : [],
        };
    }

    _replacementByte(inverse) {
        let base = unicodeToByte(this.mciReplaceChar.charAt(0));
        if (undefined === base || isControlByte(base)) {
            base = SPACE;
        }
        const b = base | (inverse ? INVERSE_BIT : 0);
        return isControlByte(b) ? SPACE | (inverse ? INVERSE_BIT : 0) : b;
    }

    _mci(mci, buf, units, at) {
        const inverse = units[at].byte >= INVERSE_BIT;
        this.emit('mci', {
            position: [this.row, this.column],
            mci: mci.mci,
            id: mci.id,
            args: mci.args,
            SGR: sgrFor(inverse),
            atascii: { inverse },
        });

        const code = units.slice(at, at + mci.cells);
        let replacement;
        if (this.mciReplaceChar.length > 0) {
            replacement = Buffer.from(
                code.map(unit => this._replacementByte(unit.byte >= INVERSE_BIT))
            );
        } else {
            replacement = buf.slice(code[0].start, code[code.length - 1].end);
        }
        const replacementUnits = unitsOf(replacement);
        this._advance(replacement, replacementUnits, 0, replacementUnits.length);
    }
}

//
//  .ata art as plain Unicode text, for anything that cannot show it natively
//  (an ANSI or PETSCII session, or a caller that wants text to embed).
//  ESC-quoted glyphs are their characters; END OF LINE (quoted or not) and the
//  screen's own wrap at |cols| become CRLF; inverse video is dropped; every
//  other control byte (cursor, clear, tab, edits, bell) is dropped, so nothing
//  in the result drives a terminal.
//
function atasciiArtToText(bytes, { cols = 40 } = {}) {
    let text = '';
    let col = 0;
    for (const cell of decodeCells(bytes)) {
        if ('\n' === cell.char) {
            text += '\r\n';
            col = 0;
            continue;
        }
        text += cell.char;
        if (++col >= cols) {
            text += '\r\n';
            col = 0;
        }
    }
    return text;
}

module.exports = { AtasciiArtParser, atasciiArtToText, sgrFor };
