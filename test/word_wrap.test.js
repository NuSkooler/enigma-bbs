'use strict';

const { strict: assert } = require('assert');

const { wordWrapText } = require('../core/word_wrap.js');
const { renderStringLength } = require('../core/string_util.js');

describe('wordWrapText', () => {
    it('wraps words at the width', () => {
        const { wrapped } = wordWrapText('the quick brown fox jumps over the lazy dog', {
            width: 15,
        });
        assert.deepEqual(wrapped, [
            'the quick ',
            'brown fox ',
            'jumps over the ',
            'lazy dog',
        ]);
    });

    it('breaks a word too long for the width', () => {
        const { wrapped } = wordWrapText('abcdefghijklmnopqrstuvwxyz', { width: 10 });
        assert.deepEqual(wrapped, ['abcdefghij', 'klmnopqrst', 'uvwxyz']);
    });

    it('breaks wide characters by columns, starting on the first line', () => {
        const { wrapped } = wordWrapText('日本語日本語日本語日本語', {
            width: 10,
            pipeCodeSupport: true,
        });
        assert.deepEqual(wrapped, ['日本語日本', '語日本語日', '本語']);
        wrapped.forEach(l => assert.ok(renderStringLength(l) <= 10, l));
    });

    it('keeps a pipe code whole where wide characters are broken', () => {
        const { wrapped } = wordWrapText('日本語日本語|12日本語', {
            width: 10,
            pipeCodeSupport: true,
        });
        assert.deepEqual(wrapped, ['日本語日本', '語|12日本語']);
        wrapped.forEach(l => assert.ok(renderStringLength(l) <= 10, l));
    });
});
