'use strict';

const { strict: assert } = require('assert');

const { ANSIEscapeParser } = require('../core/ansi_escape_parser.js');

//
//  ANSIEscapeParser's opt-in deferredWrap (used by core/ansi_canvas.js):
//  a character in the last column wraps when the next one is drawn. The
//  default -- what art.display() uses -- still wraps at once.
//

//  Where each character lands, as [ row, col ], and the parser's final row
function landings(input, options) {
    const parser = new ANSIEscapeParser(
        Object.assign({ termWidth: 4, termHeight: 100 }, options)
    );
    const out = [];
    let row = 1;
    let col = 1;
    parser.on('position update', (r, c) => {
        row = r;
        col = c;
    });
    parser.on('literal', text => {
        for (const ch of text.replace(/[\r\n]/g, '')) {
            out.push(`${ch}@${row},${col}`);
            ++col;
        }
    });
    parser.parse(input);
    return { out, row: parser.row, col: parser.column };
}

describe('ANSIEscapeParser wrap', function () {
    it('default: a full line wraps at once, so CRLF after it adds a row', function () {
        const { out, row } = landings('abcd\r\nef');
        assert.deepEqual(out, ['a@1,1', 'b@1,2', 'c@1,3', 'd@1,4', 'e@3,1', 'f@3,2']);
        assert.equal(row, 3);
    });

    it('deferredWrap: CRLF after a full line takes one row', function () {
        const { out, row } = landings('abcd\r\nef', { deferredWrap: true });
        assert.deepEqual(out, ['a@1,1', 'b@1,2', 'c@1,3', 'd@1,4', 'e@2,1', 'f@2,2']);
        assert.equal(row, 2);
    });

    it('deferredWrap: a bare LF after a full line takes one row too', function () {
        assert.deepEqual(landings('abcd\nef', { deferredWrap: true }).out.slice(4), [
            'e@2,1',
            'f@2,2',
        ]);
    });

    it('deferredWrap: the next character wraps, even after an SGR', function () {
        const { out } = landings('abcd\x1b[1;31mef', { deferredWrap: true });
        assert.deepEqual(out.slice(4), ['e@2,1', 'f@2,2']);
        assert.deepEqual(landings('abcdef', { deferredWrap: true }).out.slice(4), [
            'e@2,1',
            'f@2,2',
        ]);
    });

    it('deferredWrap: a cursor movement cancels the pending wrap', function () {
        const { out } = landings('abcd\x1b[1;2HX', { deferredWrap: true });
        assert.deepEqual(out.slice(4), ['X@1,2']);
    });
});
