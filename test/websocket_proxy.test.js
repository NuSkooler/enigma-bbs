'use strict';

//
//  The WebSocket login server behind a reverse proxy: the client address and
//  isSecure of a connection, and whether that client counts as local.
//

const { strict: assert } = require('assert');

const configDefault = require('../core/config_default.js');
const { Client } = require('../core/client.js');
const { resolveConnection } = require('../core/servers/login/websocket.js');

const DefaultTrusted = configDefault().trustedProxies;

describe('WebSocket resolveConnection()', function () {
    function resolve(peerAddress, headers, proxied = true) {
        return resolveConnection({
            peerAddress,
            headers,
            proxied,
            trustedProxies: DefaultTrusted,
        });
    }

    it('ignores forwarded headers when not proxied', () => {
        assert.deepEqual(
            resolve(
                '127.0.0.1',
                { 'x-forwarded-for': '1.2.3.4', 'x-forwarded-proto': 'https' },
                false
            ),
            {
                remoteAddress: '127.0.0.1',
                forwardedSecure: false,
                viaProxy: false,
                noClientAddress: false,
                ignoredHeaders: false,
            }
        );
    });

    it('takes the client address and https from a trusted proxy', () => {
        assert.deepEqual(
            resolve('::ffff:172.17.0.2', {
                'x-forwarded-for': '9.9.9.9, 1.2.3.4',
                'x-forwarded-proto': 'https',
            }),
            {
                remoteAddress: '1.2.3.4',
                forwardedSecure: true,
                viaProxy: true,
                noClientAddress: false,
                ignoredHeaders: false,
            }
        );
        assert.equal(
            resolve('127.0.0.1', { 'x-real-ip': '1.2.3.4' }).remoteAddress,
            '1.2.3.4'
        );
        assert.equal(
            resolve('127.0.0.1', {
                'x-forwarded-for': '1.2.3.4',
                'x-forwarded-proto': 'http',
            }).forwardedSecure,
            false
        );
    });

    it('ignores and flags forwarded headers from an untrusted peer', () => {
        assert.deepEqual(
            resolve('203.0.113.9', {
                'x-forwarded-for': '1.2.3.4',
                'x-forwarded-proto': 'https',
            }),
            {
                remoteAddress: '203.0.113.9',
                forwardedSecure: false,
                viaProxy: false,
                noClientAddress: false,
                ignoredHeaders: true,
            }
        );
        assert.equal(resolve('203.0.113.9', {}).ignoredHeaders, false);
    });

    it('flags a trusted proxy that forwards no client address', () => {
        const r = resolve('127.0.0.1', { 'x-forwarded-proto': 'https' });
        assert.equal(r.remoteAddress, '127.0.0.1');
        assert.equal(r.viaProxy, true);
        assert.equal(r.noClientAddress, true);
        assert.equal(r.forwardedSecure, true);
    });
});

describe('Client.isLocal() behind a proxy', function () {
    function isLocal(props) {
        return Client.prototype.isLocal.call(props);
    }

    it('is unchanged for a direct connection', () => {
        assert.ok(isLocal({ remoteAddress: '127.0.0.1' }));
        assert.ok(isLocal({ remoteAddress: '::ffff:127.0.0.1' }));
        assert.ok(!isLocal({ remoteAddress: '1.2.3.4' }));
    });

    function viaProxyClient(headers) {
        const r = resolveConnection({
            peerAddress: '127.0.0.1',
            headers,
            proxied: true,
            trustedProxies: DefaultTrusted,
        });
        return { remoteAddress: r.remoteAddress, viaProxy: r.viaProxy };
    }

    it('is false when the proxy forwards no client address', () => {
        const client = viaProxyClient({});
        assert.equal(client.remoteAddress, '127.0.0.1');
        assert.ok(!isLocal(client));
    });

    it('is false for any address forwarded by a trusted proxy', () => {
        //  a proxy that passes X-Forwarded-For through unchanged
        const client = viaProxyClient({ 'x-forwarded-for': '127.0.0.1' });
        assert.equal(client.remoteAddress, '127.0.0.1');
        assert.ok(!isLocal(client));
        assert.ok(!isLocal(viaProxyClient({ 'x-real-ip': '127.0.0.1' })));
    });

    it('is unchanged for a loopback peer when not proxied', () => {
        const r = resolveConnection({
            peerAddress: '127.0.0.1',
            headers: { 'x-forwarded-for': '1.2.3.4' },
            proxied: false,
            trustedProxies: DefaultTrusted,
        });
        assert.ok(isLocal({ remoteAddress: r.remoteAddress, viaProxy: r.viaProxy }));
    });
});
