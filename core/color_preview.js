'use strict';

//
//  The editors' live colour preview, shared by EditTextView and
//  MultiLineEditTextView. Only complete |## codes are colour; the code next
//  to the cursor can be shown as typed (expanded) while the rest are drawn
//  as their colour only. Which code is shown, and when it collapses, is each
//  editor's own state; this module only answers questions about the text.
//

const { colorCodeAt, indexOfColorCode, pipeColorSgr } = require('./pipe_codes.js');

const isDigit = c => c >= 48 && c <= 57;

//  A '|' or '|' + digit at the end of |s|: a code still being typed.
function endsWithPartialColorCode(s) {
    const n = s.length;
    if (n > 0 && 124 === s.charCodeAt(n - 1)) {
        return true;
    }
    return n > 1 && 124 === s.charCodeAt(n - 2) && isDigit(s.charCodeAt(n - 1));
}

//  A complete code anywhere, or one being typed at the end.
function hasColorCodeOrPartial(s) {
    return -1 !== indexOfColorCode(s, 0) || endsWithPartialColorCode(s);
}

//  Where the code just before |col| starts: a complete |## ending at col,
//  else a '|' + digit, else a '|'; -1 when there is none.
function codeStartNearCursor(chars, col) {
    if (col >= 3 && colorCodeAt(chars, col - 3) >= 0) {
        return col - 3;
    }
    if (
        col >= 2 &&
        124 === chars.charCodeAt(col - 2) &&
        isDigit(chars.charCodeAt(col - 1))
    ) {
        return col - 2;
    }
    if (col >= 1 && 124 === chars.charCodeAt(col - 1)) {
        return col - 1;
    }
    return -1;
}

//  A complete |## ends at |col|.
function cursorNearCompleteCode(chars, col) {
    return col >= 3 && colorCodeAt(chars, col - 3) >= 0;
}

//
//  |s| with every complete code drawn as its colour, except the one at
//  |nearIdx|, which is drawn in its colour followed by the code as typed.
//  Text after the last complete code that starts with '|' (a code being
//  typed) gets |partialSgr| in front when it starts at |nearIdx|.
//
function renderExpanded(s, nearIdx, partialSgr) {
    let out = '';
    let last = 0;
    for (let i = indexOfColorCode(s, 0); -1 !== i; i = indexOfColorCode(s, last)) {
        const sgr = pipeColorSgr(colorCodeAt(s, i));
        out += s.slice(last, i) + (i === nearIdx ? sgr + s.slice(i, i + 3) : sgr);
        last = i + 3;
    }
    if (last < s.length) {
        const tail = s.slice(last);
        out += 124 === tail.charCodeAt(0) && last === nearIdx ? partialSgr + tail : tail;
    }
    return out;
}

exports.endsWithPartialColorCode = endsWithPartialColorCode;
exports.hasColorCodeOrPartial = hasColorCodeOrPartial;
exports.codeStartNearCursor = codeStartNearCursor;
exports.cursorNearCompleteCode = cursorNearCompleteCode;
exports.renderExpanded = renderExpanded;
