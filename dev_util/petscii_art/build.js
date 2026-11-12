#!/usr/bin/env node
'use strict';

//
//  Builds the starter themes' placeholder art (#593): each screen in
//  ./screens.js becomes misc/petscii_starter/<NAME>.seq, and each screen in
//  ./atascii_screens.js becomes misc/atascii_starter/<NAME>.ata.
//
//      node dev_util/petscii_art/build.js           write the files
//      node dev_util/petscii_art/build.js --check   exit 1 if any differs
//
//  test/petscii_starter.test.js and test/atascii_starter.test.js check that
//  the committed files are what this produces, so edit the screens and
//  rebuild rather than editing an .seq or .ata file.
//
//  PETSCII:
//  Encoding is charset.js's lower/upper set. A screen starts with CLR and the
//  lower/upper switch, draws its rows with colour and reverse codes and
//  RETURN between rows (none after a row that fills all 40 columns: the
//  screen has already wrapped), and ends with a RETURN so that the art's
//  height counts its last row. Trailing blanks are not sent, except in a
//  padded screen, where every row is filled out to the full width with
//  spaces. A part or a prompt has no CLR and no charset switch, and a prompt
//  no RETURN at the end (see screens.js). Nothing uses DELETE, INSERT or
//  cursor codes.
//
//  ATASCII (buildAtasciiScreen()): charset.js's glyphs, each with bit 7 set
//  where the row says {rvs}; no colour (an Atari screen has one). A screen
//  starts with CLEAR and draws its rows with END OF LINE (0x9B) between
//  them; a row that fills all 40 columns has none after it, because the
//  screen has already wrapped (as on PETSCII, and as the ATASCII art parser
//  counts). The rest is as for PETSCII: trailing blanks, padded screens,
//  parts and prompts, the empty bottom right cell. No byte is a control
//  byte except CLEAR and END OF LINE: no ESC (so no quoted glyph), no cursor,
//  tab, delete or insert codes.
//

const fs = require('fs');
const paths = require('path');

const {
    Charsets,
    Colors,
    Controls,
    unicodeToByte,
    byteToUnicode,
} = require('../../core/term/petscii/charset.js');
const { Screens, WIDTH } = require('./screens.js');
const Atari = require('./atascii_screens.js');
const atascii = require('../../core/term/atascii/charset.js');

const HEIGHT = 25;
const CHARSET = Charsets.LowerUpper;
const OUT_DIR = paths.join(__dirname, '../../misc/petscii_starter');
const ATASCII_OUT_DIR = paths.join(__dirname, '../../misc/atascii_starter');

//  a row's markup -> [{ ch, color, rvs }]
function parseRow(name, row) {
    const cells = [];
    let color = null;
    let rvs = false;
    const re = /\{([^}]*)\}|([^{]+)/g;
    let m;
    while ((m = re.exec(row))) {
        if (m[1] !== undefined) {
            const tag = m[1];
            if ('rvs' === tag) {
                rvs = true;
            } else if ('/rvs' === tag) {
                rvs = false;
            } else if (Object.prototype.hasOwnProperty.call(Colors, tag)) {
                color = tag;
            } else {
                throw new Error(`${name}: unknown tag {${tag}}`);
            }
            continue;
        }
        for (const ch of m[2]) {
            cells.push({ ch, color, rvs });
        }
    }
    return cells;
}

function glyphByte(name, ch) {
    const byte = unicodeToByte(ch, CHARSET);
    if (undefined === byte || byteToUnicode(byte, CHARSET) !== ch) {
        throw new Error(`${name}: "${ch}" has no exact PETSCII glyph`);
    }
    return byte;
}

function buildScreen(name, screen) {
    const opts = Array.isArray(screen) ? {} : screen;
    const prompt = true === opts.prompt;
    //  a part (prompt or not) is drawn below what is already there
    const part = prompt || true === opts.part;
    const pad = true === opts.pad;
    const rows = Array.isArray(screen) ? screen : screen.rows;
    if (rows.length > HEIGHT) {
        throw new Error(`${name}: ${rows.length} rows; at most ${HEIGHT}`);
    }

    const out = part ? [] : [Controls.clear, Controls.charsetLower];
    let color = null;
    let rvs = false;

    rows.forEach((row, r) => {
        const cells = parseRow(name, row);
        if (cells.length > WIDTH) {
            throw new Error(`${name}: row ${r + 1} is ${cells.length} columns wide`);
        }
        if (HEIGHT - 1 === r && WIDTH === cells.length) {
            throw new Error(`${name}: the bottom right cell must stay empty`);
        }

        //  padded rows overwrite whatever was in the row before
        if (pad) {
            const width = HEIGHT - 1 === r ? WIDTH - 1 : WIDTH;
            while (cells.length < width) {
                cells.push({ ch: ' ', color: null, rvs: false });
            }
        }

        //  trailing blanks draw nothing (and are kept when padding)
        while (!pad && cells.length > 0) {
            const last = cells[cells.length - 1];
            if (' ' !== last.ch || last.rvs) {
                break;
            }
            cells.pop();
        }

        cells.forEach(cell => {
            if (cell.rvs !== rvs) {
                out.push(cell.rvs ? Controls.reverseOn : Controls.reverseOff);
                rvs = cell.rvs;
            }
            const shows = ' ' !== cell.ch || cell.rvs;
            if (shows) {
                if (!cell.color) {
                    throw new Error(
                        `${name}: row ${r + 1} draws before setting a colour`
                    );
                }
                if (cell.color !== color) {
                    out.push(Colors[cell.color]);
                    color = cell.color;
                }
            }
            out.push(glyphByte(name, cell.ch));
        });

        const last = rows.length - 1 === r;
        const wrapped = WIDTH === cells.length;
        if (wrapped || (prompt && last) || (last && HEIGHT - 1 === r)) {
            return;
        }
        out.push(Controls.return); //  also turns reverse off
        rvs = false;
    });

    return Buffer.from(out);
}

