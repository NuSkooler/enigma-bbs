/* jslint node: true */
'use strict';

//
//  Terminal emulations (#593). See ./emulation.js for what one is.
//
//  ANSI is the default for every client. PETSCII and ATASCII are the other
//  base emulations so far; a client gets one only by asking (see ./select.js).
//
const { Emulation } = require('./emulation.js');
const ansiDefinition = require('./ansi');
const petsciiDefinition = require('./petscii');
const atasciiDefinition = require('./atascii');

const DEFAULT_EMULATION = 'ansi';

const definitions = new Map([
    [ansiDefinition.name, ansiDefinition],
    [petsciiDefinition.name, petsciiDefinition],
    [atasciiDefinition.name, atasciiDefinition],
]);

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
//  as ANSI, which is what it was before emulations existed. Those all share
//  one instance: use it to read ANSI's parts, never to store per-client state
//  (a stand-in term keeps its own termCapabilities).
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
