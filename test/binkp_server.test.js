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
        const prev = configModule._pushTestConfig({ debug: { assertsEnabled: false } });
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
                    await fsp.mkdir(path.join(cliDir, 'outbound'), { recursive: true });
                    await fsp.mkdir(path.join(cliDir, 'ftn_in'), { recursive: true });
                    await fsp.mkdir(path.join(cliDir, 'ftn_secin'), { recursive: true });

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
                    networks: { testnet: { localAddress: '1:218/700', defaultZone: 1 } },
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
