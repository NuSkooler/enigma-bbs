'use strict';

const { strict: assert } = require('assert');

const { TickerView } = require('../core/ticker_view.js');
const { stylizePlainText, stylizePlainTextPieces } = require('../core/string_util.js');
const { pipeToAnsi } = require('../core/color_codes.js');

//
//  A ticker keeps one colour per character of its text (_charColors) so pipe
//  colours survive scrolling. A text style that changes the text's length
//  ('upper' turns 'ß' into 'SS') used to shift every colour after it (#1063).
//

const C14 = pipeToAnsi('|14');
const C07 = pipeToAnsi('|07');
const C11 = pipeToAnsi('|11');
const C03 = pipeToAnsi('|03');

function makeClient() {
    return {
        term: {
            termWidth: 80,
            termHeight: 25,
            write: () => {},
            rawWrite: () => {},
        },
    };
}

describe('TickerView text-style effects keep each character its colour', () => {
    let saved;
    before(() => {
        saved = { setInterval: global.setInterval, clearInterval: global.clearInterval };
        global.setInterval = () => 1;
        global.clearInterval = () => {};
    });
    after(() => {
        global.setInterval = saved.setInterval;
        global.clearInterval = saved.clearInterval;
    });

    function makeTicker(text, effect) {
        return new TickerView({
            client: makeClient(),
            id: 1,
            position: { row: 1, col: 1 },
            dimens: { width: 20, height: 1 },
            text,
            effect,
            motion: 'typewriter',
        });
    }

    //  the colour of each character, as a string per character for diffs
    function colorsOf(view) {
        assert.equal(
            view._charColors.length,
            view._plainText.length,
            'one colour per character'
        );
        return view._charColors;
    }

    it("upper on '|14ßa|07b' gives SSAB with B still |07 (the issue's repro)", () => {
        const view = makeTicker('|14ßa|07b', 'upper');
        assert.equal(view._plainText, 'SSAB');
        assert.deepEqual(colorsOf(view), [C14, C14, C14, C07]);

        //  and that is what is drawn: B in |07, not the view's own SGR
        const drawn = view._applyEffect('SSAB', 0);
        assert.ok(drawn.includes(`${C14}SSA${C07}B`), JSON.stringify(drawn));
    });

    it("lower on '|14İ|07x' keeps x in |07 though İ becomes two units", () => {
        const view = makeTicker('|14İ|07x', 'lower');
        assert.equal(view._plainText, 'i̇x');
        assert.deepEqual(colorsOf(view), [C14, C14, C07]);
    });

    it('title across a mid-word colour change is still one word', () => {
        const view = makeTicker('|11s|03MASH |11y|03OUR', 'title');
        assert.equal(view._plainText, 'Smash Your');
        assert.deepEqual(colorsOf(view), [
            C11,
            C03,
            C03,
            C03,
            C03,
            C03,
            C11,
            C03,
            C03,
            C03,
        ]);
    });

    it('a surrogate pair takes one colour for both its units', () => {
        const view = makeTicker('|14\u{10428}|07x', 'upper');
        assert.equal(view._plainText, '\u{10400}X');
        assert.deepEqual(colorsOf(view), [C14, C14, C07]);
    });

    describe('surrogate pairs beside colour changes, with a style that grows text', () => {
        //  Deseret small long I (U+10428) upper cases to U+10400: two units
        //  each, its piece on the first unit and '' on the second. 'ß' upper
        //  is 'SS'. Each output unit is checked against the source
        //  character it came from.
        const PAIR = '\u{10428}';
        const PAIR_UP = '\u{10400}';

        function assertColors(view, expected) {
            const colors = colorsOf(view);
            assert.equal(colors.length, expected.length, 'colour map length');
            expected.forEach((c, i) => {
                assert.equal(
                    colors[i],
                    c,
                    `unit ${i} of ${JSON.stringify(view._plainText)}`
                );
            });
        }

        it('pair then a growing character, both in one colour, then another', () => {
            const view = makeTicker(`|14${PAIR}ß|07x`, 'upper');
            assert.equal(view._plainText, `${PAIR_UP}SSX`);
            assert.equal(view._plainText.length, 5);
            assertColors(view, [C14, C14, C14, C14, C07]);
        });

        it('a colour change on each side of the pair', () => {
            const view = makeTicker(`|14ß|07${PAIR}|11x`, 'upper');
            assert.equal(view._plainText, `SS${PAIR_UP}X`);
            assertColors(view, [C14, C14, C07, C07, C11]);
        });

        it('pair, growing character and pair, each in its own colour', () => {
            const view = makeTicker(`|11${PAIR}|14ß|07${PAIR}y`, 'upper');
            assert.equal(view._plainText, `${PAIR_UP}SS${PAIR_UP}Y`);
            assertColors(view, [C11, C11, C14, C14, C07, C07, C07]);
        });

        it('the pieces behind it: the pair on its first unit, then ""', () => {
            assert.deepEqual(stylizePlainTextPieces(`${PAIR}ß`, 'upper'), [
                PAIR_UP,
                '',
                'SS',
            ]);
        });
    });

    it('setting the effect after setText() rebuilds the colours too', () => {
        const view = makeTicker('|14ßa|07b', 'normal');
        assert.equal(view._plainText, 'ßab');
        assert.deepEqual(colorsOf(view), [C14, C14, C07]);

        view.setPropertyValue('effect', 'upper');
        assert.equal(view._plainText, 'SSAB');
        assert.deepEqual(colorsOf(view), [C14, C14, C14, C07]);

        //  and back to a dynamic effect: the text is unstyled again
        view.setPropertyValue('effect', 'rainbow');
        assert.equal(view._plainText, 'ßab');
        assert.deepEqual(colorsOf(view), [C14, C14, C07]);
    });

    it('textStyle (the alias) does the same', () => {
        const view = makeTicker('|14ßa|07b', 'normal');
        view.setPropertyValue('textStyle', 'upper');
        assert.equal(view._plainText, 'SSAB');
        assert.deepEqual(colorsOf(view), [C14, C14, C14, C07]);
    });

    it('mixed lines colours up whatever the random draws', () => {
        //  upper and lower of ß, ŉ and ﬁ differ in length
        for (let n = 0; n < 50; ++n) {
            const view = makeTicker('|14ßŉﬁ|07zz', 'mixed');
            const colors = colorsOf(view);
            assert.equal(colors[colors.length - 1], C07);
            assert.equal(colors[colors.length - 2], C07);
            assert.ok(colors.slice(0, -2).every(c => c === C14));
            assert.equal(view._plainText.slice(-2).toLowerCase(), 'zz');
        }
    });

    it('text without pipe colours keeps an empty colour map', () => {
        const view = makeTicker('straße', 'upper');
        assert.equal(view._plainText, 'STRASSE');
        assert.deepEqual(view._charColors, []);
    });

    describe('every documented text-style effect styles the text', () => {
        //  the ticker's camelCase names, and stylizeString()'s spelling
        const NAMES = {
            firstLower: 'first lower',
            smallVowels: 'small vowels',
            bigVowels: 'big vowels',
            smallI: 'small i',
        };
        const TEXT = 'hello big Island';

        for (const [name, style] of Object.entries(NAMES)) {
            it(`${name} and '${style}'`, () => {
                const expected = stylizePlainText(TEXT, style);
                assert.notEqual(expected, TEXT, 'precondition: the style changes it');
                assert.equal(makeTicker(TEXT, name)._plainText, expected);
                assert.equal(makeTicker(TEXT, style)._plainText, expected);
            });
        }

        it('firstLower across a mid-word colour change', () => {
            const view = makeTicker('|11S|03mash', 'firstLower');
            assert.equal(view._plainText, 'sMASH');
            assert.deepEqual(colorsOf(view), [C11, C03, C03, C03, C03]);
        });

        it('firstLower growing a character mid-word keeps later colours', () => {
            //  the rest of the word is upper cased, and 'ŉ' upper is two units
            const view = makeTicker('|11a|03ŉb|07c', 'firstLower');
            assert.equal(view._plainText, 'aʼNBC');
            assert.deepEqual(colorsOf(view), [C11, C03, C03, C03, C07]);
        });

        it("smallI: 'ﬁ' becomes 'Fi' and keeps its colour", () => {
            const view = makeTicker('|14ﬁ|07x', 'smallI');
            assert.equal(view._plainText, 'FiX');
            assert.deepEqual(colorsOf(view), [C14, C14, C07]);
        });
    });
});

