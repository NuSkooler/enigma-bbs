/* jslint node: true */
'use strict';

//
//  One tokenizer for pipe codes: render, measure, strip and slice text that
//  carries Renegade/ENiGMA pipe codes (|07, |UN, |CF05, ||), ANSI escapes
//  and, in message bodies, the PCBoard/Wildcat!/WWIV/CNET families.
//
//  Every operation follows the same grammar, so a string is measured, cut
//  and stripped the way it is drawn. Two dialects, because ENiGMA has two:
//
//  ui    theme, menu, view and WFC strings (pipeToAnsi). At each '|', in order:
//          |C[FBUD] + 1-2 digits   cursor move (resolved with a client only)
//          | + 2 digits            colour 00-99 (32-99: SGR 22, consumed)
//          | + 2 upper case        predefined MCI value (client only)
//          ||                      a literal '|'
//          anything else           the '|' is literal text
//  body  message bodies and file descriptions (controlCodesToAnsi): no '||'
//        escape, plus @X##, @##@, ^C# and CNET ^Y / ^Q codes.
//
//  bodyLegacy reproduces today's controlCodesToAnsi() pipe quirks exactly
//  ('|1A' is colour 1, no |C[FBUD]## form). 'ansi' is for text that has
//  already been rendered: only ANSI escapes are codes. 'color' is the editors'
//  live-preview grammar: only |## colour codes; everything else is literal.
//
//  MCI values are resolved through a function predefined_mci.js injects
//  with setMciResolver(); nothing here requires predefined_mci or config, so
//  this module is safe to load at any point of startup.
//
//  How it is kept fast: one charCodeAt loop per operation over shared
//  scanners that report through module-level registers (no token arrays, no
//  closures); dialects are bit flags; ANSI CSI is parsed by hand for the
//  common ESC[n;n..X shape with the ANSI regex as a fallback; text width
//  goes through a per-code-unit memo; UI render/strip jump between pipes
//  with indexOf; SGR strings are cached.
//

//  ENiGMA½
const ANSI = require('./ansi_term.js');
const { charDisplayWidth } = require('./display_width.js');

//  Token types (walk() / tokenize())
const T = {
    TEXT: 0, //  literal run
    COLOR: 1, //  |00-|99                      value = number
    MOVE: 2, //  |CF## |CB## |CU## |CD##       value = { dir, n }
    MCI: 3, //  |AA predefined MCI             value = code
    PIPE: 4, //  || = literal '|' (ui only)
    ANSI: 5, //  ESC sequence                  value = { args, cmd }
    LEGACY: 6, //  @X## @##@ ^C# CNET (body)    value = { fam, v }
};

//  Dialect flags
const F_ESC = 1; //  ANSI escapes are tokens
const F_MOVE = 2; //  |C[FBUD]## movement form
const F_LEGACY = 4; //  @X## @##@ ^C# CNET
const F_NUMPFX = 8; //  bodyLegacy: |1A = colour 1, |A1 = MCI 'A1'
const F_PIPEESC = 16; //  || = literal '|'
const F_BODY = 32; //  body MCI value rule (falsy -> literal, non-string -> colour)
const F_ANSIONLY = 64; //  already rendered: only ESC sequences are codes
const F_COLORONLY = 128; //  only |## colour codes

const DIALECT = {
    ui: F_PIPEESC | F_MOVE,
    body: F_MOVE | F_LEGACY | F_BODY,
    bodyLegacy: F_LEGACY | F_NUMPFX | F_BODY,
    color: F_COLORONLY,
    ansi: F_ESC | F_ANSIONLY,
};
const UI = DIALECT.ui;

function flagsOf(opts) {
    const name = opts && opts.dialect;
    if (!name || 'ui' === name) {
        return UI;
    }
    const f = DIALECT[name];
    if (undefined === f) {
        throw new Error(`Unknown pipe code dialect: ${name}`);
    }
    return f;
}

//  ── Scanners ─────────────────────────────────────────────────────────────────
//
//  scanPipe/scanLegacy/scanAnsi recognise one code at a position, return its
//  end index (or -1) and report what they found in these registers. Callers
//  copy them to locals straight away: an MCI resolver may re-enter.
//
let tType = 0; //  T.*
let tVal = 0; //  COLOR n / MOVE n / LEGACY family
let tDir = 0; //  MOVE direction char code (F B U D)
let aCmd = 0; //  ANSI final char code
let aN = -1; //  ANSI first numeric argument, -1 when absent

const isDigit = c => c >= 48 && c <= 57;
const isUpper = c => c >= 65 && c <= 90;

//  s[i] === '|'
function scanPipe(s, i, f) {
    const c1 = s.charCodeAt(i + 1);
    const c2 = s.charCodeAt(i + 2);
    if (f & F_COLORONLY) {
        if (isDigit(c1) && isDigit(c2)) {
            tType = T.COLOR;
            tVal = (c1 - 48) * 10 + (c2 - 48);
            return i + 3;
        }
        return -1;
    }
    if (67 === c1 && f & F_MOVE && (70 === c2 || 66 === c2 || 85 === c2 || 68 === c2)) {
        const c3 = s.charCodeAt(i + 3);
        if (isDigit(c3)) {
            const c4 = s.charCodeAt(i + 4);
            tType = T.MOVE;
            tDir = c2;
            if (isDigit(c4)) {
                tVal = (c3 - 48) * 10 + (c4 - 48);
                return i + 5;
            }
            tVal = c3 - 48;
            return i + 4;
        }
    }
    if (isDigit(c1)) {
        if (isDigit(c2)) {
            tType = T.COLOR;
            tVal = (c1 - 48) * 10 + (c2 - 48);
            return i + 3;
        }
        if (f & F_NUMPFX && isUpper(c2)) {
            tType = T.COLOR; //  parseInt('1A') === 1
            tVal = c1 - 48;
            return i + 3;
        }
        return -1;
    }
    if (isUpper(c1)) {
        if (isUpper(c2) || (f & F_NUMPFX && isDigit(c2))) {
            tType = T.MCI;
            return i + 3;
        }
        return -1;
    }
    if (124 === c1 && f & F_PIPEESC) {
        tType = T.PIPE;
        return i + 2;
    }
    return -1;
}

