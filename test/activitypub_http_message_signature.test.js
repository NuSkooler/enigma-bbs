'use strict';

//
//  RFC 9421 HTTP Message Signatures (inbound): the RFC 8941 parser and
//  serializer, the signature base and verification
//  (core/activitypub/http_message_signature.js), and the 9421 helpers in
//  core/activitypub/security.js.
//
//  Vectors marked "RFC 8941 3.x" or "RFC 9421 x.y" are copied from those
//  RFCs; RFC 8792 line wrapping undone. Only the RFC's public test keys
//  are here; requests signed at test time use keys generated per run.
//

const { strict: assert } = require('assert');
const crypto = require('crypto');

const H = require('../core/activitypub/http_message_signature.js');
const {
    missingSignedComponents,
    validateSignatureTimes,
    verifyContentDigestHeader,
} = require('../core/activitypub/security.js');

const { SfToken, SfDecimal } = H;

//  RFC 9421 B.1.1 test-key-rsa (public)
const TEST_KEY_RSA = `-----BEGIN RSA PUBLIC KEY-----
MIIBCgKCAQEAhAKYdtoeoy8zcAcR874L8cnZxKzAGwd7v36APp7Pv6Q2jdsPBRrw
WEBnez6d0UDKDwGbc6nxfEXAy5mbhgajzrw3MOEt8uA5txSKobBpKDeBLOsdJKFq
MGmXCQvEG7YemcxDTRPxAleIAgYYRjTSd/QBwVW9OwNFhekro3RtlinV0a75jfZg
kne/YiktSvLG34lw2zqXBDTC5NHROUqGTlML4PlNZS5Ri2U4aCNx2rUPRcKIlE0P
uKxI4T+HIaFpv8+rdV6eUgOrB2xeI1dSFFn/nnv5OoZJEIB+VmuKn3DCUcCZSFlQ
PSXSfBDiUGhwOw76WuSSsf1D4b/vLoJ10wIDAQAB
-----END RSA PUBLIC KEY-----
`;

//  RFC 9421 B.1.2 test-key-rsa-pss (public)
const TEST_KEY_RSA_PSS = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAr4tmm3r20Wd/PbqvP1s2
+QEtvpuRaV8Yq40gjUR8y2Rjxa6dpG2GXHbPfvMs8ct+Lh1GH45x28Rw3Ry53mm+
oAXjyQ86OnDkZ5N8lYbggD4O3w6M6pAvLkhk95AndTrifbIFPNU8PPMO7OyrFAHq
gDsznjPFmTOtCEcN2Z1FpWgchwuYLPL+Wokqltd11nqqzi+bJ9cvSKADYdUAAN5W
Utzdpiy6LbTgSxP7ociU4Tn0g5I6aDZJ7A8Lzo0KSyZYoA485mqcO0GVAdVw9lq4
aOT9v6d+nb4bnNkQVklLQ3fVAvJm+xdDOp9LCNCN48V2pnDOkFV6+U9nV5oyc6XI
2wIDAQAB
-----END PUBLIC KEY-----
`;

//  RFC 9421 B.1.3 test-key-ecc-p256 (public)
const TEST_KEY_ECC_P256 = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEqIVYZVLCrPZHGHjP17CTW0/+D9Lf
w0EkjqF7xB4FivAxzic30tMM4GF+hR6Dxh71Z50VGGdldkkDXZCnTNnoXQ==
-----END PUBLIC KEY-----
`;

