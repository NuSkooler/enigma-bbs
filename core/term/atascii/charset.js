/* jslint node: true */
'use strict';

//
//  ATASCII character set tables (#593).
//
//  Pure data and lookups: Unicode <-> Atari 8-bit ATASCII bytes, plus the
//  control and key byte constants. No ENiGMA imports on purpose so this file
//  can move to another package unchanged. Companion to ../petscii/charset.js and
//  built the same way.
//
//  INTERNAL REPRESENTATION
//  -----------------------
//  Text stays Unicode and BMP-only: exactly one UTF-16 unit per ATASCII glyph.
//
//  *   A glyph that has an exact (or long-standing conventional) standard code
//      point uses it: ASCII letters, digits and punctuation, card suits, box
//      drawing, block elements, quadrants, triangles, arrows.
//  *   Every other glyph uses a private-use code point:
//
//          PUA_BASE + byte        (PUA_BASE = 0xEE00, bytes 0x00-0x7F)
//
//      where `byte` is the glyph's byte in the normal-video half. Only two glyphs
//      need it (see PUA GLYPHS), so the scheme is deliberately tiny. The range
//      0xEE00-0xEEFF does not overlap PETSCII's 0xEC00-0xEDFF. Nothing astral
//      (no U+1FBxx Legacy Computing) is ever used, although Unicode 13 does give
//      the two PUA glyphs and the clear-screen arrow code points there.
//
//  THE TWO HALVES (INVERSE VIDEO)
//  ------------------------------
//  Bit 7 of an ATASCII byte is inverse video, done by ANTIC in hardware: the
//  glyph for byte 0x80+n is the bitmap complement of the glyph for n. Verified
//  by comparing every pair in icy_tools icy_engine/data/fonts/Atari/Atari_ATASCII.psf
//  (all 128 high glyphs are exactly the complement of the low ones, control
//  positions included; Wikipedia "ATASCII", "Inverse video", says the same).
//
//  This library represents that as: byteToUnicode(0x80 + n) === byteToUnicode(n)
//  (the SAME code point) and isInverse(byte) reports bit 7 separately. A screen
//  cell is therefore (character, inverse flag), which is how ENiGMA's attributes
//  already work (the cell colour swap), instead of 128 extra code points.
//
//  Some glyphs exist in Unicode only as the complement of another ATASCII glyph:
//  the full block (inverse space), the upper half block (inverse lower half), the
//  right half block, the two upper triangles and the four three-quadrant blocks.
//  Their byte is >= 0x80 and complementByte() reports it. That is the whole
//  "exact through inverse video" set; see COMPLEMENT_GLYPHS.
//
//  CONTROL BYTES AND THE ESC RULE
//  ------------------------------
//  Sixteen bytes are acted on by the Atari screen editor (E:) instead of drawn:
//
//      0x1B-0x1F  ESC, cursor up, down, left, right
//      0x7D-0x7F  clear screen, backspace, tab
//      0x9B-0x9F  end of line, delete line, insert line, clear tab, set tab
//      0xFD-0xFF  bell, delete character, insert character
//
//  (Controls below.) Every other byte, 0x00-0x1A, 0x20-0x7C, 0x80-0x9A and
//  0xA0-0xFC, is a glyph. Unlike ASCII almost all of 0x00-0x1F are glyphs: they
//  are the line, corner, block and suit graphics.
//
//  Every control byte also has a glyph. It is drawn when the byte is preceded by
//  ESC (0x1B): ESC makes the NEXT byte a literal glyph and is itself consumed.
//  ESC ESC draws the escape glyph. QuotedGlyphs lists those glyphs; quoteByte()
//  makes the two-byte sequence. The one exception is the end of line, 0x9B, which
//  is a newline even after ESC (Wikipedia, ATASCII "Control characters"; SyncTERM
//  cterm_atascii.c atascii_literal_byte; icy_tools differs: it prints a glyph),
//  so no glyph is reachable through 0x9B, which canQuote() reports.
//
//  decode()/encode() below follow those rules. Text can never drive the terminal:
//  encode() writes a control byte only as the second byte of ESC + byte, and the
//  one deliberate exception, a newline in the input, as 0x9B.
//
//  ALTERNATE (INTERNATIONAL) CHARACTER SET
//  ---------------------------------------
//  The Atari XL/XE ROM has a second set that replaces 29 of the 0x00-0x1F
//  graphics with accented Latin letters. It is chosen by a CPU register (CHBAS,
//  or Ctrl-F4 on the 1200XL), never by a byte in the stream, and neither
//  SyncTERM nor icy_tools can switch it from the stream (icy_term only loads
//  its XEP80 variant as an unused second font slot). This library therefore
//  models only the default set and leaves the international one out.
//
//  GLYPH TABLE
//  -----------
//  Rasterised from Atari_ATASCII.psf (256 glyphs, 8x8, indexed by ATASCII byte,
//  not by Atari screen code) and matched against the Unicode shapes, as was done
//  for PETSCII; Wikipedia's ATASCII table (Bettencourt's ATASCII to Unicode
//  mapping) is the cross-check. 0x20-0x7F is ASCII except the five entries in
//  ASCII_OVERRIDES. The XEP80 font (xep80.psf) has the same glyph order and
//  shapes at 7x10, except its 0x9B cell is blank.
//
//  PUA GLYPHS
//
//      U+EE02  0x02  right quarter block (2 px wide, right edge); Unicode has
//                    U+1FB87, astral
//      U+EE0D  0x0D  upper quarter block (2 px tall, top edge); U+1FB82, astral
//
//  FALLBACKS ON ENCODE
//  -------------------
//  See FALLBACKS below. The CP437 box, block and shade set that ENiGMA art
//  produces is mapped to the nearest ATASCII graphic, typographic characters
//  fold to ASCII, accented Latin loses its accent. Where a glyph is reachable
//  only with ESC the table says so.
//

