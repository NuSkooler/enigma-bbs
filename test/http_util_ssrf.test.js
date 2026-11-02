'use strict';

//
//  http_util connect-time SSRF checks (#966): every outbound socket's lookup
//  resolves the host and refuses the connection if any address is blocked.
//
//  The real-socket tests stand up HTTPS (and HTTP) servers on 127.0.0.1 and
//  127.0.0.2 -- both loopback on Linux -- with dns.lookup stubbed to map the
//  test names onto them. To test the wiring rather than the address table,
//  Security.isBlockedAddress is wrapped so 127.0.0.1 counts as allowed and
//  127.0.0.2 stays blocked (it is loopback). Every check of "refused" also
//  asserts the server at 127.0.0.2 never saw a connection.
//

const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const dns = require('node:dns');
const https = require('node:https');
const http = require('node:http');

const configModule = require('../core/config.js');
const loggerModule = require('../core/logger.js');
const Security = require('../core/activitypub/security.js');
const HttpUtil = require('../core/http_util.js');
const { ErrorReasons } = require('../core/enig_error.js');

//
//  A fresh key and self-signed cert for ssrf-fixture.net and
//  *.ssrf-fixture.net, valid for a day, made with the openssl binary in
//  |dir|. Throws, rather than letting the tests be skipped, when openssl
//  is missing.
//
function makeFixtureCert(dir) {
    const keyPath = path.join(dir, 'ssrf-fixture.key');
    const certPath = path.join(dir, 'ssrf-fixture.crt');
    try {
        execFileSync(
            'openssl',
            [
                'req',
                '-x509',
                '-newkey',
                'ec',
                '-pkeyopt',
                'ec_paramgen_curve:prime256v1',
                '-nodes',
                '-days',
                '1',
                '-keyout',
                keyPath,
                '-out',
                certPath,
                '-subj',
                '/CN=ssrf-fixture.net',
                '-addext',
                'subjectAltName=DNS:ssrf-fixture.net,DNS:*.ssrf-fixture.net',
            ],
            { stdio: 'pipe' }
        );
    } catch (e) {
        const why = e.code === 'ENOENT' ? 'not found' : (e.stderr || e).toString();
        throw new Error(
            `these tests need the openssl binary for a test TLS certificate: ${why}`
        );
    }
    return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
}

const ALLOWED_ADDR = '127.0.0.1';
const BLOCKED_ADDR = '127.0.0.2';

//  the codes core/webfinger.js falls back to plain http:// on
const WebFingerFallbackCodes = ['ECONNREFUSED', 'ECONNRESET', 'EPROTO'];

function assertRefused(err) {
    assert.ok(err, 'expected the request to be refused');
    assert.equal(err.reasonCode, ErrorReasons.BlockedAddress, `err: ${err}`);
    assert.ok(!WebFingerFallbackCodes.includes(err.code), `code: ${err.code}`);
}

//  a dns.lookup stand-in over a name -> [addresses] map
function makeLookupStub(hosts, calls) {
    return (hostname, opts, cb) => {
        if (typeof opts === 'function') {
            cb = opts;
            opts = {};
        }
        calls.push({ hostname, opts });
        const addrs = hosts[hostname];
        process.nextTick(() => {
            if (!addrs || addrs.length === 0) {
                const err = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
                err.code = 'ENOTFOUND';
                return cb(err);
            }
            const records = addrs.map(address => ({
                address,
                family: address.includes(':') ? 6 : 4,
            }));
            if (opts.all) {
                return cb(null, records);
            }
            return cb(null, records[0].address, records[0].family);
        });
    };
}

