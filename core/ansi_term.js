/* jslint node: true */
'use strict';

//
//  ANSI Terminal Support Resources
//
//  ANSI-BBS
//      * http://ansi-bbs.org/
//
//  CTerm / SyncTERM
//      * https://github.com/protomouse/synchronet/blob/master/src/conio/cterm.txt
//
//  BananaCom
//      * http://www.bbsdocumentary.com/library/PROGRAMS/GRAPHICS/ANSI/bansi.txt
//
//  ANSI.SYS
//      * http://www.bbsdocumentary.com/library/PROGRAMS/GRAPHICS/ANSI/ansisys.txt
//      * http://academic.evergreen.edu/projects/biophysics/technotes/program/ansi_esc.htm
//
//  Modern Windows (Win10+)
//      * https://docs.microsoft.com/en-us/windows/console/console-virtual-terminal-sequences
//
//  VT100
//      * http://www.noah.org/python/pexpect/ANSI-X3.64.htm
//
//  VTX
//      * https://github.com/codewar65/VTX_ClientServer/blob/master/vtx.txt
//
//  General
//      * http://en.wikipedia.org/wiki/ANSI_escape_code
//      * http://www.inwap.com/pdp10/ansicode.txt
//      * Excellent information with many standards covered (for hterm):
//        https://chromium.googlesource.com/apps/libapps/+/master/hterm/doc/ControlSequences.md
//
//  Other Implementations
//      * https://github.com/chjj/term.js/blob/master/src/term.js
//
//
//  For a board, we need to support the semi-standard ANSI-BBS "spec" which
//  is bastardized mix of DOS ANSI.SYS, cterm.txt, bansi.txt and a little other.
//  This gives us NetRunner, SyncTERM, EtherTerm, most *nix terminals, compatibilitiy
//  with legit oldschool DOS terminals, and so on.
//

//  ENiGMA½
const miscUtil = require('./misc_util.js');

//  deps
const assert = require('assert');
const _ = require('lodash');

exports.getFullMatchRegExp = getFullMatchRegExp;
exports.getFGColorValue = getFGColorValue;
exports.getBGColorValue = getBGColorValue;
exports.sgr = sgr;
exports.getSGRFromGraphicRendition = getSGRFromGraphicRendition;
exports.clearScreen = clearScreen;
exports.resetScreen = resetScreen;
exports.normal = normal;
exports.goHome = goHome;
exports.disableVT100LineWrapping = disableVT100LineWrapping;
exports.setSyncTermFont = setSyncTermFont;
exports.getSyncTermFontFromAlias = getSyncTermFontFromAlias;
exports.setSyncTermFontWithAlias = setSyncTermFontWithAlias;
exports.setCursorStyle = setCursorStyle;
exports.setEmulatedBaudRate = setEmulatedBaudRate;
exports.vtxHyperlink = vtxHyperlink;

//
//  See also
//  https://github.com/TooTallNate/ansi.js/blob/master/lib/ansi.js

const ESC_CSI = '\u001b[';

