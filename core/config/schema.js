/* jslint node: true */
'use strict';

//  ENiGMA½
const DefaultConfig = require('../config_default.js');
const DefaultMeta = require('./meta.js');

//  deps
const _ = require('lodash');

//
//  Builds the configuration schema: a tree of SchemaNode derived from
//  core/config_default.js and overlaid with core/config/meta.js.
//
//  The defaults supply shape, type and default value. All of that is
//  mechanical, so it cannot drift from what the system actually ships.
//  meta.js supplies only what a value cannot express -- which objects are
//  keyed by sysop data, which paths have no default at all, and human facing
//  description/enum/range.
//
//  Nothing here validates anything; this module only describes. Both inputs
//  are static for the life of the process, so a schema is built once and
//  never invalidated -- a hot reload changes the sysop's data, never the
//  shape it is checked against.
//
//  The guiding rule throughout is to *fail open*. Where a default carries no
//  information -- null, {}, [] -- inference says 'unknown' and declines to
//  type check, rather than inventing a type that a correct configuration
//  would then violate. Likewise an object shape derived from example entries
//  types the keys it knows without claiming to know them all.
//

const NodeType = {
    String: 'string',
    Number: 'number',
    Boolean: 'boolean',
    Object: 'object',
    Array: 'array',
    Unknown: 'unknown',
};

//  A "*" path segment matches exactly one open map key
const WILDCARD = '*';

//  Fields meta may set directly on a node
const MetaFields = [
    'type',
    'nullable',
    'closedKeys',
    'openMap',
    'value',
    'items',
    'enum',
    'min',
    'max',
    'description',
    'discriminant',
    'variants',
];

function childPath(path, key) {
    return path ? `${path}.${key}` : key;
}

//
//  meta keys are dotted paths that may contain "*" segments, so a plain map
//  lookup is not enough. Compiling them once keeps the per-node cost to a
//  walk of a short list.
//
function compileMeta(meta) {
    const exact = new Map();
    const wild = [];

    Object.entries(meta || {}).forEach(([path, entry]) => {
        if (path.includes(WILDCARD)) {
            wild.push({ segments: path.split('.'), entry });
        } else {
            exact.set(path, entry);
        }
    });

    return { exact, wild };
}

function metaFor(compiled, path) {
    const exact = compiled.exact.get(path);
    if (exact) {
        return exact;
    }

    const segments = path.split('.');
    const match = compiled.wild.find(candidate => {
        if (candidate.segments.length !== segments.length) {
            return false;
        }
        return candidate.segments.every(
            (seg, i) => WILDCARD === seg || seg === segments[i]
        );
    });

    return match ? match.entry : undefined;
}

//
//  What a default value tells us about its own type, and nothing more.
//
function inferScalar(value) {
    const type = typeof value;
    switch (type) {
        case 'string':
        case 'number':
        case 'boolean':
            return { type, default: value };

        default:
            //  functions, symbols and friends: say nothing
            return { type: NodeType.Unknown };
    }
}

function isScalar(value) {
    return (
        null !== value &&
        undefined !== value &&
        !Array.isArray(value) &&
        !_.isPlainObject(value)
    );
}

//
//  Union several node shapes into one permissive node. Used for the values of
//  an open map, where config_default.js ships a couple of example entries
//  that are emphatically not an exhaustive key list.
//
function mergeShapes(nodes) {
    const usable = nodes.filter(Boolean);
    if (0 === usable.length) {
        return { type: NodeType.Unknown };
    }

    const types = new Set(usable.map(n => n.type));
    if (types.size > 1) {
        //  the examples disagree; better to say nothing than to pick one
        return { type: NodeType.Unknown };
    }

    const type = usable[0].type;

    if (NodeType.Object !== type) {
        const merged = { type };
        const items = usable.map(n => n.items).filter(Boolean);
        if (items.length === usable.length) {
            merged.items = mergeShapes(items);
        }
        return merged;
    }

    //
    //  closedKeys is deliberately false here. Two shipped file areas do not
    //  tell us every key a real one may carry -- acs and hashTags are both
    //  legitimate and appear in neither example -- so this shape types what
    //  it recognises and tolerates the rest.
    //
    const children = {};
    usable.forEach(node => {
        Object.entries(node.children || {}).forEach(([key, child]) => {
            if (!children[key]) {
                children[key] = child;
            }
        });
    });

    return { type: NodeType.Object, closedKeys: false, children };
}

function overlay(node, meta) {
    if (!meta) {
        return node;
    }

    MetaFields.forEach(field => {
        if (undefined !== meta[field]) {
            node[field] = meta[field];
        }
    });

    return node;
}

function buildArrayNode(arr, path, compiled) {
    const node = { type: NodeType.Array, default: arr };

    if (0 === arr.length) {
        //  an empty array says nothing about its elements
        return node;
    }

    if (arr.every(entry => _.isPlainObject(entry))) {
        //  e.g. fileTypes['application/octet-stream'], two signature entries
        node.items = mergeShapes(
            arr.map(entry => buildNode(entry, childPath(path, WILDCARD), compiled))
        );
        return node;
    }

    if (arr.every(isScalar)) {
        const types = new Set(arr.map(entry => typeof entry));
        if (1 === types.size) {
            node.items = { type: types.values().next().value };
        }
    }

    return node;
}

