'use strict';

const { strict: assert } = require('assert');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const net = require('net');

const { reapInboundTemps } = require('../core/scanner_tossers/binkp.js');
const { BinkpSession } = require('../core/binkp/session.js');

// ── reapInboundTemps (startup sweep) ──────────────────────────────────────────

describe('binkp scanner_tosser — reapInboundTemps', () => {
    let tempDir;

    beforeEach(async () => {
        tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'binkp_temp_test_'));
    });

    afterEach(async () => {
        await fsp.rm(tempDir, { recursive: true, force: true });
    });

    async function makeAged(name, ageMs) {
        const p = path.join(tempDir, name);
        await fsp.writeFile(p, 'partial');
        const t = new Date(Date.now() - ageMs);
        await fsp.utimes(p, t, t);
        return p;
    }

    it('removes binkp_in_*.dt files older than threshold', async () => {
        const stale = await makeAged('binkp_in_old_abc.dt', 2 * 60 * 60 * 1000);
        const reaped = await reapInboundTemps(tempDir, 60 * 60 * 1000);
        assert.equal(reaped, 1);
        await assert.rejects(fsp.access(stale), { code: 'ENOENT' });
    });

    it('preserves recent binkp_in_*.dt files', async () => {
        const fresh = await makeAged('binkp_in_fresh_abc.dt', 60 * 1000);
        const reaped = await reapInboundTemps(tempDir, 60 * 60 * 1000);
        assert.equal(reaped, 0);
        await assert.doesNotReject(fsp.access(fresh));
    });

    it('ignores files that do not match the binkp_in_*.dt pattern', async () => {
        const decoy1 = await makeAged('not_binkp.dt', 2 * 60 * 60 * 1000);
        const decoy2 = await makeAged('binkp_in_xyz.txt', 2 * 60 * 60 * 1000);
        const decoy3 = await makeAged('something_binkp_in_xyz.dt', 2 * 60 * 60 * 1000);
        const reaped = await reapInboundTemps(tempDir, 60 * 60 * 1000);
        assert.equal(reaped, 0);
        await assert.doesNotReject(fsp.access(decoy1));
        await assert.doesNotReject(fsp.access(decoy2));
        await assert.doesNotReject(fsp.access(decoy3));
    });

    it('reaps only the stale files in a mixed-age set', async () => {
        await makeAged('binkp_in_a.dt', 2 * 60 * 60 * 1000); // stale
        await makeAged('binkp_in_b.dt', 30 * 60 * 1000); // fresh
        await makeAged('binkp_in_c.dt', 5 * 60 * 60 * 1000); // stale
        const reaped = await reapInboundTemps(tempDir, 60 * 60 * 1000);
        assert.equal(reaped, 2);
        const remaining = await fsp.readdir(tempDir);
        assert.deepEqual(remaining.sort(), ['binkp_in_b.dt']);
    });

    it('returns 0 when tempDir does not exist', async () => {
        const missing = path.join(tempDir, 'no_such_dir');
        const reaped = await reapInboundTemps(missing, 60 * 60 * 1000);
        assert.equal(reaped, 0);
    });

    it('treats a tempDir with no matching files as 0 reaped', async () => {
        await fsp.writeFile(path.join(tempDir, 'unrelated.dat'), 'x');
        const reaped = await reapInboundTemps(tempDir, 60 * 60 * 1000);
        assert.equal(reaped, 0);
    });
});

// ── In-session finalizer (BinkpSession._destroy) ─────────────────────────────

