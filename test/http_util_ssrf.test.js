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

const HopTargets = { ok: 'ok', victim: 'victim' };

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

    describe('allowedPrivateAddresses', function () {
        const apConfig = {};
        let savedConfig;
        const lookup = host =>
            new Promise(resolve =>
                HttpUtil._checkedLookup(true, host, { all: true }, (err, addrs) =>
                    resolve({ err, addrs })
                )
            );
        const KeyRe =
            /contentServers\.web\.handlers\.activityPub\.allowedPrivateAddresses/;

        beforeEach(() => {
            savedConfig = configModule.get;
            Object.keys(apConfig).forEach(k => delete apConfig[k]);
            configModule.get = () => ({
                contentServers: { web: { handlers: { activityPub: apConfig } } },
            });
            hosts['lan.example.com'] = ['10.0.3.5'];
            hosts['ula.example.com'] = ['fd12:3456::5'];
            hosts['meta.example.com'] = ['169.254.169.254'];
        });
        afterEach(() => {
            configModule.get = savedConfig;
        });

        it('refuses a host resolving to 10.x by default, naming the setting in the warning', async () => {
            const { err } = await lookup('lan.example.com');
            assertRefused(err);
            assert.equal(warns.length, 1);
            assert.match(warns[0][1], KeyRe);
            assert.equal(warns[0][0].refused[0].allowable, true);
            assert.ok(!KeyRe.test(err.message), 'only the log says how to fix it');
        });

        it('allows it once its range, or the address itself, is listed', async () => {
            apConfig.allowedPrivateAddresses = ['10.0.0.0/8'];
            let { err, addrs } = await lookup('lan.example.com');
            assert.ifError(err);
            assert.deepEqual(addrs, [{ address: '10.0.3.5', family: 4 }]);

            apConfig.allowedPrivateAddresses = ['10.0.3.5'];
            ({ err } = await lookup('lan.example.com'));
            assert.ifError(err);

            apConfig.allowedPrivateAddresses = ['10.0.3.6'];
            ({ err } = await lookup('lan.example.com'));
            assertRefused(err);
        });

        it('likewise for an IPv6 unique local address', async () => {
            let { err } = await lookup('ula.example.com');
            assertRefused(err);
            apConfig.allowedPrivateAddresses = ['fd00::/8'];
            ({ err } = await lookup('ula.example.com'));
            assert.ifError(err);
        });

        it('still refuses when only some of the addresses are listed', async () => {
            hosts['mixed.example.com'] = ['10.0.3.5', '192.168.1.5'];
            apConfig.allowedPrivateAddresses = ['10.0.0.0/8'];
            const { err } = await lookup('mixed.example.com');
            assertRefused(err);
            assert.deepEqual(
                warns[0][0].refused.map(r => r.address),
                ['192.168.1.5']
            );
        });

        it('never allows link-local (cloud metadata), even with everything listed', async () => {
            apConfig.allowedPrivateAddresses = ['0.0.0.0/0', '::/0'];
            for (const address of [
                '169.254.169.254',
                '::ffff:169.254.169.254',
                'fe80::1',
                '0.0.0.0',
                '224.0.0.1',
                'ff02::1',
            ]) {
                hosts['meta.example.com'] = [address];
                warns.length = 0;
                const { err } = await lookup('meta.example.com');
                assertRefused(err);
                assert.equal(warns[0][0].refused[0].allowable, false, address);
                assert.ok(!KeyRe.test(warns[0][1]), 'listing it would not help');
            }
        });

        it('ignores invalid entries, with one warning per value of the setting', async () => {
            apConfig.allowedPrivateAddresses = ['bogus', '10.0.0.0/8', '10.0.0.0/33'];
            for (let i = 0; i < 3; ++i) {
                const { err } = await lookup('lan.example.com');
                assert.ifError(err);
            }
            const invalidWarns = () => warns.filter(w => /Ignoring invalid/.test(w[1]));
            assert.equal(invalidWarns().length, 1);
            assert.deepEqual(invalidWarns()[0][0].invalid, ['bogus', '10.0.0.0/33']);
            assert.match(invalidWarns()[0][1], KeyRe);

            //  a new value is reported afresh; a list that is not a list is
            //  ignored as a whole
            apConfig.allowedPrivateAddresses = '10.0.0.0/8';
            const { err } = await lookup('lan.example.com');
            assertRefused(err);
            assert.equal(invalidWarns().length, 2);
        });
    });
});

