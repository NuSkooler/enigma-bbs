/* jslint node: true */
'use strict';

const { renderStringLength, ansiRenderStringLength } = require('./string_util');

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
const REGEXP_LINE_TERM = /[\n\r\u2028\u2029]/g;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function wordWrapText(text, options) {
    assert(_.isObject(options));
    assert(_.isNumber(options.width));

    options.tabHandling = options.tabHandling || 'expand';
    options.tabWidth = options.tabWidth || 4;
    options.tabChar = options.tabChar || ' ';

    const lenFunc = options.pipeCodeSupport ? renderStringLength : ansiRenderStringLength;

    //  ESC sequences and (with pipeCodeSupport) pipe codes are kept whole when
    //  a word is broken.
    //
    //  :TODO: Need to create ansi.getMatchRegex or something - this is used all over
    const pipeCode = options.pipeCodeSupport ? '|\\|[A-Z\\d]{2}' : '';
    const REGEXP_CODE = new RegExp(
        `(\\x1b\\[[\\?=;0-9]*[ABCDEFGHJKLMSTfhlmnprsu]${pipeCode})`
    );

    //
    //  Breaks a word into pieces of at most |width| columns. A piece ends
    //  between ESC sequences, pipe codes or grapheme clusters, never inside
    //  one: a surrogate pair, a flag, an emoji and its modifiers or a letter
    //  and its combining marks stay together. A single cluster wider than
    //  |width| gets a piece of its own. Line terminators are dropped.
    //
    function splitToWidth(word) {
        //  Most words fit: no need to segment them
        if (lenFunc(word) <= options.width) {
            return [word.replace(REGEXP_LINE_TERM, '')];
        }

        const pieces = [''];
        let pieceLen = 0;

        word.split(REGEXP_CODE).forEach((part, index) => {
            //  split() puts the captured codes at the odd indexes
            const tokens =
                index % 2
                    ? [part]
                    : Array.from(
                          GRAPHEMES.segment(part.replace(REGEXP_LINE_TERM, '')),
                          s => s.segment
                      );

            for (const token of tokens) {
                const tokenLen = lenFunc(token);
                if (pieceLen > 0 && pieceLen + tokenLen > options.width) {
                    pieces.push('');
                    pieceLen = 0;
                }
                pieces[pieces.length - 1] += token;
                pieceLen += tokenLen;
            }
        });

        return pieces;
    }

    let m;
    let word;
    let c;
    let renderLen;
    let i = 0;
    let wordStart = 0;
    let lastColorCode = '';
    let result = { wrapped: [''], renderLen: [0] };

    function expandTab(column) {
        const remainWidth = options.tabWidth - (column % options.tabWidth);
        return new Array(remainWidth).join(options.tabChar);
    }

    function appendWord() {
        splitToWidth(word).forEach(w => {
            renderLen = lenFunc(w);

            //  A piece wider than the width (one wide cluster) still goes on
            //  an empty line rather than leaving it blank
            if (
                result.renderLen[i] > 0 &&
                result.renderLen[i] + renderLen > options.width
            ) {
                if (0 === i) {
                    result.firstWrapRange = {
                        start: wordStart,
                        end: wordStart + w.length,
                    };
                }

                const prefix =
                    options.pipeCodeSupport && lastColorCode ? lastColorCode : '';
                result.wrapped[++i] = prefix + w;
                result.renderLen[i] = renderLen;
            } else {
                result.wrapped[i] += w;
                result.renderLen[i] = (result.renderLen[i] || 0) + renderLen;
            }

            //  Track last active numeric pipe colour code so continuation lines
            //  inherit the correct colour when pipeCodeSupport is enabled.
            if (options.pipeCodeSupport) {
                const codes = w.match(/\|[0-9]{2}/g);
                if (codes) {
                    lastColorCode = codes[codes.length - 1];
                }
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
                    expandTab(lenFunc(result.wrapped[i]) + lenFunc(word)) +
                    options.tabChar;
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