describe('BinkpSession — inbound temp finalizer', () => {
    let tempDir;
    let server;
    let cleanupSockets;

    beforeEach(async () => {
        tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'binkp_finalizer_'));
        cleanupSockets = [];
    });

    afterEach(async () => {
        for (const s of cleanupSockets) {
            try {
                s.destroy();
            } catch {
                // already closed
            }
        }
        if (server) {
            await new Promise(resolve => server.close(resolve));
            server = null;
        }
        await fsp.rm(tempDir, { recursive: true, force: true });
    });

    //  Build a session bound to a real loopback socket so _destroy() can
    //  actually destroy it. Uses an unconnected server-side accept so we
    //  control the lifecycle from the test.
    function makeBoundSession() {
        return new Promise(resolve => {
            server = net.createServer(serverSocket => {
                cleanupSockets.push(serverSocket);
            });
            server.listen(0, '127.0.0.1', () => {
                const { port } = server.address();
                const clientSocket = net.createConnection(port, '127.0.0.1');
                cleanupSockets.push(clientSocket);
                clientSocket.once('connect', () => {
                    const sess = new BinkpSession(clientSocket, {
                        role: 'originating',
                        addresses: ['1:1/1@testnet'],
                        getPassword: () => null,
                        tempDir,
                    });
                    resolve(sess);
                });
            });
        });
    }

    it('unlinks a partial inbound temp file on _destroy()', async () => {
        const sess = await makeBoundSession();

        //  Simulate the session having received an M_FILE and one data frame
        //  that started writing to the temp path. We bypass real protocol by
        //  driving the private receive path directly — that is the surface
        //  the _destroy() finalizer is responsible for.
        sess._onFile('partial.pkt 100 1700000000 0');
        sess._onDataFrame(Buffer.from('PARTIAL_DATA_NOT_COMPLETE'));

        const tempPath = sess._currentRecv.tempPath;
        assert.ok(
            sess._inboundTempPaths.has(tempPath),
            'temp path should be tracked while in-flight'
        );

        //  Wait one tick so the createWriteStream has actually opened the fd
        //  before destroy. Otherwise the file may not exist at unlink time
        //  (which is fine for the assertion, but defeats the test purpose).
        await new Promise(r => setImmediate(r));
        await assert.doesNotReject(
            fsp.access(tempPath),
            'temp file should exist after first data frame'
        );

        sess._destroy();

        //  The unlink runs as a fire-and-forget promise inside _destroy.
        //  Give it one event-loop turn to settle.
        await new Promise(r => setImmediate(r));
        await new Promise(r => setImmediate(r));

        await assert.rejects(
            fsp.access(tempPath),
            { code: 'ENOENT' },
            'partial temp file should be unlinked by _destroy()'
        );
        assert.equal(
            sess._inboundTempPaths.size,
            0,
            'tracked-paths set should be empty after _destroy()'
        );
    });

    it('does not unlink a temp file once it has been handed off (file-received fired)', async () => {
        const sess = await makeBoundSession();

        sess._onFile('complete.pkt 5 1700000000 0');
        sess._onDataFrame(Buffer.from('HELLO')); //  exact size = 5
        const tempPath = sess._currentRecv ? sess._currentRecv.tempPath : null;

        //  After the full payload arrives, _finalizeReceive runs and
        //  _currentRecv is cleared. Capture the path from the
        //  file-received event instead.
        let receivedTempPath = null;
        await new Promise(resolve => {
            sess.once('file-received', (name, size, ts, p) => {
                receivedTempPath = p;
                resolve();
            });
        });

        const finalPath = receivedTempPath || tempPath;
        assert.ok(finalPath, 'should have a temp path from file-received');

        //  Once handed off, the session must drop ownership: destroying it
        //  now must NOT unlink the file (the consumer hasn't moved it yet).
        await assert.doesNotReject(fsp.access(finalPath));
        assert.equal(
            sess._inboundTempPaths.size,
            0,
            'session should drop ownership after file-received'
        );

        sess._destroy();
        await new Promise(r => setImmediate(r));

        //  File still present — destroy did not unlink, since the path
        //  was no longer tracked.
        await assert.doesNotReject(
            fsp.access(finalPath),
            'handed-off temp file must survive _destroy()'
        );

        //  Manual cleanup
        await fsp.unlink(finalPath).catch(() => {});
    });
});
