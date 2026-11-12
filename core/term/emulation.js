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
//      outputFilter        null, or what a layer needs done to everything
//                          ENiGMA sends after the translator (RIP: keep RIP
//                          commands out of text); see addLayer()
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

        //  null unless an attached layer filters output: the one thing the
        //  output path checks, so a session without such a layer does no
        //  more work than before
        this.outputFilter = null;
        this.outputFilters = new Map(); //  layer name -> its filter
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
    //  Attach an additive |layer|: { name, supports?(query, term), artTypes?,
    //  createOutputFilter? }. Only a base that takes layers (ANSI) accepts
    //  one; returns whether it was attached.
    //
    //  createOutputFilter() makes the layer's output filter: { filter(data),
    //  observe(data) }. filter() is given everything ENiGMA sends after the
    //  output translator and returns what goes on the wire; observe() is
    //  given what goes on the wire around it (pass-through, native and
    //  unfiltered writes; see core/client_term.js) and returns it, after
    //  anything filter() held back. It is made once per layer name and
    //  filters from the next write on.
    //
    addLayer(layer) {
        if (!this.definition.acceptsLayers || !layer || !layer.name) {
            return false;
        }
        this.layers.set(layer.name, layer);

        if (
            'function' === typeof layer.createOutputFilter &&
            !this.outputFilters.has(layer.name)
        ) {
            this.outputFilters.set(layer.name, layer.createOutputFilter());
            this.outputFilter = composeFilters([...this.outputFilters.values()]);
        }
        return true;
    }

    hasLayer(name) {
        return this.layers.has(name);
    }
}

//  One filter from several, applied in the order the layers were attached
function composeFilters(filters) {
    if (1 === filters.length) {
        return filters[0];
    }
    return {
        filter: data => filters.reduce((d, f) => f.filter(d), data),
        observe: data => filters.reduce((d, f) => f.observe(d), data),
    };
}

module.exports = { Emulation };
