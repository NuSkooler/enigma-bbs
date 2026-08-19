'use strict';

const { strict: assert } = require('assert');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const configModule = require('../core/config.js');
const Events = require('../core/events.js');

// ── fixtures ──────────────────────────────────────────────────────────────────

let tmpDir;

//  Wrapping describe — see binkp_caller.test.js for the rationale.
//  Top-level before/after in mocha are root hooks; wrapping scopes them
//  to this file's tests so cross-file state doesn't leak.
describe('ftn_bso ↔ BinkP integration', function () {
    before(async () => {
        tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'enigma_ftnbso_int_'));
        await fsp.mkdir(path.join(tmpDir, 'outbound'), { recursive: true });
        await fsp.mkdir(path.join(tmpDir, 'ftn_in'), { recursive: true });
        await fsp.mkdir(path.join(tmpDir, 'ftn_secin'), { recursive: true });
    });

    after(async () => {
        await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    function makeConfig() {
        return {
            debug: { assertsEnabled: false },
            scannerTossers: {
                ftn_bso: {
                    paths: {
                        outbound: tmpDir,
                        inbound: path.join(tmpDir, 'ftn_in'),
                        secInbound: path.join(tmpDir, 'ftn_secin'),
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

    // ── ftn_bso ↔ NewInboundBSO event ────────────────────────────────────────────

    describe('ftn_bso — NewInboundBSO integration', () => {
        it('calls performImport when NewInboundBSO is emitted after startup', done => {
            const prev = configModule._pushTestConfig(makeConfig());

            const { getModule } = require('../core/scanner_tossers/ftn_bso.js');
            const mod = new getModule();

            // Replace performImport so we can detect the call without doing real I/O
            let importCalled = false;
            mod.performImport = cb => {
                importCalled = true;
                if (cb) cb(null);
            };

            mod.startup(err => {
                if (err) {
                    configModule._popTestConfig(prev);
                    return done(err);
                }

                Events.emit(Events.getSystemEvents().NewInboundBSO);

                // The import is triggered synchronously inside the event handler;
                // give one tick for the callback chain to settle.
                setImmediate(() => {
                    mod.shutdown(() => {
                        configModule._popTestConfig(prev);
                        try {
                            assert.ok(
                                importCalled,
                                'performImport should be called on NewInboundBSO'
                            );
                            done();
                        } catch (e) {
                            done(e);
                        }
                    });
                });
            });
        });

        it('does not call performImport concurrently when NewInboundBSO fires twice rapidly', done => {
            const prev = configModule._pushTestConfig(makeConfig());

            const { getModule } = require('../core/scanner_tossers/ftn_bso.js');
            const mod = new getModule();

            let importCallCount = 0;
            let importResolve;
            mod.performImport = cb => {
                importCallCount++;
                // Hold the first import open until we explicitly resolve it
                importResolve = cb;
            };

            mod.startup(err => {
                if (err) {
                    configModule._popTestConfig(prev);
                    return done(err);
                }

                // First event starts an import (held open)
                Events.emit(Events.getSystemEvents().NewInboundBSO);
                // Second event while first is still running — should be skipped
                Events.emit(Events.getSystemEvents().NewInboundBSO);

                setImmediate(() => {
                    // Complete the first import
                    if (importResolve) importResolve(null);

                    setImmediate(() => {
                        mod.shutdown(() => {
                            configModule._popTestConfig(prev);
                            try {
                                assert.equal(
                                    importCallCount,
                                    1,
                                    'concurrent import should be suppressed'
                                );
                                done();
                            } catch (e) {
                                done(e);
                            }
                        });
                    });
                });
            });
        });

        it('does not have a NewInboundBSO listener after shutdown', done => {
            const prev = configModule._pushTestConfig(makeConfig());

            const { getModule } = require('../core/scanner_tossers/ftn_bso.js');
            const mod = new getModule();
            mod.performImport = cb => {
                if (cb) cb(null);
            };

            const countBefore = Events.listenerCount(
                Events.getSystemEvents().NewInboundBSO
            );

            mod.startup(err => {
                if (err) {
                    configModule._popTestConfig(prev);
                    return done(err);
                }

                const countDuring = Events.listenerCount(
                    Events.getSystemEvents().NewInboundBSO
                );

                mod.shutdown(() => {
                    configModule._popTestConfig(prev);
                    const countAfter = Events.listenerCount(
                        Events.getSystemEvents().NewInboundBSO
                    );
                    try {
                        assert.equal(
                            countDuring,
                            countBefore + 1,
                            'one listener added on startup'
                        );
                        assert.equal(
                            countAfter,
                            countBefore,
                            'listener removed on shutdown'
                        );
                        done();
                    } catch (e) {
                        done(e);
                    }
                });
            });
        });
    });

    // ── Outbound path compatibility ───────────────────────────────────────────────
    //
    //  Verify that the flow-file paths ftn_bso writes are identical to the paths
    //  BsoSpool.getOutboundFilesForNode() reads, so neither side needs to know about
    //  the other's naming logic.
    //

    describe('ftn_bso ↔ BsoSpool outbound path compatibility', () => {
        it('ftn_bso flow file path matches BsoSpool lookup for a non-point address', async () => {
            const prev = configModule._pushTestConfig(makeConfig());
            try {
                const { getModule } = require('../core/scanner_tossers/ftn_bso.js');
                const { BsoSpool } = require('../core/binkp/bso_spool.js');
                const Address = require('../core/ftn_address.js');

                const mod = new getModule();
                const spool = new BsoSpool({
                    paths: {
                        outbound: tmpDir,
                        inbound: path.join(tmpDir, 'ftn_in'),
                        secInbound: path.join(tmpDir, 'ftn_secin'),
                    },
                    networks: { testnet: { localAddress: '1:218/700', defaultZone: 1 } },
                });

                // Simulate what ftn_bso does when exporting to 1:218/701
                const destAddr = { zone: 1, net: 218, node: 701 };
                const outDir = mod.getOutgoingEchoMailPacketDir('testnet', destAddr);
                await fsp.mkdir(outDir, { recursive: true });

                // ftn_bso builds the flow filename using the same net/node hex padding
                const netHex = `0000${destAddr.net.toString(16)}`.slice(-4);
                const nodeHex = `0000${destAddr.node.toString(16)}`.slice(-4);
                const flowFile = path.join(outDir, `${netHex}${nodeHex}.flo`);

                // Write a flow file referencing a real file
                const pktFile = path.join(outDir, 'test.pkt');
                await fsp.writeFile(pktFile, 'TEST');
                await fsp.writeFile(flowFile, `^${pktFile}\n`);

                // BsoSpool should find the same file
                const addr = new Address({ zone: 1, net: 218, node: 701 });
                const files = await spool.getOutboundFilesForNode(addr);

                assert.equal(
                    files.length,
                    1,
                    'BsoSpool should find the flow entry ftn_bso wrote'
                );
                assert.equal(path.basename(files[0].path), 'test.pkt');
            } finally {
                configModule._popTestConfig(prev);
            }
        });

        it('ftn_bso and BsoSpool agree on the zone-suffix outbound subdir for non-default zones', async () => {
            const prev = configModule._pushTestConfig(makeConfig());
            try {
                const { getModule } = require('../core/scanner_tossers/ftn_bso.js');
                const { BsoSpool } = require('../core/binkp/bso_spool.js');
                const Address = require('../core/ftn_address.js');

                const mod = new getModule();
                const spool = new BsoSpool({
                    paths: {
                        outbound: tmpDir,
                        inbound: path.join(tmpDir, 'ftn_in'),
                        secInbound: path.join(tmpDir, 'ftn_secin'),
                    },
                    networks: { testnet: { localAddress: '1:218/700', defaultZone: 1 } },
                });

                // Zone 2 address — should land in outbound.002/
                const destAddr = { zone: 2, net: 100, node: 5 };
                const outDir = mod.getOutgoingEchoMailPacketDir('testnet', destAddr);
                await fsp.mkdir(outDir, { recursive: true });

                // Verify both agree on the subdirectory name
                const expectedSubdir = path.join(tmpDir, 'outbound.002');
                assert.equal(
                    outDir,
                    expectedSubdir,
                    'ftn_bso subdir for zone 2 should be outbound.002'
                );

                // Write a flow file and verify BsoSpool finds it
                const netHex = `0000${destAddr.net.toString(16)}`.slice(-4);
                const nodeHex = `0000${destAddr.node.toString(16)}`.slice(-4);
                const pktFile = path.join(outDir, 'z2.pkt');
                await fsp.writeFile(pktFile, 'Z2');
                await fsp.writeFile(
                    path.join(outDir, `${netHex}${nodeHex}.flo`),
                    `^${pktFile}\n`
                );

                const addr = new Address({ zone: 2, net: 100, node: 5 });
                const files = await spool.getOutboundFilesForNode(addr);

                assert.equal(
                    files.length,
                    1,
                    'BsoSpool should find the zone-2 flow entry'
                );
            } finally {
                configModule._popTestConfig(prev);
            }
        });
    });

    // ── multi-network agreement (issue #719) ─────────────────────────────────────
    //
    //  ftn_bso (writer) and BsoSpool (reader) must resolve the same outbound
    //  directory for a given network/zone. They once carried separate
    //  implementations that only agreed when exactly one network was
    //  configured — which is all the two tests above exercise — so outbound
    //  mail for a multi-network system was written to one directory and looked
    //  for in another. These cases drive both sides through the layouts that
    //  used to diverge.

    describe('ftn_bso ↔ BsoSpool multi-network agreement', () => {
        const Address = require('../core/ftn_address.js');

        const THREE_NETWORKS = {
            fidonet: { localAddress: '1:103/705' },
            fsxnet: { localAddress: '21:1/121' },
            spooknet: { localAddress: '700:100/28' },
        };

        //  One uplink per network, in config order
        const UPLINKS = [
            { network: 'fidonet', addr: { zone: 1, net: 103, node: 705 } },
            { network: 'fsxnet', addr: { zone: 21, net: 1, node: 100 } },
            { network: 'spooknet', addr: { zone: 700, net: 100, node: 1 } },
        ];

        const ALL_PENDING = ['1:103/705', '21:1/100', '700:100/1'];

        let caseSeq = 0;

        const FTN_BSO_PATH = require.resolve('../core/scanner_tossers/ftn_bso.js');

        //  ftn_bso captures `Config` (the getter function itself) at require
        //  time, so a _pushTestConfig() after the module is cached has no
        //  effect on it — every case here needs a different config, so drop it
        //  from the require cache and let it re-capture.
        function requireFtnBso() {
            delete require.cache[FTN_BSO_PATH];
            return require('../core/scanner_tossers/ftn_bso.js');
        }

        //  ...and leave the cache empty so the next suite re-captures under
        //  its own config rather than the last one pushed here.
        after(() => {
            delete require.cache[FTN_BSO_PATH];
        });

        //  Each case gets its own outbound root so layouts can't bleed together.
        async function makeCase(networks, defaultNetwork) {
            const outbound = path.join(tmpDir, `multinet_${caseSeq++}`);
            await fsp.mkdir(outbound, { recursive: true });

            const paths_ = {
                outbound,
                inbound: path.join(tmpDir, 'ftn_in'),
                secInbound: path.join(tmpDir, 'ftn_secin'),
            };

            const prev = configModule._pushTestConfig({
                debug: { assertsEnabled: false },
                scannerTossers: { ftn_bso: { paths: paths_, defaultNetwork } },
                messageNetworks: { ftn: { networks } },
            });

            const { getModule } = requireFtnBso();
            const { BsoSpool } = require('../core/binkp/bso_spool.js');

            return {
                outbound,
                mod: new getModule(),
                spool: new BsoSpool({ paths: paths_, networks, defaultNetwork }),
                restore: () => configModule._popTestConfig(prev),
            };
        }

        function flowBaseName(addr) {
            const net = `0000${addr.net.toString(16)}`.slice(-4);
            const node = `0000${addr.node.toString(16)}`.slice(-4);
            return `${net}${node}`;
        }

        //  Drop a .pkt plus a flow file referencing it into |dir|, exactly as
        //  ftn_bso's export path does.
        async function writeFlowInto(dir, addr, pktName) {
            await fsp.mkdir(dir, { recursive: true });
            const pkt = path.join(dir, pktName);
            await fsp.writeFile(pkt, 'PKT');
            await fsp.writeFile(path.join(dir, `${flowBaseName(addr)}.flo`), `^${pkt}\n`);
            return dir;
        }

        //  Export every uplink through the writer, then read it all back
        //  through the spool. Returns the writer's directory choice per
        //  network plus what the reader found.
        async function roundTrip(ctx, uplinks) {
            const writerDirs = {};
            for (const uplink of uplinks) {
                writerDirs[uplink.network] = path.basename(
                    await writeFlowInto(
                        ctx.mod.getOutgoingEchoMailPacketDir(uplink.network, uplink.addr),
                        uplink.addr,
                        `${uplink.network}.pkt`
                    )
                );
            }

            const pending = (await ctx.spool.getNodesWithPendingMail())
                .map(a => `${a.zone}:${a.net}/${a.node}`)
                .sort();

            const fileCounts = {};
            for (const uplink of uplinks) {
                fileCounts[uplink.network] = (
                    await ctx.spool.getOutboundFilesForNode(new Address(uplink.addr))
                ).length;
            }

            return { writerDirs, pending, fileCounts };
        }

        it('finds mail for every network when defaultNetwork is unset', async () => {
            const ctx = await makeCase(THREE_NETWORKS, undefined);
            try {
                const { writerDirs, pending, fileCounts } = await roundTrip(ctx, UPLINKS);

                assert.deepEqual(writerDirs, {
                    fidonet: 'outbound',
                    fsxnet: 'fsxnet',
                    spooknet: 'spooknet',
                });
                assert.deepEqual(
                    pending,
                    ALL_PENDING,
                    'first-listed network must not go missing'
                );
                assert.deepEqual(fileCounts, {
                    fidonet: 1,
                    fsxnet: 1,
                    spooknet: 1,
                });
            } finally {
                ctx.restore();
            }
        });

        it('does not mis-attribute zones when defaultNetwork is not first-listed', async () => {
            const ctx = await makeCase(THREE_NETWORKS, 'fsxnet');
            try {
                const { writerDirs, pending, fileCounts } = await roundTrip(ctx, UPLINKS);

                assert.deepEqual(writerDirs, {
                    fidonet: 'fidonet',
                    fsxnet: 'outbound',
                    spooknet: 'spooknet',
                });
                //  The reader used to read fsxnet's outbound/ with fidonet's
                //  zone, reporting a node that does not exist (1:1/100).
                assert.deepEqual(pending, ALL_PENDING);
                assert.deepEqual(fileCounts, {
                    fidonet: 1,
                    fsxnet: 1,
                    spooknet: 1,
                });
            } finally {
                ctx.restore();
            }
        });

        it('keeps working when defaultNetwork names the first-listed network', async () => {
            const ctx = await makeCase(THREE_NETWORKS, 'fidonet');
            try {
                const { writerDirs, pending } = await roundTrip(ctx, UPLINKS);
                assert.equal(writerDirs.fidonet, 'outbound');
                assert.deepEqual(pending, ALL_PENDING);
            } finally {
                ctx.restore();
            }
        });

        it('falls back to the first-listed network when defaultNetwork is unknown', async () => {
            const ctx = await makeCase(THREE_NETWORKS, 'nosuchnet');
            try {
                const { writerDirs, pending } = await roundTrip(ctx, UPLINKS);
                assert.equal(writerDirs.fidonet, 'outbound');
                assert.deepEqual(pending, ALL_PENDING);
            } finally {
                ctx.restore();
            }
        });

        it('gives every network its own subdir when defaultNetwork is disabled', async () => {
            const ctx = await makeCase(THREE_NETWORKS, null);
            try {
                const { writerDirs, pending, fileCounts } = await roundTrip(ctx, UPLINKS);

                assert.deepEqual(writerDirs, {
                    fidonet: 'fidonet',
                    fsxnet: 'fsxnet',
                    spooknet: 'spooknet',
                });
                assert.deepEqual(pending, ALL_PENDING);
                assert.deepEqual(fileCounts, {
                    fidonet: 1,
                    fsxnet: 1,
                    spooknet: 1,
                });
            } finally {
                ctx.restore();
            }
        });

        it('agrees on a mixed-case network key', async () => {
            const ctx = await makeCase(
                { fsxNet: { localAddress: '21:1/121' } },
                undefined
            );
            try {
                const uplink = {
                    network: 'fsxNet',
                    addr: { zone: 21, net: 1, node: 100 },
                };
                const { writerDirs, pending, fileCounts } = await roundTrip(ctx, [
                    uplink,
                ]);

                assert.equal(writerDirs.fsxNet, 'outbound');
                assert.deepEqual(pending, ['21:1/100']);
                assert.equal(fileCounts.fsxNet, 1);
            } finally {
                ctx.restore();
            }
        });

        it('agrees on zone-suffixed subdirs across networks', async () => {
            const ctx = await makeCase(THREE_NETWORKS, undefined);
            try {
                const uplinks = [
                    //  zone 15 is not fidonet's (default network) default zone
                    { network: 'fidonet', addr: { zone: 15, net: 2, node: 3 } },
                    //  ...nor fsxnet's
                    { network: 'fsxnet', addr: { zone: 15, net: 4, node: 5 } },
                ];
                const { writerDirs, pending, fileCounts } = await roundTrip(ctx, uplinks);

                assert.deepEqual(writerDirs, {
                    fidonet: 'outbound.00f',
                    fsxnet: 'fsxnet.00f',
                });
                assert.deepEqual(pending, ['15:2/3', '15:4/5'].sort());
                assert.deepEqual(fileCounts, { fidonet: 1, fsxnet: 1 });
            } finally {
                ctx.restore();
            }
        });

        it('still ships mail queued under the pre-0.5.1-beta layout', async () => {
            const ctx = await makeCase(THREE_NETWORKS, undefined);
            try {
                const uplink = UPLINKS[0]; //  fidonet — the default network

                //  What the old writer produced: the default network's mail in
                //  a directory named after the network rather than outbound/.
                const legacyDir = path.join(ctx.outbound, 'fidonet');
                await writeFlowInto(legacyDir, uplink.addr, 'legacy.pkt');

                assert.equal(
                    ctx.mod.getOutgoingEchoMailPacketDir(uplink.network, uplink.addr),
                    path.join(ctx.outbound, 'outbound'),
                    'new mail belongs in outbound/'
                );

                const pending = (await ctx.spool.getNodesWithPendingMail()).map(
                    a => `${a.zone}:${a.net}/${a.node}`
                );
                assert.deepEqual(pending, ['1:103/705']);

                const files = await ctx.spool.getOutboundFilesForNode(
                    new Address(uplink.addr)
                );
                assert.equal(files.length, 1);
                assert.equal(path.basename(files[0].path), 'legacy.pkt');
            } finally {
                ctx.restore();
            }
        });

        it('reports a node once when both the current and legacy layouts hold mail', async () => {
            const ctx = await makeCase(THREE_NETWORKS, undefined);
            try {
                const uplink = UPLINKS[0];

                await writeFlowInto(
                    path.join(ctx.outbound, 'fidonet'),
                    uplink.addr,
                    'legacy.pkt'
                );
                await writeFlowInto(
                    ctx.mod.getOutgoingEchoMailPacketDir(uplink.network, uplink.addr),
                    uplink.addr,
                    'current.pkt'
                );

                const pending = await ctx.spool.getNodesWithPendingMail();
                assert.equal(pending.length, 1, 'node must not be reported twice');

                //  ...but both files still ship
                const files = await ctx.spool.getOutboundFilesForNode(
                    new Address(uplink.addr)
                );
                assert.deepEqual(files.map(f => path.basename(f.path)).sort(), [
                    'current.pkt',
                    'legacy.pkt',
                ]);
            } finally {
                ctx.restore();
            }
        });
    });

    // ── ftn_bso ↔ NewOutboundBSO event ───────────────────────────────────────────
    //
    //  ftn_bso emits NewOutboundBSO each time flowFileAppendRefs successfully
    //  appends to a flow file, so the native BinkP module can dispatch a
    //  crashmail dial within hundreds of milliseconds rather than waiting for
    //  the periodic pull cycle.

    describe('ftn_bso — NewOutboundBSO emit (crashmail trigger)', () => {
        let received;
        let listener;
        const eventName = Events.getSystemEvents().NewOutboundBSO;

        beforeEach(() => {
            received = [];
            listener = payload => received.push(payload);
            Events.addListener(eventName, listener);
        });

        afterEach(() => {
            Events.removeListener(eventName, listener);
        });

        it('emits with { address } when flowFileAppendRefs succeeds', done => {
            const prev = configModule._pushTestConfig(makeConfig());
            const { getModule } = require('../core/scanner_tossers/ftn_bso.js');
            const Address = require('../core/ftn_address.js');
            const mod = new getModule();

            const flowPath = path.join(tmpDir, 'outbound', 'emit_test.flo');
            const refPath = path.join(tmpDir, 'outbound', 'emit_test.pkt');
            // The referenced file doesn't need to exist for the append to succeed
            const destAddr = new Address({ zone: 1, net: 218, node: 750 });

            mod.flowFileAppendRefs(flowPath, [refPath], '^', destAddr, err => {
                configModule._popTestConfig(prev);
                if (err) return done(err);
                assert.equal(received.length, 1, 'expected exactly one event');
                assert.equal(received[0].address, destAddr, 'payload.address');
                done();
            });
        });

        it('does NOT emit when destAddress is omitted (legacy / no-emit path)', done => {
            const prev = configModule._pushTestConfig(makeConfig());
            const { getModule } = require('../core/scanner_tossers/ftn_bso.js');
            const mod = new getModule();

            const flowPath = path.join(tmpDir, 'outbound', 'no_emit.flo');
            const refPath = path.join(tmpDir, 'outbound', 'no_emit.pkt');

            mod.flowFileAppendRefs(flowPath, [refPath], '^', null, err => {
                configModule._popTestConfig(prev);
                if (err) return done(err);
                assert.equal(
                    received.length,
                    0,
                    'must not emit when destAddress is null'
                );
                done();
            });
        });

        it('does NOT emit when the underlying append fails', done => {
            const prev = configModule._pushTestConfig(makeConfig());
            const { getModule } = require('../core/scanner_tossers/ftn_bso.js');
            const Address = require('../core/ftn_address.js');
            const mod = new getModule();

            //  Path under a regular file (not a directory) — mkdirs will fail,
            //  appendFile will fail, the emit must be skipped.
            const blocker = path.join(tmpDir, 'outbound', 'blocker_file');
            fsp.writeFile(blocker, 'X')
                .then(() => {
                    const flowPath = path.join(blocker, 'cant_create_here.flo');
                    const destAddr = new Address({ zone: 1, net: 218, node: 760 });

                    mod.flowFileAppendRefs(flowPath, ['/x'], '^', destAddr, err => {
                        configModule._popTestConfig(prev);
                        assert.ok(err, 'append should have errored');
                        assert.equal(
                            received.length,
                            0,
                            'must not emit when append fails'
                        );
                        done();
                    });
                })
                .catch(done);
        });
    });
}); // describe('ftn_bso ↔ BinkP integration')
