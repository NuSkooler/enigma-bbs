'use strict';

const { strict: assert } = require('assert');

const { ANSIEscapeParser } = require('../core/ansi_escape_parser.js');

//
//  ANSIEscapeParser: characters are whole code units (a character whose low
//  byte is CR or LF is not a line break).
//

//  The parser's events for |input|, in order
function events(input, options) {
    const parser = new ANSIEscapeParser(
        Object.assign({ termWidth: 80, termHeight: 25 }, options)
    );
    const out = [];
    [
        'literal',
        'position update',
        'sgr update',
        'sgr unsupported',
        'erase rows',
        'erase columns',
    ].forEach(name => {
        parser.on(name, (...args) => {
            out.push([
                name,
                //  copies: graphicRendition is the parser's own, and changes
                ...args.map(a =>
                    Array.isArray(a) ? [...a] : a && 'object' === typeof a ? { ...a } : a
                ),
            ]);
        });
    });
    parser.parse(input);
    return { out, parser };
}

describe('ANSIEscapeParser', function () {
    describe('characters', function () {
        //  low byte 0x0D or 0x0A: U+010D c-caron, U+250A, U+250D, U+010A,
        //  and an astral character whose surrogates both end in 0x0A
        ['\u010d', '\u250a', '\u250d', '\u010a', '\u{1280a}'].forEach(ch => {
            const name = `U+${ch.codePointAt(0).toString(16).toUpperCase()}`;
            it(`${name} is a character, not a line break`, function () {
                const { out, parser } = events(`ab${ch}cd`);
                assert.equal(parser.row, 1);
                assert.equal(parser.column, 5 + ch.length);
                assert.deepEqual(out, [['literal', `ab${ch}cd`]]);
            });
        });

        it('CR and LF still break lines', function () {
            const { parser } = events('ab\r\ncd\nef\rg');
            assert.equal(parser.row, 3);
            assert.equal(parser.column, 2);
        });
    });
});
