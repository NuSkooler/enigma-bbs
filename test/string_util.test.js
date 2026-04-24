'use strict';

const { strict: assert } = require('assert');

const {
    charDisplayWidth,
    strDisplayWidth,
    renderStringLength,
    ansiRenderStringLength,
    renderSplitPos,
} = require('../core/string_util.js');

// ─── charDisplayWidth ─────────────────────────────────────────────────────────

describe('charDisplayWidth', () => {
    it('returns 1 for ASCII letters', () => {
        assert.equal(charDisplayWidth('A'), 1);
        assert.equal(charDisplayWidth('z'), 1);
    });

    it('returns 1 for ASCII digits and punctuation', () => {
        assert.equal(charDisplayWidth('0'), 1);
        assert.equal(charDisplayWidth('!'), 1);
        assert.equal(charDisplayWidth(' '), 1);
    });

    it('returns 2 for CJK unified ideographs', () => {
        assert.equal(charDisplayWidth('一'), 2); // U+4E00
        assert.equal(charDisplayWidth('日'), 2); // U+65E5
        assert.equal(charDisplayWidth('中'), 2); // U+4E2D
    });

    it('returns 2 for Hangul syllables', () => {
        assert.equal(charDisplayWidth('가'), 2); // U+AC00
        assert.equal(charDisplayWidth('힣'), 2); // U+D7A3
    });

    it('returns 2 for Hiragana', () => {
        assert.equal(charDisplayWidth('あ'), 2); // U+3042
        assert.equal(charDisplayWidth('の'), 2); // U+306E
    });

    it('returns 2 for Katakana', () => {
        assert.equal(charDisplayWidth('ア'), 2); // U+30A2
        assert.equal(charDisplayWidth('テ'), 2); // U+30C6
    });

    it('returns 2 for fullwidth ASCII forms', () => {
        assert.equal(charDisplayWidth('Ａ'), 2); // U+FF21 fullwidth A
        assert.equal(charDisplayWidth('１'), 2); // U+FF11 fullwidth 1
    });

    it('returns 1 for halfwidth Katakana', () => {
        assert.equal(charDisplayWidth('ｦ'), 1); // U+FF66 halfwidth
        assert.equal(charDisplayWidth('ｱ'), 1); // U+FF71 halfwidth
    });

    it('returns 0 for combining diacritical marks', () => {
        assert.equal(charDisplayWidth('\u0301'), 0); // combining acute accent
        assert.equal(charDisplayWidth('\u0300'), 0); // combining grave accent
    });

    it('returns 0 for NUL', () => {
        assert.equal(charDisplayWidth('\0'), 0);
    });
});

// ─── strDisplayWidth ──────────────────────────────────────────────────────────

describe('strDisplayWidth', () => {
    it('empty string is 0', () => {
        assert.equal(strDisplayWidth(''), 0);
    });

    it('pure ASCII string equals its length', () => {
        assert.equal(strDisplayWidth('hello'), 5);
        assert.equal(strDisplayWidth('abc'), 3);
    });

    it('CJK string is twice the character count', () => {
        assert.equal(strDisplayWidth('日本'), 4);
        assert.equal(strDisplayWidth('한국어'), 6);
    });

    it('mixed ASCII and CJK accumulates correctly', () => {
        assert.equal(strDisplayWidth('A日B'), 4); // 1+2+1
        assert.equal(strDisplayWidth('AB日本CD'), 8); // 1+1+2+2+1+1
    });

    it('combining marks contribute 0', () => {
        // 'e' + combining acute = 1 display col
        assert.equal(strDisplayWidth('e\u0301'), 1);
    });
});

// ─── renderStringLength — wide char awareness ─────────────────────────────────

describe('renderStringLength — wide characters', () => {
    it('pure ASCII is unchanged', () => {
        assert.equal(renderStringLength('hello'), 5);
    });

    it('CJK characters count as 2 columns each', () => {
        assert.equal(renderStringLength('日本語'), 6);
    });

    it('mixed ASCII and CJK', () => {
        assert.equal(renderStringLength('AB日CD'), 6); // 1+1+2+1+1
    });

    it('pipe codes are stripped; wide chars behind them counted correctly', () => {
        assert.equal(renderStringLength('|07日本'), 4);
        assert.equal(renderStringLength('|07ABC|02日'), 5); // 3 + 2
    });

    it('pipe codes at end of string', () => {
        assert.equal(renderStringLength('日|07'), 2);
    });

    it('ANSI ESC[NC cursor-forward contributes its explicit count, not display width', () => {
        const esc = '\x1b[5C'; // forward 5
        assert.equal(renderStringLength(esc), 5);
        assert.equal(renderStringLength('AB' + esc + '日'), 2 + 5 + 2); // 9
    });

    it('empty string is 0', () => {
        assert.equal(renderStringLength(''), 0);
    });
});

