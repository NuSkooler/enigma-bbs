'use strict';

const { strict: assert } = require('assert');
const iconv = require('iconv-lite');

const { CP437_TERM_ENCODING, BBS_GLYPHS } = require('../core/cp437.js');

//  Every byte a CP437 stream can carry.
const ALL_BYTES = Buffer.from(Array.from({ length: 256 }, (_unused, i) => i));

describe('cp437 (BBS terminal variant)', () => {
    it('registers itself with iconv-lite', () => {
        assert.ok(iconv.encodingExists(CP437_TERM_ENCODING));
    });

    //
    //  Decoding has to stay stock. If 0x1B came back as '←' rather than ESC,
    //  every ANSI sequence in every piece of art would stop working.
    //
    describe('decoding', () => {
        it('is byte-for-byte identical to stock cp437', () => {
            assert.strictEqual(
                iconv.decode(ALL_BYTES, CP437_TERM_ENCODING),
                iconv.decode(ALL_BYTES, 'cp437')
            );
        });

        it('leaves ESC, CR and LF as control codes', () => {
            const decoded = iconv.decode(
                Buffer.from([0x1b, 0x0d, 0x0a]),
                CP437_TERM_ENCODING
            );
            assert.strictEqual(decoded, '\x1b\r\n');
        });
    });

    describe('encoding', () => {
        it('maps each BBS glyph onto its CP437 byte', () => {
            BBS_GLYPHS.forEach(([byte, glyph]) => {
                const encoded = iconv.encode(glyph, CP437_TERM_ENCODING);
                assert.deepStrictEqual(
                    encoded,
                    Buffer.from([byte]),
                    `${glyph} should encode to 0x${byte.toString(16)}`
                );
            });
        });

        it('is what stock cp437 gets wrong', () => {
            //  Guards the premise: if a future iconv-lite learns these on its
            //  own, this module has become dead weight and should be removed.
            BBS_GLYPHS.forEach(([, glyph]) => {
                assert.deepStrictEqual(
                    iconv.encode(glyph, 'cp437'),
                    Buffer.from([0x3f]),
                    `stock cp437 unexpectedly encodes ${glyph}`
                );
            });
        });

        it('leaves ANSI sequences, CR, LF and TAB untouched', () => {
            const s = '\x1b[1;37mBOLD\x1b[0m\r\n\tx';
            assert.deepStrictEqual(
                iconv.encode(s, CP437_TERM_ENCODING),
                iconv.encode(s, 'cp437')
            );
        });

        it('leaves the high range untouched', () => {
            const s = '▒█─│▄▀';
            assert.deepStrictEqual(
                iconv.encode(s, CP437_TERM_ENCODING),
                iconv.encode(s, 'cp437')
            );
        });

        it('still refuses the glyphs whose bytes a terminal would act on', () => {
            //  • ◘ ○ ◙ ♂ ♀ ♪ are BEL, BS, HT, LF, VT, FF and CR. Drawing them
            //  would mean emitting those control codes.
            '•◘○◙♂♀♪←→'.split('').forEach(glyph => {
                assert.deepStrictEqual(
                    iconv.encode(glyph, CP437_TERM_ENCODING),
                    Buffer.from([0x3f]),
                    `${glyph} must not be emitted as a control code`
                );
            });
        });
    });

    //
    //  The regression argument for the whole change: it only ever replaces a
    //  '?' with something better, so no output that works today can move.
    //
    describe('blast radius', () => {
        it('changes exactly the BBS glyphs and nothing else in the BMP', () => {
            const changed = [];
            for (let cp = 0; cp < 0x10000; ++cp) {
                const ch = String.fromCharCode(cp);
                const before = iconv.encode(ch, 'cp437');
                const after = iconv.encode(ch, CP437_TERM_ENCODING);
                if (!before.equals(after)) {
                    changed.push([cp, before]);
                }
            }

            assert.strictEqual(changed.length, BBS_GLYPHS.length);
            changed.forEach(([cp, before]) => {
                assert.deepStrictEqual(
                    before,
                    Buffer.from([0x3f]),
                    `U+${cp.toString(16)} changed from a real byte, not from '?'`
                );
            });
        });
    });

    //
    //  The codec is only useful if terminal output actually goes through it,
    //  while every other consumer keeps seeing the plain 'cp437' name.
    //
    describe('ClientTerminal wiring', () => {
        const { ClientTerminal } = require('../core/client_term.js');

        const term = () => new ClientTerminal({ write() {}, writable: true });

        it('still reports its encoding as cp437', () => {
            //  ACS "EC0" compares against this literally, and the encoding
            //  menu assigns it straight from form data.
            assert.strictEqual(term().outputEncoding, 'cp437');
        });

        it('encodes BBS glyphs rather than dropping them', () => {
            assert.deepStrictEqual(
                term().encode('♥♦♣♠'),
                Buffer.from([0x03, 0x04, 0x05, 0x06])
            );
        });

        it('leaves ANSI and the high range alone', () => {
            const t = term();
            assert.deepStrictEqual(
                t.encode('\x1b[1;37mX\x1b[0m', false),
                Buffer.from('\x1b[1;37mX\x1b[0m', 'binary')
            );
            assert.deepStrictEqual(
                t.encode('▒█─│', false),
                Buffer.from([0xb1, 0xdb, 0xc4, 0xb3])
            );
        });

        it('does not touch utf8 clients', () => {
            const t = term();
            t.outputEncoding = 'utf8';
            assert.deepStrictEqual(t.encode('♥'), Buffer.from('♥', 'utf8'));
        });
    });

    describe('art', () => {
        it('round-trips CP437 bytes losslessly, ANSI included', () => {
            //  smiley, heart, up arrow, house, shade, block, then ESC [ 0 m CRLF
            const art = Buffer.from([
                0x01, 0x03, 0x18, 0x7f, 0xb1, 0xdb, 0x1b, 0x5b, 0x30, 0x6d, 0x0d, 0x0a,
            ]);
            const decoded = iconv.decode(art, CP437_TERM_ENCODING);
            assert.deepStrictEqual(iconv.encode(decoded, CP437_TERM_ENCODING), art);
        });
    });
});
