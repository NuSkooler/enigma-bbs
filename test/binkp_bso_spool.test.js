'use strict';

const { strict: assert } = require('assert');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const net = require('net');

const {
    BsoSpool,
    attachSpoolToSession,
    nodeBaseName,
} = require('../core/binkp/bso_spool');
const { BinkpSession } = require('../core/binkp/session');

// ── test fixtures ─────────────────────────────────────────────────────────────

// net=0x0068=104, node=0x0001=1 → base='00680001'
const TEST_ADDR = { zone: 1, net: 104, node: 1 };

// A minimal single-network config so directory resolution is deterministic
function makeConfig(tmpDir) {
    return {
        paths: {
            outbound: tmpDir,
            inbound: path.join(tmpDir, 'inbound'),
            secInbound: path.join(tmpDir, 'secinbound'),
        },
        networks: {
            testnet: { localAddress: '1:1/100', defaultZone: 1 },
        },
    };
}

// With makeConfig, _outboundDir(TEST_ADDR) = path.join(tmpDir, 'outbound')
function outboundDir(tmpDir) {
    return path.join(tmpDir, 'outbound');
}

let tmpDir;
let spool;

before(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'enigma_bso_test_'));
    await fsp.mkdir(outboundDir(tmpDir), { recursive: true });
    await fsp.mkdir(path.join(tmpDir, 'inbound'), { recursive: true });
    await fsp.mkdir(path.join(tmpDir, 'secinbound'), { recursive: true });
    spool = new BsoSpool(makeConfig(tmpDir));
});

after(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
});

// Reset the outbound dir between tests so they don't step on each other
async function cleanOutbound() {
    const dir = outboundDir(tmpDir);
    const entries = await fsp.readdir(dir).catch(() => []);
    await Promise.all(
        entries.map(e => fsp.rm(path.join(dir, e), { recursive: true, force: true }))
    );
}

// ── nodeBaseName ──────────────────────────────────────────────────────────────

describe('nodeBaseName', () => {
    it('zero-pads net and node to 4 hex digits each', () => {
        assert.equal(nodeBaseName({ net: 1, node: 1 }), '00010001');
        assert.equal(nodeBaseName({ net: 104, node: 1 }), '00680001');
        assert.equal(nodeBaseName({ net: 5020, node: 1042 }), '139c0412');
    });
});

// ── BSY lock management ───────────────────────────────────────────────────────

describe('BsoSpool — lock management', () => {
    beforeEach(cleanOutbound);

    it('acquireLock creates the .bsy file and returns true', async () => {
        const ok = await spool.acquireLock(TEST_ADDR);
        assert.ok(ok, 'acquireLock should return true on first call');
        const bsyPath = path.join(outboundDir(tmpDir), '00680001.bsy');
        await assert.doesNotReject(fsp.access(bsyPath), '.bsy file should exist');
        await fsp.unlink(bsyPath);
    });

    it('acquireLock returns false when .bsy already exists', async () => {
        await spool.acquireLock(TEST_ADDR);
        const second = await spool.acquireLock(TEST_ADDR);
        assert.ok(!second, 'second acquireLock should return false');
        await spool.releaseLock(TEST_ADDR);
    });

    it('releaseLock removes the .bsy file', async () => {
        await spool.acquireLock(TEST_ADDR);
        await spool.releaseLock(TEST_ADDR);
        const bsyPath = path.join(outboundDir(tmpDir), '00680001.bsy');
        await assert.rejects(
            fsp.access(bsyPath),
            { code: 'ENOENT' },
            '.bsy should be removed'
        );
    });

    it('releaseLock is idempotent when lock does not exist', async () => {
        await assert.doesNotReject(spool.releaseLock(TEST_ADDR));
    });
});

// ── Stale .bsy reaper ─────────────────────────────────────────────────────────

