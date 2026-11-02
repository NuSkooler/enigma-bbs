'use strict';

//
//  #966: the inbox fetch budget (core/activitypub/fetch_budget.js), its use
//  in http_util, and the negative caches (core/activitypub/negative_cache.js)
//  with WebFinger's. The actor-lookup and inbox sides are tested with the
//  rest of the inbox in activitypub_note.test.js.
//

const { strict: assert } = require('assert');
const http = require('node:http');

const configModule = require('../core/config.js');
const loggerModule = require('../core/logger.js');
const FetchBudget = require('../core/activitypub/fetch_budget.js');
const NegCache = require('../core/activitypub/negative_cache.js');
const HttpUtil = require('../core/http_util.js');
const WebFinger = require('../core/webfinger.js');
const { Errors, ErrorReasons, ErrorCodes } = require('../core/enig_error.js');

//  a config with |limits| as outboundFetchLimits, and |ap| merged in
function apConfig(limits, ap = {}) {
    return {
        debug: { assertsEnabled: false },
        menus: { cls: false },
        general: { boardName: 'TestBoard' },
        contentServers: {
            web: {
                handlers: {
                    activityPub: Object.assign({ outboundFetchLimits: limits }, ap),
                },
            },
        },
    };
}

describe('fetch budget (#966)', function () {
    let clock;
    let savedConfig;
    let savedLog;
    let warns;

    const useLimits = limits => {
        configModule.get = () => apConfig(limits);
    };
    const tick = ms => {
        clock += ms;
    };
    const budgetError = (slot, limit) => {
        assert.ok(slot.error, 'refused');
        assert.ok(FetchBudget.isBudgetError(slot.error));
        assert.equal(slot.error.reasonCode, ErrorReasons.FetchBudget);
        assert.ok(
            !['ECONNREFUSED', 'ECONNRESET', 'EPROTO'].includes(slot.error.code),
            'not a code WebFinger falls back to http:// on'
        );
        if (limit) {
            assert.ok(slot.error.message.includes(limit), slot.error.message);
        }
    };

    //  moved on ten minutes per test: a test that calls done() inside run()
    //  hands mocha's next step that store, which must be stale by then
    let testStart = 1000000;
    beforeEach(() => {
        testStart += 10 * 60 * 1000;
        clock = testStart;
        FetchBudget._setClock(() => clock);
        savedConfig = configModule.get;
        useLimits({});
        warns = [];
        savedLog = loggerModule.log;
        loggerModule.log = Object.assign({}, savedLog, {
            warn: (...args) => warns.push(args),
        });
    });

    afterEach(() => {
        FetchBudget._setClock(null);
        configModule.get = savedConfig;
        loggerModule.log = savedLog;
    });

    it('admits everything outside a store, unbudgeted', () => {
        useLimits({ perHostConcurrency: 1, perHostPerMinute: 1 });
        for (let i = 0; i < 50; ++i) {
            assert.ok(!FetchBudget.acquire('https://a.example/x').error);
        }
        assert.equal(FetchBudget._state().hosts.size, 0);
    });

    it('limits concurrency per host', () => {
        useLimits({ perHostConcurrency: 2 });
        FetchBudget.run(store => {
            const a1 = FetchBudget.acquire('https://a.example/1');
            const a2 = FetchBudget.acquire('https://A.example/2');
            budgetError(
                FetchBudget.acquire('https://a.example/3'),
                'per-host concurrency'
            );
            assert.ok(!FetchBudget.acquire('https://b.example/1').error, 'another host');
            assert.equal(store.exceeded, true);

            a1.release();
            assert.ok(!FetchBudget.acquire('https://a.example/4').error, 'a slot freed');
            a2.release();
        });
        assert.equal(warns.length, 1, 'one warn per refusal');
        assert.deepEqual(warns[0][0], {
            host: 'a.example',
            limit: 'per-host concurrency',
        });
    });

    it('limits concurrency board wide', () => {
        useLimits({ globalConcurrency: 3 });
        FetchBudget.run(() => {
            ['a', 'b', 'c'].forEach(h => {
                assert.ok(!FetchBudget.acquire(`https://${h}.example/`).error);
            });
            budgetError(FetchBudget.acquire('https://d.example/'), 'global concurrency');
        });
    });

    it('empties a host bucket, and refills it as time passes', () => {
        useLimits({ perHostPerMinute: 2 });
        FetchBudget.run(() => {
            FetchBudget.acquire('https://a.example/').release();
            FetchBudget.acquire('https://a.example/').release();
            budgetError(FetchBudget.acquire('https://a.example/'), 'per-host rate');

            tick(30 * 1000); // half a minute: one token
            const slot = FetchBudget.acquire('https://a.example/');
            assert.ok(!slot.error);
            slot.release();
            budgetError(FetchBudget.acquire('https://a.example/'), 'per-host rate');
        });
    });

    it('empties the board-wide bucket', () => {
        useLimits({ globalPerMinute: 3 });
        FetchBudget.run(() => {
            ['a', 'b', 'c'].forEach(h =>
                FetchBudget.acquire(`https://${h}.example/`).release()
            );
            budgetError(FetchBudget.acquire('https://d.example/'), 'global rate');
            tick(20 * 1000);
            assert.ok(!FetchBudget.acquire('https://d.example/').error);
        });
    });

    it('spends nothing on a refused fetch', () => {
        useLimits({ globalConcurrency: 1, perHostPerMinute: 5 });
        FetchBudget.run(store => {
            const held = FetchBudget.acquire('https://a.example/');
            budgetError(FetchBudget.acquire('https://b.example/'), 'global concurrency');
            assert.ok(
                !FetchBudget._state().hosts.has('b.example'),
                'no entry, so no host token spent'
            );
            assert.equal(FetchBudget._state().boardBucket.inFlight, 1);
            assert.equal(store.fetches, 1, 'not counted against the POST');
            held.release();
        });
    });

    it('releases once, however often release() is called', () => {
        FetchBudget.run(() => {
            const slot = FetchBudget.acquire('https://a.example/');
            const other = FetchBudget.acquire('https://a.example/');
            slot.release();
            slot.release();
            assert.equal(FetchBudget._state().hosts.get('a.example').inFlight, 1);
            assert.equal(FetchBudget._state().boardBucket.inFlight, 1);
            other.release();
        });
    });

    it(`caps a POST at ${FetchBudget.MaxFetchesPerPost} fetches`, () => {
        useLimits({ perHostPerMinute: 1000, globalPerMinute: 1000 });
        FetchBudget.run(() => {
            for (let i = 0; i < FetchBudget.MaxFetchesPerPost; ++i) {
                FetchBudget.acquire(`https://h${i}.example/`).release();
            }
            budgetError(FetchBudget.acquire('https://late.example/'), 'per-POST');
        });
        FetchBudget.run(store => {
            assert.ok(!FetchBudget.acquire('https://late.example/').error, 'a new POST');
            assert.equal(store.exceeded, false);
        });
    });

    it('ignores a store older than two minutes', () => {
        useLimits({ perHostConcurrency: 1 });
        FetchBudget.run(store => {
            FetchBudget.acquire('https://a.example/');
            tick(FetchBudget.StoreMaxAgeMs + 1);
            assert.ok(!FetchBudget.acquire('https://a.example/').error, 'unbudgeted');
            assert.equal(store.fetches, 1);
            assert.equal(store.exceeded, false);
        });
    });

    it('carries the store through async work started in it', done => {
        useLimits({ perHostConcurrency: 1 });
        FetchBudget.run(store => {
            FetchBudget.acquire('https://a.example/');
            setImmediate(() => {
                budgetError(FetchBudget.acquire('https://a.example/'));
                assert.equal(FetchBudget.exceeded(), true);
                assert.equal(store.exceeded, true);
                return done();
            });
        });
    });

    it('reads the limits per acquire, and falls back on garbage values', () => {
        useLimits({
            perHostConcurrency: 'lots',
            perHostPerMinute: -1,
            globalConcurrency: 0,
            globalPerMinute: 0.5, // below 1: would admit nothing
        });
        FetchBudget.run(() => {
            const held = [];
            for (let i = 0; i < FetchBudget.DefaultLimits.perHostConcurrency; ++i) {
                const slot = FetchBudget.acquire('https://a.example/');
                assert.ok(!slot.error);
                held.push(slot);
            }
            budgetError(
                FetchBudget.acquire('https://a.example/'),
                'per-host concurrency'
            );

            //  hot-reloaded
            useLimits({ perHostConcurrency: 10 });
            assert.ok(!FetchBudget.acquire('https://a.example/').error);
        });
    });

    it('keeps no entry for a host it refuses', () => {
        FetchBudget.run(store => {
            store.fetches = FetchBudget.MaxFetchesPerPost;
            for (let i = 0; i < 100; ++i) {
                budgetError(FetchBudget.acquire(`https://h${i}.example/`), 'per-POST');
            }
        });
        assert.equal(FetchBudget._state().hosts.size, 0);
    });

    it('charges a redirect hop a host rate token and a POST fetch', () => {
        useLimits({ perHostPerMinute: 2 });
        FetchBudget.run(store => {
            assert.equal(FetchBudget.chargeRedirect('https://v.example/1'), null);
            assert.equal(FetchBudget._state().hosts.get('v.example').inFlight, 0);
            assert.equal(FetchBudget.chargeRedirect('https://v.example/2'), null);
            budgetError(
                { error: FetchBudget.chargeRedirect('https://v.example/3') },
                'per-host rate'
            );
            assert.equal(store.fetches, 2);

            store.fetches = FetchBudget.MaxFetchesPerPost;
            budgetError(
                { error: FetchBudget.chargeRedirect('https://w.example/') },
                'per-POST'
            );
            assert.ok(!FetchBudget._state().hosts.has('w.example'));
        });
        assert.equal(
            FetchBudget.chargeRedirect('https://v.example/4'),
            null,
            'unbudgeted'
        );
    });

    it('budgets background work without marking the POST exceeded', () => {
        useLimits({ perHostConcurrency: 1 });
        FetchBudget.run(store => {
            const held = FetchBudget.acquire('https://a.example/');
            FetchBudget.background(() => {
                assert.ok(!FetchBudget.acquire('https://b.example/').error);
                budgetError(
                    FetchBudget.acquire('https://a.example/'),
                    'per-host concurrency'
                );
                assert.equal(
                    FetchBudget.exceeded(),
                    true,
                    "the background work's own flag"
                );
            });
            assert.equal(store.exceeded, false, 'the POST is not exceeded');
            assert.equal(FetchBudget.exceeded(), false);
            assert.equal(store.fetches, 2, 'background fetches count against the POST');
            held.release();
        });
        //  outside a store, just runs
        let ran = false;
        FetchBudget.background(() => {
            ran = true;
        });
        assert.ok(ran);
    });

    it('forgets idle hosts', () => {
        FetchBudget.run(() => {
            FetchBudget.acquire('https://idle.example/').release();
            const busy = FetchBudget.acquire('https://busy.example/');
            tick(2 * 60 * 1000);
            FetchBudget.acquire('https://other.example/').release();
            const hosts = FetchBudget._state().hosts;
            assert.ok(!hosts.has('idle.example'), 'swept');
            assert.ok(hosts.has('busy.example'), 'kept: a fetch in flight');
            busy.release();
        });
    });
});

