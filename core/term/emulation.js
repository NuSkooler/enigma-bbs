/* jslint node: true */
'use strict';

//
//  A terminal emulation, as held by one client at |client.term.emulation|.
//
//  ENiGMA is ANSI inside. An emulation is the set of parts that differ per
//  kind of terminal, so the rest of the system does not have to know:
//
//      name                'ansi', later 'petscii', 'atascii'
//      probes              connect-time sequence: [ { name, run(client, cb) } ]
//      inputDecoder        bytes from the terminal -> key presses and replies
//      outputTranslator    the final outbound stream -> what the terminal speaks
//      codec               strings <-> the terminal's glyph bytes
//      capabilities        what this terminal reported it can do (mutable)
//      defaults            { cols, rows, artTypes(term) }
//      layers              additive features on top of the base, by name
//                          (RIP, later Sixel); empty until one is detected
//
//  A base emulation is built from a definition (see ./ansi/index.js); each
//  client gets its own instance because capabilities, layers and any decoder
//  or translator state are per connection.
//
class Emulation {
    constructor(definition) {
        this.definition = definition;
        this.name = definition.name;
        this.probes = definition.probes || [];
        this.inputDecoder = definition.createInputDecoder();
        this.outputTranslator = definition.createOutputTranslator();
        this.codec = definition.codec;
        //  the one output encoding this emulation uses, when it has its own
        this.encoding = definition.encoding;
        this.capabilities = {};
        this.defaults = definition.defaults;
        this.layers = new Map();
    }

    //
    //  Can the terminal do |query| ('osc8_hyperlink', 'vtx_audio', ...)?
    //  Unknown queries are false. |term| is the ClientTerminal (or a stand-in)
    //  the answer is for.
    //
    supports(query, term) {
        for (const layer of this.layers.values()) {
            if (layer.supports && layer.supports(query, term)) {
                return true;
            }
        }
        return this.definition.supports
            ? true === this.definition.supports(query, term)
            : false;
    }

    //
    //  Art type preferences for |term|, in the shape art.js documents:
    //  { allowed?, preferred, last? }. A layer's preferred tiers rank ahead of
    //  the base's; only the base decides what is allowed.
    //
    artTypes(term) {
        const base = this.defaults.artTypes(term);
        if (0 === this.layers.size) {
            return base;
        }

        const layerTiers = [];
        for (const layer of this.layers.values()) {
            const preferred = layer.artTypes && layer.artTypes.preferred;
            if (Array.isArray(preferred)) {
                layerTiers.push(...preferred);
            }
        }
        return Object.assign({}, base, {
            preferred: layerTiers.concat(base.preferred || []),
        });
    }

    //
    //  Attach an additive |layer|: { name, supports?(query, term), artTypes? }.
    //  Only a base that takes layers (ANSI) accepts one; returns whether it
    //  was attached.
    //
    addLayer(layer) {
        if (!this.definition.acceptsLayers || !layer || !layer.name) {
            return false;
        }
        this.layers.set(layer.name, layer);
        return true;
    }

    hasLayer(name) {
        return this.layers.has(name);
    }
}

module.exports = { Emulation };