const Controls = Object.freeze({
    escape: 0x1b,
    cursorUp: 0x1c,
    cursorDown: 0x1d,
    cursorLeft: 0x1e,
    cursorRight: 0x1f,
    clear: 0x7d,
    backspace: 0x7e,
    tab: 0x7f,
    eol: 0x9b,
    deleteLine: 0x9c,
    insertLine: 0x9d,
    clearTab: 0x9e,
    setTab: 0x9f,
    bell: 0xfd,
    deleteChar: 0xfe,
    insertChar: 0xff,
});
//  Sources: icy_tools icy_parser_core/src/atascii.rs AtasciiParser::parse (every
//  byte above), SyncTERM src/conio/cterm_atascii.c cterm_atascii_handlers, Wikipedia
//  "ATASCII" control character table (same sixteen).

const INVERSE_BIT = 0x80;
const PUA_BASE = 0xee00;

//  What each client's keyboard sends, named the way ENiGMA's ANSI input decoder
//  names keys. This table names what each byte IS as a typed key; the input
//  decoder unit decides what it reports. Several bytes below are also graphics on
//  a real Atari keyboard (Ctrl-H, Ctrl-I, Ctrl-M type graphics), so they only
//  mean a key because a PC terminal program sends them:
//
//  *   0x9B Return          real Atari keyboard; icy_term ATASCII_KEY_MAP (Enter -> 155)
//  *   0x0D Return          SyncTERM: cterm.c atascii_keys has no entry for Enter,
//                           so the raw key code 13 goes out (Wikipedia: Atari BBSs
//                           told Atari and ASCII callers apart by 155 vs 13)
//  *   0x7E Backspace       real Atari BACKSPACE key; SyncTERM's Delete key
//                           (atascii_keys CIO_KEY_DC); icy_term sends ESC 0x7E
//                           for Backspace, see EscPrefixedKeys
//  *   0x08 Backspace       SyncTERM: the Backspace key, raw
//  *   0x7F / 0x09 Tab      real Atari TAB key; SyncTERM's Tab key, raw
//  *   0x1B Escape          all
//  *   0x1C-0x1F arrows     real Atari Ctrl+- = + *; SyncTERM atascii_keys arrows
//  *   0xFF Insert          SyncTERM atascii_keys CIO_KEY_IC (also the real
//                           Atari's Ctrl+> insert character)
//  *   0xFE Delete          real Atari Ctrl+Backspace (delete character)
//
//  Neither SyncTERM nor icy_term sends anything for Home, End (icy sends ESC 0x9B),
//  Page Up/Down or function keys that is distinct from the above.
const KeyBytes = Object.freeze({
    0x9b: 'return',
    0x0d: 'return',
    0x7e: 'backspace',
    0x08: 'backspace',
    0x7f: 'tab',
    0x09: 'tab',
    0x1b: 'escape',
    0x1c: 'up arrow',
    0x1d: 'down arrow',
    0x1e: 'left arrow',
    0x1f: 'right arrow',
    0xff: 'insert',
    0xfe: 'delete',
});

