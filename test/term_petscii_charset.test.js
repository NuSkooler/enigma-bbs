'use strict';

//  PETSCII charset tables (#593 step 5a): core/term/petscii/charset.js is pure
//  data, so these tests pin the tables, not behaviour in the BBS.
//
//  Expected values come from places other than the module: the byte constants
//  from the design doc / Synchronet petdefs.h, the byte -> screen code fold from
//  the C64 Programmer's Reference Guide (re-implemented below), the CP437 fallback
//  targets from Synchronet's cp437_to_petscii.

const { strict: assert } = require('assert');
const iconv = require('iconv-lite');

const charset = require('../core/term/petscii/charset.js');

const {
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
} = charset;

const UPPER = Charsets.UpperGraphics;
const LOWER = Charsets.LowerUpper;
const BOTH = [UPPER, LOWER];

const chr = n => String.fromCharCode(n);
const hex = n => '0x' + n.toString(16).toUpperCase().padStart(2, '0');
const isPua = s => s.charCodeAt(0) >= 0xe000 && s.charCodeAt(0) <= 0xf8ff;

//  C64 byte -> screen code (glyph identity), independent of the module
function screenCode(b) {
    if (b >= 0x20 && b <= 0x3f) return b;
    if (b >= 0x40 && b <= 0x5f) return b - 0x40;
    if (b >= 0x60 && b <= 0x7f) return b - 0x20;
    if (b >= 0xa0 && b <= 0xbf) return b - 0x40;
    if (b >= 0xc0 && b <= 0xfe) return b - 0x80;
    return 0x5e; // 0xFF
}

const printableBytes = [];
for (let b = 0; b < 256; ++b) {
    if (!isControlByte(b)) printableBytes.push(b);
}