describe('http_util connect-time SSRF checks (real sockets)', function () {
    const mutableApConfig = { allowInsecureHttp: false };
    const mutableWebConfig = { handlers: { activityPub: mutableApConfig } };
    const TEST_CONFIG = {
        debug: { assertsEnabled: false },
        menus: { cls: false },
        general: { boardName: 'TestBoard' },
        contentServers: { web: mutableWebConfig },
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
            //  only the hosts the tests name, not whatever the path says
            const target = HopTargets[hop[2]];
            hits.push(`${req.headers.host.split('.')[0]} ${req.url}`);
            if (n > 0 && target) {
                res.writeHead(302, {
                    Location: `https://${target}.ssrf-fixture.net:${ports.https}/hop/${
                        n - 1
                    }/${target}`,
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
    const serverTls = {}; // { key, cert }, likewise
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
        Object.assign(serverTls, { key, cert });

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
        delete mutableApConfig.allowedPrivateAddresses;
        Object.keys(mutableWebConfig)
            .filter(k => k !== 'handlers')
            .forEach(k => delete mutableWebConfig[k]);
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
                modulusLength: 2048,
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

    //  #966: behind a reverse proxy with split-horizon DNS the board's own
    //  name resolves privately; "self" resolves to the blocked address here
    describe("the board's own origin (#966)", function () {
        const selfUrl = (p = '/thing', port = ports.https) =>
            `https://self.ssrf-fixture.net:${port}${p}`;
        const get = (u, opts = {}) =>
            new Promise(resolve =>
                HttpUtil.getJson(u, Object.assign({}, tls, opts), (err, json) =>
                    resolve({ err, json })
                )
            );
        const redirectTo = location => ({ headers: { 'X-Redirect-To': location } });
        const OwnHostRe =
            /own hostname; only https:\/\/self\.ssrf-fixture\.net:\d+ may be fetched/;

        beforeEach(() => {
            hosts['self.ssrf-fixture.net'] = [BLOCKED_ADDR];
            mutableWebConfig.overrideUrlPrefix = `https://self.ssrf-fixture.net:${ports.https}`;
        });

        it('control: refused when it is not the own origin', async () => {
            delete mutableWebConfig.overrideUrlPrefix;
            const { err } = await get(selfUrl());
            assertRefused(err);
            assert.equal(seen.https[BLOCKED_ADDR], 0);
        });

        it('fetches the own origin (overrideUrlPrefix) though it resolves to a blocked address', async () => {
            const { err, json } = await get(selfUrl());
            assert.ifError(err);
            assert.equal(json.ok, true);
            assert.equal(seen.https[BLOCKED_ADDR], 1);
            assert.equal(warns.length, 0);
        });

        it('fetches the own origin built from domain and the https port', async () => {
            delete mutableWebConfig.overrideUrlPrefix;
            Object.assign(mutableWebConfig, {
                domain: 'SELF.ssrf-fixture.net',
                https: { enabled: true, port: ports.https },
                http: { port: 8080 },
            });
            const { err } = await get(selfUrl());
            assert.ifError(err);
            assert.equal(seen.https[BLOCKED_ADDR], 1);
        });

        it('never treats the placeholder domain a board ships with as its own', async () => {
            delete mutableWebConfig.overrideUrlPrefix;
            Object.assign(mutableWebConfig, {
                domain: 'another-fine-enigma-bbs.org',
                https: { enabled: true, port: ports.https },
                http: { port: 8080 },
            });
            hosts['another-fine-enigma-bbs.org'] = [BLOCKED_ADDR];
            const { err } = await get(
                `https://another-fine-enigma-bbs.org:${ports.https}/x`
            );
            assertRefused(err);
            assert.equal(seen.https[BLOCKED_ADDR], 0);
        });

        it('POSTs and signed GETs to the own origin too', async () => {
            const posted = await new Promise(resolve =>
                HttpUtil.postJson(
                    selfUrl('/inbox'),
                    { hello: 'world' },
                    Object.assign({}, tls, { headers: {} }),
                    (err, body) => resolve({ err, body })
                )
            );
            assert.ifError(posted.err);

            const { privateKey } = crypto.generateKeyPairSync('rsa', {
                modulusLength: 2048,
            });
            const { err } = await get(selfUrl(), {
                headers: { Date: new Date().toUTCString() },
                sign: {
                    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
                    keyId: `${selfUrl('/users/sysop')}#main-key`,
                    authorizationHeaderName: 'Signature',
                    headers: ['(request-target)', 'host', 'date'],
                },
            });
            assert.ifError(err);
        });

        it('refuses the own hostname on another port, before any lookup', async () => {
            //  the HTTP server's port, spoken to over TLS: anything that is
            //  not the own origin's port
            const { err } = await get(selfUrl('/thing', ports.http));
            assert.ok(err);
            assert.match(err.message, OwnHostRe);
            assert.equal(lookupCalls.length, 0);
            assert.equal(seen.http[BLOCKED_ADDR], 0);

            const posted = await new Promise(resolve =>
                HttpUtil.postJson(
                    selfUrl('/inbox', ports.http),
                    {},
                    Object.assign({}, tls, { headers: {} }),
                    err => resolve(err)
                )
            );
            assert.match(posted.message, OwnHostRe);
        });

        it('only the own-origin agents exempt it: the regular ones refuse it on any port', done => {
            //  as if a request skipped the URL check altogether
            const req = https.get(
                selfUrl('/thing', ports.https),
                Object.assign({}, tls, { agent: HttpUtil._agents.https }),
                () => done(new Error('connected'))
            );
            req.on('error', err => {
                assertRefused(err);
                assert.equal(seen.https[BLOCKED_ADDR], 0);
                return done();
            });
        });

        it('the own-origin lookup checks every other name, and the scheme', done => {
            hosts['other.ssrf-fixture.net'] = [BLOCKED_ADDR];
            HttpUtil._ownOriginLookup(true, 'other.ssrf-fixture.net', {}, err => {
                assertRefused(err);
                //  the http:// agent's lookup never exempts an https:// origin
                HttpUtil._ownOriginLookup(false, 'self.ssrf-fixture.net', {}, err => {
                    assertRefused(err);
                    HttpUtil._ownOriginLookup(
                        true,
                        'self.ssrf-fixture.net',
                        {},
                        (err, address) => {
                            assert.ifError(err);
                            assert.equal(address, BLOCKED_ADDR);
                            return done();
                        }
                    );
                });
            });
        });

        it('follows a redirect from elsewhere to the own origin', async () => {
            const { err, json } = await get(url('ok', '/redir'), redirectTo(selfUrl()));
            assert.ifError(err);
            assert.equal(json.url, '/thing');
            assert.equal(seen.https[ALLOWED_ADDR], 1);
            assert.equal(seen.https[BLOCKED_ADDR], 1);
        });

        it('refuses a redirect to the own hostname on another port', async () => {
            const { err } = await get(
                url('ok', '/redir'),
                redirectTo(selfUrl('/thing', ports.http))
            );
            assert.ok(err);
            assert.match(err.message, OwnHostRe);
            assert.equal(seen.http[BLOCKED_ADDR], 0);
        });

        it('a redirect from the own origin to elsewhere is checked as usual', async () => {
            const { err } = await get(selfUrl('/redir'), redirectTo(url('evil')));
            assertRefused(err);
            assert.equal(seen.https[BLOCKED_ADDR], 1, 'only the own-origin hop');
        });

        it('follows a redirect from the own origin to the own origin', async () => {
            const { err, json } = await get(selfUrl('/redir'), redirectTo(selfUrl()));
            assert.ifError(err);
            assert.equal(json.url, '/thing');
            assert.ok(seen.https[BLOCKED_ADDR] >= 1);
            assert.equal(seen.https[ALLOWED_ADDR], 0);
        });

        it('takes the own hostname in any case', async () => {
            const { err } = await get(
                `https://SELF.ssrf-fixture.NET:${ports.https}/thing`
            );
            assert.ifError(err);
            assert.equal(seen.https[BLOCKED_ADDR], 1);
        });

        it('does not take the own hostname with a trailing dot', async () => {
            hosts['self.ssrf-fixture.net.'] = [BLOCKED_ADDR];
            const { err } = await get(
                `https://self.ssrf-fixture.net.:${ports.https}/thing`
            );
            assertRefused(err);
            assert.equal(seen.https[BLOCKED_ADDR], 0);
        });

        it("takes a URL spelling out the scheme's default port", () => {
            const own = () => HttpUtil._agents.ownHttps;
            mutableWebConfig.overrideUrlPrefix = 'https://self.ssrf-fixture.net';
            let checked = HttpUtil._checkUrl('https://self.ssrf-fixture.net:443/x');
            assert.equal(checked.reason, null);
            assert.equal(checked.agents.https, own());

            mutableWebConfig.overrideUrlPrefix = 'https://self.ssrf-fixture.net:443/';
            checked = HttpUtil._checkUrl('https://self.ssrf-fixture.net/x');
            assert.equal(checked.reason, null);
            assert.equal(checked.agents.https, own());

            checked = HttpUtil._checkUrl('https://self.ssrf-fixture.net:8443/x');
            assert.match(checked.reason, /own hostname/);
        });

        it("ignores a caller's options that would move the connection", async () => {
            //  the own URL, but the HTTP server's port: were it honoured,
            //  the own-origin agent would connect the own hostname there
            let r = await get(selfUrl(), { port: ports.http });
            assert.ifError(r.err);
            assert.equal(r.json.ok, true);
            assert.equal(seen.http[BLOCKED_ADDR], 0);
            assert.equal(seen.https[BLOCKED_ADDR], 1);

            r = await get(selfUrl(), {
                hostname: 'evil.ssrf-fixture.net',
                host: 'evil.ssrf-fixture.net',
                defaultPort: ports.http,
                lookup: (h, o, cb) => cb(null, ALLOWED_ADDR, 4),
                family: 6,
            });
            assert.ifError(r.err);
            assert.equal(seen.http[BLOCKED_ADDR], 0);

            //  and on the path without redirects (POST, signed GET)
            const posted = await new Promise(resolve =>
                HttpUtil.postJson(
                    selfUrl('/inbox'),
                    {},
                    Object.assign({}, tls, { headers: {}, port: ports.http }),
                    err => resolve(err)
                )
            );
            assert.ifError(posted);
            assert.equal(seen.http[BLOCKED_ADDR], 0);

            //  nor can a lookup of the caller's reach a blocked host
            const connections = seen.https[BLOCKED_ADDR];
            r = await get(url('evil'), {
                lookup: (h, o, cb) => cb(null, BLOCKED_ADDR, 4),
            });
            assertRefused(r.err);
            assert.equal(seen.https[BLOCKED_ADDR], connections);
        });

        it('never takes the placeholder domain as its own, however it is given', async () => {
            hosts['another-fine-enigma-bbs.org'] = [BLOCKED_ADDR];
            const placeholder = `https://another-fine-enigma-bbs.org:${ports.https}/x`;
            for (const prefix of [
                `https://another-fine-enigma-bbs.org:${ports.https}`,
                `https://Another-Fine-ENiGMA-BBS.org.:${ports.https}/`,
            ]) {
                mutableWebConfig.overrideUrlPrefix = prefix;
                const { err } = await get(placeholder);
                assertRefused(err);
            }

            delete mutableWebConfig.overrideUrlPrefix;
            Object.assign(mutableWebConfig, {
                domain: 'ANOTHER-FINE-ENIGMA-BBS.ORG.',
                https: { enabled: true, port: ports.https },
                http: { port: 8080 },
            });
            const { err } = await get(placeholder);
            assertRefused(err);
            assert.equal(seen.https[BLOCKED_ADDR], 0);
        });

        describe('an IPv6-literal own origin', function () {
            let v6Port;
            before(function (done) {
                //  server.listen() looks its address up through the stub
                hosts['::1'] = ['::1'];
                const server = https.createServer(serverTls, handler);
                server.once('error', () => {
                    //  no IPv6 loopback here
                    v6Port = null;
                    return done();
                });
                listen(server, 'https', '::1', 0, (err, p) => {
                    v6Port = err ? null : p;
                    return done();
                });
            });
            beforeEach(function () {
                if (!v6Port) {
                    this.skip();
                }
            });

            //  the certificate is for names: these check the address check
            const getV6 = () =>
                new Promise(resolve =>
                    HttpUtil.getJson(
                        `https://[::1]:${v6Port}/thing`,
                        Object.assign({}, tls, { rejectUnauthorized: false }),
                        (err, json) => resolve({ err, json })
                    )
                );

            it('control: ::1 is refused when it is not the own origin', async () => {
                const { err } = await getV6();
                assert.ok(err);
                assert.match(err.message, /blocked range \(loopback\)/);
                assert.equal(seen.https['::1'], 0);
            });

            it('fetches it', async () => {
                mutableWebConfig.overrideUrlPrefix = `https://[::1]:${v6Port}`;
                const { err, json } = await getV6();
                assert.ifError(err);
                assert.equal(json.ok, true);
                assert.equal(seen.https['::1'], 1);
            });
        });
    });

    describe('allowedPrivateAddresses (#966)', function () {
        //  "lan" resolves to 127.0.0.2, blocked as loopback
        beforeEach(() => {
            hosts['lan.ssrf-fixture.net'] = [BLOCKED_ADDR];
        });
        const get = u =>
            new Promise(resolve =>
                HttpUtil.getJson(u, tls, (err, json) => resolve({ err, json }))
            );

        it('refuses a host resolving to a private address by default', async () => {
            const { err } = await get(url('lan'));
            assertRefused(err);
            assert.equal(seen.https[BLOCKED_ADDR], 0);
            assert.match(warns[0][1], /allowedPrivateAddresses/);
        });

        it('fetches it once its range is listed', async () => {
            mutableApConfig.allowedPrivateAddresses = ['127.0.0.0/8'];
            const { err, json } = await get(url('lan'));
            assert.ifError(err);
            assert.equal(json.ok, true);
            assert.equal(seen.https[BLOCKED_ADDR], 1);
        });

        it('fetches a literal address in a listed range', async () => {
            mutableApConfig.allowedPrivateAddresses = [BLOCKED_ADDR];
            const { err } = await new Promise(resolve =>
                //  the certificate is for names: this checks the address
                //  was let through, not TLS
                HttpUtil.getJson(
                    `https://${BLOCKED_ADDR}:${ports.https}/thing`,
                    Object.assign({}, tls, { rejectUnauthorized: false }),
                    err => resolve({ err })
                )
            );
            assert.ifError(err);
            assert.equal(seen.https[BLOCKED_ADDR], 1);
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