//  icy_term ATASCII_KEY_MAP (crates/icy_engine_gui/src/terminal_keys.rs) sends these
//  keys as ESC + byte, which on an Atari would be the quoted glyph. Key names by
//  the byte that follows ESC; the input decoder must accept both forms.
const EscPrefixedKeys = Object.freeze({
    0x1c: 'up arrow',
    0x1d: 'down arrow',
    0x1e: 'left arrow',
    0x1f: 'right arrow',
    0x7e: 'backspace',
    0x9b: 'end',
});

//  Terminal sizes. SyncTERM src/conio/vidmodes.c ATARI_40X24 (40x24) and ATARI_80X25
//  (XEP80, 80x25); icy_engine screen_modes.rs ATASCII_SCREEN_SIZE 40x24,
//  ATASCII_XEP80_SCREEN_SIZE 80x25 (ATASCII_PAL_SCREEN_SIZE 40x25 exists too).
//  Both emulators use every column from column 0; neither models the 2-column
//  left margin of the real E: device.
const Screens = Object.freeze({
    antic: Object.freeze({ columns: 40, rows: 24 }),
    xep80: Object.freeze({ columns: 80, rows: 25 }),
});

//
//  Glyphs of the 32 bytes 0x00-0x1F. Atari_ATASCII.psf, checked against Wikipedia.
//  0x1B-0x1F are control bytes: the glyph is what ESC + byte draws.
//
const GRAPHICS = [
    '♥', // 0x00 heart
    '├', // 0x01 light vertical and right (2 px lines)
    String.fromCharCode(PUA_BASE + 0x02), // 0x02 right quarter block (PUA, U+1FB87)
    '┘', // 0x03 up and left
    '┤', // 0x04 vertical and left
    '┐', // 0x05 down and left
    '╱', // 0x06 diagonal upper right to lower left
    '╲', // 0x07 diagonal upper left to lower right
    '◢', // 0x08 black lower right triangle
    '▗', // 0x09 quadrant lower right
    '◣', // 0x0A black lower left triangle
    '▝', // 0x0B quadrant upper right
    '▘', // 0x0C quadrant upper left
    String.fromCharCode(PUA_BASE + 0x0d), // 0x0D upper quarter block (PUA, U+1FB82)
    '▂', // 0x0E lower one quarter block
    '▖', // 0x0F quadrant lower left
    '♣', // 0x10 club
    '┌', // 0x11 down and right
    '─', // 0x12 horizontal (2 px line, rows 3-4)
    '┼', // 0x13 vertical and horizontal
    '•', // 0x14 ball; Wikipedia gives U+2022 BULLET
    '▄', // 0x15 lower half block
    '▎', // 0x16 left one quarter block
    '┬', // 0x17 down and horizontal
    '┴', // 0x18 up and horizontal
    '▌', // 0x19 left half block
    '└', // 0x1A up and right
    '␛', // 0x1B escape (control; glyph is the letters ESC, U+241B)
    '↑', // 0x1C up arrow (control)
    '↓', // 0x1D down arrow (control)
    '←', // 0x1E left arrow (control)
    '→', // 0x1F right arrow (control)
];