describe('http_util GETs inside a fetch budget (#966)', function () {
    let server;
    let port;
    let requests;
    let savedConfig;
    let hang;

    const url = (p = '/doc') => `http://127.0.0.1:${port}${p}`;
    const useLimits = limits => {
        //  plain http to a loopback literal needs allowInsecureHttp
        configModule.get = () => apConfig(limits, { allowInsecureHttp: true });
    };
    const inFlight = () => {
        const host = FetchBudget._state().hosts.get('127.0.0.1');
        return host ? host.inFlight : 0;
    };

    before(done => {
        server = http.createServer((req, res) => {
            requests.push(`${req.method} ${req.url}`);
            if (hang) {
                return; // never answers
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        });
        server.listen(0, '127.0.0.1', () => {
            port = server.address().port;
            return done();
        });
    });

    after(done => {
        server.closeAllConnections();
        server.close(done);
    });

    //  A test that calls done() inside run() hands mocha's next step that
    //  store (async context carries through setImmediate). Each test moves
    //  the clock on ten minutes, so a store an earlier one left is stale.
    let clock = 1e9;

    beforeEach(() => {
        requests = [];
        hang = false;
        savedConfig = configModule.get;
        useLimits({});
        clock += 10 * 60 * 1000;
        FetchBudget._setClock(() => clock);
    });

    afterEach(() => {
        configModule.get = savedConfig;
        FetchBudget._setClock(null);
    });

    it('counts a GET, and releases its slot when it finishes', done => {
        FetchBudget.run(store => {
            HttpUtil.getJson(url(), {}, (err, json) => {
                assert.ifError(err);
                assert.equal(json.ok, true);
                assert.equal(store.fetches, 1);
                assert.equal(inFlight(), 0, 'released');
                return done();
            });
            assert.equal(inFlight(), 1, 'held while in flight');
        });
    });

    it('releases the slot of a GET that fails', done => {
        FetchBudget.run(() => {
            HttpUtil.getJson(url(), { validContentTypes: ['text/x-nope'] }, err => {
                assert.ok(err);
                assert.equal(inFlight(), 0);
                return done();
            });
        });
    });

    it('releases the slot of a GET that times out', done => {
        hang = true;
        FetchBudget.run(() => {
            HttpUtil.getJson(url(), { timeout: 100 }, err => {
                assert.ok(err);
                assert.equal(inFlight(), 0);
                return done();
            });
        });
    });

    it('does not count a POST', done => {
        useLimits({ perHostPerMinute: 1 });
        FetchBudget.run(store => {
            HttpUtil.postJson(url('/inbox'), { a: 1 }, { headers: {} }, err => {
                assert.ifError(err);
                HttpUtil.postJson(url('/inbox'), { a: 2 }, { headers: {} }, err => {
                    assert.ifError(err);
                    assert.equal(store.fetches, 0);
                    assert.equal(store.exceeded, false);
                    return done();
                });
            });
        });
    });

    it('refuses a GET over budget with the budget error, without connecting', done => {
        useLimits({ perHostPerMinute: 1 });
        FetchBudget.run(store => {
            HttpUtil.getJson(url('/one'), {}, err => {
                assert.ifError(err);
                HttpUtil.getJson(url('/two'), {}, err => {
                    assert.ok(FetchBudget.isBudgetError(err), `err: ${err}`);
                    assert.equal(store.exceeded, true);
                    assert.deepEqual(requests, ['GET /one']);
                    return done();
                });
            });
        });
    });

    //  The budget relies on the caller's async context reaching its
    //  callback, including on a pooled socket made outside the store
    it("calls back in the caller's store, on a socket made outside it", done => {
        HttpUtil.getJson(url('/warm'), {}, err => {
            assert.ifError(err);
            FetchBudget.run(store => {
                HttpUtil.getJson(url('/reuse'), {}, err => {
                    assert.ifError(err);
                    HttpUtil.getJson(url('/next'), {}, err => {
                        assert.ifError(err);
                        assert.equal(store.fetches, 2, 'both counted in this store');
                        return done();
                    });
                });
            });
        });
    });

    it('does not budget a GET outside a store', done => {
        useLimits({ perHostPerMinute: 1 });
        HttpUtil.getJson(url('/one'), {}, err => {
            assert.ifError(err);
            HttpUtil.getJson(url('/two'), {}, err => {
                assert.ifError(err);
                assert.equal(requests.length, 2);
                return done();
            });
        });
    });
});

describe('negative cache (#966)', function () {
    let clock;

    beforeEach(() => {
        clock = 5000000;
        NegCache._setClock(() => clock);
    });

    afterEach(() => {
        NegCache._setClock(null);
    });

    const httpError = status => {
        const err = Errors.HttpError(`HTTP error ${status}`);
        err.statusCode = status;
        return err;
    };

    it('remembers definite failures for 15 minutes', () => {
        const definite = [
            httpError(404),
            httpError(410),
            httpError(401),
            Errors.ValidationFailed('x'),
            Errors.Invalid('x'),
            Errors.DoesNotExist('x'),
            Errors.AccessDenied('x', ErrorReasons.BlockedAddress),
        ];
        definite.forEach(err =>
            assert.equal(NegCache.failureTtlMs(err), NegCache.DefiniteTtlMs, err.message)
        );
    });

    it('remembers transient failures for 2 minutes', () => {
        const reset = new Error('socket hang up');
        reset.code = 'ECONNRESET';
        const transient = [
            httpError(500),
            httpError(503),
            httpError(408),
            httpError(429),
            Errors.Timeout('x'),
            reset,
            new Error('anything else'),
        ];
        transient.forEach(err =>
            assert.equal(NegCache.failureTtlMs(err), NegCache.TransientTtlMs, err.message)
        );
    });

    it('never remembers a budget refusal', () => {
        const err = Errors.General('refused', ErrorReasons.FetchBudget);
        assert.equal(NegCache.failureTtlMs(err), 0);
        const cache = new NegCache.NegativeCache();
        cache.set('k', err);
        assert.equal(cache.size, 0);
        assert.equal(cache.get('k'), null);
    });

    it('gives back the error, and forgets it once expired', () => {
        const cache = new NegCache.NegativeCache();
        cache.set('k', httpError(503));
        const hit = cache.get('k');
        assert.equal(hit.message, 'HTTP error: HTTP error 503');
        assert.equal(hit.code, ErrorCodes.HttpError);
        assert.equal(hit.statusCode, 503);
        assert.equal(hit.negativeCached, true);

        clock += NegCache.TransientTtlMs;
        assert.equal(cache.get('k'), null);
        assert.equal(cache.size, 0);
    });

    it("gives back a redirected failure's responseUrl", () => {
        const cache = new NegCache.NegativeCache();
        const err = httpError(410);
        err.responseUrl = 'https://other.ssrf-fixture.net/users/alice';
        cache.set('redirected', err);
        cache.set('direct', httpError(410));
        assert.equal(
            cache.get('redirected').responseUrl,
            'https://other.ssrf-fixture.net/users/alice'
        );
        assert.ok(!('responseUrl' in cache.get('direct')), 'none made up');
    });

    it('keeps at most maxEntries, dropping the oldest', () => {
        const cache = new NegCache.NegativeCache(3);
        ['a', 'b', 'c'].forEach(k => cache.set(k, httpError(404)));
        cache.set('a', httpError(404)); // refreshed: now the newest
        cache.set('d', httpError(404));
        assert.equal(cache.size, 3);
        assert.equal(cache.get('b'), null, 'the oldest went');
        ['a', 'c', 'd'].forEach(k => assert.ok(cache.get(k), k));
    });

    it('is bounded to 5000 entries by default', () => {
        const cache = new NegCache.NegativeCache();
        for (let i = 0; i < 5100; ++i) {
            cache.set(`k${i}`, httpError(404));
        }
        assert.equal(cache.size, 5000);
        assert.equal(cache.get('k0'), null);
        assert.ok(cache.get('k5099'));
    });

    it('resetAll() empties every cache', () => {
        const cache = new NegCache.NegativeCache();
        cache.set('k', httpError(404));
        NegCache.resetAll();
        assert.equal(cache.size, 0);
    });

    it('a config reload empties every cache (allowedPrivateAddresses may have changed)', () => {
        const Events = require('../core/events.js');
        const cache = new NegCache.NegativeCache();
        cache.set('k', Errors.AccessDenied('x', ErrorReasons.BlockedAddress));
        assert.ok(
            Events.listeners(Events.getSystemEvents().ConfigChanged).includes(
                NegCache._onConfigChanged
            ),
            'listening for ConfigChanged'
        );
        //  called directly: emitting it would reach every other listener too
        NegCache._onConfigChanged();
        assert.equal(cache.size, 0);
    });

    describe('WebFinger', function () {
        //  https to a loopback literal is refused before any connection
        //  (AccessDenied), which makes a definite failure with no network
        const query = '@alice@127.0.0.1:9';

        let savedConfig;
        beforeEach(() => {
            savedConfig = configModule.get;
            configModule.get = () => apConfig({});
        });
        afterEach(() => {
            configModule.get = savedConfig;
        });

        const finger = () =>
            new Promise(resolve => WebFinger.queryWebFinger(query, err => resolve(err)));

        it('remembers a failed lookup until it expires', async () => {
            const first = await finger();
            assert.equal(first.code, ErrorCodes.AccessDenied);
            assert.ok(!first.negativeCached);

            const second = await finger();
            assert.equal(second.negativeCached, true);
            assert.equal(second.message, first.message);

            clock += NegCache.DefiniteTtlMs;
            const third = await finger();
            assert.ok(!third.negativeCached, 'asked again');
        });

        it('never remembers a lookup the budget refused', async () => {
            const savedAcquire = FetchBudget.acquire;
            FetchBudget.acquire = () => ({
                error: Errors.General('refused', ErrorReasons.FetchBudget),
            });
            let refused;
            try {
                //  the literal check comes first, so use a name: refused
                //  by the budget before any lookup
                refused = await new Promise(resolve =>
                    WebFinger.queryWebFinger('@alice@budget.ssrf-fixture.net', err =>
                        resolve(err)
                    )
                );
            } finally {
                FetchBudget.acquire = savedAcquire;
            }
            assert.ok(FetchBudget.isBudgetError(refused), `err: ${refused}`);

            //  asked again (and refused for real now: no such host)
            const savedLookup = require('node:dns').lookup;
            require('node:dns').lookup = (host, opts, cb) => {
                const err = new Error(`getaddrinfo ENOTFOUND ${host}`);
                err.code = 'ENOTFOUND';
                process.nextTick(() => cb(err));
            };
            let again;
            try {
                again = await new Promise(resolve =>
                    WebFinger.queryWebFinger('@alice@budget.ssrf-fixture.net', err =>
                        resolve(err)
                    )
                );
            } finally {
                require('node:dns').lookup = savedLookup;
            }
            assert.ok(!FetchBudget.isBudgetError(again));
            assert.ok(!again.negativeCached);
        });
    });
});

describe('outboundFetchLimits in the config schema (#966)', function () {
    const _ = require('lodash');
    const { buildSchema } = require('../core/config/schema.js');
    const { validateConfig } = require('../core/config/validate.js');

    const issues = limits => {
        const user = {
            contentServers: {
                web: { handlers: { activityPub: { outboundFetchLimits: limits } } },
            },
        };
        const merged = _.merge({}, require('../core/config_default.js')(), user);
        return validateConfig(user, merged, buildSchema()).map(
            i => `${i.code}:${i.path.split('.').pop()}`
        );
    };

    it('accepts the defaults, a rate of 1 and a fractional rate', () => {
        assert.deepEqual(issues(FetchBudget.DefaultLimits), []);
        assert.deepEqual(issues({ perHostPerMinute: 1, globalPerMinute: 1.5 }), []);
    });

    it('reports a fractional concurrency and anything below 1', () => {
        assert.deepEqual(
            issues({
                perHostConcurrency: 2.5,
                perHostPerMinute: 0,
                globalConcurrency: 0,
                globalPerMinute: 0.5,
            }).sort(),
            [
                'typeMismatch:perHostConcurrency',
                'valueOutOfRange:globalConcurrency',
                'valueOutOfRange:globalPerMinute',
                'valueOutOfRange:perHostPerMinute',
            ]
        );
    });
});

describe('allowedPrivateAddresses in the config schema (#966)', function () {
    const _ = require('lodash');
    const { buildSchema } = require('../core/config/schema.js');
    const { validateConfig } = require('../core/config/validate.js');

    const issues = value => {
        const user = {
            contentServers: {
                web: { handlers: { activityPub: { allowedPrivateAddresses: value } } },
            },
        };
        const merged = _.merge({}, require('../core/config_default.js')(), user);
        return validateConfig(user, merged, buildSchema()).map(i => i.code);
    };

    it('defaults to an empty list, and accepts a list of strings', () => {
        assert.deepEqual(
            require('../core/config_default.js')().contentServers.web.handlers.activityPub
                .allowedPrivateAddresses,
            []
        );
        assert.deepEqual(issues(['10.0.0.0/8', 'fd00::/8', '192.168.1.5']), []);
    });

    it('reports a value that is not a list', () => {
        assert.deepEqual(issues('10.0.0.0/8'), ['typeMismatch']);
    });
});
