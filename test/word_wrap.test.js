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

    it('puts a character wider than the width on its own line, with no blank line', () => {
        const { wrapped } = wordWrapText('日本語', { width: 1, pipeCodeSupport: true });
        assert.deepEqual(wrapped, ['日', '本', '語']);
    });

    it('never breaks a surrogate pair', () => {
        //  Each emoji is two UTF-16 code units and two columns
        const { wrapped } = wordWrapText('😀😀😀😀😀😀', {
            width: 5,
            pipeCodeSupport: true,
        });
        assert.deepEqual(wrapped, ['😀😀', '😀😀', '😀😀']);
    });

    it('never breaks a grapheme cluster', () => {
        const flags = '🇯🇵🇰🇷🇺🇸';
        assert.deepEqual(
            wordWrapText(flags, { width: 6, pipeCodeSupport: true }).wrapped,
            ['🇯🇵', '🇰🇷', '🇺🇸']
        );

        const thumbs = '👍🏽👍🏽👍🏽';
        assert.deepEqual(
            wordWrapText(thumbs, { width: 6, pipeCodeSupport: true }).wrapped,
            ['👍🏽', '👍🏽', '👍🏽']
        );

        const accented = 'e\u0301'.repeat(12);
        assert.deepEqual(wordWrapText(accented, { width: 10 }).wrapped, [
            'e\u0301'.repeat(10),
            'e\u0301'.repeat(2),
        ]);
    });

    it('keeps a word with a colour code in it together', () => {
        const { wrapped } = wordWrapText('|07The quick brown fox |12jumps|07. Next', {
            width: 26,
            pipeCodeSupport: true,
        });
        assert.deepEqual(wrapped, ['|07The quick brown fox ', '|07|12jumps|07. Next']);
    });

    it('breaks a long word with a colour code in it at the full width', () => {
        const { wrapped } = wordWrapText('|12aaaaaaaa|07bbbbbbbbbbbb', {
            width: 10,
            pipeCodeSupport: true,
        });
        assert.deepEqual(wrapped, ['|12aaaaaaaa|07bb', '|07bbbbbbbbbb']);
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