//  0x20-0x7F is ASCII except these (Atari_ATASCII.psf, Wikipedia):
//    0x60 diamond for the grave accent, 0x7B spade for '{', 0x7D, 0x7E and 0x7F
//    (all three controls) draw an arrow and two triangles. 0x7C is a full height
//    vertical bar, drawn exactly like U+007C '|'.
const ASCII_OVERRIDES = {
    0x60: '♦', // black diamond suit
    0x7b: '♠', // black spade suit
    //  clear screen glyph: an arrowhead top left with a tail to the lower right.
    //  Unicode names it U+1F8B0 (astral, so out); U+2196 is the BMP picture.
    0x7d: '↖',
    0x7e: '◀', // black left-pointing triangle (backspace glyph)
    0x7f: '▶', // black right-pointing triangle (tab glyph)
};

const BYTE_TO_CHAR = (() => {
    const low = [];
    for (let b = 0; b < 0x80; ++b) {
        if (b < 0x20) {
            low.push(GRAPHICS[b]);
        } else if (Object.prototype.hasOwnProperty.call(ASCII_OVERRIDES, b)) {
            low.push(ASCII_OVERRIDES[b]);
        } else {
            low.push(String.fromCharCode(b));
        }
    }
    //  the high half draws the same glyphs in inverse video
    return Object.freeze(low.concat(low));
})();

const CONTROL_BYTES = Object.freeze(Object.values(Controls));
const CONTROL_SET = new Set(CONTROL_BYTES);

//  true for the bytes the terminal acts on rather than draws (unless an ESC
//  precedes them). Anything that is not a byte is not a control byte.
function isControlByte(byte) {
    return CONTROL_SET.has(byte);
}

//  Whether ESC + byte draws the byte's glyph. True for every control byte but the
//  end of line, which stays a newline (see the header).
function canQuote(byte) {
    return isControlByte(byte) && byte !== Controls.eol;
}

//  The glyph each control byte draws when quoted, byte -> character. Frozen. The
//  high half bytes (0x9C-0x9F, 0xFD-0xFF) draw the low half glyph in inverse video;
//  0x9B has none (see canQuote).
const QuotedGlyphs = Object.freeze(
    Object.fromEntries(CONTROL_BYTES.filter(canQuote).map(b => [b, BYTE_TO_CHAR[b]]))
);

function checkByte(byte) {
    if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) {
        throw new RangeError(`Not a byte: ${byte}`);
    }
}

//  Bytes that draw `byte`'s glyph: [ESC, byte] for a control byte, [byte] otherwise.
//  Throws for the end of line, which cannot be quoted, and for a non-byte.
function quoteByte(byte) {
    checkByte(byte);
    if (!isControlByte(byte)) {
        return Buffer.from([byte]);
    }
    if (!canQuote(byte)) {
        throw new RangeError(`Byte 0x${byte.toString(16)} cannot be quoted`);
    }
    return Buffer.from([Controls.escape, byte]);
}

//  true for the inverse-video half, control bytes excluded: a control byte has no
//  inverse glyph of its own on the wire, it acts. (Quoted, it draws the inverse
//  glyph; see QuotedGlyphs.)
function isInverse(byte) {
    return byte >= INVERSE_BIT && byte <= 0xff && !isControlByte(byte);
}

//  The glyph cell for a byte. Total over 0x00-0xFF and one UTF-16 unit: the high
//  half gives the same character as the low half (see the header). Control bytes
//  give the glyph they draw when quoted, so the result is "what the cell shows",
//  not "what the byte does".
function byteToUnicode(byte) {
    checkByte(byte);
    return BYTE_TO_CHAR[byte];
}

