// Build-time ANSI art renderer.
//
// Turns a .ANS file into static HTML. This runs during `astro build`, so the
// browser receives plain markup -- no canvas, no client-side renderer, no JS.
// The art stays selectable text, scales with the VGA webfont we already ship,
// and costs nothing at runtime.
//
// Scope: SGR (colour) sequences and text. Cursor positioning is deliberately NOT
// implemented -- see parseAnsi() for what happens if art needs it.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decodeByte } from './cp437.js';
import { substituteMci } from './mci.js';

// Art is read from disk at build time and resolved against the project root
// rather than import.meta.url, because the bundler rewrites module URLs to
// point into the build output directory where the source art does not exist.
//
// Two roots, in order: site-specific art vendored under src/art/, then the
// luciano_blocktronics theme that ENiGMA actually ships. Preferring the shipped
// theme as a fallback means the site shows the art a new sysop really sees,
// and it cannot drift from the release.
const ART_DIRS = ['src/art', '../art/themes/luciano_blocktronics'];

/** Absolute path to an art file, from the first root that has it. */
export function artPath(name) {
    const tried = [];
    for (const dir of ART_DIRS) {
        const full = resolve(process.cwd(), dir, name);
        if (existsSync(full)) return full;
        tried.push(full);
    }
    throw new Error(
        `[ansi] could not find art "${name}". Looked in:\n  ` + tried.join('\n  ')
    );
}

const SAUCE_ID = 'SAUCE00';
const SAUCE_LEN = 128;
const EOF_MARKER = 0x1a;

/**
 * Read the SAUCE metadata record, if present.
 * @param {Buffer} buf
 * @returns {object|null}
 */
export function readSauce(buf) {
    if (buf.length < SAUCE_LEN) return null;
    const start = buf.length - SAUCE_LEN;
    if (buf.toString('latin1', start, start + 7) !== SAUCE_ID) return null;

    const str = (from, len) =>
        buf
            .toString('latin1', start + from, start + from + len)
            .replace(/\0/g, '')
            .trim();

    const flags = buf[start + 105];

    return {
        title: str(7, 35),
        author: str(42, 20),
        group: str(62, 20),
        date: str(82, 8),
        cols: buf.readUInt16LE(start + 96),
        rows: buf.readUInt16LE(start + 98),
        // Bit 0 of ANSiFlags: non-blink (iCE colours) mode.
        iceColors: (flags & 0x01) === 1,
        fontId: str(106, 22),
    };
}

/** Strip the SAUCE record, any comment block, and the DOS EOF marker. */
function artBody(buf) {
    let end = buf.length;

    if (readSauce(buf)) {
        end -= SAUCE_LEN;
        // A COMNT block, if present, sits immediately before SAUCE: the id plus
        // 64 bytes per comment line. SAUCE byte 104 holds the line count.
        const comments = buf[buf.length - SAUCE_LEN + 104];
        if (comments > 0) {
            const cStart = end - (comments * 64 + 5);
            if (cStart >= 0 && buf.toString('latin1', cStart, cStart + 5) === 'COMNT') {
                end = cStart;
            }
        }
    }

    const eof = buf.indexOf(EOF_MARKER, 0);
    if (eof !== -1 && eof < end) end = eof;

    return buf.subarray(0, end);
}

/**
 * Parse ANSI art into a grid of cells.
 *
 * @param {Buffer} buf raw file contents
 * @param {{cols?: number, iceColors?: boolean, mci?: boolean}} opts
 * @returns {{grid: Array<Array<{ch: string, fg: number, bg: number}>>, cols: number, rows: number, unsupported: string[]}}
 */
