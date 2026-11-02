'use strict';

//
//  Client addresses behind reverse proxies: X-Forwarded-For / X-Real-IP are
//  believed only from a peer in trustedProxies, and read right to left.
//

const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const paths = require('path');

const loggerModule = require('../core/logger.js');
const configModule = require('../core/config.js');
const configDefault = require('../core/config_default.js');
const {
    getClientAddress,
    getRequestClientAddress,
    isTrustedProxy,
    hasForwardedHeaders,
} = require('../core/client_address.js');

const DefaultTrusted = configDefault().trustedProxies;

function resolve(peerAddress, headers, trustedProxies = DefaultTrusted) {
    return getClientAddress({ peerAddress, headers, trustedProxies });
}

describe('trustedProxies default', function () {
    it('covers loopback and the private ranges', () => {
        for (const address of [
            '127.0.0.1',
            '127.1.2.3',
            '::1',
            '10.1.2.3',
            '172.16.0.1',
            '172.31.255.254',
            '192.168.1.10',
            'fd12:3456::1',
        ]) {
            assert.ok(isTrustedProxy(address, DefaultTrusted), address);
        }
    });

    it('does not cover public addresses', () => {
        for (const address of ['8.8.8.8', '172.32.0.1', '2001:db8::1', '::2']) {
            assert.ok(!isTrustedProxy(address, DefaultTrusted), address);
        }
    });

    it('matches an IPv4-mapped IPv6 peer by its IPv4 address', () => {
        assert.ok(isTrustedProxy('::ffff:127.0.0.1', DefaultTrusted));
        assert.ok(isTrustedProxy('::FFFF:192.168.0.5', DefaultTrusted));
        assert.ok(!isTrustedProxy('::ffff:8.8.8.8', DefaultTrusted));
        assert.ok(isTrustedProxy('::ffff:203.0.113.7', ['203.0.113.7']));
        assert.ok(isTrustedProxy('203.0.113.7', ['::ffff:203.0.113.7']));
    });
});

