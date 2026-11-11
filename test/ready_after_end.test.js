'use strict';

const { strict: assert } = require('assert');
const { EventEmitter } = require('events');

const configModule = require('../core/config.js');
const loggerModule = require('../core/logger.js');

//
//  #999: a transport can report 'ready' for a caller that has already gone.
//  Telnet waits up to 3s for a terminal type and used to emit 'ready' when
//  that timer fired whether or not the caller was still there; the login
//  server then started an idle monitor (never to be stopped) and the menu
//  chain for nobody.
//

const TelnetPath = require.resolve('../core/servers/login/telnet.js');

function makeLog() {
    const entries = [];
    const log = { entries, child: () => log };
    ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].forEach(level => {
        log[level] = (obj, msg) => entries.push({ level, obj, msg });
    });
    return log;
}

//
//  Just enough of the global timers to run the 3s terminal type wait and the
//  1m idle check by hand, and to see what is left running.
//
function installFakeTimers() {
    const real = {
        setTimeout: global.setTimeout,
        clearTimeout: global.clearTimeout,
        setInterval: global.setInterval,
        clearInterval: global.clearInterval,
    };
    const timers = new Map();
    let now = 0;
    let seq = 0;

    const add = (fn, ms, interval) => {
        const handle = { id: ++seq, unref() {}, ref() {} };
        timers.set(handle, { fn, at: now + (ms || 0), interval });
        return handle;
    };
    const remove = handle => timers.delete(handle);

    global.setTimeout = (fn, ms) => add(fn, ms, null);
    global.setInterval = (fn, ms) => add(fn, ms, ms);
    global.clearTimeout = remove;
    global.clearInterval = remove;

    return {
        tick(ms) {
            const until = now + ms;
            for (;;) {
                let next = null;
                for (const [handle, t] of timers) {
                    if (t.at <= until && (!next || t.at < next[1].at)) {
                        next = [handle, t];
                    }
                }
                if (!next) {
                    break;
                }
                const [handle, t] = next;
                now = t.at;
                if (t.interval) {
                    t.at += t.interval;
                } else {
                    timers.delete(handle);
                }
                t.fn();
            }
            now = until;
        },
        intervals: () => [...timers.values()].filter(t => t.interval).length,
        pending: () => timers.size,
        restore() {
            Object.assign(global, real);
        },
    };
}

