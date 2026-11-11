/* jslint node: true */
'use strict';

//
//  PETSCII character set tables (#593).
//
//  Pure data and lookups: Unicode <-> Commodore PETSCII bytes, for both screen
//  character sets, plus the control/colour/key byte constants. No ENiGMA
//  imports on purpose so this file can move to another package unchanged.
//
//  INTERNAL REPRESENTATION
//  -----------------------
//  Text stays Unicode and BMP-only: exactly one UTF-16 unit per PETSCII glyph.
//
//  *   A glyph that has an exact (or long-standing conventional) standard code
//      point uses it: letters, digits, pound sign, pi, box drawing, block
//      elements, card suits, circles, arcs, check mark, arrows.
//  *   Every other glyph uses a private-use code point in ONE contiguous range:
//
//          PUA_BASE + (charsetIndex << 8) + byte        (0xEC00 - 0xEDFF)
//
//      charsetIndex 0 = upper/graphics, 1 = lower/upper. `byte` is the canonical
//      PETSCII byte of the glyph (see below), so a PUA code point decodes back
//      to its glyph WITHOUT needing the charset argument. A glyph that is drawn
//      identically by both sets uses index 0. Only the 21 glyphs in the table
//      below use it. Nothing astral (no U+1FBxx Legacy Computing) is ever used.
//
//  TWO CHARACTER SETS
//  ------------------
//  The whole screen is in one of two sets at a time (never per cell):
//
//      upper/graphics  (Charsets.UpperGraphics, 'upper', 0x8E)  the C64 power-on set
//      lower/upper     (Charsets.LowerUpper,    'lower', 0x0E)  ENiGMA's default
//
//  They differ only in the letter slots (screen codes 0x01-0x1A, 0x41-0x5A) and
//  four graphics (0x5E, 0x5F, 0x69, 0x7A). In lower/upper, bytes 0x41-0x5A draw
//  lower case letters and 0xC1-0xDA draw upper case (ASCII with case swapped).
//
//  CANONICAL BYTES AND DUPLICATES
//  ------------------------------
//  PETSCII has several byte ranges that draw the same glyph (screen codes in
//  parentheses; see the Commodore 64 Programmer's Reference Guide, appendix B,
//  and icy_tools icy_parser_core/src/petscii.rs `petscii_to_screen_code`, which
//  implements the same fold):
//
//      0x60-0x7F  mirror 0xC0-0xDF                       (0x40-0x5F)
//      0xE0-0xFE  mirror 0xA0-0xBE                       (0x60-0x7E)
//      0xFF       is the same glyph as 0xDE ("pi")       (0x5E)
//
//  Canonical byte (what unicodeToByte/encode produce) is, in order: printable
//  ASCII range 0x20-0x5F, then 0xA0-0xBF, then 0xC0-0xDF; the lowest byte wins
//  among glyphs that happen to be drawn identically, except where Synchronet
//  (src/xpdev/petdefs.h) names a specific byte (PETSCII_VERTLINE 0xDD). So:
//  letters a-z/A-Z -> 0x41-0x5A / 0xC1-0xDA in lower/upper, A-Z -> 0x41-0x5A in
//  upper/graphics; 0xA0 (shifted space, a blank) decodes as a plain space and
//  encodes as 0x20.
//
//  Beyond the mirrors, the C64 ROM has a few duplicated shapes inside the
//  canonical range, found by comparing the ROM bitmaps (icy_tools
//  icy_engine/data/fonts/Commodore/C64_PETSCII_*.psf): 0xC0/0xC3 (horizontal
//  line), 0xC2/0xDD (vertical line), 0xA5/0xB4 (left quarter block), 0xA7/0xAA
//  (right quarter block). Each pair decodes to one code point; the canonical
//  byte is 0xC0, 0xDD, 0xA5, 0xA7.
//
//  HOW THE GLYPH TABLES WERE MADE
//  ------------------------------
//  Both 128-entry tables below (indexed by C64 SCREEN CODE, not PETSCII byte)
//  were produced by rasterising the 8x8 ROM glyphs from the two icy_tools .psf
//  fonts above and matching each against block elements, light box drawing,
//  quadrants, triangles; an exact bitmap match gets the Unicode code point. Where
//  the shape is a conventional picture of a Unicode symbol (suits, circles, the
//  four rounded corners, diagonals, pi, check mark) that code point is used even
//  though the pixels differ slightly. Everything else is PUA. Cross-checked
//  against Synchronet's names (petdefs.h, con_out.cpp petscii_to_ansibbs): e.g.
//  0xBA is a check mark and 0xBF a checkerboard in lower/upper, 0xA1/0xA2 are
//  the left/bottom halves.
//
//  PUA GLYPHS (code point, canonical byte, sets that draw it, shape)
//
//      U+ECA7  0xA7  both   right quarter block (2 px wide, right edge)
//      U+ECA8  0xA8  both   lower-half checker (bottom 4 rows of the 0xA6 hatch)
//      U+ECB6  0xB6  both   right 3/8 block (3 px wide, right edge)
//      U+ECB7  0xB7  both   top quarter block (2 px tall, top edge)
//      U+ECB8  0xB8  both   top 3/8 block (3 px tall, top edge)
//      U+ECBA  0xBA  upper  right + bottom edge corner (2 px strokes)
//      U+ECC4  0xC4  upper  horizontal line, pixel rows 2-3
//      U+ECC5  0xC5  upper  horizontal line, pixel rows 1-2
//      U+ECC6  0xC6  upper  horizontal line, pixel rows 4-5
//      U+ECC7  0xC7  upper  vertical line, pixel cols 2-3
//      U+ECC8  0xC8  upper  vertical line, pixel cols 4-5
//      U+ECCC  0xCC  upper  left + bottom edge corner (2 px strokes)
//      U+ECCF  0xCF  upper  top + left edge corner (2 px strokes)
//      U+ECD0  0xD0  upper  top + right edge corner (2 px strokes)
//      U+ECD2  0xD2  upper  horizontal line, pixel rows 5-6
//      U+ECD4  0xD4  upper  vertical line, pixel cols 1-2
//      U+ECD9  0xD9  upper  vertical line, pixel cols 5-6
//      U+ECDC  0xDC  both   checker, left half only
//      U+EDA9  0xA9  lower  hatch (diagonal weave)
//      U+EDDE  0xDE  lower  hatch (2x2 checker, shifted 2 px from the 0xA6 hatch)
//      U+EDDF  0xDF  lower  hatch (weave, variant)
//
//  (A glyph used by only one set has no mapping in the other: unicodeToByte
//  returns undefined for it there and encode() falls back.)
//
//  FALLBACKS ON ENCODE
//  -------------------
//  See FALLBACKS below. Short version: the CP437 box/block/shade/arrow set that
//  ENiGMA art produces goes to the nearest PETSCII graphic the way Synchronet's
//  cp437_to_petscii (src/sbbs3/con_out.cpp) does; ASCII PETSCII lacks gets the
//  substitutes Synchronet uses; typographic characters fold to ASCII. Fallbacks
//  that only draw in one set say so and degrade to something in the other.
//

