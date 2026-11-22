'use strict';

//  ENiGMA½
const { ANSIEscapeParser } = require('./ansi_escape_parser.js');
const ansi = require('./ansi_term.js');
const { pipeToAnsi } = require('./color_codes.js');

//  deps
const _ = require('lodash');

//
//  AnsiCanvas -- a width x height grid of cells, each a character and the
//  SGR it is drawn in, filled by drawing ANSI (or pipe coded) content off
//  screen. It is drawn with the parser art.display() uses
//  (ANSIEscapeParser), so cursor movement, SGR, MCI replacement and iCE
//  are taken the same way, and what lands in a cell is what the terminal
//  would show there.
//
//  core/ansi_prep.js also fills a grid from art, but for re-serializing
//  (export, the message body): it keeps only where the SGR changes, and its
//  rows, fill and line ends are shaped for that output. A cell here holds
//  its whole SGR, so two cells, or two canvases, compare directly
//  (core/ansi_diff.js).
//
//  Cells: |char| is one character (as decoded: Unicode, not CP437 bytes)
//  and |attr| is the cell's whole SGR, as one canonical sequence that
//  starts from a reset (ESC[0;1;34m; ESC[0m for the default), so a cell
//  can be drawn without knowing what the terminal was set to before.
//  Rows and columns are 0-based here.
//

const DEFAULT_ATTR = ansi.sgr([0]);
const BLANK = ' ';

//  the canonical attr for a parser graphic rendition, shared per value
const attrCache = new Map();

function attrOf(gr) {
    const parts = [0];
    if (gr) {
        if (1 === gr.intensity || 2 === gr.intensity) {
            parts.push(gr.intensity);
        }
        if (4 === gr.underline) {
            parts.push(4);
        }
        if (5 === gr.blink || 6 === gr.blink) {
            parts.push(5);
        }
        if (7 === gr.negative) {
            parts.push(7);
        }
        if (8 === gr.invisible) {
            parts.push(8);
        }
        if (gr.fg && 39 !== gr.fg) {
            parts.push(gr.fg);
        }
        if (gr.bg && 49 !== gr.bg) {
            parts.push(gr.bg);
        }
    }
    const key = parts.join(';');
    let attr = attrCache.get(key);
    if (!attr) {
        attr = ansi.sgr(parts);
        attrCache.set(key, attr);
    }
    return attr;
}

//  The attr an erase leaves: the current background, nothing else
function eraseAttrOf(gr) {
    return attrOf(gr && gr.bg ? { bg: gr.bg } : null);
}

//  SAUCE TInfo1 (character width), or null
function sauceWidth(sauce) {
    const width = Number(_.get(sauce, 'Character.characterWidth'));
    return width > 0 ? width : null;
}

function sauceIceColors(sauce) {
    return Boolean(sauce && sauce.ansiFlags & (1 << 0));
}

class AnsiCanvas {
    constructor(width, height, options = {}) {
        this.width = Math.max(0, Math.floor(width) || 0);
        this.height = 0;
        this.chars = [];
        this.attrs = [];
        this.iceColors = Boolean(options.iceColors);
        this._resize(Math.max(0, Math.floor(height) || 0));
    }

    _resize(height) {
        while (this.chars.length < height) {
            this.chars.push(new Array(this.width).fill(BLANK));
            this.attrs.push(new Array(this.width).fill(DEFAULT_ATTR));
        }
        this.chars.length = height;
        this.attrs.length = height;
        this.height = height;
    }

    inBounds(row, col) {
        return row >= 0 && col >= 0 && row < this.height && col < this.width;
    }

    getChar(row, col) {
        return this.inBounds(row, col) ? this.chars[row][col] : null;
    }

    getAttr(row, col) {
        return this.inBounds(row, col) ? this.attrs[row][col] : null;
    }

    //  { char, attr } at |row|, |col|, or null outside the canvas
    get(row, col) {
        return this.inBounds(row, col)
            ? { char: this.chars[row][col], attr: this.attrs[row][col] }
            : null;
    }

    set(row, col, char, attr = DEFAULT_ATTR) {
        if (this.inBounds(row, col)) {
            this.chars[row][col] = char;
            this.attrs[row][col] = attr;
        }
    }

