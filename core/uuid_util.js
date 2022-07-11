/* jslint node: true */
'use strict';

const createHash = require('crypto').createHash;

exports.createNamedUUID = createNamedUUID;

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