const Charsets = Object.freeze({
    UpperGraphics: 'upper',
    LowerUpper: 'lower',
});

const DEFAULT_CHARSET = Charsets.LowerUpper;

//  Synchronet src/xpdev/petdefs.h (PETSCII_* constants) and the table in the design doc.
const Controls = Object.freeze({
    cursorUp: 0x91, // PETSCII_UP
    cursorDown: 0x11, // PETSCII_DOWN
    cursorLeft: 0x9d, // PETSCII_LEFT
    cursorRight: 0x1d, // PETSCII_RIGHT
    home: 0x13, // PETSCII_HOME
    clear: 0x93, // PETSCII_CLEAR
    reverseOn: 0x12, // PETSCII_REVERSE_ON
    reverseOff: 0x92, // PETSCII_REVERSE_OFF
    charsetLower: 0x0e, // PETSCII_UPPERLOWER
    charsetUpper: 0x8e, // PETSCII_UPPERGRFX
    delete: 0x14, // PETSCII_DELETE
    insert: 0x94, // PETSCII_INSERT
    return: 0x0d, // CR, also turns reverse off
    shiftReturn: 0x8d, // PETSCII_CRLF
});

//  petdefs.h colour constants (C64 meanings; C128 80 column reuses some).
const Colors = Object.freeze({
    white: 0x05, // PETSCII_WHITE
    red: 0x1c, // PETSCII_RED
    green: 0x1e, // PETSCII_GREEN
    blue: 0x1f, // PETSCII_BLUE
    orange: 0x81, // PETSCII_ORANGE
    black: 0x90, // PETSCII_BLACK
    brown: 0x95, // PETSCII_BROWN
    lightRed: 0x96, // PETSCII_LIGHTRED
    darkGrey: 0x97, // PETSCII_DARKGRAY
    grey: 0x98, // PETSCII_MEDIUMGRAY
    lightGreen: 0x99, // PETSCII_LIGHTGREEN
    lightBlue: 0x9a, // PETSCII_LIGHTBLUE
    lightGrey: 0x9b, // PETSCII_LIGHTGRAY
    purple: 0x9c, // PETSCII_PURPLE
    yellow: 0x9e, // PETSCII_YELLOW
    cyan: 0x9f, // PETSCII_CYAN
});

