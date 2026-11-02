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
//  A config reload forgets everything: a lookup refused for an address the
//  operator has just listed in allowedPrivateAddresses (or for the board's
//  own URL, just changed) should be tried again now, not in 15 minutes.
//  A lookup already in flight then must not store a refusal made under the
//  old config: callers take a token() when a lookup starts and pass it to
//  set(), which drops the failure if the cache was cleared since.
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

let listeningForConfigChanges = false;
function listenForConfigChanges() {
    if (listeningForConfigChanges) {
        return;
    }
    listeningForConfigChanges = true;
    const Events = require('../events.js');
    Events.on(Events.getSystemEvents().ConfigChanged, onConfigChanged);
}
function onConfigChanged() {
    resetAll();
}

class NegativeCache {
    constructor(maxEntries = DefaultMaxEntries) {
        this.maxEntries = maxEntries;
        this.entries = new Map(); // key -> { expiresAt, message, code, reasonCode, statusCode, responseUrl }
        this.generation = 0; // bumped by clear()
        instances.push(this);
        listenForConfigChanges();
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
        if (entry.responseUrl) {
            err.responseUrl = entry.responseUrl;
        }
        err.negativeCached = true;
        return err;
    }

    //  Taken when a lookup starts (before any fetch), for set()
    token() {
        return this.generation;
    }

    //  Remember |err| for |key|, unless it is not worth remembering, or
    //  |token| (optional, from token()) shows the cache was cleared while
    //  the lookup was in flight: the failure may be stale (a config reload)
    set(key, err, token) {
        if (token !== undefined && token !== this.generation) {
            return;
        }
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
            responseUrl: err.responseUrl, // where a redirected fetch ended up
        });
    }

    delete(key) {
        this.entries.delete(key);
    }

    clear() {
        this.entries.clear();
        ++this.generation;
    }

    get size() {
        return this.entries.size;
    }
}

exports.NegativeCache = NegativeCache;
exports.failureTtlMs = failureTtlMs;
exports.DefiniteTtlMs = DefiniteTtlMs;
exports.TransientTtlMs = TransientTtlMs;

//  forget every cache's entries (on a config reload; and for tests), and,
//  for tests, a stand-in clock
function resetAll() {
    instances.forEach(c => c.clear());
}
exports.resetAll = resetAll;
exports._onConfigChanged = onConfigChanged; // exported for tests
exports._setClock = fn => {
    now = fn || (() => Date.now());
};
