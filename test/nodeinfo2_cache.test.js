'use strict';

const { strict: assert } = require('assert');

describe('NodeInfo document cache', function () {
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

    //  a handler whose document build is counted and finished by hand
    function handlerWithBuilds() {
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
        const builds = [];
        handler._buildNodeInfo = cb => builds.push(cb);
        return { handler, builds };
    }

    it('builds the document once for requests that arrive while it is built', () => {
        const { handler, builds } = handlerWithBuilds();
        const got = [];
        handler._getNodeInfo(doc => got.push(doc));
        handler._getNodeInfo(doc => got.push(doc));
        assert.equal(builds.length, 1);
        assert.deepEqual(got, []);

        const doc = { version: '1.0', n: 1 };
        builds[0](doc);
        assert.deepEqual(got, [doc, doc]);
    });

    it('serves the cached document until the TTL passes, then builds it again', () => {
        const { handler, builds } = handlerWithBuilds();
        let now = 1_000_000;
        Date.now = () => now;

        handler._getNodeInfo(() => {});
        builds[0]({ n: 1 });

        let served;
        now += NodeInfoCacheTtlMs - 1;
        handler._getNodeInfo(doc => (served = doc));
        assert.equal(builds.length, 1);
        assert.deepEqual(served, { n: 1 });

        now += 2;
        handler._getNodeInfo(doc => (served = doc));
        assert.equal(builds.length, 2);
        builds[1]({ n: 2 });
        assert.deepEqual(served, { n: 2 });
    });

    it('keeps the TTL short (minutes, not hours)', () => {
        assert.ok(NodeInfoCacheTtlMs >= 60 * 1000);
        assert.ok(NodeInfoCacheTtlMs <= 15 * 60 * 1000);
    });

    it('still answers the other waiters when one response throws', () => {
        const { handler, builds } = handlerWithBuilds();
        let answered = false;
        handler._getNodeInfo(() => {
            throw new Error('socket gone');
        });
        handler._getNodeInfo(() => (answered = true));
        builds[0]({ n: 1 });
        assert.ok(answered);
    });
});
