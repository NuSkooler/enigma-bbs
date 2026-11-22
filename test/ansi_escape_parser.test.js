'use strict';

const { strict: assert } = require('assert');

const { ANSIEscapeParser } = require('../core/ansi_escape_parser.js');

//
//  ANSIEscapeParser: characters are whole code units (a character whose low
//  byte is CR or LF is not a line break); the opt-in extendedSgr; the
//  'erase rows' event's which / column.
//

const ESC = '\x1b';

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

    describe('extendedSgr', function () {
        it('off (art.display()): SGR is read as it always has been', function () {
            const { out, parser } = events(`${ESC}[38;5;31mX`);
            assert.equal(parser.graphicRendition.blink, 5);
            assert.equal(parser.graphicRendition.fg, 31);
            assert.equal(
                out.some(e => 'sgr unsupported' === e[0]),
                false
            );
        });

        it('on: 38/48/58 take their sub-parameters, and are reported', function () {
            const { out, parser } = events(
                `${ESC}[1;34;38;5;31;48;2;255;0;0;58;5;1;4mX`,
                { extendedSgr: true }
            );
            assert.deepEqual(
                { ...parser.graphicRendition },
                { reset: false, intensity: 1, fg: 34, underline: 4 }
            );
            assert.deepEqual(
                out.filter(e => 'sgr unsupported' === e[0]),
                [
                    ['sgr unsupported', [38, 5, 31]],
                    ['sgr unsupported', [48, 2, 255, 0, 0]],
                    ['sgr unsupported', [58, 5, 1]],
                ]
            );
        });

        it('on: aixterm bright colours are reported; 90 is still the foreground', function () {
            const { out, parser } = events(`${ESC}[90;101;97mX`, { extendedSgr: true });
            assert.equal(parser.graphicRendition.fg, 90);
            assert.equal(parser.graphicRendition.bg, undefined);
            assert.deepEqual(
                out.filter(e => 'sgr unsupported' === e[0]),
                [
                    ['sgr unsupported', [90]],
                    ['sgr unsupported', [101]],
                    ['sgr unsupported', [97]],
                ]
            );
        });
    });

    describe("'erase rows'", function () {
        it('carries which (below / above) and the cursor column', function () {
            const rows = input => events(input).out.filter(e => 'erase rows' === e[0]);
            assert.deepEqual(rows(`${ESC}[3;7H${ESC}[J`), [
                ['erase rows', 3, 25, 'below', 7],
            ]);
            assert.deepEqual(rows(`${ESC}[3;7H${ESC}[0J`), [
                ['erase rows', 3, 25, 'below', 7],
            ]);
            assert.deepEqual(rows(`${ESC}[1;7H${ESC}[1J`), [
                ['erase rows', 1, 1, 'above', 7],
            ]);
        });
    });
});