//  char -> normal video byte (0x00-0x7F). No two ATASCII glyphs share a code point
//  or a bitmap (verified against the font), so there is nothing to disambiguate.
const CHAR_TO_BYTE = (() => {
    const map = new Map();
    for (let b = 0; b < 0x80; ++b) {
        map.set(BYTE_TO_CHAR[b], b);
    }
    return map;
})();

//
//  Glyphs that Unicode has only as the complement of another ATASCII glyph, so the
//  only way to draw them is an inverse video byte. char -> inverse byte. Each is the
//  exact bitmap complement of the glyph of (byte & 0x7F), found by complementing the
//  font bitmaps and matching the geometry of the Unicode block elements:
//
//      U+2588 full block                 0xA0  inverse space
//      U+2580 upper half block           0x95  inverse lower half block
//      U+2590 right half block           0x99  inverse left half block
//      U+25E4 black upper left triangle  0x88  inverse lower right triangle
//      U+25E5 black upper right triangle 0x8A  inverse lower left triangle
//      U+259C quadrants UL UR LR         0x8F  inverse lower left quadrant
//      U+259B quadrants UL UR LL         0x89  inverse lower right quadrant
//      U+259F quadrants UR LL LR         0x8C  inverse upper left quadrant
//      U+2599 quadrants UL LL LR         0x8B  inverse upper right quadrant
//
//  The complements of the 2 px strips (3/4 blocks) have no BMP code point.
//
const COMPLEMENT_GLYPHS = Object.freeze({
    '█': 0xa0,
    '▀': 0x95,
    '▐': 0x99,
    '◤': 0x88,
    '◥': 0x8a,
    '▜': 0x8f,
    '▛': 0x89,
    '▟': 0x8c,
    '▙': 0x8b,
});

function toChar(codePointOrChar) {
    const cp =
        'string' === typeof codePointOrChar
            ? codePointOrChar.codePointAt(0)
            : codePointOrChar;
    return Number.isInteger(cp) && cp >= 0 && cp <= 0xffff
        ? String.fromCharCode(cp)
        : undefined;
}

//  own, truthy option; prototype keys and non-object options are ignored
function ownOption(options, name) {
    return (
        null !== options &&
        'object' === typeof options &&
        Object.prototype.hasOwnProperty.call(options, name) &&
        options[name]
    );
}

//
//  Byte of the glyph for a code point or one-character string, or undefined when
//  no byte draws it. By default (inverse false) the result is the normal video
//  byte 0x00-0x7F. With { inverse: true } it is that byte plus 0x80, the cell in
//  inverse video. The result may be a control byte: its glyph then needs ESC (see
//  canQuote/quoteByte). Complement-only glyphs (U+2588 ...) and fallbacks are not
//  returned here; see complementByte() and encode().
//
function unicodeToByte(codePointOrChar, options) {
    const ch = toChar(codePointOrChar);
    const byte = undefined === ch ? undefined : CHAR_TO_BYTE.get(ch);
    if (undefined === byte) {
        return undefined;
    }
    return ownOption(options, 'inverse') ? byte | INVERSE_BIT : byte;
}

//  For a glyph that Unicode has only as the complement of another one (U+2588 full
//  block, ...), the inverse video byte that draws it: 0xA0 for the full block.
//  Otherwise undefined.
function complementByte(codePointOrChar) {
    const ch = toChar(codePointOrChar);
    return undefined !== ch && Object.prototype.hasOwnProperty.call(COMPLEMENT_GLYPHS, ch)
        ? COMPLEMENT_GLYPHS[ch]
        : undefined;
}

//
//  FALLBACKS
//
//  code point -> [candidates], tried in order, the first that fully resolves wins.
//  A candidate is a string whose every character has an EXACT mapping (a glyph or
//  a complement glyph, never another fallback); '' means "drop it".
//
//  There is no ATASCII-specific reference for these (Synchronet has no ATASCII
//  output path; SyncTERM only receives). They follow the PETSCII library's
//  families, and the glyph shapes in the font.
//
const FALLBACKS = new Map();

