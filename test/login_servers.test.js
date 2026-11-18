'use strict';

//
//  #1017: the login servers when every node is busy (each turns the caller
//  away cleanly and tracks nothing), SSH terminal info sent before the shell,
//  and a WebSocket session ended from this side closing the WebSocket.
//
//  #1080: an SSH connection that does not reach the shell in time is ended
//  and its node freed; a telnet socket ended from this side is closed if the
//  caller never closes its side.
//

const { strict: assert } = require('assert');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const http = require('http');
const _ = require('lodash');

const configModule = require('../core/config.js');
const loggerModule = require('../core/logger.js');
const configDefault = require('../core/config_default.js');

//  These capture Config (and the logger) at first require, so they are loaded
//  fresh under this file's config and put back afterwards: other test files
//  keep the instances they already have.
const FreshPaths = [
    '../core/login_server_module.js',
    '../core/servers/login/telnet.js',
    '../core/servers/login/websocket.js',
    '../core/servers/login/ssh.js',
].map(p => require.resolve(p));

const BusyMessage = 'All nodes are busy. Try again later...';

function makeLog() {
    const entries = [];
    const log = { entries, child: () => log };
    ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].forEach(level => {
        log[level] = (obj, msg) => {
            entries.push({ level, obj, msg });
            return true; //  log.debug() doubles as "is debug enabled?"
        };
    });
    return log;
}

function makeConfig(overrides) {
    const config = configDefault();
    config.debug = { assertsEnabled: false };
    config.menus = { cls: false };
    return _.merge(config, overrides);
}

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

