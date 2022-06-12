/* jslint node: true */
'use strict';

const ANSI = require('./ansi_term.js');
const { getPredefinedMCIValue } = require('./predefined_mci.js');

//  deps
const _ = require('lodash');

exports.stripMciColorCodes = stripMciColorCodes;
exports.pipeStringLength = pipeStringLength;
exports.pipeToAnsi = exports.renegadeToAnsi = renegadeToAnsi;
exports.controlCodesToAnsi = controlCodesToAnsi;

//  :TODO: Not really happy with the module name of "color_codes". Would like something better ... control_code_string?

function stripMciColorCodes(s) {
    return s.replace(/\|[A-Z\d]{2}/g, '');
}

function pipeStringLength(s) {
    return stripMciColorCodes(s).length;
}

function ansiSgrFromRenegadeColorCode(cc) {
    return ANSI.sgr(
        {
            0: ['reset', 'black'],
            1: ['reset', 'blue'],
            2: ['reset', 'green'],
            3: ['reset', 'cyan'],
            4: ['reset', 'red'],
            5: ['reset', 'magenta'],
            6: ['reset', 'yellow'],
            7: ['reset', 'white'],

            8: ['bold', 'black'],
            9: ['bold', 'blue'],
            10: ['bold', 'green'],
            11: ['bold', 'cyan'],
            12: ['bold', 'red'],
            13: ['bold', 'magenta'],
            14: ['bold', 'yellow'],
            15: ['bold', 'white'],

            16: ['blackBG'],
            17: ['blueBG'],
            18: ['greenBG'],
            19: ['cyanBG'],
            20: ['redBG'],
            21: ['magentaBG'],
            22: ['yellowBG'],
            23: ['whiteBG'],

            24: ['blink', 'blackBG'],
            25: ['blink', 'blueBG'],
            26: ['blink', 'greenBG'],
            27: ['blink', 'cyanBG'],
            28: ['blink', 'redBG'],
            29: ['blink', 'magentaBG'],
            30: ['blink', 'yellowBG'],
            31: ['blink', 'whiteBG'],
        }[cc] || 'normal'
    );
}

function ansiSgrFromCnetStyleColorCode(cc) {
    return ANSI.sgr(
        {
            c0: ['reset', 'black'],
            c1: ['reset', 'red'],
            c2: ['reset', 'green'],
            c3: ['reset', 'yellow'],
            c4: ['reset', 'blue'],
            c5: ['reset', 'magenta'],
            c6: ['reset', 'cyan'],
            c7: ['reset', 'white'],

            c8: ['bold', 'black'],
            c9: ['bold', 'red'],
            ca: ['bold', 'green'],
            cb: ['bold', 'yellow'],
            cc: ['bold', 'blue'],
            cd: ['bold', 'magenta'],
            ce: ['bold', 'cyan'],
            cf: ['bold', 'white'],

            z0: ['blackBG'],
            z1: ['redBG'],
            z2: ['greenBG'],
            z3: ['yellowBG'],
            z4: ['blueBG'],
            z5: ['magentaBG'],
            z6: ['cyanBG'],
            z7: ['whiteBG'],
        }[cc] || 'normal'
    );
}