describe('ready after the caller has gone (#999)', function () {
    let LoginServerModule;
    let clientConns;
    let connect;
    let saved;
    let connectEntries;

    before(() => {
        //  required lazily: these capture Config at first require
        LoginServerModule = require('../core/login_server_module.js');
        clientConns = require('../core/client_connections.js');
        connect = require('../core/connect.js');

        saved = {
            addNewClient: clientConns.addNewClient,
            removeClient: clientConns.removeClient,
            connectEntry: connect.connectEntry,
        };

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
        connect.connectEntry = (client, firstMenu) => {
            connectEntries.push({ client, firstMenu });
        };
    });

    after(() => {
        Object.assign(clientConns, {
            addNewClient: saved.addNewClient,
            removeClient: saved.removeClient,
        });
        connect.connectEntry = saved.connectEntry;
    });

    beforeEach(() => {
        connectEntries = [];
    });

    describe('the login server ready handler', () => {
        function makeClient() {
            const client = new EventEmitter();
            client.clientEnded = false;
            client.idleMonitorStarts = 0;
            client.startIdleMonitor = () => (client.idleMonitorStarts += 1);
            client.end = () => (client.clientEnded = true);
            client.term = { termType: 'ansi', emulation: { name: 'ansi' } };
            client.user = { isAuthenticated: () => true };
            return client;
        }

        function attach(client) {
            const mod = new LoginServerModule();
            mod.handleNewClient(client, new EventEmitter(), { name: 'test' });
            return mod;
        }

        it('a normal ready starts the idle monitor and the menu chain', () => {
            const client = makeClient();
            attach(client);
            client.emit('ready', { firstMenu: 'telnetConnected' });

            assert.equal(client.idleMonitorStarts, 1);
            assert.equal(connectEntries.length, 1);
            assert.equal(connectEntries[0].firstMenu, 'telnetConnected');
            client.emit('end');
        });

        it('ready after end does neither', () => {
            const client = makeClient();
            attach(client);
            client.emit('end');
            assert.equal(client.clientEnded, true);

            client.emit('ready', { firstMenu: 'telnetConnected' });

            assert.equal(client.idleMonitorStarts, 0);
            assert.equal(connectEntries.length, 0);
        });
    });

    describe('a telnet caller that drops before the terminal type wait is over', () => {
        let telnet;
        let previousConfig;
        let previousLog;
        let timers;

        before(() => {
            previousConfig = configModule._pushTestConfig({
                debug: { assertsEnabled: false },
                menus: { cls: false },
                general: { boardName: 'ENiGMA½ BBS' },
                loginServers: {
                    telnet: { port: 0, firstMenu: 'telnetConnected' },
                },
                users: { idleLogoutSeconds: 180, preAuthIdleLogoutSeconds: 180 },
            });
            previousLog = loggerModule.log;
            loggerModule.log = makeLog();

            delete require.cache[TelnetPath];
            telnet = require(TelnetPath);
        });

        after(() => {
            configModule._popTestConfig(previousConfig);
            loggerModule.log = previousLog;
            delete require.cache[TelnetPath];
        });

        beforeEach(() => {
            timers = installFakeTimers();
        });

        afterEach(() => {
            timers.restore();
        });

        function connectCaller() {
            const rawSocket = new EventEmitter();
            rawSocket.write = () => true;
            rawSocket.end = () => {};

            const client = new telnet.TelnetClient(rawSocket);
            client.readyCount = 0;
            client.on('ready', () => (client.readyCount += 1));

            const mod = new LoginServerModule();
            mod.prepareClient = (c, cb) => cb(null); //  no theme here
            mod.handleNewClient(client, rawSocket, { name: 'Telnet' });

            return { client, rawSocket };
        }

        it('emits no ready and leaves nothing running', () => {
            const { client, rawSocket } = connectCaller();

            rawSocket.emit('end'); //  hung up at once
            assert.equal(client.clientEnded, true);

            timers.tick(3500);
            assert.equal(client.readyCount, 0);
            assert.equal(connectEntries.length, 0);
            assert.equal(timers.pending(), 0, 'terminal type timer cleared');

            timers.tick(10 * 60 * 1000);
            assert.equal(timers.intervals(), 0, 'no idle monitor');
        });

        it('a caller who stays is ready after 3s, as before', () => {
            const { client, rawSocket } = connectCaller();

            timers.tick(2999);
            assert.equal(client.readyCount, 0);

            timers.tick(1);
            assert.equal(client.readyCount, 1);
            assert.equal(connectEntries.length, 1);
            assert.equal(connectEntries[0].firstMenu, 'telnetConnected');
            assert.ok(timers.intervals() > 0, 'idle monitor running');

            rawSocket.emit('end');
            assert.equal(timers.intervals(), 0, 'stopped by end()');
        });

        it('an ended session does not restart its idle monitor', () => {
            //  MRC, WFC and sysop chat restart it from leave(), which can
            //  run after the end
            const { client, rawSocket } = connectCaller();
            timers.tick(3000);
            rawSocket.emit('end');

            client.startIdleMonitor();
            assert.equal(timers.intervals(), 0);
        });

        it('a terminal type reply makes it ready at once, and only once', () => {
            const { client, rawSocket } = connectCaller();

            client._clientReady(); //  as the TTYPE subnegotiation does
            assert.equal(client.readyCount, 1);

            timers.tick(3500);
            assert.equal(client.readyCount, 1);

            rawSocket.emit('end');
        });
    });
});
