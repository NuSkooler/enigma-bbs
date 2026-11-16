'use strict';

const { strict: assert } = require('assert');

describe('NodeInfo usage cache', function () {
    let NodeInfo2, NodeInfoCacheTtlMs, NodeInfoFailureTtlMs;
    let realNow;

    before(() => {
        ({
            getModule: NodeInfo2,
            NodeInfoCacheTtlMs,
            NodeInfoFailureTtlMs,
        } = require('../core/servers/content/web_handlers/nodeinfo2.js'));
        realNow = Date.now;
    });

    afterEach(() => {
        Date.now = realNow;
    });

    //  a handler whose usage computation is counted and finished by hand
    function handlerWithRuns() {
        const handler = new NodeInfo2();
        const noop = () => {};
        handler.log = {
            fatal: noop,
            error: noop,
            warn: noop,
            info: noop,
            debug: noop,
            trace: noop,
        };
        const runs = [];
        handler._computeUsage = cb => runs.push(cb);
        return { handler, runs };
    }

    it('computes the counts once for requests that arrive while they are computed', () => {
        const { handler, runs } = handlerWithRuns();
        const got = [];
        handler._getUsage(u => got.push(u));
        handler._getUsage(u => got.push(u));
        assert.equal(runs.length, 1);
        assert.deepEqual(got, []);

        const usage = { localPosts: 3 };
        runs[0](usage, true);
        assert.deepEqual(got, [usage, usage]);
    });

    it('serves the cached counts until the TTL passes, then computes them again', () => {
        const { handler, runs } = handlerWithRuns();
        let now = 1_000_000;
        Date.now = () => now;

        handler._getUsage(() => {});
        runs[0]({ localPosts: 1 }, true);

        let served;
        now += NodeInfoCacheTtlMs - 1;
        handler._getUsage(u => (served = u));
        assert.equal(runs.length, 1);
        assert.deepEqual(served, { localPosts: 1 });

        now += 2;
        handler._getUsage(u => (served = u));
        assert.equal(runs.length, 2);
        runs[1]({ localPosts: 2 }, true);
        assert.deepEqual(served, { localPosts: 2 });
    });

    it('serves counts from a failed run for a minute, not the full TTL', () => {
        const { handler, runs } = handlerWithRuns();
        let now = 1_000_000;
        Date.now = () => now;

        let served;
        handler._getUsage(u => (served = u));
        runs[0]({ localPosts: 4 }, false);
        assert.deepEqual(served, { localPosts: 4 });

        now += NodeInfoFailureTtlMs - 1;
        handler._getUsage(() => {});
        assert.equal(runs.length, 1, 'a poll within the minute does not query again');

        now += 2;
        handler._getUsage(() => {});
        assert.equal(runs.length, 2, 'queried again once the minute has passed');
        assert.ok(NodeInfoFailureTtlMs < NodeInfoCacheTtlMs);
    });

    it('answers every waiter, and recovers, when the computation throws', () => {
        const handler = new NodeInfo2();
        const noop = () => {};
        handler.log = { warn: noop, info: noop, debug: noop, error: noop, trace: noop };
        let calls = 0;
        handler._computeUsage = () => {
            ++calls;
            throw new Error('stat log unavailable');
        };

        let now = 1_000_000;
        Date.now = () => now;
        const got = [];
        handler._getUsage(u => got.push(u));
        assert.deepEqual(got, [{}]);

        handler._getUsage(() => {});
        assert.equal(calls, 1, 'the failure is kept for a minute');
        now += NodeInfoFailureTtlMs + 1;
        handler._getUsage(u => got.push(u));
        assert.equal(calls, 2, 'a later request computes again');
        assert.deepEqual(got, [{}, {}]);
    });

    it('still answers the other waiters when one response throws', () => {
        const { handler, runs } = handlerWithRuns();
        let answered = false;
        handler._getUsage(() => {
            throw new Error('socket gone');
        });
        handler._getUsage(() => (answered = true));
        runs[0]({ localPosts: 1 }, true);
        assert.ok(answered);
    });

    it('builds the rest of the document on every request', () => {
        const { handler, runs } = handlerWithRuns();
        let name = 'First Name';
        handler._baseNodeInfo = () => ({
            server: { name },
            usage: { users: { total: 1 } },
        });

        let doc;
        handler._getNodeInfo(d => (doc = d));
        runs[0]({ localPosts: 5 }, true);
        assert.equal(doc.server.name, 'First Name');
        assert.equal(doc.usage.localPosts, 5);

        name = 'Renamed Board';
        handler._getNodeInfo(d => (doc = d));
        assert.equal(runs.length, 1, 'counts still cached');
        assert.equal(doc.server.name, 'Renamed Board');
        assert.equal(doc.usage.localPosts, 5);
    });

    it('keeps the TTL short (minutes, not hours)', () => {
        assert.ok(NodeInfoCacheTtlMs >= 60 * 1000);
        assert.ok(NodeInfoCacheTtlMs <= 15 * 60 * 1000);
    });
});
