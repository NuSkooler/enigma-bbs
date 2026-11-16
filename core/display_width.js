/* jslint node: true */
'use strict';

//
//  Terminal display width of characters and plain strings.
//
//  Kept in a module of its own, with no ENiGMA dependencies, so anything can
//  measure text -- string_util.js and pipe_codes.js both do -- without a
//  require cycle. string_util.js re-exports both functions.
//

//  deps
const wcwidth = require('wcwidth');

exports.charDisplayWidth = charDisplayWidth;
exports.strDisplayWidth = strDisplayWidth;

//
//  Returns the terminal display width (columns) of a single character: 0 for
//  combining/NUL, 1 for narrow, 2 for wide (CJK ideographs, Hangul, fullwidth
//  forms, etc.).  Uses wcwidth(3) semantics — the same algorithm used by
//  terminal emulators and ncurses.
//
function charDisplayWidth(ch) {
    const w = wcwidth(ch);
    return w < 0 ? 0 : w; //  wcwidth returns -1 for non-printable; treat as 0
}

//
//  Returns the total terminal display width of a plain string (no ANSI/pipe
//  codes — for already-stripped or literal text only).  Iterates by Unicode
//  codepoint so surrogate pairs (supplementary CJK, emoji) are handled correctly.
//
function strDisplayWidth(s) {
    let w = 0;
    for (const ch of s) {
        w += charDisplayWidth(ch);
    }
    return w;
}
