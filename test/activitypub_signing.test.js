'use strict';

//
//  HTTP Signature sign/verify round-trip tests.
//
//  These tests exercise the signing infrastructure used by ActivityPub outgoing
//  requests without touching the network.  A fresh RSA key pair is generated per
//  suite; the duck-typed request object satisfies the http-signature library's
//  interface (setHeader / getHeader / method / path / headers).
//

const { strict: assert } = require('assert');
const crypto = require('crypto');
const httpSignature = require('http-signature');
const { HttpSignatureSignHeaders } = require('../core/activitypub/const.js');

// ─── helpers ─────────────────────────────────────────────────────────────────

let privateKey, publicKey;

before(() => {
    //  Generate once per suite (1024-bit is fine for tests — fast, not for prod)
    ({ privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 1024,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    }));
});

const KEY_ID = 'https://test.example.com/ap/users/bob#main-key';

/**
 * Build a duck-typed request object that satisfies http-signature's interface.
 * `headers` must contain all headers that will be signed.
 */
function makeFakeRequest(method, path, headers) {
    return {
        method,
        path,
        headers: Object.assign({}, headers),
        setHeader(name, value) {
            this.headers[name.toLowerCase()] = value;
        },
        getHeader(name) {
            return this.headers[name.toLowerCase()];
        },
    };
}

/**
 * Sign a fake request using the test private key and the production
 * HttpSignatureSignHeaders constant, then parse and verify it.
 */
function signAndVerify(req, headersToSign = HttpSignatureSignHeaders) {
    httpSignature.sign(req, {
        key: privateKey,
        keyId: KEY_ID,
        authorizationHeaderName: 'Signature',
        headers: headersToSign,
    });

    const parsed = httpSignature.parseRequest({
        headers: req.headers,
        method: req.method,
        url: req.path,
    });

    return httpSignature.verifySignature(parsed, publicKey);
}

function makeDigest(body) {
    return 'SHA-256=' + crypto.createHash('sha256').update(body).digest('base64');
}

// ─── sign / verify round-trip ─────────────────────────────────────────────────

describe('HTTP Signature — sign/verify round-trip', function () {
    it('produces a Signature header after signing', () => {
        const req = makeFakeRequest('POST', '/inbox', {
            host: 'remote.example.com',
            date: new Date().toUTCString(),
            'content-type': 'application/activity+json',
            digest: makeDigest('{}'),
        });
        httpSignature.sign(req, {
            key: privateKey,
            keyId: KEY_ID,
            authorizationHeaderName: 'Signature',
            headers: ['(request-target)', 'host', 'date'],
        });
        assert.ok(
            req.headers['signature'],
            'Signature header should be present after signing'
        );
    });

    it('verifies a signed request with the corresponding public key', () => {
        const body = JSON.stringify({
            type: 'Follow',
            actor: 'https://test.example.com/ap/users/bob',
        });
        const req = makeFakeRequest('POST', '/inbox', {
            host: 'remote.example.com',
            date: new Date().toUTCString(),
            'content-type': 'application/activity+json',
            digest: makeDigest(body),
        });
        const ok = signAndVerify(req);
        assert.ok(ok, 'signature should verify against matching public key');
    });

    it('verification fails when the Signature header is tampered with', () => {
        const req = makeFakeRequest('POST', '/inbox', {
            host: 'remote.example.com',
            date: new Date().toUTCString(),
            'content-type': 'application/activity+json',
            digest: makeDigest('{}'),
        });
        httpSignature.sign(req, {
            key: privateKey,
            keyId: KEY_ID,
            authorizationHeaderName: 'Signature',
            headers: ['(request-target)', 'host', 'date'],
        });

        //  Corrupt the signature value
        req.headers['signature'] = req.headers['signature'].replace(
            /signature="[^"]{4}/,
            'signature="XXXX'
        );

        const parsed = httpSignature.parseRequest({
            headers: req.headers,
            method: req.method,
            url: req.path,
        });
        const ok = httpSignature.verifySignature(parsed, publicKey);
        assert.ok(!ok, 'tampered signature should not verify');
    });

    it('verification fails when a signed header is modified after signing', () => {
        const req = makeFakeRequest('POST', '/inbox', {
            host: 'remote.example.com',
            date: new Date().toUTCString(),
            'content-type': 'application/activity+json',
            digest: makeDigest('original body'),
        });
        httpSignature.sign(req, {
            key: privateKey,
            keyId: KEY_ID,
            authorizationHeaderName: 'Signature',
            headers: ['(request-target)', 'host', 'date', 'digest'],
        });

        //  Change the digest (simulating body tampering)
        req.headers['digest'] = makeDigest('tampered body');

        const parsed = httpSignature.parseRequest({
            headers: req.headers,
            method: req.method,
            url: req.path,
        });
        const ok = httpSignature.verifySignature(parsed, publicKey);
        assert.ok(!ok, 'modified digest header should fail verification');
    });
});

// ─── HttpSignatureSignHeaders constant ────────────────────────────────────────

describe('HttpSignatureSignHeaders constant', function () {
    it('includes (request-target), host, date, digest, content-type', () => {
        const required = ['(request-target)', 'host', 'date', 'digest', 'content-type'];
        for (const h of required) {
            assert.ok(
                HttpSignatureSignHeaders.includes(h),
                `HttpSignatureSignHeaders should include "${h}"`
            );
        }
    });

    it('signs and verifies using the production HttpSignatureSignHeaders list', () => {
        const body = JSON.stringify({ id: 'https://example.com/act/1', type: 'Create' });
        const req = makeFakeRequest('POST', '/users/alice/inbox', {
            host: 'remote.example.com',
            date: new Date().toUTCString(),
            'content-type': 'application/activity+json',
            digest: makeDigest(body),
        });
        const ok = signAndVerify(req, HttpSignatureSignHeaders);
        assert.ok(ok, 'production sign-headers should produce a verifiable signature');
    });
});

// ─── Digest header computation ────────────────────────────────────────────────

describe('Digest header computation (SHA-256)', function () {
    it('digest of the same body is stable across calls', () => {
        const body = 'hello world';
        assert.equal(makeDigest(body), makeDigest(body));
    });

    it('digest changes when body changes', () => {
        assert.notEqual(makeDigest('body A'), makeDigest('body B'));
    });

    it('digest header format is SHA-256=<base64>', () => {
        const d = makeDigest('some content');
        assert.ok(d.startsWith('SHA-256='), 'should start with SHA-256=');
        const b64 = d.slice('SHA-256='.length);
        assert.ok(/^[A-Za-z0-9+/]+=*$/.test(b64), 'value should be valid base64');
    });
});