//  ANSI.getFullMatchRegExp():
//    ESC [[()#;?]* ([0-9]{1,4}(?:;[0-9]{0,4})*)? ([0-9A-ORZcf-npqrsuy=><])
const ANSI_STICKY = new RegExp(ANSI.getFullMatchRegExp().source, 'y');
const ANSI_FINAL = new Uint8Array(128);
for (const ch of 'ABCDEFGHIJKLMNORZcfghijklmnpqrsuy=><') {
    ANSI_FINAL[ch.charCodeAt(0)] = 1;
}

//  s[i] === ESC. Fast path: ESC '[' then either a final letter, or 1-4 digits
//  (';' 0-4 digits)* and a non-digit final. For that shape the regex's first
//  (greedy) attempt matches with the same split, so the result is identical.
//  Anything else goes to the regex.
function scanAnsi(s, i) {
    if (91 === s.charCodeAt(i + 1)) {
        let j = i + 2;
        let c = s.charCodeAt(j);
        let n = -1;
        if (isDigit(c)) {
            n = 0;
            let k = 0;
            do {
                if (++k > 4) {
                    return scanAnsiSlow(s, i);
                }
                n = n * 10 + (c - 48);
                c = s.charCodeAt(++j);
            } while (isDigit(c));
            while (59 === c) {
                k = 0;
                c = s.charCodeAt(++j);
                while (isDigit(c)) {
                    if (++k > 4) {
                        return scanAnsiSlow(s, i);
                    }
                    c = s.charCodeAt(++j);
                }
            }
        }
        if (c < 128 && ANSI_FINAL[c]) {
            aCmd = c;
            aN = n;
            return j + 1;
        }
    }
    return scanAnsiSlow(s, i);
}

function scanAnsiSlow(s, i) {
    ANSI_STICKY.lastIndex = i;
    const m = ANSI_STICKY.exec(s);
    if (!m) {
        return -1;
    }
    aCmd = m[2].charCodeAt(0);
    aN = undefined === m[1] ? -1 : parseInt(m[1], 10);
    return ANSI_STICKY.lastIndex;
}

//  Columns a bare ESC[C (no argument) moves when measured.
const BARE_CUF = 0;

//  Display cells of the ANSI sequence just scanned: ESC[nC moves n.
function ansiCellWidth() {
    return 67 === aCmd ? (aN < 0 ? BARE_CUF : aN) : 0;
}

const isHex = c => isDigit(c) || (c >= 65 && c <= 70);

const LEG_PCB = 0;
const LEG_WC = 1;
const LEG_WWIV = 2;
const LEG_CNET = 3;
const LEG_FAM_NAME = ['pcb', 'wc', 'wwiv', 'cnet'];

//  CNET 2-char code at s[j..j+1]: c[0-9a-f] z[0-7] n1 f1 q1
function isCnet(s, j) {
    const a = s.charCodeAt(j);
    const b = s.charCodeAt(j + 1);
    if (99 === a) {
        return isDigit(b) || (b >= 97 && b <= 102);
    }
    if (122 === a) {
        return b >= 48 && b <= 55;
    }
    return 49 === b && (110 === a || 102 === a || 113 === a);
}

//  s[i] is '@', ^C, ^Y or ^Q (code c0)
function scanLegacy(s, i, c0) {
    if (64 === c0) {
        if (
            88 === s.charCodeAt(i + 1) &&
            isHex(s.charCodeAt(i + 2)) &&
            isHex(s.charCodeAt(i + 3))
        ) {
            tType = T.LEGACY;
            tVal = LEG_PCB;
            return i + 4;
        }
        if (
            isHex(s.charCodeAt(i + 1)) &&
            isHex(s.charCodeAt(i + 2)) &&
            64 === s.charCodeAt(i + 3)
        ) {
            tType = T.LEGACY;
            tVal = LEG_WC;
            return i + 4;
        }
        return -1;
    }
    if (3 === c0) {
        if (isDigit(s.charCodeAt(i + 1))) {
            tType = T.LEGACY;
            tVal = LEG_WWIV;
            return i + 2;
        }
        return -1; //  a bare ^C is literal
    }
    //  0x19 (Y-style) or 0x11 (Q-style, closed by '}')
    if (!isCnet(s, i + 1)) {
        return -1;
    }
    if (17 === c0) {
        if (125 !== s.charCodeAt(i + 3)) {
            return -1;
        }
        tType = T.LEGACY;
        tVal = LEG_CNET;
        return i + 4;
    }
    tType = T.LEGACY;
    tVal = LEG_CNET;
    return i + 3;
}

const isLegacyStart = c => 64 === c || 3 === c || 25 === c || 17 === c;