//  RFC 9421 B.1.4 test-key-ed25519 (public)
const TEST_KEY_ED25519 = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAJrQLj5P/89iXES9+vFgrIy29clF9CC/oPPsw3c5D0bs=
-----END PUBLIC KEY-----
`;

//  RFC 9421 B.2 test-request, without its signature fields
const TEST_REQUEST_URL = 'https://example.com/foo?param=Value&Pet=dog';
const TEST_REQUEST_DIGEST =
    'sha-512=:WZDPaVn/7XgHaAy8pmojAkGWoRx2UFChF41A2svX+TaPm+AbwAgBWnrIiYllu7BNNyealdVLvRwEmTHWXvJwew==:';
function testRequest(signatureInput, signature, extraHeaders = {}) {
    return {
        method: 'POST',
        url: '/foo?param=Value&Pet=dog',
        headers: Object.assign(
            {
                host: 'example.com',
                date: 'Tue, 20 Apr 2021 02:07:55 GMT',
                'content-type': 'application/json',
                'content-digest': TEST_REQUEST_DIGEST,
                'content-length': '18',
                'signature-input': signatureInput,
                signature,
            },
            extraHeaders
        ),
    };
}

function baseOf(req, url = TEST_REQUEST_URL) {
    const parsed = H.parseRequestSignature(req);
    return { parsed, base: H.signatureBase(req, parsed, new URL(url)) };
}

//  member -> plain JS for comparisons
function plain(v) {
    if (v instanceof Map) {
        return Object.fromEntries([...v].map(([k, x]) => [k, plain(x)]));
    }
    if (Array.isArray(v)) {
        return v.map(plain);
    }
    if (v instanceof SfToken) {
        return { token: v.value };
    }
    if (v instanceof SfDecimal) {
        return { decimal: v.value };
    }
    if (Buffer.isBuffer(v)) {
        return { bytes: v.toString('base64') };
    }
    if (v && typeof v === 'object' && 'value' in v && 'params' in v) {
        return { value: plain(v.value), params: plain(v.params) };
    }
    return v;
}

describe('RFC 8941 structured fields (the parts RFC 9421 needs)', function () {
    describe('Dictionaries', function () {
        it('RFC 8941 3.2: en="Applepie", da=:w4ZibGV0w6ZydGU=:', () => {
            const d = H.parseDictionary('en="Applepie", da=:w4ZibGV0w6ZydGU=:');
            assert.deepEqual([...d.keys()], ['en', 'da']);
            assert.equal(d.get('en').value, 'Applepie');
            assert.deepEqual(
                d.get('da').value,
                Buffer.from('w4ZibGV0w6ZydGU=', 'base64')
            );
        });

        it('RFC 8941 3.2: a=?0, b, c; foo=bar (bare keys are true)', () => {
            assert.deepEqual(plain(H.parseDictionary('a=?0, b, c; foo=bar')), {
                a: { value: false, params: {} },
                b: { value: true, params: {} },
                c: { value: true, params: { foo: { token: 'bar' } } },
            });
        });

        it('RFC 8941 3.2: rating=1.5, feelings=(joy sadness)', () => {
            assert.deepEqual(
                plain(H.parseDictionary('rating=1.5, feelings=(joy sadness)')),
                {
                    rating: { value: { decimal: 1.5 }, params: {} },
                    feelings: {
                        value: [
                            { value: { token: 'joy' }, params: {} },
                            { value: { token: 'sadness' }, params: {} },
                        ],
                        params: {},
                    },
                }
            );
        });

        it('RFC 8941 3.2: a=(1 2), b=3, c=4;aa=bb, d=(5 6);valid', () => {
            const d = plain(H.parseDictionary('a=(1 2), b=3, c=4;aa=bb, d=(5 6);valid'));
            assert.deepEqual(d.a.value, [
                { value: 1, params: {} },
                { value: 2, params: {} },
            ]);
            assert.deepEqual(d.b, { value: 3, params: {} });
            assert.deepEqual(d.c, { value: 4, params: { aa: { token: 'bb' } } });
            assert.deepEqual(d.d.params, { valid: true });
        });

        it('RFC 8941 3.2: foo=1 and bar=2 on two field lines read as one', () => {
            const req = {
                headers: {},
                headersDistinct: { 'example-dict': ['foo=1', 'bar=2'] },
            };
            const d = H.parseDictionary(H.fieldValue(req, 'example-dict'));
            assert.deepEqual(plain(d), {
                foo: { value: 1, params: {} },
                bar: { value: 2, params: {} },
            });
        });

        it('a duplicate key keeps the last value (RFC 8941 4.2.2)', () => {
            const d = H.parseDictionary('a=1, b=2, a=3');
            assert.equal(d.get('a').value, 3);
            assert.equal(d.size, 2);
        });
    });

    describe('Lists, Inner Lists and Parameters', function () {
        it('RFC 8941 3.1.1: ("foo" "bar"), ("baz"), ("bat" "one"), ()', () => {
            const l = H.parseList('("foo" "bar"), ("baz"), ("bat" "one"), ()');
            assert.deepEqual(
                l.map(m => m.value.map(i => i.value)),
                [['foo', 'bar'], ['baz'], ['bat', 'one'], []]
            );
        });

        it('RFC 8941 3.1.1: ("foo"; a=1;b=2);lvl=5, ("bar" "baz");lvl=1', () => {
            const l = plain(H.parseList('("foo"; a=1;b=2);lvl=5, ("bar" "baz");lvl=1'));
            assert.deepEqual(l[0], {
                value: [{ value: 'foo', params: { a: 1, b: 2 } }],
                params: { lvl: 5 },
            });
            assert.deepEqual(l[1].params, { lvl: 1 });
        });

        it('RFC 8941 3.1.2: abc;a=1;b=2; cde_456, (ghi;jk=4 l);q="9";r=w', () => {
            const l = plain(H.parseList('abc;a=1;b=2; cde_456, (ghi;jk=4 l);q="9";r=w'));
            assert.deepEqual(l[0], {
                value: { token: 'abc' },
                params: { a: 1, b: 2, cde_456: true },
            });
            assert.deepEqual(l[1], {
                value: [
                    { value: { token: 'ghi' }, params: { jk: 4 } },
                    { value: { token: 'l' }, params: {} },
                ],
                params: { q: '9', r: { token: 'w' } },
            });
        });

        it('RFC 8941 3.1.2: 1; a; b=?0', () => {
            assert.deepEqual(plain(H.parseItem('1; a; b=?0')), {
                value: 1,
                params: { a: true, b: false },
            });
        });

        it('RFC 8941 3.3.3: "hello world", and escapes', () => {
            assert.equal(H.parseItem('"hello world"').value, 'hello world');
            assert.equal(H.parseItem('"a \\"b\\" \\\\c"').value, 'a "b" \\c');
        });
    });

    describe('bad input is refused', function () {
        const bad = [
            ['an unterminated string', 'a="abc'],
            ['a bad escape', 'a="a\\b"'],
            ['a control character in a string', 'a="a\tb"'],
            ['base64 outside the alphabet', 'a=:ab$c:'],
            ['padding in the middle of base64', 'a=:ab=cd:'],
            ['an unterminated byte sequence', 'a=:abc'],
            ['a trailing comma', 'a=1,'],
            ['an upper-case key', 'A=1'],
            ['an unterminated inner list', 'a=(1 2'],
            ['items in an inner list without a space', 'a=("x""y")'],
            ['an integer longer than 15 digits', 'a=1234567890123456'],
            ['a decimal with 4 fractional digits', 'a=1.2345'],
            ['a decimal ending in "."', 'a=1.'],
            ['a bad boolean', 'a=?2'],
            ['an unknown item type', 'a=@x'],
            ['non-ASCII input', 'a="caf\u00e9"'],
            ['trailing garbage', 'a=1 b'],
        ];
        for (const [name, input] of bad) {
            it(name, () => {
                assert.throws(() => H.parseDictionary(input), H.StructuredFieldError);
            });
        }
    });

    describe('Inner List serialization (the @signature-params value)', function () {
        it('RFC 9421 2.3: the example parameters round-trip exactly', () => {
            const value =
                '("@target-uri" "@authority" "date" "cache-control");keyid="test-key-rsa-pss";alg="rsa-pss-sha512";created=1618884475;expires=1618884775';
            const d = H.parseDictionary(`sig1=${value}`);
            assert.equal(H.serializeInnerList(d.get('sig1')), value);
        });

        it('is canonical: extra spaces go, a true parameter has no value', () => {
            const d = H.parseDictionary('sig=(  "a"   "b"  );created=1; x=?1;y=tok');
            assert.equal(
                H.serializeInnerList(d.get('sig')),
                '("a" "b");created=1;x;y=tok'
            );
        });

        it('escapes quotes and backslashes in strings', () => {
            const d = H.parseDictionary('sig=();tag="a\\"b\\\\c"');
            assert.equal(H.serializeInnerList(d.get('sig')), '();tag="a\\"b\\\\c"');
        });
    });
});

describe('RFC 9421 signature base and verification', function () {
    describe('component values', function () {
        it('RFC 9421 2.1: several field lines are trimmed and joined with ", "', () => {
            const req = {
                headers: {},
                headersDistinct: {
                    'cache-control': ['max-age=60', '   must-revalidate'],
                    'x-ows-header': ['   Leading and trailing whitespace.   '],
                },
            };
            assert.equal(
                H.fieldValue(req, 'cache-control'),
                'max-age=60, must-revalidate'
            );
            assert.equal(
                H.fieldValue(req, 'x-ows-header'),
                'Leading and trailing whitespace.'
            );
        });

        it('a header named like an Object property is not found', () => {
            assert.equal(H.fieldValue({ headers: {} }, '__proto__'), null);
            assert.equal(H.fieldValue({ headers: {} }, 'constructor'), null);
        });

        //  RFC 9421 2.2.1 - 2.2.7
        function derived(name, method, url) {
            const req = {
                method,
                headers: {
                    'signature-input': `s=("${name}");created=1;keyid="k"`,
                    signature: 's=:AAAA:',
                },
            };
            const { base } = baseOf(req, url);
            return base.split('\n')[0];
        }

        it('RFC 9421 2.2: derived components of https://www.example.com/path?param=value', () => {
            const url = 'https://www.example.com/path?param=value';
            assert.equal(derived('@method', 'POST', url), '"@method": POST');
            assert.equal(
                derived('@target-uri', 'POST', url),
                '"@target-uri": https://www.example.com/path?param=value'
            );
            assert.equal(
                derived('@authority', 'POST', url),
                '"@authority": www.example.com'
            );
            assert.equal(
                derived('@request-target', 'POST', url),
                '"@request-target": /path?param=value'
            );
            assert.equal(derived('@path', 'GET', url), '"@path": /path');
        });

        it('RFC 9421 2.2.4: @scheme over plain HTTP is http', () => {
            assert.equal(
                derived('@scheme', 'POST', 'http://www.example.com/path?param=value'),
                '"@scheme": http'
            );
        });

        it('RFC 9421 2.2.7: @query, including an absent query', () => {
            assert.equal(
                derived(
                    '@query',
                    'GET',
                    'https://www.example.com/path?param=value&foo=bar&baz=bat%2Dman'
                ),
                '"@query": ?param=value&foo=bar&baz=bat%2Dman'
            );
            assert.equal(
                derived('@query', 'POST', 'https://www.example.com/path?queryString'),
                '"@query": ?queryString'
            );
            assert.equal(
                derived('@query', 'GET', 'https://www.example.com/path'),
                '"@query": ?'
            );
        });

        it('@authority is lower-cased and drops a default port', () => {
            assert.equal(
                derived('@authority', 'GET', 'https://WWW.Example.COM:443/x'),
                '"@authority": www.example.com'
            );
            assert.equal(
                derived('@authority', 'GET', 'https://www.example.com:8443/x'),
                '"@authority": www.example.com:8443'
            );
        });
    });

    describe('the RFC test vectors verify against the RFC public keys', function () {
        it('RFC 9421 2.5 Figure 1 / 3.2 sig1 (rsa-pss-sha512)', () => {
            const req = testRequest(
                'sig1=("@method" "@authority" "@path" "content-digest" "content-length" "content-type");created=1618884473;keyid="test-key-rsa-pss"',
                'sig1=:HIbjHC5rS0BYaa9v4QfD4193TORw7u9edguPh0AW3dMq9WImrlFrCGUDih47vAxi4L2YRZ3XMJc1uOKk/J0ZmZ+wcta4nKIgBkKq0rM9hs3CQyxXGxHLMCy8uqK488o+9jrptQ+xFPHK7a9sRL1IXNaagCNN3ZxJsYapFj+JXbmaI5rtAdSfSvzPuBCh+ARHBmWuNo1UzVVdHXrl8ePL4cccqlazIJdC4QEjrF+Sn4IxBQzTZsL9y9TP5FsZYzHvDqbInkTNigBcE9cKOYNFCn4D/WM7F6TNuZO9EgtzepLWcjTymlHzK7aXq6Am6sfOrpIC49yXjj3ae6HRalVc/g==:'
            );
            const { parsed, base } = baseOf(req);
            assert.equal(
                base,
                [
                    '"@method": POST',
                    '"@authority": example.com',
                    '"@path": /foo',
                    `"content-digest": ${TEST_REQUEST_DIGEST}`,
                    '"content-length": 18',
                    '"content-type": application/json',
                    '"@signature-params": ("@method" "@authority" "@path" "content-digest" "content-length" "content-type");created=1618884473;keyid="test-key-rsa-pss"',
                ].join('\n')
            );
            assert.equal(parsed.label, 'sig1');
            assert.ok(
                H.verifySignatureBytes(
                    'rsa-pss-sha512',
                    base,
                    parsed.sigBytes,
                    TEST_KEY_RSA_PSS
                )
            );
        });

        it('RFC 9421 B.2.1 minimal signature (rsa-pss-sha512)', () => {
            const req = testRequest(
                'sig-b21=();created=1618884473;keyid="test-key-rsa-pss";nonce="b3k2pp5k7z-50gnwp.yemd"',
                'sig-b21=:d2pmTvmbncD3xQm8E9ZV2828BjQWGgiwAaw5bAkgibUopemLJcWDy/lkbbHAve4cRAtx31Iq786U7it++wgGxbtRxf8Udx7zFZsckzXaJMkA7ChG52eSkFxykJeNqsrWH5S+oxNFlD4dzVuwe8DhTSja8xxbR/Z2cOGdCbzR72rgFWhzx2VjBqJzsPLMIQKhO4DGezXehhWwE56YCE+O6c0mKZsfxVrogUvA4HELjVKWmAvtl6UnCh8jYzuVG5WSb/QEVPnP5TmcAnLH1g+s++v6d4s8m0gCw1fV5/SITLq9mhho8K3+7EPYTU8IU1bLhdxO5Nyt8C8ssinQ98Xw9Q==:'
            );
            const { parsed, base } = baseOf(req);
            assert.equal(
                base,
                '"@signature-params": ();created=1618884473;keyid="test-key-rsa-pss";nonce="b3k2pp5k7z-50gnwp.yemd"'
            );
            assert.equal(parsed.params.nonce, 'b3k2pp5k7z-50gnwp.yemd');
            assert.ok(
                H.verifySignatureBytes(
                    'rsa-pss-sha512',
                    base,
                    parsed.sigBytes,
                    TEST_KEY_RSA_PSS
                )
            );
        });

        it('RFC 9421 B.2.3 full coverage (rsa-pss-sha512)', () => {
            const req = testRequest(
                'sig-b23=("date" "@method" "@path" "@query" "@authority" "content-type" "content-digest" "content-length");created=1618884473;keyid="test-key-rsa-pss"',
                'sig-b23=:bbN8oArOxYoyylQQUU6QYwrTuaxLwjAC9fbY2F6SVWvh0yBiMIRGOnMYwZ/5MR6fb0Kh1rIRASVxFkeGt683+qRpRRU5p2voTp768ZrCUb38K0fUxN0O0iC59DzYx8DFll5GmydPxSmme9v6ULbMFkl+V5B1TP/yPViV7KsLNmvKiLJH1pFkh/aYA2HXXZzNBXmIkoQoLd7YfW91kE9o/CCoC1xMy7JA1ipwvKvfrs65ldmlu9bpG6A9BmzhuzF8Eim5f8ui9eH8LZH896+QIF61ka39VBrohr9iyMUJpvRX2Zbhl5ZJzSRxpJyoEZAFL2FUo5fTIztsDZKEgM4cUA==:'
            );
            const { parsed, base } = baseOf(req);
            assert.equal(
                base,
                [
                    '"date": Tue, 20 Apr 2021 02:07:55 GMT',
                    '"@method": POST',
                    '"@path": /foo',
                    '"@query": ?param=Value&Pet=dog',
                    '"@authority": example.com',
                    '"content-type": application/json',
                    `"content-digest": ${TEST_REQUEST_DIGEST}`,
                    '"content-length": 18',
                    '"@signature-params": ("date" "@method" "@path" "@query" "@authority" "content-type" "content-digest" "content-length");created=1618884473;keyid="test-key-rsa-pss"',
                ].join('\n')
            );
            assert.ok(
                H.verifySignatureBytes(
                    'rsa-pss-sha512',
                    base,
                    parsed.sigBytes,
                    TEST_KEY_RSA_PSS
                )
            );
        });

        const B26_INPUT =
            'sig-b26=("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"';
        const B26_SIG =
            'sig-b26=:wqcAqbmYJ2ji2glfAMaRy4gruYYnx2nEFN2HN6jrnDnQCK1u02Gb04v9EDgwUPiu4A0w6vuQv5lIp5WPpBKRCw==:';

        it('RFC 9421 B.2.6 ed25519, the algorithm taken from the key', () => {
            const { parsed, base } = baseOf(testRequest(B26_INPUT, B26_SIG));
            assert.equal(
                base,
                [
                    '"date": Tue, 20 Apr 2021 02:07:55 GMT',
                    '"@method": POST',
                    '"@path": /foo',
                    '"@authority": example.com',
                    '"content-type": application/json',
                    '"content-length": 18',
                    '"@signature-params": ("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"',
                ].join('\n')
            );
            assert.equal(H.verify(parsed, base, TEST_KEY_ED25519), true);
        });

        it('RFC 9421 B.2.6 fails once a covered header changes', () => {
            const req = testRequest(B26_INPUT, B26_SIG, { 'content-length': '19' });
            const { parsed, base } = baseOf(req);
            assert.equal(H.verify(parsed, base, TEST_KEY_ED25519), false);
        });

        it('RFC 9421 B.2.6 fails against another key, or an algorithm the key does not fit', () => {
            const { parsed, base } = baseOf(testRequest(B26_INPUT, B26_SIG));
            const other = crypto
                .generateKeyPairSync('ed25519')
                .publicKey.export({ type: 'spki', format: 'pem' });
            assert.equal(H.verify(parsed, base, other), false);
            assert.equal(H.verify(parsed, base, TEST_KEY_RSA), false);
            assert.throws(
                () =>
                    H.verifySignatureBytes(
                        'rsa-v1_5-sha256',
                        base,
                        parsed.sigBytes,
                        TEST_KEY_ED25519
                    ),
                /does not match a ed25519 key/
            );
        });

        //  RFC 9421 4.3: a client's signature, then a reverse proxy that
        //  rewrote Host and added its own signature under a second label
        const MULTI_INPUT =
            'sig1=("@method" "@authority" "@path" "content-digest" "content-type" "content-length");created=1618884475;keyid="test-key-ecc-p256", proxy_sig=("@method" "@authority" "@path" "content-digest" "content-type" "content-length" "forwarded");created=1618884480;keyid="test-key-rsa";alg="rsa-v1_5-sha256";expires=1618884540';
        const MULTI_SIG =
            'sig1=:X5spyd6CFnAG5QnDyHfqoSNICd+BUP4LYMz2Q0JXlb//4Ijpzp+kve2w4NIyqeAuM7jTDX+sNalzA8ESSaHD3A==:, proxy_sig=:S6ZzPXSdAMOPjN/6KXfXWNO/f7V6cHm7BXYUh3YD/fRad4BCaRZxP+JH+8XY1I6+8Cy+CM5g92iHgxtRPz+MjniOaYmdkDcnL9cCpXJleXsOckpURl49GwiyUpZ10KHgOEe11sx3G2gxI8S0jnxQB+Pu68U9vVcasqOWAEObtNKKZd8tSFu7LB5YAv0RAGhB8tmpv7sFnIm9y+7X5kXQfi8NMaZaA8i2ZHwpBdg7a6CMfwnnrtflzvZdXAsD3LH2TwevU+/PBPv0B6NMNk93wUs/vfJvye+YuI87HU38lZHowtznbLVdp770I6VHR6WfgS9ddzirrswsE1w5o0LV/g==:';
        const proxied = (input, sig) =>
            testRequest(input, sig, {
                host: 'origin.host.internal.example',
                date: 'Tue, 20 Apr 2021 02:07:56 GMT',
                forwarded: 'for=192.0.2.123;host=example.com;proto=https',
            });

        it('RFC 9421 4.3: of two labels the first is used; with @authority from our URL, not Host, it verifies (ecdsa-p256-sha256)', () => {
            const { parsed, base } = baseOf(proxied(MULTI_INPUT, MULTI_SIG));
            assert.equal(parsed.label, 'sig1');
            assert.ok(base.includes('"@authority": example.com\n'));
            assert.equal(H.verify(parsed, base, TEST_KEY_ECC_P256), true);
        });

        it("RFC 9421 4.3: the proxy's own signature (rsa-v1_5-sha256, alg and expires)", () => {
            const input = MULTI_INPUT.slice(MULTI_INPUT.indexOf('proxy_sig='));
            const sig = MULTI_SIG.slice(MULTI_SIG.indexOf('proxy_sig='));
            const { parsed, base } = baseOf(
                proxied(input, sig),
                'https://origin.host.internal.example/foo?param=Value&Pet=dog'
            );
            assert.equal(
                base,
                [
                    '"@method": POST',
                    '"@authority": origin.host.internal.example',
                    '"@path": /foo',
                    `"content-digest": ${TEST_REQUEST_DIGEST}`,
                    '"content-type": application/json',
                    '"content-length": 18',
                    '"forwarded": for=192.0.2.123;host=example.com;proto=https',
                    '"@signature-params": ("@method" "@authority" "@path" "content-digest" "content-type" "content-length" "forwarded");created=1618884480;keyid="test-key-rsa";alg="rsa-v1_5-sha256";expires=1618884540',
                ].join('\n')
            );
            assert.deepEqual(parsed.params, {
                created: 1618884480,
                keyid: 'test-key-rsa',
                alg: 'rsa-v1_5-sha256',
                expires: 1618884540,
            });
            assert.equal(H.verify(parsed, base, TEST_KEY_RSA), true);
        });
    });

    describe('what is refused', function () {
        it('RFC 9421 B.2.2: @query-param', () => {
            const req = testRequest(
                'sig-b22=("@authority" "content-digest" "@query-param";name="Pet");created=1618884473;keyid="test-key-rsa-pss";tag="header-example"',
                'sig-b22=:LjbtqUbfmvjj5C5kr1Ugj4PmLYvx9wVjZvD9GsTT4F7GrcQEdJzgI9qHxICagShLRiLMlAJjtq6N4CDfKtjvuJyE5qH7KT8UCMkSowOB4+ECxCmT8rtAmj/0PIXxi0A0nxKyB09RNrCQibbUjsLS/2YyFYXEu4TRJQzRw1rLEuEfY17SARYhpTlaqwZVtR8NV7+4UKkjqpcAoFqWFQh62s7Cl+H2fjBSpqfZUJcsIk4N6wiKYd4je2U/lankenQ99PZfB4jY3I5rSV2DSBVkSFsURIjYErOs0tFTQosMTAoxk//0RoKUqiYY8Bh0aaUEb0rQl3/XaVe4bXTugEjHSw==:'
            );
            assert.throws(() => H.parseRequestSignature(req), H.SignatureError);
        });

        it('RFC 9421 B.2.4: @status (a response component)', () => {
            const req = testRequest(
                'sig-b24=("@status" "content-type" "content-digest" "content-length");created=1618884473;keyid="test-key-ecc-p256"',
                'sig-b24=:wNmSUAhwb5LxtOtOpNa6W5xj067m5hFrj0XQ4fvpaCLx0NKocgPquLgyahnzDnDAUy5eCdlYUEkLIj+32oiasw==:'
            );
            assert.throws(
                () => H.parseRequestSignature(req),
                /unsupported derived component "@status"/
            );
        });

        it('RFC 9421 B.2.5: hmac-sha256', () => {
            const req = testRequest(
                'sig-b25=("date" "@authority" "content-type");created=1618884473;keyid="test-shared-secret";alg="hmac-sha256"',
                'sig-b25=:pxcQw6G3AjtMBQjwo8XzkZf/bws5LelbaMk5rGIGtE8=:'
            );
            const { parsed, base } = baseOf(req);
            assert.equal(H.verify(parsed, base, TEST_KEY_RSA), false);
            assert.throws(
                () =>
                    H.verifySignatureBytes(
                        'hmac-sha256',
                        base,
                        parsed.sigBytes,
                        TEST_KEY_RSA
                    ),
                /unsupported algorithm/
            );
        });

        const req = (input, sig = 'sig=:AAAA:', headers = {}) => ({
            method: 'POST',
            headers: Object.assign({ 'signature-input': input, signature: sig }, headers),
        });

        for (const [name, param] of [
            ['sf', ';sf'],
            ['key', ';key="a"'],
            ['bs', ';bs'],
            ['req', ';req'],
            ['tr', ';tr'],
        ]) {
            it(`a component parameter: ${name}`, () => {
                assert.throws(
                    () =>
                        H.parseRequestSignature(
                            req(
                                `sig=("@method" "content-digest"${param});created=1;keyid="k"`
                            )
                        ),
                    /unsupported parameter on component "content-digest"/
                );
            });
        }

        it('a component listed twice (RFC 9421 2.5 step 2.1)', () => {
            assert.throws(
                () => H.parseRequestSignature(req('sig=("@method" "@method");created=1')),
                /listed twice/
            );
        });

        it('a component given as a token, or in upper case', () => {
            assert.throws(
                () => H.parseRequestSignature(req('sig=(date);created=1')),
                /not a string/
            );
            assert.throws(
                () => H.parseRequestSignature(req('sig=("Date");created=1')),
                /not lower case/
            );
        });

        it('a covered header that is not in the request', () => {
            const r = req('sig=("@method" "date");created=1;keyid="k"');
            const parsed = H.parseRequestSignature(r);
            assert.throws(
                () => H.signatureBase(r, parsed, new URL('https://h.example/')),
                /covered header "date" is missing/
            );
        });

        it('a non-ASCII header value in the base', () => {
            const r = req('sig=("x-name");created=1;keyid="k"', undefined, {
                'x-name': 'caf\u00e9',
            });
            const parsed = H.parseRequestSignature(r);
            assert.throws(
                () => H.signatureBase(r, parsed, new URL('https://h.example/')),
                /not ASCII/
            );
        });

        it('created, expires or keyid of the wrong type', () => {
            assert.throws(
                () => H.parseRequestSignature(req('sig=();created="1"')),
                /"created" is not integer/
            );
            assert.throws(
                () => H.parseRequestSignature(req('sig=();expires=1.5')),
                /"expires" is not integer/
            );
            assert.throws(
                () => H.parseRequestSignature(req('sig=();keyid=tok')),
                /"keyid" is not string/
            );
        });

        it('a Signature-Input with no matching Signature label, or a Signature that is not bytes', () => {
            assert.throws(
                () => H.parseRequestSignature(req('a=();created=1', 'b=:AAAA:')),
                /no Signature-Input label has a Signature/
            );
            assert.throws(
                () => H.parseRequestSignature(req('a=();created=1', 'a="AAAA"')),
                /not a byte sequence/
            );
            assert.throws(
                () => H.parseRequestSignature(req('a="x"', 'a=:AAAA:')),
                /not an inner list/
            );
        });

        it('a malformed header, or a missing one', () => {
            assert.throws(
                () => H.parseRequestSignature(req('a=(', 'a=:AAAA:')),
                /malformed/
            );
            assert.throws(
                () =>
                    H.parseRequestSignature({
                        method: 'POST',
                        headers: { 'signature-input': 'a=()' },
                    }),
                /no Signature header/
            );
        });

        it('an EC key on another curve for ecdsa-p256-sha256', () => {
            const p384 = crypto
                .generateKeyPairSync('ec', { namedCurve: 'secp384r1' })
                .publicKey.export({ type: 'spki', format: 'pem' });
            assert.throws(
                () =>
                    H.verifySignatureBytes(
                        'ecdsa-p256-sha256',
                        'x',
                        Buffer.alloc(64),
                        p384
                    ),
                /curve/
            );
            assert.equal(
                H.verify({ params: {}, sigBytes: Buffer.alloc(96) }, 'x', p384),
                false,
                'no default algorithm for P-384'
            );
        });

        it('a key that does not parse', () => {
            assert.equal(
                H.verify({ params: {}, sigBytes: Buffer.alloc(8) }, 'x', 'nope'),
                false
            );
        });
    });
});

describe('RFC 9421 requirements (security.js)', function () {
    describe('missingSignedComponents', function () {
        it('Mastodon: @method @target-uri content-digest is complete', () => {
            assert.deepEqual(
                missingSignedComponents(
                    ['@method', '@target-uri', 'content-digest'],
                    'POST'
                ),
                []
            );
        });

        it('Fedify: @method @target-uri @authority host date content-digest is complete', () => {
            assert.deepEqual(
                missingSignedComponents(
                    [
                        '@method',
                        '@target-uri',
                        '@authority',
                        'host',
                        'date',
                        'content-digest',
                    ],
                    'POST'
                ),
                []
            );
        });

        it('@path or @request-target with @authority stands in for @target-uri', () => {
            assert.deepEqual(
                missingSignedComponents(['@method', '@path', '@authority'], 'GET'),
                []
            );
            assert.deepEqual(
                missingSignedComponents(
                    ['@method', '@request-target', '@authority'],
                    'GET'
                ),
                []
            );
        });

        it('a legacy digest stands in for content-digest', () => {
            assert.deepEqual(
                missingSignedComponents(['@method', '@target-uri', 'digest'], 'POST'),
                []
            );
        });

        it('names each unmet requirement', () => {
            assert.deepEqual(
                missingSignedComponents(['@target-uri', 'content-digest'], 'POST'),
                ['@method']
            );
            assert.deepEqual(missingSignedComponents(['@method', '@path'], 'GET'), [
                '@authority or @target-uri',
            ]);
            assert.deepEqual(missingSignedComponents(['@method', '@authority'], 'GET'), [
                '@target-uri or @request-target or @path',
            ]);
            assert.deepEqual(
                missingSignedComponents(['@method', '@target-uri'], 'POST'),
                ['content-digest or digest']
            );
            assert.deepEqual(missingSignedComponents([], 'POST'), [
                '@method',
                '@target-uri or @request-target or @path',
                '@authority or @target-uri',
                'content-digest or digest',
            ]);
        });
    });

    describe('validateSignatureTimes', function () {
        const now = 1_800_000_000;
        it('accepts created within ±300 s, and expires not yet past', () => {
            assert.equal(validateSignatureTimes({ created: now - 300 }, 300, now), null);
            assert.equal(validateSignatureTimes({ created: now + 300 }, 300, now), null);
            assert.equal(
                validateSignatureTimes({ created: now, expires: now }, 300, now),
                null
            );
        });
        it('refuses created missing, stale or in the future', () => {
            assert.match(validateSignatureTimes({}, 300, now), /missing created/);
            assert.match(
                validateSignatureTimes({ created: now - 301 }, 300, now),
                /exceeds/
            );
            assert.match(
                validateSignatureTimes({ created: now + 301 }, 300, now),
                /exceeds/
            );
        });
        it('refuses expires in the past', () => {
            assert.match(
                validateSignatureTimes({ created: now, expires: now - 1 }, 300, now),
                /expired/
            );
        });
    });

    describe('verifyContentDigestHeader (RFC 9530)', function () {
        const body = '{"hello": "world"}\n';
        const b64 = alg => crypto.createHash(alg).update(body).digest('base64');

        it('RFC 9530 B.1 sha-256, and RFC 9421 B.2 sha-512, of {"hello": "world"}', () => {
            //  RFC 9530 B.1: the body followed by an LF
            assert.ok(
                verifyContentDigestHeader(
                    'sha-256=:RK/0qy18MlBSVnWgjwz6lZEWjP/lF5HF9bvEF8FabDg=:',
                    body
                )
            );
            //  RFC 9421 B.2 test-request: the body without the LF
            assert.ok(verifyContentDigestHeader(TEST_REQUEST_DIGEST, body.trimEnd()));
            assert.ok(!verifyContentDigestHeader(TEST_REQUEST_DIGEST, body));
        });

        it('every supported digest listed must match; others are ignored', () => {
            assert.ok(
                verifyContentDigestHeader(`md5=:AAAA:, sha-256=:${b64('sha256')}:`, body)
            );
            assert.ok(
                !verifyContentDigestHeader(
                    `sha-256=:${b64('sha256')}:, sha-512=:${b64('sha256')}:`,
                    body
                )
            );
        });

        it('refuses a mismatch, an unsupported algorithm only, a bad shape or nothing', () => {
            assert.ok(!verifyContentDigestHeader(`sha-256=:${b64('sha512')}:`, body));
            assert.ok(!verifyContentDigestHeader('md5=:AAAA:', body));
            assert.ok(!verifyContentDigestHeader(`sha-256="${b64('sha256')}"`, body));
            assert.ok(!verifyContentDigestHeader(`SHA-256=${b64('sha256')}`, body));
            assert.ok(!verifyContentDigestHeader(undefined, body));
        });
    });
});
