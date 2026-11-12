'use strict';

//  ATASCII charset tables (#593 step 7a): core/term/atascii/charset.js is pure
//  data, so these tests pin the tables, not behaviour in the BBS.
//
//  Expected values come from places other than the module: the control bytes from
//  the Atari 400/800 OS manual table as reproduced on Wikipedia "ATASCII" and from
//  icy_tools atascii.rs / SyncTERM cterm_atascii.c, the glyph shapes from the font
//  bitmaps (Atari_ATASCII.psf), the CP437 characters from iconv-lite's decoder.

const { strict: assert } = require('assert');
const iconv = require('iconv-lite');

const charset = require('../core/term/atascii/charset.js');

const {
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
} = charset;

const chr = n => String.fromCharCode(n);
const hex = n => '0x' + n.toString(16).toUpperCase().padStart(2, '0');
const bytes = (...b) => Buffer.from(b);

//  the sixteen control bytes, stated as ranges the way the OS manual does
const CONTROLS = new Set();
for (const [lo, hi] of [
    [0x1b, 0x1f],
    [0x7d, 0x7f],
    [0x9b, 0x9f],
    [0xfd, 0xff],
]) {
    for (let b = lo; b <= hi; ++b) CONTROLS.add(b);
}

//  walk a byte stream the way an Atari does: ESC quotes the next byte. Returns the
//  unquoted control bytes found (an unquoted 0x9B is a legitimate newline, so it
//  is reported separately) and whether the stream ends inside an ESC.
function scan(buf) {
    const acting = [];
    let eols = 0;
    let quoted = false;
    for (const b of buf) {
        if (quoted) {
            quoted = false;
        } else if (b === 0x1b) {
            quoted = true;
        } else if (b === 0x9b) {
            ++eols;
        } else if (CONTROLS.has(b)) {
            acting.push(b);
        }
    }
    return { acting, eols, dangling: quoted };
}