function legacyValue(s, i, fam) {
    switch (fam) {
        case LEG_PCB:
            return s.slice(i + 2, i + 4);
        case LEG_WWIV:
            return s[i + 1];
        default:
            return s.slice(i + 1, i + 3); //  Wildcat!, CNET
    }
}

//  ── Rendering tables ─────────────────────────────────────────────────────────

const PIPE_SGR_ARGS = {
    //  Dark foreground colors (0–7): use 'normal' (SGR 22) to clear bold/bright
    //  without a full SGR 0 reset that would wipe any previously set background.
    //  See: https://github.com/NuSkooler/enigma-bbs/issues/555
    0: ['normal', 'black'],
    1: ['normal', 'blue'],
    2: ['normal', 'green'],
    3: ['normal', 'cyan'],
    4: ['normal', 'red'],
    5: ['normal', 'magenta'],
    6: ['normal', 'yellow'],
    7: ['normal', 'white'],

    8: ['bold', 'black'],
    9: ['bold', 'blue'],
    10: ['bold', 'green'],
    11: ['bold', 'cyan'],
    12: ['bold', 'red'],
    13: ['bold', 'magenta'],
    14: ['bold', 'yellow'],
    15: ['bold', 'white'],

    16: ['blackBG'],
    17: ['blueBG'],
    18: ['greenBG'],
    19: ['cyanBG'],
    20: ['redBG'],
    21: ['magentaBG'],
    22: ['yellowBG'],
    23: ['whiteBG'],

    24: ['blink', 'blackBG'],
    25: ['blink', 'blueBG'],
    26: ['blink', 'greenBG'],
    27: ['blink', 'cyanBG'],
    28: ['blink', 'redBG'],
    29: ['blink', 'magentaBG'],
    30: ['blink', 'yellowBG'],
    31: ['blink', 'whiteBG'],
};

//  Any value; unknown ones (32-99, non-numbers) give 'normal'.
function sgrFromPipeColor(cc) {
    return ANSI.sgr(PIPE_SGR_ARGS[cc] || 'normal');
}

const SGR_CACHE = new Array(100);

//  The SGR for pipe colour |n; anything outside 0-31 gives 'normal'.
function pipeColorSgr(n) {
    if (!(n >= 0 && n < 100 && Number.isInteger(n))) {
        return sgrFromPipeColor(n);
    }
    return SGR_CACHE[n] || (SGR_CACHE[n] = sgrFromPipeColor(n));
}

const PCB_BG = {
    0: ['blackBG'],
    1: ['blueBG'],
    2: ['greenBG'],
    3: ['cyanBG'],
    4: ['redBG'],
    5: ['magentaBG'],
    6: ['yellowBG'],
    7: ['whiteBG'],

    8: ['bold', 'blackBG'],
    9: ['bold', 'blueBG'],
    A: ['bold', 'greenBG'],
    B: ['bold', 'cyanBG'],
    C: ['bold', 'redBG'],
    D: ['bold', 'magentaBG'],
    E: ['bold', 'yellowBG'],
    F: ['bold', 'whiteBG'],
};

const PCB_FG = {
    0: ['reset', 'black'],
    1: ['reset', 'blue'],
    2: ['reset', 'green'],
    3: ['reset', 'cyan'],
    4: ['reset', 'red'],
    5: ['reset', 'magenta'],
    6: ['reset', 'yellow'],
    7: ['reset', 'white'],

    8: ['blink', 'black'],
    9: ['blink', 'blue'],
    A: ['blink', 'green'],
    B: ['blink', 'cyan'],
    C: ['blink', 'red'],
    D: ['blink', 'magenta'],
    E: ['blink', 'yellow'],
    F: ['blink', 'white'],
};

const WWIV_SGR_ARGS = {
    0: ['reset', 'black'],
    1: ['bold', 'cyan'],
    2: ['bold', 'yellow'],
    3: ['reset', 'magenta'],
    4: ['bold', 'white', 'blueBG'],
    5: ['reset', 'green'],
    6: ['bold', 'blink', 'red'],
    7: ['bold', 'blue'],
    8: ['reset', 'blue'],
    9: ['reset', 'cyan'],
};

const CNET_SGR_ARGS = {
    //  Same fix as Renegade codes 0–7: 'normal' (SGR 22) clears bold without
    //  a full reset that would wipe a previously set background.
    c0: ['normal', 'black'],
    c1: ['normal', 'red'],
    c2: ['normal', 'green'],
    c3: ['normal', 'yellow'],
    c4: ['normal', 'blue'],
    c5: ['normal', 'magenta'],
    c6: ['normal', 'cyan'],
    c7: ['normal', 'white'],

    c8: ['bold', 'black'],
    c9: ['bold', 'red'],
    ca: ['bold', 'green'],
    cb: ['bold', 'yellow'],
    cc: ['bold', 'blue'],
    cd: ['bold', 'magenta'],
    ce: ['bold', 'cyan'],
    cf: ['bold', 'white'],

    z0: ['blackBG'],
    z1: ['redBG'],
    z2: ['greenBG'],
    z3: ['yellowBG'],
    z4: ['blueBG'],
    z5: ['magentaBG'],
    z6: ['cyanBG'],
    z7: ['whiteBG'],
};

