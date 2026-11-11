/* jslint node: true */
'use strict';

//
//  The output translator for a terminal that speaks what ENiGMA writes (ANSI):
//  everything goes to the wire exactly as given. No ENiGMA imports.
//
//  An output translator sees the final outbound stream, after encoding:
//
//      translate(data)     |data| (Buffer, or a string for the few callers
//                          that still write one) as what goes on the wire
//      passThrough(data)   told about bytes written around the translator
//                          (file transfers, bridges, raw doors) so that one
//                          that tracks cursor or attribute state knows it
//                          can no longer trust it. Returns nothing.
//
function createIdentityTranslator() {
    return {
        identity: true,
        translate(data) {
            return data;
        },
        passThrough() {},
    };
}

module.exports = { createIdentityTranslator };
