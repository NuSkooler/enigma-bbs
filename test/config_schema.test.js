'use strict';

const { strict: assert } = require('assert');
const paths = require('path');
const fs = require('fs');
const hjson = require('hjson');

//  No load-time Config() dependency here -- require directly.
const {
    buildSchema,
    resolvePath,
    lookupPath,
    NodeType,
} = require('../core/config/schema');
const Meta = require('../core/config/meta');

// ─── Derivation from a default value ─────────────────────────────────────────

describe('config schema derivation', () => {
    const build = (defaults, meta = {}) => buildSchema(defaults, meta);

    it('types scalars from their default and records the default', () => {
        const s = build({ a: 'str', b: 7, c: true });
        assert.equal(resolvePath(s, 'a').type, NodeType.String);
        assert.equal(resolvePath(s, 'a').default, 'str');
        assert.equal(resolvePath(s, 'b').type, NodeType.Number);
        assert.equal(resolvePath(s, 'c').type, NodeType.Boolean);
    });

    it('recurses into non-empty objects and marks them closed', () => {
        const s = build({ outer: { inner: { leaf: 1 } } });
        assert.equal(resolvePath(s, 'outer').closedKeys, true);
        assert.equal(resolvePath(s, 'outer.inner.leaf').type, NodeType.Number);
    });

    it('gives up on an empty object rather than calling it a closed object', () => {
        const s = build({ nothing: {} });
        assert.equal(resolvePath(s, 'nothing').type, NodeType.Unknown);
    });

    it('gives up on null but records that null is legal', () => {
        const s = build({ unset: null });
        const node = resolvePath(s, 'unset');
        assert.equal(node.type, NodeType.Unknown);
        assert.equal(node.nullable, true);
    });

    it('types an array of homogeneous scalars', () => {
        const s = build({ list: ['a', 'b'] });
        const node = resolvePath(s, 'list');
        assert.equal(node.type, NodeType.Array);
        assert.equal(node.items.type, NodeType.String);
    });

    it('says nothing about the elements of an empty or mixed array', () => {
        const s = build({ empty: [], mixed: [1, 'two'] });
        assert.equal(resolvePath(s, 'empty').items, undefined);
        assert.equal(resolvePath(s, 'mixed').items, undefined);
    });

    it('derives an element shape for an array of homogeneous objects', () => {
        const s = build({ sigs: [{ ext: '.dms' }, { ext: '.lha' }] });
        const node = resolvePath(s, 'sigs');
        assert.equal(node.type, NodeType.Array);
        assert.equal(node.items.type, NodeType.Object);
        assert.equal(node.items.children.ext.type, NodeType.String);
    });
});

// ─── meta overlay ────────────────────────────────────────────────────────────

describe('config schema meta overlay', () => {
    it('lets meta declare a type inference could not supply', () => {
        const s = buildSchema({ enc: null }, { enc: { type: 'string', nullable: true } });
        const node = resolvePath(s, 'enc');
        assert.equal(node.type, NodeType.String);
        assert.equal(node.nullable, true);
    });

    it('lets meta override an inferred type', () => {
        const s = buildSchema({ n: 1 }, { n: { type: 'string' } });
        assert.equal(resolvePath(s, 'n').type, NodeType.String);
    });

    it('carries description, enum and range through to the node', () => {
        const s = buildSchema(
            { mode: 'warn' },
            { mode: { enum: ['warn', 'off'], description: 'why', min: 1, max: 9 } }
        );
        const node = resolvePath(s, 'mode');
        assert.deepEqual(node.enum, ['warn', 'off']);
        assert.equal(node.description, 'why');
        assert.equal(node.min, 1);
        assert.equal(node.max, 9);
    });

    it('grafts on a path the defaults never declare, creating parents', () => {
        const s = buildSchema({}, { 'a.b.c': { type: 'boolean' } });
        assert.equal(resolvePath(s, 'a.b.c').type, NodeType.Boolean);
        //  invented parents stay permissive: knowing a section exists is not
        //  the same as knowing every key in it
        assert.equal(resolvePath(s, 'a').closedKeys, false);
    });

    it('matches a "*" segment against exactly one open map key', () => {
        const s = buildSchema(
            { confs: { one: { areas: { a: { name: 'A' } } } } },
            { confs: { openMap: true }, 'confs.*.areas': { openMap: true } }
        );
        assert.equal(resolvePath(s, 'confs').openMap, true);
        assert.equal(resolvePath(s, 'confs.anything.areas').openMap, true);
    });
});

// ─── Open maps ───────────────────────────────────────────────────────────────

describe('config schema open maps', () => {
    it('does not treat example keys as a key list', () => {
        const s = buildSchema(
            { areas: { sample: { name: 'S' } } },
            { areas: { openMap: true } }
        );
        const node = resolvePath(s, 'areas');
        assert.equal(node.openMap, true);
        assert.equal(node.closedKeys, false);
        assert.equal(node.children, undefined);
    });

    it('derives the value shape from the examples', () => {
        const s = buildSchema(
            { areas: { one: { name: 'A', n: 1 }, two: { name: 'B', n: 2 } } },
            { areas: { openMap: true } }
        );
        assert.equal(resolvePath(s, 'areas.whatever.name').type, NodeType.String);
        assert.equal(resolvePath(s, 'areas.whatever.n').type, NodeType.Number);
    });

    it('leaves the derived value shape open, so an unlisted key is tolerated', () => {
        //  §0.1: two shipped file areas do not enumerate every legal key
        const s = buildSchema(
            { areas: { one: { name: 'A' } } },
            { areas: { openMap: true } }
        );
        assert.equal(resolvePath(s, 'areas.whatever').closedKeys, false);
        const r = lookupPath(s, 'areas.whatever.acs');
        assert.equal(r.known, false);
        assert.equal(r.tolerated, true);
    });

    it('prefers an explicit meta value shape over the examples', () => {
        const s = buildSchema(
            { tags: { sample: { unexpected: true } } },
            { tags: { openMap: true, value: { type: 'string' } } }
        );
        assert.equal(resolvePath(s, 'tags.anything').type, NodeType.String);
    });

    it('says nothing when the examples disagree', () => {
        const s = buildSchema(
            { m: { a: { k: 1 }, b: ['nope'] } },
            { m: { openMap: true } }
        );
        assert.equal(resolvePath(s, 'm.anything').type, NodeType.Unknown);
    });

    it('supports an open map with no default at all', () => {
        const s = buildSchema({}, { 'net.networks': { openMap: true } });
        const node = resolvePath(s, 'net.networks');
        assert.equal(node.openMap, true);
        assert.equal(node.closedKeys, false);
    });
});

