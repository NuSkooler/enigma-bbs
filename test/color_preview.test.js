'use strict';

const { strict: assert } = require('assert');

const ColorPreview = require('../core/color_preview.js');
const PipeCodes = require('../core/pipe_codes.js');

//  mulberry32
function prng(seed) {
    return n => {
        seed = (seed + 0x6d2b79f5) >>> 0;
        let t = seed;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
    };
}

//  The editors' hand-written regex versions, as they were before they moved
//  onto pipe_codes.js: the shared helpers must give the same results.
const OLD = {
    isPipeCode(chars, i) {
        return (
            chars[i] === '|' &&
            i + 2 < chars.length &&
            chars[i + 1] >= '0' &&
            chars[i + 1] <= '9' &&
            chars[i + 2] >= '0' &&
            chars[i + 2] <= '9'
        );
    },
    hasCode: s => /\|[0-9]{2}/.test(s),
    hasCodeOrPartial: s => /\|[0-9]{2}/.test(s) || /\|[0-9]?$/.test(s),
    strip: s => s.replace(/\|[0-9]{2}/g, ''),
    collapsed: s =>
        s.replace(/\|([0-9]{2})/g, (_, code) =>
            PipeCodes.pipeColorSgr(parseInt(code, 10))
        ),
    codeStartNearCursor(chars, col) {
        if (col >= 3 && OLD.isPipeCode(chars, col - 3)) return col - 3;
        if (
            col >= 2 &&
            chars[col - 2] === '|' &&
            chars[col - 1] >= '0' &&
            chars[col - 1] <= '9'
        )
            return col - 2;
        if (col >= 1 && chars[col - 1] === '|') return col - 1;
        return -1;
    },
    expanded(s, nearIdx, partialSgr) {
        const PIPE_RE = /\|([0-9]{2})/g;
        let m;
        let rendered = '';
        let lastIndex = 0;
        while ((m = PIPE_RE.exec(s)) !== null) {
            rendered += s.slice(lastIndex, m.index);
            const sgr = PipeCodes.pipeColorSgr(parseInt(m[1], 10));
            rendered += m.index === nearIdx ? sgr + m[0] : sgr;
            lastIndex = PIPE_RE.lastIndex;
        }
        const tail = s.slice(lastIndex);
        if (tail) {
            rendered +=
                tail[0] === '|' && lastIndex === nearIdx ? partialSgr + tail : tail;
        }
        return rendered;
    },
};

describe("color_preview (the editors' live colour helpers)", () => {
    it('partial codes', () => {
        assert.deepEqual(
            ['|', 'ab|', 'ab|0', '|0', 'ab|0x', 'ab|07', '', 'x'].map(
                ColorPreview.endsWithPartialColorCode
            ),
            [true, true, true, true, false, false, false, false]
        );
    });

    it('give what the regex versions gave (seeded)', () => {
        const rnd = prng(1022);
        const CS = [
            '|',
            '|',
            '|',
            '0',
            '7',
            '1',
            '9',
            'a',
            'U',
            ' ',
            '日',
            '\ud800',
            '\x1b',
        ];
        const PARTIAL = '<P>';
        for (let k = 0; k < 20000; ++k) {
            let s = '';
            for (let j = rnd(12); j > 0; --j) {
                s += CS[rnd(CS.length)];
            }
            const why = JSON.stringify(s);
            assert.equal(-1 !== PipeCodes.indexOfColorCode(s, 0), OLD.hasCode(s), why);
            assert.equal(
                ColorPreview.hasColorCodeOrPartial(s),
                OLD.hasCodeOrPartial(s),
                why
            );
            assert.equal(PipeCodes.strip(s, { dialect: 'color' }), OLD.strip(s), why);
            assert.equal(
                PipeCodes.render(s, { dialect: 'color' }),
                OLD.collapsed(s),
                why
            );
            for (let i = -1; i <= s.length + 1; ++i) {
                assert.equal(PipeCodes.colorCodeAt(s, i) >= 0, OLD.isPipeCode(s, i), why);
                assert.equal(
                    ColorPreview.codeStartNearCursor(s, i),
                    OLD.codeStartNearCursor(s, i),
                    why
                );
                assert.equal(
                    ColorPreview.cursorNearCompleteCode(s, i),
                    i >= 3 && OLD.isPipeCode(s, i - 3),
                    why
                );
                assert.equal(
                    ColorPreview.renderExpanded(s, i, PARTIAL),
                    OLD.expanded(s, i, PARTIAL),
                    why
                );
            }
        }
    });
});