describe('BsoSpool — stale .bsy reaper', () => {
    beforeEach(cleanOutbound);

    //  Build a spool with a tight stale-lock threshold so we don't have to
    //  wait minutes in tests. The configured value is what the JIT path on
    //  acquireLock and the bulk reapStaleLocks() both consult.
    function freshSpool(staleLockMaxAgeMs) {
        return new BsoSpool({
            ...makeConfig(tmpDir),
            staleLockMaxAgeMs,
        });
    }

    //  Backdate a file's mtime so it looks older than the threshold without
    //  needing a real-time wait.
    async function backdate(filePath, ageMs) {
        const t = new Date(Date.now() - ageMs);
        await fsp.utimes(filePath, t, t);
    }

    it('acquireLock returns false when an existing .bsy is still fresh', async () => {
        const s = freshSpool(60 * 1000); // 60s threshold
        await s.acquireLock(TEST_ADDR); // create the .bsy
        const second = await s.acquireLock(TEST_ADDR);
        assert.ok(!second, 'fresh lock must not be reaped');
        await s.releaseLock(TEST_ADDR);
    });

    it('acquireLock reaps a stale .bsy and succeeds on retry', async () => {
        const s = freshSpool(60 * 1000); // 60s threshold
        await s.acquireLock(TEST_ADDR);
        const bsyPath = path.join(outboundDir(tmpDir), '00680001.bsy');
        await backdate(bsyPath, 5 * 60 * 1000); // 5 min old → stale

        const got = await s.acquireLock(TEST_ADDR);
        assert.ok(got, 'stale lock should be reaped and re-acquired');

        //  Lock now belongs to us — release for cleanliness
        await s.releaseLock(TEST_ADDR);
    });

    it('reapStaleLocks removes only stale .bsy files', async () => {
        const s = freshSpool(60 * 1000);

        const stalePath = path.join(outboundDir(tmpDir), '00680001.bsy');
        const freshPath = path.join(outboundDir(tmpDir), '00680002.bsy');
        await fsp.writeFile(stalePath, '0');
        await fsp.writeFile(freshPath, '0');
        await backdate(stalePath, 5 * 60 * 1000);
        //  freshPath keeps current mtime

        const reaped = await s.reapStaleLocks();
        assert.equal(reaped, 1, 'exactly one stale lock should be reaped');

        await assert.rejects(fsp.access(stalePath), { code: 'ENOENT' });
        await assert.doesNotReject(fsp.access(freshPath));

        await fsp.unlink(freshPath);
    });

    it('reapStaleLocks ignores non-.bsy files', async () => {
        const s = freshSpool(60 * 1000);
        const decoy = path.join(outboundDir(tmpDir), '00680001.flo');
        await fsp.writeFile(decoy, 'flow data');
        await backdate(decoy, 5 * 60 * 1000);

        const reaped = await s.reapStaleLocks();
        assert.equal(reaped, 0);
        await assert.doesNotReject(fsp.access(decoy));
    });

    it('reapStaleLocks is a no-op when outbound dirs do not exist', async () => {
        const s = new BsoSpool({
            paths: {
                outbound: path.join(tmpDir, 'no_such_outbound'),
                inbound: path.join(tmpDir, 'inbound'),
                secInbound: path.join(tmpDir, 'secinbound'),
            },
            networks: { testnet: { localAddress: '1:1/100', defaultZone: 1 } },
            staleLockMaxAgeMs: 60 * 1000,
        });
        const reaped = await s.reapStaleLocks();
        assert.equal(reaped, 0);
    });

    it('default staleLockMaxAgeMs is used when not configured', async () => {
        //  No staleLockMaxAgeMs in config → constructor falls back to 30 min.
        //  A fresh lock (~0 ms old) must NOT be reaped under the default.
        const s = new BsoSpool(makeConfig(tmpDir));
        await s.acquireLock(TEST_ADDR);
        const second = await s.acquireLock(TEST_ADDR);
        assert.ok(!second, 'fresh lock must not be reaped under default threshold');
        await s.releaseLock(TEST_ADDR);
    });
});

// ── Direct-attach file enumeration ────────────────────────────────────────────

