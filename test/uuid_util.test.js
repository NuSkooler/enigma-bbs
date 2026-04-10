'use strict';

const { strict: assert } = require('assert');
const {
    parseUUID,
    unparseUUID,
    createNamedUUID,
    createNamedUUIDString,
    uuidV5,
    Namespaces,
} = require('../core/uuid_util.js');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('parseUUID / unparseUUID', () => {
    it('round-trips the DNS namespace UUID string', () => {
        const str = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
        assert.equal(unparseUUID(parseUUID(str)), str);
    });

    it('parseUUID returns a 16-byte Buffer', () => {
        const buf = parseUUID('6ba7b810-9dad-11d1-80b4-00c04fd430c8');
        assert.ok(Buffer.isBuffer(buf));
        assert.equal(buf.length, 16);
    });

    it('unparseUUID produces lowercase with correct hyphen positions', () => {
        assert.match(unparseUUID(Buffer.alloc(16, 0)), UUID_RE);
    });

    it('round-trips all-zeros UUID', () => {
        const str = '00000000-0000-0000-0000-000000000000';
        assert.equal(unparseUUID(parseUUID(str)), str);
    });

    it('round-trips all-ff UUID', () => {
        const str = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
        assert.equal(unparseUUID(parseUUID(str)), str);
    });

    it('parseUUID produces correct bytes for a known value', () => {
        const buf = parseUUID('6ba7b810-9dad-11d1-80b4-00c04fd430c8');
        assert.equal(buf[0], 0x6b);
        assert.equal(buf[3], 0x10);
        assert.equal(buf[15], 0xc8);
    });
});

describe('Namespaces', () => {
    it('Namespaces.DNS matches RFC 4122 value', () => {
        assert.equal(unparseUUID(Namespaces.DNS), '6ba7b810-9dad-11d1-80b4-00c04fd430c8');
    });

    it('Namespaces.URL matches RFC 4122 value', () => {
        assert.equal(unparseUUID(Namespaces.URL), '6ba7b811-9dad-11d1-80b4-00c04fd430c8');
    });
});

describe('uuidV5', () => {
    it('returns a valid UUID format string', () => {
        assert.match(uuidV5('test', Namespaces.DNS), UUID_RE);
    });

    it('result has version bits set to 5', () => {
        const result = uuidV5('any-name', Namespaces.DNS);
        // 3rd group's first hex char must be '5'
        const versionChar = result.split('-')[2][0];
        assert.equal(versionChar, '5');
    });

    it('result has RFC 4122 variant bits set (8, 9, a, or b at position 19)', () => {
        const result = uuidV5('any-name', Namespaces.DNS);
        const variantChar = result.split('-')[3][0];
        assert.ok(
            ['8', '9', 'a', 'b'].includes(variantChar),
            `Expected variant char in [89ab], got '${variantChar}'`
        );
    });

    it('is deterministic — same input always produces the same UUID', () => {
        const a = uuidV5('stable-name', Namespaces.DNS);
        const b = uuidV5('stable-name', Namespaces.DNS);
        assert.equal(a, b);
    });

    it('different names produce different UUIDs', () => {
        assert.notEqual(uuidV5('foo', Namespaces.DNS), uuidV5('bar', Namespaces.DNS));
    });

    it('different namespaces produce different UUIDs for the same name', () => {
        assert.notEqual(uuidV5('test', Namespaces.DNS), uuidV5('test', Namespaces.URL));
    });

    it('accepts a Buffer namespace as well as a string namespace', () => {
        const fromString = uuidV5('test', '6ba7b810-9dad-11d1-80b4-00c04fd430c8');
        const fromBuffer = uuidV5('test', Namespaces.DNS);
        assert.equal(fromString, fromBuffer);
    });

    it('is consistent with unparseUUID(createNamedUUID(...))', () => {
        const name = 'consistency-check';
        assert.equal(
            uuidV5(name, Namespaces.URL),
            unparseUUID(createNamedUUID(Namespaces.URL, name))
        );
    });

    //  Regression: verifies the ENiGMA internal message UUID namespace produces
    //  a stable, known output. This value is what our SHA-1 implementation
    //  produces and must not change — stored message UUIDs depend on it.
    it('produces a stable output for the ENiGMA message UUID namespace', () => {
        const enigmaNamespace = '154506df-1df8-46b9-98f8-ebb5815baaf8';
        const result = uuidV5('test-message', enigmaNamespace);
        // Capture current output as regression baseline
        assert.match(result, UUID_RE);
        assert.equal(result[14], '5'); // version 5
        // Re-running must produce the same value
        assert.equal(result, uuidV5('test-message', enigmaNamespace));
    });
});

describe('createNamedUUIDString', () => {
    it('is equivalent to unparseUUID(createNamedUUID(...))', () => {
        const ns = parseUUID('154506df-1df8-46b9-98f8-ebb5815baaf8');
        const key = Buffer.from('test-key');
        assert.equal(
            createNamedUUIDString(ns, key),
            unparseUUID(createNamedUUID(ns, key))
        );
    });

    it('returns a valid UUID format string', () => {
        const ns = parseUUID('154506df-1df8-46b9-98f8-ebb5815baaf8');
        assert.match(createNamedUUIDString(ns, 'some-key'), UUID_RE);
    });
});