describe('login servers (#1017)', function () {
    let saved;
    let previousConfig;
    let previousLog;
    let log;
    let config;
    let LoginServerModule;
    let ssh;
    let telnet;
    let websocket;
    let clientConns;
    let connect;

    before(() => {
        config = makeConfig({
            general: { maxConnections: 1, closedSystem: false },
            users: { newUserNames: ['new'] },
            loginServers: { webSocket: { proxied: false } },
        });
        previousConfig = configModule._pushTestConfig(config);
        previousLog = loggerModule.log;
        log = makeLog();
        loggerModule.log = log;

        saved = { modules: FreshPaths.map(p => require.cache[p]) };
        FreshPaths.forEach(p => delete require.cache[p]);

        LoginServerModule = require(FreshPaths[0]);
        telnet = require(FreshPaths[1]);
        websocket = require(FreshPaths[2]);
        ssh = require(FreshPaths[3]);

        clientConns = require('../core/client_connections.js');
        connect = require('../core/connect.js');
        saved.addNewClient = clientConns.addNewClient;
        saved.removeClient = clientConns.removeClient;
        saved.connectEntry = connect.connectEntry;

        //  tracking without the side effects (stat log timer, system events)
        clientConns.addNewClient = client => {
            client.session.id = 1;
            client.log = makeLog();
            clientConns.clientConnections.push(client);
        };
        clientConns.removeClient = client => {
            client.end();
            const i = clientConns.clientConnections.indexOf(client);
            if (i > -1) {
                clientConns.clientConnections.splice(i, 1);
            }
        };
        connect.connectEntry = () => {};
    });

    after(() => {
        FreshPaths.forEach((p, i) => {
            if (saved.modules[i]) {
                require.cache[p] = saved.modules[i];
            } else {
                delete require.cache[p];
            }
        });
        clientConns.addNewClient = saved.addNewClient;
        clientConns.removeClient = saved.removeClient;
        connect.connectEntry = saved.connectEntry;
        configModule._popTestConfig(previousConfig);
        loggerModule.log = previousLog;
    });

    //  a session already on the one node there is
    let occupant;
    function fillBoard() {
        occupant = { session: { id: 1 }, node: 1 };
        clientConns.clientConnections.push(occupant);
    }

    afterEach(() => {
        const i = clientConns.clientConnections.indexOf(occupant);
        if (i > -1) {
            clientConns.clientConnections.splice(i, 1);
        }
        occupant = null;
        log.entries.length = 0;
    });

    function themeListeners() {
        const Events = require('../core/events.js');
        return Events.listenerCount(Events.getSystemEvents().ThemeChanged);
    }

    function refusedLogged() {
        return log.entries.some(
            e => 'info' === e.level && /All nodes are busy; refusing/.test(e.msg)
        );
    }

    //
    //  ssh2's server connection, as far as SSHClient uses it
    //
    function makeSshConn() {
        const conn = new EventEmitter();
        conn.endCount = 0;
        conn.end = () => {
            conn.endCount += 1;
            return conn;
        };
        conn._sock = new EventEmitter();
        conn._sock.remoteAddress = '192.0.2.10';
        return conn;
    }

    function makeAuthCtx(method, username = 'new') {
        const ctx = { method, username, rejects: [], accepts: 0, prompts: [] };
        ctx.reject = methods => ctx.rejects.push(methods);
        ctx.accept = () => (ctx.accepts += 1);
        ctx.prompt = (...args) => ctx.prompts.push(args);
        return ctx;
    }

    describe('SSH terminal info before the shell', () => {
        function openShell(requests) {
            const conn = makeSshConn();
            const client = new ssh.SSHClient(conn, {
                header: { identRaw: 'SSH-2.0-OpenSSH_9.6' },
            });
            client.session = {};
            client.log = makeLog();

            //  The terminal type as the SSH server sets it. Spied on rather
            //  than run: ClientTerminal reads a Config captured by whichever
            //  test file loaded it first.
            client.termTypesSet = [];
            client.setTermType = termType => {
                client.termTypesSet.push(termType);
                client.term.env.TERM = termType;
            };

            conn.emit('ready');
            const session = new EventEmitter();
            conn.emit('session', () => session);

            const shell = () => {
                const channel = { stdin: new PassThrough(), stdout: new PassThrough() };
                session.emit('shell', () => channel);
            };

            requests.forEach(([name, info]) => {
                if ('shell' === name) {
                    return shell();
                }
                session.emit(
                    name,
                    () => {},
                    () => {},
                    info
                );
            });

            return client;
        }

        const pty = ['pty', { term: 'xterm-256color', cols: 100, rows: 40 }];
        const winch = ['window-change', { cols: 120, rows: 50, width: 0, height: 0 }];

        it('pty, window-change, shell: keeps the terminal type, takes the later size', () => {
            const client = openShell([pty, winch, ['shell']]);
            assert.deepEqual(client.termTypesSet, ['xterm-256color']);
            assert.equal(client.term.termWidth, 120);
            assert.equal(client.term.termHeight, 50);
        });

        it('window-change, pty, shell: keeps the terminal type', () => {
            const client = openShell([winch, pty, ['shell']]);
            assert.deepEqual(client.termTypesSet, ['xterm-256color']);
            assert.equal(client.term.termWidth, 100);
        });

        it('pty, shell, window-change: resizes as before', () => {
            const client = openShell([pty, ['shell'], winch]);
            assert.deepEqual(client.termTypesSet, ['xterm-256color']);
            assert.equal(client.term.termWidth, 120);
            assert.equal(client.term.termHeight, 50);
        });
    });

    describe('every node busy', () => {
        describe('SSH', () => {
            let refusalTimeoutMs;

            beforeEach(() => {
                refusalTimeoutMs = ssh.SSHClient.RefusalTimeoutMs;
            });

            afterEach(() => {
                ssh.SSHClient.RefusalTimeoutMs = refusalTimeoutMs;
            });

            function connectRefused() {
                fillBoard();
                const conn = makeSshConn();
                const client = new ssh.SSHClient(conn, {
                    header: { identRaw: 'SSH-2.0-OpenSSH_9.6' },
                });
                const mod = new LoginServerModule();
                assert.doesNotThrow(() =>
                    mod.handleNewClient(client, conn._sock, ssh.moduleInfo)
                );
                return { conn, client };
            }

            it('tracks nothing, logs the refusal, and gives the client a logger', () => {
                const { conn, client } = connectRefused();
                assert.equal(clientConns.clientConnections.length, 1);
                assert.ok(!clientConns.clientConnections.includes(client));
                assert.ok(client.log, 'client.log');
                assert.ok(refusedLogged());
                assert.equal(conn.endCount, 0, 'kept open to say why');
                conn.emit('close');
            });

            it('shows the message through keyboard-interactive, then disconnects', () => {
                const { conn } = connectRefused();

                const ctx = makeAuthCtx('keyboard-interactive');
                conn.emit('authentication', ctx);

                assert.equal(ctx.prompts.length, 1);
                const [prompts, title, instructions, cb] = ctx.prompts[0];
                assert.deepEqual(prompts, []);
                assert.equal(title, '');
                assert.equal(instructions, BusyMessage);
                assert.equal(conn.endCount, 0);

                cb([]);
                assert.equal(conn.endCount, 1);
                assert.equal(ctx.accepts, 0);
                conn.emit('close');
            });

            it('steers other methods to keyboard-interactive a few times, then ends', () => {
                const { conn } = connectRefused();

                ['none', 'publickey', 'password'].forEach(method => {
                    const ctx = makeAuthCtx(method, 'somebody');
                    conn.emit('authentication', ctx);
                    assert.deepEqual(ctx.rejects, [['keyboard-interactive']], method);
                    assert.equal(conn.endCount, 0, method);
                });

                //  ...and keyboard-interactive after those still shows it
                const kbd = makeAuthCtx('keyboard-interactive');
                conn.emit('authentication', kbd);
                assert.equal(kbd.prompts.length, 1);

                const password = makeAuthCtx('password', 'somebody');
                conn.emit('authentication', password);
                assert.equal(password.rejects.length, 1);
                assert.ok(conn.endCount > 0);
                conn.emit('close');
            });

            it('closes the socket outright if the caller has not closed it after the end', async () => {
                ssh.SSHClient.RefusalTimeoutMs = 5;
                ssh.SSHClient.RefusalCloseGraceMs = 5;
                const { conn } = connectRefused();
                conn._sock.destroyed = false;
                conn._sock.destroy = () => {
                    conn._sock.destroyed = true;
                    conn.emit('close');
                };
                await tick(40);
                assert.equal(conn._sock.destroyed, true);
            });

            it('leaves the socket alone if the caller closes it in the grace time', async () => {
                ssh.SSHClient.RefusalTimeoutMs = 5;
                ssh.SSHClient.RefusalCloseGraceMs = 30;
                const { conn } = connectRefused();
                let destroyed = 0;
                conn._sock.destroy = () => (destroyed += 1);
                await tick(15);
                conn.emit('close');
                await tick(40);
                assert.equal(destroyed, 0);
            });

            it('does not accept a new user on an open system', () => {
                const { conn } = connectRefused();
                const ctx = makeAuthCtx('password', 'new');
                conn.emit('authentication', ctx);
                assert.equal(ctx.accepts, 0);
                conn.emit('close');
            });

            it('a connection error does not throw', () => {
                const { conn } = connectRefused();
                assert.doesNotThrow(() => conn.emit('error', new Error('reset')));
                conn.emit('close');
            });

            it('ends a refused connection that is still open after the timeout', async () => {
                ssh.SSHClient.RefusalTimeoutMs = 5;
                const { conn } = connectRefused();
                await tick(30);
                assert.equal(conn.endCount, 1);
                conn.emit('close');
            });

            it('the timer is cleared when the connection closes', async () => {
                ssh.SSHClient.RefusalTimeoutMs = 5;
                const { conn, client } = connectRefused();
                conn.emit('close');
                assert.equal(client.clientEnded, true, 'torn down on close');
                const endCount = conn.endCount;
                await tick(30);
                assert.equal(conn.endCount, endCount, 'timer did not fire');
            });

            //
            //  The Client constructor registers a ThemeChanged listener that
            //  only end() removes; a refused client must still get there.
            //
            it('releases the client when the connection closes, once', () => {
                const before = themeListeners();
                for (let i = 0; i < 5; i++) {
                    const { conn } = connectRefused();
                    assert.equal(themeListeners(), before + 1, 'held while open');
                    conn.emit('close');
                    conn.emit('close');
                    assert.equal(themeListeners(), before);
                    clientConns.clientConnections.splice(
                        clientConns.clientConnections.indexOf(occupant),
                        1
                    );
                }
            });

            it('releases the client when the refusal timer ends it', async () => {
                ssh.SSHClient.RefusalTimeoutMs = 5;
                const before = themeListeners();
                const { conn, client } = connectRefused();
                await tick(30);
                assert.equal(client.clientEnded, true);
                assert.equal(themeListeners(), before);
                conn.emit('close');
                assert.equal(themeListeners(), before);
            });
        });

        describe('telnet', () => {
            let server;
            let port;

            before(done => {
                const net = require('net');
                server = net.createServer(socket => {
                    const client = new telnet.TelnetClient(socket);
                    client.banner();
                    new LoginServerModule().handleNewClient(
                        client,
                        socket,
                        telnet.moduleInfo
                    );
                    server.emit('enigma client', client);
                });
                server.listen(0, '127.0.0.1', () => {
                    port = server.address().port;
                    return done();
                });
            });

            after(done => {
                server.close(() => done());
            });

            //  a real telnet caller: everything it received, up to the FIN
            function call() {
                const net = require('net');
                return new Promise(resolve => {
                    const sock = net.connect(port, '127.0.0.1');
                    const got = { data: [] };
                    got.ended = new Promise(onEnd => {
                        sock.on('end', () => {
                            got.text = Buffer.concat(got.data).toString('latin1');
                            return onEnd(got);
                        });
                    });
                    sock.on('data', d => got.data.push(d));
                    server.once('enigma client', client => {
                        got.client = client;
                        return resolve(got);
                    });
                });
            }

            function withTimeout(promise, what) {
                return Promise.race([
                    promise,
                    tick(2000).then(() => {
                        throw new Error(`${what}: no FIN`);
                    }),
                ]);
            }

            it('writes the message, ends the connection, and tracks nothing', async () => {
                fillBoard();
                const listenersBefore = themeListeners();
                const got = await call();
                const ended = await withTimeout(got.ended, 'refused');

                assert.ok(ended.text.includes(BusyMessage), ended.text);
                assert.equal(got.client.clientEnded, true);
                assert.ok(!clientConns.clientConnections.includes(got.client));
                assert.ok(refusedLogged());

                //  for what still arrives from the caller (a terminal type
                //  answering the negotiation, say) before the socket closes
                assert.ok(got.client.log, 'client.log');
                assert.equal(themeListeners(), listenersBefore, 'client released');
            });

            it('several writes and then the end: all of it arrives before the FIN', async () => {
                const got = await call();
                const term = got.client.term;
                term.write('one ');
                term.write('two ');
                term.write('three ');
                term.write('Goodbye!');
                got.client.end();
                const ended = await withTimeout(got.ended, 'ended');
                assert.ok(ended.text.endsWith('one two three Goodbye!'), ended.text);
            });
        });

        describe('WebSocket', () => {
            let server;
            let wsServer;
            let port;
            let clients;

            before(done => {
                const WebSocket = require('ws');
                server = http.createServer();
                wsServer = new WebSocket.Server({ server });
                clients = [];
                wsServer.on('connection', (ws, req) => {
                    const client = new websocket.WebSocketClient(ws, req, 'insecure');
                    clients.push(client);
                    new LoginServerModule().handleNewClient(
                        client,
                        client.socket,
                        websocket.moduleInfo
                    );
                    server.emit('enigma client', client);
                });
                server.listen(0, '127.0.0.1', () => {
                    port = server.address().port;
                    return done();
                });
            });

            after(done => {
                clients.forEach(c => c.end());
                wsServer.close();
                server.close(() => done());
            });

            //
            //  A real WebSocket caller: everything it received and how the
            //  connection closed.
            //
            function call(headers = {}) {
                const WebSocket = require('ws');
                return new Promise((resolve, reject) => {
                    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers });
                    const got = { data: [], ws };
                    got.closed = new Promise(onClose => {
                        ws.on('close', (code, reason) => {
                            got.code = code;
                            got.reason = String(reason);
                            got.text = Buffer.concat(got.data).toString('latin1');
                            return onClose(got);
                        });
                    });
                    ws.on('message', d => got.data.push(Buffer.from(d)));
                    ws.on('error', reject);
                    server.once('enigma client', client => {
                        got.client = client;
                        return resolve(got);
                    });
                });
            }

            function withTimeout(promise, what) {
                return Promise.race([
                    promise,
                    tick(2000).then(() => {
                        throw new Error(`${what}: the WebSocket was not closed`);
                    }),
                ]);
            }

            it('writes the message, then closes with 1013 (Try Again Later)', async () => {
                fillBoard();
                const listenersBefore = themeListeners();
                const got = await call();
                const closed = await withTimeout(got.closed, 'refused');

                assert.ok(closed.text.includes(BusyMessage), closed.text);
                assert.equal(closed.code, 1013);
                assert.equal(closed.reason, 'All nodes are busy');
                assert.equal(themeListeners(), listenersBefore, 'client released');
                assert.ok(!clientConns.clientConnections.includes(got.client));
                assert.ok(refusedLogged());
            });

            it('a session ended from this side closes the WebSocket, after its last output', async () => {
                const got = await call();
                assert.ok(clientConns.clientConnections.includes(got.client));

                got.client.term.write('Goodbye!');
                got.client.end(); //  logoff, idle timeout, a kick: all end() here
                const closed = await withTimeout(got.closed, 'ended');

                assert.ok(closed.text.endsWith('Goodbye!'), closed.text);
                assert.equal(closed.code, 1000);
                await tick(10);
                assert.ok(
                    !clientConns.clientConnections.includes(got.client),
                    'removed once closed'
                );
            });

            it('several writes and then the end: all of it arrives, then the close', async () => {
                const got = await call();
                const term = got.client.term;
                term.write('one ');
                term.write('two ');
                term.write('three ');
                term.write('Goodbye!');
                got.client.end();
                const closed = await withTimeout(got.closed, 'ended');
                assert.ok(closed.text.endsWith('one two three Goodbye!'), closed.text);
                assert.equal(closed.code, 1000);
            });

            it('a stream that fails before the end still closes the WebSocket', async () => {
                const got = await call();
                got.client.socket.rawSocket.destroy(new Error('stream failed'));
                const closed = await withTimeout(got.closed, 'destroyed');
                assert.equal(closed.code, 1000);
            });

            it('the same behind a reverse proxy', async () => {
                const previous = config.loginServers.webSocket.proxied;
                config.loginServers.webSocket.proxied = true;
                try {
                    const got = await call({
                        'x-forwarded-for': '203.0.113.7',
                        'x-forwarded-proto': 'https',
                    });
                    assert.equal(got.client.socket.remoteAddress, '203.0.113.7');
                    assert.equal(got.client.isSecure, true);

                    got.client.end();
                    const closed = await withTimeout(got.closed, 'proxied');
                    assert.equal(closed.code, 1000);
                } finally {
                    config.loginServers.webSocket.proxied = previous;
                }
            });
        });
    });

    describe('SSH login timeout (#1080)', () => {
        let saved1080;

        beforeEach(() => {
            saved1080 = {
                loginTimeoutSeconds: config.loginServers.ssh.loginTimeoutSeconds,
                closeGraceMs: ssh.SSHClient.RefusalCloseGraceMs,
            };
        });

        afterEach(() => {
            config.loginServers.ssh.loginTimeoutSeconds = saved1080.loginTimeoutSeconds;
            ssh.SSHClient.RefusalCloseGraceMs = saved1080.closeGraceMs;

            //  a test that fails must not leave the one node taken for the next
            clientConns.clientConnections
                .slice()
                .forEach(client => clientConns.removeClient(client));
        });

        it('defaults to 120 seconds, as OpenSSH LoginGraceTime', () => {
            assert.equal(configDefault().loginServers.ssh.loginTimeoutSeconds, 120);
            config.loginServers.ssh.loginTimeoutSeconds = 120;
            assert.equal(ssh.SSHClient.getLoginTimeoutMs(), 120000);
        });

        it('0 turns it off; a value that is not a number gets the default', () => {
            config.loginServers.ssh.loginTimeoutSeconds = 0;
            assert.equal(ssh.SSHClient.getLoginTimeoutMs(), 0);
            ['120', -5, null, NaN].forEach(value => {
                config.loginServers.ssh.loginTimeoutSeconds = value;
                assert.equal(ssh.SSHClient.getLoginTimeoutMs(), 120000, String(value));
            });
        });

        function connectTracked() {
            const conn = makeSshConn();
            const client = new ssh.SSHClient(conn, {
                header: { identRaw: 'SSH-2.0-OpenSSH_9.6' },
            });
            new LoginServerModule().handleNewClient(client, conn._sock, ssh.moduleInfo);
            conn._sock.destroyed = false;
            conn._sock.destroy = () => {
                conn._sock.destroyed = true;
                conn.emit('close');
            };
            return { conn, client };
        }

        it('ends a connection that has not reached the shell, then frees its node', async () => {
            config.loginServers.ssh.loginTimeoutSeconds = 0.01;
            ssh.SSHClient.RefusalCloseGraceMs = 50;
            const { conn, client } = connectTracked();
            assert.ok(clientConns.clientConnections.includes(client));

            await tick(30);
            assert.equal(conn.endCount, 1, 'ended');
            assert.equal(client.clientEnded, true);
            assert.equal(conn._sock.destroyed, false, 'given the grace time');

            await tick(60);
            assert.equal(conn._sock.destroyed, true, 'closed outright');
            assert.ok(!clientConns.clientConnections.includes(client), 'node freed');
        });

        it('does nothing to a connection that closes first', async () => {
            config.loginServers.ssh.loginTimeoutSeconds = 0.01;
            const { conn, client } = connectTracked();
            conn.emit('close');
            assert.ok(!clientConns.clientConnections.includes(client));
            const endCount = conn.endCount;
            await tick(30);
            assert.equal(conn.endCount, endCount, 'timer did not fire');
        });

        it('is cleared when the shell opens', async () => {
            config.loginServers.ssh.loginTimeoutSeconds = 0.01;
            const { conn, client } = connectTracked();
            let ready = 0;
            client.removeAllListeners('ready'); //  no menus here
            client.on('ready', () => (ready += 1));

            conn.emit('ready');
            const session = new EventEmitter();
            conn.emit('session', () => session);
            session.emit('shell', () => ({
                stdin: new PassThrough(),
                stdout: new PassThrough(),
            }));
            assert.equal(ready, 1);

            await tick(30);
            assert.equal(conn.endCount, 0, 'not ended');
            assert.equal(client.clientEnded, false);
            assert.ok(clientConns.clientConnections.includes(client));
            conn.emit('close');
        });

        it('0 leaves a connection that has not reached the shell alone', async () => {
            config.loginServers.ssh.loginTimeoutSeconds = 0;
            const { conn, client } = connectTracked();
            assert.equal(client.loginTimer, undefined);
            await tick(20);
            assert.equal(conn.endCount, 0);
            conn.emit('close');
        });

        describe('a real SSH server', () => {
            const crypto = require('crypto');
            const fs = require('fs');
            const net = require('net');
            const os = require('os');
            const path = require('path');
            const ssh2 = require('ssh2');

            let tmpDir;
            let sockets;
            let mod;
            let port;
            let clients;
            let savedKey;

            before(done => {
                tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enigma-ssh-1080-'));
                const { privateKey } = crypto.generateKeyPairSync('rsa', {
                    modulusLength: 2048,
                    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
                    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
                });
                const keyPath = path.join(tmpDir, 'host_key.pem');
                fs.writeFileSync(keyPath, privateKey);

                savedKey = {
                    enabled: config.loginServers.ssh.enabled,
                    privateKeyPem: config.loginServers.ssh.privateKeyPem,
                    privateKeyPass: config.loginServers.ssh.privateKeyPass,
                };
                config.loginServers.ssh.enabled = true;
                config.loginServers.ssh.privateKeyPem = keyPath;
                config.loginServers.ssh.privateKeyPass = undefined;

                mod = new ssh.getModule();
                clients = [];
                sockets = [];
                const handleNewClient = mod.handleNewClient.bind(mod);
                mod.handleNewClient = (client, sock, modInfo) => {
                    clients.push(client);
                    return handleNewClient(client, sock, modInfo);
                };
                mod.prepareClient = (client, cb) => cb(null); //  no themes here

                mod.createServer(err => {
                    if (err) {
                        return done(err);
                    }
                    mod.server.listen(0, '127.0.0.1', () => {
                        port = mod.server.address().port;
                        return done();
                    });
                });
            });

            after(done => {
                Object.assign(config.loginServers.ssh, savedKey);
                clients.forEach(c => c.end());
                sockets.forEach(s => s.destroy());
                fs.rmSync(tmpDir, { recursive: true, force: true });
                mod.server.close(() => done());
            });

            function waitFor(what, test, ms = 3000) {
                const start = Date.now();
                return new Promise((resolve, reject) => {
                    const check = () => {
                        if (test()) {
                            return resolve();
                        }
                        if (Date.now() - start > ms) {
                            return reject(new Error(`timed out waiting for: ${what}`));
                        }
                        setTimeout(check, 10);
                    };
                    check();
                });
            }

            //
            //  ssh2 hands a connection over (and it takes a node) once the
            //  caller has sent its identification line; this one then stops,
            //  before key exchange, and never closes its side either.
            //
            it('a caller that stalls before key exchange is disconnected and its node freed', async () => {
                config.loginServers.ssh.loginTimeoutSeconds = 0.2;
                ssh.SSHClient.RefusalCloseGraceMs = 100;

                const sock = net.connect({
                    port,
                    host: '127.0.0.1',
                    allowHalfOpen: true,
                });
                sockets.push(sock);
                sock.on('connect', () => sock.write('SSH-2.0-Stalled_1.0\r\n'));
                sock.on('data', () => {});
                let fin = false;
                sock.on('end', () => (fin = true));
                let closed = false;
                sock.on('close', () => (closed = true));
                sock.on('error', () => {});

                await waitFor('the connection', () => clients.length > 0);
                const client = clients[clients.length - 1];
                assert.ok(clientConns.clientConnections.includes(client), 'holds a node');

                await tick(100);
                assert.equal(closed, false, 'not before the timeout');

                await waitFor('the disconnect', () => fin);
                assert.equal(closed, false, 'the caller has not closed its side');
                await waitFor('the socket to be closed outright', () => {
                    return client.rawSocket.destroyed;
                });
                await waitFor('the node to be freed', () => {
                    return !clientConns.clientConnections.includes(client);
                });
                assert.equal(client.clientEnded, true);
            });

            it('a caller that stalls during authentication is disconnected and its node freed', async () => {
                config.loginServers.ssh.loginTimeoutSeconds = 0.3;
                const count = clients.length;

                const sshClient = new ssh2.Client();
                let closed = false;
                let authAsked = false;
                sshClient.on('close', () => (closed = true));
                sshClient.on('error', () => {});
                sshClient.connect({
                    host: '127.0.0.1',
                    port,
                    username: 'somebody',
                    //  key exchange done; then never says how it will authenticate
                    authHandler: () => {
                        authAsked = true;
                    },
                });

                await waitFor('the session', () => clients.length > count);
                const client = clients[clients.length - 1];
                await waitFor('authentication', () => authAsked);
                assert.ok(clientConns.clientConnections.includes(client), 'holds a node');

                await waitFor('the disconnect', () => closed);
                await waitFor('the node to be freed', () => {
                    return !clientConns.clientConnections.includes(client);
                });
            });

            it('a caller that logs in and opens a shell keeps its connection', async () => {
                config.loginServers.ssh.loginTimeoutSeconds = 0.2;
                const count = clients.length;

                const sshClient = new ssh2.Client();
                let closed = false;
                sshClient.on('close', () => (closed = true));
                sshClient.on('error', () => {});

                await new Promise((resolve, reject) => {
                    sshClient.on('ready', () => {
                        //  No pty request: a terminal type would go through
                        //  ClientTerminal, which reads a Config captured by
                        //  whichever test file loaded it first.
                        sshClient.shell(false, (err, stream) => {
                            if (err) {
                                return reject(err);
                            }
                            stream.on('data', () => {});
                            return resolve();
                        });
                    });
                    sshClient.on('error', reject);
                    sshClient.connect({
                        host: '127.0.0.1',
                        port,
                        username: 'new',
                        password: 'x',
                    });
                });

                await waitFor('the session', () => clients.length > count);
                const client = clients[clients.length - 1];
                await waitFor('the shell', () => Boolean(client.input));
                assert.equal(client.loginTimer, undefined, 'timer cleared');

                await tick(400); //  twice the timeout
                assert.equal(closed, false, 'still connected');
                assert.equal(client.clientEnded, false);
                assert.ok(clientConns.clientConnections.includes(client));

                sshClient.end();
                await waitFor('the node to be freed', () => {
                    return !clientConns.clientConnections.includes(client);
                });
            });
        });
    });

    describe('telnet socket ended from this side (#1080)', () => {
        const net = require('net');
        let server;
        let port;
        let graceMs;
        const sockets = [];

        before(done => {
            graceMs = telnet.TelnetClient.EndCloseGraceMs;
            server = net.createServer(socket => {
                const client = new telnet.TelnetClient(socket);
                client.banner();
                new LoginServerModule().handleNewClient(
                    client,
                    socket,
                    telnet.moduleInfo
                );
                server.emit('enigma client', client);
            });
            server.listen(0, '127.0.0.1', () => {
                port = server.address().port;
                return done();
            });
        });

        after(done => {
            telnet.TelnetClient.EndCloseGraceMs = graceMs;
            sockets.forEach(s => s.destroy());
            server.close(() => done());
        });

        //  a caller that does not close its side when this side ends
        function call() {
            return new Promise(resolve => {
                const sock = net.connect({
                    port,
                    host: '127.0.0.1',
                    allowHalfOpen: true,
                });
                sockets.push(sock);
                const got = { data: [], sock, closed: false };
                sock.on('data', d => got.data.push(d));
                sock.on('end', () => (got.fin = true));
                sock.on('close', () => (got.closed = true));
                sock.on('error', () => {});
                server.once('enigma client', client => {
                    got.client = client;
                    return resolve(got);
                });
            });
        }

        it('closes the socket once the grace time has passed, after the last output', async () => {
            telnet.TelnetClient.EndCloseGraceMs = 100;
            const got = await call();
            got.client.term.write('Goodbye!');
            got.client.end();

            await tick(50);
            assert.equal(got.fin, true, 'FIN sent');
            assert.equal(got.client.rawSocket.destroyed, false, 'waiting for the caller');

            await tick(200);
            assert.equal(got.client.rawSocket.destroyed, true, 'closed outright');
            const text = Buffer.concat(got.data).toString('latin1');
            assert.ok(text.endsWith('Goodbye!'), text);
            assert.ok(!clientConns.clientConnections.includes(got.client), 'node freed');
        });

        it('a caller that closes its side in time is closed as before', async () => {
            telnet.TelnetClient.EndCloseGraceMs = 5000;
            const got = await call();
            got.client.end();
            await tick(50);
            assert.equal(got.fin, true);
            got.sock.end();
            await tick(50);
            assert.equal(got.closed, true);
            assert.equal(got.client.rawSocket.destroyed, true);
        });
    });
});