describe('getClientAddress()', function () {
    it('ignores forwarded headers from an untrusted peer', () => {
        const r = resolve('203.0.113.9', {
            'x-forwarded-for': '1.2.3.4',
            'x-real-ip': '5.6.7.8',
        });
        assert.deepEqual(r, {
            address: '203.0.113.9',
            forwarded: false,
            peerTrusted: false,
        });
    });

    it('uses the peer address when a trusted peer forwards nothing', () => {
        assert.deepEqual(resolve('127.0.0.1', {}), {
            address: '127.0.0.1',
            forwarded: false,
            peerTrusted: true,
        });
        assert.equal(resolve('127.0.0.1', undefined).address, '127.0.0.1');
    });

    it('takes a single X-Forwarded-For entry from a trusted peer', () => {
        const r = resolve('::ffff:127.0.0.1', { 'x-forwarded-for': '1.2.3.4' });
        assert.deepEqual(r, { address: '1.2.3.4', forwarded: true, peerTrusted: true });
    });

    it('takes the right-most untrusted entry of a multi-hop header', () => {
        //  client-written 9.9.9.9 is left of the real client and not believed
        assert.equal(
            resolve('127.0.0.1', { 'x-forwarded-for': '9.9.9.9, 1.2.3.4, 10.0.0.2' })
                .address,
            '1.2.3.4'
        );
        assert.equal(
            resolve('127.0.0.1', { 'x-forwarded-for': '9.9.9.9,1.2.3.4' }).address,
            '1.2.3.4'
        );
    });

    it('treats a proxy on a public address as a hop once listed', () => {
        const trusted = DefaultTrusted.concat('198.51.100.0/24');
        assert.equal(
            resolve(
                '198.51.100.20',
                { 'x-forwarded-for': '1.2.3.4, 198.51.100.21' },
                trusted
            ).address,
            '1.2.3.4'
        );
    });

    it('joins repeated X-Forwarded-For headers', () => {
        assert.equal(
            resolve('127.0.0.1', { 'x-forwarded-for': ['9.9.9.9', '1.2.3.4'] }).address,
            '1.2.3.4'
        );
        assert.equal(
            resolve('127.0.0.1', { 'x-forwarded-for': ['1.2.3.4', '10.0.0.2'] }).address,
            '1.2.3.4'
        );
    });

    it('uses the left-most entry when every entry is trusted', () => {
        assert.equal(
            resolve('127.0.0.1', { 'x-forwarded-for': '192.168.1.5, 10.0.0.2' }).address,
            '192.168.1.5'
        );
        const loopback = resolve('127.0.0.1', { 'x-forwarded-for': '127.0.0.1' });
        assert.deepEqual(loopback, {
            address: '127.0.0.1',
            forwarded: true,
            peerTrusted: true,
        });
    });

    it('stops at an invalid entry and keeps the nearest good hop', () => {
        //  "unknown" ends the walk; 10.0.0.2 is the last address vouched for
        assert.equal(
            resolve('127.0.0.1', { 'x-forwarded-for': '1.2.3.4, unknown, 10.0.0.2' })
                .address,
            '10.0.0.2'
        );
        //  an untrusted entry right of the bad one is found first anyway
        assert.equal(
            resolve('127.0.0.1', { 'x-forwarded-for': 'garbage, 1.2.3.4' }).address,
            '1.2.3.4'
        );
    });

    it('falls back when the right-most entry is invalid', () => {
        assert.deepEqual(resolve('127.0.0.1', { 'x-forwarded-for': '1.2.3.4, nope' }), {
            address: '127.0.0.1',
            forwarded: false,
            peerTrusted: true,
        });
        assert.equal(
            resolve('127.0.0.1', {
                'x-forwarded-for': '1.2.3.4, nope',
                'x-real-ip': '5.6.7.8',
            }).address,
            '5.6.7.8'
        );
    });

    it('skips empty entries', () => {
        assert.equal(
            resolve('127.0.0.1', { 'x-forwarded-for': ' , 1.2.3.4,  ' }).address,
            '1.2.3.4'
        );
    });

    it('accepts bracketed IPv6 and IPv4 with a port', () => {
        assert.equal(
            resolve('127.0.0.1', { 'x-forwarded-for': '[2001:db8::5]' }).address,
            '2001:db8::5'
        );
        assert.equal(
            resolve('127.0.0.1', { 'x-forwarded-for': '[2001:db8::5]:4711' }).address,
            '2001:db8::5'
        );
        assert.equal(
            resolve('127.0.0.1', { 'x-forwarded-for': '1.2.3.4:5678' }).address,
            '1.2.3.4'
        );
        assert.equal(
            resolve('127.0.0.1', { 'x-forwarded-for': '2001:db8::7' }).address,
            '2001:db8::7'
        );
        //  brackets around something that is not IPv6
        assert.equal(
            resolve('127.0.0.1', { 'x-forwarded-for': '[1.2.3.4]' }).address,
            '127.0.0.1'
        );
    });

    it('rejects IPv6 zone ids', () => {
        //  a zone id ends the walk like any other invalid entry
        assert.equal(
            resolve('127.0.0.1', { 'x-forwarded-for': '1.2.3.4, fe80::1%eth0' }).address,
            '127.0.0.1'
        );
        assert.equal(
            resolve('127.0.0.1', { 'x-forwarded-for': '[fe80::1%25eth0]:80' }).address,
            '127.0.0.1'
        );
        assert.equal(
            resolve('127.0.0.1', { 'x-real-ip': 'fe80::1%eth0' }).address,
            '127.0.0.1'
        );
    });

    it('returns a forwarded IPv4-mapped address as plain IPv4', () => {
        assert.equal(
            resolve('127.0.0.1', { 'x-forwarded-for': '::ffff:1.2.3.4' }).address,
            '1.2.3.4'
        );
        assert.equal(
            resolve('127.0.0.1', { 'x-forwarded-for': '[::FFFF:1.2.3.4]:443' }).address,
            '1.2.3.4'
        );
        assert.equal(
            resolve('127.0.0.1', { 'x-real-ip': '::ffff:5.6.7.8' }).address,
            '5.6.7.8'
        );
    });

    it('leaves the peer address as the socket gave it', () => {
        assert.equal(resolve('::ffff:203.0.113.9', {}).address, '::ffff:203.0.113.9');
        assert.equal(resolve('::ffff:127.0.0.1', {}).address, '::ffff:127.0.0.1');
    });

    it('treats a private address the proxy sees as another hop by default', () => {
        //  the default list covers the private ranges, so 192.168.1.5 is
        //  skipped as if it were a proxy; naming only the proxy stops that
        const headers = { 'x-forwarded-for': '1.1.1.1, 192.168.1.5' };
        assert.equal(resolve('127.0.0.1', headers).address, '1.1.1.1');
        assert.equal(resolve('127.0.0.1', headers, ['127.0.0.1']).address, '192.168.1.5');
    });

    it('falls back to a single X-Real-IP', () => {
        assert.deepEqual(resolve('127.0.0.1', { 'x-real-ip': ' 5.6.7.8 ' }), {
            address: '5.6.7.8',
            forwarded: true,
            peerTrusted: true,
        });
        //  X-Forwarded-For wins when it is usable
        assert.equal(
            resolve('127.0.0.1', { 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '5.6.7.8' })
                .address,
            '1.2.3.4'
        );
    });

    it('rejects an X-Real-IP that is not a single address', () => {
        assert.equal(
            resolve('127.0.0.1', { 'x-real-ip': '5.6.7.8, 9.9.9.9' }).address,
            '127.0.0.1'
        );
        assert.equal(resolve('127.0.0.1', { 'x-real-ip': 'bogus' }).address, '127.0.0.1');
    });

    it('trusts nothing with an empty list', () => {
        assert.equal(
            resolve('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' }, []).address,
            '127.0.0.1'
        );
    });
});

