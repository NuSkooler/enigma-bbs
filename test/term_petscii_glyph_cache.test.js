'use strict';

//  Pins the bytes the PETSCII translator and charset produce per glyph, so the
//  per-charset glyph caches cannot change output (compared against the
//  uncached implementation over ~900K cases when the cache was added).

const { strict: assert } = require('assert');

const { Controls, unicodeToByte, encode } = require('../core/term/petscii/charset.js');
const { createPetsciiTranslator } = require('../core/term/petscii/output_translator.js');

function bytesOf(text, charset) {
    const out = createPetsciiTranslator({ cols: 40, rows: 25, charset }).translate(
        Buffer.from(text, 'utf8')
    );
    return [...out];
}

describe('PETSCII glyph cache', function () {
    it('pins glyph bytes in both charsets, cold and warm', function () {
        //  every output starts: charset select, reverse off, white
        const L = [0x0e, 0x92, 0x9b];
        const U = [0x8e, 0x92, 0x9b];
        for (let pass = 0; pass < 2; ++pass) {
            assert.deepEqual(bytesOf('Ab', 'lower'), [...L, 0xc1, 0x42]);
            //  upper/graphics has no lower case: folded
            assert.deepEqual(bytesOf('Ab', 'upper'), [...U, 0x41, 0x42]);
            //  accented Latin strips the mark
            assert.deepEqual(bytesOf('\u00e9', 'lower'), [...L, 0x45]);
            assert.deepEqual(bytesOf('\u00e9', 'upper'), [...U, 0x45]);
            //  zero-width draws nothing; unmapped is '?'
            assert.deepEqual(bytesOf('a\u200bb', 'lower'), [...L, 0x41, 0x42]);
            assert.deepEqual(bytesOf('\u9760', 'lower'), [...L, 0x3f]);
            //  U+2588 is reverse video 0xA0
            assert.deepEqual(bytesOf('\u2588', 'lower'), [0x0e, 0x12, 0x9b, 0xa0]);
            assert.deepEqual(bytesOf('\u2588', 'upper'), [0x8e, 0x12, 0x9b, 0xa0]);
        }
    });

    it('does not leak a cached glyph between charsets or attribute states', function () {
        const t = createPetsciiTranslator({ cols: 40, rows: 25, charset: 'lower' });
        const a = [...t.translate(Buffer.from('█'))];
        t.setCharset('upper');
        const b = [...t.translate(Buffer.from('█'))];
        assert.ok(a.includes(0xa0) && b.includes(0xa0));
        //  a later plain glyph is not left in reverse
        const c = [...t.translate(Buffer.from('x'))];
        assert.ok(c.includes(Controls.reverseOff));
    });

    it('encode and unicodeToByte are stable across repeated calls', function () {
        const first = encode('é█', 'lower');
        first[0] = 0xff; //  encode returns a fresh Buffer each call
        assert.deepEqual([...encode('é█', 'lower')], [0x45, 0x12, 0xa0, 0x92]);
        assert.equal(unicodeToByte('é', 'lower'), 0x45);
        assert.equal(unicodeToByte('é', 'lower'), 0x45);
    });
});