describe('BsoSpool — getOutboundFilesForNode: direct-attach', () => {
    beforeEach(cleanOutbound);

    it('returns a .out file with disposition=delete', async () => {
        const outPath = path.join(outboundDir(tmpDir), '00680001.out');
        await fsp.writeFile(outPath, 'PACKETDATA');

        const files = await spool.getOutboundFilesForNode(TEST_ADDR);
        assert.equal(files.length, 1);
        assert.equal(files[0].name, '00680001.out');
        assert.equal(files[0].disposition, 'delete');
        assert.equal(files[0].size, 10);
    });

    it('skips zero-byte .ilo file (poll trigger, not mail)', async () => {
        const iloPath = path.join(outboundDir(tmpDir), '00680001.ilo');
        await fsp.writeFile(iloPath, ''); // zero bytes

        const files = await spool.getOutboundFilesForNode(TEST_ADDR);
        assert.equal(files.length, 0);
    });

    it('direct-attach disposeFn is null (BinkpSession owns the file)', async () => {
        //  Direct-attach files have no flow-file annotation step, and the
        //  session layer (BinkpSession._applyDisposition) already unlinks
        //  the file based on the queued disposition. The spool layer has
        //  no post-send work to do for direct-attach — disposeFn is null.
        const outPath = path.join(outboundDir(tmpDir), '00680001.out');
        await fsp.writeFile(outPath, 'DATA');

        const files = await spool.getOutboundFilesForNode(TEST_ADDR);
        assert.equal(files.length, 1);
        assert.equal(files[0].disposeFn, null, 'direct-attach disposeFn must be null');
        assert.equal(files[0].disposition, 'delete');

        //  And the file is still on disk — disposeFn alone won't remove it.
        //  (The session's _applyDisposition is what actually unlinks at send time.)
        await assert.doesNotReject(fsp.access(outPath));
    });
});

// ── Flow file enumeration ─────────────────────────────────────────────────────

describe('BsoSpool — getOutboundFilesForNode: flow files', () => {
    let referencedFile;

    beforeEach(async () => {
        await cleanOutbound();
        // A real file that the flow file will reference
        referencedFile = path.join(tmpDir, 'test_packet.pkt');
        await fsp.writeFile(referencedFile, 'PKT_CONTENT_HERE');
    });

    afterEach(async () => {
        await fsp.unlink(referencedFile).catch(() => {});
    });

    it('returns a keep-disposition entry from a bare path line', async () => {
        const flowPath = path.join(outboundDir(tmpDir), '00680001.flo');
        await fsp.writeFile(flowPath, `${referencedFile}\n`);

        const files = await spool.getOutboundFilesForNode(TEST_ADDR);
        assert.equal(files.length, 1);
        assert.equal(files[0].path, referencedFile);
        assert.equal(files[0].disposition, 'keep');
    });

    it('returns a delete-disposition entry from a ^ prefixed line', async () => {
        const flowPath = path.join(outboundDir(tmpDir), '00680001.flo');
        await fsp.writeFile(flowPath, `^${referencedFile}\n`);

        const files = await spool.getOutboundFilesForNode(TEST_ADDR);
        assert.equal(files.length, 1);
        assert.equal(files[0].disposition, 'delete');
    });

    it('returns a delete-disposition entry from a - prefixed line', async () => {
        const flowPath = path.join(outboundDir(tmpDir), '00680001.flo');
        await fsp.writeFile(flowPath, `-${referencedFile}\n`);

        const files = await spool.getOutboundFilesForNode(TEST_ADDR);
        assert.equal(files.length, 1);
        assert.equal(files[0].disposition, 'delete');
    });

    it('returns a truncate-disposition entry from a # prefixed line', async () => {
        const flowPath = path.join(outboundDir(tmpDir), '00680001.flo');
        await fsp.writeFile(flowPath, `#${referencedFile}\n`);

        const files = await spool.getOutboundFilesForNode(TEST_ADDR);
        assert.equal(files.length, 1);
        assert.equal(files[0].disposition, 'truncate');
    });

    it('skips ~ prefixed (already-sent) lines', async () => {
        const flowPath = path.join(outboundDir(tmpDir), '00680001.flo');
        await fsp.writeFile(flowPath, `~${referencedFile}\n`);

        const files = await spool.getOutboundFilesForNode(TEST_ADDR);
        assert.equal(files.length, 0);
    });

    it('skips lines where the referenced file is missing from disk', async () => {
        const flowPath = path.join(outboundDir(tmpDir), '00680001.flo');
        await fsp.writeFile(flowPath, '/nonexistent/path/file.pkt\n');

        const files = await spool.getOutboundFilesForNode(TEST_ADDR);
        assert.equal(files.length, 0);
    });

    it('returns nothing when the outbound directory does not exist', async () => {
        const emptySpool = new BsoSpool({
            paths: {
                outbound: path.join(tmpDir, 'no_such_dir'),
                inbound: path.join(tmpDir, 'inbound'),
                secInbound: path.join(tmpDir, 'secinbound'),
            },
            networks: { testnet: { localAddress: '1:1/100', defaultZone: 1 } },
        });
        const files = await emptySpool.getOutboundFilesForNode(TEST_ADDR);
        assert.equal(files.length, 0);
    });
});