//
//  ANSI colour index (0-7 normal, 8-15 bright; ANSI order: black, red, green,
//  yellow/brown, blue, magenta, cyan, white) -> closest C64 colour byte.
//
//  Source: Synchronet src/sbbs3/petscii_term.cpp `PETSCII_Terminal::attrstr`
//  (C64 subset). It switches on Synchronet's CGA-ordered attribute, and we
//  re-index that to ANSI order:
//
//      CGA BLACK        -> 0x90 black          ANSI 0
//      CGA RED          -> 0x1C red            ANSI 1
//      CGA GREEN        -> 0x1E green          ANSI 2
//      CGA BROWN        -> 0x95 brown          ANSI 3
//      CGA BLUE         -> 0x1F blue           ANSI 4
//      CGA MAGENTA      -> 0x81 orange         ANSI 5
//      CGA CYAN         -> 0x98 grey           ANSI 6   (C64; C128 80 col uses 0x97)
//      CGA LIGHTGRAY    -> 0x9B light grey     ANSI 7
//      CGA DARKGRAY     -> 0x97 dark grey      ANSI 8   (C64; C128 80 col uses 0x98)
//      CGA LIGHTRED     -> 0x96 light red      ANSI 9
//      CGA LIGHTGREEN   -> 0x99 light green    ANSI 10
//      CGA YELLOW       -> 0x9E yellow         ANSI 11
//      CGA LIGHTBLUE    -> 0x9A light blue     ANSI 12
//      CGA LIGHTMAGENTA -> 0x9C purple         ANSI 13
//      CGA LIGHTCYAN    -> 0x9F cyan           ANSI 14
//      CGA WHITE        -> 0x05 white          ANSI 15
//
const AnsiToPetsciiColor = Object.freeze([
    Colors.black,
    Colors.red,
    Colors.green,
    Colors.brown,
    Colors.blue,
    Colors.orange,
    Colors.grey,
    Colors.lightGrey,
    Colors.darkGrey,
    Colors.lightRed,
    Colors.lightGreen,
    Colors.yellow,
    Colors.lightBlue,
    Colors.purple,
    Colors.cyan,
    Colors.white,
]);

