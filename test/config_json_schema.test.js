'use strict';

const { strict: assert } = require('assert');
const paths = require('path');
const fs = require('fs');
const hjson = require('hjson');

const { buildSchema, NodeType } = require('../core/config/schema');
const {
    toJsonSchema,
    serialize,
    JSON_SCHEMA_DRAFT,
    INSTALL_ROOT,
} = require('../core/config/json_schema');

const ARTIFACT_PATH = paths.join(__dirname, '../misc/config.schema.json');
const MENU_ARTIFACT_PATH = paths.join(__dirname, '../misc/menu.schema.json');

// ─── The projection itself ───────────────────────────────────────────────────

describe('config JSON Schema projection', () => {
    const convert = node =>
        toJsonSchema({ type: NodeType.Object, closedKeys: true, children: { x: node } })
            .properties.x;

    it('carries type, default, description, enum and range', () => {
        const out = convert({
            type: 'number',
            default: 8888,
            description: 'A port.',
            min: 1,
            max: 65535,
        });

        assert.equal(out.type, 'number');
        assert.equal(out.default, 8888);
        assert.equal(out.description, 'A port.');
        assert.equal(out.minimum, 1);
        assert.equal(out.maximum, 65535);
    });

    it('spells a nullable scalar as a type union', () => {
        assert.deepEqual(convert({ type: 'string', nullable: true }).type, [
            'string',
            'null',
        ]);
    });

    it('accepts anything for a node whose type could not be inferred', () => {
        assert.deepEqual(convert({ type: NodeType.Unknown }), {});
    });

    it('keeps a description on an untyped node', () => {
        assert.deepEqual(convert({ type: NodeType.Unknown, description: 'Anything.' }), {
            description: 'Anything.',
        });
    });

    it('omits items when the element shape is unknown', () => {
        const out = convert({ type: NodeType.Array, items: { type: NodeType.Unknown } });
        assert.equal(out.type, 'array');
        assert.equal(out.items, undefined);
    });

    it('emits items when the element shape is known', () => {
        const out = convert({ type: NodeType.Array, items: { type: 'string' } });
        assert.deepEqual(out.items, { type: 'string' });
    });

    it('closes an object only when the schema claims to know every key', () => {
        const closed = convert({
            type: NodeType.Object,
            closedKeys: true,
            children: { a: { type: 'string' } },
        });

        assert.equal(closed.additionalProperties, false);
        //  a leading underscore is scratch space, not configuration
        assert.deepEqual(closed.patternProperties, { '^_': true });
    });

    it('leaves an exemplar-derived object open', () => {
        //
        //  §0.1: two shipped file areas do not tell us every key a real one
        //  may carry. Emitting additionalProperties:false here would make the
        //  artifact reject "acs" and "hashTags".
        //
        const open = convert({
            type: NodeType.Object,
            closedKeys: false,
            children: { a: { type: 'string' } },
        });

        assert.equal(open.additionalProperties, undefined);
        assert.equal(open.patternProperties, undefined);
    });

    it('turns an open map into additionalProperties carrying the value shape', () => {
        const out = convert({
            type: NodeType.Object,
            openMap: true,
            closedKeys: false,
            value: { type: 'string' },
        });

        assert.deepEqual(out.additionalProperties, { type: 'string' });
    });

    it('accepts any value in an open map whose value shape is unknown', () => {
        const out = convert({
            type: NodeType.Object,
            openMap: true,
            closedKeys: false,
            value: { type: NodeType.Unknown },
        });

        assert.equal(out.additionalProperties, true);
    });

    it('offers both forms where a bare scalar is documented shorthand', () => {
        const out = convert({
            type: NodeType.Object,
            closedKeys: true,
            scalarShorthand: true,
            children: { areaTag: { type: 'string' } },
        });

        assert.equal(out.anyOf.length, 2);
        assert.equal(out.anyOf[0].type, 'object');
        assert.deepEqual(out.anyOf[1].type, ['string', 'number', 'boolean']);
    });

    it('declares the draft and an id at the root', () => {
        const doc = toJsonSchema(buildSchema());

        assert.equal(doc.$schema, JSON_SCHEMA_DRAFT);
        assert.ok(doc.$id.endsWith('/misc/config.schema.json'));
        assert.equal(doc.type, 'object');
        assert.ok(doc.$comment.includes('npm run build:schema'));
        assert.ok(doc.$comment.includes('core/config_default.js'));
    });

    it('never marks anything required', () => {
        //  a configuration file may be a fragment; "includes" and the defaults
        //  supply the rest
        const found = [];
        (function walk(value, path) {
            if (!value || 'object' !== typeof value) {
                return;
            }
            if (Array.isArray(value)) {
                return value.forEach((v, i) => walk(v, `${path}[${i}]`));
            }
            Object.entries(value).forEach(([k, v]) => {
                if ('required' === k) {
                    found.push(path);
                }
                walk(v, path ? `${path}.${k}` : k);
            });
        })(toJsonSchema(buildSchema()), '');

        assert.deepEqual(found, []);
    });
});

