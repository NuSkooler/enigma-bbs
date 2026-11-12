/* jslint node: true */
'use strict';

//
//  MRC chat can show ":)" and ":D" as the CP437 smiley glyphs, which are the
//  bytes 0x01 and 0x02.
//
//  A RIPscrip terminal reads those two bytes as the start of a RIP command
//  wherever they turn up in a line, and the text that follows them here was
//  written by someone else on the MRC network. So a session whose terminal
//  does RIPscrip (#989) keeps the smilies as they were typed.
//
function glyphSmiliesAllowed(userPrefs, client) {
    if (!userPrefs || !userPrefs.showSmilies) {
        return false;
    }
    return !(client && client.terminalSupports && client.terminalSupports('rip'));
}

function smiliesToGlyphs(text) {
    return text.replace(/:D/g, '\x02').replace(/=\)/g, '\x02').replace(/:\)/g, '\x01');
}

exports.glyphSmiliesAllowed = glyphSmiliesAllowed;
exports.smiliesToGlyphs = smiliesToGlyphs;
