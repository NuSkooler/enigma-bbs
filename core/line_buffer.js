'use strict';

//
//  LineBuffer — low-level line storage with per-character Uint32 attribute
//  words.  No view dependencies; fully unit-testable in isolation.
//
//  Attribute word layout (32-bit unsigned):
//
//    [31:24]  fg color (0-255 ANSI palette index, or truecolor key)
//    [23:16]  bg color (0-255 ANSI palette index, or truecolor key)
//    [15]     bold
//    [14]     blink
//    [13]     underline
//    [12]     italic
//    [11]     strikethrough
//    [10:8]   colorSource  (see ColorSource enum)
//    [7]      TC_FG  — fg uses truecolor map entry
//    [6]      TC_BG  — bg uses truecolor map entry
//    [5:0]    reserved
//
//  Lines use soft (eol=false) or hard (eol=true) line-end markers.
//  Hard breaks originate from Enter key or explicit \n in source text.
//  Soft breaks are word-wrap artifacts and rejoin transparently.
//
//  A "paragraph" is a contiguous sequence of lines whose last member has
//  eol=true.  All other members have eol=false.
//

const ColorSource = Object.freeze({
    DEFAULT: 0,
    PIPE: 1,
    ANSI: 2,
    IMPORTED: 3,
    TRUECOLOR: 7,
});

//  ─── Attribute helpers ────────────────────────────────────────────────────────

//  makeAttr({ fg, bg, bold, blink, underline, italic, strikethrough,
//             colorSrc, tcFg, tcBg })  → Uint32
function makeAttr({
    fg = 7,
    bg = 0,
    bold = false,
    blink = false,
    underline = false,
    italic = false,
    strikethrough = false,
    colorSrc = ColorSource.DEFAULT,
    tcFg = false,
    tcBg = false,
} = {}) {
    //  Use multiplication for fg shift to avoid signed-integer issues with << 24
    return (
        (((fg & 0xff) * 0x1000000) | // bits 31:24
            ((bg & 0xff) << 16) | // bits 23:16
            (bold ? 1 << 15 : 0) |
            (blink ? 1 << 14 : 0) |
            (underline ? 1 << 13 : 0) |
            (italic ? 1 << 12 : 0) |
            (strikethrough ? 1 << 11 : 0) |
            ((colorSrc & 0x7) << 8) | // bits 10:8
            (tcFg ? 1 << 7 : 0) |
            (tcBg ? 1 << 6 : 0)) >>>
        0
    ); // coerce to unsigned 32-bit
}

//  parseAttr(attr)  → plain object (all fields)
function parseAttr(attr) {
    return {
        fg: (attr >>> 24) & 0xff,
        bg: (attr >>> 16) & 0xff,
        bold: !!(attr & (1 << 15)),
        blink: !!(attr & (1 << 14)),
        underline: !!(attr & (1 << 13)),
        italic: !!(attr & (1 << 12)),
        strikethrough: !!(attr & (1 << 11)),
        colorSrc: (attr >>> 8) & 0x7,
        tcFg: !!(attr & (1 << 7)),
        tcBg: !!(attr & (1 << 6)),
    };
}

function getFg(attr) {
    return (attr >>> 24) & 0xff;
}
function getBg(attr) {
    return (attr >>> 16) & 0xff;
}
function getColorSrc(attr) {
    return (attr >>> 8) & 0x7;
}

//  ─── Uint32Array helpers ──────────────────────────────────────────────────────

function u32Insert(arr, index, value) {
    const out = new Uint32Array(arr.length + 1);
    out.set(arr.subarray(0, index), 0);
    out[index] = value;
    out.set(arr.subarray(index), index + 1);
    return out;
}

function u32Delete(arr, index) {
    const out = new Uint32Array(arr.length - 1);
    out.set(arr.subarray(0, index), 0);
    out.set(arr.subarray(index + 1), index);
    return out;
}