function legacyToAnsiUncached(fam, v) {
    if (LEG_PCB === fam || LEG_WC === fam) {
        const bg = PCB_BG[v.charAt(0)] || ['normal'];
        const fg = PCB_FG[v.charAt(1)] || ['normal'];
        return ANSI.sgr(fg.concat(bg));
    }
    if (LEG_WWIV === fam) {
        return ANSI.sgr(WWIV_SGR_ARGS[v] || 'normal');
    }
    if ('n1' === v) {
        return '\n';
    }
    if ('f1' === v) {
        return ANSI.clearScreen();
    }
    return ANSI.sgr(CNET_SGR_ARGS[v] || 'normal');
}

const LEGACY_CACHE = new Map();
function legacyToAnsi(fam, v) {
    const key = fam + v;
    let r = LEGACY_CACHE.get(key);
    if (undefined === r) {
        r = legacyToAnsiUncached(fam, v);
        LEGACY_CACHE.set(key, r);
    }
    return r;
}

//  ── MCI resolution (injected) ────────────────────────────────────────────────

let injectedResolver = null;
let injectedKnownMci = null;

//
//  predefined_mci.js calls this at load time with getPredefinedMCIValue and
//  the set of codes it knows. Nothing here requires it, so there is no cycle.
//  Returns the previous pair, so a test can put it back.
//
function setMciResolver(resolver, knownMci) {
    const previous = { resolver: injectedResolver, knownMci: injectedKnownMci };
    injectedResolver = resolver || null;
    injectedKnownMci = knownMci || null;
    return previous;
}

const MOVE_CODE = { 70: 'CF', 66: 'CB', 85: 'CU', 68: 'CD' };

//
//  The string render() inserts for an MCI or MOVE code, or undefined when it
//  shows the code literally. ui: a value only when it is a string. body: a
//  falsy value shows the literal code; a non-string one becomes a colour --
//  exactly what controlCodesToAnsi() has always done.
//
function mciShown(code, extra, opts, f) {
    if (!opts || !opts.client) {
        return undefined;
    }
    const resolver = opts.resolveMci || injectedResolver;
    if (!resolver) {
        return undefined;
    }
    const raw = resolver(opts.client, code, extra);
    if (f & F_BODY) {
        if (!raw) {
            return undefined;
        }
        return 'string' === typeof raw ? raw : sgrFromPipeColor(raw);
    }
    return 'string' === typeof raw ? raw : undefined;
}

//  ── Width primitives ─────────────────────────────────────────────────────────
//
//  Per code unit width + 1 (0 = not computed yet). Exact, because wcwidth
//  works per UTF-16 code unit: summing units gives the same total as the
//  per-code-point loop in strDisplayWidth(), astral characters included.
//
const UNIT_W = new Uint8Array(65536);

function unitWidthSlow(c) {
    const w = charDisplayWidth(String.fromCharCode(c));
    UNIT_W[c] = w + 1;
    return w;
}

function unitWidth(c) {
    const u = UNIT_W[c];
    return 0 !== u ? u - 1 : unitWidthSlow(c);
}

function textWidth(s, a, b) {
    let w = 0;
    for (let i = a; i < b; ++i) {
        const c = s.charCodeAt(i);
        if (c < 127 && c >= 32) {
            ++w;
        } else {
            w += unitWidth(c);
        }
    }
    return w;
}

//  Width of already rendered text: ANSI escapes only, in one pass.
function widthAnsi(s) {
    const len = s.length;
    let w = 0;
    for (let i = 0; i < len; ++i) {
        const c = s.charCodeAt(i);
        if (c < 127 && c >= 32) {
            ++w;
            continue;
        }
        if (27 === c) {
            const e = scanAnsi(s, i);
            if (e > 0) {
                w += ansiCellWidth();
                i = e - 1;
                continue;
            }
        }
        w += unitWidth(c);
    }
    return w;
}

//  ── render ───────────────────────────────────────────────────────────────────

//
//  Convert codes to ANSI. opts: { dialect, client, resolveMci }. Without a
//  client, MCI and cursor codes show literally.
//
function render(s, opts) {
    if (!s) {
        return '';
    }
    const f = flagsOf(opts);
    if (UI === f) {
        return renderUi(s, opts);
    }
    return renderGeneric(s, opts, f);
}

function renderUi(s, opts) {
    let i = s.indexOf('|');
    if (-1 === i) {
        return s;
    }
    let out = '';
    let last = 0;
    do {
        const e = scanPipe(s, i, UI);
        if (e < 0) {
            i = s.indexOf('|', i + 1);
            continue;
        }
        const type = tType;
        let rep;
        if (T.COLOR === type) {
            rep = SGR_CACHE[tVal] || pipeColorSgr(tVal);
        } else if (T.PIPE === type) {
            rep = '|';
        } else {
            const v =
                T.MOVE === type
                    ? mciShown(MOVE_CODE[tDir], s.slice(i + 3, e), opts, UI)
                    : mciShown(s.slice(i + 1, i + 3), undefined, opts, UI);
            rep = undefined === v ? s.slice(i, e) : v;
        }
        out += i > last ? s.slice(last, i) + rep : rep;
        last = e;
        i = s.indexOf('|', e);
    } while (-1 !== i);
    //  An MCI value can be '' ("|LO rest" for a user with no location): that
    //  renders as nothing, wherever it is. (renegadeToAnsi() used to return the
    //  raw source when every leading code was empty.)
    return out + s.slice(last);
}