function fallback(chars, ...candidates) {
    for (const ch of chars) {
        FALLBACKS.set(ch.codePointAt(0), candidates);
    }
}

//  Box drawing. ATASCII has the single line set: ─ 0x12, a vertical bar 0x7C ('|'),
//  four corners 0x11 0x05 0x1A 0x03, tees 0x01 0x04 0x17 0x18 and the cross 0x13,
//  all plain glyphs that need no ESC. The CP437 double and mixed lines fold onto
//  them the way the PETSCII library does (Synchronet cp437_to_petscii).
//  U+2502 and U+007C draw the same bar, so U+2502 goes to '|'.
fallback('│║┃', '|');
fallback('═━', '─');
fallback('╬╫╪╋', '┼');
fallback('╝╜╛┛╯', '┘');
fallback('╔╒╓┏╭', '┌');
fallback('╖╕╗┓╮', '┐');
fallback('╚╙╘┗╰', '└');
fallback('╞╟╠┣', '├');
fallback('╡╢╣┫', '┤');
fallback('╦╤╥┳', '┬');
fallback('╩╧╨┻', '┴');

//  Blocks and shades. Exact, no fallback needed: U+2588 U+2584 U+2580 U+258C U+2590
//  (the upper half, full and right half only through inverse video), quadrants,
//  triangles. ATASCII has no hatch or checker glyph, so shades become an ASCII
//  density ramp. The diagonal quadrants become the diagonal strokes the font has.
fallback('░', '.');
fallback('▒', '*');
fallback('▓', '#');
fallback('■▪◼▮', '█');
fallback('□▫◻▯', 'o');
fallback('▞', '╱');
fallback('▚', '╲');
fallback('▬', '-');

//  Arrows and pointers. U+2191 U+2193 U+2190 U+2192 U+25B6 U+25C0 are exact but
//  need ESC; with quoting off, or for the CP437 triangles, ASCII stands in.
fallback('▲', '^');
fallback('▼', 'v');
fallback('►', '▶', '>');
fallback('◄', '◀', '<');
fallback('▶', '>');
fallback('◀', '<');
fallback('↑', '^');
fallback('↓', 'v');
fallback('←', '<');
fallback('→', '>');
fallback('↔', '-');
fallback('↕', '|');
fallback('↖', '^');
fallback('␛', '');

//  Bullets, shapes, marks.
fallback('∙·●⚫', '•');
fallback('○◦◌', 'o');
fallback('√✓✔', 'v');
fallback('☺☻', ':)');
fallback('☼', '*');

//  ASCII that ATASCII lacks: 0x60, 0x7B, 0x7D and 0x7E are a diamond, a spade, an
//  arrow and a triangle. (A literal ASCII '|' is 0x7C, same as the bar.)
fallback('`', "'");
fallback('{', '(');
fallback('}', ')');
fallback('~', '-');

//  Typographic characters -> plain ASCII equivalents.
fallback('‘’‚′ʼ', "'");
fallback('“”„″', '"');
fallback('‐‑‒–—―−', '-');
fallback('…', '...');
//  no-break and fixed width spaces
fallback(String.fromCharCode(0xa0, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007), ' ');
fallback(String.fromCharCode(0x2008, 0x2009, 0x200a, 0x202f, 0x3000), ' ');
//  zero width characters and the soft hyphen: drop
fallback(String.fromCharCode(0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0xad), '');
fallback('‹', '<');
fallback('›', '>');
fallback('«', '<<');
fallback('»', '>>');
fallback('†‡', '+');
fallback('‰', '%');
fallback('×', 'x');
fallback('÷', '/');
fallback('±', '+/-');
fallback('°', 'o');
fallback('¢', 'c');
fallback('£', 'L');
fallback('¥', 'Y');
fallback('€', 'E');
fallback('©', '(c)');
fallback('®', '(R)');
fallback('™', 'TM');
fallback('µ', 'u');
fallback('¶§', 'S');
fallback('¡', '!');
fallback('¿', '?');
fallback('½', '1/2');
fallback('¼', '1/4');
fallback('¾', '3/4');
fallback('¹', '1');
fallback('²', '2');
fallback('³', '3');
fallback('ⁿ', 'n');
fallback('≤', '<=');
fallback('≥', '>=');
fallback('≈≡', '=');
fallback('∞', '8');
fallback('♪♫', '#');