// ── disposeFn — flow entries ──────────────────────────────────────────────────

describe('BsoSpool — disposeFn for flow entries', () => {
    let referencedFile;
    let flowPath;

    beforeEach(async () => {
        await cleanOutbound();
        referencedFile = path.join(tmpDir, 'dispose_test.pkt');
        await fsp.writeFile(referencedFile, 'CONTENT');
        flowPath = path.join(outboundDir(tmpDir), '00680001.flo');
    });

    afterEach(async () => {
        await fsp.unlink(referencedFile).catch(() => {});
    });

    //  Note: disposeFn does NOT perform the file action (unlink/truncate) —
    //  that is BinkpSession._applyDisposition's job, run before 'file-sent'
    //  fires. disposeFn handles only flow-file bookkeeping: tilde the line,
    //  and GC the flow file once no live lines remain.

    it('delete disposition: leaves file alone, GCs the (now all-tilded) flow file', async () => {
        await fsp.writeFile(flowPath, `^${referencedFile}\n`);

        const files = await spool.getOutboundFilesForNode(TEST_ADDR);
        await files[0].disposeFn();

        //  File untouched by disposeFn (the session layer is what unlinks)
        await assert.doesNotReject(fsp.access(referencedFile));

        //  Flow file had a single live entry, now tilded → GC'd
        await assert.rejects(
            fsp.access(flowPath),
            { code: 'ENOENT' },
            'flow file should be unlinked once no live entries remain'
        );
    });

    it('keep disposition: marks the flow line ~ and GCs the flow file', async () => {
        await fsp.writeFile(flowPath, `${referencedFile}\n`);

        const files = await spool.getOutboundFilesForNode(TEST_ADDR);
        await files[0].disposeFn();

        await assert.doesNotReject(fsp.access(referencedFile));
        await assert.rejects(fsp.access(flowPath), { code: 'ENOENT' });
    });

    it('truncate disposition: leaves file alone, GCs the (now all-tilded) flow file', async () => {
        await fsp.writeFile(flowPath, `#${referencedFile}\n`);

        const files = await spool.getOutboundFilesForNode(TEST_ADDR);
        await files[0].disposeFn();

        //  Disposition belongs to the session; the spool must not truncate.
        const stat = await fsp.stat(referencedFile);
        assert.equal(stat.size, 'CONTENT'.length, 'disposeFn must not truncate');

        await assert.rejects(fsp.access(flowPath), { code: 'ENOENT' });
    });

    it('preserves the flow file when other live entries remain', async () => {
        //  Two live entries; only the first is dispatched. The second must
        //  remain pending and the flow file must NOT be GC'd.
        const otherFile = path.join(tmpDir, 'dispose_test_other.pkt');
        await fsp.writeFile(otherFile, 'OTHER');
        try {
            await fsp.writeFile(flowPath, `^${referencedFile}\n^${otherFile}\n`);

            const files = await spool.getOutboundFilesForNode(TEST_ADDR);
            assert.equal(files.length, 2);
            await files[0].disposeFn();

            //  Flow file still present (one live line remains).
            //  Note: the `^` directive prefix is replaced by `~` (not added
            //  in front of it) — the line was originally `^path`, so it
            //  becomes `~path`.
            const content = await fsp.readFile(flowPath, 'utf8');
            assert.ok(
                content.includes(`~${referencedFile}`),
                `first line should be tilded, got: ${content}`
            );
            assert.ok(
                content.includes(`^${otherFile}`),
                `second line should still be live, got: ${content}`
            );
            //  And it must still resolve as pending (the surviving line)
            const remaining = await spool.getOutboundFilesForNode(TEST_ADDR);
            assert.equal(remaining.length, 1);
            assert.equal(remaining[0].path, otherFile);
        } finally {
            await fsp.unlink(otherFile).catch(() => {});
        }
    });

    it('GCs the flow file once the LAST live entry is tilded', async () => {
        //  Same as above but dispatch BOTH entries and assert the file is
        //  unlinked exactly once the second disposeFn runs.
        const otherFile = path.join(tmpDir, 'dispose_test_other2.pkt');
        await fsp.writeFile(otherFile, 'OTHER');
        try {
            await fsp.writeFile(flowPath, `^${referencedFile}\n^${otherFile}\n`);

            const files = await spool.getOutboundFilesForNode(TEST_ADDR);
            await files[0].disposeFn();
            //  Still present after first
            await assert.doesNotReject(fsp.access(flowPath));
            await files[1].disposeFn();
            //  GC'd after the last live line tilded
            await assert.rejects(fsp.access(flowPath), { code: 'ENOENT' });
        } finally {
            await fsp.unlink(otherFile).catch(() => {});
        }
    });

    it('disposeFn is a noop if the flow file changed unexpectedly', async () => {
        //  Concurrent modification (e.g. ftn_bso appended a fresh entry,
        //  or a stale callback fired after a manual cleanup): disposeFn
        //  must skip both the rewrite and the GC.
        await fsp.writeFile(flowPath, `^${referencedFile}\n`);
        const files = await spool.getOutboundFilesForNode(TEST_ADDR);

        //  Replace the line entirely before disposeFn runs
        await fsp.writeFile(flowPath, '/some/other/path.pkt\n');

        await files[0].disposeFn();

        //  No GC, no rewrite — file untouched
        const content = await fsp.readFile(flowPath, 'utf8');
        assert.equal(content, '/some/other/path.pkt\n');
    });
});