//
//  Bytes a C64 keyboard sends, named the way ENiGMA's ANSI input decoder names
//  keys (core/term/ansi/input_decoder.js: 'up arrow', 'return', 'f1', ...).
//  F-key bytes are the real C64 keyboard codes (F1 $85, F3 $86, F5 $87, F7 $88,
//  F2 $89, F4 $8A, F6 $8B, F8 $8C), the same as SyncTERM cterm.c `petscii_keys`.
//  Shift-Return (0x8D) is reported as plain 'return' (key names carry no shift).
//
const KeyBytes = Object.freeze({
    0x0d: 'return',
    0x8d: 'return',
    0x11: 'down arrow',
    0x1d: 'right arrow',
    0x91: 'up arrow',
    0x9d: 'left arrow',
    0x13: 'home',
    0x93: 'clear',
    0x14: 'backspace', // DEL key
    0x94: 'insert', // Shift-DEL
    0x85: 'f1',
    0x89: 'f2',
    0x86: 'f3',
    0x8a: 'f4',
    0x87: 'f5',
    0x8b: 'f6',
    0x88: 'f7',
    0x8c: 'f8',
});

const PUA_BASE = 0xec00;

//
//  Glyph per C64 screen code (0x00-0x7F; 0x80-0xFF are these in reverse video).
//  Upper/graphics first, lower/upper second.
//
//  PETSCII byte -> screen code: 0x20-0x3F same; 0x40-0x5F -0x40; 0x60-0x7F -0x20;
//  0xA0-0xBF -0x40; 0xC0-0xFE -0x80; 0xFF -> 0x5E.
//
// prettier-ignore
const SCREEN_GLYPHS_UPPER = [
    '@',
    'A',
    'B',
    'C',
    'D',
    'E',
    'F',
    'G',
    'H',
    'I',
    'J',
    'K',
    'L',
    'M',
    'N',
    'O', // screen 00-0F
    'P',
    'Q',
    'R',
    'S',
    'T',
    'U',
    'V',
    'W',
    'X',
    'Y',
    'Z',
    '[',
    '£',
    ']',
    '↑',
    '←', // screen 10-1F
    ' ',
    '!',
    '"',
    '#',
    '$',
    '%',
    '&',
    "'",
    '(',
    ')',
    '*',
    '+',
    ',',
    '-',
    '.',
    '/', // screen 20-2F
    '0',
    '1',
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
    '8',
    '9',
    ':',
    ';',
    '<',
    '=',
    '>',
    '?', // screen 30-3F
    '─',
    '♠',
    '│',
    '─',
    '\uECC4',
    '\uECC5',
    '\uECC6',
    '\uECC7',
    '\uECC8',
    '╮',
    '╰',
    '╯',
    '\uECCC',
    '╲',
    '╱',
    '\uECCF', // screen 40-4F
    '\uECD0',
    '●',
    '\uECD2',
    '♥',
    '\uECD4',
    '╭',
    '╳',
    '○',
    '♣',
    '\uECD9',
    '♦',
    '┼',
    '\uECDC',
    '│',
    'π',
    '◥', // screen 50-5F
    ' ',
    '▌',
    '▄',
    '▔',
    '▁',
    '▎',
    '▒',
    '\uECA7',
    '\uECA8',
    '◤',
    '\uECA7',
    '├',
    '▗',
    '└',
    '┐',
    '▂', // screen 60-6F
    '┌',
    '┴',
    '┬',
    '┤',
    '▎',
    '▍',
    '\uECB6',
    '\uECB7',
    '\uECB8',
    '▃',
    '\uECBA',
    '▖',
    '▝',
    '┘',
    '▘',
    '▚', // screen 70-7F
];

