/* jslint node: true */
'use strict';

//
//  What an ANSI terminal says about itself in reply to Device Attributes (DA)
//  and CTerm Device Attributes (CTDA) queries. Pure parsing: no ENiGMA imports.
//

//
//  Terminals that answer DA with their name in ASCII, as decimal parameters,
//  followed by version components. |versioned| marks the ones whose trailing
//  parameters are known to be a version.
//
//  * CTerm (SyncTERM): '67;84;101;114;109' is "CTerm".
//    See https://syncterm.bbsdev.net/cterm.html
//  * enig-term: '101;110;105;103;45;116;101;114;109' is "enig-term", then
//    major;minor;patch. CTerm-shaped, but it is not CTerm: it is identified
//    as its own client and does not set ctermVersion.
//  * IcyTerm: '73;99;121;84;101;114;109' is "IcyTerm"; the remaining bytes
//    are version info in a form not relied on here.
//    See https://github.com/mkrueger/icy_tools
//
const NamedDeviceAttrClients = [
    { prefix: '67;84;101;114;109', termClient: 'cterm', versioned: true },
    {
        prefix: '101;110;105;103;45;116;101;114;109',
        termClient: 'enig_term',
        versioned: true,
    },
    { prefix: '73;99;121;84;101;114;109', termClient: 'icy_term', versioned: false },
];

//  DA replies matched exactly
const ExactDeviceAttrClients = {
    '63;1;2': 'arctel', //  https://web.archive.org/web/20190828112223/http://www.fbl.cz/arctel/download/techman.pdf - Irssi ConnectBot (Android)
    '50;86;84;88': 'vtx', //  https://github.com/codewar65/VTX_ClientServer/blob/master/vtx.txt
};

//
//  The version that follows a name |prefix| in a DA reply, its components
//  joined with dots: '67;84;101;114;109;1;332' with the CTerm prefix is
//  '1.332'. Whatever follows the prefix is kept as-is, so a fork that appends
//  a component keeps it. null when nothing usable follows the prefix.
//
function getDeviceAttrVersion(deviceAttr, prefix) {
    const prefixLen = prefix.split(';').length;
    const parts = deviceAttr.split(';');
    if (parts.slice(0, prefixLen).join(';') !== prefix) {
        return null;
    }
    const revision = parts.slice(prefixLen);
    if (!revision.length || revision.some(part => !/^(?:0|[1-9][0-9]*)$/.test(part))) {
        return null;
    }
    return revision.join('.');
}

//
//  CTerm answers DA with the "CTerm" prefix followed by its revision, dots
//  turned into semi-colons: '67;84;101;114;109;1;332' is revision 1.332. A
//  fork appends a further component rather than incrementing one of these, so
//  whatever follows the prefix is kept as-is.
//
function getCtermVersion(deviceAttr) {
    const cterm = NamedDeviceAttrClients.find(c => 'cterm' === c.termClient);
    return cterm ? getDeviceAttrVersion(deviceAttr, cterm.prefix) : null;
}

//
//  The terminal client a DA reply identifies, and its version where the reply
//  carries one: { termClient, version }, or null for a reply we don't know.
//
function getTermClientFromDeviceAttr(deviceAttr) {
    const exact = ExactDeviceAttrClients[deviceAttr];
    if (exact) {
        return { termClient: exact, version: null };
    }

    //  match on a whole parameter boundary: a prefix followed by ';' or nothing
    const named = NamedDeviceAttrClients.find(
        c => deviceAttr === c.prefix || deviceAttr.startsWith(`${c.prefix};`)
    );
    if (!named) {
        return null;
    }

    return {
        termClient: named.termClient,
        version: named.versioned ? getDeviceAttrVersion(deviceAttr, named.prefix) : null,
    };
}

//
//  CTerm Device Attributes (CTDA): asked with CSI < c, answered with
//  CSI < 0 ; Ps... c, one Ps per feature the terminal has right now (SyncTERM
//  for example leaves out font selection in its curses output mode).
//
//  The numbering is the current CTerm manual's (Table 4), and the one CTerm's
//  code has used since it first answered CTDA (Synchronet commit 6b0845de,
//  2018-02-09, shipped in SyncTERM 1.1). cterm.txt documented a different
//  order (no bright background; 2 palette, 3 pixel, 4 font select, 5 "more
//  than 16 colours") until the 2023-04-21 fix 44f5dccc: that was only ever a
//  documentation error, so there is no older numbering to map from, and no
//  CTerm revision to tell the two apart by.
//
//  See https://syncterm.bbsdev.net/cterm.html
//
const CtdaFeatures = Object.freeze({
    1: 'loadableFonts', //  fonts loadable by DCS
    2: 'brightBackground', //  bright background, CSI ? 33 h (iCE colours)
    3: 'paletteOsc', //  palette entries settable by OSC
    4: 'pixelOps', //  pixel operations: sixel, PPM
    5: 'fontSelect', //  font selection by CSI Ps1 ; Ps2 SP D
    6: 'extendedPalette', //  extended palette
    7: 'mouse', //  mouse reports
    8: 'keyEvents', //  physical key press/release reports
});

//
//  The capabilities a CTDA reply reports, from its parameters ('0;1;2;3;5' or
//  [1, 2, 3, 5]): { ctda: [...], <name>: bool, ... }. The leading 0 that CTerm
//  sends is not a feature and is dropped, so a reply without it (IcyTerm 0.8)
//  reads the same.
//  Every known feature gets a boolean, so a feature the reply leaves out is
//  false rather than missing; numbers we have no name for are kept in |ctda|.
//
function getCtermCapabilitiesFromCtda(params) {
    const list = (Array.isArray(params) ? params : String(params).split(';'))
        .map(p => parseInt(p, 10))
        .filter(n => Number.isInteger(n) && n > 0);

    const ctda = [...new Set(list)].sort((a, b) => a - b);
    const caps = { ctda };
    Object.entries(CtdaFeatures).forEach(([n, name]) => {
        caps[name] = ctda.includes(parseInt(n, 10));
    });
    return caps;
}

module.exports = {
    NamedDeviceAttrClients,
    ExactDeviceAttrClients,
    CtdaFeatures,
    getDeviceAttrVersion,
    getCtermVersion,
    getTermClientFromDeviceAttr,
    getCtermCapabilitiesFromCtda,
};