describe('http_util _checkedLookup()', function () {
    let savedLookup;
    let savedLog;
    let hosts;
    let calls;
    let warns;

    beforeEach(() => {
        hosts = {};
        calls = [];
        warns = [];
        savedLookup = dns.lookup;
        dns.lookup = makeLookupStub(hosts, calls);
        savedLog = loggerModule.log;
        loggerModule.log = Object.assign({}, savedLog, {
            warn: (...args) => warns.push(args),
        });
    });

    afterEach(() => {
        dns.lookup = savedLookup;
        loggerModule.log = savedLog;
    });

    it('refuses a host resolving to 127.0.0.1', done => {
        hosts['loop.example.com'] = ['127.0.0.1'];
        HttpUtil._checkedLookup(true, 'loop.example.com', { all: true }, err => {
            assertRefused(err);
            assert.equal(warns.length, 1, 'one warn per refusal');
            assert.deepEqual(
                warns[0][0].refused.map(r => r.address),
                ['127.0.0.1']
            );
            return done();
        });
    });

    it('refuses when any one address is blocked (no filtering)', done => {
        hosts['mixed.example.com'] = ['93.184.216.34', '10.0.0.5'];
        HttpUtil._checkedLookup(true, 'mixed.example.com', {}, err => {
            assertRefused(err);
            assert.deepEqual(
                warns[0][0].refused.map(r => r.address),
                ['10.0.0.5']
            );
            return done();
        });
    });

    it('resolves every address even when one is asked for', done => {
        hosts['mixed.example.com'] = ['93.184.216.34', '10.0.0.5'];
        HttpUtil._checkedLookup(true, 'mixed.example.com', { family: 4 }, err => {
            assertRefused(err);
            assert.equal(calls[0].opts.all, true);
            assert.equal(calls[0].opts.family, 4);
            return done();
        });
    });

    it('passes all-public addresses through in the all:true shape', done => {
        hosts['pub.example.com'] = ['93.184.216.34', '2606:4700::1111'];
        HttpUtil._checkedLookup(true, 'pub.example.com', { all: true }, (err, addrs) => {
            assert.ifError(err);
            assert.deepEqual(addrs, [
                { address: '93.184.216.34', family: 4 },
                { address: '2606:4700::1111', family: 6 },
            ]);
            assert.equal(warns.length, 0);
            return done();
        });
    });

    it('passes all-public addresses through in the single-address shape', done => {
        hosts['pub.example.com'] = ['2606:4700::1111', '93.184.216.34'];
        HttpUtil._checkedLookup(true, 'pub.example.com', {}, (err, address, family) => {
            assert.ifError(err);
            assert.equal(address, '2606:4700::1111');
            assert.equal(family, 6);
            return done();
        });
    });

    it('passes a resolver error through unchanged', done => {
        HttpUtil._checkedLookup(true, 'nowhere.example.com', { all: true }, err => {
            assert.equal(err.code, 'ENOTFOUND');
            assert.equal(warns.length, 0);
            return done();
        });
    });
});