// prettier-ignore
const SCREEN_GLYPHS_LOWER = [
    '@',
    'a',
    'b',
    'c',
    'd',
    'e',
    'f',
    'g',
    'h',
    'i',
    'j',
    'k',
    'l',
    'm',
    'n',
    'o', // screen 00-0F
    'p',
    'q',
    'r',
    's',
    't',
    'u',
    'v',
    'w',
    'x',
    'y',
    'z',
    '[',
    '£',
    ']',
    '↑',
    '←', // screen 10-1F
    ' ',
    '!',
    '"',
    '#',
    '$',
    '%',
    '&',
    "'",
    '(',
    ')',
    '*',
    '+',
    ',',
    '-',
    '.',
    '/', // screen 20-2F
    '0',
    '1',
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
    '8',
    '9',
    ':',
    ';',
    '<',
    '=',
    '>',
    '?', // screen 30-3F
    '─',
    'A',
    'B',
    'C',
    'D',
    'E',
    'F',
    'G',
    'H',
    'I',
    'J',
    'K',
    'L',
    'M',
    'N',
    'O', // screen 40-4F
    'P',
    'Q',
    'R',
    'S',
    'T',
    'U',
    'V',
    'W',
    'X',
    'Y',
    'Z',
    '┼',
    '\uECDC',
    '│',
    '\uEDDE',
    '\uEDDF', // screen 50-5F
    ' ',
    '▌',
    '▄',
    '▔',
    '▁',
    '▎',
    '▒',
    '\uECA7',
    '\uECA8',
    '\uEDA9',
    '\uECA7',
    '├',
    '▗',
    '└',
    '┐',
    '▂', // screen 60-6F
    '┌',
    '┴',
    '┬',
    '┤',
    '▎',
    '▍',
    '\uECB6',
    '\uECB7',
    '\uECB8',
    '▃',
    '✓',
    '▖',
    '▝',
    '┘',
    '▘',
    '▚', // screen 70-7F
];

const CHARSET_INDEX = { upper: 0, lower: 1 };

function charsetIndexOf(charset) {
    const name = undefined === charset ? DEFAULT_CHARSET : charset;
    const idx = Object.prototype.hasOwnProperty.call(CHARSET_INDEX, name)
        ? CHARSET_INDEX[name]
        : undefined;
    if (undefined === idx) {
        throw new TypeError(`Unknown PETSCII charset: ${charset}`);
    }
    return idx;
}

//  true for the bytes the terminal acts on rather than draws: 0x00-0x1F, 0x80-0x9F
function isControlByte(byte) {
    return (byte >= 0x00 && byte <= 0x1f) || (byte >= 0x80 && byte <= 0x9f);
}

//  PETSCII byte (printable) -> C64 screen code; see the table comment above.
function screenCodeOf(byte) {
    if (byte >= 0x20 && byte <= 0x3f) return byte;
    if (byte >= 0x40 && byte <= 0x5f) return byte - 0x40;
    if (byte >= 0x60 && byte <= 0x7f) return byte - 0x20;
    if (byte >= 0xa0 && byte <= 0xbf) return byte - 0x40;
    if (byte >= 0xc0 && byte <= 0xfe) return byte - 0x80;
    return 0x5e; // 0xFF, pi
}

const SCREEN_GLYPHS = [SCREEN_GLYPHS_UPPER, SCREEN_GLYPHS_LOWER];

//  byte -> single-unit string, total over 0-255 for both sets
const BYTE_TO_CHAR = SCREEN_GLYPHS.map(glyphs => {
    const table = new Array(256);
    for (let b = 0; b < 256; ++b) {
        table[b] = isControlByte(b) ? String.fromCharCode(b) : glyphs[screenCodeOf(b)];
    }
    return Object.freeze(table);
});

//  char -> canonical byte (first wins in the order documented in the header)
const CHAR_TO_BYTE = BYTE_TO_CHAR.map(table => {
    const map = new Map();
    const order = [];
    for (let b = 0x20; b <= 0x5f; ++b) order.push(b);
    for (let b = 0xa0; b <= 0xbf; ++b) order.push(b);
    for (let b = 0xc0; b <= 0xdf; ++b) order.push(b);
    for (const b of order) {
        if (!map.has(table[b])) {
            map.set(table[b], b);
        }
    }
    //  Synchronet PETSCII_VERTLINE is 0xDD, not the 0xC2 duplicate
    if (map.has('│')) {
        map.set('│', 0xdd);
    }
    return map;
});

function byteToUnicode(byte, charset) {
    if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) {
        throw new RangeError(`Not a byte: ${byte}`);
    }
    return BYTE_TO_CHAR[charsetIndexOf(charset)][byte];
}

function toCodePoint(codePointOrChar) {
    return 'string' === typeof codePointOrChar
        ? codePointOrChar.codePointAt(0)
        : codePointOrChar;
}

