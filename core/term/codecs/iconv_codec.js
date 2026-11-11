/* jslint node: true */
'use strict';

//
//  A glyph codec backed by iconv-lite. No ENiGMA imports.
//
//  |aliases| maps the encoding name the rest of the system uses to the name
//  handed to iconv, for the cases where they differ (the ANSI emulation sends
//  'cp437' through the BBS-aware CP437 variant).
//
const iconv = require('iconv-lite');

function createIconvCodec(aliases = {}) {
    const resolve = encoding => aliases[encoding] || encoding;

    return {
        //  true when |encoding| can be used as a terminal's output encoding
        encodingExists(encoding) {
            return iconv.encodingExists(encoding);
        },

        //  |text| (a string) as the bytes a terminal in |encoding| expects
        encode(text, encoding) {
            return iconv.encode(text, resolve(encoding));
        },

        //  the reverse of encode()
        decode(bytes, encoding) {
            return iconv.decode(bytes, resolve(encoding));
        },
    };
}

module.exports = { createIconvCodec };
