/* jslint node: true */
'use strict';

//
//  Native PETSCII art parser (#593): the counterpart of
//  core/ansi_escape_parser.js for .seq art (Commodore sequential files as
//  PETSCII editors and C64 BBS software write them).
//
//  It walks the art's bytes with a tracked cursor on a cols x rows screen,
//  using the same rules as the output translator (./screen_rules.js), and
//  emits what art.display() needs, with the event names and payloads of
//  ANSIEscapeParser:
//
//      'literal'        (Buffer)  a run of glyph bytes, as they are
//      'control'        (Buffer)  a run of control bytes, as they are
//      'mci'            ({ position: [row, col], mci, id, args, SGR, petscii })
//                       an MCI code found at 1-based |position|; the code's bytes
//                       are not emitted: |mciReplaceChar| (a byte per character
//                       of the code) goes out in their place, or the code's own
//                       bytes when |mciReplaceChar| is ''
//      'clear screen'   ()        CLR (0x93)
//      'scroll'         (1)       the screen scrolled up a row
//      'insert columns' (row, col, 1)  INSERT (0x94)
//      'complete'       ({ row, column, extent })  final 1-based cursor
//                       position; |extent| is { rows, cols }, the furthest row
//                       and column a glyph was drawn in
//
//  |row| and |column| are also kept on the parser (1-based), as on
//  ANSIEscapeParser.
//
//  MCI CODES are ordinary characters in the art (%TL1, %VM1(2,3), ...). The
//  artist may have typed the letters shifted or not, so in the lower/upper
//  set they may be lower case: for this type they match case-insensitively
//  and the code is reported upper case. Letters are recognised by what the
//  byte draws in the character set in effect at that point (charset.js), so
//  in upper/graphics a shifted letter is a graphic and never part of a code.
//
//  COLOUR AT AN MCI CODE is reported two ways: |petscii| { color, reverse,
//  charset } as the art has it, and |SGR|, an ANSI SGR sequence that the
//  output translator turns back into exactly that colour and reverse state
//  (the inverse of charset.js AnsiToPetsciiColor; bright colours as bold),
//  which is what a view uses as its style. PETSCII has no background colour,
//  blink or underline, so there is nothing more to carry. The character set
//  cannot be part of a view's style: it is screen-wide. Until the art sets a
//  colour, light grey (the translator's default) is assumed.
//
//  No ENiGMA imports on purpose (only ./charset.js, ./screen_rules.js and
//  Node built-ins).
//
const { EventEmitter } = require('events');

const {
    DEFAULT_CHARSET,
    Colors,
    Controls,
    AnsiToPetsciiColor,
    isControlByte,
    byteToUnicode,
    unicodeToByte,
} = require('./charset.js');
const { Effect, createScreenState, applyByte } = require('./screen_rules.js');

const PERCENT = 0x25;
const SPACE = 0x20;
const MCI_RE = /^%([A-Za-z]{2})([0-9]{1,2})?(?:\(([0-9A-Za-z,]+)\))*/;
const MCI_MAX_LENGTH = 64; //  bytes looked at for one code
const DEFAULT_COLOR = Colors.lightGrey;

const PETSCII_TO_ANSI = new Map(AnsiToPetsciiColor.map((byte, idx) => [byte, idx]));

//  ANSI SGR that the output translator maps back to |color| + |reverse|
function sgrFor(color, reverse) {
    const idx = PETSCII_TO_ANSI.has(color) ? PETSCII_TO_ANSI.get(color) : 7;
    const params = [0];
    if (idx >= 8) {
        params.push(1);
    }
    params.push(30 + (idx & 7));
    if (reverse) {
        params.push(7);
    }
    return `\x1b[${params.join(';')}m`;
}

function isReturn(b) {
    return Controls.return === b || Controls.shiftReturn === b;
}