//  exact mapping only: C0/C1 pass through, then the glyph table
function exactByte(cp, idx) {
    if (isControlByte(cp)) {
        return cp;
    }
    if (undefined === cp || cp > 0xffff) {
        return undefined;
    }
    return CHAR_TO_BYTE[idx].get(String.fromCharCode(cp));
}

//
//  FALLBACKS
//
//  code point -> { upper: [candidates], lower: [candidates] }. Tried in order,
//  first that fully resolves wins. A candidate is:
//
//      string            every character must have an EXACT mapping; '' means "drop it"
//      number            a PETSCII byte, used as is (only listed where it draws the
//                        intended glyph in that set)
//      { reverse: byte } glyph only available as reverse video (see SOLID_BLOCK)
//
const FALLBACKS = new Map();

function fallback(chars, both, perSet) {
    const sets = Object.assign({ upper: both, lower: both }, perSet);
    for (const ch of chars) {
        FALLBACKS.set(ch.codePointAt(0), sets);
    }
}

//  Box drawing. Source: Synchronet con_out.cpp cp437_to_petscii. It folds the CP437
//  double and mixed lines onto the single-line PETSCII graphics, which every PETSCII
//  charset draws: 186/179 -> 0xDD; 205/196 -> 0xC0; 206 215 216 197 -> 0xDB;
//  188 189 190 217 -> 0xBD; 201 213 214 218 -> 0xB0; 183 184 187 191 -> 0xAE;
//  200 211 212 192 -> 0xAD; 198 199 204 195 -> 0xAB; 180 181 182 185 -> 0xB3;
//  203 209 210 194 -> 0xB2; 202 207 208 193 -> 0xB1.
//  The single-line characters themselves are exact mappings, not fallbacks.
//  Same glyphs in both sets.
fallback('║', ['│']);
fallback('═', ['─']);
fallback('╬╫╪', ['┼']);
fallback('╝╜╛', ['┘']);
fallback('╔╒╓', ['┌']);
fallback('╖╕╗', ['┐']);
fallback('╚╙╘', ['└']);
fallback('╞╟╠', ['├']);
fallback('╡╢╣', ['┤']);
fallback('╦╤╥', ['┬']);
fallback('╩╧╨', ['┴']);

//  Blocks and shades. Synchronet: 219 -> PETSCII_SOLID (0xA0, wrapped in reverse
//  on/off by its output path), 220 -> 0xA2, 221 -> 0xA1, 222 -> 0xB6, 223 -> 0xB8,
//  254 -> 0xBE; 176 -> 0xA6, 177 -> 0xDE, 178 -> 0xA9.
//  U+2584 and U+258C are exact (0xA2, 0xA1), so only the rest are listed.
//
//  0xA0 is a BLANK (shifted space); a solid cell is a reverse-video blank, hence
//  the { reverse } candidate. encode() wraps it in 0x12 .. 0x92 unless told not to.
//
//  PETSCII has one hatch density: 0xA6 (exact U+2592) in both sets. Synchronet also
//  uses 0xDE and 0xA9 for the heavier shades, but those draw pi and a triangle in
//  upper/graphics, so: U+2591 -> U+2592 everywhere; U+2593 -> the 0xA9 weave in
//  lower/upper (the only set it exists in), U+2592 elsewhere.
fallback('█', [{ reverse: 0xa0 }]);
fallback('▐', [0xb6]); // right 3/8, nearest to a right half
fallback('▀', [0xb8]); // top 3/8, nearest to a top half
fallback('■▪◼', ['▘']); // Synchronet PETSCII_UPRLFTBOX
fallback('░', ['▒']);
fallback('▓', ['▒'], { lower: ['\uEDA9', '▒'] });

//  Arrows. Synchronet: 0x18 0x1E -> 0x5E (up arrow); 0x19 0x1F -> 'V'; 0x1A -> '>';
//  0x10 -> '>'; 0x11 -> '<'. U+2191 and U+2190 are exact (0x5E, 0x5F).
fallback('▲', ['↑']);
fallback('▼↓', ['V']);
fallback('►▶→', ['>']);
fallback('◄◀', ['<']);
fallback('↔', ['-']);
fallback('↕', ['│']);