const CONTROL = {
    up: 'A',
    down: 'B',

    forward: 'C',
    right: 'C',

    back: 'D',
    left: 'D',

    nextLine: 'E',
    prevLine: 'F',
    horizAbsolute: 'G',

    //
    //  CSI [ p1 ] J
    //  Erase in Page / Erase Data
    //  Defaults: p1 = 0
    //  Erases from the current screen according to the value of p1
    //  0 - Erase from the current position to the end of the screen.
    //  1 - Erase from the current position to the start of the screen.
    //  2 - Erase entire screen.  As a violation of ECMA-048, also moves
    //      the cursor to position 1/1 as a number of BBS programs assume
    //      this behaviour.
    //  Erased characters are set to the current attribute.
    //
    //  Support:
    //  * SyncTERM: Works as expected
    //  * NetRunner: Always clears a screen *height* (e.g. 25) regardless of p1
    //    and screen remainder
    //
    eraseData: 'J',

    eraseLine: 'K',
    insertLine: 'L',

    //
    //  CSI [ p1 ] M
    //  Delete Line(s) / "ANSI" Music
    //  Defaults: p1 = 1
    //  Deletes the current line and the p1 - 1 lines after it scrolling the
    //  first non-deleted line up to the current line and filling the newly
    //  empty lines at the end of the screen with the current attribute.
    //  If "ANSI" Music is fully enabled (CSI = 2 M), performs "ANSI" music
    //  instead.
    //  See "ANSI" MUSIC section for more details.
    //
    //  Support:
    //  * SyncTERM: Works as expected
    //  * NetRunner:
    //
    //  General Notes:
    //  See also notes in bansi.txt and cterm.txt about the various
    //  incompatibilities & oddities around this sequence. ANSI-BBS
    //  states that it *should* work with any value of p1.
    //
    deleteLine: 'M',
    ansiMusic: 'M',

    scrollUp: 'S',
    scrollDown: 'T',
    setScrollRegion: 'r',
    savePos: 's',
    restorePos: 'u',
    queryPos: '6n',
    queryScreenSize: '255n', //  See bansi.txt
    goto: 'H', //  row Pr, column Pc -- same as f
    gotoAlt: 'f', //  same as H

    blinkToBrightIntensity: '?33h',
    blinkNormal: '?33l',

    emulationSpeed: '*r', //  Set output emulation speed. See cterm.txt

    hideCursor: '?25l', //  Nonstandard - cterm.txt
    showCursor: '?25h', //  Nonstandard - cterm.txt

    queryDeviceAttributes: 'c', //  Nonstandard - cterm.txt

    //  :TODO: see https://code.google.com/p/conemu-maximus5/wiki/AnsiEscapeCodes
    //  apparently some terms can report screen size and text area via 18t and 19t
};

//
//  Select Graphics Rendition
//  See http://cvs.synchro.net/cgi-bin/viewcvs.cgi/*checkout*/src/conio/cterm.txt
//
const SGRValues = {
    reset: 0,
    bold: 1,
    dim: 2,
    blink: 5,
    fastBlink: 6,
    negative: 7,
    hidden: 8,

    normal: 22, //
    steady: 25,
    positive: 27,

    black: 30,
    red: 31,
    green: 32,
    yellow: 33,
    blue: 34,
    magenta: 35,
    cyan: 36,
    white: 37,

    blackBG: 40,
    redBG: 41,
    greenBG: 42,
    yellowBG: 43,
    blueBG: 44,
    magentaBG: 45,
    cyanBG: 46,
    whiteBG: 47,
};