    //
    //  A new canvas of exactly |width| x |height|, copied from this one
    //  starting at |row|, |col|: what lies outside this canvas is blank. So
    //  it both clips (a frame larger than its box) and pads (a smaller one).
    //
    crop({ row = 0, col = 0, width = this.width, height = this.height } = {}) {
        const out = new AnsiCanvas(width, height, { iceColors: this.iceColors });
        for (let r = 0; r < out.height; ++r) {
            const srcRow = row + r;
            if (srcRow < 0 || srcRow >= this.height) {
                continue;
            }
            for (let c = 0; c < out.width; ++c) {
                const srcCol = col + c;
                if (srcCol >= 0 && srcCol < this.width) {
                    out.chars[r][c] = this.chars[srcRow][srcCol];
                    out.attrs[r][c] = this.attrs[srcRow][srcCol];
                }
            }
        }
        return out;
    }

    //  Same size and the same cells
    equals(other) {
        if (!other || other.width !== this.width || other.height !== this.height) {
            return false;
        }
        for (let r = 0; r < this.height; ++r) {
            for (let c = 0; c < this.width; ++c) {
                if (
                    this.chars[r][c] !== other.chars[r][c] ||
                    this.attrs[r][c] !== other.attrs[r][c]
                ) {
                    return false;
                }
            }
        }
        return true;
    }

    //
    //  ANSI drawn into a new canvas. |options|:
    //
    //  width           columns; default SAUCE TInfo1, else 80. Content
    //                  wraps at this width, as art at its width does.
    //  height          rows, or 'auto' (the default): as many as the
    //                  content draws (renderedRows). Content below a fixed
    //                  height is dropped and |truncated| set.
    //  sauce           the art's SAUCE record (getArtFromPath()), for the
    //                  width and iCE
    //  iceColors       blink is a bright background; default from SAUCE.
    //                  Kept on the canvas: cells keep blink in their attr,
    //                  and whoever draws the canvas sets the mode.
    //  wrap            'deferred' (the default): a character in the last
    //                  column wraps when the next one is drawn, so an
    //                  exactly-full line ended with CRLF takes one row.
    //                  'immediate': as art.display()'s parser does.
    //  mciReplaceChar  as for art.display(): MCI codes in the art are
    //                  drawn as this (default ' '); '' draws them as text
    //
    //  The result has:
    //  renderedRows    rows the content takes. Rows the cursor only passed
    //                  through count (blank lines); a trailing line break
    //                  adds none. A 0x1A ends the art (SAUCE after it adds
    //                  nothing); SAUCE TInfo2 is never used.
    //  truncated       content fell outside the canvas
    //  mci             [ { mci, id, position: [ row, col ] } ] as the art
    //                  parser reports them (1-based)
    //  warnings        strings: things drawn that a canvas does not model
    //
    static fromAnsi(input, options = {}) {
        const sauce = options.sauce;
        const width = options.width || sauceWidth(sauce) || 80;
        const autoHeight = !(options.height > 0);
        const iceColors = _.isBoolean(options.iceColors)
            ? options.iceColors
            : sauceIceColors(sauce);

        const canvas = new AnsiCanvas(width, autoHeight ? 0 : options.height, {
            iceColors,
        });
        canvas.renderedRows = 0;
        canvas.truncated = false;
        canvas.mci = [];
        canvas.warnings = [];

        const parser = new ANSIEscapeParser({
            mciReplaceChar: _.isString(options.mciReplaceChar)
                ? options.mciReplaceChar
                : BLANK,
            termWidth: width,
            //  never scrolls: art taller than a screen is drawn whole
            termHeight: 0x3fff,
            deferredWrap: 'immediate' !== options.wrap,
        });

        let row = 0;
        let col = 0;
        let attr = DEFAULT_ATTR;
        let maxWrittenRow = -1;
        let maxCursorRow = 0; //  rows above the cursor have been passed through
        const unsupported = new Set();

        //  Make |r| a row of the canvas, if the canvas may hold it
        const ensureRow = r => {
            if (r < canvas.height) {
                return true;
            }
            if (!autoHeight) {
                canvas.truncated = true;
                return false;
            }
            canvas._resize(r + 1);
            return true;
        };

        parser.on('position update', (r, c) => {
            row = r - 1;
            col = c - 1;
            maxCursorRow = Math.max(maxCursorRow, row);
        });

        parser.on('literal', literal => {
            //  line breaks come as position updates
            for (const ch of literal.replace(/\r?\n|[\r\u2028\u2029]/g, '')) {
                if (col < width) {
                    if (ensureRow(row)) {
                        canvas.chars[row][col] = ch;
                        canvas.attrs[row][col] = attr;
                        maxWrittenRow = Math.max(maxWrittenRow, row);
                    }
                } else {
                    canvas.truncated = true;
                }
                col += 1;
            }
        });

        parser.on('sgr update', gr => {
            attr = attrOf(gr);
        });

        parser.on('mci', info => {
            canvas.mci.push({
                mci: info.mci,
                id: info.id,
                position: info.position.slice(),
            });
            //  The replacement is drawn in the SGR the code had, and the
            //  terminal stays in it: what art.display() sends
            if (parser.mciReplaceChar.length > 0) {
                attr = attrOf(parser.graphicRenditionForErase);
            }
        });

        parser.on('clear screen', () => {
            for (let r = 0; r < canvas.height; ++r) {
                canvas.chars[r].fill(BLANK);
                canvas.attrs[r].fill(DEFAULT_ATTR);
            }
            maxWrittenRow = -1;
            maxCursorRow = 0;
        });

        //  ESC[J: rows already on the canvas only (the parser's screen is
        //  0x3fff rows tall)
        parser.on('erase rows', (startRow, endRow) => {
            const erase = eraseAttrOf(parser.graphicRendition);
            const last = Math.min(endRow - 1, canvas.height - 1);
            for (let r = Math.max(0, startRow - 1); r <= last; ++r) {
                canvas.chars[r].fill(BLANK);
                canvas.attrs[r].fill(erase);
            }
        });

        //  ESC[K: a line filled with its background counts as drawn
        parser.on('erase columns', (r, startCol, endCol) => {
            if (!ensureRow(r - 1)) {
                return;
            }
            const erase = eraseAttrOf(parser.graphicRendition);
            const last = Math.min(endCol, width) - 1;
            for (let c = Math.max(0, startCol - 1); c <= last; ++c) {
                canvas.chars[r - 1][c] = BLANK;
                canvas.attrs[r - 1][c] = erase;
            }
            maxWrittenRow = Math.max(maxWrittenRow, r - 1);
        });

        [
            'scroll',
            'insert line',
            'delete line',
            'insert columns',
            'delete columns',
        ].forEach(event => {
            parser.on(event, () => unsupported.add(event));
        });

        parser.parse(String(input || ''));

        canvas.renderedRows = Math.max(maxWrittenRow + 1, maxCursorRow);
        if (autoHeight) {
            canvas._resize(canvas.renderedRows);
        }
        unsupported.forEach(event => {
            canvas.warnings.push(`'${event}' is not drawn on a canvas; ignored`);
        });
        return canvas;
    }

