'use strict';

const Commands = {
    M_NUL: 0,
    M_ADR: 1,
    M_PWD: 2,
    M_FILE: 3,
    M_OK: 4,
    M_EOB: 5,
    M_GOT: 6,
    M_ERR: 7,
    M_BSY: 8,
    M_GET: 9,
    M_SKIP: 10,
};

const CommandNames = Object.fromEntries(Object.entries(Commands).map(([k, v]) => [v, k]));

// M_NUL sub-type keyword prefixes
const NulKeywords = {
    SYS: 'SYS',
    ZYZ: 'ZYZ',
    LOC: 'LOC',
    NDL: 'NDL',
    VER: 'VER',
    TIME: 'TIME',
    OPT: 'OPT',
    TRF: 'TRF',
};

// Capability tokens used in M_NUL OPT
const Opts = {
    NR: 'NR',
    ND: 'ND',
    NDA: 'NDA',
    CRYPT: 'CRYPT',
    GZ: 'GZ',
    BZ2: 'BZ2',
    EXTCMD: 'EXTCMD',
};

module.exports = { Commands, CommandNames, NulKeywords, Opts };