function buildOpenMapNode(value, path, compiled, meta) {
    const node = {
        type: NodeType.Object,
        openMap: true,
        //  the keys are sysop data, so an unrecognised one is never a typo
        closedKeys: false,
    };

    if (meta && meta.value) {
        node.value = meta.value;
        return node;
    }

    const examples = _.isPlainObject(value) ? Object.values(value) : [];
    node.value = mergeShapes(
        examples.map(entry => buildNode(entry, childPath(path, WILDCARD), compiled))
    );

    return node;
}

function buildNode(value, path, compiled) {
    const meta = metaFor(compiled, path);
    let node;

    if (meta && true === meta.openMap) {
        node = buildOpenMapNode(value, path, compiled, meta);
    } else if (_.isPlainObject(value) && Object.keys(value).length > 0) {
        const children = {};
        Object.keys(value).forEach(key => {
            children[key] = buildNode(value[key], childPath(path, key), compiled);
        });
        node = { type: NodeType.Object, closedKeys: true, children };
    } else if (Array.isArray(value)) {
        node = buildArrayNode(value, path, compiled);
    } else if (null === value) {
        //  null is a documented "unset" sentinel, not a type
        node = { type: NodeType.Unknown, nullable: true };
    } else if (_.isPlainObject(value)) {
        //  {} -- carries no shape at all
        node = { type: NodeType.Unknown };
    } else {
        node = inferScalar(value);
    }

    return overlay(node, meta);
}

//
//  meta declares paths the defaults never mention -- messageNetworks and
//  friends. Those have to be grafted onto the tree, along with any missing
//  parents, or the very settings most worth checking would read as unknown
//  keys.
//
//  Intermediates created this way are left open unless meta says otherwise:
//  knowing a section exists is not the same as knowing every key in it.
//
function newDeclaredNode(isLeaf, entry) {
    if (!isLeaf) {
        return { type: NodeType.Object, closedKeys: false, children: {} };
    }

    if (entry && true === entry.openMap) {
        return {
            type: NodeType.Object,
            openMap: true,
            closedKeys: false,
            value: { type: NodeType.Unknown },
        };
    }

    return { type: NodeType.Unknown };
}

function insertDeclaredPaths(root, meta, compiled) {
    Object.keys(meta || {})
        .filter(path => !path.includes(WILDCARD))
        .sort() //  parents before their children
        .forEach(path => {
            const segments = path.split('.');
            let node = root;

            for (let i = 0; i < segments.length; ++i) {
                if (!node) {
                    break;
                }

                if (NodeType.Unknown === node.type && !node.openMap) {
                    //
                    //  The default said nothing here -- null, {} or absent --
                    //  but meta declares something beneath it, which is itself
                    //  a statement that this is an object. Promote it, leaving
                    //  it permissive: we know it has this child, not that it
                    //  has only this child.
                    //
                    node.type = NodeType.Object;
                    node.closedKeys = false;
                    node.children = node.children || {};
                }

                if (NodeType.Object !== node.type || node.openMap) {
                    //  nothing to graft onto; an open map already accepts it
                    break;
                }

                const segment = segments[i];
                node.children = node.children || {};

                if (!node.children[segment]) {
                    const isLeaf = i === segments.length - 1;
                    const entry = isLeaf ? metaFor(compiled, path) : undefined;

                    node.children[segment] = overlay(
                        newDeclaredNode(isLeaf, entry),
                        entry
                    );
                }

                node = node.children[segment];
            }
        });

    return root;
}

//
//  Resolve a dotted config path against a schema, stepping through open maps
//  transparently. Returns the SchemaNode, or undefined when the path names
//  nothing the schema knows about.
//
function resolvePath(schema, path) {
    let node = schema;

    for (const segment of String(path).split('.')) {
        if (!node) {
            return undefined;
        }

        if (node.openMap) {
            //  any key is legal here; step into the value shape
            node = node.value;
            continue;
        }

        if (!node.children || !node.children[segment]) {
            return undefined;
        }

        node = node.children[segment];
    }

    return node;
}

//
//  Like resolvePath(), but distinguishes the two very different reasons a path
//  may not resolve:
//
//    known     the schema describes this path exactly
//    tolerated the schema does not describe it, but does not object to it
//              either -- it sits under an open map, under a shape derived
//              from examples, or under a node whose type is unknown
//
//  Only a path that is neither known nor tolerated is a candidate for being
//  reported as an unknown key.
//
function lookupPath(schema, path) {
    let node = schema;
    const segments = String(path).split('.');

    for (let i = 0; i < segments.length; ++i) {
        if (!node) {
            return { known: false, tolerated: false };
        }

        if (NodeType.Unknown === node.type) {
            //  we know nothing below here, which is not the same as objecting
            return { known: false, tolerated: true };
        }

        if (node.openMap) {
            //  this segment is a sysop supplied key; step into the value shape
            node = node.value;
            continue;
        }

        const child = node.children && node.children[segments[i]];
        if (!child) {
            return { known: false, tolerated: false === node.closedKeys };
        }

        node = child;
    }

    return node
        ? { node, known: true, tolerated: true }
        : { known: false, tolerated: false };
}

function buildSchema(defaultConfig, meta) {
    const config = defaultConfig || DefaultConfig();
    const metaMap = meta || DefaultMeta;
    const compiled = compileMeta(metaMap);

    let root = buildNode(config, '', compiled);

    if (NodeType.Object !== root.type) {
        //  an empty or non-object default still has to be somewhere to graft
        //  meta declared paths onto
        root = { type: NodeType.Object, closedKeys: true, children: {} };
    }

    return insertDeclaredPaths(root, metaMap, compiled);
}

module.exports = {
    buildSchema,
    resolvePath,
    lookupPath,
    NodeType,
};