function renderGeneric(s, opts, f) {
    if (f & F_ANSIONLY) {
        return s;
    }
    const len = s.length;
    const legacy = 0 !== (f & F_LEGACY);
    let out = '';
    let last = 0;
    for (let i = 0; i < len; ++i) {
        const c = s.charCodeAt(i);
        let e;
        if (124 === c) {
            e = scanPipe(s, i, f);
        } else if (legacy && isLegacyStart(c)) {
            e = scanLegacy(s, i, c);
        } else {
            continue;
        }
        if (e < 0) {
            continue;
        }
        const type = tType;
        let rep;
        if (T.COLOR === type) {
            rep = pipeColorSgr(tVal);
        } else if (T.LEGACY === type) {
            rep = legacyToAnsi(tVal, legacyValue(s, i, tVal));
        } else if (T.PIPE === type) {
            rep = '|';
        } else {
            const v =
                T.MOVE === type
                    ? mciShown(MOVE_CODE[tDir], s.slice(i + 3, e), opts, f)
                    : mciShown(s.slice(i + 1, i + 3), undefined, opts, f);
            rep = undefined === v ? s.slice(i, e) : v;
        }
        out += i > last ? s.slice(last, i) + rep : rep;
        last = e;
        i = e - 1;
    }
    return 0 === last ? s : out + s.slice(last);
}

//
//  Render and measure the result in one pass. Equal to
//  { text: render(s, opts), width: width(render(s, opts), { dialect: 'ansi' }) }.
//
function renderWithWidth(s, opts) {
    if (!s) {
        return { text: '', width: 0 };
    }
    const f = flagsOf(opts);
    if (UI !== f || -1 !== s.indexOf('\x1b')) {
        const text = render(s, opts);
        return { text, width: widthAnsi(text) };
    }
    let i = s.indexOf('|');
    if (-1 === i) {
        return { text: s, width: textWidth(s, 0, s.length) };
    }
    let out = '';
    let last = 0;
    let w = 0;
    let remeasure = false;
    do {
        const e = scanPipe(s, i, UI);
        if (e < 0) {
            i = s.indexOf('|', i + 1);
            continue;
        }
        const type = tType;
        let rep;
        if (T.COLOR === type) {
            rep = SGR_CACHE[tVal] || pipeColorSgr(tVal);
        } else if (T.PIPE === type) {
            rep = '|';
            w += 1;
        } else {
            const v =
                T.MOVE === type
                    ? mciShown(MOVE_CODE[tDir], s.slice(i + 3, e), opts, UI)
                    : mciShown(s.slice(i + 1, i + 3), undefined, opts, UI);
            if (undefined === v) {
                rep = s.slice(i, e);
                w += e - i;
            } else {
                rep = v;
                if (-1 === v.indexOf('\x1b')) {
                    w += textWidth(v, 0, v.length);
                } else if (T.MOVE === type && scanAnsi(v, 0) === v.length) {
                    w += ansiCellWidth();
                } else {
                    remeasure = true; //  an escape in a value can join its neighbours
                }
            }
        }
        if (i > last) {
            w += textWidth(s, last, i);
            out += s.slice(last, i) + rep;
        } else {
            out += rep;
        }
        last = e;
        i = s.indexOf('|', e);
    } while (-1 !== i);
    const text = out + s.slice(last);
    return {
        text,
        width: remeasure ? widthAnsi(text) : w + textWidth(s, last, s.length),
    };
}

//  ── width ────────────────────────────────────────────────────────────────────

//
//  Display cells of what render(s, opts) shows. ANSI escapes in |s| count as
//  well (ESC[nC = n) unless opts.ansi === false. Without a client an MCI or
//  cursor code shows literally, so it measures its printed width.
//
function width(s, opts) {
    if (!s) {
        return 0;
    }
    let f = flagsOf(opts);
    if (f & F_ANSIONLY) {
        return widthAnsi(s);
    }
    if (!(opts && false === opts.ansi)) {
        f |= F_ESC;
    }
    const legacy = 0 !== (f & F_LEGACY);
    const len = s.length;
    let w = 0;
    let i = 0;
    while (i < len) {
        const c = s.charCodeAt(i);
        if (c < 127 && c >= 32) {
            if (124 === c) {
                const e = scanPipe(s, i, f);
                if (e > 0) {
                    w += pipeTokenWidth(s, i, e, opts, f);
                    i = e;
                    continue;
                }
            } else if (64 === c && legacy) {
                const e = scanLegacy(s, i, c);
                if (e > 0) {
                    i = e;
                    continue;
                }
            }
            ++w;
            ++i;
            continue;
        }
        if (27 === c) {
            if (f & F_ESC) {
                const e = scanAnsi(s, i);
                if (e > 0) {
                    w += ansiCellWidth();
                    i = e;
                    continue;
                }
            }
        } else if (legacy && (3 === c || 25 === c || 17 === c)) {
            const e = scanLegacy(s, i, c);
            if (e > 0) {
                i = e; //  LEGACY = 0 (CNET n1 starts a new line)
                continue;
            }
        }
        w += unitWidth(c);
        ++i;
    }
    return w;
}

//  Width of the pipe token just scanned at s[i..e).
function pipeTokenWidth(s, i, e, opts, f) {
    const type = tType;
    if (T.COLOR === type) {
        return 0;
    }
    if (T.PIPE === type) {
        return 1;
    }
    if (T.MOVE === type) {
        const dir = tDir;
        const n = tVal;
        const v = mciShown(MOVE_CODE[dir], s.slice(i + 3, e), opts, f);
        return undefined === v ? e - i : 70 === dir ? n : 0;
    }
    const v = mciShown(s.slice(i + 1, i + 3), undefined, opts, f);
    return undefined === v ? e - i : widthAnsi(v);
}

