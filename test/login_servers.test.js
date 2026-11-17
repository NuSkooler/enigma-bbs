'use strict';

//
//  #1017: the login servers when every node is busy (each turns the caller
//  away cleanly and tracks nothing), SSH terminal info sent before the shell,
//  and a WebSocket session ended from this side closing the WebSocket.
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

            it('steers other methods to keyboard-interactive once, then ends', () => {
                const { conn } = connectRefused();

                const none = makeAuthCtx('none');
                conn.emit('authentication', none);
                assert.deepEqual(none.rejects, [['keyboard-interactive']]);
                assert.equal(conn.endCount, 0);

                const password = makeAuthCtx('password', 'somebody');
                conn.emit('authentication', password);
                assert.equal(password.rejects.length, 1);
                assert.equal(conn.endCount, 1);
                conn.emit('close');
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
                const { conn } = connectRefused();
                conn.emit('close');
                await tick(30);
                assert.equal(conn.endCount, 0);
            });
        });

        describe('telnet', () => {
            function makeRawSocket() {
                const rawSocket = new EventEmitter();
                rawSocket.written = [];
                rawSocket.ended = 0;
                rawSocket.remoteAddress = '192.0.2.11';
                rawSocket.write = data => {
                    rawSocket.written.push(Buffer.from(data));
                    return true;
                };
                rawSocket.end = () => (rawSocket.ended += 1);
                return rawSocket;
            }

            it('writes the message, ends the connection, and tracks nothing', () => {
                fillBoard();
                const rawSocket = makeRawSocket();
                const client = new telnet.TelnetClient(rawSocket);
                client.banner();

                const mod = new LoginServerModule();
                assert.doesNotThrow(() =>
                    mod.handleNewClient(client, rawSocket, telnet.moduleInfo)
                );

                const output = Buffer.concat(rawSocket.written).toString('latin1');
                assert.ok(output.includes(BusyMessage), output);
                assert.ok(rawSocket.ended > 0);
                assert.equal(client.clientEnded, true);
                assert.ok(!clientConns.clientConnections.includes(client));
                assert.ok(refusedLogged());

                //  for what still arrives from the caller (a terminal type
                //  answering the negotiation, say) before the socket closes
                assert.ok(client.log, 'client.log');
                rawSocket.emit('close');
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
                const got = await call();
                const closed = await withTimeout(got.closed, 'refused');

                assert.ok(closed.text.includes(BusyMessage), closed.text);
                assert.equal(closed.code, 1013);
                assert.equal(closed.reason, 'All nodes are busy');
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
});
