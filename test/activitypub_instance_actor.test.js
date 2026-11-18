'use strict';

//
//  The ActivityPub instance actor (#966): its key and document, the GETs it
//  signs (and that it signs nothing else), WebFinger and NodeInfo.
//
//  The http_util tests use plain HTTP servers on 127.0.0.1 with
//  allowInsecureHttp, which skips the address checks for http:// URLs (those
//  are covered in http_util_ssrf.test.js).
//

const { strict: assert } = require('assert');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const http = require('http');

const configModule = require('../core/config.js');
const dbModule = require('../core/database.js');

const webConfig = {
    domain: 'bbs.example.com',
    https: { enabled: true, port: 443 },
    http: { port: 80 },
    handlers: { activityPub: { enabled: true, allowInsecureHttp: true } },
};
const TEST_CONFIG = {
    debug: { assertsEnabled: false },
    general: { boardName: 'Test Board' },
    contentServers: { web: webConfig },
};
const BASE = 'https://bbs.example.com';
const ACTOR_ID = `${BASE}/_enig/ap/actor`;

//  mirrors the instance_key table in database.js
const InstanceKeyTable = `CREATE TABLE IF NOT EXISTS instance_key (
    key_name            VARCHAR PRIMARY KEY NOT NULL,
    public_key_pem      VARCHAR NOT NULL,
    private_key_pem     VARCHAR NOT NULL,
    created_timestamp   DATETIME NOT NULL
);`;

//  a small key for the tests that need one stored (a real one is 4096 bits)
const testKey = (() => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
    });
    return {
        publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
        privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    };
})();

const quietLog = () => {
    const calls = { warn: [], error: [] };
    const noop = () => {};
    return {
        calls,
        trace: noop,
        debug: noop,
        info: noop,
        warn: (...args) => calls.warn.push(args),
        error: (...args) => calls.error.push(args),
        child() {
            return this;
        },
    };
};

//  a ServerResponse stand-in, given to |handlerFn|; resolves with what it got
function callHandler(handlerFn) {
    let resp;
    const done = new Promise(resolve => {
        resp = {
            writeHead(status, headers) {
                this.status = status;
                this.headers = headers;
            },
            end(body) {
                resolve({ status: this.status, headers: this.headers, body });
            },
        };
    });
    handlerFn(resp);
    return done;
}

let savedConfigGet;
let savedApDb;
let apDb;
let InstanceActor;
let ApUtil;
let HttpUtil;

//  loaded again with this file's config, and dropped again afterwards so
//  that nothing later picks up the copies that captured it
const ReloadedModules = [
    '../core/web_util.js',
    '../core/activitypub/endpoint.js',
    '../core/activitypub/instance_actor.js',
    '../core/activitypub/util.js',
    '../core/servers/content/web_handlers/webfinger.js',
    '../core/servers/content/web_handlers/nodeinfo2.js',
    '../core/servers/content/web_handlers/activitypub.js',
];
const dropReloaded = () =>
    ReloadedModules.forEach(m => delete require.cache[require.resolve(m)]);

function reloadModules() {
    dropReloaded();
    InstanceActor = require('../core/activitypub/instance_actor.js');
    ApUtil = require('../core/activitypub/util.js');
    HttpUtil = require('../core/http_util.js');
}

function storeTestKey() {
    apDb.prepare('INSERT OR REPLACE INTO instance_key VALUES (?, ?, ?, ?);').run(
        'main',
        testKey.publicKey,
        testKey.privateKey,
        'now'
    );
    InstanceActor._resetForTests();
}