// ─── ansiRenderStringLength — wide char awareness ────────────────────────────

describe('ansiRenderStringLength — wide characters', () => {
    it('CJK characters count as 2 columns each', () => {
        assert.equal(ansiRenderStringLength('日本'), 4);
    });

    it('pipe codes are NOT stripped (no pipe support in this variant)', () => {
        // |07 counts as 3 literal chars
        assert.equal(ansiRenderStringLength('|07'), 3);
    });

    it('ANSI escapes stripped, wide chars counted', () => {
        const sgr = '\x1b[32m';
        assert.equal(ansiRenderStringLength(sgr + '日'), 2);
    });
});

// ─── renderSplitPos ───────────────────────────────────────────────────────────

describe('renderSplitPos', () => {
    //  Helper: returns a string split at width and the remainder
    function splitAt(str, width, pipe = false) {
        const pos = renderSplitPos(str, width, pipe);
        return [str.slice(0, pos), str.slice(pos)];
    }

    it('splits pure ASCII at exact width', () => {
        const [left, right] = splitAt('ABCDE', 3, false);
        assert.equal(left, 'ABC');
        assert.equal(right, 'DE');
    });

    it('returns full length when string fits within width', () => {
        assert.equal(renderSplitPos('ABC', 10, false), 3);
    });

    it('returns 0 for width 0', () => {
        assert.equal(renderSplitPos('ABC', 0, false), 0);
    });

    it('empty string always returns 0', () => {
        assert.equal(renderSplitPos('', 5, false), 0);
    });

    it('snaps before a wide char that would straddle the boundary', () => {
        // 'AB日C': A(1)+B(1)+日(2)+C(1) — at width 3, 日 would overshoot
        assert.equal(renderSplitPos('AB日C', 3, false), 2); // snap before 日
    });

    it('includes a wide char that fits exactly', () => {
        // 'AB日C' at width 4: A+B+日 = 4 → string index 3 (after 日, which is 1 JS char)
        assert.equal(renderSplitPos('AB日C', 4, false), 3);
    });

    it('includes multiple wide chars that fit', () => {
        // '日本語' at width 4: 日(2)+本(2) = 4 → string index 2
        assert.equal(renderSplitPos('日本語', 4, false), 2);
    });

    it('snaps before second wide char when only one fits', () => {
        // '日本語' at width 3: 日(2)=2, adding 本 would give 4 > 3 → snap after 日 = index 1
        assert.equal(renderSplitPos('日本語', 3, false), 1);
    });

    it('snaps before first wide char at width 1', () => {
        // width 1 cannot fit 日(2) → index 0
        assert.equal(renderSplitPos('日本', 1, false), 0);
    });

    it('strips ANSI escape sequences (pipeCodeSupport=false)', () => {
        const sgr = '\x1b[32m';
        // sgr(0) + 'AB'(2) + '日'(2) = 4 visible cols
        assert.equal(renderSplitPos(sgr + 'AB日C', 4, false), sgr.length + 3);
    });

    it('strips pipe codes when pipeCodeSupport=true', () => {
        // '|07AB日C': |07(0 vis) + A(1) + B(1) + 日(2) + C(1)
        // at width 4: |07 + A + B + 日 = 4 vis → index = 3 + 3 = 6
        assert.equal(renderSplitPos('|07AB日C', 4, true), 6);
    });

    it('snaps before wide char even with leading pipe code (pipeCodeSupport=true)', () => {
        // '|07AB日': snap at width 3 → |07(0)+A(1)+B(1) = 2 vis → snap before 日
        // string index = 3 (pipe code) + 2 (AB) = 5
        assert.equal(renderSplitPos('|07AB日', 3, true), 5);
    });

    it('ANSI cursor-forward contributes its count to width', () => {
        const fwd3 = '\x1b[3C'; // cursor forward 3
        // fwd3(+3 vis) + 'AB'(+2 vis) = 5 vis; at width 4 → snap after fwd3+A = 4 vis
        const pos = renderSplitPos(fwd3 + 'AB', 4, false);
        assert.equal(pos, fwd3.length + 1); // fwd3 chars + 'A'
    });
});