describe('http_util connect-time SSRF checks (real sockets)', function () {
    const mutableApConfig = { allowInsecureHttp: false };
    const TEST_CONFIG = {
        debug: { assertsEnabled: false },
        menus: { cls: false },
        general: { boardName: 'TestBoard' },
        contentServers: { web: { handlers: { activityPub: mutableApConfig } } },
    };

    const hosts = {};
    const hits = [];
    const lookupCalls = [];
    //  address -> connections seen, per protocol
    const seen = { https: {}, http: {} };
    const servers = [];
    const ports = {};

    let savedConfig;
    let savedLookup;
    let savedIsBlocked;
    let savedLog;
    let warns;
    let certDir;

    const handler = (req, res) => {
        const hop = /^\/hop\/(\d+)\/([a-z]+)$/.exec(req.url);
        if (hop) {
            //  /hop/N/host: redirect to host's /hop/N-1/host, then answer
            const n = Number(hop[1]);
            hits.push(`${req.headers.host.split('.')[0]} ${req.url}`);
            if (n > 0) {
                res.writeHead(302, {
                    Location: `https://${hop[2]}.ssrf-fixture.net:${ports.https}/hop/${
                        n - 1
                    }/${hop[2]}`,
                });
                return res.end();
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end('{"ok":true}');
        }
        if (req.url === '/cutoff') {
            //  headers and part of the body, then the socket goes
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Content-Length': '1000',
            });
            res.write('{"partial":');
            return setTimeout(() => req.socket.destroy(), 30);
        }
        if (req.url === '/trickle') {
            //  a byte at a time, never finishing
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Content-Length': '1000',
            });
            const timer = setInterval(() => res.write(' '), 50);
            return res.on('close', () => clearInterval(timer));
        }
        if (req.url === '/redir') {
            res.writeHead(302, { Location: req.headers['x-redirect-to'] });
            return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, url: req.url }));
    };

    const listen = (server, proto, address, listenPort, cb) => {
        seen[proto][address] = 0;
        server.on('connection', () => {
            seen[proto][address] += 1;
        });
        server.once('error', cb);
        server.listen(listenPort, address, () => {
            servers.push(server);
            return cb(null, server.address().port);
        });
    };

    //  drop every pooled socket so the next request needs a new one (and so
    //  a fresh lookup)
    const dropSockets = () => {
        for (const agent of Object.values(HttpUtil._agents)) {
            for (const list of Object.values(agent.freeSockets)) {
                list.forEach(s => s.destroy());
            }
        }
    };

    const tls = {}; // { ca }, once before() has made the cert
    const url = (host, p = '/thing', proto = 'https') =>
        `${proto}://${host}.ssrf-fixture.net:${ports[proto]}${p}`;

    before(function (done) {
        savedConfig = configModule.get;
        configModule.get = () => TEST_CONFIG;

        savedIsBlocked = Security.isBlockedAddress;
        Security.isBlockedAddress = address =>
            address === ALLOWED_ADDR ? null : savedIsBlocked(address);

        savedLog = loggerModule.log;
        loggerModule.log = Object.assign({}, savedLog, {
            warn: (...args) => warns.push(args),
        });

        //  after the saves above: after() restores them even if this throws
        certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enigma-ssrf-test-'));
        const { cert, key } = makeFixtureCert(certDir);
        tls.ca = cert;

        //  each protocol's servers share a port across both addresses, so a
        //  name's URL reaches whichever address it resolves to
        const opts = { key, cert };
        const pair = (proto, make, cb) => {
            listen(make(), proto, ALLOWED_ADDR, 0, (err, p) => {
                if (err) return cb(err);
                ports[proto] = p;
                return listen(make(), proto, BLOCKED_ADDR, p, cb);
            });
        };
        pair(
            'https',
            () => https.createServer(opts, handler),
            err => {
                if (err) return done(err);
                pair(
                    'http',
                    () => http.createServer(handler),
                    err => {
                        //  only now: server.listen() resolves its address too
                        savedLookup = dns.lookup;
                        dns.lookup = makeLookupStub(hosts, lookupCalls);
                        return done(err);
                    }
                );
            }
        );
    });

    after(function (done) {
        configModule.get = savedConfig;
        if (savedLookup) {
            dns.lookup = savedLookup;
        }
        Security.isBlockedAddress = savedIsBlocked;
        loggerModule.log = savedLog;
        dropSockets();
        if (certDir) {
            fs.rmSync(certDir, { recursive: true, force: true });
        }

        let pending = servers.length;
        if (!pending) return done();
        servers.forEach(s => {
            s.closeAllConnections && s.closeAllConnections();
            s.close(() => --pending || done());
        });
    });

    beforeEach(() => {
        mutableApConfig.allowInsecureHttp = false;
        Object.keys(hosts).forEach(h => delete hosts[h]);
        hosts['ok.ssrf-fixture.net'] = [ALLOWED_ADDR];
        hosts['evil.ssrf-fixture.net'] = [BLOCKED_ADDR];
        hosts['attacker.ssrf-fixture.net'] = [ALLOWED_ADDR];
        hosts['victim.ssrf-fixture.net'] = [ALLOWED_ADDR];
        hits.length = 0;
        lookupCalls.length = 0;
        warns = [];
        dropSockets();
        for (const proto of Object.keys(seen)) {
            for (const addr of Object.keys(seen[proto])) {
                seen[proto][addr] = 0;
            }
        }
    });

    it('control: the blocked server answers when nothing refuses it', done => {
        //  proves a refusal below is the check, not an unreachable server
        const wrapped = Security.isBlockedAddress;
        Security.isBlockedAddress = () => null;
        HttpUtil.getJson(url('evil'), tls, (err, json) => {
            Security.isBlockedAddress = wrapped;
            assert.ifError(err);
            assert.equal(json.ok, true);
            assert.equal(seen.https[BLOCKED_ADDR], 1);
            return done();
        });
    });

    it('allows a host resolving to an allowed address (TLS options reach the agent)', done => {
        HttpUtil.getJson(url('ok'), tls, (err, json) => {
            assert.ifError(err);
            assert.equal(json.ok, true);
            assert.equal(seen.https[ALLOWED_ADDR], 1);
            assert.ok(lookupCalls.some(c => c.hostname === 'ok.ssrf-fixture.net'));
            return done();
        });
    });

    it('refuses a GET to a host resolving to a blocked address', done => {
        HttpUtil.getJson(url('evil'), tls, err => {
            assertRefused(err);
            assert.equal(seen.https[BLOCKED_ADDR], 0, 'no connection was made');
            assert.equal(warns.length, 1, 'one warn per refusal');
            assert.equal(warns[0][0].host, 'evil.ssrf-fixture.net');
            return done();
        });
    });

    it('refuses a redirect whose second hop resolves to a blocked address', done => {
        const opts = Object.assign({}, tls, {
            headers: { 'X-Redirect-To': url('evil') },
        });
        HttpUtil.getJson(url('ok', '/redir'), opts, err => {
            assertRefused(err);
            assert.equal(seen.https[ALLOWED_ADDR], 1, 'hop 1 was made');
            assert.equal(seen.https[BLOCKED_ADDR], 0, 'hop 2 was not');
            return done();
        });
    });

    it('refuses a rebinding host on a new socket', done => {
        hosts['rebind.ssrf-fixture.net'] = [ALLOWED_ADDR];
        HttpUtil.getJson(url('rebind'), tls, err => {
            assert.ifError(err);
            assert.equal(seen.https[ALLOWED_ADDR], 1);

            hosts['rebind.ssrf-fixture.net'] = [BLOCKED_ADDR];
            dropSockets();
            HttpUtil.getJson(url('rebind'), tls, err => {
                assertRefused(err);
                assert.equal(seen.https[BLOCKED_ADDR], 0);
                assert.equal(
                    lookupCalls.filter(c => c.hostname === 'rebind.ssrf-fixture.net')
                        .length,
                    2
                );
                return done();
            });
        });
    });

    it('refuses a POST (postJson) the same way', done => {
        const opts = Object.assign({}, tls, { headers: {} });
        HttpUtil.postJson(url('evil', '/inbox'), { hello: 'world' }, opts, err => {
            assertRefused(err);
            assert.equal(seen.https[BLOCKED_ADDR], 0);
            return done();
        });
    });

    it('refuses a signed GET the same way', done => {
        const { privateKey } = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
        });
        const opts = Object.assign({}, tls, {
            headers: { Date: new Date().toUTCString() },
            sign: {
                key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
                keyId: 'https://ok.ssrf-fixture.net/users/alice#main-key',
                authorizationHeaderName: 'Signature',
                headers: ['(request-target)', 'host', 'date'],
            },
        });
        HttpUtil.getJson(url('evil'), opts, err => {
            assertRefused(err);
            assert.equal(seen.https[BLOCKED_ADDR], 0);
            return done();
        });
    });

    it('with allowInsecureHttp, http:// to a loopback host is allowed but https:// is still refused', done => {
        mutableApConfig.allowInsecureHttp = true;
        HttpUtil.getJson(url('evil', '/thing', 'http'), {}, (err, json) => {
            assert.ifError(err);
            assert.equal(json.ok, true);
            assert.equal(seen.http[BLOCKED_ADDR], 1);

            HttpUtil.getJson(url('evil'), tls, err => {
                assertRefused(err);
                assert.equal(seen.https[BLOCKED_ADDR], 0);
                return done();
            });
        });
    });

    //  #966 phase B review: a response cut off part way, or one that never
    //  finishes, must still call back and free its fetch budget slot
    describe('responses that never complete', function () {
        const FetchBudget = require('../core/activitypub/fetch_budget.js');
        const boardInFlight = () => {
            const board = FetchBudget._state().boardBucket;
            return board ? board.inFlight : 0;
        };
        const signedOpts = () => {
            const { privateKey } = crypto.generateKeyPairSync('rsa', {
                modulusLength: 1024,
            });
            return Object.assign({}, tls, {
                headers: { Date: new Date().toUTCString() },
                sign: {
                    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
                    keyId: 'https://ok.ssrf-fixture.net/users/alice#main-key',
                    authorizationHeaderName: 'Signature',
                    headers: ['(request-target)', 'host', 'date'],
                },
            });
        };

        //  done() inside run() hands mocha's next step the store: a moving
        //  fake clock makes such a leftover store stale for later tests
        let clock = 1e9;
        beforeEach(() => {
            clock += 10 * 60 * 1000;
            FetchBudget._setClock(() => clock);
        });
        afterEach(() => {
            HttpUtil._setMinDeadlineMs(null);
            FetchBudget._setClock(null);
        });

        for (const signed of [false, true]) {
            const kind = signed ? 'signed (node:https)' : 'unsigned (follow-redirects)';

            it(`calls back and frees the slot when a response is cut off: ${kind}`, done => {
                FetchBudget.run(() => {
                    HttpUtil.getJson(
                        url('ok', '/cutoff'),
                        signed ? signedOpts() : tls,
                        err => {
                            assert.ok(err, 'an error');
                            setImmediate(() => {
                                assert.equal(boardInFlight(), 0);
                                return done();
                            });
                        }
                    );
                });
            });

            it(`gives up on a response that trickles past the deadline: ${kind}`, done => {
                HttpUtil._setMinDeadlineMs(300);
                const opts = Object.assign(
                    signed ? signedOpts() : Object.assign({}, tls),
                    {
                        timeout: 100, // idle: never trips, a byte comes every 50ms
                    }
                );
                const started = Date.now();
                FetchBudget.run(() => {
                    HttpUtil.getJson(url('ok', '/trickle'), opts, err => {
                        assert.ok(err);
                        assert.match(err.message, /took too long/);
                        assert.ok(Date.now() - started < 2000);
                        setImmediate(() => {
                            assert.equal(boardInFlight(), 0);
                            return done();
                        });
                    });
                });
            });
        }
    });

    describe('redirects (#966)', function () {
        const FetchBudget = require('../core/activitypub/fetch_budget.js');
        let savedLimits;

        let clock = 2e9; // as above
        beforeEach(() => {
            savedLimits = mutableApConfig.outboundFetchLimits;
            clock += 10 * 60 * 1000;
            FetchBudget._setClock(() => clock);
        });
        afterEach(() => {
            mutableApConfig.outboundFetchLimits = savedLimits;
            FetchBudget._setClock(null);
        });

        it('follows at most 3 redirects', done => {
            HttpUtil.getJson(url('ok', '/hop/5/ok'), tls, err => {
                assert.ok(err, 'refused');
                assert.equal(hits.length, 4, 'the first request and 3 hops');
                return done();
            });
        });

        it("charges each hop's host a rate token, refusing a hop it has none for", done => {
            mutableApConfig.outboundFetchLimits = { perHostPerMinute: 1 };
            FetchBudget.run(store => {
                //  attacker -> victim -> victim: victim's second hop is refused
                HttpUtil.getJson(url('attacker', '/hop/2/victim'), tls, err => {
                    assert.ok(FetchBudget.isBudgetError(err), `err: ${err}`);
                    assert.deepEqual(hits, [
                        'attacker /hop/2/victim',
                        'victim /hop/1/victim',
                    ]);
                    assert.equal(store.exceeded, true);
                    assert.equal(store.fetches, 2, 'the first request and one hop');
                    return done();
                });
            });
        });

        it('counts hops toward the per-POST cap', done => {
            FetchBudget.run(store => {
                store.fetches = FetchBudget.MaxFetchesPerPost - 2;
                HttpUtil.getJson(url('attacker', '/hop/3/victim'), tls, err => {
                    assert.ok(FetchBudget.isBudgetError(err), `err: ${err}`);
                    assert.equal(hits.length, 2);
                    assert.equal(store.fetches, FetchBudget.MaxFetchesPerPost);
                    return done();
                });
            });
        });

        it('checks a redirect to an IPv6 literal as that address, not as unparseable', done => {
            const opts = Object.assign({}, tls, {
                headers: { 'X-Redirect-To': `https://[::1]:${ports.https}/thing` },
            });
            HttpUtil.getJson(url('ok', '/redir'), opts, err => {
                assert.ok(err, 'refused');
                assert.match(err.message, /IPv6 address "\[::1\]".*\(loopback\)/);
                return done();
            });
        });
    });

    describe('_redirectUrl() (#966)', function () {
        //  options as follow-redirects' spreadUrlObject() leaves them
        const hop = location => {
            const u = new URL(location);
            return {
                protocol: u.protocol,
                hostname: u.hostname.replace(/^\[(.*)\]$/, '$1'),
                port: u.port === '' ? '' : Number(u.port),
                path: u.pathname + u.search,
            };
        };

        it('brackets an IPv6 host and keeps the port', () => {
            const built = HttpUtil._redirectUrl(
                hop('https://[2606:4700::1111]:8443/x?y=1')
            );
            assert.equal(built, 'https://[2606:4700::1111]:8443/x?y=1');
            assert.equal(Security.isSafeOutboundUrl(built), null);
            //  what FetchBudget.chargeRedirect() keys the hop on
            assert.equal(new URL(built).hostname, '[2606:4700::1111]');
        });

        it('leaves a name, and a default port, as they are', () => {
            assert.equal(
                HttpUtil._redirectUrl(hop('https://ok.ssrf-fixture.net:8443/a')),
                'https://ok.ssrf-fixture.net:8443/a'
            );
            assert.equal(
                HttpUtil._redirectUrl(hop('https://ok.ssrf-fixture.net/a')),
                'https://ok.ssrf-fixture.net/a'
            );
            assert.equal(
                HttpUtil._redirectUrl(hop('https://[2a02::1]/a')),
                'https://[2a02::1]/a'
            );
        });

        it('treats a null port as the default', () => {
            //  url.parse()-style options, as follow-redirects builds them
            //  without native URL support
            assert.equal(
                HttpUtil._redirectUrl({
                    protocol: 'https:',
                    hostname: '::1',
                    port: null,
                    path: '/',
                }),
                'https://[::1]/'
            );
        });
    });

    describe('WebFinger http:// fallback (#966)', function () {
        const WebFinger = require('../core/webfinger.js');
        const NegCache = require('../core/activitypub/negative_cache.js');
        const net = require('node:net');
        let clock;

        beforeEach(() => {
            clock = 1e9;
            NegCache._setClock(() => clock);
        });
        afterEach(() => NegCache._setClock(null));

        const freePort = cb => {
            //  no host: listen() would resolve it through the stubbed lookup
            const s = net.createServer().listen(0, () => {
                const p = s.address().port;
                s.close(() => cb(p));
            });
        };

        it('does not fall back without allowInsecureHttp: a refused connection is transient', done => {
            freePort(p => {
                const query = `@alice@ok.ssrf-fixture.net:${p}`;
                WebFinger.queryWebFinger(query, err => {
                    assert.equal(err && err.code, 'ECONNREFUSED', `err: ${err}`);
                    clock += NegCache.TransientTtlMs;
                    WebFinger.queryWebFinger(query, err => {
                        assert.ok(err);
                        assert.ok(!err.negativeCached, 'forgotten after 2 minutes');
                        return done();
                    });
                });
            });
        });

        it('with allowInsecureHttp, falls back to http:// for a host https:// refuses as private', done => {
            mutableApConfig.allowInsecureHttp = true;
            //  evil resolves to the blocked address, where the HTTP server listens
            WebFinger.queryWebFinger(
                `@alice@evil.ssrf-fixture.net:${ports.http}`,
                (err, json, by) => {
                    assert.ifError(err);
                    assert.equal(json.ok, true);
                    assert.match(by, /^http:\/\/evil\.ssrf-fixture\.net/);
                    assert.equal(seen.http[BLOCKED_ADDR], 1);
                    assert.equal(seen.https[BLOCKED_ADDR], 0, 'https:// stayed strict');
                    return done();
                }
            );
        });
    });

    it('without allowInsecureHttp, http:// is refused before any lookup', done => {
        HttpUtil.getJson(url('ok', '/thing', 'http'), {}, err => {
            assert.ok(err);
            assert.equal(lookupCalls.length, 0);
            assert.equal(seen.http[ALLOWED_ADDR], 0);
            return done();
        });
    });
});