    //
    //  Pipe coded text (|0B, |15, ...) drawn into a new canvas: converted by
    //  pipeToAnsi(), as views do, then fromAnsi(). Lines are separated by
    //  newlines. |options.client| resolves MCI and cursor codes, as for
    //  pipeToAnsi(); without one they are shown as text. Other options as
    //  for fromAnsi().
    //
    static fromPipe(input, options = {}) {
        return AnsiCanvas.fromAnsi(
            pipeToAnsi(String(input || ''), options.client),
            options
        );
    }

    //
    //  Art at |path|, read as art.display() reads it (getArtFromPath(),
    //  with SAUCE: the EOF marker, SAUCE and its comment block are not
    //  drawn), drawn into a new canvas. cb(err, canvas).
    //
    static fromFile(path, options, cb) {
        if (!cb && _.isFunction(options)) {
            cb = options;
            options = {};
        }
        //  late: art.js captures config.js's |get| when it is first required
        const { getArtFromPath } = require('./art.js');
        getArtFromPath(
            path,
            { readSauce: true, encodedAs: options.encodedAs },
            (err, artInfo) => {
                if (err) {
                    return cb(err);
                }
                let canvas;
                try {
                    canvas = AnsiCanvas.fromAnsi(
                        artInfo.data,
                        Object.assign({ sauce: artInfo.sauce }, options)
                    );
                } catch (e) {
                    return cb(e);
                }
                return cb(null, canvas);
            }
        );
    }
}

