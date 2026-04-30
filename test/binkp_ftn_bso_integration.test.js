'use strict';

const { strict: assert } = require('assert');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

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

// ── fixtures ──────────────────────────────────────────────────────────────────

let tmpDir;

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

        const countBefore = Events.listenerCount(Events.getSystemEvents().NewInboundBSO);

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
                    assert.equal(countAfter, countBefore, 'listener removed on shutdown');
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

            assert.equal(files.length, 1, 'BsoSpool should find the zone-2 flow entry');
        } finally {
            configModule._popTestConfig(prev);
        }
    });
});
