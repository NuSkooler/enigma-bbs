'use strict';

//
//  enig-term support: recognising it from its DA reply, what the connect
//  probes do for it, and the /_enig/ws-term/ route that serves an operator
//  installed copy of it.
//

const { strict: assert } = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const http = require('http');
const os = require('os');
const paths = require('path');

const configModule = require('../core/config.js');

const ENIG_TERM_DA = '101;110;105;103;45;116;101;114;109'; //  "enig-term"
const CTERM_DA = '67;84;101;114;109'; //  "CTerm"

describe('enig-term', function () {
    //  heavy modules are required here rather than at load: some test files
    //  evict core modules from require.cache when they load
    let ClientModule;
    let ClientTerminal;
    let Events;
    let Connect;
    let WsTerm;

    before(() => {
        ClientModule = require('../core/client.js');
        ClientTerminal = require('../core/client_term.js').ClientTerminal;
        Events = require('../core/events.js');
        Connect = require('../core/connect.js');
        WsTerm = require('../core/web_ws_term.js');
    });

    describe('DA recognition', () => {
        it('maps the enig-term DA prefix to enig_term with its version', () => {
            assert.deepEqual(
                ClientModule.getTermClientFromDeviceAttr(`${ENIG_TERM_DA};0;1;0`),
                { termClient: 'enig_term', version: '0.1.0' }
            );
            assert.deepEqual(
                ClientModule.getTermClientFromDeviceAttr(`${ENIG_TERM_DA};1;12;3`),
                { termClient: 'enig_term', version: '1.12.3' }
            );
        });

        it('reports no version when the reply carries none usable', () => {
            assert.deepEqual(ClientModule.getTermClientFromDeviceAttr(ENIG_TERM_DA), {
                termClient: 'enig_term',
                version: null,
            });
            assert.equal(
                ClientModule.getTermClientFromDeviceAttr(`${ENIG_TERM_DA};0;x;0`).version,
                null
            );
        });

        it('still recognises CTerm, IcyTerm, VTX and arctel', () => {
            assert.deepEqual(
                ClientModule.getTermClientFromDeviceAttr(`${CTERM_DA};1;332`),
                {
                    termClient: 'cterm',
                    version: '1.332',
                }
            );
            assert.equal(
                ClientModule.getTermClientFromDeviceAttr('73;99;121;84;101;114;109;1;0')
                    .termClient,
                'icy_term'
            );
            assert.equal(
                ClientModule.getTermClientFromDeviceAttr('50;86;84;88').termClient,
                'vtx'
            );
            assert.equal(
                ClientModule.getTermClientFromDeviceAttr('63;1;2').termClient,
                'arctel'
            );
            assert.equal(ClientModule.getTermClientFromDeviceAttr('1;2;3'), null);
        });

        it('matches a prefix on a whole parameter only', () => {
            assert.equal(
                ClientModule.getTermClientFromDeviceAttr(`${CTERM_DA}0;1`),
                null
            );
            assert.equal(
                ClientModule.getTermClientFromDeviceAttr(`${ENIG_TERM_DA}5;0;1;0`),
                null
            );
        });

        it('getDeviceAttrVersion() is the generalised getCtermVersion()', () => {
            assert.equal(
                ClientModule.getDeviceAttrVersion(`${ENIG_TERM_DA};0;1;0`, ENIG_TERM_DA),
                '0.1.0'
            );
            assert.equal(
                ClientModule.getDeviceAttrVersion(`${CTERM_DA};1;332`, ENIG_TERM_DA),
                null
            );
            assert.equal(ClientModule.getCtermVersion(`${CTERM_DA};1;332`), '1.332');
        });

        describe('from the client data stream', () => {
            let client;

            beforeEach(() => {
                client = new ClientModule.Client();
                client.term = new ClientTerminal(null);
            });

            afterEach(() => {
                Events.removeListener(
                    Events.getSystemEvents().ThemeChanged,
                    client.themeChangedListener
                );
            });

            it('sets termClient and termClientVersion, and not ctermVersion', () => {
                client.emit('data', Buffer.from(`\x1b[=${ENIG_TERM_DA};0;1;0c`));
                assert.equal(client.term.termClient, 'enig_term');
                assert.equal(client.term.termClientVersion, '0.1.0');
                assert.equal(client.term.ctermVersion, null);
            });

            it('keeps setting ctermVersion for CTerm', () => {
                client.emit('data', Buffer.from(`\x1b[=${CTERM_DA};1;332c`));
                assert.equal(client.term.termClient, 'cterm');
                assert.equal(client.term.termClientVersion, '1.332');
                assert.equal(client.term.ctermVersion, '1.332');
            });

            it('does not assume OSC 8 or VTX audio from the name', () => {
                client.emit('data', Buffer.from(`\x1b[=${ENIG_TERM_DA};0;1;0c`));
                //  isNixTerm() reads term config this suite doesn't carry; enig-term
                //  identifies as ansi-bbs, which is not a *nix terminal
                client.term.isNixTerm = () => false;
                assert.equal(client.terminalSupports('osc8_hyperlink'), false);
                assert.equal(client.terminalSupports('vtx_audio'), false);

                client.term.termCapabilities.osc8 = true; //  as the =6n reply sets it
                assert.equal(client.terminalSupports('osc8_hyperlink'), true);
            });
        });
    });

    describe('connect probes', () => {
        function makeClient(termClient) {
            const client = new EventEmitter();
            client.node = 1;
            client.writes = [];
            client.log = {
                info() {},
                debug() {},
                warn() {},
            };
            client.term = {
                termClient,
                syncTermFontsEnabled: false,
                termCapabilities: {},
                rawWrite: s => client.writes.push(s),
            };
            return client;
        }

        const CTERM_QUERY = '\x1b[<c\x1b[=6n\x1b[6n';

        it('takes the SyncTERM font fast path for enig_term, with no probe', done => {
            const client = makeClient('enig_term');
            Connect.ansiQuerySyncTermFontSupport(client, err => {
                assert.ifError(err);
                assert.equal(client.term.syncTermFontsEnabled, true);
                assert.deepEqual(client.writes, []);
                return done();
            });
        });

        it('asks a CTerm-shaped client CTDA, CSI = 6 n and a CPR in one write', done => {
            const client = makeClient('enig_term');
            Connect.ansiQueryCtermCapabilities(client, err => {
                assert.ifError(err);
                assert.equal(client.term.termCapabilities.osc8, true);
                assert.equal(client.listenerCount('cterm capability response'), 0);
                assert.equal(client.listenerCount('cursor position report'), 0);
                return done();
            });
            assert.deepEqual(client.writes, [CTERM_QUERY]);
            client.emit('cterm capability response', { id: 6, value: 1 });
            client.emit('cursor position report', [1, 1]);
        });

        it('wires the client parser and the probes together', done => {
            //  a real Client: the CTDA reply goes through the input parser
            const client = new ClientModule.Client();
            client.term = new ClientTerminal(null);
            client.session = { id: 1 }; //  client.node
            client.log = { info() {}, debug() {}, warn() {} };
            const writes = [];
            client.term.rawWrite = s => writes.push(s);
            const keys = [];
            client.on('key press', ch => keys.push(ch));

            client.emit('data', Buffer.from(`\x1b[=${ENIG_TERM_DA};0;1;0c`));
            Connect.ansiQueryCtermCapabilities(client, () => {
                Connect.ansiQuerySyncTermFontSupport(client, () => {
                    Events.removeListener(
                        Events.getSystemEvents().ThemeChanged,
                        client.themeChangedListener
                    );
                    assert.deepEqual(writes, [CTERM_QUERY]);
                    assert.deepEqual(client.term.termCapabilities.ctda, [1, 2, 3, 5]);
                    assert.equal(client.term.termCapabilities.osc8, true);
                    assert.equal(client.term.syncTermFontsEnabled, true);
                    assert.deepEqual(keys, []);
                    return done();
                });
            });
            //  enig-term's answer to the three queries, in one chunk
            client.emit('data', Buffer.from('\x1b[<0;1;2;3;5c\x1b[=6;1n\x1b[1;1R'));
        });
    });

    describe('/_enig/ws-term/ endpoint resolution', () => {
        const base = (wsTerm, wss, domain = 'bbs.example.com') => ({
            general: { boardName: 'Test Board' },
            contentServers: { web: { domain, wsTerm } },
            loginServers: { webSocket: { wss } },
        });

        it('prefers wsTerm.endpoint', () => {
            assert.equal(
                WsTerm.resolveEndpoint(
                    base(
                        { endpoint: 'wss://xibalba.vip:44512' },
                        { enabled: true, port: 8811 }
                    )
                ),
                'wss://xibalba.vip:44512'
            );
        });

        it('falls back to the domain and the wss port', () => {
            assert.equal(
                WsTerm.resolveEndpoint(
                    base({ endpoint: '' }, { enabled: true, port: 8811 })
                ),
                'wss://bbs.example.com:8811'
            );
            assert.equal(
                WsTerm.resolveEndpoint(base({}, { enabled: true, port: 443 })),
                'wss://bbs.example.com'
            );
        });

        it('is null when wss is off: plain ws is never derived', () => {
            assert.equal(
                WsTerm.resolveEndpoint(
                    base({ endpoint: '' }, { enabled: false, port: 8811 })
                ),
                null
            );
            assert.equal(WsTerm.resolveEndpoint(base(undefined, undefined)), null);
            assert.equal(
                WsTerm.resolveEndpoint(base({}, { enabled: true, port: 8811 }, '')),
                null
            );
        });

        it('generates { version, endpoint, title, ...client }', () => {
            assert.deepEqual(
                WsTerm.generateClientConfig(
                    base(
                        { endpoint: '', client: { cols: 80, crt: true } },
                        { enabled: true, port: 8811 }
                    )
                ),
                {
                    version: 1,
                    endpoint: 'wss://bbs.example.com:8811',
                    title: 'Test Board',
                    cols: 80,
                    crt: true,
                }
            );
        });
    });

    describe('/_enig/ws-term/ route', function () {
        let tmpDir;
        let root;
        let server;
        let port;
        let previousConfig;
        let wsTerm;
        let wss;

        const notFoundWebServer = {
            fileNotFound(resp) {
                resp.writeHead(404, { 'Content-Type': 'text/html' });
                return resp.end('File not found.');
            },
        };

        const INDEX = '<!doctype html><title>enig-term</title>';
        const WASM = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

        function request(path, { method = 'GET', headers = {} } = {}) {
            return new Promise((resolve, reject) => {
                const req = http.request(
                    { host: '127.0.0.1', port, path, method, headers },
                    resp => {
                        const chunks = [];
                        resp.on('data', c => chunks.push(c));
                        resp.on('end', () =>
                            resolve({
                                status: resp.statusCode,
                                headers: resp.headers,
                                body: Buffer.concat(chunks),
                            })
                        );
                    }
                );
                req.on('error', reject);
                req.end();
            });
        }

        function install() {
            fs.mkdirSync(paths.join(root, 'sub'), { recursive: true });
            fs.writeFileSync(paths.join(root, 'index.html'), INDEX);
            fs.writeFileSync(paths.join(root, 'enig_term_core_bg.wasm'), WASM);
            fs.writeFileSync(paths.join(root, 'enig-term.js'), 'export {};\n');
            fs.writeFileSync(paths.join(root, 'sub', 'index.html'), 'sub index');
            fs.writeFileSync(paths.join(root, '.hidden'), 'hidden');
        }

        before(done => {
            tmpDir = fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-ws-term-'));
            root = paths.join(tmpDir, 'ws-term');
            fs.writeFileSync(paths.join(tmpDir, 'secret.txt'), 'secret');

            previousConfig = configModule._pushTestConfig({
                general: { boardName: 'Test Board' },
                contentServers: {
                    web: {
                        domain: 'bbs.example.com',
                        get wsTerm() {
                            return wsTerm;
                        },
                    },
                },
                loginServers: {
                    webSocket: {
                        get wss() {
                            return wss;
                        },
                    },
                },
            });

            server = http.createServer((req, resp) =>
                WsTerm.handleRequest(notFoundWebServer, req, resp)
            );
            server.listen(0, '127.0.0.1', () => {
                port = server.address().port;
                return done();
            });
        });

        after(done => {
            configModule._popTestConfig(previousConfig);
            fs.rmSync(tmpDir, { recursive: true, force: true });
            server.close(() => done());
        });

        beforeEach(() => {
            fs.rmSync(root, { recursive: true, force: true });
            wsTerm = { root, endpoint: '', client: {} };
            wss = { enabled: false, port: 8811 };
            WsTerm._resetWarnings();
        });

        it('is a 404 while the root does not exist', async () => {
            assert.equal((await request('/_enig/ws-term/')).status, 404);
            assert.equal((await request('/_enig/ws-term')).status, 404);
            assert.equal((await request('/_enig/ws-term/config.json')).status, 404);
        });

        it('is a 404 while the root has no index.html', async () => {
            fs.mkdirSync(root);
            fs.writeFileSync(paths.join(root, 'config.json'), '{}');
            assert.equal((await request('/_enig/ws-term/')).status, 404);
            assert.equal((await request('/_enig/ws-term/config.json')).status, 404);
        });

        it('goes live as soon as index.html is copied in, with no restart', async () => {
            assert.equal((await request('/_enig/ws-term/')).status, 404);
            install();
            assert.equal((await request('/_enig/ws-term/')).status, 200);
            fs.rmSync(root, { recursive: true, force: true });
            assert.equal((await request('/_enig/ws-term/')).status, 404);
        });

        it('serves index.html for the directory URL', async () => {
            install();
            const resp = await request('/_enig/ws-term/?endpoint=wss://x');
            assert.equal(resp.status, 200);
            assert.equal(resp.headers['content-type'], 'text/html; charset=utf-8');
            assert.equal(resp.body.toString(), INDEX);
            assert.equal(resp.headers['cache-control'], 'no-cache');
            assert.ok(resp.headers.etag);

            assert.equal(
                (await request('/_enig/ws-term/sub/')).body.toString(),
                'sub index'
            );
        });

        it('redirects the bare route to the directory URL, keeping the query', async () => {
            install();
            let resp = await request('/_enig/ws-term');
            assert.equal(resp.status, 301);
            assert.equal(resp.headers.location, '/_enig/ws-term/');

            resp = await request('/_enig/ws-term?connect=1');
            assert.equal(resp.headers.location, '/_enig/ws-term/?connect=1');
        });

        it('serves .wasm as application/wasm', async () => {
            install();
            const resp = await request('/_enig/ws-term/enig_term_core_bg.wasm');
            assert.equal(resp.status, 200);
            assert.equal(resp.headers['content-type'], 'application/wasm');
            assert.equal(Number(resp.headers['content-length']), WASM.length);
            assert.deepEqual(resp.body, WASM);

            const js = await request('/_enig/ws-term/enig-term.js');
            assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8');
        });

        it('answers HEAD without a body, and a matching ETag with a 304', async () => {
            install();
            const head = await request('/_enig/ws-term/enig_term_core_bg.wasm', {
                method: 'HEAD',
            });
            assert.equal(head.status, 200);
            assert.equal(Number(head.headers['content-length']), WASM.length);
            assert.equal(head.body.length, 0);

            const again = await request('/_enig/ws-term/enig_term_core_bg.wasm', {
                headers: { 'If-None-Match': head.headers.etag },
            });
            assert.equal(again.status, 304);
            assert.equal(again.body.length, 0);
        });

        it('never serves anything outside the root', async () => {
            install();
            fs.symlinkSync(
                paths.join(tmpDir, 'secret.txt'),
                paths.join(root, 'link.txt')
            );

            for (const path of [
                '/_enig/ws-term/../secret.txt',
                '/_enig/ws-term/%2e%2e/secret.txt',
                '/_enig/ws-term/..%2fsecret.txt',
                '/_enig/ws-term/sub/..%2f..%2fsecret.txt',
                '/_enig/ws-term/%2e%2e%5csecret.txt',
                '/_enig/ws-term/link.txt',
                '/_enig/ws-term/.hidden',
                '/_enig/ws-term//etc/passwd',
                '/_enig/ws-term/%00',
                '/_enig/ws-term/%E0%A4%A',
                '/_enig/ws-term-other/',
            ]) {
                const resp = await request(path);
                assert.equal(resp.status, 404, path);
                assert.ok(!resp.body.toString().includes('secret'), path);
            }
        });

        it('follows a root that is itself a symlink', async () => {
            const real = paths.join(tmpDir, 'dist');
            fs.mkdirSync(real, { recursive: true });
            fs.writeFileSync(paths.join(real, 'index.html'), INDEX);
            fs.symlinkSync(real, root);
            try {
                assert.equal((await request('/_enig/ws-term/')).body.toString(), INDEX);
                assert.equal((await request('/_enig/ws-term/../secret.txt')).status, 404);
            } finally {
                fs.rmSync(root, { force: true });
                fs.rmSync(real, { recursive: true, force: true });
            }
        });

        it('generates config.json from the board configuration', async () => {
            install();
            wsTerm.client = { cols: 80, rows: 25, autoConnect: true };
            wss = { enabled: true, port: 8811 };

            const resp = await request('/_enig/ws-term/config.json');
            assert.equal(resp.status, 200);
            assert.equal(resp.headers['content-type'], 'application/json; charset=utf-8');
            assert.equal(resp.headers['cache-control'], 'no-cache');
            assert.deepEqual(JSON.parse(resp.body.toString()), {
                version: 1,
                endpoint: 'wss://bbs.example.com:8811',
                title: 'Test Board',
                cols: 80,
                rows: 25,
                autoConnect: true,
            });
        });

        it('uses wsTerm.endpoint over the derived one', async () => {
            install();
            wsTerm.endpoint = 'wss://xibalba.vip:44512';
            wss = { enabled: true, port: 8811 };
            const resp = await request('/_enig/ws-term/config.json');
            assert.equal(
                JSON.parse(resp.body.toString()).endpoint,
                'wss://xibalba.vip:44512'
            );
        });

        it('generates a null endpoint, warning once, when there is none', async () => {
            install();
            const loggerModule = require('../core/logger.js');
            const previousLog = loggerModule.log;
            const warnings = [];
            loggerModule.log = Object.assign({}, previousLog, {
                warn: (...args) => warnings.push(args),
            });
            try {
                const first = await request('/_enig/ws-term/config.json');
                assert.equal(JSON.parse(first.body.toString()).endpoint, null);
                await request('/_enig/ws-term/config.json');
                assert.equal(warnings.length, 1);
            } finally {
                loggerModule.log = previousLog;
            }
        });

        it("serves the operator's own config.json as-is", async () => {
            install();
            const own = '{ "endpoint": "wss://elsewhere:1234", "crt": true }\n';
            fs.writeFileSync(paths.join(root, 'config.json'), own);
            wss = { enabled: true, port: 8811 };

            const resp = await request('/_enig/ws-term/config.json');
            assert.equal(resp.status, 200);
            assert.equal(resp.headers['content-type'], 'application/json; charset=utf-8');
            assert.equal(resp.body.toString(), own);
        });

        it('registers GET and HEAD routes for exactly its own path', () => {
            const listeningServer = require('../core/listening_server.js');
            const previousGetServer = listeningServer.getServer;
            const routes = [];
            listeningServer.getServer = () => ({
                instance: {
                    isEnabled: () => true,
                    addRoute: route => routes.push(route),
                },
            });
            try {
                WsTerm.startup(err => assert.ifError(err));
            } finally {
                listeningServer.getServer = previousGetServer;
            }

            assert.deepEqual(
                routes.map(r => r.method),
                ['GET', 'HEAD']
            );
            const re = routes[0].path;
            [
                '/_enig/ws-term',
                '/_enig/ws-term/',
                '/_enig/ws-term?x=1',
                '/_enig/ws-term/a.wasm',
            ].forEach(p => assert.ok(re.test(p), p));
            ['/_enig/ws-terminal', '/x/_enig/ws-term/', '/_enig/ws'].forEach(p =>
                assert.ok(!re.test(p), p)
            );
        });
    });
});
