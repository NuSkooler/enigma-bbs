/* jslint node: true */
'use strict';

const { createRipOutputFilter } = require('./output_filter.js');

//
//  The RIPscrip layer (#989): an addition to the ANSI emulation for a
//  terminal that draws RIPscrip graphics (SyncTERM with RIP enabled for the
//  entry, IcyTerm in RIP mode). See ../emulation.js for what a layer is.
//
//  The layer says the terminal is there, filters what is sent to it so that
//  only RIP ENiGMA means to send is run (./output_filter.js), and makes
//  '.rip' art preferred (see core/art.js). Menus come later. Node built-ins
//  only; no ENiGMA imports.
//
//  DETECTION
//  ---------
//  Two ways, either one is enough:
//
//  * The terminal type: IcyTerm announces 'RIP' (see ../select.js).
//  * The version query below, sent to every ANSI session at connect (see
//    ../ansi/probes.js). A RIP terminal answers on the input stream as if
//    typed: 'RIPSCRIP' and six digits, e.g. RIPSCRIP015410 (RIPscrip 1.54,
//    SyncTERM, IcyTerm) or RIPSCRIP030001 (SyncTERM set to RIPscrip 3).
//    IcyTerm adds a NUL. SyncTERM with RIP off does not answer at all. A
//    reply within 30 seconds of the query is taken out of the input by
//    ./reply_scanner.js, so it never reaches a menu as keys; after that, or
//    once one reply has been taken, input is left alone.
//
//  THE QUERY
//  ---------
//  The RIPscrip spec's query is ESC [ ! (also ESC [ 0 !). To a terminal
//  that does not know RIP that is a control sequence that has not ended:
//  '!' is an intermediate byte, and the sequence waits for a final byte
//  (0x40-0x7E). What follows decides what the terminal does:
//
//  * a final byte ends it, and the terminal ignores CSI ! <final>. '_' is
//    what Synchronet has sent since v2 (answer.cpp: "\x1b[!_"). It is not
//    DECSTR (CSI ! p, a soft reset) nor anything else a terminal defines.
//  * anything else is worse. A C0 control (CR, LF) is run while the
//    sequence carries on, so the next letter is eaten as its final byte;
//    SyncTERM's older parser (1.2 to 1.9 at least) prints a broken sequence
//    as text (ESC [ !), even when the next byte is ESC; IcyTerm in ANSI mode
//    drops the next byte, whatever it is.
//
//  A RIP terminal acts at the '!' (SyncTERM ripper.c, IcyTerm's RIP parser)
//  and then shows the '_' as text; so does any terminal whose parser takes
//  '!' itself as the final byte. The '_' is therefore drawn black on black,
//  as Synchronet does, then ESC [ 0 m resets the attributes. ENiGMA has set
//  no attributes of its own at that point in a session, and the screen is
//  cleared (with ESC [ 0 m again) once the probes are done.
//
//  Only the bare ESC [ ! and ESC [ 0 ! forms have been seen answered by
//  real SyncTERM and IcyTerm (2026-11-12); the form with '_' is read from
//  their sources. Change VERSION_QUERY to try another.
//
const VERSION_QUERY = '\x1b[!_';

//  What is sent: the query, its '_' hidden
const VERSION_PROBE = `\x1b[30;40m${VERSION_QUERY}\x1b[0m`;

//  What a reply starts with, and how many digits follow
const REPLY_PREFIX = 'RIPSCRIP';
const REPLY_DIGITS = 6;

const LAYER_NAME = 'rip';

//  The art type a RIP session prefers, ahead of what ANSI would get
const ART_TYPE = '.rip';

//
//  RIP_KILL_MOUSE_FIELDS: makes the terminal forget every mouse field
//  (button, click region) drawn so far. A clear screen (ESC[2J) removes the
//  drawing but leaves the fields live, invisible and clickable, on SyncTERM
//  and IcyTerm alike (seen 2026-11-12), so this goes out when a session
//  leaves a screen a '.rip' was shown on (see ClientTerminal's
//  leaveRipScreen()). A command runs only at the start of a line on every
//  terminal tested, hence the CR LF in front; the CR LF after it ends the
//  command and is taken by the terminal with it. This form was seen working.
//
//  ENiGMA never sends RIP_RESET_WINDOWS (!|*) or a text window (!|w): either
//  one makes SyncTERM 1.10a/1.10b stop sending keys for the rest of the call
//  (the screen rebuild loses its keystroke callback; upstream bug).
//
const RIP_KILL_MOUSE_FIELDS = '\r\n!|1K\r\n';

//
//  The major version a reply names: RIPSCRIP015410 -> 1, RIPSCRIP030001 -> 3;
//  undefined when |reply| is not one.
//
function majorVersionOf(reply) {
    if ('string' !== typeof reply || !reply.startsWith(REPLY_PREFIX)) {
        return undefined;
    }
    const digits = reply.slice(REPLY_PREFIX.length);
    if (!new RegExp(`^[0-9]{${REPLY_DIGITS}}$`).test(digits)) {
        return undefined;
    }
    return parseInt(digits.slice(0, 2), 10);
}

//
//  A layer for one client:
//
//      name            'rip'
//      version         what the terminal answered ('RIPSCRIP015410'), or
//                      undefined until it does (a terminal type alone says
//                      nothing about the version)
//      majorVersion    1, 3, ... from |version|
//      source          how it was first found: 'termType' | 'probe'
//      supports(q)     true for 'rip'
//      artTypes        '.rip' preferred over everything ANSI would get
//      mouseFieldsShown
//                      true once a '.rip' has been shown, until the session
//                      leaves that screen (see ClientTerminal's
//                      ripScreenShown() and leaveRipScreen())
//      createOutputFilter()
//                      the session's output filter (./output_filter.js),
//                      made by the emulation when the layer is attached
//
function createRipLayer({ version, source } = {}) {
    const layer = {
        name: LAYER_NAME,
        version: undefined,
        majorVersion: undefined,
        source,
        supports: query => LAYER_NAME === query,
        artTypes: { preferred: [[ART_TYPE]] },
        mouseFieldsShown: false,
        createOutputFilter: createRipOutputFilter,
        setVersion(reply) {
            const major = majorVersionOf(reply);
            if (undefined === major) {
                return false;
            }
            this.version = reply;
            this.majorVersion = major;
            return true;
        },
    };
    if (version) {
        layer.setVersion(version);
    }
    return layer;
}

module.exports = {
    LAYER_NAME,
    ART_TYPE,
    RIP_KILL_MOUSE_FIELDS,
    VERSION_QUERY,
    VERSION_PROBE,
    REPLY_PREFIX,
    REPLY_DIGITS,
    majorVersionOf,
    createRipLayer,
};
