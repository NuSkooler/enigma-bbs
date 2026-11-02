'use strict';

//
//  Outbound fetch budget for inbox-triggered GETs (#966).
//
//  Handling one inbox POST can fetch several remote documents: the actor,
//  the signing key's actor, WebFinger for their handles, a forwarded Note,
//  an announced Note and its author... Without a limit, anyone who can POST
//  to the inbox can make the board fetch as much as they like, from hosts
//  of their choosing.
//
//  The budget is implicit: _inboxPostHandler runs its work inside run(),
//  which opens a per-POST store in an AsyncLocalStorage, and http_util's
//  _makeRequest() calls acquire() for every GET. Callers in between
//  (Actor.fromId(), WebFinger, boost_util, ...) need not know about it.
//  Outside a store, a GET is unbudgeted. A store is ignored once older
//  than StoreMaxAgeMs, so a long-lived thing first created during a POST
//  (a queue, a timer) does not carry that POST's budget forever.
//
//  The limits fail fast, nothing is queued:
//    - per POST:     at most MaxFetchesPerPost fetches
//    - per host:     perHostConcurrency in flight, perHostPerMinute
//    - board wide:   globalConcurrency in flight, globalPerMinute
//  Rates are token buckets holding a minute's worth of tokens, refilled
//  continuously. A refused fetch marks the store exceeded; the inbox then
//  answers 503 with Retry-After rather than refusing the activity.
//
//  A host is the initial URL's hostname: a redirect chain is one fetch,
//  counted against the host first asked.
//

const { Errors, ErrorReasons } = require('../enig_error.js');
const { AsyncLocalStorage } = require('node:async_hooks');

//  read through the module each time: tests swap config.get and the logger
const Config = () => require('../config').get();
const Log = () => require('../logger.js').log;

const StoreMaxAgeMs = 2 * 60 * 1000;
const MaxFetchesPerPost = 16;

const DefaultLimits = {
    perHostConcurrency: 4,
    perHostPerMinute: 60,
    globalConcurrency: 32,
    globalPerMinute: 600,
};

const storage = new AsyncLocalStorage();

let now = () => Date.now();

//  host -> { inFlight, tokens, updatedAt }
const hosts = new Map();
let boardBucket = null;
let lastSweep = 0;

function _newBucket(perMinute) {
    return { inFlight: 0, tokens: perMinute, updatedAt: now() };
}

//  top the bucket up for the time since it was last looked at
function _refill(bucket, perMinute) {
    const t = now();
    const elapsed = Math.max(0, t - bucket.updatedAt);
    bucket.tokens = Math.min(perMinute, bucket.tokens + (elapsed * perMinute) / 60000);
    bucket.updatedAt = t;
}

//  The configured limits, read per acquire (config hot-reloads); anything
//  that is not a positive number falls back to its default
function _limits() {
    let configured;
    try {
        configured = Config().contentServers.web.handlers.activityPub.outboundFetchLimits;
    } catch {
        configured = null;
    }
    configured = configured || {};
    const limits = {};
    for (const [name, def] of Object.entries(DefaultLimits)) {
        const v = configured[name];
        limits[name] = typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : def;
    }
    return limits;
}

//  Drop idle hosts (nothing in flight, bucket full): a new entry starts
//  full, so forgetting one changes nothing. At most once a minute.
function _sweep(limits) {
    const t = now();
    if (t - lastSweep < 60000) {
        return;
    }
    lastSweep = t;
    for (const [host, bucket] of hosts) {
        _refill(bucket, limits.perHostPerMinute);
        if (bucket.inFlight === 0 && bucket.tokens >= limits.perHostPerMinute) {
            hosts.delete(host);
        }
    }
}

//  The current POST's store, or null outside one (or past its age guard)
function _liveStore() {
    const store = storage.getStore();
    if (!store || now() - store.startedAt > StoreMaxAgeMs) {
        return null;
    }
    return store;
}

//
//  Run fn(store) inside a new per-POST store. Whatever fn starts, sync or
//  async, sees the store.
//
function run(fn) {
    const store = { startedAt: now(), fetches: 0, exceeded: false };
    return storage.run(store, () => fn(store));
}
exports.run = run;

//  True when a fetch was refused for budget in the current POST
function exceeded() {
    const store = storage.getStore();
    return !!(store && store.exceeded);
}
exports.exceeded = exceeded;

//
//  Admit a GET to |url|, or refuse it. Returns { release } when admitted
//  (release() must be called once the request is done; extra calls are
//  ignored), or { error } when refused. Outside a live store every GET is
//  admitted, unbudgeted.
//
function acquire(url) {
    const store = _liveStore();
    if (!store) {
        return { release: () => {} };
    }

    let host;
    try {
        host = new URL(url).hostname.toLowerCase();
    } catch {
        host = String(url).toLowerCase();
    }

    const limits = _limits();
    _sweep(limits);

    let hostBucket = hosts.get(host);
    if (!hostBucket) {
        hostBucket = _newBucket(limits.perHostPerMinute);
        hosts.set(host, hostBucket);
    }
    if (!boardBucket) {
        boardBucket = _newBucket(limits.globalPerMinute);
    }
    _refill(hostBucket, limits.perHostPerMinute);
    _refill(boardBucket, limits.globalPerMinute);

    //  every limit is checked before anything is spent
    let limit = null;
    if (store.fetches >= MaxFetchesPerPost) {
        limit = 'per-POST fetches';
    } else if (hostBucket.inFlight >= limits.perHostConcurrency) {
        limit = 'per-host concurrency';
    } else if (hostBucket.tokens < 1) {
        limit = 'per-host rate';
    } else if (boardBucket.inFlight >= limits.globalConcurrency) {
        limit = 'global concurrency';
    } else if (boardBucket.tokens < 1) {
        limit = 'global rate';
    }

    if (limit) {
        store.exceeded = true;
        Log().warn({ host, limit }, 'Outbound fetch refused: fetch budget exceeded');
        return {
            error: Errors.General(
                `Outbound fetch to "${host}" refused: ${limit} limit reached`,
                ErrorReasons.FetchBudget
            ),
        };
    }

    store.fetches += 1;
    hostBucket.tokens -= 1;
    hostBucket.inFlight += 1;
    boardBucket.tokens -= 1;
    boardBucket.inFlight += 1;

    const counted = boardBucket;
    let released = false;
    return {
        release: () => {
            if (released) {
                return;
            }
            released = true;
            hostBucket.inFlight = Math.max(0, hostBucket.inFlight - 1);
            counted.inFlight = Math.max(0, counted.inFlight - 1);
        },
    };
}
exports.acquire = acquire;

//  True for the error acquire() refuses a fetch with
function isBudgetError(err) {
    return !!err && err.reasonCode === ErrorReasons.FetchBudget;
}
exports.isBudgetError = isBudgetError;

exports.MaxFetchesPerPost = MaxFetchesPerPost;
exports.StoreMaxAgeMs = StoreMaxAgeMs;
exports.DefaultLimits = DefaultLimits;

//  for tests: a stand-in clock, and forgetting all state
exports._setClock = fn => {
    now = fn || (() => Date.now());
};
exports._reset = () => {
    hosts.clear();
    boardBucket = null;
    lastSweep = 0;
};
exports._state = () => ({ hosts, boardBucket });
