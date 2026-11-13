#!/usr/bin/env node
'use strict';

//
//  Builds the RIP starter's button screens (#989): each screen in
//  ./screens.js becomes misc/rip_starter/<NAME>.rip and <NAME>.ans.
//
//      node dev_util/rip_art/build.js           write the files
//      node dev_util/rip_art/build.js --check   exit 1 if any differs
//
//  test/rip_starter.test.js checks that the committed files are what this
//  produces, so edit the screens and rebuild rather than editing the files.
//
//  The .rip file (what a RIP caller sees): RIPscrip command lines first, one
//  command per line, each at the start of its line, then ANSI text placed
//  with cursor positioning. Lines end in CR LF; the last line (the status
//  line, holding the screen's MCI code) has no line end, so the cursor stays
//  on it. Coordinates are pixels on RIP's 640x350 screen; with the 8x8 font
//  a text cell is 8 pixels square, so text row r starts at y = (r - 1) * 8.
//  Everything fits a 42 row screen (the smallest a RIP terminal reports)
//  and leaves the rows below empty on a 43 or 44 row one.
//
//  Only commands seen working on SyncTERM (1.8rc2, 1.10b) and IcyTerm are
//  used: font style (Y), colour (c), fill style (S), bar (B), rectangle (R),
//  text at (@), button style (1B) and button (1U). Never reset windows (*)
//  or a text window (w): SyncTERM 1.10 stops sending keys after either.
//  Buttons have no hotkey (00): the menu binds the keys itself, and each
//  button's host command is one key, without Enter.
//
//  Layout, in pixels (n buttons):
//      0..23       header bar, dark grey, the title in light green
//      24..27      two lines under it, light green then green
//      rows 6, 7   help text (ANSI, cyan)
//      72..        a dark grey frame around the buttons
//      80 + 44i    button i, 240x32, centred (x 200..439), light cyan label
//                  on dark grey, a light grey outline 2 pixels outside it
//      then        a green line, and on the row below it the status line
//
//  Colours are the 16 EGA colours, chosen to match the default theme
//  (luciano_blocktronics): greens for the title and highlights, cyans for
//  text and labels, greys for frames, all on black.
//
//  The .ans file is the same screen as text (title, help, a [key] label per
//  button, status line), for a caller who reaches the menu without RIP, or
//  whose .rip file is missing. Neither file clears the screen: the menus
//  do (cls).
//

const fs = require('fs');
const paths = require('path');

const { Screens } = require('./screens.js');

const OUT_DIR = paths.join(__dirname, '../../misc/rip_starter');

const ESC = String.fromCharCode(0x1b);
const CRLF = '\r\n';

const SCREEN_WIDTH = 640;
const SCREEN_HEIGHT = 350;
const CELL = 8;
const MIN_ROWS = 42;

//  EGA colours
const Color = {
    black: 0,
    green: 2,
    cyan: 3,
    lightGrey: 7,
    darkGrey: 8,
    lightGreen: 10,
    lightCyan: 11,
    white: 15,
    yellow: 14,
};

const Layout = {
    headerBottom: 23,
    titleX: 16,
    titleY: 8,
    helpRow: 6,
    textCol: 3,
    buttonX0: 200,
    buttonX1: 439,
    buttonTop: 80,
    buttonHeight: 32,
    buttonPitch: 44,
    outline: 2,
    frameX0: 184,
    frameX1: 455,
    frameTop: 72,
    frameMargin: 8,
    rule: { x0: 16, x1: 623 },
};

//  a number as a RIPscrip "meganum": base 36, |width| digits
function mn(n, width = 2) {
    if (!Number.isInteger(n) || n < 0 || n >= Math.pow(36, width)) {
        throw new Error(`${n} does not fit a ${width} digit meganum`);
    }
    return n.toString(36).toUpperCase().padStart(width, '0');
}

//  text inside a RIP command: "!", "|" and "\" are escaped
const ripText = s => s.replace(/[\\!|]/g, c => `\\${c}`);

const point = (x, y) => {
    if (x < 0 || x >= SCREEN_WIDTH || y < 0 || y >= SCREEN_HEIGHT) {
        throw new Error(`${x},${y} is off the 640x350 screen`);
    }
    return mn(x) + mn(y);
};