//  Check mark: 0xBA in lower/upper only (exact there). Synchronet: 251 -> PETSCII_CHECKMARK.
//  Upper/graphics 0xBA is an unrelated corner, so use 'V' there.
fallback('√✓✔', ['✓'], { upper: ['V'] });

//  Bullets and shapes with no counterpart in lower/upper (the C64 draws them in
//  upper/graphics only): a filled circle there, '*' / 'o' otherwise.
fallback('•∙·◦', ['●'], { lower: ['*'] });
fallback('○◌', ['○'], { lower: ['o'] });
fallback('●', ['●'], { lower: ['*'] });

//  ASCII PETSCII lacks or draws differently. Synchronet cp437_to_petscii and
//  petdefs.h: '|' 0xDD, '\\' '/' ("the 109 graphics char is an 'M' in shifted/text
//  mode"), '`' 0xAD, '~' 0xA8, '_' 0xA4, '{' '(' and '}' ')'; '^' stays byte 0x5E, which draws an up arrow.
//  In the 0xAD/0xA8/0xA4 cases the byte draws the same glyph in both sets.
fallback('|', ['│']);
fallback('\\', ['/']);
fallback('^', ['↑']);
fallback('_', [0xa4]); // U+2581 lower eighth block, exact in both sets
fallback('`', [0xad]); // U+2514, exact in both sets (Synchronet's choice)
fallback('~', [0xa8]); // lower-half hatch, U+ECA8 in both sets
fallback('{', ['(']);
fallback('}', [')']);

//  Typographic characters -> plain ASCII equivalents.
fallback('‘’‚′ʼ', ["'"]);
fallback('“”„″', ['"']);
fallback('‐‑‒–—―−', ['-']);
fallback('…', ['...']);
fallback('\u00A0\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u3000', [
    ' ',
]);
fallback('\u200B\u200C\u200D\u2060\uFEFF\u00AD', ['']); // zero width, soft hyphen: drop
fallback('‹', ['<']);
fallback('›', ['>']);
fallback('«', ['<<']);
fallback('»', ['>>']);
fallback('†‡', ['+']);
fallback('‰', ['%']);
fallback('×', ['x']);
fallback('÷', ['/']);
fallback('±', ['+/-']);
fallback('°', ['o']);
fallback('¢', ['c']);
fallback('¥', ['Y']);
fallback('€', ['E']);
fallback('©', ['(c)']);
fallback('®', ['(R)']);
fallback('™', ['TM']);
fallback('µ', ['u']);
fallback('¶§', ['S']);
fallback('¡', ['!']);
fallback('¿', ['?']);
fallback('½', ['1/2']);
fallback('¼', ['1/4']);
fallback('¾', ['3/4']);
fallback('¹', ['1']);
fallback('²', ['2']);
fallback('³', ['3']);

//  Latin letters with no decomposition: ASCII fold.
fallback('ß', ['ss']);
fallback('Æ', ['AE']);
fallback('æ', ['ae']);
fallback('Œ', ['OE']);
fallback('œ', ['oe']);
fallback('Ø', ['O']);
fallback('ĐÐ', ['D']);
fallback('ø', ['o']);
fallback('đð', ['d']);
fallback('Ł', ['L']);
fallback('ł', ['l']);
fallback('Þ', ['Th']);
fallback('þ', ['th']);

//  The only glyph that exists solely as reverse video.
const SOLID_BLOCK = '█';
const SOLID_BLOCK_BYTE = 0xa0;

//  exact mapping, or the upper case letter for a lower case one (upper/graphics
//  has no lower case)
function exactOrFolded(cp, idx) {
    const b = exactByte(cp, idx);
    return undefined === b && cp >= 0x61 && cp <= 0x7a ? exactByte(cp - 0x20, idx) : b;
}