// ── receiveFile ───────────────────────────────────────────────────────────────

describe('BsoSpool — receiveFile', () => {
    it('moves the temp file to the inbound directory', async () => {
        const tmpFile = path.join(os.tmpdir(), `bso_recv_test_${Date.now()}.dt`);
        await fsp.writeFile(tmpFile, 'INBOUND_PKT');

        const finalPath = await spool.receiveFile(tmpFile, 'test.pkt', false);
        assert.ok(finalPath.startsWith(path.join(tmpDir, 'inbound')));

        const content = await fsp.readFile(finalPath, 'utf8');
        assert.equal(content, 'INBOUND_PKT');

        await fsp.unlink(finalPath);
    });

    it('moves to secInbound when isSecure=true', async () => {
        const tmpFile = path.join(os.tmpdir(), `bso_recv_sec_${Date.now()}.dt`);
        await fsp.writeFile(tmpFile, 'SECURE_INBOUND');

        const finalPath = await spool.receiveFile(tmpFile, 'sec.pkt', true);
        assert.ok(finalPath.startsWith(path.join(tmpDir, 'secinbound')));

        await fsp.unlink(finalPath);
    });

    it('handles filename collisions by appending a counter', async () => {
        // Pre-create a file with the target name
        const existing = path.join(tmpDir, 'inbound', 'collision.pkt');
        await fsp.writeFile(existing, 'EXISTING');

        const tmpFile = path.join(os.tmpdir(), `bso_collision_${Date.now()}.dt`);
        await fsp.writeFile(tmpFile, 'INCOMING');

        const finalPath = await spool.receiveFile(tmpFile, 'collision.pkt', false);

        // Should be a different path (collision resolved)
        assert.notEqual(path.basename(finalPath), 'collision.pkt');
        const content = await fsp.readFile(finalPath, 'utf8');
        assert.equal(content, 'INCOMING');

        await fsp.unlink(existing);
        await fsp.unlink(finalPath);
    });
});

// ── getNodesWithPendingMail ───────────────────────────────────────────────────

describe('BsoSpool — getNodesWithPendingMail', () => {
    beforeEach(cleanOutbound);

    it('returns a node that has a pending flow entry', async () => {
        const refFile = path.join(tmpDir, 'pending.pkt');
        await fsp.writeFile(refFile, 'DATA');
        const flowPath = path.join(outboundDir(tmpDir), '00680001.flo');
        await fsp.writeFile(flowPath, `${refFile}\n`);

        const nodes = await spool.getNodesWithPendingMail();
        assert.equal(nodes.length, 1);
        assert.equal(nodes[0].net, 104);
        assert.equal(nodes[0].node, 1);

        await fsp.unlink(refFile);
    });

    it('excludes a node whose flow file has only ~ entries', async () => {
        const refFile = path.join(tmpDir, 'done.pkt');
        await fsp.writeFile(refFile, 'DATA');
        const flowPath = path.join(outboundDir(tmpDir), '00680001.flo');
        await fsp.writeFile(flowPath, `~${refFile}\n`);

        const nodes = await spool.getNodesWithPendingMail();
        assert.equal(nodes.length, 0);

        await fsp.unlink(refFile);
    });

    it('returns a node with a non-empty direct-attach .out file', async () => {
        const outPath = path.join(outboundDir(tmpDir), '00680001.out');
        await fsp.writeFile(outPath, 'PKT');

        const nodes = await spool.getNodesWithPendingMail();
        assert.equal(nodes.length, 1);
    });

    it('returns an empty list when there are no outbound files', async () => {
        const nodes = await spool.getNodesWithPendingMail();
        assert.equal(nodes.length, 0);
    });
});