describe('trustedProxies parsing', function () {
    let savedLog;
    let warnings;

    beforeEach(() => {
        savedLog = loggerModule.log;
        warnings = [];
        loggerModule.log = Object.assign({}, savedLog, {
            warn: (obj, msg) => warnings.push({ obj, msg }),
        });
    });

    afterEach(() => {
        loggerModule.log = savedLog;
    });

    it('ignores invalid entries, warning once per value', () => {
        //  values unique to this test: each is only ever reported once
        const list = [
            '10.99.0.0/33',
            'not-an-ip-981',
            '10.98.0.1/abc',
            42,
            '203.0.113.50',
        ];

        assert.ok(isTrustedProxy('203.0.113.50', list));
        assert.ok(!isTrustedProxy('10.99.0.1', list));
        assert.equal(warnings.length, 4);
        assert.deepEqual(
            warnings.map(w => w.obj.entry),
            ['10.99.0.0/33', 'not-an-ip-981', '10.98.0.1/abc', 42]
        );

        //  a different list repeating a bad value does not warn again
        assert.ok(isTrustedProxy('203.0.113.51', ['not-an-ip-981', '203.0.113.51']));
        assert.equal(warnings.length, 4);
    });

    it('accepts a single string', () => {
        assert.ok(isTrustedProxy('203.0.113.60', '203.0.113.60'));
    });

    it('reads the setting at call time, so a reload takes effect', () => {
        const prev = configModule._pushTestConfig({ trustedProxies: ['203.0.113.70'] });
        try {
            assert.ok(isTrustedProxy('203.0.113.70'));
            assert.equal(
                getRequestClientAddress({
                    socket: { remoteAddress: '203.0.113.70' },
                    headers: { 'x-forwarded-for': '1.2.3.4' },
                }),
                '1.2.3.4'
            );

            configModule._pushTestConfig({ trustedProxies: ['203.0.113.71'] });
            assert.ok(!isTrustedProxy('203.0.113.70'));
            assert.ok(isTrustedProxy('203.0.113.71'));
            assert.equal(
                getRequestClientAddress({
                    socket: { remoteAddress: '203.0.113.70' },
                    headers: { 'x-forwarded-for': '1.2.3.4' },
                }),
                '203.0.113.70'
            );
        } finally {
            configModule._popTestConfig(prev);
        }
    });
});

describe('trustedProxies in config.hjson', function () {
    let savedGet;
    let savedReload;
    let tempDir;

    before(() => {
        savedGet = configModule.get;
        savedReload = configModule.reload;
        tempDir = fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-trusted-proxies-'));
    });

    after(() => {
        //  Config.create() rebinds these module-level exports
        configModule.get = savedGet;
        configModule.reload = savedReload;
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function load(hjsonText, cb) {
        const path = paths.join(tempDir, `config-${Date.now()}-${Math.random()}.hjson`);
        fs.writeFileSync(path, hjsonText);
        configModule.Config.create(
            path,
            { hotReload: false, reportValidation: false },
            err => cb(err, configModule.get())
        );
    }

    it('keeps the default when unset', done => {
        load('{\n}\n', (err, config) => {
            assert.ifError(err);
            assert.deepEqual(config.trustedProxies, DefaultTrusted);
            return done();
        });
    });

    it('replaces the default rather than merging with it', done => {
        load('{\n    trustedProxies: [ "203.0.113.5" ]\n}\n', (err, config) => {
            assert.ifError(err);
            assert.deepEqual(config.trustedProxies, ['203.0.113.5']);
            return done();
        });
    });
});

describe('hasForwardedHeaders()', function () {
    it('spots any forwarded header with a value', () => {
        assert.ok(hasForwardedHeaders({ 'x-forwarded-for': '1.2.3.4' }));
        assert.ok(hasForwardedHeaders({ 'x-real-ip': '1.2.3.4' }));
        assert.ok(hasForwardedHeaders({ 'x-forwarded-proto': 'https' }));
        assert.ok(!hasForwardedHeaders({ 'x-forwarded-for': '  ' }));
        assert.ok(!hasForwardedHeaders({ host: 'example.com' }));
        assert.ok(!hasForwardedHeaders(undefined));
    });
});
