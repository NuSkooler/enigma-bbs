/* jslint node: true */
'use strict';

//
//  Which emulation a connection gets (#593).
//
//  Two things can name one, in this order:
//
//  1. The listener the caller connected to: |emulation| on a named telnet
//     listener (loginServers.telnet.listeners). The operator said so.
//  2. The terminal type the caller sent (telnet TTYPE, SSH pty-req):
//     SyncTERM and IcyTerm announce 'PETSCII' and 'ATASCII'; IcyTerm
//     announces 'RIP'.
//
//  Anything else is ANSI, as it always has been.
//
//  What was asked for is always recorded. What the connection actually gets
//  is the emulation if it is implemented, otherwise ANSI, and that is logged.
//  ANSI, PETSCII and ATASCII are implemented so far, and the RIPscrip layer
//  on ANSI.
//
//  A layer can also be found later: a RIP terminal answers the version query
//  the ANSI probes send (core/term/rip), and core/client.js hands the answer
//  to attachRipLayer() below, whenever it arrives.
//
const {
    emulationExists,
    layerExists,
    createEmulation,
    createLayer,
    DEFAULT_EMULATION,
} = require('./index.js');
const Rip = require('./rip');

//
//  Names we recognise. A base emulation replaces ANSI; a layer is an addition
//  to ANSI (see ./emulation.js).
//
const KnownEmulations = Object.freeze({
    ansi: 'base',
    petscii: 'base',
    atascii: 'base',
    rip: 'layer',
});

//  Terminal type (lower case) -> emulation name. Exact matches only.
const TermTypeEmulations = Object.freeze({
    petscii: 'petscii', //  SyncTERM (C64 / C128 modes), IcyTerm
    atascii: 'atascii', //  SyncTERM (Atari modes), IcyTerm
    rip: 'rip', //  IcyTerm
});

const normalize = name => (typeof name === 'string' ? name.trim().toLowerCase() : '');

//  The emulation a terminal type names, or undefined
function emulationFromTermType(termType) {
    const name = normalize(termType);
    return Object.prototype.hasOwnProperty.call(TermTypeEmulations, name)
        ? TermTypeEmulations[name]
        : undefined;
}

//
//  Resolve what was requested and what will be used:
//
//      {
//          requested   emulation name asked for ('ansi' when nothing asked)
//          source      'listener' | 'termType' | 'default'
//          kind        'base' | 'layer' | 'unknown'
//          base        the base emulation to use; always an implemented one
//          layers      layer names to attach; always implemented ones
//          fallback    true when |requested| could not be honoured
//      }
//
function resolveEmulation({ termType, listenerEmulation } = {}) {
    let requested = normalize(listenerEmulation);
    let source = 'listener';

    if (!requested) {
        requested = emulationFromTermType(termType);
        source = 'termType';
    }

    if (!requested) {
        requested = DEFAULT_EMULATION;
        source = 'default';
    }

    const kind = Object.prototype.hasOwnProperty.call(KnownEmulations, requested)
        ? KnownEmulations[requested]
        : 'unknown';

    const resolved = {
        requested,
        source,
        kind,
        base: DEFAULT_EMULATION,
        layers: [],
        fallback: false,
    };

    if ('base' === kind && emulationExists(requested)) {
        resolved.base = requested;
    } else if ('layer' === kind && layerExists(requested)) {
        //  a layer is an addition to ANSI
        resolved.layers.push(requested);
    } else {
        //  an unimplemented base or layer, or a name we do not know: ANSI
        resolved.fallback = true;
    }

    return resolved;
}

//
//  Attach the layer |name| to |client|'s emulation, made from |info|. Logs at
//  info how it was found. Returns the layer, or undefined when the emulation
//  takes no layers (PETSCII, ATASCII).
//
function attachLayer(client, name, info) {
    const term = client.term;
    const emulation = term.emulation;
    const layer = createLayer(name, info);

    if (!emulation || !emulation.addLayer(layer)) {
        if (client.log) {
            client.log.debug(
                { layer: name, emulation: emulation && emulation.name, ...info },
                `Terminal emulation "${emulation && emulation.name}" takes no layers; "${name}" not attached`
            );
        }
        return undefined;
    }

    if (client.log) {
        client.log.info(
            {
                layer: name,
                source: info.source,
                version: layer.version,
                termType: term.termType,
            },
            `Terminal emulation layer "${name}" attached (${info.source})`
        );
    }
    return layer;
}

//
//  A RIPscrip terminal has made itself known: by its terminal type (IcyTerm,
//  at selection) or by answering the version query (|source| 'probe',
//  |version| what it answered, e.g. 'RIPSCRIP015410'). Attaches the 'rip'
//  layer the first time; after that, records a version not yet known.
//
//  Only an emulation that takes layers (ANSI) gets one; PETSCII and ATASCII
//  sessions are never sent the query, and a reply on one is ignored.
//
function attachRipLayer(client, { source, version } = {}) {
    const emulation = client.term.emulation;
    const existing =
        emulation && emulation.layers && emulation.layers.get(Rip.LAYER_NAME);

    if (!existing) {
        return attachLayer(client, Rip.LAYER_NAME, { source, version });
    }

    if (version && !existing.version && existing.setVersion(version)) {
        if (client.log) {
            client.log.info(
                { layer: Rip.LAYER_NAME, source, version, firstSource: existing.source },
                'RIPscrip version reported'
            );
        }
    }
    return existing;
}

//
//  Give |client| its emulation, before the connect probes run. |readyOptions|
//  is what the login server sent with 'ready'; a named listener's config, if
//  any, is at |readyOptions.listener|.
//
//  For a caller that asks for nothing this changes nothing and logs nothing
//  above debug.
//
function selectClientEmulation(client, readyOptions) {
    const term = client.term;
    const listener = readyOptions && readyOptions.listener;

    const resolved = resolveEmulation({
        termType: term.termType,
        listenerEmulation: listener && listener.emulation,
    });

    term.requestedEmulation = {
        name: resolved.requested,
        source: resolved.source,
    };

    if (term.emulation.name !== resolved.base) {
        term.emulation = createEmulation(resolved.base);

        //
        //  An emulation with an output encoding of its own (PETSCII) uses it
        //  from here on. ANSI has none: its encoding stays whatever the
        //  terminal type and configuration made it.
        //
        if (term.emulation.encoding) {
            term.outputEncoding = term.emulation.encoding;
        }
    }

    for (const name of resolved.layers) {
        attachLayer(client, name, { source: resolved.source });
    }

    const info = {
        requested: resolved.requested,
        source: resolved.source,
        emulation: term.emulation.name,
        termType: term.termType,
    };
    if (listener && listener.name) {
        info.listener = listener.name;
    }

    if (client.log) {
        if (resolved.fallback) {
            client.log.info(
                info,
                `Terminal emulation "${resolved.requested}" is not ${
                    'unknown' === resolved.kind ? 'known' : 'implemented'
                }; using "${term.emulation.name}"`
            );
        } else {
            client.log.debug(info, 'Terminal emulation selected');
        }
    }

    return resolved;
}

module.exports = {
    KnownEmulations,
    TermTypeEmulations,
    emulationFromTermType,
    resolveEmulation,
    selectClientEmulation,
    attachLayer,
    attachRipLayer,
};