//  ── splitPos ─────────────────────────────────────────────────────────────────

//
//  The index in |s| at which |cols| display cells have been used. Codes take
//  no cells (except cursor-forward and MCI values, which are never split); a
//  wide character that would straddle the boundary is left out. Literal
//  codes are text and may be split.
//
function splitPos(s, cols, opts) {
    if (!s) {
        return 0;
    }
    let f = flagsOf(opts);
    if (!(f & F_ANSIONLY) && !(opts && false === opts.ansi)) {
        f |= F_ESC;
    }
    const pipes = !(f & F_ANSIONLY);
    const legacy = 0 !== (f & F_LEGACY);
    const len = s.length;
    let vis = 0;
    let i = 0;
    while (i < len && vis < cols) {
        const c = s.charCodeAt(i);
        let e = -1;
        if (124 === c) {
            if (pipes) {
                e = scanPipe(s, i, f);
            }
        } else if (27 === c) {
            if (f & F_ESC) {
                e = scanAnsi(s, i);
                if (e > 0) {
                    const w = ansiCellWidth();
                    if (vis + w > cols) {
                        break; //  cursor-forward would overshoot
                    }
                    vis += w;
                    i = e;
                    continue;
                }
            }
        } else if (legacy && isLegacyStart(c)) {
            e = scanLegacy(s, i, c);
        }
        if (e > 0) {
            const type = tType;
            let w = 0;
            if (T.PIPE === type) {
                w = 1;
            } else if (T.MOVE === type || T.MCI === type) {
                const isMove = T.MOVE === type;
                const dir = tDir;
                const n = tVal;
                const v = isMove
                    ? mciShown(MOVE_CODE[dir], s.slice(i + 3, e), opts, f)
                    : mciShown(s.slice(i + 1, i + 3), undefined, opts, f);
                if (undefined === v) {
                    e = -1; //  shows literally: text
                } else {
                    w = isMove ? (70 === dir ? n : 0) : widthAnsi(v);
                }
            }
            if (e > 0) {
                if (vis + w > cols) {
                    break;
                }
                vis += w;
                i = e;
                continue;
            }
        }
        //  literal character, by code point
        let w = unitWidth(c);
        let n = 1;
        if (c >= 0xd800 && c <= 0xdbff && i + 1 < len) {
            const lo = s.charCodeAt(i + 1);
            if (lo >= 0xdc00 && lo <= 0xdfff) {
                w += unitWidth(lo);
                n = 2;
            }
        }
        if (vis + w > cols) {
            break; //  wide character straddles the boundary
        }
        vis += w;
        i += n;
    }
    return i;
}

//  ── strip ────────────────────────────────────────────────────────────────────

//
//  Remove every code render() would consume and keep what it shows
//  literally: '||' becomes '|' (ui), |CF05 becomes five spaces, and an |AA
//  code is dropped only when it is a known MCI code (opts.knownMci, else the
//  set predefined_mci.js registered) -- an unknown one stays as typed. With
//  no set at all every |AA code is dropped, so nothing leaks.
//  opts.ansi === true also drops ANSI escapes; opts.legacy === false keeps
//  the body dialect's @X## / ^C# / CNET codes (pipe codes only).
//
function strip(s, opts) {
    if (!s) {
        return '';
    }
    const ansi = !!(opts && true === opts.ansi);
    let f = flagsOf(opts) & ~F_ANSIONLY;
    if (opts && false === opts.legacy) {
        f &= ~F_LEGACY;
    }
    if (!ansi && !(f & F_LEGACY) && -1 === s.indexOf('|')) {
        return s;
    }
    if (ansi) {
        f |= F_ESC;
    }
    const known = (opts && opts.knownMci) || injectedKnownMci;
    if (UI === f) {
        return stripUi(s, known);
    }
    const legacy = 0 !== (f & F_LEGACY);
    const len = s.length;
    let out = '';
    let last = 0;
    for (let i = 0; i < len; ++i) {
        const c = s.charCodeAt(i);
        let e;
        if (124 === c) {
            e = scanPipe(s, i, f);
        } else if (27 === c && f & F_ESC) {
            e = scanAnsi(s, i);
            if (e > 0) {
                tType = T.ANSI;
            }
        } else if (legacy && isLegacyStart(c)) {
            e = scanLegacy(s, i, c);
        } else {
            continue;
        }
        if (e < 0) {
            continue;
        }
        const type = tType;
        let rep = '';
        if (T.MCI === type) {
            if (known && !known.has(s.slice(i + 1, i + 3))) {
                i = e - 1; //  stays literal
                continue;
            }
        } else if (T.PIPE === type) {
            rep = '|';
        } else if (T.MOVE === type) {
            if (70 === tDir) {
                rep = ' '.repeat(tVal);
            }
        } else if (T.LEGACY === type) {
            if (LEG_CNET === tVal && 110 === s.charCodeAt(i + 1)) {
                rep = '\n'; //  n1
            }
        }
        out += s.slice(last, i) + rep;
        last = e;
        i = e - 1;
    }
    return 0 === last ? s : out + s.slice(last);
}