//  an ATASCII row's markup -> [{ ch, rvs }]: only {rvs} and {/rvs}
function parseAtasciiRow(name, row) {
    const cells = [];
    let rvs = false;
    const re = /\{([^}]*)\}|([^{]+)/g;
    let m;
    while ((m = re.exec(row))) {
        if (m[1] !== undefined) {
            if ('rvs' === m[1]) {
                rvs = true;
            } else if ('/rvs' === m[1]) {
                rvs = false;
            } else {
                throw new Error(`${name}: unknown tag {${m[1]}} (ATASCII has no colour)`);
            }
            continue;
        }
        for (const ch of m[2]) {
            cells.push({ ch, rvs });
        }
    }
    return cells;
}

function atasciiGlyphByte(name, ch, rvs) {
    const byte = atascii.unicodeToByte(ch);
    if (undefined === byte || atascii.byteToUnicode(byte) !== ch) {
        throw new Error(`${name}: "${ch}" has no exact ATASCII glyph`);
    }
    //  its glyph would need ESC quoting (and SyncTERM misdraws some)
    if (
        atascii.isControlByte(byte) ||
        atascii.isControlByte(byte | atascii.INVERSE_BIT)
    ) {
        throw new Error(`${name}: "${ch}" is drawn by a control byte`);
    }
    return rvs ? byte | atascii.INVERSE_BIT : byte;
}

function buildAtasciiScreen(name, screen) {
    const { WIDTH: width, HEIGHT: height } = Atari;
    const opts = Array.isArray(screen) ? {} : screen;
    const prompt = true === opts.prompt;
    const part = prompt || true === opts.part;
    const pad = true === opts.pad;
    const rows = Array.isArray(screen) ? screen : screen.rows;
    if (rows.length > height) {
        throw new Error(`${name}: ${rows.length} rows; at most ${height}`);
    }

    const C = atascii.Controls;
    const out = part ? [] : [C.clear];

    rows.forEach((row, r) => {
        const cells = parseAtasciiRow(name, row);
        if (cells.length > width) {
            throw new Error(`${name}: row ${r + 1} is ${cells.length} columns wide`);
        }
        if (height - 1 === r && width === cells.length) {
            throw new Error(`${name}: the bottom right cell must stay empty`);
        }
        if (pad) {
            const w = height - 1 === r ? width - 1 : width;
            while (cells.length < w) {
                cells.push({ ch: ' ', rvs: false });
            }
        }
        while (!pad && cells.length > 0) {
            const last = cells[cells.length - 1];
            if (' ' !== last.ch || last.rvs) {
                break;
            }
            cells.pop();
        }
        cells.forEach(cell => out.push(atasciiGlyphByte(name, cell.ch, cell.rvs)));

        const last = rows.length - 1 === r;
        const wrapped = width === cells.length;
        if (wrapped || (prompt && last) || (last && height - 1 === r)) {
            return;
        }
        out.push(C.eol);
    });

    return Buffer.from(out);
}

//  { file name: bytes } for a target: 'petscii' (the default) or 'atascii'
function buildAll(target = 'petscii') {
    const built = {};
    if ('atascii' === target) {
        Object.entries(Atari.Screens).forEach(([name, screen]) => {
            built[`${name}.ata`] = buildAtasciiScreen(name, screen);
        });
        return built;
    }
    Object.entries(Screens).forEach(([name, screen]) => {
        built[`${name}.seq`] = buildScreen(name, screen);
    });
    return built;
}

const Targets = {
    petscii: OUT_DIR,
    atascii: ATASCII_OUT_DIR,
};

module.exports = {
    buildAll,
    buildScreen,
    buildAtasciiScreen,
    OUT_DIR,
    ATASCII_OUT_DIR,
    Targets,
};

if (require.main === module) {
    const check = process.argv.includes('--check');
    let stale = 0;
    Object.entries(Targets).forEach(([target, outDir]) => {
        Object.entries(buildAll(target)).forEach(([file, bytes]) => {
            const path = paths.join(outDir, file);
            const current = fs.existsSync(path) ? fs.readFileSync(path) : null;
            const same = current && current.equals(bytes);
            if (check) {
                if (!same) {
                    ++stale;
                    console.error(`${file}: differs from what the screens build`);
                }
                return;
            }
            if (!same) {
                fs.mkdirSync(outDir, { recursive: true });
                fs.writeFileSync(path, bytes);
            }
            console.log(`${file}: ${bytes.length} bytes${same ? '' : ' (written)'}`);
        });
    });
    if (stale > 0) {
        process.exitCode = 1;
    }
}