function u32Concat(a, b) {
    const out = new Uint32Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

//  ─── Internal: word-wrap a flat string+attrs into line objects ────────────────

//  Matches ANSI escape sequences and |XX pipe color codes.
//  Used to measure visible (rendered) character width, skipping zero-width codes.
//  Group 1 captures the numeric argument of ESC[NC (cursor-forward), which
//  contributes that many visible columns.
const _WRAP_CODE_RE = /\x1b\[(?:([0-9]+)C|[0-9;]*[A-Za-z])|\|[0-9A-Z]{2}/g;

//  Returns the number of visible (rendered) characters in str,
//  skipping ANSI escape sequences and |XX pipe color codes.
function _visLen(str) {
    let len = 0;
    let pos = 0;
    _WRAP_CODE_RE.lastIndex = 0;
    let m;
    while ((m = _WRAP_CODE_RE.exec(str)) !== null) {
        len += m.index - pos;
        if (m[1]) len += parseInt(m[1], 10); //  ESC[NC cursor forward counts
        pos = m.index + m[0].length;
    }
    len += str.length - pos;
    return len;
}

//  Returns the string index at which `width` visible characters have been
//  consumed, skipping ANSI and pipe code bytes transparently.
function _splitPos(str, width) {
    let vis = 0;
    let i = 0;
    _WRAP_CODE_RE.lastIndex = 0;
    let m = _WRAP_CODE_RE.exec(str);
    while (i < str.length && vis < width) {
        if (m && m.index === i) {
            if (m[1]) {
                const fwd = parseInt(m[1], 10);
                if (vis + fwd >= width) break; //  this forward-move crosses the boundary
                vis += fwd;
            }
            i += m[0].length;
            m = _WRAP_CODE_RE.exec(str);
        } else {
            i++;
            vis++;
        }
    }
    return i;
}

//  _wrapText(text, attrs, width, hardEol)  → Line[]
//
//  Splits text at word boundaries (last space before width visible chars).
//  If no space is found in the window, breaks at the width boundary (hard
//  character wrap).  The space at the break point is consumed (not stored in
//  either line).  Non-final lines get eol=false; the final line gets
//  eol=hardEol.
//
//  Width is measured in visible (rendered) characters — ANSI escape sequences
//  and |XX pipe color codes are skipped and do not contribute to line length.
function _wrapText(text, attrs, width, hardEol) {
    if (text.length === 0) {
        return [{ chars: '', attrs: new Uint32Array(0), eol: hardEol, initialAttr: 0 }];
    }

    const lines = [];
    let pos = 0;

    while (pos < text.length) {
        const remaining = text.slice(pos);
        const remAttrs = attrs.slice(pos);

        if (_visLen(remaining) <= width) {
            lines.push({
                chars: remaining,
                attrs: remAttrs,
                eol: hardEol,
                initialAttr: remAttrs.length > 0 ? remAttrs[0] : 0,
            });
            break;
        }

        //  Find the last space within the first `width` visible chars
        const splitAt = _splitPos(remaining, width);
        const window = remaining.slice(0, splitAt);
        const lastSpace = window.lastIndexOf(' ');
        const wrapAt = lastSpace > 0 ? lastSpace : splitAt;

        lines.push({
            chars: remaining.slice(0, wrapAt),
            attrs: remAttrs.slice(0, wrapAt),
            eol: false,
            initialAttr: remAttrs.length > 0 ? remAttrs[0] : 0,
        });

        //  Consume the space at the break point (if that was the wrap reason)
        pos += wrapAt + (remaining[wrapAt] === ' ' ? 1 : 0);
    }

    return lines;
}

//  ─── LineBuffer ───────────────────────────────────────────────────────────────

class LineBuffer {
    constructor({ width = 79 } = {}) {
        this.width = width;
        this.lines = [
            { chars: '', attrs: new Uint32Array(0), eol: true, initialAttr: 0 },
        ];
    }

    //  ── Single-character mutations (no auto-wrap) ────────────────────────────

    //  insertChar(lineIndex, col, char, attr)
    //  Inserts one character at col within the given line.  Does NOT reflow.
    insertChar(lineIndex, col, char, attr = 0) {
        const line = this.lines[lineIndex];
        line.chars = line.chars.slice(0, col) + char + line.chars.slice(col);
        line.attrs = u32Insert(line.attrs, col, attr);
    }

    //  deleteChar(lineIndex, col)
    //  Removes the character at col from the given line.  Does NOT reflow.
    deleteChar(lineIndex, col) {
        const line = this.lines[lineIndex];
        line.chars = line.chars.slice(0, col) + line.chars.slice(col + 1);
        line.attrs = u32Delete(line.attrs, col);
    }

    //  ── Line structure mutations ─────────────────────────────────────────────

    //  splitLine(lineIndex, col)
    //  Splits the line at col, creating a hard break (Enter key semantics).
    //  The left portion keeps the current line; a new line is inserted after it
    //  with the right portion.  The left line's eol becomes true.
    splitLine(lineIndex, col) {
        const line = this.lines[lineIndex];
        const right = {
            chars: line.chars.slice(col),
            attrs: line.attrs.slice(col),
            eol: line.eol, // right half inherits the original break type
            initialAttr: col < line.attrs.length ? line.attrs[col] : line.initialAttr,
        };
        line.chars = line.chars.slice(0, col);
        line.attrs = line.attrs.slice(0, col);
        line.eol = true; // this is now a hard break
        this.lines.splice(lineIndex + 1, 0, right);
    }

    //  joinLines(lineIndex)
    //  Joins line at lineIndex with the line immediately after it (Backspace
    //  at column 0, or Delete at end of line).  The combined line inherits
    //  the eol of the next line.  No-op if lineIndex is the last line.
    joinLines(lineIndex) {
        if (lineIndex >= this.lines.length - 1) {
            return;
        }
        const line = this.lines[lineIndex];
        const next = this.lines[lineIndex + 1];
        line.chars = line.chars + next.chars;
        line.attrs = u32Concat(line.attrs, next.attrs);
        line.eol = next.eol;
        this.lines.splice(lineIndex + 1, 1);
    }

    //  ── Paragraph operations ────────────────────────────────────────────────

    //  _paragraphRange(lineIndex) → { start, end }
    //  Returns the index range of the paragraph that contains lineIndex.
    //  A paragraph is bounded by hard breaks (eol=true).
    _paragraphRange(lineIndex) {
        let start = lineIndex;
        //  Walk backward while the previous line is a soft wrap (eol=false)
        while (start > 0 && !this.lines[start - 1].eol) {
            start--;
        }

        let end = lineIndex;
        //  Walk forward while this line is a soft wrap (eol=false)
        while (end < this.lines.length - 1 && !this.lines[end].eol) {
            end++;
        }

        return { start, end };
    }

    //  rewrapParagraph(lineIndex) → { start, end }
    //  Re-wraps the paragraph containing lineIndex to fit within this.width.
    //  Soft-wrapped lines are rejoined (with a space) then re-split.
    //  Hard breaks are preserved.  Returns the new index range.
    rewrapParagraph(lineIndex) {
        const { start, end } = this._paragraphRange(lineIndex);
        const wasEol = this.lines[end].eol;

        //  Rejoin the paragraph: soft-wrapped lines are separated by a space
        //  (the space that was consumed at the wrap point).
        let allChars = '';
        let allAttrs = new Uint32Array(0);
        for (let i = start; i <= end; i++) {
            if (i > start) {
                //  Reinsert the stripped space; use attr of the preceding char
                const prevAttrs = this.lines[i - 1].attrs;
                const spaceAttr =
                    prevAttrs.length > 0 ? prevAttrs[prevAttrs.length - 1] : 0;
                allChars += ' ';
                allAttrs = u32Concat(allAttrs, new Uint32Array([spaceAttr]));
            }
            allChars += this.lines[i].chars;
            allAttrs = u32Concat(allAttrs, this.lines[i].attrs);
        }

        const newLines = _wrapText(allChars, allAttrs, this.width, wasEol);
        this.lines.splice(start, end - start + 1, ...newLines);

        return { start, end: start + newLines.length - 1 };
    }

    //  ── Bulk text operations ────────────────────────────────────────────────

    //  setText(text)
    //  Replaces buffer contents with plain text.  \n is a hard break; long
    //  lines are wrapped at word boundaries to fit within this.width.
    //  Attributes default to 0 for all characters.
    setText(text) {
        this.lines = [];
        const hardLines = text.split('\n');

        for (const hardLine of hardLines) {
            const attrs = new Uint32Array(hardLine.length);
            const wrapped = _wrapText(hardLine, attrs, this.width, true /* hardEol */);
            this.lines.push(...wrapped);
        }

        if (this.lines.length === 0) {
            this.lines.push({
                chars: '',
                attrs: new Uint32Array(0),
                eol: true,
                initialAttr: 0,
            });
        }
    }

    //  getText() → string
    //  Extracts plain text from the buffer.  Hard breaks become \n; the space
    //  consumed at soft-wrap points is reinserted.  No trailing \n is added
    //  for the very last line.
    getText() {
        const parts = [];
        for (let i = 0; i < this.lines.length; i++) {
            parts.push(this.lines[i].chars);
            if (i < this.lines.length - 1) {
                parts.push(this.lines[i].eol ? '\n' : ' ');
            }
        }
        return parts.join('');
    }

    //  setWidth(width)
    //  Updates the wrap width and re-wraps every paragraph in the buffer.
    setWidth(width) {
        this.width = width;
        let i = 0;
        while (i < this.lines.length) {
            const range = this.rewrapParagraph(i);
            i = range.end + 1;
        }
    }
}

exports.LineBuffer = LineBuffer;
exports.ColorSource = ColorSource;
exports.makeAttr = makeAttr;
exports.parseAttr = parseAttr;
exports.getFg = getFg;
exports.getBg = getBg;
exports.getColorSrc = getColorSrc;
exports.u32Insert = u32Insert;
exports.u32Delete = u32Delete;
exports.u32Concat = u32Concat;