function renegadeToAnsi(s, client) {
    if (-1 == s.indexOf('|')) {
        return s; //  no pipe codes present
    }

    let result = '';
    const re = /\|(?:(C[FBUD])([0-9]{1,2})|([0-9]{2})|([A-Z]{2})|(\|))/g;
    let m;
    let lastIndex = 0;
    while ((m = re.exec(s))) {
        if (m[3]) {
            //  |## color
            const val = parseInt(m[3], 10);
            const attr = ansiSgrFromRenegadeColorCode(val);
            result += s.substr(lastIndex, m.index - lastIndex) + attr;
        } else if (m[4] || m[1]) {
            //  |AA MCI code or |Cx## movement where ## is in m[1]
            let val = getPredefinedMCIValue(client, m[4] || m[1], m[2]);
            val = _.isString(val) ? val : m[0]; //  value itself or literal
            result += s.substr(lastIndex, m.index - lastIndex) + val;
        } else if (m[5]) {
            //  || -- literal '|', that is.
            result += '|';
        }

        lastIndex = re.lastIndex;
    }

    return 0 === result.length ? s : result + s.substr(lastIndex);
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
function controlCodesToAnsi(s, client) {
    const RE =
        /(\|([A-Z0-9]{2})|\|)|(@X([0-9A-F]{2}))|(@([0-9A-F]{2})@)|(\x03[0-9]|\x03)|(\x19(c[0-9a-f]|z[0-7]|n1|f1|q1)|\x19)|(\x11(c[0-9a-f]|z[0-7]|n1|f1|q1)}|\x11)/g; //  eslint-disable-line no-control-regex

    let m;
    let result = '';
    let lastIndex = 0;
    let v;
    let fg;
    let bg;

    while ((m = RE.exec(s))) {
        switch (m[0].charAt(0)) {
            case '|':
                //  Renegade |##
                v = parseInt(m[2], 10);

                if (isNaN(v)) {
                    v = getPredefinedMCIValue(client, m[2]) || m[0]; //  value itself or literal
                }

                if (_.isString(v)) {
                    result += s.substr(lastIndex, m.index - lastIndex) + v;
                } else {
                    v = ansiSgrFromRenegadeColorCode(v);
                    result += s.substr(lastIndex, m.index - lastIndex) + v;
                }
                break;

            case '@':
                //  PCBoard @X## or Wildcat! @##@
                if ('@' === m[0].substr(-1)) {
                    //  Wildcat!
                    v = m[6];
                } else {
                    v = m[4];
                }

                bg = {
                    0: ['blackBG'],
                    1: ['blueBG'],
                    2: ['greenBG'],
                    3: ['cyanBG'],
                    4: ['redBG'],
                    5: ['magentaBG'],
                    6: ['yellowBG'],
                    7: ['whiteBG'],

                    8: ['bold', 'blackBG'],
                    9: ['bold', 'blueBG'],
                    A: ['bold', 'greenBG'],
                    B: ['bold', 'cyanBG'],
                    C: ['bold', 'redBG'],
                    D: ['bold', 'magentaBG'],
                    E: ['bold', 'yellowBG'],
                    F: ['bold', 'whiteBG'],
                }[v.charAt(0)] || ['normal'];

                fg = {
                    0: ['reset', 'black'],
                    1: ['reset', 'blue'],
                    2: ['reset', 'green'],
                    3: ['reset', 'cyan'],
                    4: ['reset', 'red'],
                    5: ['reset', 'magenta'],
                    6: ['reset', 'yellow'],
                    7: ['reset', 'white'],

                    8: ['blink', 'black'],
                    9: ['blink', 'blue'],
                    A: ['blink', 'green'],
                    B: ['blink', 'cyan'],
                    C: ['blink', 'red'],
                    D: ['blink', 'magenta'],
                    E: ['blink', 'yellow'],
                    F: ['blink', 'white'],
                }[v.charAt(1)] || ['normal'];

                v = ANSI.sgr(fg.concat(bg));
                result += s.substr(lastIndex, m.index - lastIndex) + v;
                break;

            case '\x03':
                //  WWIV
                v = parseInt(m[8], 10);

                if (isNaN(v)) {
                    v += m[0];
                } else {
                    v = ANSI.sgr(
                        {
                            0: ['reset', 'black'],
                            1: ['bold', 'cyan'],
                            2: ['bold', 'yellow'],
                            3: ['reset', 'magenta'],
                            4: ['bold', 'white', 'blueBG'],
                            5: ['reset', 'green'],
                            6: ['bold', 'blink', 'red'],
                            7: ['bold', 'blue'],
                            8: ['reset', 'blue'],
                            9: ['reset', 'cyan'],
                        }[v] || 'normal'
                    );
                }

                result += s.substr(lastIndex, m.index - lastIndex) + v;
                break;

            case '\x19':
            case '\0x11':
                //  CNET "Y-Style" & "Q-Style"
                v = m[9] || m[11];
                if (v) {
                    if ('n1' === v) {
                        v = '\n';
                    } else if ('f1' === v) {
                        v = ANSI.clearScreen();
                    } else {
                        v = ansiSgrFromCnetStyleColorCode(v);
                    }
                } else {
                    v = m[0];
                }
                result += s.substr(lastIndex, m.index - lastIndex) + v;
                break;
        }

        lastIndex = RE.lastIndex;
    }

    return 0 === result.length ? s : result + s.substr(lastIndex);
}
