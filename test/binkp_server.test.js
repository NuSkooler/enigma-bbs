'use strict';

const { strict: assert } = require('assert');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const net = require('net');

//  ── mock logger ──────────────────────────────────────────────────────────────
const loggerModule = require('../core/logger.js');
if (!loggerModule.log) {
    loggerModule.log = {
        child() {
            return this;
        },
        warn() {},
        info() {},
        debug() {},
        trace() {},
        error() {},
    };
} else if (!loggerModule.log.child) {
    loggerModule.log.child = function () {
        return loggerModule.log;
    };
}

const configModule = require('../core/config.js');
const Events = require('../core/events.js');
const { BinkpSession } = require('../core/binkp/session.js');
const { BsoSpool, attachSpoolToSession } = require('../core/binkp/bso_spool.js');

// ── fixtures ──────────────────────────────────────────────────────────────────

let tmpDir;

//  Wrapping describe — see binkp_caller.test.js for the rationale.
//  Top-level before/after in mocha are root hooks; wrapping scopes them
//  to this file's tests so cross-file config writes don't leak.
describe('BinkP server', function () {
    before(async () => {
        tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'enigma_binkp_srv_test_'));
        await fsp.mkdir(path.join(tmpDir, 'ftn_out'), { recursive: true });
        await fsp.mkdir(path.join(tmpDir, 'ftn_in'), { recursive: true });
        await fsp.mkdir(path.join(tmpDir, 'ftn_secin'), { recursive: true });
    });

    after(async () => {
        await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    function makeConfig(binkpOverride = {}) {
        return {
            debug: { assertsEnabled: false },
            scannerTossers: {
                ftn_bso: {
                    paths: {
                        outbound: tmpDir,
                        inbound: path.join(tmpDir, 'ftn_in'),
                        secInbound: path.join(tmpDir, 'ftn_secin'),
                    },
                    binkp: Object.assign(
                        {
                            inbound: {
                                enabled: true,
                                port: 0, // ephemeral
                                address: '127.0.0.1',
                            },
                        },
                        binkpOverride
                    ),
                },
            },
            messageNetworks: {
                ftn: {
                    networks: {
                        testnet: {
                            localAddress: '1:218/700',
                            defaultZone: 1,
                        },
                    },
                },
            },
        };
    }

    // Start the BinkP scanner/tosser module; returns { mod, port, stop }.
    async function startModule(binkpOverride = {}) {
        const prev = configModule._pushTestConfig(makeConfig(binkpOverride));
        const { getModule } = require('../core/scanner_tossers/binkp.js');
        const mod = new getModule();

        await new Promise((resolve, reject) =>
            mod.startup(err => (err ? reject(err) : resolve()))
        );

        const port = mod._server.address().port;
        return {
            mod,
            port,
            stop: async () => {
                await new Promise(res => mod.shutdown(res));
                configModule._popTestConfig(prev);
            },
        };
    }

    // Connect an originating BinkpSession to port.
    function connectClient(port, opts = {}) {
        const socket = net.createConnection(port, '127.0.0.1');
        const session = new BinkpSession(socket, {
            role: 'originating',
            addresses: opts.addresses || ['1:218/701@testnet'],
            getPassword: opts.getPassword || (() => null),
            tempDir: os.tmpdir(),
        });
        return { session, socket };
    }

    // ── Module shape ──────────────────────────────────────────────────────────────

    describe('BinkpModule — module shape', () => {
        it('exports moduleInfo with required fields', () => {
            const mod = require('../core/scanner_tossers/binkp.js');
            assert.ok(mod.moduleInfo.name);
            assert.ok(mod.moduleInfo.desc);
            assert.ok(mod.moduleInfo.packageName);
        });

        it('exports getModule as a constructor', () => {
            const { getModule } = require('../core/scanner_tossers/binkp.js');
            assert.equal(typeof getModule, 'function');
            const inst = new getModule();
            assert.equal(typeof inst.startup, 'function');
            assert.equal(typeof inst.shutdown, 'function');
        });
    });

    // ── startup / shutdown lifecycle ──────────────────────────────────────────────

    describe('BinkpModule — lifecycle', () => {
        it('startup starts the inbound server and shutdown stops it', async () => {
            const { mod, stop } = await startModule();
            assert.ok(mod._server, 'server should be running after startup');
            await stop();
            assert.equal(mod._server, null, 'server should be null after shutdown');
        });

        it('startup does nothing when inbound.enabled is false', async () => {
            const prev = configModule._pushTestConfig(
                makeConfig({
                    inbound: { enabled: false, port: 0, address: '127.0.0.1' },
                })
            );
            const { getModule } = require('../core/scanner_tossers/binkp.js');
            const mod = new getModule();
            await new Promise((res, rej) => mod.startup(err => (err ? rej(err) : res())));
            assert.equal(mod._server, null);
            await new Promise(res => mod.shutdown(res));
            configModule._popTestConfig(prev);
        });

        it('startup does nothing when ftn_bso is not configured', async () => {
            const prev = configModule._pushTestConfig({
                debug: { assertsEnabled: false },
            });
            const { getModule } = require('../core/scanner_tossers/binkp.js');
            const mod = new getModule();
            await new Promise((res, rej) => mod.startup(err => (err ? rej(err) : res())));
            assert.equal(mod._server, null);
            configModule._popTestConfig(prev);
        });
    });

    // ── Connection handling ───────────────────────────────────────────────────────

    describe('BinkpModule — connection handling', () => {
        it('accepts a connection and completes a no-file session', done => {
            startModule()
                .then(({ port, stop }) => {
                    const { session } = connectClient(port);
                    session.on('session-end', () =>
                        stop()
                            .then(() => done())
                            .catch(done)
                    );
                    session.on('error', err =>
                        stop()
                            .then(() => done(err))
                            .catch(done)
                    );
                    session.start();
                })
                .catch(done);
        });

        it('advertises the configured FTN address to connecting client', done => {
            startModule()
                .then(({ port, stop }) => {
                    const { session } = connectClient(port);
                    let receivedAddrs = [];
                    session.on('addresses', addrs => {
                        receivedAddrs = addrs;
                    });
                    session.on('session-end', () => {
                        stop()
                            .then(() => {
                                try {
                                    assert.ok(
                                        receivedAddrs.some(a => a.includes('1:218/700')),
                                        `Expected 1:218/700 in addresses: ${receivedAddrs.join(', ')}`
                                    );
                                    done();
                                } catch (e) {
                                    done(e);
                                }
                            })
                            .catch(done);
                    });
                    session.on('error', err =>
                        stop()
                            .then(() => done(err))
                            .catch(done)
                    );
                    session.start();
                })
                .catch(done);
        });

        it('session is non-secure when no password configured', done => {
            startModule()
                .then(({ port, stop }) => {
                    const { session } = connectClient(port);
                    let secure = null;
                    session.on('authenticated', s => {
                        secure = s;
                    });
                    session.on('session-end', () => {
                        stop()
                            .then(() => {
                                try {
                                    assert.equal(secure, false);
                                    done();
                                } catch (e) {
                                    done(e);
                                }
                            })
                            .catch(done);
                    });
                    session.on('error', err =>
                        stop()
                            .then(() => done(err))
                            .catch(done)
                    );
                    session.start();
                })
                .catch(done);
        });

        it('session is secure when client sends correct password', done => {
            startModule({
                inbound: { enabled: true, port: 0, address: '127.0.0.1' },
                nodes: { '1:218/701': { sessionPassword: 'testpw' } },
            })
                .then(({ port, stop }) => {
                    const { session } = connectClient(port, {
                        addresses: ['1:218/701@testnet'],
                        getPassword: () => 'testpw',
                    });
                    let secure = null;
                    session.on('authenticated', s => {
                        secure = s;
                    });
                    session.on('session-end', () => {
                        stop()
                            .then(() => {
                                try {
                                    assert.equal(secure, true);
                                    done();
                                } catch (e) {
                                    done(e);
                                }
                            })
                            .catch(done);
                    });
                    session.on('error', err =>
                        stop()
                            .then(() => done(err))
                            .catch(done)
                    );
                    session.start();
                })
                .catch(done);
        });

        it('emits NewInboundBSO when a file is received from the connecting client', done => {
            startModule()
                .then(async ({ port, stop }) => {
                    // Create a separate tmpDir for the client spool so it doesn't share state
                    // with the server spool (which uses the module's configured paths).
                    const cliDir = await fsp.mkdtemp(
                        path.join(os.tmpdir(), 'enigma_cli_send_')
                    );
                    try {
                        await fsp.mkdir(path.join(cliDir, 'outbound'), {
                            recursive: true,
                        });
                        await fsp.mkdir(path.join(cliDir, 'ftn_in'), { recursive: true });
                        await fsp.mkdir(path.join(cliDir, 'ftn_secin'), {
                            recursive: true,
                        });

                        // Client (1:218/701) sends a file to the server (1:218/700 → 00da02bc)
                        const refFile = path.join(cliDir, 'cli_to_srv.pkt');
                        await fsp.writeFile(refFile, 'CLI_DATA');
                        await fsp.writeFile(
                            path.join(cliDir, 'outbound', '00da02bc.flo'),
                            `^${refFile}\n`
                        );

                        const clientSpool = new BsoSpool({
                            paths: {
                                outbound: cliDir,
                                inbound: path.join(cliDir, 'ftn_in'),
                                secInbound: path.join(cliDir, 'ftn_secin'),
                            },
                            networks: {
                                testnet: { localAddress: '1:218/701', defaultZone: 1 },
                            },
                        });

                        let gotEvent = false;
                        Events.once(Events.getSystemEvents().NewInboundBSO, () => {
                            gotEvent = true;
                        });

                        const Address = require('../core/ftn_address.js');
                        const { session } = connectClient(port);
                        const serverAddr = new Address({ zone: 1, net: 218, node: 700 });
                        await attachSpoolToSession(session, clientSpool, [serverAddr]);

                        session.on('session-end', () => {
                            fsp.rm(cliDir, { recursive: true, force: true })
                                .then(() => stop())
                                .then(() => {
                                    try {
                                        assert.ok(
                                            gotEvent,
                                            'NewInboundBSO should be emitted'
                                        );
                                        done();
                                    } catch (e) {
                                        done(e);
                                    }
                                })
                                .catch(done);
                        });
                        session.on('error', err =>
                            fsp
                                .rm(cliDir, { recursive: true, force: true })
                                .then(() => stop())
                                .then(() => done(err))
                                .catch(done)
                        );
                        session.start();
                    } catch (err) {
                        await fsp
                            .rm(cliDir, { recursive: true, force: true })
                            .catch(() => {});
                        throw err;
                    }
                })
                .catch(done);
        });

        it('sends M_BSY when the node already holds a BSY lock', done => {
            startModule()
                .then(async ({ port, stop }) => {
                    const { BsoSpool } = require('../core/binkp/bso_spool.js');
                    const spool = new BsoSpool({
                        paths: {
                            outbound: tmpDir,
                            inbound: path.join(tmpDir, 'ftn_in'),
                            secInbound: path.join(tmpDir, 'ftn_secin'),
                        },
                        networks: {
                            testnet: { localAddress: '1:218/700', defaultZone: 1 },
                        },
                    });
                    const lockAddr = { zone: 1, net: 218, node: 701 };
                    await spool.acquireLock(lockAddr);

                    const { session } = connectClient(port);
                    let gotBusy = false;
                    session.on('busy', () => {
                        gotBusy = true;
                    });

                    const finish = async () => {
                        await spool.releaseLock(lockAddr);
                        await stop();
                        try {
                            assert.ok(gotBusy, 'expected busy event');
                            done();
                        } catch (e) {
                            done(e);
                        }
                    };
                    session.on('disconnect', finish);
                    session.on('session-end', finish);
                    session.on('error', async err => {
                        await spool.releaseLock(lockAddr);
                        stop()
                            .then(() => done(err))
                            .catch(done);
                    });
                    session.start();
                })
                .catch(done);
        });
    });

    // ── Pull cycle (periodic outbound polling of all configured peers) ────────────
    //
    //  The pull cycle is what keeps echo-mail flowing in from quiet hubs that
    //  wait for the spoke to call. We validate the address-selection logic here;
    //  the actual schedule firing is delegated to later.js (no value testing
    //  someone else's library).

    describe('BinkpModule — _pullAddresses (pull-cycle target selection)', () => {
        it('returns concrete addresses from binkp.nodes', () => {
            const prev = configModule._pushTestConfig(makeConfig());
            const { getModule } = require('../core/scanner_tossers/binkp.js');
            const mod = new getModule();

            const addrs = mod._pullAddresses({
                nodes: {
                    '1:218/700': { host: 'a' },
                    '700:100/0': { host: 'b' },
                    '911:1423/0': { host: 'c' },
                },
            });

            configModule._popTestConfig(prev);
            const strs = addrs.map(a => a.toString()).sort();
            assert.deepEqual(strs, ['1:218/700', '700:100/0', '911:1423/0']);
        });

        it('omits nodes flagged pull:false', () => {
            const prev = configModule._pushTestConfig(makeConfig());
            const { getModule } = require('../core/scanner_tossers/binkp.js');
            const mod = new getModule();

            const addrs = mod._pullAddresses({
                nodes: {
                    '1:218/700': { host: 'a' },
                    '700:100/0': { host: 'b', pull: false },
                },
            });

            configModule._popTestConfig(prev);
            assert.deepEqual(
                addrs.map(a => a.toString()),
                ['1:218/700']
            );
        });

        it('skips wildcard / non-concrete patterns', () => {
            const prev = configModule._pushTestConfig(makeConfig());
            const { getModule } = require('../core/scanner_tossers/binkp.js');
            const mod = new getModule();

            const addrs = mod._pullAddresses({
                nodes: {
                    '21:*': { host: 'wild' }, // wildcard — can't dial
                    '1:218/700': { host: 'a' },
                },
            });

            configModule._popTestConfig(prev);
            assert.deepEqual(
                addrs.map(a => a.toString()),
                ['1:218/700']
            );
        });

        it('returns [] when binkp.nodes is missing or empty', () => {
            const prev = configModule._pushTestConfig(makeConfig());
            const { getModule } = require('../core/scanner_tossers/binkp.js');
            const mod = new getModule();

            assert.deepEqual(mod._pullAddresses({}), []);
            assert.deepEqual(mod._pullAddresses({ nodes: {} }), []);
            configModule._popTestConfig(prev);
        });
    });

    // ── Crashmail (event-driven outbound dispatch on NewOutboundBSO) ──────────────
    //
    //  When ftn_bso emits NewOutboundBSO with a destination address, the BinkP
    //  module debounces briefly to coalesce back-to-back exports for the same
    //  peer, then dials. End-to-end tests dial a real fake server so the dial
    //  itself is observable.

    describe('BinkpModule — crashmail dispatch', () => {
        it('registers a NewOutboundBSO listener on startup, removes it on shutdown', async () => {
            const eventName = Events.getSystemEvents().NewOutboundBSO;
            const before = Events.listenerCount(eventName);

            const { mod, stop } = await startModule();
            assert.equal(
                Events.listenerCount(eventName),
                before + 1,
                'startup should register a NewOutboundBSO listener'
            );
            assert.equal(typeof mod._crashmailListener, 'function');

            await stop();
            assert.equal(
                Events.listenerCount(eventName),
                before,
                'shutdown should remove the NewOutboundBSO listener'
            );
            assert.equal(mod._crashmailListener, null);
        });

        it('debounces multiple events for the same address into a single dial', done => {
            //  Stand up a fake answering server and configure binkp to dial it.
            //  Emit NewOutboundBSO three times in quick succession for the same
            //  address — exactly one inbound connection should land within the
            //  debounce window.
            const Address = require('../core/ftn_address.js');
            let connections = 0;
            const fakeServer = net.createServer(sock => {
                connections += 1;
                sock.destroy(); // we only care about the connect, not a full session
            });

            fakeServer.listen(0, '127.0.0.1', async () => {
                const fakePort = fakeServer.address().port;
                const target = '1:218/702'; // address we'll dial
                const { mod, stop } = await startModule({
                    crashmailDebounceMs: 50,
                    nodes: {
                        [target]: { host: '127.0.0.1', port: fakePort },
                    },
                });

                const addr = Address.fromString(target);
                //  Emit three times — should coalesce
                Events.emit(Events.getSystemEvents().NewOutboundBSO, { address: addr });
                Events.emit(Events.getSystemEvents().NewOutboundBSO, { address: addr });
                Events.emit(Events.getSystemEvents().NewOutboundBSO, { address: addr });

                //  Wait long enough for the debounce + dial to complete
                setTimeout(async () => {
                    await stop();
                    fakeServer.close(() => {
                        try {
                            assert.equal(
                                connections,
                                1,
                                `expected exactly 1 dial after coalescing 3 events, got ${connections}`
                            );
                            done();
                        } catch (e) {
                            done(e);
                        }
                    });
                }, 250);
            });
        });

        it('dispatches once per distinct address within the debounce window', done => {
            //  Two different addresses emitted within the debounce window should
            //  both be dialed in the single batch flush. We count incoming
            //  connections to the fake server (each pollNodes dial = one TCP
            //  connect even if the BinkP session itself errors immediately).
            const Address = require('../core/ftn_address.js');
            let connections = 0;
            let resolveDone;
            const allConnections = new Promise(r => {
                resolveDone = r;
            });
            const fakeServer = net.createServer(sock => {
                connections += 1;
                sock.destroy();
                if (connections >= 2) resolveDone();
            });

            fakeServer.listen(0, '127.0.0.1', async () => {
                const fakePort = fakeServer.address().port;
                const { mod, stop } = await startModule({
                    crashmailDebounceMs: 50,
                    nodes: {
                        '1:218/710': { host: '127.0.0.1', port: fakePort },
                        '1:218/711': { host: '127.0.0.1', port: fakePort },
                    },
                });

                Events.emit(Events.getSystemEvents().NewOutboundBSO, {
                    address: Address.fromString('1:218/710'),
                });
                Events.emit(Events.getSystemEvents().NewOutboundBSO, {
                    address: Address.fromString('1:218/711'),
                });

                //  Wait for both connections to land OR a hard timeout. pollNodes
                //  dials sequentially (await per node) and each needs the prior
                //  to complete with an error before moving on.
                const timeout = new Promise(r => setTimeout(r, 4000));
                await Promise.race([allConnections, timeout]);
                await stop();
                fakeServer.close(() => {
                    try {
                        assert.equal(
                            connections,
                            2,
                            `expected 2 dials (one per address), got ${connections}`
                        );
                        done();
                    } catch (e) {
                        done(e);
                    }
                });
            });
        });

        it('discards events with a missing address payload', done => {
            startModule({ crashmailDebounceMs: 50 })
                .then(async ({ mod, stop }) => {
                    Events.emit(Events.getSystemEvents().NewOutboundBSO, {});
                    Events.emit(Events.getSystemEvents().NewOutboundBSO, {
                        address: null,
                    });
                    //  No timer should have been armed
                    setTimeout(() => {
                        assert.equal(
                            mod._crashmailTimer,
                            null,
                            'no timer should be armed for empty payloads'
                        );
                        assert.equal(mod._crashmailPending.size, 0);
                        stop().then(done).catch(done);
                    }, 75);
                })
                .catch(done);
        });
    });
}); // describe('BinkP server')