class PetsciiArtParser extends EventEmitter {
    //
    //  options:
    //      termWidth, termHeight   screen size (default 40 x 25)
    //      startRow                1-based row the art starts on (default 1)
    //      mciReplaceChar          what replaces each character of an MCI code
    //                              (default ''; art.display passes ' ')
    //      charset                 character set the art starts in
    //                              (charset.js Charsets; default lower/upper)
    //      trailingLF              'default' | 'omit' | 'no' | false | 'yes':
    //                              as ANSIEscapeParser, for a final RETURN.
    //                              'default' drops it when it would scroll
    //
    constructor(options = {}) {
        super();
        this.termWidth = options.termWidth > 0 ? options.termWidth : 40;
        this.termHeight = options.termHeight > 0 ? options.termHeight : 25;
        this.startRow = options.startRow;
        this.mciReplaceChar =
            undefined === options.mciReplaceChar ? '' : String(options.mciReplaceChar);
        this.charset = undefined === options.charset ? DEFAULT_CHARSET : options.charset;
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
        this.state = createScreenState({
            row: Math.max(startRow, 1) - 1,
            col: 0,
            color: DEFAULT_COLOR,
            reverse: false,
            charset: this.charset,
        });
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
        let end = buf.length;
        const finalReturn = end > 0 && isReturn(buf[end - 1]);
        if (finalReturn) {
            --end;
        }

        let pos = 0;
        for (let i = 0; i < end; ++i) {
            if (this.stopped) {
                return;
            }
            if (PERCENT !== buf[i]) {
                continue;
            }
            //  the character set at |i| depends on everything before it
            this._advance(buf, pos, i);
            pos = i;

            const mci = this._matchMci(buf, i, end);
            if (mci) {
                this._mci(mci, buf, i);
                i += mci.length - 1;
                pos = i + 1;
            }
        }
        this._advance(buf, pos, end);

        if (finalReturn && this._keepFinalReturn()) {
            this._advance(buf, end, end + 1);
        }

        this.emit('complete', {
            row: this.row,
            column: this.column,
            extent: Object.assign({}, this.extent),
        });
    }

    _keepFinalReturn() {
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

    //  Apply buf[from, to) to the screen, emitting runs and screen events.
    _advance(buf, from, to) {
        let runStart = from;
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

        for (let i = from; i < to; ++i) {
            const b = buf[i];
            const isControl = isControlByte(b);
            if (isControl !== runIsControl) {
                flush(i);
                runIsControl = isControl;
            }

            const { row, col } = this.state;
            const fx = applyByte(this.state, b, this.termWidth, this.termHeight);

            if (fx & Effect.Glyph) {
                this.extent.rows = Math.max(this.extent.rows, row + 1);
                this.extent.cols = Math.max(this.extent.cols, col + 1);
            }

            if (fx & (Effect.Cleared | Effect.Scrolled | Effect.Inserted)) {
                flush(i + 1);
                if (fx & Effect.Cleared) {
                    this.emit('clear screen');
                }
                if (fx & Effect.Scrolled) {
                    this.emit('scroll', 1);
                }
                if (fx & Effect.Inserted) {
                    this.emit('insert columns', row + 1, col + 1, 1);
                }
            }
        }
        flush(to);
    }

    //  An MCI code starting at buf[at] (a '%'), or null.
    _matchMci(buf, at, end) {
        const stop = Math.min(end, at + MCI_MAX_LENGTH);
        let text = '';
        for (let i = at; i < stop && !isControlByte(buf[i]); ++i) {
            text += byteToUnicode(buf[i], this.state.charset);
        }
        const m = MCI_RE.exec(text);
        if (!m) {
            return null;
        }
        return {
            length: m[0].length, //  one UTF-16 unit per byte (charset.js)
            mci: m[1].toUpperCase(),
            id: m[2] ? parseInt(m[2], 10) : null,
            args: m[3] ? m[3].split(',') : [],
        };
    }

    _mci(mci, buf, at) {
        const { color, reverse, charset } = this.state;
        this.emit('mci', {
            position: [this.row, this.column],
            mci: mci.mci,
            id: mci.id,
            args: mci.args,
            SGR: sgrFor(color, reverse),
            petscii: { color, reverse, charset },
        });

        let replacement;
        if (this.mciReplaceChar.length > 0) {
            let byte = unicodeToByte(this.mciReplaceChar.charAt(0), charset);
            if (undefined === byte || isControlByte(byte)) {
                byte = SPACE;
            }
            replacement = Buffer.alloc(mci.length, byte);
        } else {
            replacement = buf.slice(at, at + mci.length);
        }
        this._advance(replacement, 0, replacement.length);
    }
}

//
//  .seq art as plain Unicode text, for anything that cannot show it natively
//  (an ANSI session, or a caller that wants text to embed). Glyphs are decoded
//  in the character set in effect; RETURN and the screen's own wrap at |cols|
//  become CRLF; RIGHT becomes a space; every other control (colour, reverse,
//  cursor, clear) is dropped, so nothing in the result drives a terminal.
//
function petsciiArtToText(bytes, { charset = DEFAULT_CHARSET, cols = 40 } = {}) {
    const state = createScreenState({ charset });
    const rows = Number.MAX_SAFE_INTEGER; //  never scrolls: only rows are counted
    let text = '';
    for (const b of bytes) {
        const before = state.row;
        const glyph = byteToUnicode(b, state.charset);
        applyByte(state, b, cols, rows);
        if (!isControlByte(b)) {
            text += glyph;
        } else if (Controls.cursorRight === b && state.row === before) {
            text += ' ';
        }
        if (
            state.row > before &&
            (isReturn(b) || !isControlByte(b) || Controls.cursorRight === b)
        ) {
            text += '\r\n';
        }
    }
    return text;
}

module.exports = { PetsciiArtParser, petsciiArtToText, sgrFor };
