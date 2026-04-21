/* jslint node: true */
'use strict';

const createHash = require('crypto').createHash;

// Well-known UUID namespaces (RFC 4122)
const Namespaces = {
    DNS: parseUUID('6ba7b810-9dad-11d1-80b4-00c04fd430c8'),
    URL: parseUUID('6ba7b811-9dad-11d1-80b4-00c04fd430c8'),
    OID: parseUUID('6ba7b812-9dad-11d1-80b4-00c04fd430c8'),
    X500: parseUUID('6ba7b814-9dad-11d1-80b4-00c04fd430c8'),
};

exports.createNamedUUID = createNamedUUID;
exports.createNamedUUIDString = createNamedUUIDString;
exports.parseUUID = parseUUID;
exports.unparseUUID = unparseUUID;
exports.uuidV5 = uuidV5;
exports.Namespaces = Namespaces;

// Parse a UUID string (with or without dashes) into a 16-byte Buffer
function parseUUID(uuidStr) {
    const hex = uuidStr.replace(/-/g, '');
    return Buffer.from(hex, 'hex');
}

// Unparse a 16-byte Buffer into a lowercase UUID string
function unparseUUID(buf) {
    const h = buf.toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(
        16,
        20
    )}-${h.slice(20)}`;
}

// Generate a v5 UUID Buffer from a namespace Buffer and a key Buffer/string
function createNamedUUID(namespaceUuid, key) {
    //
    //  v5 UUID generation code based on the work here:
    //  https://github.com/download13/uuidv5/blob/master/uuid.js
    //
    if (!Buffer.isBuffer(namespaceUuid)) {
        namespaceUuid = Buffer.from(namespaceUuid);
    }

    if (!Buffer.isBuffer(key)) {
        key = Buffer.from(key);
    }

    let digest = createHash('sha1')
        .update(Buffer.concat([namespaceUuid, key]))
        .digest();

    let u = Buffer.alloc(16);

    // bbbb - bb - bb - bb - bbbbbb
    digest.copy(u, 0, 0, 4); // time_low
    digest.copy(u, 4, 4, 6); // time_mid
    digest.copy(u, 6, 6, 8); // time_hi_and_version

    u[6] = (u[6] & 0x0f) | 0x50; // version, 4 most significant bits are set to version 5 (0101)
    u[8] = (digest[8] & 0x3f) | 0x80; // clock_seq_hi_and_reserved, 2msb are set to 10
    u[9] = digest[9];

    digest.copy(u, 10, 10, 16);

    return u;
}

// Generate a v5 UUID string from a value string and a namespace (Buffer or string)
function uuidV5(value, namespace) {
    if (!Buffer.isBuffer(namespace)) {
        namespace = parseUUID(namespace);
    }
    return unparseUUID(createNamedUUID(namespace, value));
}

// Convenience: generate a v5 UUID string from a namespace Buffer and key Buffer/string
function createNamedUUIDString(namespaceUuid, key) {
    return unparseUUID(createNamedUUID(namespaceUuid, key));
}