//  Result of mapping one code point: { bytes, reverse } or undefined.
function resolve(cp, idx) {
    const exact = exactByte(cp, idx);
    if (undefined !== exact) {
        return { bytes: [exact], reverse: false };
    }
    if (undefined === cp || cp > 0xffff) {
        return undefined;
    }

    //  upper/graphics has no lower case: fold to the upper case letters
    const folded = exactOrFolded(cp, idx);
    if (undefined !== folded) {
        return { bytes: [folded], reverse: false };
    }

    const entry = FALLBACKS.get(cp);
    if (entry) {
        for (const cand of entry[0 === idx ? 'upper' : 'lower']) {
            if ('number' === typeof cand) {
                return { bytes: [cand], reverse: false };
            }
            if ('object' === typeof cand) {
                return { bytes: [cand.reverse], reverse: true };
            }
            const bytes = [];
            let ok = true;
            for (const ch of cand) {
                const b = exactOrFolded(ch.codePointAt(0), idx);
                if (undefined === b) {
                    ok = false;
                    break;
                }
                bytes.push(b);
            }
            if (ok) {
                return { bytes, reverse: false };
            }
        }
        return undefined;
    }

    //  accented Latin: strip combining marks (e -> e, n-tilde -> n)
    const nfd = String.fromCharCode(cp).normalize('NFD');
    if (nfd.length > 1 && /^[̀-ͯ]+$/.test(nfd.slice(1))) {
        return resolve(nfd.codePointAt(0), idx);
    }

    return undefined;
}

//
//  Byte for a code point or one-character string, or undefined when there is no
//  single-byte mapping. Exact mappings come first, then the single byte fallbacks
//  above ('|' -> 0xDD, U+2593 -> a hatch, ...). Not returned: glyphs that need
//  reverse video (U+2588, see reverseOnlyByte) and fallbacks that expand to several
//  bytes ('...'); encode() does produce those.
//
function unicodeToByte(codePointOrChar, charset) {
    const r = resolve(toCodePoint(codePointOrChar), charsetIndexOf(charset));
    return r && !r.reverse && 1 === r.bytes.length ? r.bytes[0] : undefined;
}

//  If the glyph is only drawable as reverse video, the byte to print with
//  Controls.reverseOn active (U+2588 -> 0xA0). Otherwise undefined.
function reverseOnlyByte(codePointOrChar) {
    return toCodePoint(codePointOrChar) === SOLID_BLOCK.codePointAt(0)
        ? SOLID_BLOCK_BYTE
        : undefined;
}

function decode(buffer, charset) {
    const table = BYTE_TO_CHAR[charsetIndexOf(charset)];
    let s = '';
    for (let i = 0; i < buffer.length; ++i) {
        s += table[buffer[i]];
    }
    return s;
}

//
//  options.fallbackByte  byte for characters with no mapping (default 0x3F '?')
//  options.reverseSolid  wrap U+2588 as reverseOn 0xA0 reverseOff the way Synchronet
//                        does (default true). A caller that tracks reverse state
//                        itself passes false and gets the bare 0xA0 (a blank!)
//                        and must use reverseOnlyByte() instead.
//
function encode(string, charset, options) {
    const idx = charsetIndexOf(charset);
    const opts = options || {};
    const fallbackByte = undefined === opts.fallbackByte ? 0x3f : opts.fallbackByte;
    const reverseSolid = false !== opts.reverseSolid;

    const out = [];
    for (const ch of String(string)) {
        const cp = ch.codePointAt(0);
        const r = resolve(cp, idx);
        if (!r) {
            //  a combining mark on its own (decomposed input): the base letter
            //  has already been written, so the mark is dropped, not shown as '?'
            if (cp >= 0x300 && cp <= 0x36f) {
                continue;
            }
            out.push(fallbackByte);
        } else if (r.reverse && reverseSolid) {
            out.push(Controls.reverseOn, ...r.bytes, Controls.reverseOff);
        } else {
            out.push(...r.bytes);
        }
    }
    return Buffer.from(out);
}

module.exports = {
    Charsets,
    DEFAULT_CHARSET,
    Controls,
    Colors,
    AnsiToPetsciiColor,
    KeyBytes,
    PUA_BASE,
    isControlByte,
    byteToUnicode,
    unicodeToByte,
    reverseOnlyByte,
    decode,
    encode,
};