function stripUi(s, known) {
    let i = s.indexOf('|');
    let out = '';
    let last = 0;
    while (-1 !== i) {
        //  colour codes are nearly all of them: no scanner call
        const c1 = s.charCodeAt(i + 1);
        if (isDigit(c1) && isDigit(s.charCodeAt(i + 2))) {
            if (i > last) {
                out += s.slice(last, i);
            }
            last = i + 3;
            i = s.indexOf('|', last);
            continue;
        }
        const e = scanPipe(s, i, UI);
        if (e < 0) {
            i = s.indexOf('|', i + 1);
            continue;
        }
        const type = tType;
        if (T.MCI === type && known && !known.has(s.slice(i + 1, i + 3))) {
            i = s.indexOf('|', e); //  stays literal
            continue;
        }
        out += s.slice(last, i);
        if (T.PIPE === type) {
            out += '|';
        } else if (T.MOVE === type && 70 === tDir) {
            out += ' '.repeat(tVal);
        }
        last = e;
        i = s.indexOf('|', e);
    }
    return 0 === last ? s : out + s.slice(last);
}

//  ── substr (#1022) ───────────────────────────────────────────────────────────

const ANSI_ONLY = { dialect: 'ansi' };

//
//  substr() in display cells: |length| cells starting at cell |start|.
//
//  *   Zero-width codes before |start| are kept, so the colour in effect
//      carries into the window; text before |start| is dropped.
//  *   A wide character straddling the start edge becomes a space; one
//      straddling the end edge is left out.
//  *   A cursor-forward or MCI value straddling an edge is cut to its
//      visible part. Zero-width codes directly after the window are kept.
//
//  The result is source text that is rendered again, so it must not form a
//  code the input did not have. In the ui dialect a literal '|' is emitted
//  as '||' (inside an MCI value slice too), and a kept zero-width cursor
//  code a following digit could extend (|CU1, |CU) is emitted as its escape.
//  The body dialects have no pipe escape, so a join is still possible there.
//
function substr(s, start, length, opts) {
    if (!s) {
        return '';
    }
    start = start || 0;
    const end = start + (undefined === length ? Infinity : length);
    let f = flagsOf(opts);
    if (!(f & F_ANSIONLY) && !(opts && false === opts.ansi)) {
        f |= F_ESC;
    }
    const pipes = !(f & F_ANSIONLY);
    const legacy = 0 !== (f & F_LEGACY);
    const esc = 0 !== (f & F_PIPEESC);
    const len = s.length;
    let col = 0;
    let out = '';
    let i = 0;
    let runStart = true; //  the next text character starts a text run
    outer: while (i < len) {
        const c = s.charCodeAt(i);
        let e = -1;
        if (124 === c) {
            if (pipes) {
                e = scanPipe(s, i, f);
            }
        } else if (27 === c) {
            if (f & F_ESC) {
                e = scanAnsi(s, i);
                tType = T.ANSI;
            }
        } else if (legacy && isLegacyStart(c)) {
            e = scanLegacy(s, i, c);
        }
        if (e < 0) {
            //  ── text
            if (c < 127 && c >= 32) {
                if (col >= end) {
                    break;
                }
                if (124 === c && esc) {
                    if (col >= start) {
                        out += '||'; //  a literal pipe stays literal
                    }
                    ++col;
                    ++i;
                } else if (col >= start) {
                    //  copy the ASCII run inside the window in one slice
                    let j = i + 1;
                    const lim = Math.min(len, i + (end - col));
                    while (j < lim) {
                        const cj = s.charCodeAt(j);
                        if (cj < 32 || cj >= 127 || 124 === cj || (64 === cj && legacy)) {
                            break;
                        }
                        ++j;
                    }
                    out += s.slice(i, j);
                    col += j - i;
                    i = j;
                } else {
                    ++col;
                    ++i;
                }
                runStart = false;
                continue;
            }
            let w = unitWidth(c);
            let n = 1;
            if (c >= 0xd800 && c <= 0xdbff && i + 1 < len) {
                const lo = s.charCodeAt(i + 1);
                if (lo >= 0xdc00 && lo <= 0xdfff) {
                    w += unitWidth(lo);
                    n = 2;
                }
            }
            if (col >= end && (w > 0 || runStart)) {
                break;
            }
            if (col + w > end) {
                break; //  straddles the end
            }
            if (col >= start) {
                out += 1 === n ? s[i] : s.slice(i, i + 2);
            } else if (col + w > start) {
                out += ' '; //  straddles the start
            }
            col += w;
            i += n;
            runStart = false;
            continue;
        }
        //  ── code s[i..e)
        runStart = true;
        const type = tType;
        let w = 0;
        if (T.COLOR === type || T.LEGACY === type) {
            out += s.slice(i, e);
            i = e;
            continue;
        }
        if (T.PIPE === type) {
            if (col >= end) {
                break;
            }
            if (col >= start) {
                out += '||';
            }
            col += 1;
            i = e;
            continue;
        }
        if (T.ANSI === type) {
            w = ansiCellWidth();
        } else {
            const isMove = T.MOVE === type;
            const dir = tDir;
            const n = tVal;
            const v = isMove
                ? mciShown(MOVE_CODE[dir], s.slice(i + 3, e), opts, f)
                : mciShown(s.slice(i + 1, i + 3), undefined, opts, f);
            if (undefined === v) {
                //  shows literally: one cell per character
                for (let k = i; k < e; ++k) {
                    if (col >= end) {
                        break outer;
                    }
                    if (col >= start) {
                        out += esc && 124 === s.charCodeAt(k) ? '||' : s[k];
                    }
                    col += 1;
                }
                i = e;
                continue;
            }
            if (isMove) {
                w = 70 === dir ? n : 0;
                if (0 === w) {
                    out += v; //  |CU1 then a digit would read as |CU1#
                    i = e;
                    continue;
                }
            } else {
                w = widthAnsi(v);
                if (
                    0 === w &&
                    67 === s.charCodeAt(i + 1) &&
                    MOVE_CODE[s.charCodeAt(i + 2)]
                ) {
                    out += v; //  |CU then a digit would read as |CU#
                    i = e;
                    continue;
                }
                if (w > 0 && !(col >= start && col + w <= end)) {
                    //  the value straddles an edge: emit its visible slice
                    if (col >= end) {
                        break;
                    }
                    const a = Math.max(col, start);
                    const b = Math.min(col + w, end);
                    if (b > a) {
                        const part = substr(v, a - col, b - a, ANSI_ONLY);
                        out +=
                            esc && -1 !== part.indexOf('|')
                                ? part.replace(/\|/g, '||')
                                : part;
                    }
                    col += w;
                    i = e;
                    continue;
                }
            }
        }
        if (0 === w) {
            out += s.slice(i, e); //  zero width: always kept (state)
        } else {
            //  cursor forward or an MCI value: never split
            if (col >= end) {
                break;
            }
            if (col >= start && col + w <= end) {
                out += s.slice(i, e);
            } else {
                const a = Math.max(col, start);
                const b = Math.min(col + w, end);
                if (b > a) {
                    out += ANSI.forward(b - a);
                }
            }
            col += w;
        }
        i = e;
    }
    return out;
}

