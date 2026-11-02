'use strict';

//
//  In-memory negative caches for remote lookups (#966): a lookup that just
//  failed is not repeated for a while, so the same unreachable or bogus
//  actor named in POST after POST does not cost a fetch each time.
//
//  A definite failure (the remote said no, or what it sent was refused) is
//  remembered for DefiniteTtlMs; anything that may clear up by itself
//  (timeouts, 5xx, 408/429, connection errors) for TransientTtlMs. A fetch
//  refused by the fetch budget says nothing about the remote and is never
//  remembered. Each cache holds at most maxEntries, the oldest dropped first.
//

const { EnigError, ErrorCodes } = require('../enig_error.js');
const { isBudgetError } = require('./fetch_budget.js');

const DefiniteTtlMs = 15 * 60 * 1000;
const TransientTtlMs = 2 * 60 * 1000;
const DefaultMaxEntries = 5000;

const DefiniteErrorCodes = [
    ErrorCodes.ValidationFailed,
    ErrorCodes.Invalid,
    ErrorCodes.DoesNotExist,
    ErrorCodes.AccessDenied, // a literal or resolved-address refusal
];

//  How long |err| should be remembered, in ms; 0 for not at all
function failureTtlMs(err) {
    if (!err || isBudgetError(err)) {
        return 0;
    }
    const status = err.statusCode;
    if (Number.isInteger(status) && status >= 400 && status < 500) {
        return status === 408 || status === 429 ? TransientTtlMs : DefiniteTtlMs;
    }
    if (DefiniteErrorCodes.includes(err.code)) {
        return DefiniteTtlMs;
    }
    return TransientTtlMs;
}

let now = () => Date.now();
const instances = [];

class NegativeCache {
    constructor(maxEntries = DefaultMaxEntries) {
        this.maxEntries = maxEntries;
        this.entries = new Map(); // key -> { expiresAt, message, code, reasonCode, statusCode }
        instances.push(this);
    }

    //  A copy of the remembered error for |key|, or null
    get(key) {
        const entry = this.entries.get(key);
        if (!entry) {
            return null;
        }
        if (now() >= entry.expiresAt) {
            this.entries.delete(key);
            return null;
        }
        const err = new EnigError(entry.message, entry.code);
        err.reasonCode = entry.reasonCode;
        err.statusCode = entry.statusCode;
        err.negativeCached = true;
        return err;
    }

    //  Remember |err| for |key|, unless it is not worth remembering
    set(key, err) {
        const ttl = failureTtlMs(err);
        if (!ttl) {
            return;
        }
        //  re-inserted at the end: Map order is the eviction order
        this.entries.delete(key);
        while (this.entries.size >= this.maxEntries) {
            this.entries.delete(this.entries.keys().next().value);
        }
        this.entries.set(key, {
            expiresAt: now() + ttl,
            message: err.message,
            code: err.code,
            reasonCode: err.reasonCode,
            statusCode: err.statusCode,
        });
    }

    delete(key) {
        this.entries.delete(key);
    }

    clear() {
        this.entries.clear();
    }

    get size() {
        return this.entries.size;
    }
}

exports.NegativeCache = NegativeCache;
exports.failureTtlMs = failureTtlMs;
exports.DefiniteTtlMs = DefiniteTtlMs;
exports.TransientTtlMs = TransientTtlMs;

//  for tests: forget every cache's entries, and a stand-in clock
exports.resetAll = () => instances.forEach(c => c.clear());
exports._setClock = fn => {
    now = fn || (() => Date.now());
};
