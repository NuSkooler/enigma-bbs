'use strict';

//
//  A description file (FILE_ID.DIZ, README, .NFO) that carries a SAUCE record
//  is cut at the EOF marker (0x1a) before it. The cut is made on the raw
//  bytes: after the CP437 decode a character never equals the number 0x1a,
//  so nothing was ever cut (#1109).
//

const { strict: assert } = require('assert');
const iconv = require('iconv-lite');

const { sliceAtSauceMarker, decodeDescFile } = require('../core/desc_file.js');

//  A 128 byte SAUCE record: ID, version, then NUL padding is enough here.
function sauceRecord() {
    const rec = Buffer.alloc(128, 0);
    rec.write('SAUCE00', 0, 'latin1');
    rec.write('A Title', 7, 'latin1');
    return rec;
}

describe('sliceAtSauceMarker()', () => {
    const text = Buffer.from([
        ...Buffer.from('Short from the DIZ\r\n', 'latin1'),
        0xb0,
        0xb1,
        0xb2, //  CP437 shade blocks, decoded to graphics
        ...Buffer.from('\r\n', 'latin1'),
    ]);

    it('cuts the bytes at the EOF marker before a SAUCE record', () => {
        const data = Buffer.concat([text, Buffer.from([0x1a]), sauceRecord()]);
        assert.deepEqual(sliceAtSauceMarker(data), text);
    });

    it('leaves nothing of the record in the decoded description', () => {
        const data = Buffer.concat([text, Buffer.from([0x1a]), sauceRecord()]);
        const desc = decodeDescFile(data);
        assert.equal(desc, iconv.decode(text, 'cp437'));
        assert.ok(!desc.includes('SAUCE00'));
        assert.ok(!desc.includes('\0'));
    });

    it('keeps a file with no EOF marker whole', () => {
        assert.deepEqual(sliceAtSauceMarker(text), text);
    });

    it('only looks for the marker near the end', () => {
        const early = Buffer.concat([
            Buffer.from('a'),
            Buffer.from([0x1a]),
            Buffer.alloc(400, 0x41),
        ]);
        assert.deepEqual(sliceAtSauceMarker(early), early);
    });
});
