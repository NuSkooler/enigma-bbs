'use strict';

//
//  The signed header set and Digest rules inbound ActivityPub requests must
//  meet, through the web handler's own parse (_parseAndValidateSignature)
//  and the inbox POST's body check.
//
//  Request shapes follow what each implementation's signer sends; see the
//  RequiredSignedHeaders comment in core/activitypub/security.js.
//

const { strict: assert } = require('assert');
const crypto = require('crypto');
const { Readable } = require('stream');
const httpSignature = require('http-signature');

const HOST = 'test.example.com';
const INBOX = '/_enig/ap/shared-inbox';
const KEY_ID = 'https://remote.example/users/alice#main-key';

let privateKey, publicKey;
let ActivityPubWebHandler;

function sha256(body) {
    return 'SHA-256=' + crypto.createHash('sha256').update(body).digest('base64');
}

//
//  Build a signed request. headers holds the HTTP headers sent; signed lists
//  the header names covered, in order; extraParams adds created / expires.
//
function signedRequest({
    method = 'POST',
    path = INBOX,
    body = '',
    headers,
    signed,
    algorithm = 'rsa-sha256',
    extraParams = {},
    headerName = 'signature',
}) {
    const lines = signed.map(h => {
        if (h === '(request-target)') {
            return `(request-target): ${method.toLowerCase()} ${path}`;
        }
        if (h === '(created)' || h === '(expires)') {
            return `${h}: ${extraParams[h.slice(1, -1)]}`;
        }
        return `${h}: ${headers[h]}`;
    });
    const sig = crypto
        .sign('sha256', Buffer.from(lines.join('\n')), privateKey)
        .toString('base64');
    const params = Object.entries(extraParams)
        .map(([k, v]) => `${k}=${v}`)
        .join(',');
    const value =
        `keyId="${KEY_ID}",algorithm="${algorithm}",` +
        (params ? `${params},` : '') +
        `headers="${signed.join(' ')}",signature="${sig}"`;

    const req = Readable.from(body ? [Buffer.from(body)] : []);
    req.headers = Object.assign({}, headers, {
        [headerName]: headerName === 'authorization' ? `Signature ${value}` : value,
    });
    req.url = path;
    req.method = method;
    return req;
}

function postShaped(signed, { body = '{"type":"Create"}', digest } = {}) {
    return signedRequest({
        body,
        headers: {
            host: HOST,
            date: new Date().toUTCString(),
            digest: digest || sha256(body),
            'content-type': 'application/activity+json',
            'content-length': String(Buffer.byteLength(body)),
        },
        signed,
    });
}

function newHandler(warnings = []) {
    const handler = new ActivityPubWebHandler();
    const noop = () => {};
    handler.log = {
        fatal: noop,
        error: noop,
        warn: (obj, msg) => warnings.push({ obj, msg }),
        info: noop,
        debug: noop,
        trace: noop,
    };
    handler.sysLog = handler.log;
    return handler;
}

function parsesAndVerifies(req) {
    const signature = newHandler()._parseAndValidateSignature(req);
    return !!signature && httpSignature.verifySignature(signature, publicKey);
}

