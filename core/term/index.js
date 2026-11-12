/* jslint node: true */
'use strict';

//
//  Terminal emulations (#593). See ./emulation.js for what one is.
//
//  ANSI is the default for every client. PETSCII and ATASCII are the other
//  base emulations so far; a client gets one only by asking (see ./select.js).
//  RIPscrip is a layer on ANSI (./rip), attached when the terminal says it
//  draws RIP.
//
const { Emulation } = require('./emulation.js');
const ansiDefinition = require('./ansi');
const petsciiDefinition = require('./petscii');
const atasciiDefinition = require('./atascii');
const rip = require('./rip');

const DEFAULT_EMULATION = 'ansi';

const definitions = new Map([
    [ansiDefinition.name, ansiDefinition],
    [petsciiDefinition.name, petsciiDefinition],
    [atasciiDefinition.name, atasciiDefinition],
]);

//  Layers, by name: each makes a new layer for one client from |info|
const layerFactories = new Map([[rip.LAYER_NAME, rip.createRipLayer]]);

//  true when a base emulation called |name| is implemented
function emulationExists(name) {
    return definitions.has(name);
}

//  true when a layer called |name| is implemented
function layerExists(name) {
    return layerFactories.has(name);
}

//  A new layer for one client; |info| is what the layer takes (rip: version,
//  source)
function createLayer(name, info) {
    const factory = layerFactories.get(name);
    if (!factory) {
        throw new Error(`Unknown terminal emulation layer "${name}"`);
    }
    return factory(info);
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
    createLayer,
    emulationExists,
    layerExists,
    emulationNames,
    emulationOf,
};