describe('ATASCII charset tables', function () {
    describe('exports', function () {
        it('has the documented shape', function () {
            assert.deepEqual(
                Object.keys(charset).sort(),
                [
                    'Controls',
                    'EscPrefixedKeys',
                    'INVERSE_BIT',
                    'KeyBytes',
                    'PUA_BASE',
                    'QuotedGlyphs',
                    'Screens',
                    'byteToUnicode',
                    'canQuote',
                    'complementByte',
                    'decode',
                    'decodeCells',
                    'encode',
                    'isControlByte',
                    'isInverse',
                    'quoteByte',
                    'unicodeToByte',
                ].sort()
            );
        });

        it('freezes every constant table', function () {
            for (const o of [
                Controls,
                KeyBytes,
                EscPrefixedKeys,
                Screens,
                Screens.antic,
                Screens.xep80,
                QuotedGlyphs,
            ]) {
                assert(Object.isFrozen(o));
            }
            assert.throws(() => {
                Controls.clear = 1;
            }, TypeError);
            assert.throws(() => {
                QuotedGlyphs[0x1c] = 'x';
            }, TypeError);
        });
    });

    describe('constants', function () {
        it('Controls are the sixteen bytes of the OS manual', function () {
            assert.deepEqual(Controls, {
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
            assert.deepEqual(new Set(Object.values(Controls)), CONTROLS);
            assert.equal(Object.values(Controls).length, 16);
        });

        it('INVERSE_BIT and PUA_BASE', function () {
            assert.equal(INVERSE_BIT, 0x80);
            assert.equal(PUA_BASE, 0xee00);
        });

        it('KeyBytes name what the Atari keyboard, SyncTERM and icy_term send', function () {
            assert.deepEqual(KeyBytes, {
                0x9b: 'return', // Atari, icy_term
                0x0d: 'return', // SyncTERM raw Enter
                0x7e: 'backspace', // Atari, SyncTERM Delete key
                0x08: 'backspace', // SyncTERM raw Backspace
                0x7f: 'tab', // Atari
                0x09: 'tab', // SyncTERM raw Tab
                0x1b: 'escape',
                0x1c: 'up arrow',
                0x1d: 'down arrow',
                0x1e: 'left arrow',
                0x1f: 'right arrow',
                0xff: 'insert', // SyncTERM CIO_KEY_IC
                0xfe: 'delete',
            });
        });

        it('arrow keys agree with Controls', function () {
            assert.equal(KeyBytes[Controls.cursorUp], 'up arrow');
            assert.equal(KeyBytes[Controls.cursorDown], 'down arrow');
            assert.equal(KeyBytes[Controls.cursorLeft], 'left arrow');
            assert.equal(KeyBytes[Controls.cursorRight], 'right arrow');
            assert.equal(KeyBytes[Controls.eol], 'return');
            assert.equal(KeyBytes[Controls.backspace], 'backspace');
            assert.equal(KeyBytes[Controls.tab], 'tab');
            assert.equal(KeyBytes[Controls.escape], 'escape');
        });

        it('EscPrefixedKeys are the ESC + byte keys icy_term sends', function () {
            assert.deepEqual(EscPrefixedKeys, {
                0x1c: 'up arrow',
                0x1d: 'down arrow',
                0x1e: 'left arrow',
                0x1f: 'right arrow',
                0x7e: 'backspace',
                0x9b: 'end',
            });
        });

        it('Screens are the sizes of both emulators', function () {
            assert.deepEqual(Screens, {
                antic: { columns: 40, rows: 24 },
                xep80: { columns: 80, rows: 25 },
            });
        });
    });

    describe('isControlByte / isInverse / canQuote', function () {
        it('isControlByte is exactly the sixteen bytes', function () {
            for (let b = 0; b < 256; ++b) {
                assert.equal(isControlByte(b), CONTROLS.has(b), hex(b));
            }
        });

        it('is false for anything that is not a byte', function () {
            for (const v of [-1, 256, 1.5, NaN, '1b', null, undefined, {}]) {
                assert.equal(isControlByte(v), false);
            }
        });

        it('isInverse is bit 7 on glyph bytes only', function () {
            let n = 0;
            for (let b = 0; b < 256; ++b) {
                const expected = b >= 0x80 && !CONTROLS.has(b);
                assert.equal(isInverse(b), expected, hex(b));
                if (expected) ++n;
            }
            assert.equal(n, 128 - 8);
        });

        it('canQuote is every control byte except the end of line', function () {
            for (let b = 0; b < 256; ++b) {
                assert.equal(canQuote(b), CONTROLS.has(b) && b !== 0x9b, hex(b));
            }
        });

        it('quoteByte puts ESC in front of controls only', function () {
            assert.deepEqual(quoteByte(0x41), bytes(0x41));
            assert.deepEqual(quoteByte(0x1c), bytes(0x1b, 0x1c));
            assert.deepEqual(quoteByte(0x1b), bytes(0x1b, 0x1b));
            assert.deepEqual(quoteByte(0xff), bytes(0x1b, 0xff));
            assert.throws(() => quoteByte(0x9b), RangeError);
            assert.throws(() => quoteByte(256), RangeError);
            assert.throws(() => quoteByte('a'), RangeError);
        });
    });

    describe('byteToUnicode', function () {
        it('is total: every byte gives one UTF-16 unit, never astral', function () {
            for (let b = 0; b < 256; ++b) {
                const s = byteToUnicode(b);
                assert.equal(typeof s, 'string');
                assert.equal(s.length, 1, hex(b));
                const cp = s.charCodeAt(0);
                assert(cp < 0xd800 || cp > 0xdfff, `${hex(b)} is a surrogate`);
            }
        });

        it('rejects bad input', function () {
            for (const v of [-1, 256, 1.5, NaN, '65', undefined, null]) {
                assert.throws(() => byteToUnicode(v), RangeError);
            }
        });

        it('the inverse half is the same code point as the low half', function () {
            for (let b = 0; b < 128; ++b) {
                assert.equal(byteToUnicode(b + 0x80), byteToUnicode(b), hex(b));
            }
        });

        it('the 128 normal video glyphs are all different', function () {
            const seen = new Map();
            for (let b = 0; b < 128; ++b) {
                const s = byteToUnicode(b);
                assert(!seen.has(s), `${hex(b)} repeats an earlier glyph`);
                seen.set(s, b);
            }
        });

        it('0x20-0x7F is ASCII except five bytes', function () {
            const different = [];
            for (let b = 0x20; b < 0x80; ++b) {
                if (byteToUnicode(b) !== chr(b)) different.push(b);
            }
            assert.deepEqual(different, [0x60, 0x7b, 0x7d, 0x7e, 0x7f]);
        });

        it('has letters of both cases, digits and punctuation at their ASCII bytes', function () {
            for (let b = 0x41; b <= 0x5a; ++b) assert.equal(byteToUnicode(b), chr(b));
            for (let b = 0x61; b <= 0x7a; ++b) assert.equal(byteToUnicode(b), chr(b));
            for (let b = 0x30; b <= 0x39; ++b) assert.equal(byteToUnicode(b), chr(b));
            assert.equal(byteToUnicode(0x20), ' ');
            //  punctuation that differs from nothing, including the three ASCII
            //  characters PETSCII changes
            for (const ch of '!"#$%&\'()*+,-./:;<=>?@[\\]^_|') {
                assert.equal(byteToUnicode(ch.charCodeAt(0)), ch);
            }
        });

        it('the five ASCII slots that differ draw suits, arrows and triangles', function () {
            assert.equal(byteToUnicode(0x60), '♦');
            assert.equal(byteToUnicode(0x7b), '♠');
            assert.equal(byteToUnicode(0x7d), '↖');
            assert.equal(byteToUnicode(0x7e), '◀');
            assert.equal(byteToUnicode(0x7f), '▶');
        });

        it('0x00-0x1F are the graphics', function () {
            const expected = [
                '♥',
                '├',
                chr(PUA_BASE + 0x02),
                '┘',
                '┤',
                '┐',
                '╱',
                '╲',
                '◢',
                '▗',
                '◣',
                '▝',
                '▘',
                chr(PUA_BASE + 0x0d),
                '▂',
                '▖',
                '♣',
                '┌',
                '─',
                '┼',
                '•',
                '▄',
                '▎',
                '┬',
                '┴',
                '▌',
                '└',
                '␛',
                '↑',
                '↓',
                '←',
                '→',
            ];
            for (let b = 0; b < 0x20; ++b) {
                assert.equal(byteToUnicode(b), expected[b], hex(b));
            }
        });

        it('control bytes give the glyph they draw when quoted', function () {
            assert.equal(byteToUnicode(0x1c), '↑');
            assert.equal(byteToUnicode(0x9c), '↑');
            assert.equal(byteToUnicode(0x9b), '␛');
            assert.equal(byteToUnicode(0xfd), '↖');
            assert.equal(byteToUnicode(0xfe), '◀');
            assert.equal(byteToUnicode(0xff), '▶');
        });
    });

    describe('private use area', function () {
        it('is exactly two glyphs, in PUA_BASE + byte', function () {
            const pua = [];
            for (let b = 0; b < 256; ++b) {
                const cp = byteToUnicode(b).charCodeAt(0);
                if (cp >= 0xe000 && cp <= 0xf8ff) pua.push([b, cp]);
            }
            assert.deepEqual(
                pua.filter(([b]) => b < 128),
                [
                    [0x02, 0xee02],
                    [0x0d, 0xee0d],
                ]
            );
            for (const [b, cp] of pua) assert.equal(cp, PUA_BASE + (b & 0x7f));
        });

        it('does not overlap the PETSCII range 0xEC00-0xEDFF', function () {
            assert(PUA_BASE > 0xedff);
            assert(PUA_BASE + 0xff <= 0xf8ff);
        });

        it('encodes back to its byte', function () {
            assert.deepEqual(encode(chr(PUA_BASE + 0x02)), bytes(0x02));
            assert.deepEqual(encode(chr(PUA_BASE + 0x0d)), bytes(0x0d));
            //  a PETSCII private use code point means nothing here
            assert.deepEqual(encode(chr(0xeca7)), bytes(0x3f));
            assert.deepEqual(encode(chr(PUA_BASE + 0x03)), bytes(0x3f));
        });
    });

    describe('round trip', function () {
        it('unicodeToByte(byteToUnicode(b)) is the normal video byte of the same glyph', function () {
            for (let b = 0; b < 256; ++b) {
                assert.equal(unicodeToByte(byteToUnicode(b)), b & 0x7f, hex(b));
                assert.equal(
                    unicodeToByte(byteToUnicode(b), { inverse: true }),
                    (b & 0x7f) | 0x80,
                    hex(b)
                );
            }
        });

        it('every glyph byte survives decode + encode', function () {
            for (let b = 0; b < 256; ++b) {
                if (CONTROLS.has(b)) continue;
                const text = decode(bytes(b));
                assert.equal(text, byteToUnicode(b));
                assert.deepEqual(encode(text), bytes(b & 0x7f), hex(b));
            }
        });

        it('every quotable control byte survives quote + decode + encode', function () {
            for (const b of CONTROLS) {
                if (!canQuote(b)) continue;
                const text = decode(quoteByte(b));
                assert.equal(text, byteToUnicode(b));
                assert.deepEqual(encode(text), bytes(0x1b, b & 0x7f), hex(b));
            }
        });
    });

    describe('inverse video glyphs that Unicode only has as a complement', function () {
        //  Independent geometry: each of these is a set of quadrants of the 8x8 cell
        //  (bit 0 UL, 1 UR, 2 LL, 3 LR); the complement of a glyph is the other quadrants.
        const quads = {
            ' ': 0,
            '█': 0xf,
            '▀': 0b0011,
            '▄': 0b1100,
            '▌': 0b0101,
            '▐': 0b1010,
            '▘': 0b0001,
            '▝': 0b0010,
            '▖': 0b0100,
            '▗': 0b1000,
            '▛': 0b0111,
            '▜': 0b1011,
            '▙': 0b1101,
            '▟': 0b1110,
        };
        //  triangles: the complement of a lower triangle is the opposite upper one
        const triangles = { '◢': '◤', '◣': '◥' };

        it('are the bitmap complement of the glyph in the low half', function () {
            let n = 0;
            for (const [ch, mask] of Object.entries(quads)) {
                const byte = complementByte(ch);
                if (undefined === byte) {
                    continue; // has a low half byte of its own
                }
                ++n;
                assert(byte >= 0x80 && !CONTROLS.has(byte), ch);
                const base = quads[byteToUnicode(byte & 0x7f)];
                assert.notEqual(base, undefined, `${hex(byte)} is not a quadrant glyph`);
                assert.equal(mask, ~base & 0xf, `${ch} via ${hex(byte)}`);
            }
            assert.equal(n, 7); // █ ▀ ▐ ▛ ▜ ▙ ▟
            for (const [low, high] of Object.entries(triangles)) {
                const byte = complementByte(high);
                assert.equal(byteToUnicode(byte & 0x7f), low);
                assert(byte >= 0x80);
            }
        });

        it('are exactly the documented bytes', function () {
            assert.equal(complementByte('█'), 0xa0);
            assert.equal(complementByte(0x2580), 0x95);
            assert.equal(complementByte('▐'), 0x99);
            assert.equal(complementByte('◤'), 0x88);
            assert.equal(complementByte('◥'), 0x8a);
            assert.equal(complementByte('▜'), 0x8f);
            assert.equal(complementByte('▛'), 0x89);
            assert.equal(complementByte('▟'), 0x8c);
            assert.equal(complementByte('▙'), 0x8b);
        });

        it('are not in the normal video table and not for other characters', function () {
            for (const ch of '█▀▐◤◥▛▜▙▟') {
                assert.equal(unicodeToByte(ch), undefined, ch);
            }
            for (const ch of ['A', '▄', '▌', '▘', '▚', '▞', '', 'ab']) {
                assert.equal(complementByte(ch === 'ab' ? 'a' : ch), undefined, ch);
            }
            assert.equal(complementByte(0x1f7e0), undefined);
            assert.equal(complementByte(-1), undefined);
            assert.equal(complementByte(undefined), undefined);
        });

        it('encode writes them as inverse video bytes', function () {
            assert.deepEqual(encode('█'), bytes(0xa0));
            assert.deepEqual(encode('▀'), bytes(0x95));
            assert.deepEqual(encode('▐'), bytes(0x99));
            assert.deepEqual(encode('◤◥'), bytes(0x88, 0x8a));
            assert.deepEqual(encode('▛▜▙▟'), bytes(0x89, 0x8f, 0x8b, 0x8c));
            //  the ones with a low half byte stay in the low half
            assert.deepEqual(
                encode('▄▌▘▝▖▗◢◣'),
                bytes(0x15, 0x19, 0x0c, 0x0b, 0x0f, 0x09, 0x08, 0x0a)
            );
        });
    });

    describe('unicodeToByte', function () {
        it('accepts a code point number or a character', function () {
            assert.equal(unicodeToByte('A'), 0x41);
            assert.equal(unicodeToByte(0x41), 0x41);
            assert.equal(unicodeToByte('♥'), 0x00);
            assert.equal(unicodeToByte(0x2665), 0x00);
        });

        it('the inverse option adds bit 7', function () {
            assert.equal(unicodeToByte('A', { inverse: true }), 0xc1);
            assert.equal(unicodeToByte(' ', { inverse: true }), 0xa0);
            assert.equal(unicodeToByte('A', { inverse: false }), 0x41);
            assert.equal(unicodeToByte('A', {}), 0x41);
            assert.equal(unicodeToByte('A', null), 0x41);
        });

        it('ignores option names that come from Object.prototype', function () {
            const evil = Object.create({ inverse: true });
            assert.equal(unicodeToByte('A', evil), 0x41);
            assert.equal(
                unicodeToByte('A', JSON.parse('{"__proto__":{"inverse":true}}')),
                0x41
            );
        });

        it('returns control bytes for the glyphs that need ESC', function () {
            assert.equal(unicodeToByte('↑'), 0x1c);
            assert.equal(unicodeToByte('␛'), 0x1b);
            assert.equal(unicodeToByte('▶'), 0x7f);
            assert.equal(unicodeToByte('␛', { inverse: true }), 0x9b);
        });

        it('returns undefined with no mapping at all', function () {
            for (const v of [
                'é',
                '`',
                '{',
                '}',
                '~',
                '中',
                0x1f600,
                '😀',
                '',
                -1,
                1.5,
                undefined,
            ]) {
                assert.equal(unicodeToByte(v), undefined, String(v));
            }
            assert.equal(unicodeToByte(chr(0xd800)), undefined);
        });
    });

    describe('letters, case and ASCII punctuation', function () {
        it('both cases encode to themselves', function () {
            assert.deepEqual(encode('AZaz09'), Buffer.from('AZaz09'));
            assert.deepEqual(
                encode('Hello, World! @[]^_|\\'),
                Buffer.from('Hello, World! @[]^_|\\')
            );
        });

        it('the four ASCII characters ATASCII lacks fall back to plain ASCII', function () {
            assert.deepEqual(encode('`'), Buffer.from("'"));
            assert.deepEqual(encode('{'), Buffer.from('('));
            assert.deepEqual(encode('}'), Buffer.from(')'));
            assert.deepEqual(encode('~'), Buffer.from('-'));
        });

        it('never emits 0x60 0x7B 0x7D 0x7E 0x7F for ASCII text, which would draw glyphs', function () {
            for (let c = 0x20; c < 0x7f; ++c) {
                const out = encode(chr(c));
                assert.equal(out.length, 1);
                assert(![0x60, 0x7b, 0x7d, 0x7e, 0x7f].includes(out[0]), chr(c));
            }
        });
    });

    describe('CP437 fallbacks', function () {
        //  CP437 byte -> ATASCII bytes, derived from the glyph shapes: the font has
        //  the single line set (and no double lines), so double and mixed lines fold
        //  to single ones, as the PETSCII library does.
        const expected = {
            0xb3: [0x7c], // │
            0xba: [0x7c], // ║
            0xc4: [0x12], // ─
            0xcd: [0x12], // ═
            0xda: [0x11], // ┌
            0xc9: [0x11],
            0xd5: [0x11],
            0xd6: [0x11],
            0xbf: [0x05], // ┐
            0xbb: [0x05],
            0xb8: [0x05],
            0xb7: [0x05],
            0xc0: [0x1a], // └
            0xc8: [0x1a],
            0xd4: [0x1a],
            0xd3: [0x1a],
            0xd9: [0x03], // ┘
            0xbc: [0x03],
            0xbe: [0x03],
            0xbd: [0x03],
            0xc3: [0x01], // ├
            0xc6: [0x01],
            0xc7: [0x01],
            0xcc: [0x01],
            0xb4: [0x04], // ┤
            0xb5: [0x04],
            0xb6: [0x04],
            0xb9: [0x04],
            0xc2: [0x17], // ┬
            0xd1: [0x17],
            0xd2: [0x17],
            0xcb: [0x17],
            0xc1: [0x18], // ┴
            0xcf: [0x18],
            0xd0: [0x18],
            0xca: [0x18],
            0xc5: [0x13], // ┼
            0xd7: [0x13],
            0xd8: [0x13],
            0xce: [0x13],
            0xdb: [0xa0], // █ inverse space
            0xdc: [0x15], // ▄
            0xdd: [0x19], // ▌
            0xde: [0x99], // ▐ inverse ▌
            0xdf: [0x95], // ▀ inverse ▄
            0xfe: [0xa0], // ■ -> full block
            0xb0: [0x2e], // ░ -> .
            0xb1: [0x2a], // ▒ -> *
            0xb2: [0x23], // ▓ -> #
        };

        it('box, block and shade characters, byte for byte', function () {
            for (const [cp437, atascii] of Object.entries(expected)) {
                const ch = iconv.decode(Buffer.from([Number(cp437)]), 'cp437');
                assert.deepEqual(
                    encode(ch),
                    Buffer.from(atascii),
                    `${ch} (CP437 ${hex(Number(cp437))})`
                );
            }
        });

        it('every CP437 box and block character (0xB0-0xDF) is mapped', function () {
            for (let b = 0xb0; b <= 0xdf; ++b) {
                const ch = iconv.decode(Buffer.from([b]), 'cp437');
                assert.notDeepEqual(encode(ch), bytes(0x3f), `${ch} (${hex(b)})`);
            }
        });

        it('none of those need ESC, except none', function () {
            for (const atascii of Object.values(expected)) {
                for (const b of atascii) assert(!CONTROLS.has(b), hex(b));
            }
        });

        it('printable CP437 (letters, accents, symbols) never produces an acting byte', function () {
            for (let b = 0x20; b < 0x100; ++b) {
                const ch = iconv.decode(Buffer.from([b]), 'cp437');
                const out = encode(ch);
                assert.deepEqual(scan(out).acting, [], `${ch} ${hex(b)}`);
                assert.equal(scan(out).eols, 0);
                assert(!scan(out).dangling);
            }
        });

        it('CP437 accented Latin folds to its base letter', function () {
            const folded = {
                Ç: 'C',
                ü: 'u',
                é: 'e',
                â: 'a',
                ä: 'a',
                à: 'a',
                å: 'a',
                ç: 'c',
                ê: 'e',
                ë: 'e',
                è: 'e',
                ï: 'i',
                î: 'i',
                ì: 'i',
                Ä: 'A',
                Å: 'A',
                É: 'E',
                ô: 'o',
                ö: 'o',
                ò: 'o',
                û: 'u',
                ù: 'u',
                ÿ: 'y',
                Ö: 'O',
                Ü: 'U',
                á: 'a',
                í: 'i',
                ó: 'o',
                ú: 'u',
                ñ: 'n',
                Ñ: 'N',
            };
            for (const [accented, plain] of Object.entries(folded)) {
                assert.deepEqual(encode(accented), Buffer.from(plain), accented);
            }
            assert.deepEqual(encode('ß'), Buffer.from('ss'));
            assert.deepEqual(encode('Æ'), Buffer.from('AE'));
            //  decomposed input gives the same
            assert.deepEqual(encode('e' + chr(0x301)), Buffer.from('e'));
        });

        it('CP437 suits and quarter blocks that ATASCII draws exactly', function () {
            assert.deepEqual(encode('♥♦♣♠'), bytes(0x00, 0x60, 0x10, 0x7b));
            assert.deepEqual(encode('•'), bytes(0x14));
            assert.deepEqual(encode('∙·'), bytes(0x14, 0x14));
        });

        it('diagonal quadrants become the diagonal strokes', function () {
            assert.deepEqual(encode('▞▚'), bytes(0x06, 0x07));
        });
    });

    describe('ESC-quoted glyphs', function () {
        it('arrows and pointers are written ESC + byte', function () {
            assert.deepEqual(
                encode('↑↓←→'),
                bytes(0x1b, 0x1c, 0x1b, 0x1d, 0x1b, 0x1e, 0x1b, 0x1f)
            );
            assert.deepEqual(encode('◀▶'), bytes(0x1b, 0x7e, 0x1b, 0x7f));
            assert.deepEqual(encode('↖'), bytes(0x1b, 0x7d));
            assert.deepEqual(encode('␛'), bytes(0x1b, 0x1b));
        });

        it('the CP437 triangle pointers use the ATASCII ones', function () {
            assert.deepEqual(encode('►◄'), bytes(0x1b, 0x7f, 0x1b, 0x7e));
        });

        it('the CP437 up and down triangles are ASCII', function () {
            assert.deepEqual(encode('▲▼'), Buffer.from('^v'));
        });

        it('quoted:false never writes ESC, and falls back to ASCII', function () {
            assert.deepEqual(encode('↑↓←→', { quoted: false }), Buffer.from('^v<>'));
            assert.deepEqual(encode('►◄◀▶↖', { quoted: false }), Buffer.from('><<>^'));
            assert.deepEqual(encode('␛', { quoted: false }), Buffer.alloc(0));
            assert.deepEqual(encode('A█', { quoted: false }), bytes(0x41, 0xa0));
        });

        it('quoted:false output has no ESC at all', function () {
            for (let cp = 0; cp < 0x10000; ++cp) {
                if (cp === 0x0a || cp === 0x0d) continue;
                const out = encode(chr(cp), { quoted: false });
                for (const b of out) assert(!CONTROLS.has(b), `U+${cp.toString(16)}`);
            }
        });

        it('QuotedGlyphs has one glyph for each quotable control byte', function () {
            assert.deepEqual(
                Object.keys(QuotedGlyphs).map(Number),
                [...CONTROLS].filter(b => b !== 0x9b).sort((a, b) => a - b)
            );
            for (const [b, glyph] of Object.entries(QuotedGlyphs)) {
                assert.equal(glyph, byteToUnicode(Number(b)));
            }
            assert.equal(QuotedGlyphs[0x1b], '␛');
            assert.equal(QuotedGlyphs[0x9f], '→');
            assert.equal(QuotedGlyphs[0x9b], undefined);
        });
    });

    describe('the inverse option', function () {
        it('flips bit 7 on every glyph byte', function () {
            assert.deepEqual(encode('Ab ', { inverse: true }), bytes(0xc1, 0xe2, 0xa0));
            assert.deepEqual(encode('♥─', { inverse: true }), bytes(0x80, 0x92));
        });

        it('a complement glyph comes out in the normal half', function () {
            assert.deepEqual(encode('█', { inverse: true }), bytes(0x20));
            assert.deepEqual(encode('▀', { inverse: true }), bytes(0x15));
        });

        it('quoted glyphs are quoted in their inverse form', function () {
            assert.deepEqual(encode('↑', { inverse: true }), bytes(0x1b, 0x9c));
            assert.deepEqual(encode('▶', { inverse: true }), bytes(0x1b, 0xff));
        });

        it('a glyph that would flip into the end of line is a fallback, never a newline', function () {
            assert.deepEqual(encode('␛', { inverse: true }), bytes(0x3f));
        });

        it('does not touch the fallback byte or the line end', function () {
            assert.deepEqual(encode('中\n', { inverse: true }), bytes(0x3f, 0x9b));
        });

        it('ignores a prototype-supplied inverse', function () {
            assert.deepEqual(encode('A', Object.create({ inverse: true })), bytes(0x41));
        });
    });

    describe('newlines, tabs and controls in the input', function () {
        it('LF, CR and CR LF are each one end of line', function () {
            assert.deepEqual(encode('a\nb'), bytes(0x61, 0x9b, 0x62));
            assert.deepEqual(encode('a\rb'), bytes(0x61, 0x9b, 0x62));
            assert.deepEqual(encode('a\r\nb'), bytes(0x61, 0x9b, 0x62));
            assert.deepEqual(encode('a\n\nb'), bytes(0x61, 0x9b, 0x9b, 0x62));
            assert.deepEqual(encode('a\r\n\r\nb'), bytes(0x61, 0x9b, 0x9b, 0x62));
            assert.deepEqual(encode('\n\r'), bytes(0x9b, 0x9b));
        });

        it('a tab is a space', function () {
            assert.deepEqual(encode('a\tb'), bytes(0x61, 0x20, 0x62));
        });

        it('other C0, C1 and DEL characters are dropped, not passed through', function () {
            const noise = [];
            for (let c = 0; c < 0x20; ++c)
                if (![9, 10, 13].includes(c)) noise.push(chr(c));
            for (let c = 0x7f; c <= 0x9f; ++c) noise.push(chr(c));
            assert.deepEqual(encode('a' + noise.join('') + 'b'), Buffer.from('ab'));
        });

        it('an ANSI escape sequence in the text cannot reach the terminal as ESC', function () {
            const out = encode('\x1b[31mred\x1b[0m');
            assert.deepEqual(scan(out).acting, []);
            assert(!out.includes(0x1b));
        });
    });

    describe('encode: odd input', function () {
        it('empty and missing input give an empty buffer', function () {
            assert.deepEqual(encode(''), Buffer.alloc(0));
            assert.deepEqual(encode(undefined), Buffer.alloc(0));
            assert.deepEqual(encode(null), Buffer.alloc(0));
        });

        it('an astral character is one fallback byte, not two', function () {
            assert.deepEqual(encode('😀'), bytes(0x3f));
            assert.deepEqual(encode('a😀b'), bytes(0x61, 0x3f, 0x62));
            assert.deepEqual(encode(String.fromCodePoint(0x1fb87)), bytes(0x3f));
        });

        it('a lone surrogate is a fallback byte', function () {
            assert.deepEqual(encode(chr(0xd800)), bytes(0x3f));
            assert.deepEqual(encode(chr(0xdc00)), bytes(0x3f));
            assert.deepEqual(encode(chr(0xd800) + 'a'), bytes(0x3f, 0x61));
        });

        it('fallbackByte is honoured, including 0, and must not be a control byte', function () {
            assert.deepEqual(encode('中', { fallbackByte: 0x2e }), bytes(0x2e));
            assert.deepEqual(encode('中', { fallbackByte: 0 }), bytes(0x00));
            assert.deepEqual(encode('中', { fallbackByte: 0xc1 }), bytes(0xc1));
            for (const bad of [0x1b, 0x1c, 0x7d, 0x9b, 0xff]) {
                assert.throws(() => encode('a', { fallbackByte: bad }), RangeError);
            }
            for (const bad of [-1, 256, 1.5, '?', NaN, null]) {
                assert.throws(() => encode('a', { fallbackByte: bad }), RangeError);
            }
        });

        it('ignores option names that come from Object.prototype', function () {
            const evil = Object.create({
                fallbackByte: 0x1c,
                quoted: false,
                inverse: true,
            });
            assert.deepEqual(encode('中↑', evil), bytes(0x3f, 0x1b, 0x1c));
            const parsed = JSON.parse('{"__proto__":{"fallbackByte":28}}');
            assert.deepEqual(encode('中', parsed), bytes(0x3f));
            for (const options of [null, undefined, 5, 'x', [], () => {}]) {
                assert.deepEqual(encode('A↑', options), bytes(0x41, 0x1b, 0x1c));
            }
        });

        it('coerces non-strings like String()', function () {
            assert.deepEqual(encode(42), Buffer.from('42'));
        });

        it('output is always bytes', function () {
            const out = encode('A█中↑');
            assert(Buffer.isBuffer(out));
            for (const b of out) assert(b >= 0 && b <= 255);
        });

        it('a long string is fine', function () {
            const out = encode('é↑'.repeat(50000));
            assert.equal(out.length, 150000);
        });
    });

    describe('no control injection', function () {
        const optionSets = [
            undefined,
            { inverse: true },
            { quoted: false },
            { inverse: true, quoted: false },
            { fallbackByte: 0xc1 },
        ];

        it('no BMP code point writes an acting control byte unquoted', function () {
            for (const options of optionSets) {
                for (let cp = 0; cp < 0x10000; ++cp) {
                    const out = encode(chr(cp), options);
                    const { acting, eols, dangling } = scan(out);
                    const label = `U+${cp.toString(16).toUpperCase()} ${JSON.stringify(options)}`;
                    assert.deepEqual(acting, [], label);
                    assert(!dangling, label);
                    //  the only way to an end of line is a newline in the input
                    assert.equal(eols, cp === 0x0a || cp === 0x0d ? 1 : 0, label);
                }
            }
        });

        it('what is quoted is only ever a quotable control byte', function () {
            for (const options of optionSets) {
                for (let cp = 0; cp < 0x10000; ++cp) {
                    const out = encode(chr(cp), options);
                    for (let i = 0; i < out.length; ++i) {
                        if (out[i] === 0x1b) {
                            assert(canQuote(out[i + 1]), `U+${cp.toString(16)}`);
                            ++i;
                        }
                    }
                }
            }
        });

        it('holds for mixed strings too (seeded)', function () {
            let seed = 0x5eed;
            const next = () => {
                seed = (seed * 1103515245 + 12345) & 0x7fffffff;
                return seed;
            };
            for (let n = 0; n < 200; ++n) {
                let s = '';
                for (let i = 0; i < 80; ++i) s += chr(next() % 0x10000);
                for (const options of optionSets) {
                    const { acting, dangling } = scan(encode(s, options));
                    assert.deepEqual(acting, []);
                    assert(!dangling);
                }
            }
        });

        it('every glyph byte and quoted control byte round trips without leaking', function () {
            for (let b = 0; b < 256; ++b) {
                const stream = CONTROLS.has(b) ? quoteByteOrNothing(b) : bytes(b);
                const text = decode(stream);
                const { acting } = scan(encode(text));
                assert.deepEqual(acting, [], hex(b));
            }
        });
    });

    describe('decode', function () {
        it('decodes glyph bytes, both halves, to the same characters', function () {
            assert.equal(decode(Buffer.from('Hello')), 'Hello');
            assert.equal(decode(bytes(0x41, 0xc1)), 'AA');
            assert.equal(decode(bytes(0x00, 0x80)), '♥♥');
            assert.equal(decode(bytes(0xa0)), ' ');
        });

        it('an unquoted control byte acts and draws nothing', function () {
            for (const b of CONTROLS) {
                if (b === 0x1b) continue;
                assert.equal(
                    decode(bytes(0x41, b, 0x42)),
                    b === 0x9b ? 'A\nB' : 'AB',
                    hex(b)
                );
            }
        });

        it('ESC quotes the next byte, which draws its glyph', function () {
            assert.equal(decode(bytes(0x1b, 0x1c)), '↑');
            assert.equal(decode(bytes(0x1b, 0x7d)), '↖');
            assert.equal(decode(bytes(0x1b, 0x7f)), '▶');
            assert.equal(decode(bytes(0x1b, 0xfd)), '↖');
            assert.equal(decode(bytes(0x1b, 0x9c)), '↑');
            assert.equal(decode(bytes(0x1b, 0x41)), 'A');
        });

        it('ESC ESC draws the escape glyph, and only the first ESC is consumed', function () {
            assert.equal(decode(bytes(0x1b, 0x1b)), '␛');
            assert.equal(decode(bytes(0x1b, 0x1b, 0x1c)), '␛');
            assert.equal(decode(bytes(0x1b, 0x1b, 0x1b, 0x1c)), '␛↑');
        });

        it('the end of line is a newline even when quoted', function () {
            assert.equal(decode(bytes(0x41, 0x9b, 0x42)), 'A\nB');
            assert.equal(decode(bytes(0x41, 0x1b, 0x9b, 0x42)), 'A\nB');
        });

        it('a trailing ESC is dropped', function () {
            assert.equal(decode(bytes(0x41, 0x1b)), 'A');
            assert.equal(decode(bytes(0x1b)), '');
        });

        it('decodeCells keeps inverse video', function () {
            assert.deepEqual(
                decodeCells(bytes(0x41, 0xc1, 0x1b, 0x9c, 0x1b, 0x1c, 0x9b)),
                [
                    { char: 'A', inverse: false },
                    { char: 'A', inverse: true },
                    { char: '↑', inverse: true },
                    { char: '↑', inverse: false },
                    { char: '\n', inverse: false },
                ]
            );
        });

        it('handles Uint8Array, an empty buffer and bad input', function () {
            assert.equal(decode(new Uint8Array([0x41, 0x42])), 'AB');
            assert.equal(decode(Buffer.alloc(0)), '');
            assert.equal(decode([0x41]), 'A');
            for (const v of [undefined, null, 5, {}]) {
                assert.throws(() => decode(v), TypeError);
                assert.throws(() => decodeCells(v), TypeError);
            }
        });

        it('every byte value decodes without throwing, in any pairing', function () {
            for (let a = 0; a < 256; ++a) {
                for (const b of [0x1b, 0x41, 0x9b, 0xff]) {
                    assert.equal(typeof decode(bytes(a, b)), 'string');
                }
            }
        });
    });

    describe('encode inverts decode on glyph text', function () {
        it('a stream of normal video glyphs round trips', function () {
            const stream = [];
            for (let b = 0; b < 0x80; ++b) {
                if (CONTROLS.has(b)) continue;
                stream.push(b);
            }
            const buf = Buffer.from(stream);
            assert.deepEqual(encode(decode(buf)), buf);
        });

        it('quoted controls round trip', function () {
            const buf = bytes(0x41, 0x1b, 0x1c, 0x1b, 0x7e, 0x1b, 0x1b, 0x42);
            assert.deepEqual(encode(decode(buf)), buf);
        });
    });
});

function quoteByteOrNothing(b) {
    return charset.canQuote(b) ? charset.quoteByte(b) : bytes(b);
}