//  Latin letters with no decomposition: ASCII fold.
fallback('ß', 'ss');
fallback('Æ', 'AE');
fallback('æ', 'ae');
fallback('Œ', 'OE');
fallback('œ', 'oe');
fallback('Ø', 'O');
fallback('ĐÐ', 'D');
fallback('ø', 'o');
fallback('đð', 'd');
fallback('Ł', 'L');
fallback('ł', 'l');
fallback('Þ', 'Th');
fallback('þ', 'th');

//  Byte of one character through an exact mapping (glyph, then complement glyph).
function exact(ch) {
    const byte = CHAR_TO_BYTE.get(ch);
    if (undefined !== byte) {
        return byte;
    }
    return Object.prototype.hasOwnProperty.call(COMPLEMENT_GLYPHS, ch)
        ? COMPLEMENT_GLYPHS[ch]
        : undefined;
}

function isCombiningMark(cp) {
    return cp >= 0x300 && cp <= 0x36f;
}

//
//  Bytes (before the inverse option and quoting) for one code point, or undefined.
//  `quoted` false makes glyphs that need ESC unavailable so their fallbacks apply.
//
function resolve(cp, quoted) {
    if (undefined === cp || cp > 0xffff) {
        return undefined;
    }
    const usable = byte => quoted || !isControlByte(byte);

    const ch = String.fromCharCode(cp);
    const byte = exact(ch);
    if (undefined !== byte && usable(byte)) {
        return [byte];
    }

    const candidates = FALLBACKS.get(cp);
    if (candidates) {
        for (const cand of candidates) {
            const bytes = [];
            let ok = true;
            for (const c of cand) {
                const b = exact(c);
                if (undefined === b || !usable(b)) {
                    ok = false;
                    break;
                }
                bytes.push(b);
            }
            if (ok) {
                return bytes;
            }
        }
        return undefined;
    }

    //  accented Latin: strip combining marks (e acute -> e, n tilde -> n)
    const nfd = ch.normalize('NFD');
    if (
        nfd.length > 1 &&
        [...nfd.slice(1)].every(c => isCombiningMark(c.codePointAt(0)))
    ) {
        return resolve(nfd.codePointAt(0), quoted);
    }

    return undefined;
}

//  Push one output byte, ESC-quoting control bytes. False when it cannot be written
//  (the end of line, which the inverse option can flip a glyph into).
function emitByte(byte, out) {
    if (!isControlByte(byte)) {
        out.push(byte);
        return true;
    }
    if (!canQuote(byte)) {
        return false;
    }
    out.push(Controls.escape, byte);
    return true;
}

//
//  decode: the glyph text a byte stream puts on the screen.
//
//  *   ESC quotes the next byte, which then draws its glyph (QuotedGlyphs);
//      ESC ESC gives U+241B. A trailing ESC with nothing after it is dropped.
//  *   0x9B is a newline, '\n', even when quoted.
//  *   Any other control byte acts and draws nothing, so it is dropped.
//  *   Inverse video is dropped: the high half decodes to the same characters as the
//      low half. Use decodeCells() to keep it.
//
function decode(buffer) {
    let s = '';
    for (const cell of decodeCells(buffer)) {
        s += cell.char;
    }
    return s;
}

