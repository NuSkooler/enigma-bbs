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
const path = require('path');
const crypto = require('crypto');
const dns = require('node:dns');
const https = require('node:https');
const http = require('node:http');

const configModule = require('../core/config.js');
const loggerModule = require('../core/logger.js');
const Security = require('../core/activitypub/security.js');
const HttpUtil = require('../core/http_util.js');
const { ErrorReasons } = require('../core/enig_error.js');

//  Self-signed for ssrf-fixture.net and *.ssrf-fixture.net, valid to 2126.
//  Named .crt/.key because .gitignore drops *.pem. Regenerate with:
//    openssl req -x509 -newkey rsa:2048 -nodes -days 36500 \
//      -keyout ssrf-fixture.key -out ssrf-fixture.crt -subj /CN=ssrf-fixture.net \
//      -addext subjectAltName=DNS:ssrf-fixture.net,DNS:*.ssrf-fixture.net
const FixtureDir = path.join(__dirname, 'fixtures', 'http_util_ssrf');
const CERT = fs.readFileSync(path.join(FixtureDir, 'ssrf-fixture.crt'));
const KEY = fs.readFileSync(path.join(FixtureDir, 'ssrf-fixture.key'));

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

    const handler = (req, res) => {
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

    const tls = { ca: CERT };
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

        //  each protocol's servers share a port across both addresses, so a
        //  name's URL reaches whichever address it resolves to
        const opts = { key: KEY, cert: CERT };
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
            assert.equal(warns[0][0].hostname, 'evil.ssrf-fixture.net');
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

    it('without allowInsecureHttp, http:// is refused before any lookup', done => {
        HttpUtil.getJson(url('ok', '/thing', 'http'), {}, err => {
            assert.ok(err);
            assert.equal(lookupCalls.length, 0);
            assert.equal(seen.http[ALLOWED_ADDR], 0);
            return done();
        });
    });
});
