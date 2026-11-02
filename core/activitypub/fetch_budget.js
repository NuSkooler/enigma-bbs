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
//  A host is the URL's hostname. A redirect hop (http_util follows at most
//  3) costs the host it lands on a rate token and the POST a fetch, but
//  runs in the first host's concurrency slot (chargeRedirect()).
//
//  Work a POST starts that its answer does not depend on (refreshing an
//  actor already cached) runs in background(): budgeted the same, but a
//  refusal does not mark the POST exceeded.
//

const { Errors, ErrorReasons } = require('../enig_error.js');
const { AsyncLocalStorage } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');

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

//  monotonic: a wall clock stepped back would refill buckets wrongly
const monotonicNow = () => performance.now();
let now = monotonicNow;

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
//  that is not a number of at least 1 falls back to its default (a rate
//  below 1 would never hold a whole token, and so admit nothing)
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
        limits[name] = typeof v === 'number' && Number.isFinite(v) && v >= 1 ? v : def;
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
    if (!store) {
        return null;
    }
    //  a negative age is a store from another clock (a test's): stale too
    const age = now() - store.startedAt;
    return age >= 0 && age <= StoreMaxAgeMs ? store : null;
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

//
//  Run fn() as background work of the current POST: its fetches still count
//  against the POST and every limit, but a refusal does not mark the POST
//  exceeded, as nothing the POST answers with depends on them (the refresh
//  of an actor already cached, say). Outside a live store, just fn().
//
function background(fn) {
    const store = _liveStore();
    if (!store) {
        return fn();
    }
    const post = store.post || store;
    const child = { startedAt: post.startedAt, post, exceeded: false, background: true };
    return storage.run(child, fn);
}
exports.background = background;

//  True when a fetch was refused for budget in the current POST
function exceeded() {
    const store = storage.getStore();
    return !!(store && store.exceeded);
}
exports.exceeded = exceeded;

function _hostOf(url) {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return String(url).toLowerCase();
    }
}

//  The host's bucket, topped up; a host with no entry has a full one,
//  which is only kept (insert()) once a fetch is admitted
function _hostBucket(host, limits) {
    const bucket = hosts.get(host);
    if (!bucket) {
        const fresh = _newBucket(limits.perHostPerMinute);
        return { bucket: fresh, insert: () => hosts.set(host, fresh) };
    }
    _refill(bucket, limits.perHostPerMinute);
    return { bucket, insert: () => {} };
}

function _refuse(store, host, limit) {
    store.exceeded = true;
    Log().warn({ host, limit }, 'Outbound fetch refused: fetch budget exceeded');
    return Errors.General(
        `Outbound fetch to "${host}" refused: ${limit} limit reached`,
        ErrorReasons.FetchBudget
    );
}

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
    const post = store.post || store;
    const host = _hostOf(url);

    const limits = _limits();
    _sweep(limits);

    const { bucket: hostBucket, insert } = _hostBucket(host, limits);
    if (!boardBucket) {
        boardBucket = _newBucket(limits.globalPerMinute);
    }
    _refill(boardBucket, limits.globalPerMinute);

    //  every limit is checked before anything is spent
    let limit = null;
    if (post.fetches >= MaxFetchesPerPost) {
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
        return { error: _refuse(store, host, limit) };
    }

    insert();
    post.fetches += 1;
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

//
//  Charge a redirect hop to |url|: a per-host rate token for the host it
//  lands on, and one of the POST's fetches. The hop runs in the slot the
//  first request holds, so concurrency stays with the first host. Returns
//  null when admitted (or outside a live store), or the budget error.
//
function chargeRedirect(url) {
    const store = _liveStore();
    if (!store) {
        return null;
    }
    const post = store.post || store;
    const host = _hostOf(url);
    const limits = _limits();
    const { bucket, insert } = _hostBucket(host, limits);

    if (post.fetches >= MaxFetchesPerPost) {
        return _refuse(store, host, 'per-POST fetches (redirect)');
    }
    if (bucket.tokens < 1) {
        return _refuse(store, host, 'per-host rate (redirect)');
    }

    insert();
    post.fetches += 1;
    bucket.tokens -= 1;
    return null;
}
exports.chargeRedirect = chargeRedirect;

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
    now = fn || monotonicNow;
};
exports._reset = () => {
    hosts.clear();
    boardBucket = null;
    lastSweep = 0;
};
exports._state = () => ({ hosts, boardBucket });