export function parseAnsi(buf, { cols = 80, iceColors = false, mci = true } = {}) {
    const body = artBody(buf);

    const grid = [];
    const unsupported = new Set();

    let row = 0;
    let col = 0;
    let fg = 7;
    let bg = 0;
    let bold = false;
    let blink = false;

    const cellAt = (r, c) => {
        while (grid.length <= r) grid.push([]);
        const line = grid[r];
        while (line.length <= c) line.push({ ch: ' ', fg: 7, bg: 0 });
        return line[c];
    };

    const put = ch => {
        if (col >= cols) {
            col = 0;
            row++;
        }
        const cell = cellAt(row, col);
        cell.ch = ch;
        cell.fg = bold ? fg + 8 : fg;
        // Without iCE, blink is a real blink and we simply drop it. With iCE,
        // it means "bright background" instead.
        cell.bg = iceColors && blink ? bg + 8 : bg;
        col++;
    };

    for (let i = 0; i < body.length; i++) {
        const b = body[i];

        if (b === 0x1b && body[i + 1] === 0x5b) {
            // CSI: collect parameter bytes then the final byte.
            let j = i + 2;
            let params = '';
            while (j < body.length && body[j] >= 0x30 && body[j] <= 0x3f) {
                params += String.fromCharCode(body[j]);
                j++;
            }
            while (j < body.length && body[j] >= 0x20 && body[j] <= 0x2f) j++;
            const final = j < body.length ? String.fromCharCode(body[j]) : '';

            if (final === 'm') {
                for (const p of params === '' ? ['0'] : params.split(';')) {
                    const n = p === '' ? 0 : parseInt(p, 10);
                    if (n === 0) {
                        fg = 7;
                        bg = 0;
                        bold = false;
                        blink = false;
                    } else if (n === 1) bold = true;
                    else if (n === 22) bold = false;
                    else if (n === 5 || n === 6) blink = true;
                    else if (n === 25) blink = false;
                    else if (n >= 30 && n <= 37) fg = n - 30;
                    else if (n >= 40 && n <= 47) bg = n - 40;
                    else if (n >= 90 && n <= 97) {
                        fg = n - 90;
                        bold = true;
                    } else if (n >= 100 && n <= 107) bg = n - 100 + 8;
                }
            } else if (final === 'C') {
                // CUF — cursor forward. BBS art uses this constantly in place of
                // runs of spaces, to save bytes: 78 of the 121 files in the
                // shipped luciano_blocktronics theme rely on it. Skipped cells
                // are left untouched (space, default attrs), which is what a real
                // terminal leaves behind on a freshly cleared screen.
                //
                // A parameter of 0 means 1, per ECMA-48. The cursor stops at the
                // right margin rather than wrapping, so art that runs long is
                // clipped instead of cascading onto the next row.
                const n = Math.max(1, parseInt(params, 10) || 1);
                col = Math.min(col + n, cols - 1);
            } else if (final) {
                // Erase, save/restore, absolute positioning. This renderer is for
                // art that paints top-to-bottom; anything else is reported so the
                // caller can fall back rather than silently render it wrong.
                unsupported.add(final);
            }

            i = j;
            continue;
        }

        if (b === 0x0a) {
            row++;
            col = 0;
            continue;
        }
        if (b === 0x0d) {
            col = 0;
            continue;
        }

        put(decodeByte(b, true));
    }

    // MCI substitution runs on the decoded grid rather than the raw bytes,
    // because a code can be split by an SGR sequence mid-token. Working row by
    // row keeps each cell's colour attached to its character: the replacement
    // inherits the attributes of the cell it overwrites.
    if (mci) {
        for (const line of grid) {
            const text = line.map(c => c.ch).join('');
            const out = substituteMci(text);
            if (out === text) continue;
            for (let i = 0; i < line.length; i++) line[i].ch = out[i] ?? ' ';
        }
    }

    // Normalise: pad every row to the widest, so background colours form clean
    // rectangles rather than ragged edges.
    const width = Math.min(
        cols,
        grid.reduce((m, line) => Math.max(m, line.length), 0)
    );
    for (const line of grid) {
        while (line.length < width) line.push({ ch: ' ', fg: 7, bg: 0 });
        line.length = Math.min(line.length, width);
    }

    return { grid, cols: width, rows: grid.length, unsupported: [...unsupported] };
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const escapeHtml = s => s.replace(/[&<>]/g, c => ESCAPES[c]);

/**
 * Render an ANSI art file to HTML, coalescing runs of identical attributes
 * into as few spans as possible.
 *
 * @param {URL|string} path
 * @returns {{html: string, sauce: object|null, cols: number, rows: number, unsupported: string[]}}
 */
export function renderAnsiFile(name, { mci = true } = {}) {
    const full = artPath(name);
    let buf;
    try {
        buf = readFileSync(full);
    } catch (err) {
        throw new Error(
            `[ansi] could not read art "${name}" at ${full}. ` +
                `Art is resolved against the current working directory, so builds must ` +
                `run from the project root. (${err.code})`
        );
    }
    const sauce = readSauce(buf);

    const { grid, cols, rows, unsupported } = parseAnsi(buf, {
        cols: sauce?.cols || 80,
        iceColors: sauce?.iceColors ?? false,
        mci,
    });

    const out = [];
    for (const line of grid) {
        let run = '';
        let fg = null;
        let bg = null;

        const flush = () => {
            if (!run) return;
            out.push(`<span class="f${fg} b${bg}">${escapeHtml(run)}</span>`);
            run = '';
        };

        for (const cell of line) {
            if (cell.fg !== fg || cell.bg !== bg) {
                flush();
                fg = cell.fg;
                bg = cell.bg;
            }
            run += cell.ch;
        }
        flush();
        out.push('\n');
    }

    return { html: out.join(''), sauce, cols, rows, unsupported };
}
