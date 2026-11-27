'use strict';

const { strict: assert } = require('assert');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const net = require('net');

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
                    //  Port 0: each module listens on a free port of its
                    //  own, never on one shared with another test run or a
                    //  BBS on this machine. startModule() reads the port back.
                    //  tempDir: startup sweeps it for old inbound temps, and
                    //  received files land there; keep both out of /tmp.
                    binkp: Object.assign(
                        {
                            tempDir: tmpDir,
                            inbound: {
                                enabled: true,
                                port: 0,
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

    //  Modules started and not yet stopped. A test that fails or times out
    //  before its own stop() leaves its module here, and afterEach stops it:
    //  its listener and its live sessions (and their .bsy locks) must not
    //  outlast the test. (test/setup.js restores the config it pushed.)
    const running = new Set();
    afterEach(async () => {
        for (const stop of Array.from(running)) {
            await stop();
        }
    });

    // Start the BinkP scanner/tosser module; returns { mod, port, stop }.
    async function startModule(binkpOverride = {}) {
        const prev = configModule._pushTestConfig(makeConfig(binkpOverride));
        const { getModule } = require('../core/scanner_tossers/binkp.js');
        const mod = new getModule();

        let stopped = null;
        const stop = () => {
            if (!stopped) {
                stopped = new Promise(res => mod.shutdown(res)).then(() => {
                    running.delete(stop);
                    configModule._popTestConfig(prev);
                });
            }
            return stopped;
        };
        running.add(stop);

        await new Promise((resolve, reject) =>
            mod.startup(err => (err ? reject(err) : resolve()))
        );

        const port = mod._server.address().port;
        return { mod, port, stop };
    }

    // Connect an originating BinkpSession to port.
    function connectClient(port, opts = {}) {
        const socket = net.createConnection(port, '127.0.0.1');
        const session = new BinkpSession(socket, {
            role: 'originating',
            addresses: opts.addresses || ['1:218/701@testnet'],
            getPassword: opts.getPassword || (() => null),
            tempDir: tmpDir,
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

    // ── per-node NR opt-in ────────────────────────────────────────────────────────

    describe('BinkpModule — requestNR node lookup', () => {
        function lookup(nodes, addrs) {
            const { getModule } = require('../core/scanner_tossers/binkp.js');
            return new getModule()._lookupRequestNR(nodes, addrs);
        }

        it('is off when no nodes are configured', () => {
            assert.equal(lookup({}, ['21:1/100']), false);
            assert.equal(lookup(undefined, ['21:1/100']), false);
        });

        it('is off for a node that has not opted in', () => {
            assert.equal(lookup({ '21:1/100': { host: 'x' } }, ['21:1/100']), false);
        });

        it('is on for a node that has', () => {
            assert.equal(lookup({ '21:1/100': { requestNR: true } }, ['21:1/100']), true);
        });

        it('ignores addresses that do not match', () => {
            assert.equal(
                lookup({ '21:1/100': { requestNR: true } }, ['21:1/200']),
                false
            );
        });

        it('honours any of the remote presented addresses', () => {
            assert.equal(
                lookup({ '46:1/100': { requestNR: true } }, ['21:1/200', '46:1/100']),
                true
            );
        });

        it('lets a specific node override a wildcard', () => {
            //  findBestNodeMatch scores by specificity rather than insertion
            //  order, so the concrete entry wins whichever way round the
            //  HJSON was written.
            const nodes = {
                '21:*': { requestNR: true },
                '21:1/100': { requestNR: false },
            };
            assert.equal(lookup(nodes, ['21:1/100']), false);
            assert.equal(lookup(nodes, ['21:1/999']), true);
        });

        it('tolerates malformed addresses from the remote', () => {
            assert.equal(
                lookup({ '21:1/100': { requestNR: true } }, ['not-an-address', '']),
                false
            );
        });
    });

    // ── per-node GZ opt-out ───────────────────────────────────────────────────────

    describe('BinkpModule — GZ node lookup', () => {
        function lookup(nodes, addrs) {
            const { getModule } = require('../core/scanner_tossers/binkp.js');
            return new getModule()._lookupNodeGz(nodes, addrs);
        }

        it('is on when nothing is configured', () => {
            assert.equal(lookup({}, ['21:1/100']), true);
            assert.equal(lookup(undefined, ['21:1/100']), true);
        });

        it('is on for a node that says nothing about it', () => {
            assert.equal(lookup({ '21:1/100': { host: 'x' } }, ['21:1/100']), true);
        });

        it('is off only for an explicit false', () => {
            assert.equal(lookup({ '21:1/100': { gz: false } }, ['21:1/100']), false);
            assert.equal(lookup({ '21:1/100': { gz: true } }, ['21:1/100']), true);
            //  A stray string must not read as "off" — that would silently
            //  disable compression for a peer the sysop meant to keep it on.
            assert.equal(lookup({ '21:1/100': { gz: 'no' } }, ['21:1/100']), true);
        });

        it('does not let an unrelated node disable it', () => {
            assert.equal(lookup({ '21:1/100': { gz: false } }, ['21:1/200']), true);
        });

        it('lets a specific node override a wildcard', () => {
            const nodes = {
                '21:*': { gz: false },
                '21:1/100': { gz: true },
            };
            assert.equal(lookup(nodes, ['21:1/100']), true);
            assert.equal(lookup(nodes, ['21:1/999']), false);
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

        //  #1052: a shutdown during a session used to wait for the session
        //  to end (a listener's close() waits for its connections), so the
        //  system exited on its safety timer and the lock stayed behind.
        it('shutdown ends a live session with M_BSY and releases its locks', async () => {
            const { FrameParser, buildCommandFrame } = require('../core/binkp/frame.js');
            const { Commands } = require('../core/binkp/commands.js');
            const bsoLock = require('../core/bso_lock.js');
            //  1:218/701. The answering side only locks in a directory that
            //  exists.
            await fsp.mkdir(path.join(tmpDir, 'outbound'), { recursive: true });
            const bsyPath = path.join(tmpDir, 'outbound', '00da02bd.bsy');

            const { stop, port } = await startModule();
            let stopped = false;
            let socket = null;
            try {
                const received = [];
                const parser = new FrameParser();
                parser.on('frame', f => 'command' === f.type && received.push(f.cmd));
                socket = net.createConnection(port, '127.0.0.1');
                socket.on('data', chunk => parser.push(chunk));
                socket.on('error', () => {});
                const closed = new Promise(resolve => socket.on('close', resolve));
                await new Promise(resolve => socket.on('connect', resolve));
                //  Present an address, then say nothing more.
                socket.write(buildCommandFrame(Commands.M_NUL, 'SYS stalls'));
                socket.write(buildCommandFrame(Commands.M_ADR, '1:218/701@testnet'));

                const until = Date.now() + 3000;
                while (
                    !(await fsp.access(bsyPath).then(
                        () => true,
                        () => false
                    ))
                ) {
                    assert.ok(Date.now() < until, 'the session took its lock');
                    await new Promise(r => setTimeout(r, 10));
                }

                const started = Date.now();
                stopped = true;
                await stop();
                assert.ok(Date.now() - started < 4500, 'within the shutdown cap');
                await closed;
                assert.ok(received.includes(Commands.M_BSY), 'remote told M_BSY');
                await assert.rejects(fsp.access(bsyPath), { code: 'ENOENT' });
                assert.equal(bsoLock.heldCount(), 0, 'no lock held');
            } finally {
                socket && socket.destroy();
                if (!stopped) {
                    await stop();
                }
            }
        });

        //  Port 0 used to read as unset and listen on the default 24554.
        it('inbound.port 0 listens on a free port, not the default', async () => {
            const { port, stop } = await startModule({
                inbound: { enabled: true, port: 0, address: '127.0.0.1' },
            });
            try {
                assert.ok(port > 0, 'bound to a real port');
                assert.notEqual(port, 24554, 'not the default port');
            } finally {
                await stop();
            }
        });

        //  A listen that fails only emits 'error'; startup used to wait on
        //  the listen callback, which then never comes.
        it('startup fails, rather than waiting for good, when the inbound port is taken', async () => {
            const squatter = net.createServer();
            await new Promise(resolve => squatter.listen(0, '127.0.0.1', resolve));
            try {
                const port = squatter.address().port;
                await assert.rejects(
                    startModule({
                        inbound: { enabled: true, port, address: '127.0.0.1' },
                    }),
                    { code: 'EADDRINUSE' }
                );
            } finally {
                await new Promise(resolve => squatter.close(resolve));
            }
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
                                        `Expected 1:218/700 in addresses: ${receivedAddrs.join(
                                            ', '
                                        )}`
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

        it('refuses a wrong password with M_ERR, then lets the node in with the right one', async () => {
            const { port, stop } = await startModule({
                inbound: { enabled: true, port: 0, address: '127.0.0.1' },
                nodes: { '1:218/701': { sessionPassword: 'testpw' } },
            });
            try {
                const bad = connectClient(port, {
                    addresses: ['1:218/701@testnet'],
                    getPassword: () => 'not-testpw',
                });
                let authenticated = false;
                bad.session.on('authenticated', () => {
                    authenticated = true;
                });
                const err = await new Promise(resolve => {
                    bad.session.on('error', resolve);
                    bad.session.on('session-end', () => resolve(null));
                    bad.session.start();
                });
                assert.ok(err, 'the session ends in an error');
                assert.match(err.message, /Bad password/);
                assert.ok(!authenticated);

                //  The refused session must not leave the node locked: a
                //  stale lock would answer the next call with M_BSY. The
                //  caller hears M_ERR before the server's unlink lands, so
                //  give that a moment.
                await new Promise(r => setTimeout(r, 100));
                const good = connectClient(port, {
                    addresses: ['1:218/701@testnet'],
                    getPassword: () => 'testpw',
                });
                let secure = null;
                good.session.on('authenticated', s => {
                    secure = s;
                });
                await new Promise((resolve, reject) => {
                    good.session.on('session-end', resolve);
                    good.session.on('error', reject);
                    good.session.on('busy', r => reject(new Error(`busy: ${r}`)));
                    good.session.start();
                });
                assert.equal(secure, true);
            } finally {
                await stop();
            }
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

    describe('BinkpModule — flow file locks', () => {
        const outDir = () => path.join(tmpDir, 'outbound');
        const exists = p =>
            fsp.access(p).then(
                () => true,
                () => false
            );

        async function waitFor(cond, ms = 2000) {
            const deadline = Date.now() + ms;
            while (!(await cond())) {
                if (Date.now() > deadline) return false;
                await new Promise(r => setTimeout(r, 20));
            }
            return true;
        }

        //  Two addresses for the caller, each with a packet queued:
        //  1:218/701 -> 00da02bd, 1:218/702 -> 00da02be.
        const TWO_AKAS = ['1:218/701@testnet', '1:218/702@testnet'];

        async function queueForBoth() {
            await fsp.mkdir(outDir(), { recursive: true });
            const q = {};
            for (const [key, base] of [
                ['first', '00da02bd'],
                ['second', '00da02be'],
            ]) {
                const pkt = path.join(outDir(), `${key}.pkt`);
                const flow = path.join(outDir(), `${base}.flo`);
                await fsp.writeFile(pkt, key.toUpperCase());
                await fsp.writeFile(flow, `^${pkt}\n`);
                q[key] = { pkt, flow, bsy: path.join(outDir(), `${base}.bsy`) };
            }
            return q;
        }

        //  Run one session from a client presenting |addresses|. Resolves
        //  { received, busy, ended } once it is over, however it ended.
        function runClient(port, { addresses = TWO_AKAS, getPassword } = {}) {
            const { session } = connectClient(port, { addresses, getPassword });
            const result = { received: [], busy: null, ended: null };
            session.on('file-received', (name, size, ts, tmp) => {
                result.received.push(name);
                fsp.unlink(tmp).catch(() => {});
            });
            session.on('busy', reason => (result.busy = reason));
            return new Promise(resolve => {
                const end = how => {
                    if (!result.ended) {
                        result.ended = how;
                        resolve(result);
                    }
                };
                session.on('session-end', () => end('session-end'));
                session.on('disconnect', () => end('disconnect'));
                session.on('error', () => end('error'));
                session.start();
            });
        }

        //  Count spool reads, to show nothing was read for any address.
        function countReads() {
            const original = BsoSpool.prototype.getOutboundFilesForNode;
            const counter = { reads: 0 };
            BsoSpool.prototype.getOutboundFilesForNode = function (...args) {
                ++counter.reads;
                return original.apply(this, args);
            };
            counter.restore = () => {
                BsoSpool.prototype.getOutboundFilesForNode = original;
            };
            return counter;
        }

        it('drops a busy address with no password and serves the others', async () => {
            const q = await queueForBoth();
            await fsp.writeFile(q.second.bsy, '4242'); //  another process
            const { port, stop } = await startModule();
            try {
                const result = await runClient(port);
                assert.equal(result.busy, null, 'the session goes ahead');
                assert.deepEqual(result.received, ['first.pkt']);

                //  The busy address: flow file and packet untouched, its
                //  lock still the other process's.
                assert.equal(
                    await fsp.readFile(q.second.flow, 'utf8'),
                    `^${q.second.pkt}\n`
                );
                assert.ok(await exists(q.second.pkt));
                assert.equal(await fsp.readFile(q.second.bsy, 'utf8'), '4242');

                //  The free one: delivered, marked, its lock released.
                assert.ok(await waitFor(async () => !(await exists(q.first.flow))));
                assert.ok(await waitFor(async () => !(await exists(q.first.bsy))));
            } finally {
                await stop();
                await fsp.rm(outDir(), { recursive: true, force: true });
            }
        });

        it('makes the whole session busy when a busy address has a password (as binkd does)', async () => {
            const q = await queueForBoth();
            await fsp.writeFile(q.second.bsy, '4242');
            const reads = countReads();
            const { port, stop } = await startModule({
                nodes: { '1:218/702': { sessionPassword: 'pw' } },
            });
            try {
                const result = await runClient(port, { getPassword: () => 'pw' });
                assert.equal(result.busy, 'Secure AKA 1:218/702@testnet busy');
                assert.deepEqual(result.received, []);
                assert.equal(reads.reads, 0, 'nothing read for any address');

                for (const key of ['first', 'second']) {
                    assert.equal(
                        await fsp.readFile(q[key].flow, 'utf8'),
                        `^${q[key].pkt}\n`
                    );
                    assert.ok(await exists(q[key].pkt));
                }
                //  The first address's lock was taken and given back.
                assert.ok(await waitFor(async () => !(await exists(q.first.bsy))));
                assert.equal(await fsp.readFile(q.second.bsy, 'utf8'), '4242');
            } finally {
                reads.restore();
                await stop();
                await fsp.rm(outDir(), { recursive: true, force: true });
            }
        });

        it('sends M_BSY when every presented address is busy', async () => {
            const q = await queueForBoth();
            await fsp.writeFile(q.first.bsy, '4242');
            await fsp.writeFile(q.second.bsy, '4343');
            const reads = countReads();
            const { port, stop } = await startModule();
            try {
                const result = await runClient(port);
                assert.equal(result.busy, 'All AKAs are busy');
                assert.deepEqual(result.received, []);
                assert.equal(reads.reads, 0);
                assert.equal(await fsp.readFile(q.first.bsy, 'utf8'), '4242');
                assert.equal(await fsp.readFile(q.second.bsy, 'utf8'), '4343');
            } finally {
                reads.restore();
                await stop();
                await fsp.rm(outDir(), { recursive: true, force: true });
            }
        });

        it('releases every lock when the password is refused', async () => {
            const q = await queueForBoth();
            const { port, stop } = await startModule({
                nodes: { '1:218/702': { sessionPassword: 'pw' } },
            });
            try {
                const result = await runClient(port, { getPassword: () => 'wrong' });
                assert.deepEqual(result.received, []);
                assert.ok(await waitFor(async () => !(await exists(q.first.bsy))));
                assert.ok(await waitFor(async () => !(await exists(q.second.bsy))));
                assert.equal(
                    await fsp.readFile(q.first.flow, 'utf8'),
                    `^${q.first.pkt}\n`
                );
            } finally {
                await stop();
                await fsp.rm(outDir(), { recursive: true, force: true });
            }
        });

        it('releases every lock when the caller drops the connection mid-handshake', async () => {
            const q = await queueForBoth();
            const { port, stop } = await startModule();
            try {
                //  M_ADR, then gone before M_PWD.
                const { buildCommandFrame } = require('../core/binkp/frame.js');
                const { Commands } = require('../core/binkp/commands.js');
                const socket = net.createConnection(port, '127.0.0.1');
                await new Promise(r => socket.once('connect', r));
                socket.write(buildCommandFrame(Commands.M_ADR, TWO_AKAS.join(' ')));
                assert.ok(
                    await waitFor(async () => await exists(q.second.bsy)),
                    'both addresses locked at M_ADR'
                );
                assert.ok(await exists(q.first.bsy));
                socket.destroy();

                assert.ok(await waitFor(async () => !(await exists(q.first.bsy))));
                assert.ok(await waitFor(async () => !(await exists(q.second.bsy))));
            } finally {
                await stop();
                await fsp.rm(outDir(), { recursive: true, force: true });
            }
        });

        //  A raw caller: writes |frames| in one go and collects the server's
        //  commands until the connection closes or |ms| passes.
        async function rawExchange(port, frames, ms = 1500) {
            const {
                buildCommandFrame,
                buildDataFrame,
                FrameParser,
            } = require('../core/binkp/frame.js');
            const { CommandNames } = require('../core/binkp/commands.js');
            const socket = net.createConnection(port, '127.0.0.1');
            await new Promise(r => socket.once('connect', r));
            const parser = new FrameParser();
            const seen = [];
            parser.on('frame', f => {
                if ('command' === f.type) seen.push(`${CommandNames[f.cmd]} ${f.arg}`);
            });
            socket.on('data', c => parser.push(c));
            socket.on('error', () => {});
            //  A frame is [command, argument], or { data } for a data frame.
            socket.write(
                Buffer.concat(
                    frames.map(f =>
                        Array.isArray(f)
                            ? buildCommandFrame(f[0], f[1])
                            : buildDataFrame(f.data)
                    )
                )
            );
            await new Promise(resolve => {
                const t = setTimeout(resolve, ms);
                socket.once('close', () => {
                    clearTimeout(t);
                    resolve();
                });
            });
            socket.destroy();
            return seen;
        }

        describe('M_BSY goes before any M_OK (M_ADR and M_PWD in one write)', () => {
            const { Commands } = require('../core/binkp/commands.js');
            const frames = pwd => [
                [Commands.M_ADR, TWO_AKAS.join(' ')],
                [Commands.M_PWD, pwd],
            ];
            const okIndex = seen => seen.findIndex(f => f.startsWith('M_OK'));
            const bsyIndex = seen => seen.findIndex(f => f.startsWith('M_BSY'));

            afterEach(() => fsp.rm(outDir(), { recursive: true, force: true }));

            it('a busy secure address: M_BSY, no M_OK', async () => {
                const q = await queueForBoth();
                await fsp.writeFile(q.second.bsy, '4242');
                const { port, stop } = await startModule({
                    nodes: { '1:218/702': { sessionPassword: 'pw' } },
                });
                try {
                    const seen = await rawExchange(port, frames('pw'));
                    assert.ok(bsyIndex(seen) >= 0, seen.join(' | '));
                    assert.equal(okIndex(seen), -1, seen.join(' | '));
                } finally {
                    await stop();
                }
            });

            it('every address busy: M_BSY, no M_OK', async () => {
                const q = await queueForBoth();
                await fsp.writeFile(q.first.bsy, '4242');
                await fsp.writeFile(q.second.bsy, '4343');
                const { port, stop } = await startModule();
                try {
                    const seen = await rawExchange(port, frames('-'));
                    assert.ok(bsyIndex(seen) >= 0, seen.join(' | '));
                    assert.equal(okIndex(seen), -1, seen.join(' | '));
                } finally {
                    await stop();
                }
            });

            it('nothing busy: M_OK, no M_BSY', async () => {
                await queueForBoth();
                const { port, stop } = await startModule();
                try {
                    const seen = await rawExchange(port, frames('-'), 500);
                    assert.ok(okIndex(seen) >= 0, seen.join(' | '));
                    assert.equal(bsyIndex(seen), -1, seen.join(' | '));
                } finally {
                    await stop();
                }
            });
        });

        it('a caller dropping during the flow file listing: nothing read after the locks go', async () => {
            const q = await queueForBoth();
            const original = BsoSpool.prototype.getOutboundFilesForNode;
            let listingStarted;
            const started = new Promise(r => (listingStarted = r));
            let release;
            const gate = new Promise(r => (release = r));
            const heldWhenRead = [];
            BsoSpool.prototype.getOutboundFilesForNode = async function (addr, opts) {
                listingStarted();
                await gate;
                heldWhenRead.push(await exists(q.first.bsy));
                return original.call(this, addr, opts);
            };
            const { port, stop } = await startModule();
            try {
                const { session, socket } = connectClient(port, { addresses: TWO_AKAS });
                session.on('error', () => {});
                session.start();
                await started;
                socket.destroy();
                await new Promise(r => setTimeout(r, 100));
                assert.ok(await exists(q.first.bsy), 'not released while listing');
                release();
                assert.ok(await waitFor(async () => !(await exists(q.first.bsy))));
                assert.ok(heldWhenRead.every(Boolean), 'every read under the lock');
            } finally {
                release();
                BsoSpool.prototype.getOutboundFilesForNode = original;
                await stop();
                await fsp.rm(outDir(), { recursive: true, force: true });
            }
        });

        describe('frames a caller sends behind M_PWD without waiting for M_OK', () => {
            const { Commands } = require('../core/binkp/commands.js');
            const inbound = () => path.join(tmpDir, 'ftn_in');
            const pipelined = (pwd, name) => [
                [Commands.M_ADR, TWO_AKAS.join(' ')],
                [Commands.M_PWD, pwd],
                [Commands.M_FILE, `${name} 5 1700000000 0`],
                { data: Buffer.from('hello') },
                [Commands.M_EOB, ''],
            ];

            afterEach(async () => {
                await fsp.rm(outDir(), { recursive: true, force: true });
                for (const n of await fsp.readdir(inbound())) {
                    await fsp.rm(path.join(inbound(), n), { force: true });
                }
            });

            it('are handled once the password is answered, in order', async () => {
                await queueForBoth();
                const { port, stop } = await startModule();
                try {
                    const seen = await rawExchange(
                        port,
                        pipelined('-', 'pipelined.txt'),
                        800
                    );
                    assert.ok(
                        seen.some(f => f.startsWith('M_OK')),
                        seen.join(' | ')
                    );
                    assert.ok(
                        seen.includes('M_GOT pipelined.txt 5 1700000000'),
                        seen.join(' | ')
                    );
                    assert.ok(
                        await waitFor(async () =>
                            (await fsp.readdir(inbound())).includes('pipelined.txt')
                        )
                    );
                } finally {
                    await stop();
                }
            });

            it('are dropped when the session is busy: nothing received, nothing sent', async () => {
                const q = await queueForBoth();
                await fsp.writeFile(q.second.bsy, '4242');
                const { port, stop } = await startModule({
                    nodes: { '1:218/702': { sessionPassword: 'pw' } },
                });
                try {
                    const seen = await rawExchange(port, pipelined('pw', 'dropped.txt'));
                    assert.ok(
                        seen.some(f => f.startsWith('M_BSY')),
                        seen.join(' | ')
                    );
                    assert.ok(
                        !seen.some(f => /^M_(OK|GOT|FILE)/.test(f)),
                        seen.join(' | ')
                    );
                    await new Promise(r => setTimeout(r, 100));
                    assert.deepEqual(await fsp.readdir(inbound()), []);
                    assert.equal(
                        await fsp.readFile(q.first.flow, 'utf8'),
                        `^${q.first.pkt}\n`
                    );
                } finally {
                    await stop();
                }
            });
        });

        it('a second M_ADR cannot bring in an address that is busy and has a password', async () => {
            //  The first M_ADR presents 1:218/701 (no password); the second
            //  1:218/702, which has one and whose .bsy is held elsewhere. With
            //  702's password the session must not become a secure one for
            //  702: the addresses are those of the first M_ADR.
            const { Commands } = require('../core/binkp/commands.js');
            const q = await queueForBoth();
            await fsp.writeFile(q.second.bsy, '4242');
            const { port, stop } = await startModule({
                nodes: { '1:218/702': { sessionPassword: 'pw' } },
            });
            try {
                const seen = await rawExchange(
                    port,
                    [
                        [Commands.M_ADR, TWO_AKAS[0]],
                        [Commands.M_ADR, TWO_AKAS[1]],
                        [Commands.M_PWD, 'pw'],
                    ],
                    800
                );
                assert.ok(!seen.includes('M_OK secure'), seen.join(' | '));
                assert.ok(
                    !seen.some(f => f.startsWith('M_FILE second.pkt')),
                    seen.join(' | ')
                );
                assert.equal(
                    await fsp.readFile(q.second.flow, 'utf8'),
                    `^${q.second.pkt}\n`
                );
                assert.equal(await fsp.readFile(q.second.bsy, 'utf8'), '4242');
            } finally {
                await stop();
                await fsp.rm(outDir(), { recursive: true, force: true });
            }
        });

        it('a second M_ADR adds no locks, and dropping the line leaves none behind', async function () {
            this.timeout(20000);
            const { Commands } = require('../core/binkp/commands.js');
            await fsp.mkdir(outDir(), { recursive: true });
            const { port, stop } = await startModule();
            try {
                for (let i = 0; i < 8; i++) {
                    const many = Array.from(
                        { length: 40 },
                        (_, k) => `1:218/${1000 + k}@testnet`
                    );
                    const socket = net.createConnection(port, '127.0.0.1');
                    socket.on('error', () => {});
                    await new Promise(r => socket.once('connect', r));
                    socket.write(
                        Buffer.concat([
                            require('../core/binkp/frame.js').buildCommandFrame(
                                Commands.M_ADR,
                                many.join(' ')
                            ),
                            require('../core/binkp/frame.js').buildCommandFrame(
                                Commands.M_ADR,
                                '1:218/2000@testnet'
                            ),
                        ])
                    );
                    await new Promise(r => setTimeout(r, i % 5));
                    socket.destroy();

                    const bsy = async () =>
                        (await fsp.readdir(outDir())).filter(n => /\.bsy$/i.test(n));
                    assert.ok(
                        await waitFor(async () => 0 === (await bsy()).length, 3000),
                        `iteration ${i}: left ${(await bsy()).join(' ')}`
                    );
                }
            } finally {
                await stop();
                await fsp.rm(outDir(), { recursive: true, force: true });
            }
        });

        it('creates no directories for presented addresses, and locks at most MAX_PRESENTED_ADDRESSES', async function () {
            this.timeout(20000);
            const { MAX_PRESENTED_ADDRESSES } = require('../core/binkp/bso_spool.js');
            const { Commands } = require('../core/binkp/commands.js');
            await fsp.mkdir(outDir(), { recursive: true });
            const before = (await fsp.readdir(tmpDir)).sort();
            //  Zone 1 lands in the existing outbound/; every other zone would
            //  need an outbound.NNN that does not exist.
            const many = Array.from(
                { length: 1500 },
                (_, k) => `${1 + (k % 30)}:${k}/${k}${k % 7 ? `.${k % 7}` : ''}`
            );
            const { port, stop } = await startModule();
            try {
                const socket = net.createConnection(port, '127.0.0.1');
                socket.on('error', () => {});
                await new Promise(r => socket.once('connect', r));
                socket.write(
                    require('../core/binkp/frame.js').buildCommandFrame(
                        Commands.M_ADR,
                        many.join(' ').slice(0, 32000)
                    )
                );
                await new Promise(r => setTimeout(r, 1000));
                assert.deepEqual((await fsp.readdir(tmpDir)).sort(), before);
                const entries = await fsp.readdir(outDir());
                assert.equal(
                    entries.filter(n => !/\.bsy$/i.test(n)).length,
                    0,
                    'no point directories made'
                );
                assert.ok(entries.length <= MAX_PRESENTED_ADDRESSES, `${entries.length}`);
                socket.destroy();
                assert.ok(
                    await waitFor(async () => 0 === (await fsp.readdir(outDir())).length)
                );
            } finally {
                await stop();
                await fsp.rm(outDir(), { recursive: true, force: true });
            }
        });

        it('keeps the lock until marking what was sent has finished', async () => {
            await fsp.mkdir(outDir(), { recursive: true });
            const pkt = path.join(outDir(), 'settle.pkt');
            const flowPath = path.join(outDir(), '00da02bd.flo'); //  1:218/701
            const bsyPath = path.join(outDir(), '00da02bd.bsy');
            await fsp.writeFile(pkt, 'SETTLE');
            await fsp.writeFile(flowPath, `^${pkt}\n`);

            //  Pause the rewrite that marks the line sent. The module builds
            //  its own spool per connection, so this goes on the prototype.
            let release;
            const gate = new Promise(r => (release = r));
            let rewriteStarted = false;
            const original = BsoSpool.prototype._applyFlowDisposition;
            BsoSpool.prototype._applyFlowDisposition = async function (...args) {
                rewriteStarted = true;
                await gate;
                return original.apply(this, args);
            };

            const { port, stop } = await startModule();
            try {
                const { session } = connectClient(port);
                const received = [];
                session.on('file-received', (name, size, ts, tmp) => {
                    received.push(name);
                    fsp.unlink(tmp).catch(() => {});
                });
                const ended = new Promise((resolve, reject) => {
                    session.on('session-end', resolve);
                    session.on('error', reject);
                });
                session.start();
                await ended;

                assert.deepEqual(received, ['settle.pkt']);
                assert.ok(await waitFor(async () => rewriteStarted));
                await new Promise(r => setTimeout(r, 100));
                assert.ok(await exists(bsyPath), 'lock held while the rewrite runs');

                release();
                assert.ok(
                    await waitFor(async () => !(await exists(bsyPath))),
                    'lock released once the rewrite has landed'
                );
                assert.equal(await exists(flowPath), false, 'nothing left; removed');
            } finally {
                release();
                BsoSpool.prototype._applyFlowDisposition = original;
                await stop();
                await fsp.rm(outDir(), { recursive: true, force: true });
            }
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
                const { stop } = await startModule({
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
                const { stop } = await startModule({
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

    // ── configuration hot-reload ──────────────────────────────────────────────────
    //
    //  config.hjson is hot-reloadable. Anything a session or a poll reads must
    //  be resolved when that work happens, not captured at startup — otherwise
    //  the process stays pinned to boot-time config until it is restarted.
    //  What genuinely cannot work that way (the pull timer, the listener
    //  bindings) is reconciled on the ConfigChanged event instead.

    describe('BinkpModule — configuration hot-reload', () => {
        //  Push a second config over the one startModule() installed. Returns a
        //  restore fn; call it before the module's own stop().
        function reload(cfg, { emit = true } = {}) {
            const prev = configModule._pushTestConfig(cfg);
            if (emit) {
                Events.emit(Events.getSystemEvents().ConfigChanged);
            }
            return () => configModule._popTestConfig(prev);
        }

        //  Collect Log.warn calls. binkp.js holds a reference to the logger
        //  object from setup.js, so patching the method is enough.
        function captureWarnings() {
            const Log = require('../core/logger.js').log;
            const original = Log.warn;
            const captured = [];
            Log.warn = (obj, msg) => captured.push({ obj, msg });
            return {
                captured,
                restore: () => {
                    Log.warn = original;
                },
            };
        }

        it('advertises a local address added after startup', done => {
            startModule()
                .then(({ port, stop }) => {
                    //  testnet moves to a different node number mid-run
                    const changed = makeConfig();
                    changed.messageNetworks.ftn.networks.testnet.localAddress =
                        '1:218/777';
                    const restore = reload(changed);

                    const { session } = connectClient(port);
                    let receivedAddrs = [];
                    session.on('addresses', addrs => {
                        receivedAddrs = addrs;
                    });
                    const finish = err => {
                        restore();
                        stop()
                            .then(() => done(err))
                            .catch(done);
                    };
                    session.on('session-end', () => {
                        try {
                            assert.ok(
                                receivedAddrs.some(a => a.includes('1:218/777')),
                                `expected reloaded address 1:218/777 in: ${receivedAddrs.join(
                                    ', '
                                )}`
                            );
                            finish();
                        } catch (e) {
                            finish(e);
                        }
                    });
                    session.on('error', finish);
                    session.start();
                })
                .catch(done);
        });

        it('serves outbound mail from an outbound path set after startup', done => {
            //  The spool used to be built once at startup, so a reloaded
            //  paths.outbound was invisible to every inbound session.
            startModule()
                .then(async ({ port, stop }) => {
                    const newSpoolDir = await fsp.mkdtemp(
                        path.join(os.tmpdir(), 'enigma_reload_spool_')
                    );
                    const outDir = path.join(newSpoolDir, 'outbound');
                    await fsp.mkdir(outDir, { recursive: true });

                    //  Mail for the connecting client, 1:218/701 -> 00da02bd
                    const pkt = path.join(outDir, 'reloaded.pkt');
                    await fsp.writeFile(pkt, 'RELOADED');
                    await fsp.writeFile(path.join(outDir, '00da02bd.flo'), `^${pkt}\n`);

                    const changed = makeConfig();
                    changed.scannerTossers.ftn_bso.paths.outbound = newSpoolDir;
                    const restore = reload(changed);

                    const { session } = connectClient(port);
                    const received = [];
                    session.on('file-received', (name, size, ts, tmp) => {
                        received.push(name);
                        fsp.unlink(tmp).catch(() => {});
                    });

                    const finish = err => {
                        restore();
                        fsp.rm(newSpoolDir, { recursive: true, force: true })
                            .then(() => stop())
                            .then(() => done(err))
                            .catch(done);
                    };
                    session.on('session-end', () => {
                        try {
                            assert.deepEqual(
                                received,
                                ['reloaded.pkt'],
                                'file queued under the reloaded outbound path should be sent'
                            );
                            finish();
                        } catch (e) {
                            finish(e);
                        }
                    });
                    session.on('error', finish);
                    session.start();
                })
                .catch(done);
        });

        it('_pullAddresses reflects nodes added after startup', async () => {
            const { mod, stop } = await startModule({ nodes: {} });
            assert.deepEqual(mod._pullAddresses(), []);

            const restore = reload(
                makeConfig({
                    nodes: { '1:218/900': { host: 'example.com' } },
                })
            );
            try {
                assert.deepEqual(
                    mod._pullAddresses().map(a => a.toString('3D')),
                    ['1:218/900'],
                    'pull cycle should dial nodes added by a reload'
                );

                //  An explicit argument still wins, for callers evaluating a
                //  node set other than the configured one
                assert.deepEqual(mod._pullAddresses({ nodes: {} }), []);
            } finally {
                restore();
                await stop();
            }
        });

        it('rebuilds the pull timer when pullSchedule changes', async () => {
            const { mod, stop } = await startModule({
                pullSchedule: 'every 15 minutes',
            });
            const originalTimer = mod._pullTimer;
            assert.ok(originalTimer, 'pull timer should exist at startup');

            const restore = reload(makeConfig({ pullSchedule: 'every 30 minutes' }));
            try {
                assert.ok(mod._pullTimer, 'pull timer should still be running');
                assert.notEqual(
                    mod._pullTimer,
                    originalTimer,
                    'timer should be rebuilt, not left on the old schedule'
                );
                assert.equal(mod._pullSchedule, 'every 30 minutes');
            } finally {
                restore();
                await stop();
            }
        });

        it('stops the pull timer when pullSchedule is removed', async () => {
            const { mod, stop } = await startModule({
                pullSchedule: 'every 15 minutes',
            });
            assert.ok(mod._pullTimer);

            const restore = reload(makeConfig({ pullSchedule: null }));
            try {
                assert.equal(mod._pullTimer, null);
            } finally {
                restore();
                await stop();
            }
        });

        it('leaves the pull timer alone when pullSchedule is unchanged', async () => {
            const { mod, stop } = await startModule({
                pullSchedule: 'every 15 minutes',
            });
            const originalTimer = mod._pullTimer;

            const restore = reload(
                makeConfig({
                    pullSchedule: 'every 15 minutes',
                    crashmailDebounceMs: 999,
                })
            );
            try {
                assert.equal(mod._pullTimer, originalTimer);
            } finally {
                restore();
                await stop();
            }
        });

        it('warns that a restart is required when a listener binding changes', async () => {
            const { mod, stop } = await startModule();
            const warn = captureWarnings();

            const changed = makeConfig();
            changed.scannerTossers.ftn_bso.binkp.inbound.port = 24999;
            const restore = reload(changed);
            try {
                const restartWarnings = warn.captured.filter(w =>
                    /restart required/i.test(w.msg || '')
                );
                assert.equal(restartWarnings.length, 1);
                assert.deepEqual(restartWarnings[0].obj.changed, ['inbound.port']);
            } finally {
                warn.restore();
                restore();
                await stop();
            }
            assert.ok(mod);
        });

        it('does not warn when only hot-appliable settings change', async () => {
            const { stop } = await startModule();
            const warn = captureWarnings();

            const restore = reload(makeConfig({ crashmailDebounceMs: 999 }));
            try {
                assert.deepEqual(
                    warn.captured.filter(w => /restart required/i.test(w.msg || '')),
                    []
                );
            } finally {
                warn.restore();
                restore();
                await stop();
            }
        });

        it('removes its ConfigChanged listener on shutdown', async () => {
            const eventName = Events.getSystemEvents().ConfigChanged;
            const before = Events.listenerCount(eventName);

            const { mod, stop } = await startModule();
            assert.equal(Events.listenerCount(eventName), before + 1);

            await stop();
            assert.equal(Events.listenerCount(eventName), before);
            assert.equal(mod._configChangedListener, null);
        });
    });
}); // describe('BinkP server')
