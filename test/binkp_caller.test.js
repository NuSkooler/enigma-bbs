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
const { callNode, pollNodes } = require('../core/binkp/caller.js');
const Address = require('../core/ftn_address.js');

//  ── fixtures ─────────────────────────────────────────────────────────────────

let tmpDir;
let outboundDir;
let configPrev;

//  All describe blocks below sit inside this outer wrapper so the
//  before()/after() hooks are scoped to THIS file. At top level they would
//  be Mocha root hooks that wrap every test in every file — and other test
//  files install their own configModule.get during their own root hooks,
//  the LAST of which wins. Wrapping in a describe keeps the binkp_caller
//  config push effective for our own tests, regardless of file load order.
describe('BinkP caller', function () {
    before(async () => {
        tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'enigma_caller_test_'));
        outboundDir = path.join(tmpDir, 'outbound');
        await fsp.mkdir(outboundDir, { recursive: true });
        await fsp.mkdir(path.join(tmpDir, 'ftn_in'), { recursive: true });
        await fsp.mkdir(path.join(tmpDir, 'ftn_secin'), { recursive: true });
        configPrev = configModule._pushTestConfig(makeConfig());
    });

    after(async () => {
        configModule._popTestConfig(configPrev);
        await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    async function cleanOutbound() {
        const entries = await fsp.readdir(outboundDir).catch(() => []);
        await Promise.all(
            entries.map(e =>
                fsp.rm(path.join(outboundDir, e), { recursive: true, force: true })
            )
        );
    }

    function makeConfig(nodesCfg = {}) {
        return {
            debug: { assertsEnabled: false },
            scannerTossers: {
                ftn_bso: {
                    paths: {
                        outbound: tmpDir,
                        inbound: path.join(tmpDir, 'ftn_in'),
                        secInbound: path.join(tmpDir, 'ftn_secin'),
                    },
                    binkp: {
                        nodes: nodesCfg,
                    },
                },
            },
            messageNetworks: {
                ftn: {
                    networks: {
                        testnet: { localAddress: '1:218/700', defaultZone: 1 },
                    },
                },
            },
        };
    }

    function makeSpool() {
        return new BsoSpool({
            paths: {
                outbound: tmpDir,
                inbound: path.join(tmpDir, 'ftn_in'),
                secInbound: path.join(tmpDir, 'ftn_secin'),
            },
            networks: { testnet: { localAddress: '1:218/700', defaultZone: 1 } },
        });
    }

    // Start a minimal answering BinkP server; returns { port, stop }
    async function startAnsweringServer(opts = {}) {
        const spool = opts.spool || makeSpool();
        const server = net.createServer(async serverSocket => {
            const sess = new BinkpSession(serverSocket, {
                role: 'answering',
                addresses: opts.addresses || ['1:218/700@testnet'],
                getPassword: opts.getPassword || (() => null),
                tempDir: os.tmpdir(),
            });
            if (opts.onSession) opts.onSession(sess);
            await attachSpoolToSession(sess, spool, null);
            sess.start();
        });

        const port = await new Promise(resolve =>
            server.listen(0, '127.0.0.1', () => resolve(server.address().port))
        );

        return {
            port,
            spool,
            stop: () => new Promise(res => server.close(res)),
        };
    }

    // ── callNode ──────────────────────────────────────────────────────────────────

    describe('callNode', () => {
        beforeEach(cleanOutbound);

        it('completes a session with a live answering server', async () => {
            const { port, spool, stop } = await startAnsweringServer();
            try {
                const addr = new Address({ zone: 1, net: 218, node: 700 });
                const nodeConf = { host: '127.0.0.1', port };
                await callNode(addr, nodeConf, spool);
            } finally {
                await stop();
            }
        });

        it('acquires the BSY lock before connecting and releases it after', async () => {
            const { port, spool, stop } = await startAnsweringServer();
            try {
                const addr = new Address({ zone: 1, net: 218, node: 700 });
                const nodeConf = { host: '127.0.0.1', port };

                let lockHeldDuringSession = false;
                const origAcquire = spool.acquireLock.bind(spool);
                spool.acquireLock = async a => {
                    const result = await origAcquire(a);
                    lockHeldDuringSession = result;
                    return result;
                };

                await callNode(addr, nodeConf, spool);

                // Lock should be released now
                const canAcquireAgain = await spool.acquireLock(addr);
                assert.ok(canAcquireAgain, 'lock should be released after session');
                await spool.releaseLock(addr);
                assert.ok(
                    lockHeldDuringSession,
                    'lock should have been held during session'
                );
            } finally {
                await stop();
            }
        });

        it('skips (resolves without error) when the BSY lock is already held', async () => {
            const spool = makeSpool();
            const addr = new Address({ zone: 1, net: 218, node: 700 });
            await spool.acquireLock(addr);
            try {
                // Should return without throwing even though lock is held
                await callNode(addr, { host: '127.0.0.1', port: 9 }, spool);
            } finally {
                await spool.releaseLock(addr);
            }
        });

        it('rejects on connection refused', async () => {
            // Port 1 is almost certainly not listening
            const spool = makeSpool();
            const addr = new Address({ zone: 1, net: 218, node: 700 });
            const nodeConf = { host: '127.0.0.1', port: 1 };
            await assert.rejects(() => callNode(addr, nodeConf, spool), /ECONNREFUSED/);
        });

        it('releases the BSY lock even when the session errors', async () => {
            // Port 1 will cause connection refused → callNode rejects but lock must be freed
            const spool = makeSpool();
            const addr = new Address({ zone: 1, net: 218, node: 700 });
            await assert.rejects(() =>
                callNode(addr, { host: '127.0.0.1', port: 1 }, spool)
            );
            const canAcquire = await spool.acquireLock(addr);
            assert.ok(canAcquire, 'lock should be released after failed callNode');
            await spool.releaseLock(addr);
        });

        it('sends files from the outbound spool to the remote', async () => {
            const refFile = path.join(tmpDir, 'test_outbound.pkt');
            await fsp.writeFile(refFile, 'PKT_CONTENT');

            //  Server address must differ from the caller's localAddress
            //  (1:218/700, set in makeConfig) — otherwise the server's spool
            //  reads the same flow file the caller is sending and queues it
            //  for return delivery, the caller's delete-disposition unlinks
            //  the source mid-flight, and the server intermittently misses
            //  the inbound file. Same-zone keeps the outbound subdir at
            //  ".../outbound" (zone-1 = default) instead of "outbound.NNN".
            //
            //  net=1, node=2 → flow filename "00010002.flo".
            const flowPath = path.join(outboundDir, '00010002.flo');
            await fsp.writeFile(flowPath, `^${refFile}\n`);

            let serverReceivedFile = false;
            const { port, spool, stop } = await startAnsweringServer({
                addresses: ['1:1/2@testnet'],
                onSession: sess => {
                    sess.on('file-received', () => {
                        serverReceivedFile = true;
                    });
                },
            });
            try {
                const addr = new Address({ zone: 1, net: 1, node: 2 });
                const nodeConf = { host: '127.0.0.1', port };
                await callNode(addr, nodeConf, spool);
                assert.ok(serverReceivedFile, 'server should have received the file');
            } finally {
                await stop();
            }
        });

        it('emits NewInboundBSO when callNode receives files from the remote', async () => {
            // Use a separate spool dir for the server so its outbound is independent of the caller's.
            const srvDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'enigma_srv_recv_'));
            try {
                await fsp.mkdir(path.join(srvDir, 'outbound'), { recursive: true });
                await fsp.mkdir(path.join(srvDir, 'ftn_in'), { recursive: true });
                await fsp.mkdir(path.join(srvDir, 'ftn_secin'), { recursive: true });

                // Server (1:218/702) will send this file to the caller (1:218/700 → 00da02bc)
                const refFile = path.join(srvDir, 'srv_to_caller.pkt');
                await fsp.writeFile(refFile, 'SRV_DATA');
                await fsp.writeFile(
                    path.join(srvDir, 'outbound', '00da02bc.flo'),
                    `^${refFile}\n`
                );

                const serverSpool = new BsoSpool({
                    paths: {
                        outbound: srvDir,
                        inbound: path.join(srvDir, 'ftn_in'),
                        secInbound: path.join(srvDir, 'ftn_secin'),
                    },
                    networks: { testnet: { localAddress: '1:218/702', defaultZone: 1 } },
                });

                const { port, stop } = await startAnsweringServer({
                    addresses: ['1:218/702@testnet'],
                    spool: serverSpool,
                });

                try {
                    let gotEvent = false;
                    Events.once(Events.getSystemEvents().NewInboundBSO, () => {
                        gotEvent = true;
                    });

                    const addr = new Address({ zone: 1, net: 218, node: 700 });
                    await callNode(addr, { host: '127.0.0.1', port }, makeSpool());

                    assert.ok(
                        gotEvent,
                        'NewInboundBSO should be emitted after callNode receives files'
                    );
                } finally {
                    await stop();
                }
            } finally {
                await fsp.rm(srvDir, { recursive: true, force: true });
            }
        });
    });

    // ── pollNodes ─────────────────────────────────────────────────────────────────

    describe('pollNodes', () => {
        beforeEach(cleanOutbound);

        it('calls back immediately when spool is not configured', done => {
            const prev = configModule._pushTestConfig({
                debug: { assertsEnabled: false },
            });
            pollNodes([], err => {
                configModule._popTestConfig(prev);
                done(err);
            });
        });

        it('calls back without error when there is no pending mail', done => {
            const prev = configModule._pushTestConfig(makeConfig());
            pollNodes([], err => {
                configModule._popTestConfig(prev);
                done(err);
            });
        });

        it('skips nodes that have no host configured', done => {
            const prev = configModule._pushTestConfig(
                makeConfig({
                    // node entry exists but no host
                    '1:218/700': { sessionPassword: 'pw' },
                })
            );

            // Put a pending flow file for 1:218/700 in the spool
            const flowPath = path.join(outboundDir, '00da02bc.flo');
            fsp.writeFile(flowPath, '/nonexistent/file.pkt\n')
                .then(() => {
                    pollNodes([], err => {
                        configModule._popTestConfig(prev);
                        done(err);
                    });
                })
                .catch(done);
        });

        it('calls a node that has pending mail and a configured host', done => {
            let sessionCompleted = false;

            startAnsweringServer()
                .then(async ({ port, stop }) => {
                    const refFile = path.join(tmpDir, 'poll_test.pkt');
                    await fsp.writeFile(refFile, 'POLL_DATA');
                    const flowPath = path.join(outboundDir, '00da02bc.flo');
                    await fsp.writeFile(flowPath, `^${refFile}\n`);

                    const cfg = makeConfig({
                        '1:218/700': { host: '127.0.0.1', port },
                    });
                    const prev = configModule._pushTestConfig(cfg);

                    pollNodes([], async err => {
                        await stop();
                        configModule._popTestConfig(prev);
                        done(err);
                    });
                })
                .catch(done);
        });

        it('continues polling remaining nodes after one call fails', done => {
            // Node 1:218/700 has no server (connection refused)
            // Node 1:218/701 has a live server — pollNodes should still reach it

            startAnsweringServer({ addresses: ['1:218/701@testnet'] })
                .then(async ({ port: goodPort, stop }) => {
                    // Pending mail for both nodes
                    const file1 = path.join(tmpDir, 'poll_fail.pkt');
                    const file2 = path.join(tmpDir, 'poll_ok.pkt');
                    await fsp.writeFile(file1, 'DATA1');
                    await fsp.writeFile(file2, 'DATA2');
                    // 1:218/700 → net=218=0x00da, node=700=0x02bc → 00da02bc
                    await fsp.writeFile(
                        path.join(outboundDir, '00da02bc.flo'),
                        `^${file1}\n`
                    );
                    // 1:218/701 → node=701=0x02bd → 00da02bd
                    await fsp.writeFile(
                        path.join(outboundDir, '00da02bd.flo'),
                        `^${file2}\n`
                    );

                    const cfg = makeConfig({
                        '1:218/700': { host: '127.0.0.1', port: 1 }, // will fail (ECONNREFUSED)
                        '1:218/701': { host: '127.0.0.1', port: goodPort },
                    });
                    const prev = configModule._pushTestConfig(cfg);

                    pollNodes([], async err => {
                        await stop();
                        configModule._popTestConfig(prev);
                        // pollNodes itself should not propagate the per-node error
                        done(err);
                    });
                })
                .catch(done);
        });

        //  ── forceAddrs (force-poll) ──────────────────────────────────────────
        //
        //  pollNodes(forceAddrs, cb) dials each address in forceAddrs even when
        //  the spool has no pending mail for it. This is the mechanism that
        //  drives the periodic pull cycle (echo-mail fetch from quiet hubs)
        //  and crashmail dispatch (immediate dial when ftn_bso queues outbound).

        it('forceAddrs: dials a node with no pending mail', done => {
            startAnsweringServer({ addresses: ['1:218/701@testnet'] })
                .then(async ({ port, stop }) => {
                    // No flow file, no direct-attach — spool has nothing pending
                    const cfg = makeConfig({
                        '1:218/701': { host: '127.0.0.1', port },
                    });
                    const prev = configModule._pushTestConfig(cfg);
                    const target = new Address({ zone: 1, net: 218, node: 701 });

                    pollNodes([target], async err => {
                        await stop();
                        configModule._popTestConfig(prev);
                        done(err);
                    });
                })
                .catch(done);
        });

        it('forceAddrs: accepts plain address strings', done => {
            startAnsweringServer({ addresses: ['1:218/702@testnet'] })
                .then(async ({ port, stop }) => {
                    const cfg = makeConfig({
                        '1:218/702': { host: '127.0.0.1', port },
                    });
                    const prev = configModule._pushTestConfig(cfg);

                    pollNodes(['1:218/702'], async err => {
                        await stop();
                        configModule._popTestConfig(prev);
                        done(err);
                    });
                })
                .catch(done);
        });

        it('forceAddrs: ignores invalid address strings', done => {
            const cfg = makeConfig();
            const prev = configModule._pushTestConfig(cfg);
            // Garbage string — must not throw; pollNodes should silently skip it.
            pollNodes(['not-an-address', '', null, undefined], err => {
                configModule._popTestConfig(prev);
                done(err);
            });
        });

        it('forceAddrs: dedupes against pending (one session per node)', done => {
            let connectionCount = 0;
            startAnsweringServer({
                addresses: ['1:218/703@testnet'],
                onSession: () => {
                    connectionCount += 1;
                },
            })
                .then(async ({ port, stop }) => {
                    // Pending mail for 1:218/703
                    const refFile = path.join(tmpDir, 'force_dedupe.pkt');
                    await fsp.writeFile(refFile, 'DATA');
                    // 1:218/703 → node=703=0x02bf → 00da02bf
                    await fsp.writeFile(
                        path.join(outboundDir, '00da02bf.flo'),
                        `^${refFile}\n`
                    );

                    const cfg = makeConfig({
                        '1:218/703': { host: '127.0.0.1', port },
                    });
                    const prev = configModule._pushTestConfig(cfg);

                    //  Same node passed via forceAddrs AND present in pending.
                    //  Must dial exactly once.
                    const target = new Address({ zone: 1, net: 218, node: 703 });
                    pollNodes([target, '1:218/703'], async err => {
                        await stop();
                        configModule._popTestConfig(prev);
                        if (err) return done(err);
                        assert.equal(
                            connectionCount,
                            1,
                            'expected exactly one session for the deduped node'
                        );
                        done();
                    });
                })
                .catch(done);
        });
    });
}); // describe('BinkP caller')