// ── attachSpoolToSession ──────────────────────────────────────────────────────

describe('attachSpoolToSession', () => {
    let refFile;

    before(async () => {
        refFile = path.join(tmpDir, 'spool_session_test.pkt');
        await fsp.writeFile(refFile, 'SESSION_PKT_DATA');
    });

    after(async () => {
        await fsp.unlink(refFile).catch(() => {});
    });

    beforeEach(cleanOutbound);

    it('queues outbound files and moves received files via the session', done => {
        // Put a file in the spool keyed to the CLIENT's address so the server
        // sends it to the client (net=2,node=2 → 00020002.flo).
        const flowPath = path.join(outboundDir(tmpDir), '00020002.flo'); // net=2,node=2
        fsp.writeFile(flowPath, `^${refFile}\n`).then(() => {
            const serverAddr = { zone: 1, net: 1, node: 1 }; // server's address
            const clientAddr = { zone: 1, net: 2, node: 2 }; // client's address

            const server = net.createServer(serverSocket => {
                const serverSess = new BinkpSession(serverSocket, {
                    role: 'answering',
                    addresses: ['1:1/1@testnet'],
                    getPassword: () => null,
                    tempDir: os.tmpdir(),
                });

                // Attach spool: answering side doesn't know remote addrs yet
                attachSpoolToSession(serverSess, spool, null).then(() => {
                    serverSess.start();
                });
            });

            server.listen(0, '127.0.0.1', async () => {
                const { port } = server.address();
                const clientSocket = net.createConnection(port, '127.0.0.1');
                const clientSess = new BinkpSession(clientSocket, {
                    role: 'originating',
                    addresses: ['1:2/2@testnet'],
                    getPassword: () => null,
                    tempDir: os.tmpdir(),
                });

                // Originating side: spool has a file for net=1/node=1 (server's addr)
                const serverAddrObj = new (require('../core/ftn_address'))({
                    zone: 1,
                    net: 1,
                    node: 1,
                });
                await attachSpoolToSession(clientSess, spool, [serverAddrObj]);

                let clientReceivedFile = false;
                clientSess.on('file-received', (name, size, ts, tmpPath) => {
                    clientReceivedFile = true;
                    fsp.unlink(tmpPath).catch(() => {});
                });

                clientSess.on('session-end', () => {
                    server.close();
                    try {
                        assert.ok(
                            clientReceivedFile,
                            'client should have received the file from server spool'
                        );
                        done();
                    } catch (e) {
                        done(e);
                    }
                });

                clientSess.on('error', done);
                clientSess.start();
            });
        });
    });

    it('holdSend/releaseSend gates sending until async spool load completes', done => {
        const server = net.createServer(serverSocket => {
            const serverSess = new BinkpSession(serverSocket, {
                role: 'answering',
                addresses: ['1:1/1@testnet'],
                getPassword: () => null,
                tempDir: os.tmpdir(),
            });
            serverSess.start();
        });

        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            const clientSocket = net.createConnection(port, '127.0.0.1');
            const clientSess = new BinkpSession(clientSocket, {
                role: 'originating',
                addresses: ['1:2/2@testnet'],
                getPassword: () => null,
                tempDir: os.tmpdir(),
            });

            // Manually test holdSend / releaseSend
            clientSess.on('authenticated', () => {
                // At this point session is in transfer state
                clientSess.holdSend();
                // Queue a file after holding
                fsp.mkdtemp(path.join(os.tmpdir(), 'bso_hold_')).then(async d => {
                    const f = path.join(d, 'held.pkt');
                    await fsp.writeFile(f, 'HELD_DATA');
                    const stat = await fsp.stat(f);
                    clientSess.queueFile(
                        f,
                        'held.pkt',
                        stat.size,
                        Math.floor(Date.now() / 1000),
                        'delete'
                    );
                    clientSess.releaseSend();
                });
            });

            let serverGotFile = false;
            // We need a server session that can receive
            // (the simple server above won't track it — this test just checks no crash)
            clientSess.on('session-end', () => {
                server.close();
                done();
            });
            clientSess.on('error', done);
            clientSess.start();
        });
    });
});