describe('ActivityPub instance actor (#966)', function () {
    before(() => {
        savedConfigGet = configModule.get;
        configModule.get = () => TEST_CONFIG;
        savedApDb = dbModule.dbs.activitypub;
        apDb = new Database(':memory:');
        dbModule.dbs.activitypub = apDb;
        reloadModules();
    });

    after(() => {
        configModule.get = savedConfigGet;
        dbModule.dbs.activitypub = savedApDb;
        InstanceActor._resetForTests();
        dropReloaded();
        apDb.close();
    });

    beforeEach(() => {
        delete webConfig.overrideUrlPrefix;
        webConfig.handlers.activityPub.enabled = true;
        apDb.exec('DROP TABLE IF EXISTS instance_key;');
        apDb.exec(InstanceKeyTable);
        InstanceActor._resetForTests();
    });

    describe('key', function () {
        it('has no key, document or sign options before one is made', () => {
            assert.equal(InstanceActor.getKey(), null);
            assert.equal(InstanceActor.toDocument(), null);
            assert.equal(InstanceActor.fetchSignOptions(), null);
        });

        it('reads as no key, without throwing, from a database with no instance_key table', () => {
            apDb.exec('DROP TABLE instance_key;');
            assert.equal(InstanceActor.getKey(), null);
            assert.equal(InstanceActor.fetchSignOptions(), null);
        });

        it('makes an RSA 4096 key once, stores it, and gives every caller that key', async function () {
            this.timeout(60000);
            const ensure = () =>
                new Promise((resolve, reject) =>
                    InstanceActor.ensureKey((err, key) =>
                        err ? reject(err) : resolve(key)
                    )
                );
            const [a, b] = await Promise.all([ensure(), ensure()]);
            assert.equal(a.publicKey, b.publicKey);

            const rows = apDb.prepare('SELECT * FROM instance_key;').all();
            assert.equal(rows.length, 1);
            assert.equal(rows[0].key_name, 'main');
            assert.equal(rows[0].public_key_pem, a.publicKey);
            assert.equal(
                crypto.createPublicKey(a.publicKey).asymmetricKeyDetails.modulusLength,
                4096
            );

            //  another process (or the next start) reads the same key
            InstanceActor._resetForTests();
            assert.equal(InstanceActor.getKey().privateKey, a.privateKey);
            //  and ensureKey does not make another
            assert.equal((await ensure()).publicKey, a.publicKey);
            assert.equal(
                apDb.prepare('SELECT COUNT(*) AS n FROM instance_key;').get().n,
                1
            );
        });

        it('keeps the key another process stored while it was making one', async function () {
            this.timeout(60000);
            const result = new Promise((resolve, reject) =>
                InstanceActor.ensureKey((err, key) => (err ? reject(err) : resolve(key)))
            );
            //  stored by "the other process" before this one's key is ready
            apDb.prepare('INSERT INTO instance_key VALUES (?, ?, ?, ?);').run(
                'main',
                testKey.publicKey,
                testKey.privateKey,
                'now'
            );
            const key = await result;
            assert.equal(key.publicKey, testKey.publicKey);
            assert.equal(InstanceActor.getKey().publicKey, testKey.publicKey);
            assert.equal(
                apDb.prepare('SELECT COUNT(*) AS n FROM instance_key;').get().n,
                1
            );
        });

        describe('when making it fails', function () {
            const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
            //  fails the first |failures| calls, then gives the test key at once
            const generator = failures => {
                const g = cb => {
                    g.calls += 1;
                    setImmediate(() =>
                        g.calls <= failures
                            ? cb(new Error('no entropy today'))
                            : cb(null, testKey)
                    );
                };
                g.calls = 0;
                return g;
            };
            const ensure = () =>
                new Promise(resolve =>
                    InstanceActor.ensureKey((err, key) => resolve({ err, key }))
                );

            it('tries again once the wait after a failure is over, and signing starts', async () => {
                const gen = generator(1);
                InstanceActor._resetForTests({
                    generator: gen,
                    retryAfterFailureMs: 60,
                    missingRecheckMs: 0,
                });

                const first = await ensure();
                assert.match(first.err.message, /no entropy today/);
                assert.equal(gen.calls, 1);

                //  within the wait: not tried again, still unsigned
                assert.equal(InstanceActor.fetchSignOptions(), null);
                assert.equal(InstanceActor.toDocument(), null);
                assert.equal(gen.calls, 1);

                await wait(80);
                //  this call starts the attempt and still answers null
                assert.equal(InstanceActor.fetchSignOptions(), null);
                assert.equal(gen.calls, 2);
                await wait(5);

                const sign = InstanceActor.fetchSignOptions();
                assert.equal(sign && sign.keyId, `${ACTOR_ID}#main-key`);
                assert.equal(
                    apDb.prepare('SELECT public_key_pem FROM instance_key;').get()
                        .public_key_pem,
                    testKey.publicKey
                );
            });

            it('waits again after another failure', async () => {
                const gen = generator(2);
                InstanceActor._resetForTests({
                    generator: gen,
                    retryAfterFailureMs: 60,
                    missingRecheckMs: 0,
                });
                await ensure();
                await wait(80);
                InstanceActor.getKey(); // second attempt, which fails
                await wait(5);
                assert.equal(gen.calls, 2);
                InstanceActor.getKey();
                assert.equal(gen.calls, 2, 'not before the wait is over');
                await wait(80);
                InstanceActor.getKey();
                await wait(5);
                assert.equal(gen.calls, 3);
                assert.ok(InstanceActor.getKey());
            });

            it('never makes a key in a process that did not ask for one (oputil)', async () => {
                const gen = generator(0);
                InstanceActor._resetForTests({ generator: gen, missingRecheckMs: 0 });
                assert.equal(InstanceActor.getKey(), null);
                assert.equal(InstanceActor.fetchSignOptions(), null);
                await wait(5);
                assert.equal(gen.calls, 0);
                assert.equal(
                    apDb.prepare('SELECT COUNT(*) AS n FROM instance_key;').get().n,
                    0
                );
            });

            it('believes a missing key for a while instead of reading the table on every call', async () => {
                const gen = generator(0);
                InstanceActor._resetForTests({ generator: gen, missingRecheckMs: 60000 });
                assert.equal(InstanceActor.getKey(), null);
                apDb.prepare('INSERT INTO instance_key VALUES (?, ?, ?, ?);').run(
                    'main',
                    testKey.publicKey,
                    testKey.privateKey,
                    'now'
                );
                assert.equal(InstanceActor.getKey(), null, 'not read again yet');
                //  ensureKey() reads it at once, and makes nothing
                const { err, key } = await ensure();
                assert.ifError(err);
                assert.equal(key.publicKey, testKey.publicKey);
                assert.equal(gen.calls, 0);
            });
        });
    });

    describe('document', function () {
        it('is an Application actor for the board, at /_enig/ap/actor', () => {
            storeTestKey();
            const doc = InstanceActor.toDocument();
            assert.deepEqual(doc, {
                '@context': [
                    'https://www.w3.org/ns/activitystreams',
                    'https://w3id.org/security/v1',
                ],
                id: ACTOR_ID,
                type: 'Application',
                preferredUsername: 'bbs.example.com',
                name: 'Test Board',
                inbox: `${BASE}/_enig/ap/shared-inbox`,
                outbox: `${ACTOR_ID}/outbox`,
                endpoints: { sharedInbox: `${BASE}/_enig/ap/shared-inbox` },
                manuallyApprovesFollowers: true,
                discoverable: false,
                indexable: false,
                publicKey: {
                    id: `${ACTOR_ID}#main-key`,
                    owner: ACTOR_ID,
                    publicKeyPem: testKey.publicKey,
                },
            });
        });

        it('builds every URL from overrideUrlPrefix behind a reverse proxy', () => {
            storeTestKey();
            webConfig.overrideUrlPrefix = 'https://public.example.net/bbs';
            const doc = InstanceActor.toDocument();
            assert.equal(doc.id, 'https://public.example.net/bbs/_enig/ap/actor');
            assert.equal(doc.preferredUsername, 'public.example.net');
            assert.equal(doc.publicKey.id, `${doc.id}#main-key`);
            assert.equal(
                doc.inbox,
                'https://public.example.net/bbs/_enig/ap/shared-inbox'
            );
            assert.equal(InstanceActor.keyId(), `${doc.id}#main-key`);
        });

        it('has an empty outbox', () => {
            assert.deepEqual(InstanceActor.emptyOutbox(), {
                '@context': 'https://www.w3.org/ns/activitystreams',
                id: `${ACTOR_ID}/outbox`,
                type: 'OrderedCollection',
                totalItems: 0,
                orderedItems: [],
            });
        });

        it('recognises only its own id', () => {
            assert.equal(InstanceActor.isInstanceActorId(ACTOR_ID), true);
            assert.equal(InstanceActor.isInstanceActorId(`${ACTOR_ID}/outbox`), false);
            assert.equal(
                InstanceActor.isInstanceActorId(`${BASE}/_enig/ap/users/actor`),
                false
            );
            assert.equal(InstanceActor.isInstanceActorId(null), false);
        });
    });

    describe('sign options', function () {
        it('sign a GET as the instance actor, marked as such', () => {
            storeTestKey();
            const sign = InstanceActor.fetchSignOptions();
            assert.equal(sign.keyId, `${ACTOR_ID}#main-key`);
            assert.equal(sign.key, testKey.privateKey);
            assert.deepEqual(sign.headers, ['(request-target)', 'host', 'date']);
            assert.equal(sign.instanceActor, true);
        });

        it('util.fetchSignOptions() prefers the local user, then the instance actor', () => {
            const UserProps = require('../core/user_property.js');
            const user = {
                username: 'bob',
                getProperty: name =>
                    name === UserProps.PrivateActivityPubSigningKey ? 'bob key' : null,
            };
            assert.equal(ApUtil.fetchSignOptions(null), null, 'no key yet: unsigned');
            assert.equal(
                ApUtil.fetchSignOptions(user).keyId,
                `${BASE}/_enig/ap/users/bob#main-key`
            );

            storeTestKey();
            assert.equal(
                ApUtil.fetchSignOptions(user).keyId,
                `${BASE}/_enig/ap/users/bob#main-key`
            );
            assert.equal(ApUtil.fetchSignOptions(user).instanceActor, undefined);
            assert.equal(ApUtil.fetchSignOptions(null).keyId, `${ACTOR_ID}#main-key`);
            //  a user without a key
            assert.equal(
                ApUtil.fetchSignOptions({ username: 'x', getProperty: () => null }).keyId,
                `${ACTOR_ID}#main-key`
            );
            //  signedFetchOptions() stays user-only
            assert.equal(ApUtil.signedFetchOptions(null), null);
        });

        it('Actor lookups are signed as the instance actor when no user is given', done => {
            storeTestKey();
            const Actor = require('../core/activitypub/actor.js');
            const savedGetJson = HttpUtil.getJson;
            HttpUtil.getJson = (url, opts, cb) => {
                HttpUtil.getJson = savedGetJson;
                try {
                    assert.equal(opts.sign && opts.sign.keyId, `${ACTOR_ID}#main-key`);
                    assert.equal(Actor._signerKind(null), 'instance');
                } catch (e) {
                    return done(e);
                }
                cb(new Error('stop here'));
            };
            Actor._fromRemoteQuery(
                'https://remote.example/users/alice',
                null,
                null,
                err => {
                    HttpUtil.getJson = savedGetJson;
                    assert.ok(err);
                    done();
                }
            );
        });

        it('remembers failed actor lookups apart by who signed them', () => {
            const Actor = require('../core/activitypub/actor.js');
            const UserProps = require('../core/user_property.js');
            assert.equal(Actor._signerKind(null), 'none');
            storeTestKey();
            assert.equal(Actor._signerKind(null), 'instance');
            assert.equal(
                Actor._signerKind({
                    username: 'bob',
                    getProperty: n =>
                        n === UserProps.PrivateActivityPubSigningKey ? 'k' : null,
                }),
                'user'
            );
        });
    });

    describe('http_util', function () {
        let server;
        let port;
        let seen;
        const routes = new Map();

        before(done => {
            server = http.createServer((req, res) => {
                seen.push({ url: req.url, method: req.method, headers: req.headers });
                const route = routes.get(req.url) || { status: 404 };
                if (route.location) {
                    res.writeHead(route.status, { Location: route.location });
                    return res.end();
                }
                res.writeHead(route.status, {
                    'Content-Type': 'application/activity+json',
                });
                res.end(JSON.stringify(route.doc || {}));
            });
            server.listen(0, '127.0.0.1', () => {
                port = server.address().port;
                done();
            });
        });
        after(done => {
            for (const agent of Object.values(HttpUtil._agents)) {
                agent.destroy();
            }
            server.close(() => done());
        });
        beforeEach(() => {
            seen = [];
            routes.clear();
            storeTestKey();
        });

        const url = path => `http://127.0.0.1:${port}${path}`;
        const getJson = (u, opts) =>
            new Promise(resolve =>
                HttpUtil.getJson(u, opts, (err, body, res) => resolve({ err, body, res }))
            );

        it('signs a GET as the instance actor, without passing its marker on', async () => {
            routes.set('/doc', { status: 200, doc: { ok: 1 } });
            const sign = InstanceActor.fetchSignOptions();
            const { err, body } = await getJson(url('/doc'), { sign });
            assert.ifError(err);
            assert.deepEqual(body, { ok: 1 });
            assert.equal(
                sign.instanceActor,
                true,
                "the caller's options are not changed"
            );

            assert.equal(seen.length, 1);
            const { headers } = seen[0];
            assert.ok(!JSON.stringify(headers).includes('instanceActor'));

            //  the signature verifies with the published key
            const httpSignature = require('http-signature');
            const parsed = httpSignature.parseRequest({
                method: 'GET',
                url: '/doc',
                httpVersion: '1.1',
                headers,
            });
            assert.equal(parsed.keyId, `${ACTOR_ID}#main-key`);
            assert.ok(
                httpSignature.verifySignature(
                    parsed,
                    InstanceActor.toDocument().publicKey.publicKeyPem
                )
            );
        });

        it('refuses to sign anything but a GET with the instance key', async () => {
            const sign = InstanceActor.fetchSignOptions();
            const err = await new Promise(resolve =>
                HttpUtil.postJson(
                    url('/inbox'),
                    { type: 'Create' },
                    { headers: {}, sign },
                    e => resolve(e)
                )
            );
            assert.ok(err, 'refused');
            assert.match(err.message, /instance actor key signs GET requests only/);
            assert.equal(seen.length, 0, 'nothing was sent');
        });

        it('repeats an instance-signed GET unsigned when it is redirected, and follows the redirect', async () => {
            routes.set('/a', { status: 302, location: '/b' });
            routes.set('/b', { status: 200, doc: { id: 'b' } });
            const { err, body, res } = await getJson(url('/a'), {
                sign: InstanceActor.fetchSignOptions(),
            });
            assert.ifError(err);
            assert.deepEqual(body, { id: 'b' });
            assert.equal(res.responseUrl, url('/b'));
            assert.deepEqual(
                seen.map(r => [r.url, !!r.headers.signature]),
                [
                    ['/a', true],
                    ['/a', false],
                    ['/b', false],
                ]
            );
        });

        it('signs the remote collection counts the actor screens show', async () => {
            routes.set('/followers', {
                status: 200,
                doc: { id: url('/followers'), type: 'OrderedCollection', totalItems: 3 },
            });
            const Collection = require('../core/activitypub/collection.js');
            const stats = await new Promise((resolve, reject) =>
                Collection.getRemoteCollectionStats(url('/followers'), (err, s) =>
                    err ? reject(err) : resolve(s)
                )
            );
            assert.equal(stats.totalItems, 3);
            assert.match(
                seen[0].headers.signature,
                /keyId="https:\/\/bbs\.example\.com\/_enig\/ap\/actor#main-key"/
            );
        });

        it('charges a redirected instance-signed GET to the fetch budget once, plus its hop', async () => {
            const FetchBudget = require('../core/activitypub/fetch_budget.js');
            FetchBudget._reset();
            FetchBudget._setClock(() => 1000000); // no refill while it runs
            try {
                routes.set('/a', { status: 302, location: '/b' });
                routes.set('/b', { status: 200, doc: { id: 'b' } });
                const { err, body } = await new Promise(resolve =>
                    FetchBudget.run(() =>
                        HttpUtil.getJson(
                            url('/a'),
                            { sign: InstanceActor.fetchSignOptions() },
                            (e, b) => resolve({ err: e, body: b })
                        )
                    )
                );
                assert.ifError(err);
                assert.deepEqual(body, { id: 'b' });
                const bucket = FetchBudget._state().hosts.get('127.0.0.1');
                const perMinute = FetchBudget.DefaultLimits.perHostPerMinute;
                //  /a once (not again for its unsigned repeat), and the hop to /b
                assert.equal(perMinute - bucket.tokens, 2);
                assert.equal(bucket.inFlight, 0, 'the slot is given back once done');
            } finally {
                FetchBudget._setClock(null);
                FetchBudget._reset();
            }
        });

        it('leaves a user-signed GET that is redirected as it was: an error, not followed', async () => {
            routes.set('/a', { status: 302, location: '/b' });
            const sign = Object.assign({}, InstanceActor.fetchSignOptions(), {
                keyId: `${BASE}/_enig/ap/users/bob#main-key`,
            });
            delete sign.instanceActor;
            const { err } = await getJson(url('/a'), { sign });
            assert.ok(err);
            assert.equal(err.statusCode, 302);
            assert.deepEqual(
                seen.map(r => r.url),
                ['/a']
            );
        });
    });

    describe('web handler routes', function () {
        let ActivityPubWebHandler;
        before(() => {
            ActivityPubWebHandler =
                require('../core/servers/content/web_handlers/activitypub.js').getModule;
        });

        function handler() {
            const h = new ActivityPubWebHandler();
            h.log = quietLog();
            h.sysLog = h.log;
            h.webServer = {
                serviceUnavailable: (resp, secs) => resp.end({ status: 503, secs }),
                resourceNotFound: resp => resp.end({ status: 404 }),
            };
            return h;
        }

        it('serves the actor document as activity+json', async () => {
            storeTestKey();
            const h = handler();
            const out = await callHandler(resp => h._instanceActorGetHandler({}, resp));
            assert.equal(out.status, 200);
            assert.equal(out.headers['Content-Type'], 'application/activity+json');
            assert.equal(out.headers['Cache-Control'], 'public, max-age=600');
            assert.deepEqual(JSON.parse(out.body), InstanceActor.toDocument());
        });

        it('answers 503 while there is no key yet', async () => {
            const h = handler();
            const out = await callHandler(resp => h._instanceActorGetHandler({}, resp));
            assert.deepEqual(out.body, { status: 503, secs: 10 });
        });

        it('serves the empty outbox', async () => {
            const h = handler();
            const out = await callHandler(resp =>
                h._instanceActorOutboxGetHandler({}, resp)
            );
            assert.equal(out.status, 200);
            assert.deepEqual(JSON.parse(out.body), InstanceActor.emptyOutbox());
        });

        it('cannot be followed: a Follow of it finds no local user (404)', async () => {
            const User = require('../core/user.js');
            const saved = User.getUserIdsWithProperty;
            User.getUserIdsWithProperty = (name, value, cb) => cb(null, []);
            try {
                const h = handler();
                const out = await callHandler(resp =>
                    h._inboxFollowActivity(
                        resp,
                        { id: 'https://remote.example/users/alice' },
                        {
                            type: 'Follow',
                            actor: 'https://remote.example/users/alice',
                            object: ACTOR_ID,
                        }
                    )
                );
                assert.deepEqual(out.body, { status: 404 });
            } finally {
                User.getUserIdsWithProperty = saved;
            }
        });
    });

    describe('WebFinger', function () {
        let handler;
        let User;
        beforeEach(() => {
            const WebFinger =
                require('../core/servers/content/web_handlers/webfinger.js').getModule;
            User = require('../core/user.js');
            handler = new WebFinger();
            handler.log = quietLog();
            handler.acceptedResourceRegExps = [];
            handler.webServer = {
                resourceNotFound: resp => resp.end({ status: 404 }),
                respondWithError: (resp, status) => resp.end({ status }),
                serviceUnavailable: (resp, secs) => resp.end({ status: 503, secs }),
            };
            storeTestKey();
        });

        const finger = resource =>
            callHandler(resp =>
                handler._webFingerRequestHandler(
                    {
                        url: `/.well-known/webfinger?resource=${encodeURIComponent(resource)}`,
                    },
                    resp
                )
            );
        const instanceJrd = {
            subject: 'acct:bbs.example.com@bbs.example.com',
            aliases: [ACTOR_ID],
            links: [{ rel: 'self', type: 'application/activity+json', href: ACTOR_ID }],
        };

        it('finds the instance actor as acct:<domain>@<domain>', async () => {
            const out = await finger('acct:bbs.example.com@bbs.example.com');
            assert.equal(out.status, 200);
            assert.equal(out.headers['Content-Type'], 'application/jrd+json');
            assert.deepEqual(JSON.parse(out.body), instanceJrd);
        });

        it('finds it by its actor URL, and in any case', async () => {
            assert.deepEqual(JSON.parse((await finger(ACTOR_ID)).body), instanceJrd);
            assert.deepEqual(
                JSON.parse((await finger('acct:BBS.example.com@bbs.EXAMPLE.com')).body),
                instanceJrd
            );
        });

        it('answers 503, as the actor does, while there is no key yet', async () => {
            apDb.exec('DELETE FROM instance_key;');
            InstanceActor._resetForTests();
            const out = await finger('acct:bbs.example.com@bbs.example.com');
            assert.deepEqual(out.body, { status: 503, secs: 10 });
        });

        it('does not exist while ActivityPub is off', async () => {
            webConfig.handlers.activityPub.enabled = false;
            const out = await finger('acct:bbs.example.com@bbs.example.com');
            assert.deepEqual(out.body, { status: 404 });
        });

        it('warns once when a local user is named like the web domain', () => {
            const saved = User.getUserIdAndName;
            try {
                User.getUserIdAndName = (name, cb) =>
                    name === 'bbs.example.com'
                        ? cb(null, 7, 'BBS.example.com')
                        : cb(new Error('none'));
                handler._warnOnInstanceActorNameCollision('bbs.example.com');
                assert.equal(handler.log.calls.warn.length, 1);
                assert.match(handler.log.calls.warn[0][1], /named like the web domain/);

                handler.log.calls.warn.length = 0;
                handler._warnOnInstanceActorNameCollision('other.example');
                assert.equal(handler.log.calls.warn.length, 0);

                webConfig.handlers.activityPub.enabled = false;
                handler._warnOnInstanceActorNameCollision('bbs.example.com');
                assert.equal(handler.log.calls.warn.length, 0);
            } finally {
                User.getUserIdAndName = saved;
            }
        });
    });

    describe('NodeInfo discovery (FEP-2677)', function () {
        const discover = () => {
            const NodeInfo =
                require('../core/servers/content/web_handlers/nodeinfo2.js').getModule;
            const h = new NodeInfo();
            h.log = quietLog();
            return callHandler(resp => h._nodeInfoDiscoveryHandler({}, resp)).then(out =>
                JSON.parse(out.body)
            );
        };
        const Rel = 'https://www.w3.org/ns/activitystreams#Application';

        it('links the instance actor', async () => {
            const { links } = await discover();
            assert.deepEqual(
                links.filter(l => l.rel === Rel),
                [{ rel: Rel, href: ACTOR_ID }]
            );
            assert.equal(links.length, 3, 'the NodeInfo links stay');
        });

        it('does not while ActivityPub is off', async () => {
            webConfig.handlers.activityPub.enabled = false;
            const { links } = await discover();
            assert.equal(links.filter(l => l.rel === Rel).length, 0);
            assert.equal(links.length, 2);
        });
    });
});
