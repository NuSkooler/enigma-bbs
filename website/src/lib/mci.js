//  Sample values for MCI codes, so art previews show something plausible
//  instead of raw %BN / %ND tokens.
//
//  ENiGMA substitutes these live against the real board, user and session. The
//  site renders art at build time with no BBS behind it, so it supplies stand-in
//  values whose only job is to look like a running board.
//
//  Codes fall into two kinds (see art/mci.md):
//    * predefined VALUE codes  -- %BN board name, %ND node, %UN username, ...
//    * view INSTANTIATION codes -- %VM vertical menu, %ET edit text, ...
//  Only the first kind has a value to show. View codes mark where a widget goes,
//  so they are blanked rather than printed literally.

/** Predefined value codes → what a demo board would show. */
export const MCI_SAMPLES = {
    BN: 'ENiGMA½ BBS',
    VL: 'ENiGMA½ v0.5.1-beta',
    VN: '0.5.1-beta',
    SN: 'sysop',
    SR: 'The SysOp',
    SL: 'Parts Unknown',
    SA: 'ENiGMA½',
    SE: 'sysop@example.com',
    UN: 'newuser',
    UI: '42',
    UG: 'users',
    UR: 'New User',
    LO: 'Parts Unknown',
    UA: '31',
    BD: '1995-10-01',
    US: 'M',
    UE: 'user@example.com',
    UW: 'https://example.com',
    UF: 'ENiGMA½',
    UT: 'luciano_blocktronics',
    UD: 'luciano_blocktronics',
    UC: '128',
    ND: '3',
    DT: '2026-09-09',
    OS: 'Linux',
    AN: '3',
    TC: '112908',
    SC: '4911',
    PT: '1284',
    NV: '4',
    TP: '37',
    TT: '18d 04:22',
    OA: '0.0.0.0',
    RR: 'Long distance calls cost a fortune. Use the BBS.',
    AS: '@newuser@example.com',
};

//  A token is %CODE, optionally a view id, optionally (args): %BN, %RR1, %BN(l).
const MCI_TOKEN = /%([A-Z]{2})(\d*)(\([^)]*\))?/g;

/**
 * Replace MCI codes in a line of art with sample values.
 *
 * The art is a fixed character grid, so a longer replacement would shear
 * everything to its right. Surplus characters are absorbed by eating the spaces
 * that follow the token — art authors leave a field there for exactly this — and
 * the value is truncated if that field is too small to hold it.
 *
 * @param {string} line
 * @returns {string} the line, same length or shorter
 */
export function substituteMci(line) {
    MCI_TOKEN.lastIndex = 0;
    let out = '';
    let cursor = 0;
    let m;

    while ((m = MCI_TOKEN.exec(line)) !== null) {
        const [token, code] = m;
        const start = m.index;

        //  The field is the token plus any spaces immediately following it —
        //  art authors leave that room for the substituted value. Replacing
        //  exactly that span keeps every later column where it was.
        const trailing = /^ */.exec(line.slice(start + token.length))[0].length;
        const field = token.length + trailing;

        const value = MCI_SAMPLES[code];
        //  A view code, or one with no sample: blank it so no raw token ships.
        const text = value === undefined ? '' : value;

        out += line.slice(cursor, start);
        out += text.length > field ? text.slice(0, field) : text.padEnd(field, ' ');
        cursor = start + field;
        MCI_TOKEN.lastIndex = cursor;
    }

    return out + line.slice(cursor);
}