// ─── lookupPath: known vs tolerated vs neither ───────────────────────────────

describe('config schema lookupPath', () => {
    const s = buildSchema(
        { general: { boardName: 'x' }, areas: { one: { name: 'A' } } },
        { areas: { openMap: true } }
    );

    it('reports a described path as known', () => {
        assert.equal(lookupPath(s, 'general.boardName').known, true);
    });

    it('reports an undescribed key under a closed object as neither', () => {
        const r = lookupPath(s, 'general.boardnam');
        assert.equal(r.known, false);
        assert.equal(r.tolerated, false);
    });

    it('reports an open map key as tolerated', () => {
        assert.equal(lookupPath(s, 'areas.anything.acs').tolerated, true);
    });

    it('tolerates everything beneath an unknown node', () => {
        const u = buildSchema({ blob: null }, {});
        assert.equal(lookupPath(u, 'blob.deep.deeper').tolerated, true);
    });
});

// ─── Against the real configuration ──────────────────────────────────────────

describe('config schema against config_default.js', () => {
    const schema = buildSchema();

    it('builds without throwing and produces a closed object at the root', () => {
        assert.equal(schema.type, NodeType.Object);
        assert.equal(schema.closedKeys, true);
        assert.ok(Object.keys(schema.children).length > 20);
    });

    it('every meta path resolves to a node', () => {
        const unresolved = Object.keys(Meta)
            .filter(p => !p.includes('*'))
            .filter(p => !resolvePath(schema, p));

        assert.deepEqual(
            unresolved,
            [],
            `meta paths that resolve to nothing: ${unresolved}`
        );
    });

    it('every meta open map really is an open map in the built schema', () => {
        const broken = Object.entries(Meta)
            .filter(([, entry]) => entry.openMap)
            .filter(([p]) => !p.includes('*'))
            .filter(([p]) => {
                const node = resolvePath(schema, p);
                return !node || true !== node.openMap;
            })
            .map(([p]) => p);

        assert.deepEqual(broken, [], `declared open maps that are not open: ${broken}`);
    });

    it('types the three nodes whose default carries no type', () => {
        //  Guard 4: this set must not grow silently.
        assert.equal(
            resolvePath(schema, 'term.forceOutputEncoding').type,
            NodeType.String
        );
        assert.equal(
            resolvePath(schema, 'email.outbound.fromDomain').type,
            NodeType.String
        );
        assert.equal(
            resolvePath(schema, 'contentServers.nntp.publicMessageConferences').openMap,
            true
        );
    });

    it('finds no untyped node that meta has not accounted for', () => {
        //  Guard 4, stated as a walk: any node left Unknown must be one meta
        //  deliberately left alone, not a new null/{} default nobody noticed.
        const declared = new Set(Object.keys(Meta));
        const orphans = [];

        (function walk(node, path, isMapValue) {
            if (!node) {
                return;
            }

            //
            //  An open map's value shape is allowed to be Unknown: with no
            //  example entries -- messageNetworks.ftn.networks has none, since
            //  the whole section is absent from the defaults -- there is
            //  genuinely nothing to infer. That is the documented fail-open
            //  outcome, not an unannotated null.
            //
            if (
                !isMapValue &&
                NodeType.Unknown === node.type &&
                path &&
                !declared.has(path)
            ) {
                orphans.push(path);
            }

            Object.entries(node.children || {}).forEach(([k, child]) =>
                walk(child, path ? `${path}.${k}` : k, false)
            );

            if (node.value) {
                walk(node.value, path ? `${path}.*` : '*', true);
            }
        })(schema, '', false);

        assert.deepEqual(orphans, [], `untyped nodes missing from meta: ${orphans}`);
    });

    it('knows or tolerates every path in the shipped config template', () => {
        //
        //  §0.2 regression: the template is what "oputil.js config new"
        //  produces, so anything it contains is by definition legitimate. A
        //  path here that is neither known nor tolerated would surface as a
        //  false unknownKey on a brand new installation.
        //
        const templatePath = paths.join(__dirname, '../misc/config_template.in.hjson');
        const template = hjson.parse(
            fs.readFileSync(templatePath, 'utf8').replace(/\{\{[^}]*\}\}/g, 'x')
        );

        const rejected = [];
        (function walk(value, path) {
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                return;
            }
            Object.keys(value).forEach(key => {
                const childPath = path ? `${path}.${key}` : key;
                const r = lookupPath(schema, childPath);
                if (!r.known && !r.tolerated) {
                    rejected.push(childPath);
                    return; //  no point walking beneath a rejected path
                }
                walk(value[key], childPath);
            });
        })(template, '');

        assert.deepEqual(
            rejected,
            [],
            `template paths the schema would reject: ${rejected.join(', ')}`
        );
    });
});
