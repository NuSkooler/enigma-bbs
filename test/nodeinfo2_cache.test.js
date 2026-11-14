'use strict';

const { strict: assert } = require('assert');

describe('NodeInfo usage cache', function () {
    let NodeInfo2, NodeInfoCacheTtlMs;
    let realNow;

    before(() => {
        ({
            getModule: NodeInfo2,
            NodeInfoCacheTtlMs,
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

    it('serves but does not cache counts from a run in which a query failed', () => {
        const { handler, runs } = handlerWithRuns();
        let served;
        handler._getUsage(u => (served = u));
        runs[0]({ activeMonth: 4 }, false);
        assert.deepEqual(served, { activeMonth: 4 });

        handler._getUsage(u => (served = u));
        assert.equal(runs.length, 2, 'computed again rather than served from cache');
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

        const got = [];
        handler._getUsage(u => got.push(u));
        assert.deepEqual(got, [{}]);

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
