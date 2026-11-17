/* jslint node: true */
'use strict';

const PipeCodes = require('./pipe_codes.js');

//  Loaded for its side effect: predefined_mci.js registers its MCI resolver
//  with pipe_codes.js, which is how |UN and friends resolve below.
require('./predefined_mci.js');

exports.stripMciColorCodes = stripMciColorCodes;
exports.pipeStringLength = pipeStringLength;
exports.pipeToAnsi = exports.renegadeToAnsi = renegadeToAnsi;
exports.controlCodesToAnsi = controlCodesToAnsi;

//  Convert a two-digit Renegade/ENiGMA pipe color code (as an integer 0-31) to
//  an ANSI SGR escape sequence.  Exposed for live pipe-code rendering in MLTEV.
exports.pipeColorToAnsi = PipeCodes.pipeColorSgr;

//  :TODO: Not really happy with the module name of "color_codes". Would like something better ... control_code_string?

//
//  Remove the pipe codes pipeToAnsi() would consume: colours, cursor codes
//  (|CF05 becomes five spaces) and known MCI codes. An unknown |XY stays, as
//  it shows literally. The result can be rendered again (achievement titles
//  are): "||" stays "||", and a pipe the removal would turn into a code is
//  escaped.
//
const STRIP_RERENDER = { rerender: true };

function stripMciColorCodes(s) {
    return PipeCodes.strip(s, STRIP_RERENDER);
}

//  Display columns of |s| as pipeToAnsi() without a client would draw it.
function pipeStringLength(s) {
    return PipeCodes.width(s);
}

//
//  Renegade/ENiGMA pipe codes (|##, |AA MCI, |C[FBUD]##, ||) to ANSI. See
//  pipe_codes.js for the grammar. Without a client, MCI and cursor codes
//  are shown literally.
//
function renegadeToAnsi(s, client) {
    return PipeCodes.render(s, client ? { client } : undefined);
}

//
//  Converts various control codes popular in BBS packages
//  to ANSI escape sequences. Additionally supports ENiGMA style
//  MCI codes.
//
//  Supported control code formats:
//  * Renegade      : |##
//  * PCBoard       : @X## where the first number/char is BG color, and second is FG
//  * WildCat!      : @##@ the same as PCBoard without the X prefix, but with a @ suffix
//  * WWIV          : ^#
//  * CNET Control-Y: AKA Y-Style -- 0x19## where ## is a specific set of codes (older format)
//  * CNET Control-Q: AKA Q-style -- 0x11##} where ## is a specific set of codes (newer format)
//
//  TODO: Add Synchronet and Celerity format support
//
//  Resources:
//  * http://wiki.synchro.net/custom:colors
//  * https://archive.org/stream/C-Net_Pro_3.0_1994_Perspective_Software/C-Net_Pro_3.0_1994_Perspective_Software_djvu.txt
//
//  Pipe codes follow the UI grammar minus the "||" escape (as on Renegade,
//  Synchronet and Mystic, "||05" is "|" then colour 05): |1A is text, and
//  |C[FBUD]## moves the cursor when a client resolves it.
//
const BODY = { dialect: 'body' };

function controlCodesToAnsi(s, client) {
    if (!s || 'string' !== typeof s) {
        return s; //  as it always has: a number or other non-string comes back as is
    }
    return PipeCodes.render(s, client ? { dialect: 'body', client } : BODY);
}
