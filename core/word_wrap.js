/* jslint node: true */
'use strict';

const { ansiRenderStringLength } = require('./string_util');

//  deps
const assert = require('assert');
const _ = require('lodash');

exports.wordWrapText = wordWrapText;

const SPACE_CHARS = [
    ' ',
    '\f',
    '\n',
    '\r',
    '\v',
    '​\u00a0',
    '\u1680',
    '​\u180e',
    '\u2000​',
    '\u2001',
    '\u2002',
    '​\u2003',
    '\u2004',
    '\u2005',
    '\u2006​',
    '\u2007',
    '\u2008​',
    '\u2009',
    '\u200a​',
    '\u2028',
    '\u2029​',
    '\u202f',
    '\u205f​',
    '\u3000',
];

const REGEXP_WORD_WRAP = new RegExp(`\t|[${SPACE_CHARS.join('')}]`, 'g');

function wordWrapText(text, options) {
    assert(_.isObject(options));
    assert(_.isNumber(options.width));

    options.tabHandling = options.tabHandling || 'expand';
    options.tabWidth = options.tabWidth || 4;
    options.tabChar = options.tabChar || ' ';

    //const REGEXP_GOBBLE = new RegExp(`.{0,${options.width}}`, 'g');
    //
    //  For a given word, match 0->options.width chars -- always include a full trailing ESC
    //  sequence if present!
    //
    //  :TODO: Need to create ansi.getMatchRegex or something - this is used all over
    const REGEXP_GOBBLE = new RegExp(
        `.{0,${options.width}}\\x1b\\[[\\?=;0-9]*[ABCDEFGHJKLMSTfhlmnprsu]|.{0,${options.width}}`,
        'g'
    );

    let m;
    let word;
    let c;
    let renderLen;
    let i = 0;
    let wordStart = 0;
    let result = { wrapped: [''], renderLen: [0] };

    function expandTab(column) {
        const remainWidth = options.tabWidth - (column % options.tabWidth);
        return new Array(remainWidth).join(options.tabChar);
    }

    function appendWord() {
        word.match(REGEXP_GOBBLE).forEach(w => {
            renderLen = ansiRenderStringLength(w);

            if (result.renderLen[i] + renderLen > options.width) {
                if (0 === i) {
                    result.firstWrapRange = {
                        start: wordStart,
                        end: wordStart + w.length,
                    };
                }

                result.wrapped[++i] = w;
                result.renderLen[i] = renderLen;
            } else {
                result.wrapped[i] += w;
                result.renderLen[i] = (result.renderLen[i] || 0) + renderLen;
            }
        });
    }

    //
    //  Some of the way we word wrap is modeled after Sublime Test 3:
    //
    //  *   Sublime Text 3 for example considers spaces after a word
    //      part of said word. For example, "word    " would be wraped
    //      in it's entirety.
    //
    //  *   Tabs in Sublime Text 3 are also treated as a word, so, e.g.
    //      "\t" may resolve to "      " and must fit within the space.
    //
    //  *   If a word is ultimately too long to fit, break it up until it does.
    //
    while (null !== (m = REGEXP_WORD_WRAP.exec(text))) {
        word = text.substring(wordStart, REGEXP_WORD_WRAP.lastIndex - 1);

        c = m[0].charAt(0);
        if (SPACE_CHARS.indexOf(c) > -1) {
            word += m[0];
        } else if ('\t' === c) {
            if ('expand' === options.tabHandling) {
                //  Good info here: http://c-for-dummies.com/blog/?p=424
                word +=
                    expandTab(result.wrapped[i].length + word.length) + options.tabChar;
            } else {
                word += m[0];
            }
        }

        appendWord();
        wordStart = REGEXP_WORD_WRAP.lastIndex + m[0].length - 1;
    }

    word = text.substring(wordStart);
    appendWord();

    return result;
}