//  command builders; each returns one command line
const Rip = {
    fontStyle: () => '!|Y00000100', //  8x8 font, horizontal, size 1
    color: c => `!|c${mn(c)}`,
    fill: c => `!|S01${mn(c)}`, //  solid fill
    bar: (x0, y0, x1, y1) => `!|B${point(x0, y0)}${point(x1, y1)}`,
    rect: (x0, y0, x1, y1) => `!|R${point(x0, y0)}${point(x1, y1)}`,
    text: (x, y, s) => `!|@${point(x, y)}${ripText(s)}`,
    //  width/height 0 (each button has its own), label centred, flags 1282:
    //  1024 mouse button + 256 plain (filled with the surface colour) + 2
    //  invertable; no bevel; the colours below; no group; reserved 000000
    buttonStyle: () =>
        '!|1B' +
        mn(0) +
        mn(0) +
        mn(2) +
        mn(1024 + 256 + 2, 4) +
        mn(0) + //  bevel size
        mn(Color.lightCyan) + //  label
        mn(Color.darkGrey) + //  drop shadow (not drawn: no shadow flag)
        mn(Color.white) + //  highlight (unused: no bevel)
        mn(Color.darkGrey) + //  shadow (unused: no bevel)
        mn(Color.darkGrey) + //  surface
        mn(0) + //  group
        mn(0) + //  flags 2
        mn(Color.yellow) + //  underline (unused: no hotkey)
        mn(Color.darkGrey) + //  corner
        '000000',
    //  hotkey 00 (none), flags 0, reserved 0; no icon
    button: (x0, y0, x1, y1, label, hostCommand) =>
        `!|1U${point(x0, y0)}${point(x1, y1)}${mn(0)}00<>${ripText(label)}<>${ripText(
            hostCommand
        )}`,
};

const Ansi = {
    goto: (row, col) => `${ESC}[${row};${col}H`,
    sgr: (...params) => `${ESC}[${params.join(';')}m`,
};

//
//  One text field of a screen, checked: printable ASCII only (no CR, LF,
//  ESC or any other control character, nothing above 0x7E), at most |max|
//  characters. |ripSafe| (text that goes inside a RIP command) also rejects
//  "!", "|" and a backslash, which RIPscrip needs escaped, and "<>", its field
//  separator; |noMci| rejects "|" and "%", which ENiGMA would read as codes.
//  Errors name the screen and the field.
//
function checkText(screen, field, text, { max, ripSafe = false, noMci = false }) {
    const where = `${screen.name}: ${field}`;
    if ('string' !== typeof text) {
        throw new Error(`${where} is not a string`);
    }
    if (/[^ -~]/.test(text)) {
        throw new Error(
            `${where} "${text}" has a character that is not printable ASCII (no control characters, line ends or non-ASCII)`
        );
    }
    if (text.length > max) {
        throw new Error(
            `${where} "${text}" is ${text.length} characters; at most ${max}`
        );
    }
    if (ripSafe && /[\\!|]/.test(text)) {
        throw new Error(
            `${where} "${text}" has "!", "|" or "\\", which RIPscrip needs escaped; leave them out`
        );
    }
    if (ripSafe && text.includes('<>')) {
        throw new Error(`${where} "${text}" has "<>", the RIP field separator`);
    }
    if (noMci && /[|%]/.test(text)) {
        throw new Error(`${where} "${text}" has "|" or "%", which ENiGMA would expand`);
    }
}

function checkScreen(screen) {
    if (!/^R[A-Z0-9]{1,7}$/.test(screen.name)) {
        throw new Error(`${screen.name}: art names are R + up to 7 letters or digits`);
    }
    //  title: from column 3 in the RIP header, from column 2 in the .ans
    checkText(screen, 'title', screen.title, { max: 78, ripSafe: true, noMci: true });
    if (!Array.isArray(screen.help)) {
        throw new Error(`${screen.name}: help is not a list`);
    }
    if (!Array.isArray(screen.buttons) || 0 === screen.buttons.length) {
        throw new Error(`${screen.name}: buttons is not a list with at least one button`);
    }
    if (!Array.isArray(screen.status) || 2 !== screen.status.length) {
        throw new Error(`${screen.name}: status is not [ text, MCI code ]`);
    }
    const keys = new Set();
    screen.buttons.forEach(([key, label], i) => {
        const field = `button ${i + 1}`;
        if (!/^[A-Z]$/.test(key)) {
            throw new Error(`${screen.name}: ${field} key "${key}" is not one letter`);
        }
        if (keys.has(key)) {
            throw new Error(`${screen.name}: key ${key} used twice`);
        }
        keys.add(key);
        //  the host command is the key: exactly one printable ASCII character
        checkText(screen, `${field} host command`, key, {
            max: 1,
            ripSafe: true,
        });
        if (1 !== key.length) {
            throw new Error(`${screen.name}: ${field} host command is not one character`);
        }
        //  drawn as "[K] label" inside a 240 pixel (30 character) button
        checkText(screen, `${field} label`, label, {
            max: Math.floor((Layout.buttonX1 - Layout.buttonX0 + 1) / CELL) - 4,
            ripSafe: true,
        });
    });
    screen.help.forEach((line, i) => {
        checkText(screen, `help line ${i + 1}`, line, { max: 76, noMci: true });
    });
    //  from column 3; what the MCI code expands to follows, so leave room
    checkText(screen, 'status text', screen.status[0], { max: 50, noMci: true });
    if (!/^%[A-Z0-9]{2}$/.test(screen.status[1])) {
        throw new Error(
            `${screen.name}: status MCI code "${screen.status[1]}" is not a % and two letters or digits`
        );
    }
}