describe('inbound HTTP signatures: required signed headers and Digest', function () {
    before(() => {
        ({ privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        }));
        ActivityPubWebHandler =
            require('../core/servers/content/web_handlers/activitypub.js').getModule;
    });

    describe('requests as major implementations send them are accepted', function () {
        it('Mastodon: host date digest content-type (request-target)', () => {
            const req = postShaped([
                'host',
                'date',
                'digest',
                'content-type',
                '(request-target)',
            ]);
            assert.ok(parsesAndVerifies(req));
        });

        it('GoToSocial: hs2019 over (request-target) host date digest', () => {
            const body = '{"type":"Follow"}';
            const now = Math.floor(Date.now() / 1000);
            const req = signedRequest({
                body,
                headers: {
                    host: HOST,
                    date: new Date().toUTCString(),
                    digest: sha256(body),
                },
                signed: ['(request-target)', 'host', 'date', 'digest'],
                algorithm: 'hs2019',
                extraParams: { created: now, expires: now + 3600 },
            });
            assert.ok(parsesAndVerifies(req));
        });

        it('Pleroma / Akkoma: adds content-length', () => {
            const req = postShaped([
                '(request-target)',
                'content-length',
                'date',
                'digest',
                'host',
            ]);
            assert.ok(parsesAndVerifies(req));
        });

        it('Misskey / Sharkey: (request-target) date host digest', () => {
            const req = postShaped(['(request-target)', 'date', 'host', 'digest']);
            assert.ok(parsesAndVerifies(req));
        });

        it('Lemmy: hs2019 with (created) and (expires) as well as date', () => {
            const body = '{"type":"Announce"}';
            const now = Math.floor(Date.now() / 1000);
            const req = signedRequest({
                body,
                headers: {
                    host: HOST,
                    date: new Date().toUTCString(),
                    digest: sha256(body),
                    'content-type': 'application/activity+json',
                },
                signed: [
                    '(request-target)',
                    '(created)',
                    '(expires)',
                    'content-type',
                    'date',
                    'digest',
                    'host',
                ],
                algorithm: 'hs2019',
                extraParams: { created: now, expires: now + 600 },
            });
            assert.ok(parsesAndVerifies(req));
        });

        it('in an Authorization header as well as Signature', () => {
            const body = '{"type":"Like"}';
            const req = signedRequest({
                body,
                headers: {
                    host: HOST,
                    date: new Date().toUTCString(),
                    digest: sha256(body),
                },
                signed: ['(request-target)', 'host', 'date', 'digest'],
                headerName: 'authorization',
            });
            assert.ok(parsesAndVerifies(req));
        });
    });

    describe('the signature must cover (request-target), host and date', function () {
        const cases = [
            ['date only', ['date']],
            ['no (request-target)', ['host', 'date', 'digest']],
            ['no host', ['(request-target)', 'date', 'digest']],
            ['no date', ['(request-target)', 'host', 'digest']],
        ];
        for (const [name, signed] of cases) {
            it(`refuses a signature over ${name}`, () => {
                const warnings = [];
                const req = postShaped(signed);
                assert.equal(newHandler(warnings)._parseAndValidateSignature(req), null);
            });
        }

        it('says which headers were missing', () => {
            const warnings = [];
            newHandler(warnings)._parseAndValidateSignature(postShaped(['date']));
            const w = warnings.find(w => /required headers are not signed/.test(w.msg));
            assert.ok(w, 'logged');
            assert.deepEqual(w.obj.missing, ['(request-target)', 'host', 'digest']);
        });

        it('applies the same set to a GET (digest not needed)', () => {
            const get = signed =>
                signedRequest({
                    method: 'GET',
                    path: '/_enig/ap/users/bob',
                    headers: { host: HOST, date: new Date().toUTCString() },
                    signed,
                });
            assert.ok(parsesAndVerifies(get(['(request-target)', 'host', 'date'])));
            assert.equal(
                newHandler()._parseAndValidateSignature(
                    get(['(request-target)', 'date'])
                ),
                null
            );
        });
    });

    describe('a POST must sign a Digest that matches its body', function () {
        it('refuses a POST that does not sign its Digest', () => {
            const req = postShaped(['(request-target)', 'host', 'date']);
            assert.equal(newHandler()._parseAndValidateSignature(req), null);
        });

        function post(req) {
            const warnings = [];
            const handler = newHandler(warnings);
            return new Promise(resolve => {
                const respond = name => () => resolve({ result: name, warnings });
                handler.webServer = {
                    accepted: respond('accepted'),
                    accessDenied: respond('accessDenied'),
                    resourceNotFound: respond('resourceNotFound'),
                    badRequest: respond('badRequest'),
                    notImplemented: respond('notImplemented'),
                    internalServerError: respond('internalServerError'),
                    requestEntityTooLarge: respond('requestEntityTooLarge'),
                    serviceUnavailable: respond('serviceUnavailable'),
                };
                const signature = handler._parseAndValidateSignature(req);
                assert.ok(signature, 'the request itself parses');
                handler._inboxPostHandler(req, {}, signature, 'sharedInbox');
            });
        }

        const digestRejected = ({ warnings }) =>
            warnings.some(w => /^Digest header missing, unsupported/.test(w.msg));

        it('refuses a signed Digest that does not match the body', async () => {
            const req = postShaped(['(request-target)', 'host', 'date', 'digest'], {
                body: '{"type":"Create","n":1}',
                digest: sha256('{"type":"Create","n":2}'),
            });
            const got = await post(req);
            assert.equal(got.result, 'badRequest');
            assert.ok(digestRejected(got));
        });

        it('refuses a signed Digest in an unsupported algorithm', async () => {
            const req = postShaped(['(request-target)', 'host', 'date', 'digest'], {
                digest: 'MD5=rL0Y20zC+Fzt72VPzMSk2A==',
            });
            const got = await post(req);
            assert.equal(got.result, 'badRequest');
            assert.ok(digestRejected(got));
        });

        it('lets a matching Digest through to the activity checks', async () => {
            //  an empty object: past the Digest it fails as an activity
            const req = postShaped(['(request-target)', 'host', 'date', 'digest'], {
                body: '{}',
            });
            const got = await post(req);
            assert.ok(!digestRejected(got), 'the Digest check passed');
        });
    });
});
