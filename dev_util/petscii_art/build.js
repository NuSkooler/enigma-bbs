#!/usr/bin/env node
'use strict';

//
//  Builds the PETSCII starter theme's placeholder art (#593): each screen in
//  ./screens.js becomes misc/petscii_starter/<NAME>.seq.
//
//      node dev_util/petscii_art/build.js           write the .seq files
//      node dev_util/petscii_art/build.js --check   exit 1 if any differs
//
//  test/petscii_starter.test.js checks that the committed files are what this
//  produces, so edit screens.js and rebuild rather than editing a .seq file.
//
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

const HEIGHT = 25;
const CHARSET = Charsets.LowerUpper;
const OUT_DIR = paths.join(__dirname, '../../misc/petscii_starter');

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

function buildAll() {
    const built = {};
    Object.entries(Screens).forEach(([name, screen]) => {
        built[`${name}.seq`] = buildScreen(name, screen);
    });
    return built;
}

module.exports = { buildAll, buildScreen, OUT_DIR };

if (require.main === module) {
    const check = process.argv.includes('--check');
    let stale = 0;
    Object.entries(buildAll()).forEach(([file, bytes]) => {
        const path = paths.join(OUT_DIR, file);
        const current = fs.existsSync(path) ? fs.readFileSync(path) : null;
        const same = current && current.equals(bytes);
        if (check) {
            if (!same) {
                ++stale;
                console.error(`${file}: differs from what screens.js builds`);
            }
            return;
        }
        if (!same) {
            fs.writeFileSync(path, bytes);
        }
        console.log(`${file}: ${bytes.length} bytes${same ? '' : ' (written)'}`);
    });
    if (stale > 0) {
        process.exitCode = 1;
    }
}