describe('stylizePlainTextPieces()', () => {
    const CORPUS = [
        '',
        'hello world',
        'smash your keyboard!',
        'ßa b',
        'ŉ ﬁne ﬂow ﬃ ﬄ ﬅ',
        'İstanbul İ',
        'ΟΔΟΣ ΣΟΦΟΣ σ αΣ.Σβ',
        '|pipe| ||text',
        'a\u{10428}b \u{10400}x',
        'x\uD800y lone surrogate',
        '  lead_trail  ',
        'über straße ǅ ǈ',
        '123 abc_DEF-ghi',
        'MiXeD CaSe AEIOU aeiou',
    ];

    const DETERMINISTIC = [
        'normal',
        'N',
        'upper',
        'U',
        'lower',
        'l',
        'title',
        'T',
        'first lower',
        'f',
        'small vowels',
        'v',
        'big vowels',
        'V',
        'small i',
        'i',
        'l33t',
        '3',
        'not a style',
    ];

    for (const style of DETERMINISTIC) {
        it(`'${style}': pieces join to stylizePlainText(), one per unit`, () => {
            for (const s of CORPUS) {
                const pieces = stylizePlainTextPieces(s, style);
                assert.equal(pieces.length, s.length, JSON.stringify(s));
                assert.equal(
                    pieces.join(''),
                    stylizePlainText(s, style),
                    JSON.stringify(s)
                );
            }
        });
    }

    it("'mixed': one piece per unit, each the upper or lower of its unit", () => {
        for (const s of CORPUS) {
            const pieces = stylizePlainTextPieces(s, 'mixed');
            assert.equal(pieces.length, s.length);
            pieces.forEach((p, i) => {
                assert.ok(p === s[i].toUpperCase() || p === s[i].toLowerCase());
            });
        }
    });

    it('gives each character what it becomes', () => {
        assert.deepEqual(stylizePlainTextPieces('ßab', 'upper'), ['SS', 'A', 'B']);
        assert.deepEqual(stylizePlainTextPieces('a\u{10428}', 'upper'), [
            'A',
            '\u{10400}',
            '',
        ]);
        //  final sigma comes out as it does for the whole string
        assert.deepEqual(stylizePlainTextPieces('ΟΣ', 'lower'), ['ο', 'ς']);
    });
});
