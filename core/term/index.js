/* jslint node: true */
'use strict';

//
//  Terminal emulations (#593). See ./emulation.js for what one is.
//
//  ANSI is the only base emulation so far and the default for every client.
//
const { Emulation } = require('./emulation.js');
const ansiDefinition = require('./ansi');

const DEFAULT_EMULATION = 'ansi';

const definitions = new Map([[ansiDefinition.name, ansiDefinition]]);

//  true when a base emulation called |name| is implemented
function emulationExists(name) {
    return definitions.has(name);
}

function emulationNames() {
    return [...definitions.keys()];
}

//  A new emulation instance for one client; ANSI when |name| is not given
function createEmulation(name = DEFAULT_EMULATION) {
    const definition = definitions.get(name);
    if (!definition) {
        throw new Error(`Unknown terminal emulation "${name}"`);
    }
    return new Emulation(definition);
}

//
//  The emulation of |term|. A ClientTerminal always has one; anything else
//  handed around as a term (tests, modules that build a stand-in) is treated
//  as ANSI, which is what it was before emulations existed.
//
let fallback;
function emulationOf(term) {
    if (term && term.emulation) {
        return term.emulation;
    }
    if (!fallback) {
        fallback = createEmulation(DEFAULT_EMULATION);
    }
    return fallback;
}

module.exports = {
    DEFAULT_EMULATION,
    Emulation,
    createEmulation,
    emulationExists,
    emulationNames,
    emulationOf,
};