// ─── Guard 1: the checked-in artifact must match the generator ───────────────

describe('config JSON Schema artifact', () => {
    it('is exactly what "npm run build:schema" produces', () => {
        const generated = serialize(toJsonSchema(buildSchema()));
        const checkedIn = fs.readFileSync(ARTIFACT_PATH, 'utf8');

        assert.equal(
            generated,
            checkedIn,
            'misc/config.schema.json is stale -- run "npm run build:schema" and commit the result'
        );
    });

    it('says nothing about where this checkout happens to live', () => {
        //
        //  Roughly forty defaults in config_default.js are built from
        //  __dirname, so quoting them puts the developer's home directory in a
        //  published artifact -- and makes the staleness guard above report
        //  the difference between two checkouts as a stale file. It failed in
        //  CI for exactly that reason before this existed.
        //
        const text =
            fs.readFileSync(ARTIFACT_PATH, 'utf8') +
            fs.readFileSync(MENU_ARTIFACT_PATH, 'utf8');

        assert.ok(
            !text.includes(INSTALL_ROOT),
            `artifact quotes the installation directory (${INSTALL_ROOT}); a path default is being emitted verbatim`
        );
    });

    it('describes an installation-derived default instead of quoting it', () => {
        const logs = JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8')).properties.paths
            .properties.logs;

        assert.equal(logs.default, undefined);
        assert.equal(logs.$comment, 'Default: <installation directory>/logs/');
    });

    it('publishes the menu schema too, and keeps it current', () => {
        //  same guard, second artifact; the emitter is generic
        const { buildMenuSchema } = require('../core/config/menu_schema');

        const generated = serialize(
            toJsonSchema(buildMenuSchema(), {
                title: 'ENiGMA½ BBS menus',
                id: 'menu.schema.json',
                source: 'core/config/menu_schema.js',
            })
        );

        assert.equal(
            generated,
            fs.readFileSync(MENU_ARTIFACT_PATH, 'utf8'),
            'misc/menu.schema.json is stale -- run "npm run build:schema" and commit the result'
        );
    });

    it('gives each artifact its own id and title', () => {
        const config = JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8'));
        const menu = JSON.parse(fs.readFileSync(MENU_ARTIFACT_PATH, 'utf8'));

        assert.notEqual(config.$id, menu.$id);
        assert.ok(menu.$id.endsWith('/misc/menu.schema.json'));
        assert.match(menu.title, /menus/i);
    });

    it('is valid JSON and parses back to the same document', () => {
        const parsed = JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8'));
        assert.deepEqual(parsed, JSON.parse(JSON.stringify(toJsonSchema(buildSchema()))));
    });
});

// ─── The artifact, checked as data rather than through the emitter ───────────

//
//  A deliberately small JSON Schema subset: exactly the keywords the generator
//  emits, and no more. The coverage assertion below fails if the artifact ever
//  grows a keyword this does not implement, so the checker cannot quietly
//  become a no-op that passes everything.
//
const HANDLED = new Set([
    'type',
    'enum',
    'minimum',
    'maximum',
    'properties',
    'patternProperties',
    'additionalProperties',
    'items',
    'anyOf',
]);

//  annotations: carried through, never checked
const IGNORED = new Set([
    '$schema',
    '$id',
    'title',
    '$comment',
    'description',
    'default',
]);

function subSchemas(schema) {
    const out = [];

    if (schema.properties) {
        out.push(...Object.values(schema.properties));
    }
    if (schema.patternProperties) {
        out.push(...Object.values(schema.patternProperties));
    }
    if (schema.items) {
        out.push(schema.items);
    }
    if (schema.anyOf) {
        out.push(...schema.anyOf);
    }
    if (schema.additionalProperties && 'object' === typeof schema.additionalProperties) {
        out.push(schema.additionalProperties);
    }

    return out.filter(s => s && 'object' === typeof s);
}

function typeMatches(type, value) {
    const one = t => {
        switch (t) {
            case 'null':
                return null === value;
            case 'array':
                return Array.isArray(value);
            case 'object':
                return (
                    null !== value && 'object' === typeof value && !Array.isArray(value)
                );
            default:
                return typeof value === t;
        }
    };

    return Array.isArray(type) ? type.some(one) : one(type);
}

