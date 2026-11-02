'use strict';

//
//  Web server rate limits are per client: behind a trusted reverse proxy that
//  is the forwarded address. Idle keys are dropped.
//

const { strict: assert } = require('assert');

const configModule = require('../core/config.js');
const configDefault = require('../core/config_default.js');
const {
    RateLimiter,
    getModule: WebServerModule,
} = require('../core/servers/content/web.js');

const DefaultTrusted = configDefault().trustedProxies;

describe('RateLimiter', function () {
    const opts = { windowMs: 1000, maxRequests: 2 };
    let realNow;
    let now;

    beforeEach(() => {
        realNow = Date.now;
        now = 1000000;
        Date.now = () => now;
    });

    afterEach(() => {
        Date.now = realNow;
    });

    it('limits each address and key on its own', () => {
        const limiter = new RateLimiter();
        assert.ok(limiter.check('1.2.3.4', 'k', opts));
        assert.ok(limiter.check('1.2.3.4', 'k', opts));
        assert.ok(!limiter.check('1.2.3.4', 'k', opts));
        assert.ok(limiter.check('5.6.7.8', 'k', opts));
        assert.ok(limiter.check('1.2.3.4', 'other', opts));

        now += opts.windowMs;
        assert.ok(limiter.check('1.2.3.4', 'k', opts));
    });

    it('drops keys whose window has passed', () => {
        const limiter = new RateLimiter({ sweepIntervalMs: 500 });
        limiter.check('1.2.3.4', 'k', opts);
        limiter.check('5.6.7.8', 'k', { windowMs: 10000, maxRequests: 2 });
        assert.equal(limiter.size, 2);

        //  not yet time to sweep
        now += 400;
        limiter.check('9.9.9.9', 'k', opts);
        assert.equal(limiter.size, 3);

        //  1.2.3.4 is idle past its window; 5.6.7.8 has a longer one
        now += 700;
        limiter.check('9.9.9.10', 'k', opts);
        assert.equal(limiter.size, 3);
        assert.ok(!limiter._windows.has('1.2.3.4:k'));
        assert.ok(limiter._windows.has('5.6.7.8:k'));
        assert.ok(limiter._windows.has('9.9.9.9:k'));
    });
});

describe('WebServerModule.checkRateLimit()', function () {
    const opts = { windowMs: 60000, maxRequests: 1 };
    let prevConfig;

    before(() => {
        prevConfig = configModule._pushTestConfig({ trustedProxies: DefaultTrusted });
    });

    after(() => {
        configModule._popTestConfig(prevConfig);
    });

    function makeWeb() {
        const web = Object.create(WebServerModule.prototype);
        web._rateLimiter = new RateLimiter();
        web.warnings = [];
        web.log = { warn: obj => web.warnings.push(obj) };
        web.rateLimitExceeded = () => {};
        return web;
    }

    function request(peerAddress, headers = {}) {
        return { socket: { remoteAddress: peerAddress }, headers };
    }

    it('gives each client behind a trusted proxy its own bucket', () => {
        const web = makeWeb();
        const viaProxy = client => request('127.0.0.1', { 'x-forwarded-for': client });

        assert.ok(web.checkRateLimit(viaProxy('1.2.3.4'), {}, 'k', opts));
        assert.ok(web.checkRateLimit(viaProxy('5.6.7.8'), {}, 'k', opts));
        assert.ok(!web.checkRateLimit(viaProxy('1.2.3.4'), {}, 'k', opts));
        assert.deepEqual(web.warnings, [{ ip: '1.2.3.4', key: 'k' }]);
    });

    it('keys an untrusted peer on its own address', () => {
        const web = makeWeb();
        const spoofed = client => request('203.0.113.9', { 'x-forwarded-for': client });

        assert.ok(web.checkRateLimit(spoofed('1.2.3.4'), {}, 'k', opts));
        assert.ok(!web.checkRateLimit(spoofed('5.6.7.8'), {}, 'k', opts));
        assert.deepEqual(web.warnings, [{ ip: '203.0.113.9', key: 'k' }]);
    });
});
