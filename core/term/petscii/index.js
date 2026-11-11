/* jslint node: true */
'use strict';

//
//  The PETSCII base emulation (#593): Commodore 64 / 128 terminals, and
//  SyncTERM or IcyTerm in their C64 modes. See ../emulation.js for the parts.
//
//  ENiGMA stays ANSI inside. For a PETSCII session:
//
//  * the codec turns text into UTF-8, an in-process intermediate that never
//    reaches the wire;
//  * the output translator turns that UTF-8 text and the ANSI sequences
//    around it into PETSCII bytes (./output_translator.js);
//  * the input decoder turns PETSCII key bytes into the key presses the rest
//    of the system already understands (./input_decoder.js).
//
//  No ENiGMA imports here or in the files beside this one.
//
const { createPetsciiInputDecoder } = require('./input_decoder.js');
const { createPetsciiTranslator, MAX_COLS, MAX_ROWS } = require('./output_translator.js');

const DEFAULT_COLS = 40;
const DEFAULT_ROWS = 25;

//
//  The session's output encoding name. It is the only one this emulation
//  accepts, so nothing that sets an encoding by terminal type, configuration
//  or menu can switch a PETSCII session to CP437 or UTF-8 output.
//
const ENCODING = 'petscii';

const codec = {
    encodingExists(encoding) {
        return ENCODING === encoding;
    },

    //  text for the output translator: UTF-8, whatever |encoding| says
    encode(text) {
        return Buffer.isBuffer(text) ? text : Buffer.from(String(text), 'utf8');
    },

    decode(bytes) {
        return Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
    },
};

//
//  A PETSCII terminal answers no queries, so nothing is asked of it. The one
//  connect-time step is settling the screen size: what the terminal reported
//  (telnet NAWS, SSH pty-req), else 40x25, and telling the output translator,
//  which positions the cursor by counting from the home position.
//
const probes = [
    {
        name: 'settleScreenSize',
        run(client, callback) {
            const term = client.term;

            //
            //  The size is the caller's claim (NAWS allows up to 65535 each
            //  way). Anything that is not a plausible screen is replaced by
            //  the default, and a large one is cut to what the translator
            //  will accept, so the views and the translator agree.
            //
            const plausible = n => Number.isInteger(n) && n >= 2;
            if (!plausible(term.termWidth) || !plausible(term.termHeight)) {
                term.termWidth = DEFAULT_COLS;
                term.termHeight = DEFAULT_ROWS;
            }
            term.termWidth = Math.min(term.termWidth, MAX_COLS);
            term.termHeight = Math.min(term.termHeight, MAX_ROWS);

            const translator = term.emulation.outputTranslator;
            if (translator && 'function' === typeof translator.setSize) {
                translator.setSize(term.termWidth, term.termHeight);
            }
            return callback(null);
        },
    },
];

//
//  Art types: native '.seq' art first. Where a name has no '.seq', the ANSI
//  types as for a non-UTF-8 ANSI terminal, translated: a board with no
//  PETSCII art still shows something. (Only callers that can show native art
//  are offered '.seq' at all; see core/art.js.)
//
function artTypes() {
    return { preferred: [['.seq']], last: ['.utf8ans'] };
}

module.exports = {
    name: 'petscii',
    acceptsLayers: false,
    encoding: ENCODING,
    probes,
    createInputDecoder: createPetsciiInputDecoder,
    createOutputTranslator: () =>
        createPetsciiTranslator({ cols: DEFAULT_COLS, rows: DEFAULT_ROWS }),
    codec,
    supports: () => false,
    defaults: {
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        artTypes,
    },
};
