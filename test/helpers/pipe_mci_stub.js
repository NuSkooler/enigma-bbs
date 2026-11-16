'use strict';

//
//  A deterministic stand-in for getPredefinedMCIValue(), for pipe code tests
//  and the frozen render fixtures in test/fixtures/pipe_codes/. A known code
//  resolves to itself three times ('UN' -> 'UNUNUN'); a few codes give the
//  awkward values real generators can return.
//
//  The fixtures were generated with exactly this resolver: change it and they
//  have to be regenerated from a build that still has the old renderer.
//

const ANSI = require('../../core/ansi_term.js');

const KNOWN_MCI = new Set(
    (
        'BN VL VN SN SR SL SA SS SE UN UI UG UR AS LO UA BD US UE UW UF UT UD UC ND ' +
        'IP ST FN DN DK UP UK NR KR MS PS PC MD MA MC ML CM SH SW AC AP DR DM TO TR ' +
        'TA TD NM NP IA IV DT CT OS OA SC MB MF LA CL UU NV AN TC TT PI PE RR SD SO ' +
        'SU SP TF TB PT TP FT FB DD DB NT TU LC LD LT XY EM QQ ES PV CF CB CU CD'
    ).split(' ')
);

function resolveMci(client, code, extra) {
    if (!client || !code) {
        return;
    }
    switch (code) {
        case 'XY':
            return; //  generator that returns nothing
        case 'LO':
        case 'EM':
            return ''; //  empty value: a user with no location
        case 'QQ':
            return 7; //  a non-string value
        case 'ES':
            return '\x1b[1'; //  ends in an incomplete escape
        case 'PV':
            return 'a|07b'; //  a value holding a pipe code
        case 'CF':
            return ANSI.forward(undefined === extra ? 1 : extra);
        case 'CB':
            return ANSI.back(undefined === extra ? 1 : extra);
        case 'CU':
            return ANSI.up(undefined === extra ? 1 : extra);
        case 'CD':
            return ANSI.down(undefined === extra ? 1 : extra);
    }
    if (KNOWN_MCI.has(code)) {
        return code + code + code;
    }
}

module.exports = { resolveMci, KNOWN_MCI };