//  Like decode, but one entry per drawn cell: { char, inverse }. A newline is
//  { char: '\n', inverse: false }. `inverse` is bit 7 of the byte that drew it, which
//  for a quoted control byte is its inverse glyph (ESC 0x9C draws an inverse up arrow).
function decodeCells(buffer) {
    if (!buffer || 'number' !== typeof buffer.length) {
        throw new TypeError('decode needs a Buffer or Uint8Array');
    }
    const cells = [];
    let quoted = false;
    for (let i = 0; i < buffer.length; ++i) {
        const b = buffer[i];
        if (quoted) {
            quoted = false;
            if (b === Controls.eol) {
                cells.push({ char: '\n', inverse: false });
            } else {
                cells.push({ char: BYTE_TO_CHAR[b], inverse: b >= INVERSE_BIT });
            }
        } else if (b === Controls.escape) {
            quoted = true;
        } else if (b === Controls.eol) {
            cells.push({ char: '\n', inverse: false });
        } else if (!isControlByte(b)) {
            cells.push({ char: BYTE_TO_CHAR[b], inverse: b >= INVERSE_BIT });
        }
    }
    return cells;
}

//
//  encode: string -> ATASCII bytes.
//
//  options.fallbackByte  byte for characters with no mapping (default 0x3F '?'). It
//                        must be a non-control byte, else RangeError.
//  options.inverse       draw every glyph in inverse video: bit 7 is flipped on each
//                        byte. A glyph that is only a complement (U+2588) therefore
//                        comes out as its low half byte (a space). Not applied to
//                        the fallback byte or to line ends.
//  options.quoted        false = never write ESC + byte; glyphs that need it (arrows,
//                        pointers, the escape glyph) use their ASCII fallback
//                        instead. Default true.
//
//  Newlines: LF, CR and CR LF each become one end of line, 0x9B. A tab becomes a
//  space. Every other C0/C1 control character (and DEL) is dropped. Nothing but
//  those newlines and ESC-quoted glyphs ever writes a control byte.
//
function encode(string, options) {
    const hasFallback =
        null !== options &&
        'object' === typeof options &&
        Object.prototype.hasOwnProperty.call(options, 'fallbackByte') &&
        undefined !== options.fallbackByte;
    const fb = hasFallback ? options.fallbackByte : 0x3f;
    checkByte(fb);
    if (isControlByte(fb)) {
        throw new RangeError(`fallbackByte 0x${fb.toString(16)} is a control byte`);
    }
    const inverse = !!ownOption(options, 'inverse');
    const quoted = !(
        null !== options &&
        'object' === typeof options &&
        Object.prototype.hasOwnProperty.call(options, 'quoted') &&
        false === options.quoted
    );
    const flip = inverse ? INVERSE_BIT : 0;

    const text = undefined === string || null === string ? '' : String(string);
    const out = [];
    let afterCr = false;
    for (const ch of text) {
        const cp = ch.codePointAt(0);
        const wasCr = afterCr;
        afterCr = false;

        if (0x0d === cp) {
            out.push(Controls.eol);
            afterCr = true;
            continue;
        }
        if (0x0a === cp) {
            if (!wasCr) {
                out.push(Controls.eol);
            }
            continue;
        }
        if (0x09 === cp) {
            out.push(0x20 ^ flip);
            continue;
        }
        if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) {
            continue;
        }

        const bytes = resolve(cp, quoted);
        if (undefined === bytes) {
            //  a combining mark on its own (decomposed input): the base letter has
            //  already been written, so the mark is dropped, not shown as '?'
            if (!isCombiningMark(cp)) {
                out.push(fb);
            }
            continue;
        }
        const written = [];
        let ok = true;
        for (const b of bytes) {
            if (!emitByte(b ^ flip, written)) {
                ok = false;
                break;
            }
        }
        if (ok) {
            out.push(...written);
        } else {
            out.push(fb);
        }
    }
    return Buffer.from(out);
}

module.exports = {
    Controls,
    KeyBytes,
    EscPrefixedKeys,
    Screens,
    QuotedGlyphs,
    INVERSE_BIT,
    PUA_BASE,
    isControlByte,
    canQuote,
    quoteByte,
    isInverse,
    byteToUnicode,
    unicodeToByte,
    complementByte,
    decode,
    decodeCells,
    encode,
};