//
//  Cut |s| to opts.length cells (default 30), ending in opts.omission
//  (default '...') when anything was cut.
//
function truncate(s, opts) {
    if (!s) {
        return '';
    }
    opts = opts || {};
    const len = opts.length || 30;
    const omission = 'string' === typeof opts.omission ? opts.omission : '...';
    if (width(s, opts) <= len) {
        return s;
    }
    return substr(s, 0, Math.max(0, len - width(omission, opts)), opts) + omission;
}

//
//  The colour of a complete |## code at s[i], or -1. The editors' live
//  preview handles only these.
//
function colorCodeAt(s, i) {
    if (124 !== s.charCodeAt(i)) {
        return -1;
    }
    const c1 = s.charCodeAt(i + 1);
    const c2 = s.charCodeAt(i + 2);
    return isDigit(c1) && isDigit(c2) ? (c1 - 48) * 10 + (c2 - 48) : -1;
}

//  ── walk / tokenize (tests and tooling; not on the hot paths) ────────────────

//  walk(s, opts, onToken(type, start, end, value))
function walk(s, opts, onToken) {
    let f = flagsOf(opts);
    if (!(opts && false === opts.ansi)) {
        f |= F_ESC;
    }
    const pipes = !(f & F_ANSIONLY);
    const legacy = 0 !== (f & F_LEGACY);
    const len = s.length;
    let textStart = 0;
    let i = 0;
    while (i < len) {
        const c = s.charCodeAt(i);
        let e = -1;
        let value = null;
        if (124 === c && pipes) {
            e = scanPipe(s, i, f);
            if (e > 0) {
                if (T.COLOR === tType) {
                    value = tVal;
                } else if (T.MOVE === tType) {
                    value = { dir: String.fromCharCode(tDir), n: tVal };
                } else if (T.MCI === tType) {
                    value = s.slice(i + 1, i + 3);
                }
            }
        } else if (27 === c && f & F_ESC) {
            e = scanAnsi(s, i);
            if (e > 0) {
                tType = T.ANSI;
                ANSI_STICKY.lastIndex = i;
                const m = ANSI_STICKY.exec(s);
                value = { args: m[1], cmd: m[2] };
            }
        } else if (legacy && isLegacyStart(c)) {
            e = scanLegacy(s, i, c);
            if (e > 0) {
                value = { fam: LEG_FAM_NAME[tVal], v: legacyValue(s, i, tVal) };
            }
        }
        if (e > 0) {
            const type = tType;
            if (i > textStart) {
                onToken(T.TEXT, textStart, i, null);
            }
            onToken(type, i, e, value);
            i = textStart = e;
            continue;
        }
        ++i;
    }
    if (len > textStart) {
        onToken(T.TEXT, textStart, len, null);
    }
}

//  tokenize(s, opts) -> [{ type, raw, value }]
function tokenize(s, opts) {
    const out = [];
    s = s || '';
    walk(s, opts, (type, start, end, value) =>
        out.push({ type, raw: s.slice(start, end), value })
    );
    return out;
}

//  For tests: the hand ANSI scanner at s[i] as [end, cmd, firstArg], or null.
function scanAnsiAt(s, i) {
    const e = scanAnsi(s, i);
    return e < 0 ? null : [e, String.fromCharCode(aCmd), aN];
}

exports.T = T;
exports.DIALECT = DIALECT;
exports.render = render;
exports.renderWithWidth = renderWithWidth;
exports.width = width;
exports.strip = strip;
exports.substr = substr;
exports.truncate = truncate;
exports.splitPos = splitPos;
exports.colorCodeAt = colorCodeAt;
exports.pipeColorSgr = pipeColorSgr;
exports.setMciResolver = setMciResolver;
exports.walk = walk;
exports.tokenize = tokenize;
exports.scanAnsiAt = scanAnsiAt;
