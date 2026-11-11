/* jslint node: true */
'use strict';

//
//  The ANSI base emulation: ENiGMA's behaviour from before emulations existed,
//  gathered behind the component interface (see ../emulation.js).
//
const { probes, DEFAULT_COLS, DEFAULT_ROWS } = require('./probes.js');
const { createAnsiInputDecoder } = require('./input_decoder.js');
const { createIdentityTranslator } = require('../translators/identity.js');
const { createIconvCodec } = require('../codecs/iconv_codec.js');
const { CP437_TERM_ENCODING } = require('../../cp437.js');

//
//  What we actually hand iconv, keyed by the encoding name the rest of the
//  system sees. CP437 output goes through the BBS-aware variant so the glyphs
//  living under 0x20 survive instead of becoming '?' -- see core/cp437.js.
//
//  The name stays 'cp437' everywhere else on purpose: ACS "EC0" compares
//  against it literally, and setClientEncoding() assigns it straight from menu
//  form data.
//
const codec = createIconvCodec({ cp437: CP437_TERM_ENCODING });

//
//  Art types by output encoding: a UTF-8 terminal prefers '.utf8ans'. Any
//  other terminal cannot draw UTF-8, so '.utf8ans' is a last resort, used only
//  when it is the sole match. Every ANSI terminal accepts every type.
//
function artTypes(term) {
    if (term && 'utf8' === term.outputEncoding) {
        return { preferred: [['.utf8ans']] };
    }
    return { preferred: [], last: ['.utf8ans'] };
}

function supports(query, term) {
    const termClient = term.termClient;

    switch (query) {
        case 'vtx_audio':
            //  https://github.com/codewar65/VTX_ClientServer/blob/master/vtx.txt
            return 'vtx' === termClient;

        case 'osc8_hyperlink':
            //  OSC 8 clickable hyperlink support
            //  cterm/SyncTERM, enig-term: confirmed via active capability
            //  query (CSI = 6 n); never assumed from the client name
            //  IcyTerm: confirmed via DA response + feature documentation
            //  VTX: uses xterm.js which supports OSC 8
            //  *nix xterm-class: broad support
            if (term.termCapabilities.osc8) return true;
            if ('icy_term' === termClient) return true;
            if ('vtx' === termClient) return true;
            return term.isNixTerm();

        default:
            return false;
    }
}

module.exports = {
    name: 'ansi',
    acceptsLayers: true,
    probes,
    createInputDecoder: createAnsiInputDecoder,
    createOutputTranslator: createIdentityTranslator,
    codec,
    supports,
    defaults: {
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        artTypes,
    },
};