function check(schema, value, path, errors) {
    if (schema.anyOf) {
        const ok = schema.anyOf.some(branch => {
            const branchErrors = [];
            check(branch, value, path, branchErrors);
            return 0 === branchErrors.length;
        });

        if (!ok) {
            errors.push(`${path}: matches none of anyOf`);
        }
        return;
    }

    if (schema.type && !typeMatches(schema.type, value)) {
        errors.push(`${path}: expected ${schema.type}, got ${typeof value}`);
        return;
    }

    if (schema.enum && !schema.enum.includes(value)) {
        errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
    }

    if ('number' === typeof value) {
        if (undefined !== schema.minimum && value < schema.minimum) {
            errors.push(`${path}: below minimum`);
        }
        if (undefined !== schema.maximum && value > schema.maximum) {
            errors.push(`${path}: above maximum`);
        }
    }

    if (Array.isArray(value)) {
        if (schema.items) {
            value.forEach((entry, i) =>
                check(schema.items, entry, `${path}[${i}]`, errors)
            );
        }
        return;
    }

    if (null === value || 'object' !== typeof value) {
        return;
    }

    Object.entries(value).forEach(([key, child]) => {
        const childPath = path ? `${path}.${key}` : key;

        const direct =
            schema.properties &&
            Object.prototype.hasOwnProperty.call(schema.properties, key)
                ? schema.properties[key]
                : undefined;

        if (direct) {
            return check(direct, child, childPath, errors);
        }

        const pattern = Object.entries(schema.patternProperties || {}).find(([re]) =>
            new RegExp(re).test(key)
        );

        if (pattern) {
            return true === pattern[1]
                ? undefined
                : check(pattern[1], child, childPath, errors);
        }

        if (false === schema.additionalProperties) {
            errors.push(`${childPath}: not allowed here`);
            return;
        }

        if (schema.additionalProperties && true !== schema.additionalProperties) {
            check(schema.additionalProperties, child, childPath, errors);
        }
    });
}

//
//  What "oputil.js config new" writes: the template with its placeholders
//  replaced from the defaults, plus the handful of answers it asks for. The
//  key list is imported rather than copied so the two cannot drift.
//
function generatedConfig() {
    const _ = require('lodash');
    const { ConfigIncludeKeys } = require('../core/oputil/oputil_config');

    const defaults = require('../core/config_default')();
    const config = hjson.parse(
        fs.readFileSync(paths.join(__dirname, '../misc/config_template.in.hjson'), 'utf8')
    );

    const direct = {};
    ConfigIncludeKeys.forEach(keyPath =>
        _.set(direct, keyPath, _.get(defaults, keyPath))
    );
    _.merge(config, direct);

    config.general.boardName = 'A Test Board';
    config.logging.rotatingFile.level = 'debug';
    config.messageConferences.local = {
        name: 'Local',
        desc: 'Local Areas',
        sort: 1,
        default: true,
        areas: {
            general: {
                name: 'General',
                desc: 'General chit-chat',
                sort: 1,
                default: true,
            },
        },
    };

    return config;
}

describe('config JSON Schema fidelity', () => {
    const artifact = JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8'));

    it('uses no keyword the checker below does not implement', () => {
        const unhandled = new Set();

        (function walk(schema) {
            Object.keys(schema).forEach(key => {
                if (!HANDLED.has(key) && !IGNORED.has(key)) {
                    unhandled.add(key);
                }
            });
            subSchemas(schema).forEach(walk);
        })(artifact);

        assert.deepEqual(
            [...unhandled],
            [],
            `artifact uses keywords this test cannot check: ${[...unhandled]}`
        );
    });

    it('accepts the configuration "oputil.js config new" produces', () => {
        //
        //  §0.2 again, restated against the artifact rather than the schema
        //  tree: whatever a brand new installation ships with must validate,
        //  or the artifact is useless to the editor it exists for.
        //
        //  Built the way oputil builds it. The template on its own is not a
        //  configuration -- its values are XXXXX placeholders, so every port
        //  in it is a string -- and checking that instead would quietly stop
        //  checking types at exactly the settings most often got wrong.
        //
        const errors = [];
        check(artifact, generatedConfig(), '', errors);

        assert.deepEqual(errors, [], `generated config rejected: ${errors.join(', ')}`);
    });

    it('accepts the defaults it was derived from', () => {
        const errors = [];
        check(artifact, require('../core/config_default')(), '', errors);

        assert.deepEqual(errors, [], `defaults rejected: ${errors.join(', ')}`);
    });

    it('rejects a misspelled key inside a closed block', () => {
        const errors = [];
        check(artifact, { general: { boardname: 'x' } }, '', errors);

        assert.equal(errors.length, 1);
        assert.ok(errors[0].includes('general.boardname'));
    });

    it('tolerates an unlisted key inside a file area', () => {
        //  §0.1: acs and hashTags appear in neither shipped exemplar
        const errors = [];
        check(
            artifact,
            { fileBase: { areas: { some_area: { acs: 'GM[users]', hashTags: 'a,b' } } } },
            '',
            errors
        );

        assert.deepEqual(errors, []);
    });

    it('tolerates a "_" scratch block', () => {
        const errors = [];
        check(artifact, { _snips: { anything: 1 } }, '', errors);

        assert.deepEqual(errors, []);
    });
});