describe('PETSCII charset tables', function () {
    describe('exports', function () {
        it('has the documented shape', function () {
            assert.deepEqual(
                Object.keys(charset).sort(),
                [
                    'AnsiToPetsciiColor',
                    'Charsets',
                    'Colors',
                    'Controls',
                    'DEFAULT_CHARSET',
                    'KeyBytes',
                    'PUA_BASE',
                    'byteToUnicode',
                    'decode',
                    'encode',
                    'isControlByte',
                    'reverseOnlyByte',
                    'unicodeToByte',
                ].sort()
            );
            assert.deepEqual(Charsets, { UpperGraphics: 'upper', LowerUpper: 'lower' });
            assert.equal(DEFAULT_CHARSET, Charsets.LowerUpper);
        });

        it('freezes every constant table', function () {
            for (const o of [Charsets, Controls, Colors, AnsiToPetsciiColor, KeyBytes]) {
                assert(Object.isFrozen(o));
            }
            assert.throws(() => {
                Controls.home = 1;
            }, TypeError);
            assert.throws(() => {
                AnsiToPetsciiColor[0] = 1;
            }, TypeError);
        });
    });

    describe('constants', function () {
        it('Controls match the design doc', function () {
            assert.deepEqual(Controls, {
                cursorUp: 0x91,
                cursorDown: 0x11,
                cursorLeft: 0x9d,
                cursorRight: 0x1d,
                home: 0x13,
                clear: 0x93,
                reverseOn: 0x12,
                reverseOff: 0x92,
                charsetLower: 0x0e,
                charsetUpper: 0x8e,
                delete: 0x14,
                insert: 0x94,
                return: 0x0d,
                shiftReturn: 0x8d,
            });
        });

        it('Colors match the design doc (all 16, all distinct)', function () {
            assert.deepEqual(Colors, {
                white: 0x05,
                red: 0x1c,
                green: 0x1e,
                blue: 0x1f,
                orange: 0x81,
                black: 0x90,
                brown: 0x95,
                lightRed: 0x96,
                darkGrey: 0x97,
                grey: 0x98,
                lightGreen: 0x99,
                lightBlue: 0x9a,
                lightGrey: 0x9b,
                purple: 0x9c,
                yellow: 0x9e,
                cyan: 0x9f,
            });
            assert.equal(new Set(Object.values(Colors)).size, 16);
            Object.values(Colors).forEach(b => assert(isControlByte(b)));
        });

        it('AnsiToPetsciiColor follows Synchronet attrstr (C64)', function () {
            //  ANSI order: black red green yellow blue magenta cyan white, then bright
            assert.deepEqual(
                [...AnsiToPetsciiColor],
                [
                    0x90, 0x1c, 0x1e, 0x95, 0x1f, 0x81, 0x98, 0x9b, 0x97, 0x96, 0x99,
                    0x9e, 0x9a, 0x9c, 0x9f, 0x05,
                ]
            );
            const colors = new Set(Object.values(Colors));
            AnsiToPetsciiColor.forEach(b => assert(colors.has(b)));
            assert.equal(new Set(AnsiToPetsciiColor).size, 16);
        });

        it('KeyBytes name the C64 keyboard codes', function () {
            assert.deepEqual(KeyBytes, {
                0x0d: 'return',
                0x8d: 'return',
                0x11: 'down arrow',
                0x1d: 'right arrow',
                0x91: 'up arrow',
                0x9d: 'left arrow',
                0x13: 'home',
                0x93: 'clear',
                0x14: 'backspace',
                0x94: 'insert',
                0x85: 'f1',
                0x89: 'f2',
                0x86: 'f3',
                0x8a: 'f4',
                0x87: 'f5',
                0x8b: 'f6',
                0x88: 'f7',
                0x8c: 'f8',
            });
            //  F1..F8 in order are 85 89 86 8A 87 8B 88 8C
            const f = [1, 2, 3, 4, 5, 6, 7, 8].map(n =>
                Number(Object.keys(KeyBytes).find(k => KeyBytes[k] === `f${n}`))
            );
            assert.deepEqual(f, [0x85, 0x89, 0x86, 0x8a, 0x87, 0x8b, 0x88, 0x8c]);
        });

        it('keys agree with Controls', function () {
            assert.equal(KeyBytes[Controls.cursorUp], 'up arrow');
            assert.equal(KeyBytes[Controls.cursorDown], 'down arrow');
            assert.equal(KeyBytes[Controls.cursorLeft], 'left arrow');
            assert.equal(KeyBytes[Controls.cursorRight], 'right arrow');
            assert.equal(KeyBytes[Controls.home], 'home');
            assert.equal(KeyBytes[Controls.clear], 'clear');
            assert.equal(KeyBytes[Controls.delete], 'backspace');
            assert.equal(KeyBytes[Controls.insert], 'insert');
            assert.equal(KeyBytes[Controls.return], 'return');
        });
    });

    describe('isControlByte', function () {
        it('is exactly 0x00-0x1F and 0x80-0x9F', function () {
            for (let b = 0; b < 256; ++b) {
                assert.equal(
                    isControlByte(b),
                    b < 0x20 || (b >= 0x80 && b < 0xa0),
                    hex(b)
                );
            }
        });
    });

    describe('byteToUnicode', function () {
        for (const cs of BOTH) {
            describe(cs, function () {
                it('is total: every byte gives one UTF-16 unit', function () {
                    for (let b = 0; b < 256; ++b) {
                        const s = byteToUnicode(b, cs);
                        assert.equal(typeof s, 'string', hex(b));
                        assert.equal(s.length, 1, hex(b));
                        assert.equal([...s].length, 1, hex(b));
                    }
                });

                it('never uses astral code points or surrogates', function () {
                    for (let b = 0; b < 256; ++b) {
                        const cp = byteToUnicode(b, cs).codePointAt(0);
                        assert(cp <= 0xffff, hex(b));
                        assert(cp < 0xd800 || cp > 0xdfff, hex(b));
                    }
                });

                it('maps control bytes to the same C0/C1 code point', function () {
                    for (let b = 0; b < 256; ++b) {
                        if (isControlByte(b)) {
                            assert.equal(byteToUnicode(b, cs), chr(b), hex(b));
                        } else {
                            assert(
                                !isControlByte(byteToUnicode(b, cs).charCodeAt(0)),
                                hex(b)
                            );
                        }
                    }
                });

                it('draws mirrored byte ranges identically', function () {
                    for (let b = 0x60; b <= 0x7f; ++b) {
                        assert.equal(
                            byteToUnicode(b, cs),
                            byteToUnicode(b + 0x60, cs),
                            `${hex(b)} mirrors ${hex(b + 0x60)}`
                        );
                    }
                    for (let b = 0xa0; b <= 0xbe; ++b) {
                        assert.equal(
                            byteToUnicode(b, cs),
                            byteToUnicode(b + 0x40, cs),
                            `${hex(b)} mirrors ${hex(b + 0x40)}`
                        );
                    }
                    assert.equal(byteToUnicode(0xff, cs), byteToUnicode(0xde, cs));
                });

                it('gives equal glyphs for equal screen codes', function () {
                    for (const a of printableBytes) {
                        for (const b of printableBytes) {
                            if (screenCode(a) === screenCode(b)) {
                                assert.equal(
                                    byteToUnicode(a, cs),
                                    byteToUnicode(b, cs),
                                    `${hex(a)} / ${hex(b)}`
                                );
                            }
                        }
                    }
                });

                it('only repeats a code point for the known duplicate glyphs', function () {
                    //  The ROM draws these shapes twice inside the canonical range
                    //  (besides the mirrors above and 0xA0 = a blank like 0x20).
                    const known = {
                        '0x20': ['0x20', '0xA0'],
                        '0xA5': ['0xA5', '0xB4'],
                        '0xA7': ['0xA7', '0xAA'],
                    };
                    if (UPPER === cs) {
                        known['0xC0'] = ['0xC0', '0xC3'];
                        known['0xC2'] = ['0xC2', '0xDD'];
                    }
                    const seen = new Map();
                    for (let b = 0x20; b <= 0xdf; ++b) {
                        if (isControlByte(b) || (b >= 0x60 && b <= 0x7f)) continue;
                        const s = byteToUnicode(b, cs);
                        seen.set(s, [...(seen.get(s) || []), hex(b)]);
                    }
                    const dups = {};
                    for (const bytes of seen.values()) {
                        if (bytes.length > 1) dups[bytes[0]] = bytes;
                    }
                    assert.deepEqual(dups, known);
                });
            });
        }

        it('rejects bad input', function () {
            assert.throws(() => byteToUnicode(256, LOWER), RangeError);
            assert.throws(() => byteToUnicode(-1, LOWER), RangeError);
            assert.throws(() => byteToUnicode(0x41, 'petscii'), TypeError);
        });

        it('defaults to lower/upper', function () {
            assert.equal(byteToUnicode(0x41), 'a');
            assert.equal(byteToUnicode(0x41, UPPER), 'A');
        });
    });

    describe('round trip', function () {
        for (const cs of BOTH) {
            it(`${cs}: unicodeToByte(byteToUnicode(b)) draws the same glyph (and is a canonical byte)`, function () {
                for (const b of printableBytes) {
                    const s = byteToUnicode(b, cs);
                    const b2 = unicodeToByte(s, cs);
                    assert.notEqual(b2, undefined, `${hex(b)} has no way back`);
                    assert.equal(byteToUnicode(b2, cs), s, hex(b));
                }
            });

            it(`${cs}: control bytes round trip as themselves`, function () {
                for (let b = 0; b < 256; ++b) {
                    if (isControlByte(b)) {
                        assert.equal(unicodeToByte(byteToUnicode(b, cs), cs), b, hex(b));
                    }
                }
            });

            it(`${cs}: canonical bytes are fixed points`, function () {
                const canonical = new Set();
                for (const b of printableBytes) {
                    canonical.add(unicodeToByte(byteToUnicode(b, cs), cs));
                }
                for (const b of canonical) {
                    assert.equal(unicodeToByte(byteToUnicode(b, cs), cs), b, hex(b));
                    //  canonical bytes live in 0x20-0x5F, 0xA0-0xBF or 0xC0-0xDF
                    assert((b >= 0x20 && b <= 0x5f) || (b >= 0xa0 && b <= 0xdf), hex(b));
                }
            });
        }

        it('picks the documented canonical byte in mirrored ranges', function () {
            for (const cs of BOTH) {
                for (let b = 0x60; b <= 0x7f; ++b) {
                    //  0x60-0x7F -> 0xC0-0xDF, except the duplicates listed below
                    const want = b + 0x60;
                    const got = unicodeToByte(byteToUnicode(b, cs), cs);
                    if (UPPER === cs && 0x62 === b) {
                        assert.equal(got, 0xdd); // Synchronet PETSCII_VERTLINE
                    } else if (UPPER === cs && 0x63 === b) {
                        assert.equal(got, 0xc0);
                    } else {
                        assert.equal(got, want, `${cs} ${hex(b)}`);
                    }
                }
                for (let b = 0xe0; b <= 0xfe; ++b) {
                    const got = unicodeToByte(byteToUnicode(b, cs), cs);
                    //  0xE0-0xFE mirror 0xA0-0xBE; 0xE0 is the blank, and the quarter
                    //  blocks are drawn twice (0xA5/0xB4, 0xA7/0xAA) so 0xF4 and 0xEA
                    //  land on the lower duplicate
                    const dup = { 0xe0: 0x20, 0xf4: 0xa5, 0xea: 0xa7 };
                    assert.equal(got, dup[b] || b - 0x40, `${cs} ${hex(b)}`);
                }
                assert.equal(unicodeToByte(byteToUnicode(0xff, cs), cs), 0xde);
                assert.equal(unicodeToByte(byteToUnicode(0xa0, cs), cs), 0x20);
            }
        });
    });

    describe('letters and case', function () {
        it('lower/upper: a-z <-> 0x41-0x5A, A-Z <-> 0xC1-0xDA', function () {
            for (let i = 0; i < 26; ++i) {
                const lo = chr(0x61 + i);
                const up = chr(0x41 + i);
                assert.equal(byteToUnicode(0x41 + i, LOWER), lo);
                assert.equal(byteToUnicode(0xc1 + i, LOWER), up);
                assert.equal(byteToUnicode(0x61 + i, LOWER), up); // mirror of 0xC1
                assert.equal(unicodeToByte(lo, LOWER), 0x41 + i);
                assert.equal(unicodeToByte(up, LOWER), 0xc1 + i);
            }
        });

        it('upper/graphics: A-Z <-> 0x41-0x5A, and a-z folds to them', function () {
            for (let i = 0; i < 26; ++i) {
                const up = chr(0x41 + i);
                assert.equal(byteToUnicode(0x41 + i, UPPER), up);
                assert.equal(unicodeToByte(up, UPPER), 0x41 + i);
                assert.equal(unicodeToByte(chr(0x61 + i), UPPER), 0x41 + i);
            }
            assert.deepEqual(encode('Hello, World', UPPER), Buffer.from('HELLO, WORLD'));
        });

        it('upper/graphics 0xC1-0xDA are graphics, not letters', function () {
            for (let b = 0xc1; b <= 0xda; ++b) {
                assert(!/[A-Za-z]/.test(byteToUnicode(b, UPPER)), hex(b));
            }
            assert.equal(byteToUnicode(0xc1, UPPER), '♠'); // spade
        });

        it('digits, space and ASCII punctuation PETSCII shares are identical bytes', function () {
            const same = ' !"#$%&\'()*+,-./0123456789:;<=>?@[]';
            for (const cs of BOTH) {
                for (const ch of same) {
                    assert.equal(unicodeToByte(ch, cs), ch.charCodeAt(0), ch);
                    assert.equal(byteToUnicode(ch.charCodeAt(0), cs), ch, ch);
                }
            }
        });
    });

    describe('truthful decoding of the ASCII outliers', function () {
        it('0x5C is the pound sign, 0x5E up arrow, 0x5F left arrow', function () {
            for (const cs of BOTH) {
                assert.equal(byteToUnicode(0x5c, cs), '£');
                assert.equal(byteToUnicode(0x5e, cs), '↑');
                assert.equal(byteToUnicode(0x5f, cs), '←');
                assert.equal(unicodeToByte('£', cs), 0x5c);
                assert.equal(unicodeToByte('↑', cs), 0x5e);
                assert.equal(unicodeToByte('←', cs), 0x5f);
            }
        });

        it('pi is 0xDE/0x7E/0xFF in upper/graphics only', function () {
            assert.equal(byteToUnicode(0xde, UPPER), 'π');
            assert.equal(byteToUnicode(0xff, UPPER), 'π');
            assert.equal(unicodeToByte('π', UPPER), 0xde);
            assert.equal(unicodeToByte('π', LOWER), undefined);
        });

        it('graphics Synchronet names decode to the glyphs it describes', function () {
            //  petdefs.h: names; con_out.cpp petscii_to_ansibbs: the CP437 it draws
            const cases = [
                [0xc0, '─'], // HORZLINE
                [0xdd, '│'], // VERTLINE
                [0xdb, '┼'], // CROSS
                [0xa1, '▌'], // LEFTHALF
                [0xa2, '▄'], // BOTTOMHALF
                [0xac, '▗'], // LWRRHTBOX
                [0xbb, '▖'], // LWRLFTBOX
                [0xbc, '▝'], // UPRRHTBOX
                [0xbe, '▘'], // UPRLFTBOX
                [0xbf, '▚'], // CHECKERBRD
                [0xa6, '▒'], // LIGHTHASH (the one hatch both sets share)
                [0xb0, '┌'],
                [0xae, '┐'],
                [0xad, '└'],
                [0xbd, '┘'],
                [0xab, '├'],
                [0xb3, '┤'],
                [0xb2, '┬'],
                [0xb1, '┴'],
            ];
            for (const cs of BOTH) {
                for (const [b, u] of cases) {
                    assert.equal(byteToUnicode(b, cs), u, `${cs} ${hex(b)}`);
                }
            }
            assert.equal(byteToUnicode(0xba, LOWER), '✓'); // CHECKMARK
        });
    });

    describe('private use area', function () {
        const used = new Map(); // code point -> { charsetIndex -> [bytes] }
        for (const [i, cs] of BOTH.entries()) {
            for (let b = 0; b < 256; ++b) {
                const s = byteToUnicode(b, cs);
                if (isPua(s)) {
                    const cp = s.charCodeAt(0);
                    used.set(cp, {
                        ...used.get(cp),
                        [i]: [...((used.get(cp) || {})[i] || []), b],
                    });
                }
            }
        }

        it('is one contiguous documented range starting at PUA_BASE', function () {
            assert.equal(PUA_BASE, 0xec00);
            assert(used.size > 0);
            for (const cp of used.keys()) {
                assert(cp >= PUA_BASE && cp < PUA_BASE + 0x200, cp.toString(16));
            }
        });

        it('follows PUA_BASE + (charsetIndex << 8) + canonicalByte', function () {
            for (const [cp, bySet] of used) {
                const idx = (cp - PUA_BASE) >> 8;
                const byte = (cp - PUA_BASE) & 0xff;
                assert([0, 1].includes(idx), cp.toString(16));
                //  the glyph is drawn by that charset at that byte ...
                assert.equal(byteToUnicode(byte, BOTH[idx]), chr(cp), cp.toString(16));
                //  ... which is the canonical byte, so decoding needs no charset
                assert.equal(unicodeToByte(chr(cp), BOTH[idx]), byte, cp.toString(16));
                //  a glyph both sets draw has index 0
                if (bySet[0] && bySet[1]) assert.equal(idx, 0, cp.toString(16));
            }
        });

        it('has exactly the 21 documented glyphs', function () {
            assert.deepEqual(
                [...used.keys()].sort((a, b) => a - b).map(n => n.toString(16)),
                [
                    'eca7',
                    'eca8',
                    'ecb6',
                    'ecb7',
                    'ecb8',
                    'ecba',
                    'ecc4',
                    'ecc5',
                    'ecc6',
                    'ecc7',
                    'ecc8',
                    'eccc',
                    'eccf',
                    'ecd0',
                    'ecd2',
                    'ecd4',
                    'ecd9',
                    'ecdc',
                    'eda9',
                    'edde',
                    'eddf',
                ]
            );
        });

        it('a set-specific glyph has no byte in the other set', function () {
            assert.equal(unicodeToByte('\uEDDE', UPPER), undefined); // lower/upper hatch
            assert.equal(unicodeToByte('\uEDDE', LOWER), 0xde);
            assert.equal(unicodeToByte('\uECC4', LOWER), undefined); // upper/graphics line
            assert.equal(unicodeToByte('\uECC4', UPPER), 0xc4);
            assert.equal(unicodeToByte('\uECA7', UPPER), 0xa7); // shared
            assert.equal(unicodeToByte('\uECA7', LOWER), 0xa7);
        });
    });

    describe('unicodeToByte', function () {
        it('accepts a code point number or a character', function () {
            assert.equal(unicodeToByte(0x41, LOWER), 0xc1);
            assert.equal(unicodeToByte('A', LOWER), 0xc1);
            assert.equal(unicodeToByte('AB', LOWER), 0xc1); // first character only
        });

        it('returns undefined with no mapping at all', function () {
            for (const cs of BOTH) {
                assert.equal(unicodeToByte('中', cs), undefined); // CJK
                assert.equal(unicodeToByte(0x1f600, cs), undefined); // astral
                assert.equal(unicodeToByte(0x1fb00, cs), undefined); // Legacy Computing
                assert.equal(unicodeToByte('…', cs), undefined); // expands to 3 bytes
                assert.equal(unicodeToByte('', cs), undefined);
                assert.equal(unicodeToByte(0x2588, cs), undefined); // needs reverse video
            }
        });

        it('reports glyphs that exist only as reverse video', function () {
            assert.equal(reverseOnlyByte('█'), 0xa0);
            assert.equal(reverseOnlyByte(0x2588), 0xa0);
            assert.equal(reverseOnlyByte('A'), undefined);
        });

        it('includes the single byte fallbacks', function () {
            assert.equal(unicodeToByte('|', LOWER), 0xdd);
            assert.equal(unicodeToByte('═', UPPER), 0xc0);
            assert.equal(unicodeToByte('é', LOWER), 0x45); // e, lower case in this set
            assert.equal(unicodeToByte('é', UPPER), 0x45);
        });
    });

    describe('ASCII PETSCII lacks (encode substitutes)', function () {
        //  Synchronet cp437_to_petscii / petdefs.h
        const subs = [
            ['\\', 0x2f], // '/'  (PETSCII_BACKSLASH)
            ['^', 0x5e], // up arrow (left as is)
            ['_', 0xa4], // PETSCII_UNDERSCORE
            ['`', 0xad], // PETSCII_BACKTICK
            ['~', 0xa8], // PETSCII_TILDE
            ['{', 0x28], // '('
            ['}', 0x29], // ')'
            ['|', 0xdd], // PETSCII_VERTLINE
        ];

        for (const cs of BOTH) {
            it(`${cs}: each substitute`, function () {
                for (const [ch, b] of subs) {
                    assert.deepEqual(encode(ch, cs), Buffer.from([b]), ch);
                    assert.equal(unicodeToByte(ch, cs), b, ch);
                }
            });
        }

        it('substitutes draw something sensible in both sets', function () {
            for (const cs of BOTH) {
                assert.equal(byteToUnicode(0xa4, cs), '▁');
                assert.equal(byteToUnicode(0xad, cs), '└');
                assert.equal(isPua(byteToUnicode(0xa8, cs)), true);
            }
        });
    });

    describe('CP437 fallbacks', function () {
        //  CP437 byte -> PETSCII byte, Synchronet cp437_to_petscii (box, blocks)
        const sync = {
            0xba: 0xdd,
            0xb3: 0xdd,
            0xcd: 0xc0,
            0xc4: 0xc0,
            0xce: 0xdb,
            0xd7: 0xdb,
            0xd8: 0xdb,
            0xc5: 0xdb,
            0xbc: 0xbd,
            0xbd: 0xbd,
            0xbe: 0xbd,
            0xd9: 0xbd,
            0xc9: 0xb0,
            0xd5: 0xb0,
            0xd6: 0xb0,
            0xda: 0xb0,
            0xb7: 0xae,
            0xb8: 0xae,
            0xbb: 0xae,
            0xbf: 0xae,
            0xc8: 0xad,
            0xd3: 0xad,
            0xd4: 0xad,
            0xc0: 0xad,
            0xc6: 0xab,
            0xc7: 0xab,
            0xcc: 0xab,
            0xc3: 0xab,
            0xb4: 0xb3,
            0xb5: 0xb3,
            0xb6: 0xb3,
            0xb9: 0xb3,
            0xcb: 0xb2,
            0xd1: 0xb2,
            0xd2: 0xb2,
            0xc2: 0xb2,
            0xca: 0xb1,
            0xcf: 0xb1,
            0xd0: 0xb1,
            0xc1: 0xb1,
            0xdc: 0xa2,
            0xdd: 0xa1,
            0xde: 0xb6,
            0xdf: 0xb8,
            0xfe: 0xbe,
            0xb0: 0xa6,
            0xb1: 0xa6,
        };

        for (const cs of BOTH) {
            it(`${cs}: Synchronet's table, byte for byte`, function () {
                for (const [cp437, petscii] of Object.entries(sync)) {
                    const ch = iconv.decode(Buffer.from([Number(cp437)]), 'cp437');
                    assert.deepEqual(
                        encode(ch, cs),
                        Buffer.from([petscii]),
                        `${ch} (CP437 ${hex(Number(cp437))})`
                    );
                }
            });

            it(`${cs}: every CP437 box and block character (0xB0-0xDF) is mapped`, function () {
                for (let b = 0xb0; b <= 0xdf; ++b) {
                    const ch = iconv.decode(Buffer.from([b]), 'cp437');
                    const out = encode(ch, cs);
                    assert.notDeepEqual(out, Buffer.from([0x3f]), `${ch} (${hex(b)})`);
                }
            });
        }

        it('U+2588 FULL BLOCK is reverse-video blank (Synchronet PETSCII_SOLID)', function () {
            for (const cs of BOTH) {
                assert.deepEqual(
                    encode('█', cs),
                    Buffer.from([Controls.reverseOn, 0xa0, Controls.reverseOff])
                );
                assert.deepEqual(
                    encode('█', cs, { reverseSolid: false }),
                    Buffer.from([0xa0])
                );
            }
            assert.equal(byteToUnicode(0xa0, LOWER), ' ');
        });

        it('shades: one hatch density exists; the heavier one only in lower/upper', function () {
            assert.deepEqual(encode('░▒', LOWER), Buffer.from([0xa6, 0xa6]));
            assert.deepEqual(encode('▓', LOWER), Buffer.from([0xa9]));
            assert.deepEqual(encode('░▒▓', UPPER), Buffer.from([0xa6, 0xa6, 0xa6]));
        });

        it('needs upper/graphics: bullets and shapes', function () {
            assert.deepEqual(encode('•', UPPER), Buffer.from([0xd1])); // filled circle
            assert.deepEqual(encode('•', LOWER), Buffer.from('*'));
            assert.deepEqual(encode('♥', UPPER), Buffer.from([0xd3]));
            assert.deepEqual(encode('♥', LOWER), Buffer.from('?'));
        });

        it('needs lower/upper: check mark', function () {
            assert.deepEqual(encode('√', LOWER), Buffer.from([0xba]));
            assert.deepEqual(encode('√', UPPER), Buffer.from('V'));
        });

        it('arrows', function () {
            for (const cs of BOTH) {
                assert.deepEqual(encode('↑←', cs), Buffer.from([0x5e, 0x5f]));
                assert.deepEqual(encode('▲', cs), Buffer.from([0x5e]));
                assert.deepEqual(
                    encode('↓▼', cs),
                    Buffer.from(cs === LOWER ? [0xd6, 0xd6] : [0x56, 0x56])
                );
                assert.deepEqual(encode('→►', cs), Buffer.from('>>'));
                assert.deepEqual(encode('◄', cs), Buffer.from('<'));
            }
        });

        it('typographic characters become plain ASCII', function () {
            const nbsp = String.fromCodePoint(0xa0);
            const zwsp = String.fromCodePoint(0x200b);
            const cases = [
                ['‘x’', "'x'"],
                ['“x”', '"x"'],
                ['a–b—c', 'a-b-c'],
                ['wait…', 'wait...'],
                [`a${nbsp}b`, 'a b'],
                [`a${zwsp}b`, 'ab'],
                ['« x »', '<< x >>'],
                ['½', '1/2'],
                ['©', '(c)'],
            ];
            for (const cs of BOTH) {
                for (const [input, want] of cases) {
                    // lower case letters are case-folded by the charset, not here
                    assert.equal(
                        decode(
                            encode(input, cs),
                            LOWER === cs ? LOWER : UPPER
                        ).toLowerCase(),
                        want.toLowerCase(),
                        input
                    );
                }
            }
        });

        it('accented Latin letters fold to ASCII, the rest to the fallback', function () {
            assert.equal(decode(encode('café naïve Ñ', LOWER), LOWER), 'cafe naive N');
            assert.equal(decode(encode('straße æ Ø', LOWER), LOWER), 'strasse ae O');
            assert.equal(decode(encode('½ é', UPPER), UPPER), '1/2 E');
        });
    });

    describe('decode / encode', function () {
        it('decodes a mixed buffer (controls pass through as C0/C1)', function () {
            const buf = Buffer.from([
                Controls.clear,
                Colors.red,
                0xc8,
                0x45,
                0x4c,
                0x4c,
                0x4f,
                0x20,
                0xdd,
                0xc0,
                0xa6,
                Controls.return,
            ]);
            assert.equal(
                decode(buf, LOWER),
                chr(0x93) + chr(0x1c) + 'Hello │─▒' + chr(0x0d)
            );
            //  same bytes, other set: letters and graphics change, controls do not
            assert.equal(
                decode(buf, UPPER),
                chr(0x93) + chr(0x1c) + chr(0xecc8) + 'ELLO │─▒' + chr(0x0d)
            );
        });

        it('decode handles Uint8Array and an empty buffer', function () {
            assert.equal(decode(Buffer.alloc(0), LOWER), '');
            assert.equal(decode(new Uint8Array([0x41, 0x42]), UPPER), 'AB');
        });

        it('encode inverts decode on canonical text', function () {
            for (const cs of BOTH) {
                const canonical = [];
                for (const b of printableBytes) {
                    const c = unicodeToByte(byteToUnicode(b, cs), cs);
                    if (!canonical.includes(c)) canonical.push(c);
                }
                const bytes = Buffer.from(canonical);
                assert.deepEqual(encode(decode(bytes, cs), cs), bytes);
            }
        });

        it('encodes mixed text and controls in lower/upper', function () {
            const text = 'Hi, You!' + chr(0x0d) + chr(0x93);
            assert.deepEqual(
                encode(text, LOWER),
                Buffer.from([0xc8, 0x49, 0x2c, 0x20, 0xd9, 0x4f, 0x55, 0x21, 0x0d, 0x93])
            );
        });

        it('defaults to lower/upper', function () {
            assert.deepEqual(encode('aA'), Buffer.from([0x41, 0xc1]));
            assert.equal(decode(Buffer.from([0x41, 0xc1])), 'aA');
        });

        it('unmappable characters become the fallback byte (default 0x3F)', function () {
            for (const cs of BOTH) {
                assert.deepEqual(encode('a中b', cs), Buffer.from([0x41, 0x3f, 0x42]));
                assert.deepEqual(
                    encode('中', cs, { fallbackByte: 0x2e }),
                    Buffer.from('.')
                );
                assert.deepEqual(
                    encode('中', cs, { fallbackByte: 0x20 }),
                    Buffer.from(' ')
                );
            }
        });

        it('an astral character is one fallback byte, not two', function () {
            const emoji = String.fromCodePoint(0x1f600);
            const legacy = String.fromCodePoint(0x1fb00); // Legacy Computing sextant
            for (const cs of BOTH) {
                assert.deepEqual(encode(emoji, cs), Buffer.from([0x3f]));
                assert.deepEqual(
                    encode(`x${legacy}y`, cs),
                    Buffer.from([0x58, 0x3f, 0x59])
                );
            }
        });

        it('a lone surrogate is a fallback byte', function () {
            assert.deepEqual(encode(chr(0xd800), LOWER), Buffer.from([0x3f]));
        });

        it('PUA code points encode back to their byte, and only in a set that draws them', function () {
            assert.deepEqual(encode('\uEDDE', LOWER), Buffer.from([0xde]));
            assert.deepEqual(encode('\uEDDE', UPPER), Buffer.from([0x3f]));
            assert.deepEqual(encode('\uECC4', UPPER), Buffer.from([0xc4]));
        });

        it('rejects an unknown charset', function () {
            assert.throws(() => encode('a', 'ascii'), TypeError);
            assert.throws(() => decode(Buffer.from([0x41]), 'ascii'), TypeError);
        });

        it('output is always bytes', function () {
            const out = encode('A█中', UPPER);
            assert(Buffer.isBuffer(out));
            for (const b of out) assert(b >= 0 && b <= 255);
        });
    });
    describe('review fixes', () => {
        it('rejects charset names that are Object.prototype keys with the same error', () => {
            ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'ascii'].forEach(
                name => {
                    assert.throws(
                        () => charset.encode('a', name),
                        /Unknown PETSCII charset/
                    );
                }
            );
        });

        it('drops a lone combining mark instead of writing the fallback byte', () => {
            const decomposed = 'cafe' + String.fromCharCode(0x301);
            assert.deepEqual(
                [...charset.encode(decomposed, charset.Charsets.LowerUpper)],
                [0x43, 0x41, 0x46, 0x45]
            );
        });
    });
});