//
//  Frames cut from a sheet: frame i is rows [ i * (height + gap),
//  + height ) from the region origin, |width| columns wide. Frames stack
//  vertically (see "Frame sheets" in the design notes). |options|:
//
//  width, height   one frame's size (the view's box), required
//  row, col        1-based origin of frame 0 inside the sheet (default 1, 1)
//  gap             blank rows between frames (default 0)
//  frameCount      take at most this many frames
//
//  The frame count comes from the sheet's rendered rows, never from SAUCE.
//  A partial last frame is dropped, with a warning. Returns { frames,
//  warnings }; each frame is its own canvas, starting from a clean SGR
//  (every cell carries its whole SGR).
//
function sliceSheet(sheet, options = {}) {
    const width = Math.floor(options.width);
    const height = Math.floor(options.height);
    const warnings = [];
    if (!(width > 0) || !(height > 0)) {
        return { frames: [], warnings: ['Frame width and height are required'] };
    }

    const top = Math.max(1, Math.floor(options.row) || 1) - 1;
    const left = Math.max(1, Math.floor(options.col) || 1) - 1;
    const gap = Math.max(0, Math.floor(options.gap) || 0);
    const rows = _.isNumber(sheet.renderedRows) ? sheet.renderedRows : sheet.height;
    const available = Math.max(0, rows - top);

    //  n frames take n * height + (n - 1) * gap rows
    let count = Math.max(0, Math.floor((available + gap) / (height + gap)));
    const leftover = available - (count * (height + gap) - (count > 0 ? gap : 0));

    const cap = Math.floor(options.frameCount);
    if (cap > 0 && cap < count) {
        count = cap; //  rows past the frames wanted (notes below them) are ignored
    } else {
        if (leftover > gap || (0 === count && available > 0)) {
            const partial = 0 === count ? available : leftover - gap;
            warnings.push(
                `Sheet has a partial frame (${partial} of ${height} rows) after ` +
                    `${count} frame(s); dropped`
            );
        }
        if (cap > count) {
            warnings.push(`Sheet has ${count} frame(s), fewer than frameCount ${cap}`);
        }
    }

    if (left + width > sheet.width) {
        warnings.push(
            `Frames (columns ${left + 1}-${left + width}) extend past the ` +
                `sheet's ${sheet.width} columns; clipped`
        );
    }

    const frames = [];
    for (let i = 0; i < count; ++i) {
        frames.push(
            sheet.crop({ row: top + i * (height + gap), col: left, width, height })
        );
    }
    return { frames, warnings };
}

//
//  Transparency for a set of frames of one size. A cell whose character is
//  |transparentChar| in every frame is never drawn (the art under it shows):
//  it is set in the returned |mask| (Uint8Array, row * width + col; 1 =
//  never drawn), which the diff writer takes. A cell transparent in only
//  some frames cannot be: it is drawn as fill (a space in the cell's
//  attr) in those frames, which are changed in place, and a warning says
//  so. Returns { mask, warnings }.
//
function applyTransparency(frames, transparentChar) {
    const warnings = [];
    if (!frames.length || !_.isString(transparentChar) || !transparentChar) {
        return { mask: null, warnings };
    }
    const { width, height } = frames[0];
    const mask = new Uint8Array(width * height);
    let partial = 0;
    let firstPartial = null;

    for (let r = 0; r < height; ++r) {
        for (let c = 0; c < width; ++c) {
            let transparent = 0;
            frames.forEach(frame => {
                if (transparentChar === frame.getChar(r, c)) {
                    ++transparent;
                }
            });
            if (transparent === frames.length) {
                mask[r * width + c] = 1;
            } else if (transparent > 0) {
                ++partial;
                if (!firstPartial) {
                    firstPartial = { row: r + 1, col: c + 1 };
                }
                frames.forEach(frame => {
                    if (transparentChar === frame.getChar(r, c)) {
                        frame.chars[r][c] = BLANK;
                    }
                });
            }
        }
    }

    if (partial > 0) {
        warnings.push(
            `${partial} cell(s) transparent in only some frames are drawn as fill ` +
                `(first at row ${firstPartial.row}, column ${firstPartial.col})`
        );
    }
    return { mask, warnings };
}

exports.AnsiCanvas = AnsiCanvas;
exports.sliceSheet = sliceSheet;
exports.applyTransparency = applyTransparency;
exports.attrOf = attrOf;
exports.DEFAULT_ATTR = DEFAULT_ATTR;