//  where things go for |count| buttons
function layoutFor(count) {
    const buttons = [];
    for (let i = 0; i < count; ++i) {
        const y0 = Layout.buttonTop + i * Layout.buttonPitch;
        buttons.push({
            x0: Layout.buttonX0,
            y0,
            x1: Layout.buttonX1,
            y1: y0 + Layout.buttonHeight - 1,
        });
    }
    const frameBottom = buttons[count - 1].y1 + Layout.frameMargin;
    //  the green line on the row after the frame, the status line below it
    const ruleRow = Math.floor(frameBottom / CELL) + 2;
    const ruleY = (ruleRow - 1) * CELL + 3;
    const statusRow = ruleRow + 1;
    if (statusRow > MIN_ROWS - 1) {
        throw new Error(`${count} buttons do not fit ${MIN_ROWS} rows`);
    }
    return { buttons, frameBottom, ruleY, statusRow };
}

function buildRip(screen) {
    checkScreen(screen);
    const layout = layoutFor(screen.buttons.length);
    const right = SCREEN_WIDTH - 1;
    const lines = [
        Rip.fontStyle(),
        //  black out anything still drawn
        Rip.fill(Color.black),
        Rip.bar(0, 0, right, SCREEN_HEIGHT - 1),
        //  header
        Rip.fill(Color.darkGrey),
        Rip.bar(0, 0, right, Layout.headerBottom),
        Rip.fill(Color.lightGreen),
        Rip.bar(0, Layout.headerBottom + 1, right, Layout.headerBottom + 2),
        Rip.fill(Color.green),
        Rip.bar(0, Layout.headerBottom + 3, right, Layout.headerBottom + 4),
        Rip.color(Color.lightGreen),
        Rip.text(Layout.titleX, Layout.titleY, screen.title),
        //  frame and outlines
        Rip.color(Color.darkGrey),
        Rip.rect(Layout.frameX0, Layout.frameTop, Layout.frameX1, layout.frameBottom),
        Rip.color(Color.lightGrey),
        ...layout.buttons.map(b =>
            Rip.rect(
                b.x0 - Layout.outline,
                b.y0 - Layout.outline,
                b.x1 + Layout.outline,
                b.y1 + Layout.outline
            )
        ),
        //  buttons
        Rip.buttonStyle(),
        ...layout.buttons.map((b, i) => {
            const [key, label] = screen.buttons[i];
            return Rip.button(b.x0, b.y0, b.x1, b.y1, `[${key}] ${label}`, key);
        }),
        //  the line above the status line
        Rip.fill(Color.green),
        Rip.bar(Layout.rule.x0, layout.ruleY, Layout.rule.x1, layout.ruleY + 1),
    ];

    const text = [
        ...screen.help.map(
            (line, i) =>
                Ansi.goto(Layout.helpRow + i, Layout.textCol) + Ansi.sgr(0, 36) + line
        ),
        Ansi.goto(layout.statusRow, Layout.textCol) +
            Ansi.sgr(0, 36) +
            screen.status[0] +
            Ansi.sgr(1, 32) +
            screen.status[1],
    ];

    //  the status line is last and has no line end
    return Buffer.from(lines.concat(text).join(CRLF), 'latin1');
}

function buildAns(screen) {
    checkScreen(screen);
    const rows = [
        Ansi.sgr(0) + ' ' + Ansi.sgr(1, 32) + screen.title,
        Ansi.sgr(0, 32) + ' ' + '-'.repeat(76),
        '',
        ...screen.help.map(line => Ansi.sgr(0, 36) + ' ' + line),
        '',
        ...screen.buttons.map(
            ([key, label]) =>
                '   ' +
                Ansi.sgr(1, 30) +
                '[' +
                Ansi.sgr(1, 32) +
                key +
                Ansi.sgr(1, 30) +
                '] ' +
                Ansi.sgr(0, 36) +
                label
        ),
        '',
        Ansi.sgr(0, 32) + ' ' + '-'.repeat(76),
        Ansi.sgr(0, 36) + ' ' + screen.status[0] + Ansi.sgr(1, 32) + screen.status[1],
    ];
    return Buffer.from(rows.join(CRLF), 'latin1');
}

//  { 'RMAIN.rip': Buffer, 'RMAIN.ans': Buffer, ... }
function buildAll() {
    const out = {};
    Screens.forEach(screen => {
        out[`${screen.name}.rip`] = buildRip(screen);
        out[`${screen.name}.ans`] = buildAns(screen);
    });
    return out;
}

module.exports = {
    buildAll,
    buildRip,
    buildAns,
    checkScreen,
    layoutFor,
    mn,
    Layout,
    OUT_DIR,
    SCREEN_WIDTH,
    SCREEN_HEIGHT,
    CELL,
    MIN_ROWS,
};

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
                console.error(`${file}: differs from what the screens build`);
            }
            return;
        }
        if (!same) {
            fs.mkdirSync(OUT_DIR, { recursive: true });
            fs.writeFileSync(path, bytes);
        }
        console.log(`${file}: ${bytes.length} bytes${same ? '' : ' (written)'}`);
    });
    if (stale > 0) {
        process.exitCode = 1;
    }
}