function getFullMatchRegExp(flags = 'g') {
    //  :TODO: expand this a bit - see strip-ansi/etc.
    //  :TODO: \u009b ?
    return new RegExp(
        /[\u001b][[()#;?]*([0-9]{1,4}(?:;[0-9]{0,4})*)?([0-9A-ORZcf-npqrsuy=><])/,
        flags
    ); //  eslint-disable-line no-control-regex
}

function getFGColorValue(name) {
    return SGRValues[name];
}

function getBGColorValue(name) {
    return SGRValues[name + 'BG'];
}

//  See http://cvs.synchro.net/cgi-bin/viewcvs.cgi/*checkout*/src/conio/cterm.txt
//  :TODO: document
//  :TODO: Create mappings for aliases... maybe make this a map to values instead
//  :TODO: Break this up in to two parts:
//  1) FONT_AND_CODE_PAGES (e.g. SyncTERM/cterm)
//  2) SAUCE_FONT_MAP: Sauce name(s) -> items in FONT_AND_CODE_PAGES.
//  ...we can then have getFontFromSAUCEName(sauceFontName)
//  Also, create a SAUCE_ENCODING_MAP: SAUCE font name -> encodings

//
//  An array of CTerm/SyncTERM font/encoding values. Each entry's index
//  corresponds to it's escape sequence value (e.g. cp437 = 0)
//
//  See https://github.com/protomouse/synchronet/blob/master/src/conio/cterm.txt
//
const SYNCTERM_FONT_AND_ENCODING_TABLE = [
    'cp437',
    'cp1251',
    'koi8_r',
    'iso8859_2',
    'iso8859_4',
    'cp866',
    'iso8859_9',
    'haik8',
    'iso8859_8',
    'koi8_u',
    'iso8859_15',
    'iso8859_4',
    'koi8_r_b',
    'iso8859_4',
    'iso8859_5',
    'ARMSCII_8',
    'iso8859_15',
    'cp850',
    'cp850',
    'cp885',
    'cp1251',
    'iso8859_7',
    'koi8-r_c',
    'iso8859_4',
    'iso8859_1',
    'cp866',
    'cp437',
    'cp866',
    'cp885',
    'cp866_u',
    'iso8859_1',
    'cp1131',
    'c64_upper',
    'c64_lower',
    'c128_upper',
    'c128_lower',
    'atari',
    'pot_noodle',
    'mo_soul',
    'microknight_plus',
    'topaz_plus',
    'microknight',
    'topaz',
];

//
//  A map of various font name/aliases such as those used
//  in SAUCE records to SyncTERM/CTerm names
//
//  This table contains lowercased entries with any spaces
//  replaced with '_' for lookup purposes.
//
const FONT_ALIAS_TO_SYNCTERM_MAP = {
    cp437: 'cp437',
    ibm_vga: 'cp437',
    ibmpc: 'cp437',
    ibm_pc: 'cp437',
    pc: 'cp437',
    cp437_art: 'cp437',
    ibmpcart: 'cp437',
    ibmpc_art: 'cp437',
    ibm_pc_art: 'cp437',
    msdos_art: 'cp437',
    msdosart: 'cp437',
    pc_art: 'cp437',
    pcart: 'cp437',

    ibm_vga50: 'cp437',
    ibm_vga25g: 'cp437',
    ibm_ega: 'cp437',
    ibm_ega43: 'cp437',

    topaz: 'topaz',
    amiga_topaz_1: 'topaz',
    'amiga_topaz_1+': 'topaz_plus',
    topazplus: 'topaz_plus',
    topaz_plus: 'topaz_plus',
    amiga_topaz_2: 'topaz',
    'amiga_topaz_2+': 'topaz_plus',
    topaz2plus: 'topaz_plus',

    pot_noodle: 'pot_noodle',
    p0tnoodle: 'pot_noodle',
    'amiga_p0t-noodle': 'pot_noodle',

    mo_soul: 'mo_soul',
    mosoul: 'mo_soul',
    "mo'soul": 'mo_soul',
    amiga_mosoul: 'mo_soul',

    amiga_microknight: 'microknight',
    'amiga_microknight+': 'microknight_plus',

    atari: 'atari',
    atarist: 'atari',
};

function setSyncTermFont(name, fontPage) {
    const p1 = miscUtil.valueWithDefault(fontPage, 0);

    assert(p1 >= 0 && p1 <= 3);

    const p2 = SYNCTERM_FONT_AND_ENCODING_TABLE.indexOf(name);
    if (p2 > -1) {
        return `${ESC_CSI}${p1};${p2} D`;
    }

    return '';
}

function getSyncTermFontFromAlias(alias) {
    return FONT_ALIAS_TO_SYNCTERM_MAP[alias.toLowerCase().replace(/ /g, '_')];
}

function setSyncTermFontWithAlias(nameOrAlias) {
    nameOrAlias = getSyncTermFontFromAlias(nameOrAlias) || nameOrAlias;
    return setSyncTermFont(nameOrAlias);
}

const DEC_CURSOR_STYLE = {
    'blinking block': 0,
    default: 1,
    'steady block': 2,
    'blinking underline': 3,
    'steady underline': 4,
    'blinking bar': 5,
    'steady bar': 6,
};

function setCursorStyle(cursorStyle) {
    const ps = DEC_CURSOR_STYLE[cursorStyle];
    if (ps) {
        return `${ESC_CSI}${ps} q`;
    }
    return '';
}

//  Create methods such as up(), nextLine(),...
Object.keys(CONTROL).forEach(function onControlName(name) {
    const code = CONTROL[name];

    exports[name] = function () {
        let c = code;
        if (arguments.length > 0) {
            //  arguments are array like -- we want an array
            c = Array.prototype.slice.call(arguments).map(Math.round).join(';') + code;
        }
        return `${ESC_CSI}${c}`;
    };
});

//  Create various color methods such as white(), yellowBG(), reset(), ...
Object.keys(SGRValues).forEach(name => {
    const code = SGRValues[name];

    exports[name] = function () {
        return `${ESC_CSI}${code}m`;
    };
});

function sgr() {
    //
    //  - Allow an single array or variable number of arguments
    //  - Each element can be either a integer or string found in SGRValues
    //    which in turn maps to a integer
    //
    if (arguments.length <= 0) {
        return '';
    }

    let result = [];
    const args = Array.isArray(arguments[0]) ? arguments[0] : arguments;

    for (let i = 0; i < args.length; ++i) {
        const arg = args[i];
        if (_.isString(arg) && arg in SGRValues) {
            result.push(SGRValues[arg]);
        } else if (_.isNumber(arg)) {
            result.push(arg);
        }
    }

    return `${ESC_CSI}${result.join(';')}m`;
}

//
//  Converts a Graphic Rendition object used elsewhere
//  to a ANSI SGR sequence.
//
function getSGRFromGraphicRendition(graphicRendition, initialReset) {
    let sgrSeq = [];
    let styleCount = 0;

    ['intensity', 'underline', 'blink', 'negative', 'invisible'].forEach(s => {
        if (graphicRendition[s]) {
            sgrSeq.push(graphicRendition[s]);
            ++styleCount;
        }
    });

    if (graphicRendition.fg) {
        sgrSeq.push(graphicRendition.fg);
    }

    if (graphicRendition.bg) {
        sgrSeq.push(graphicRendition.bg);
    }

    if (0 === styleCount || initialReset) {
        sgrSeq.unshift(0);
    }

    return sgr(sgrSeq);
}

///////////////////////////////////////////////////////////////////////////////
//  Shortcuts for common functions
///////////////////////////////////////////////////////////////////////////////

function clearScreen() {
    return exports.eraseData(2);
}

function resetScreen() {
    return `${exports.reset()}${exports.eraseData(2)}${exports.goHome()}`;
}

function normal() {
    return sgr(['normal', 'reset']);
}

function goHome() {
    return exports.goto(); //  no params = home = 1,1
}

//
//  Disable auto line wraping @ termWidth
//
//  See:
//  http://stjarnhimlen.se/snippets/vt100.txt
//  https://github.com/protomouse/synchronet/blob/master/src/conio/cterm.txt
//
//  WARNING:
//  * Not honored by all clients
//  * If it is honored, ANSI's that rely on this (e.g. do not have \r\n endings
//    and use term width -- generally 80 columns -- will display garbled!
//
function disableVT100LineWrapping() {
    return `${ESC_CSI}?7l`;
}

function setEmulatedBaudRate(rate) {
    const speed =
        {
            unlimited: 0,
            off: 0,
            0: 0,
            300: 1,
            600: 2,
            1200: 3,
            2400: 4,
            4800: 5,
            9600: 6,
            19200: 7,
            38400: 8,
            57600: 9,
            76800: 10,
            115200: 11,
        }[rate] || 0;
    return 0 === speed ? exports.emulationSpeed() : exports.emulationSpeed(1, speed);
}

function vtxHyperlink(client, url, len) {
    if (!client.terminalSupports('vtx_hyperlink')) {
        return '';
    }

    len = len || url.length;

    url = url
        .split('')
        .map(c => c.charCodeAt(0))
        .join(';');
    return `${ESC_CSI}1;${len};1;1;${url}\\`;
}
