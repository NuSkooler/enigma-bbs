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

    it('marks every entry sent when one session ships several files', async () => {
        //
        //  _applyFlowDisposition() is a whole-file read-modify-write and a
        //  session runs one per file it ships, concurrently. Each used to read
        //  the file with every line still unmarked, mark its own and write its
        //  own copy back, so the last writer won and the other lines silently
        //  lost their '~'.
        //
        //  Forwarding a file echo made that immediately harmful: the payload is
        //  queued 'keep' because it lives in the file base, so losing its mark
        //  left it looking unsent and it went out again on every session --
        //  the downlink receiving the same file forever, with no TIC. Caught
        //  between two live instances, not by any unit test, because it needs
        //  two real dispositions racing inside one session.
        //
        const dir = path.join(tmpDir, 'outbound');
        await fsp.mkdir(dir, { recursive: true });

        const payload = path.join(dir, 'PAYLOAD.ZIP');
        const tic = path.join(dir, 'aaaaaaaa.tic');
        await fsp.writeFile(payload, 'payload');
        await fsp.writeFile(tic, 'tic');

        const flowPath = path.join(dir, `${nodeBaseName(TEST_ADDR)}.clo`);
        await fsp.writeFile(flowPath, `${payload}\n^${tic}\n`);

        const files = await spool.getOutboundFilesForNode(TEST_ADDR);
        assert.equal(files.length, 2, 'both entries queued');

        //  Concurrently, as a session does -- not one after the other.
        await Promise.all(files.map(f => f.disposeFn()));

        //
        //  The flow file is removed once nothing live remains in it, so its
        //  absence is the strongest possible evidence: it can only have been
        //  unlinked if *both* entries were marked. When it does survive, every
        //  entry in it must carry '~'.
        //
        let content = null;
        try {
            content = await fsp.readFile(flowPath, 'utf8');
        } catch (err) {
            assert.equal(err.code, 'ENOENT', err.message);
        }

        if (null !== content) {
            content
                .split('\n')
                .filter(l => l.trim().length)
                .forEach(l =>
                    assert.ok(
                        l.trim().startsWith('~'),
                        `entry left unmarked and so will be re-sent: ${l}`
                    )
                );
        }

        //  ...and the node therefore has nothing further pending
        const again = await spool.getOutboundFilesForNode(TEST_ADDR);
        assert.equal(again.length, 0, 'nothing may be queued a second time');
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

    it('returns a .out file with disposition=delete, renamed to a unique .pkt', async () => {
        const outPath = path.join(outboundDir(tmpDir), '00680001.out');
        await fsp.writeFile(outPath, 'PACKETDATA');

        const files = await spool.getOutboundFilesForNode(TEST_ADDR);
        assert.equal(files.length, 1);
        assert.equal(files[0].path, outPath, 'reads from the .out on disk');
        //  FTS-5005.003 §3.1: netmail flow files must be sent under a unique
        //  name with a .pkt extension, or the remote's tosser will not
        //  recognise what it received as a packet.
        assert.match(files[0].name, /^[0-9a-f]{8}\.pkt$/);
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

// ── dangling and rescued flow references ──────────────────────────────────────
//
//  Flow files carry absolute paths (FTS-5005.003 §3.1), so a file that moves
//  out from under its reference becomes invisible: the entry is skipped, the
//  session finds nothing to send, and the call reports success. That is how
//  misfiled outbound mail hid (see issue #734) -- and hand-repairing it meant
//  editing flow files, because moving the packet alone left the stored path
//  stale.
//
//  Two behaviours close that off: a reference is also looked for by basename
//  in the flow file's own directory, and a flow file whose live entries all
//  resolve to nothing no longer reports its node as pending -- which used to
//  put the poller in a dial-every-cycle-and-send-nothing loop.

describe('BsoSpool — dangling and rescued flow references', () => {
    beforeEach(cleanOutbound);

    it('resolves a reference by basename in the flow file directory', async () => {
        const moved = path.join(outboundDir(tmpDir), 'moved.pkt');
        await fsp.writeFile(moved, 'MOVED');

        //  The stored path is where the packet used to live
        const flowPath = path.join(outboundDir(tmpDir), '00680001.flo');
        await fsp.writeFile(flowPath, `^${path.join(tmpDir, 'old_home', 'moved.pkt')}\n`);

        const files = await spool.getOutboundFilesForNode(TEST_ADDR);
        assert.equal(files.length, 1, 'the moved packet must still be found');
        assert.equal(files[0].path, moved);
        assert.equal(files[0].disposition, 'delete');
    });

    it('marks a rescued entry sent using the line as written', async () => {
        const moved = path.join(outboundDir(tmpDir), 'rescued.pkt');
        await fsp.writeFile(moved, 'RESCUED');

        const stale = path.join(tmpDir, 'old_home', 'rescued.pkt');
        const flowPath = path.join(outboundDir(tmpDir), '00680001.flo');
        await fsp.writeFile(flowPath, `^${stale}\nkeepme\n`);

        const files = await spool.getOutboundFilesForNode(TEST_ADDR);
        assert.equal(files.length, 1);

        await files[0].disposeFn();

        const content = await fsp.readFile(flowPath, 'utf8');
        assert.ok(
            content.includes(`~${stale}`),
            `expected the original line marked sent, got:\n${content}`
        );
    });

    it('excludes a node whose live entries all resolve to nothing', async () => {
        const flowPath = path.join(outboundDir(tmpDir), '00680001.flo');
        await fsp.writeFile(flowPath, `^${path.join(tmpDir, 'gone', 'nope.pkt')}\n`);

        const nodes = await spool.getNodesWithPendingMail();
        assert.deepEqual(
            nodes,
            [],
            'a node with nothing shippable must not be reported as pending'
        );
    });

    it('still reports a node whose only entry needed rescuing', async () => {
        const moved = path.join(outboundDir(tmpDir), 'pending_moved.pkt');
        await fsp.writeFile(moved, 'DATA');

        const flowPath = path.join(outboundDir(tmpDir), '00680001.flo');
        await fsp.writeFile(
            flowPath,
            `^${path.join(tmpDir, 'old_home', 'pending_moved.pkt')}\n`
        );

        const nodes = await spool.getNodesWithPendingMail();
        assert.equal(nodes.length, 1);
        assert.equal(nodes[0].net, 104);
        assert.equal(nodes[0].node, 1);
    });

    it('does not rescue across directories, only the flow file own directory', async () => {
        //  A same-named file elsewhere in the outbound tree must not be picked
        //  up; that would ship the wrong packet to the wrong node.
        const elsewhere = path.join(tmpDir, 'elsewhere');
        await fsp.mkdir(elsewhere, { recursive: true });
        await fsp.writeFile(path.join(elsewhere, 'decoy.pkt'), 'DECOY');

        const flowPath = path.join(outboundDir(tmpDir), '00680001.flo');
        await fsp.writeFile(flowPath, `^${path.join(tmpDir, 'gone', 'decoy.pkt')}\n`);

        const files = await spool.getOutboundFilesForNode(TEST_ADDR);
        assert.equal(files.length, 0);
    });

    it('skips a reference that names a directory', async () => {
        //  A directory would queue, then fail to open at send time, and its
        //  node would stay pending forever.
        const dir = path.join(outboundDir(tmpDir), 'itsadir');
        await fsp.mkdir(dir, { recursive: true });

        const flowPath = path.join(outboundDir(tmpDir), '00680001.flo');
        await fsp.writeFile(flowPath, `^${dir}\n`);

        assert.deepEqual(await spool.getOutboundFilesForNode(TEST_ADDR), []);
        assert.deepEqual(await spool.getNodesWithPendingMail(), []);
    });

    it('does not collapse a dangling reference onto a directory', async () => {
        //  The rescue takes the reference's last path segment. For a path
        //  ending in ".." that segment resolves to the parent of the outbound
        //  directory -- outside the spool entirely -- and for "." to the
        //  outbound directory itself. Neither is a file, and neither may be
        //  offered to a remote.
        for (const tail of ['..', '.']) {
            await cleanOutbound();
            const flowPath = path.join(outboundDir(tmpDir), '00680001.flo');
            //  built by hand: path.join() would normalise the tail away
            await fsp.writeFile(flowPath, `^${tmpDir}/gone/missing/${tail}\n`);

            assert.deepEqual(
                await spool.getOutboundFilesForNode(TEST_ADDR),
                [],
                `a reference ending in "${tail}" must resolve to nothing`
            );
            assert.deepEqual(await spool.getNodesWithPendingMail(), []);
        }
    });

    it('rescues a reference written with the other platform separators', async () => {
        const here = path.join(outboundDir(tmpDir), 'aabbccdd.pkt');
        await fsp.writeFile(here, 'PKT');

        const flowPath = path.join(outboundDir(tmpDir), '00680001.flo');
        await fsp.writeFile(flowPath, '^C:\\bbs\\out\\aabbccdd.pkt\n');

        const files = await spool.getOutboundFilesForNode(TEST_ADDR);
        assert.equal(files.length, 1);
        assert.equal(files[0].path, here);
    });
});

// ── Filename case ─────────────────────────────────────────────────────────────
//
//  FTS-5005.003 §2: "Lower case filenames are prefered if supported by the file
//  system. If the OS file system supports lower and upper case filenames, the
//  software should be able to handle both for maximum compatibility."
//
//  We write lower case, but an outbound inherited from a DOS-era mailer -- or
//  written by ftn_bso with fileCase: 'upper' -- is upper case. The scan used a
//  case-insensitive regexp while the per-node lookup stat()ed an exactly lower
//  case name, so such a node was reported as pending and then had nothing
//  queued for it: a poll loop that dialled every cycle and never shipped.

//
//  The operator-facing view of the outbound — issue #754.
//
//  A flow file stores an absolute path, so a file that is deleted or moved
//  leaves an entry that can never be sent. The spool skips it, and
//  getNodesWithPendingMail deliberately hides a node whose entries have all
//  gone that way, so the poller does not dial someone it has nothing to give.
//  That is right for the poller and wrong for the operator: the node it hides
//  is precisely the one somebody needs to be told about.
//
describe('BsoSpool — inspecting the outbound', () => {
    beforeEach(cleanOutbound);

    const OTHER_ADDR = { zone: 1, net: 104, node: 2 }; //  00680002

    function nodeIn(report, addr) {
        return report.find(
            n => n.address.net === addr.net && n.address.node === addr.node
        );
    }

    it('shows a node the poller hides because everything it has is missing', async () => {
        const flowPath = path.join(outboundDir(tmpDir), '00680001.flo');
        await fsp.writeFile(flowPath, `^${path.join(tmpDir, 'gone', 'nope.pkt')}\n`);

        //  The poller is right to skip it...
        assert.deepEqual(await spool.getNodesWithPendingMail(), []);

        //  ...and the operator still has to be able to see it.
        const node = nodeIn(await spool.inspectOutbound(), TEST_ADDR);
        assert.ok(node, 'the node must appear in the report');
        assert.equal(node.entries.length, 1);
        assert.equal(node.entries[0].status, 'missing');
    });

    it('separates what is sendable, missing, and already sent', async () => {
        const real = path.join(outboundDir(tmpDir), 'real.pkt');
        await fsp.writeFile(real, 'PKTDATA');

        const missing = path.join(tmpDir, 'gone', 'vanished.zip');
        const done = path.join(tmpDir, 'gone', 'already.pkt');
        const flowPath = path.join(outboundDir(tmpDir), '00680001.flo');
        await fsp.writeFile(flowPath, `^${real}\n^${missing}\n~${done}\n`);

        const node = nodeIn(await spool.inspectOutbound(), TEST_ADDR);
        const byStatus = Object.fromEntries(node.entries.map(e => [e.status, e]));

        assert.equal(byStatus.pending.path, real);
        assert.equal(byStatus.pending.size, 'PKTDATA'.length);
        assert.equal(byStatus.pending.disposition, 'delete');
        assert.equal(byStatus.missing.path, missing);
        assert.equal(byStatus.missing.size, null, 'a missing file has no size');
        assert.equal(byStatus.sent.path, done);
    });

    it('reports each node separately', async () => {
        const real = path.join(outboundDir(tmpDir), 'one.pkt');
        await fsp.writeFile(real, 'A');
        await fsp.writeFile(path.join(outboundDir(tmpDir), '00680001.flo'), `^${real}\n`);
        await fsp.writeFile(
            path.join(outboundDir(tmpDir), '00680002.flo'),
            `^${path.join(tmpDir, 'gone', 'other.zip')}\n`
        );

        const report = await spool.inspectOutbound();
        assert.equal(nodeIn(report, TEST_ADDR).entries[0].status, 'pending');
        assert.equal(nodeIn(report, OTHER_ADDR).entries[0].status, 'missing');
    });
});

describe('BsoSpool — reporting a missing reference', () => {
    beforeEach(cleanOutbound);

    const loggerModule = require('../core/logger.js');

    //  bso_spool captures logger.js's |log| object at require time, so the
    //  stub has to be installed onto that same object rather than replacing
    //  it wholesale.
    function captureWarnings(work) {
        const warnings = [];
        const original = loggerModule.log.warn;
        loggerModule.log.warn = (fields, message) => warnings.push({ fields, message });
        return work()
            .then(() => warnings)
            .finally(() => {
                loggerModule.log.warn = original;
            });
    }

    it('names the node and the file, not just the stored path', async () => {
        //  The operator's question is "who is missing what". A bare absolute
        //  path answers neither, and was all this used to say.
        const missing = path.join(tmpDir, 'gone', 'payload.zip');
        await fsp.writeFile(
            path.join(outboundDir(tmpDir), '00680001.flo'),
            `^${missing}\n`
        );

        const warnings = await captureWarnings(() =>
            spool.getOutboundFilesForNode(TEST_ADDR)
        );

        const warned = warnings.find(w => w.fields && w.fields.ref === missing);
        assert.ok(warned, `expected a warning about ${missing}`);
        assert.equal(warned.fields.file, 'payload.zip');
        assert.match(String(warned.fields.node), /104\/1/);
        assert.match(
            warned.message,
            /never receive/,
            'it should say the file is not coming, not that a step was skipped'
        );
    });

    it('derives the node from the flow file when sweeping the outbound', async () => {
        //  getNodesWithPendingMail has no address in hand — it is working out
        //  which nodes exist — so the label comes from the file name.
        await fsp.writeFile(
            path.join(outboundDir(tmpDir), '00680001.flo'),
            `^${path.join(tmpDir, 'gone', 'swept.zip')}\n`
        );

        const warnings = await captureWarnings(() => spool.getNodesWithPendingMail());

        const warned = warnings.find(w => w.fields && 'swept.zip' === w.fields.file);
        assert.ok(warned, 'the sweep must report it too');
        assert.match(String(warned.fields.node), /104\/1/);
    });

    it('reports each missing file, not just the first one seen', async () => {
        const one = path.join(tmpDir, 'gone', 'one.zip');
        const two = path.join(tmpDir, 'gone', 'two.zip');
        await fsp.writeFile(
            path.join(outboundDir(tmpDir), '00680001.flo'),
            `^${one}\n^${two}\n`
        );

        const warnings = await captureWarnings(() =>
            spool.getOutboundFilesForNode(TEST_ADDR)
        );

        const files = warnings
            .filter(w => w.fields && w.fields.file)
            .map(w => w.fields.file);
        assert.deepEqual(files.sort(), ['one.zip', 'two.zip']);
    });
});

describe('BsoSpool — pruning missing references', () => {
    beforeEach(cleanOutbound);

    async function seed() {
        const real = path.join(outboundDir(tmpDir), 'keep.pkt');
        await fsp.writeFile(real, 'KEEP');
        const missing = path.join(tmpDir, 'gone', 'vanished.zip');
        const done = path.join(tmpDir, 'gone', 'already.pkt');
        const flowPath = path.join(outboundDir(tmpDir), '00680001.flo');
        await fsp.writeFile(flowPath, `^${real}\n^${missing}\n~${done}\n`);
        return { real, missing, done, flowPath };
    }

    it('changes nothing on a dry run', async () => {
        const { missing, flowPath } = await seed();
        const before = await fsp.readFile(flowPath, 'utf8');

        const { removed } = await spool.pruneMissingRefs(TEST_ADDR);

        assert.deepEqual(
            removed.map(e => e.path),
            [missing],
            'it should still say what it would remove'
        );
        assert.equal(await fsp.readFile(flowPath, 'utf8'), before);
    });

    it('defaults to a dry run when asked for nothing in particular', async () => {
        //  Removing queue entries is the one destructive thing here, and an
        //  unreachable file store looks exactly like a deleted one, so the
        //  caller has to say so explicitly.
        const { flowPath } = await seed();
        const before = await fsp.readFile(flowPath, 'utf8');
        await spool.pruneMissingRefs(TEST_ADDR, {});
        assert.equal(await fsp.readFile(flowPath, 'utf8'), before);
    });

    it('removes only the missing entries when told to', async () => {
        const { real, missing, done, flowPath } = await seed();

        const { removed } = await spool.pruneMissingRefs(TEST_ADDR, { dryRun: false });
        assert.deepEqual(
            removed.map(e => e.path),
            [missing]
        );

        const content = await fsp.readFile(flowPath, 'utf8');
        assert.ok(content.includes(real), 'the sendable entry must survive');
        assert.ok(content.includes(`~${done}`), 'the sent marker must survive');
        assert.ok(!content.includes(missing), 'the missing entry must be gone');
    });

    it('removes the flow file when nothing sendable is left', async () => {
        //  Same as a normal drain: ftn_bso recreates it next time it queues
        //  something, and leaving an all-dead file behind is what the
        //  disposition path already avoids.
        const flowPath = path.join(outboundDir(tmpDir), '00680001.flo');
        await fsp.writeFile(flowPath, `^${path.join(tmpDir, 'gone', 'only.zip')}\n`);

        await spool.pruneMissingRefs(TEST_ADDR, { dryRun: false });

        assert.equal(
            await fsp
                .access(flowPath)
                .then(() => true)
                .catch(() => false),
            false
        );
    });

    it('leaves other nodes alone', async () => {
        const otherFlow = path.join(outboundDir(tmpDir), '00680002.flo');
        await fsp.writeFile(otherFlow, `^${path.join(tmpDir, 'gone', 'theirs.zip')}\n`);
        await seed();

        await spool.pruneMissingRefs(TEST_ADDR, { dryRun: false });

        assert.ok(
            (await fsp.readFile(otherFlow, 'utf8')).includes('theirs.zip'),
            "another node's queue must not be touched"
        );
    });

    it('removes several missing entries from one flow file', async () => {
        //  Splicing shifts every later index, so the removals have to run
        //  bottom-up. With one entry that is invisible.
        const real = path.join(outboundDir(tmpDir), 'survivor.pkt');
        await fsp.writeFile(real, 'KEEP');
        const a = path.join(tmpDir, 'gone', 'a.zip');
        const b = path.join(tmpDir, 'gone', 'b.zip');
        const c = path.join(tmpDir, 'gone', 'c.zip');
        const flowPath = path.join(outboundDir(tmpDir), '00680001.flo');
        await fsp.writeFile(flowPath, `^${a}\n^${real}\n^${b}\n^${c}\n`);

        const { removed } = await spool.pruneMissingRefs(TEST_ADDR, { dryRun: false });
        assert.deepEqual(removed.map(e => e.path).sort(), [a, b, c].sort());

        const remaining = (await fsp.readFile(flowPath, 'utf8'))
            .split('\n')
            .map(l => l.trim())
            .filter(Boolean);
        assert.deepEqual(remaining, [`^${real}`], 'only the real file may remain');
    });

    it('leaves the flow file alone when another process holds the lock', async () => {
        //  oputil runs as its own process, so the in-process write chain says
        //  nothing about what the running BBS is doing. ftn_bso appends refs
        //  and sessions mark them sent under the FTS-5005 .bsy lock; rewriting
        //  outside it drops whatever was queued in between (see #749).
        const bsoLock = require('../core/bso_lock');

        const missing = path.join(tmpDir, 'gone', 'locked.zip');
        const flowPath = path.join(outboundDir(tmpDir), '00680001.flo');
        await fsp.writeFile(flowPath, `^${missing}\n`);

        const bsyPath = bsoLock.bsyPathForFlowFile(flowPath);
        assert.equal(
            await bsoLock.acquire(bsyPath, { staleMaxAgeMs: 600000 }),
            true,
            'test could not take the lock it means to hold'
        );

        try {
            const result = await spool.pruneMissingRefs(TEST_ADDR, {
                dryRun: false,
                lockTimeoutMs: 50,
            });
            assert.deepEqual(result.removed, [], 'nothing may be reported as removed');
            assert.deepEqual(result.busy, [flowPath], 'and the caller must be told why');
            assert.ok(
                (await fsp.readFile(flowPath, 'utf8')).includes(missing),
                'the flow file must be left exactly as it was'
            );
        } finally {
            await bsoLock.release(bsyPath);
        }

        //  ...and once the holder is done, it prunes normally.
        assert.equal(
            (await spool.pruneMissingRefs(TEST_ADDR, { dryRun: false })).removed.length,
            1
        );
    });

    it('will not prune a file it merely could not read', async () => {
        //  ENOENT means gone. EACCES means still there and still owed to the
        //  node -- pruning on that would discard mail over a transient fault.
        const unreadableDir = path.join(tmpDir, 'noaccess');
        await fsp.mkdir(unreadableDir, { recursive: true });
        const hidden = path.join(unreadableDir, 'secret.zip');
        await fsp.writeFile(hidden, 'DATA');

        const flowPath = path.join(outboundDir(tmpDir), '00680001.flo');
        await fsp.writeFile(flowPath, `^${hidden}\n`);

        await fsp.chmod(unreadableDir, 0o000);
        try {
            //  Running as root defeats the permission bits entirely; skip
            //  rather than assert something the platform will not honour.
            const denied = await fsp
                .stat(hidden)
                .then(() => false)
                .catch(err => 'EACCES' === err.code);
            if (!denied) {
                return;
            }

            const node = (await spool.inspectOutbound()).find(
                n => n.address.net === TEST_ADDR.net && n.address.node === TEST_ADDR.node
            );
            assert.equal(node.entries[0].status, 'unreadable');

            assert.deepEqual(
                (await spool.pruneMissingRefs(TEST_ADDR, { dryRun: false })).removed,
                [],
                'an unreadable file must never be pruned'
            );
        } finally {
            await fsp.chmod(unreadableDir, 0o755);
        }
    });

    it('does not claim to have removed an entry that had moved on', async () => {
        //  The listing is taken before the lock, so a session can mark an
        //  entry sent in between. The rewrite correctly leaves that line
        //  alone -- but saying "removed" about it would tell the operator a
        //  file had been dealt with while it is still in the node's queue.
        const missing = path.join(tmpDir, 'gone', 'moved_on.zip');
        const flowPath = path.join(outboundDir(tmpDir), '00680001.flo');
        await fsp.writeFile(flowPath, `^${missing}\nkeepme\n`);

        //  A listing whose line no longer matches what is on disk.
        const stale = {
            kind: 'flow',
            status: 'missing',
            path: missing,
            flowFile: flowPath,
            lineIdx: 0,
            line: `^${path.join(tmpDir, 'gone', 'something_else.zip')}`,
        };
        const realInspect = spool.inspectOutbound.bind(spool);
        spool.inspectOutbound = async () => [
            {
                address: new (require('../core/ftn_address'))(TEST_ADDR),
                entries: [stale],
            },
        ];

        try {
            const { removed } = await spool.pruneMissingRefs(TEST_ADDR, {
                dryRun: false,
            });
            assert.deepEqual(removed, [], 'nothing was actually removed, so say so');
        } finally {
            spool.inspectOutbound = realInspect;
        }

        assert.ok(
            (await fsp.readFile(flowPath, 'utf8')).includes(missing),
            'and the entry must still be there'
        );
    });

    it('says there is nothing to do for a node with no missing entries', async () => {
        const real = path.join(outboundDir(tmpDir), 'fine.pkt');
        await fsp.writeFile(real, 'FINE');
        await fsp.writeFile(path.join(outboundDir(tmpDir), '00680001.flo'), `^${real}\n`);

        assert.deepEqual(
            (await spool.pruneMissingRefs(TEST_ADDR, { dryRun: false })).removed,
            []
        );
    });
});

describe('BsoSpool — upper case outbound (FTS-5005.003 §2)', () => {
    beforeEach(cleanOutbound);

    it('finds an upper case flow file, and agrees with the pending scan', async () => {
        const refFile = path.join(tmpDir, 'UPPER.PKT');
        await fsp.writeFile(refFile, 'DATA');
        await fsp.writeFile(
            path.join(outboundDir(tmpDir), '00680001.CLO'),
            `^${refFile}\n`
        );

        const files = await spool.getOutboundFilesForNode(TEST_ADDR);
        assert.equal(files.length, 1, 'per-node lookup must find it');
        assert.equal(path.basename(files[0].path), 'UPPER.PKT');

        const nodes = await spool.getNodesWithPendingMail();
        assert.equal(nodes.length, 1, 'scan and lookup must agree');

        await fsp.unlink(refFile);
    });

    it('finds an upper case direct-attach file', async () => {
        await fsp.writeFile(path.join(outboundDir(tmpDir), '00680001.CUT'), 'PKTDATA');

        const files = await spool.getOutboundFilesForNode(TEST_ADDR);
        assert.equal(files.length, 1);
        assert.match(files[0].name, /^[0-9a-f]{8}\.pkt$/);
    });

    it('prefers the lower case spelling when both cases are present', async () => {
        //  Possible only on a case-sensitive filesystem; take the lower case
        //  spelling the spec prefers rather than queueing the node's mail twice.
        //
        //  The two flow files reference *different* packets so the assertions
        //  can tell which spelling won -- referencing the same packet would
        //  make the count come out right for the wrong reason.
        const lowerRef = path.join(tmpDir, 'dup_lower.pkt');
        const upperRef = path.join(tmpDir, 'dup_upper.pkt');
        await fsp.writeFile(lowerRef, 'DATA');
        await fsp.writeFile(upperRef, 'DATA');
        await fsp.writeFile(
            path.join(outboundDir(tmpDir), '00680001.clo'),
            `^${lowerRef}\n`
        );
        await fsp.writeFile(
            path.join(outboundDir(tmpDir), '00680001.CLO'),
            `^${upperRef}\n`
        );

        const files = await spool.getOutboundFilesForNode(TEST_ADDR);
        assert.deepEqual(
            files.map(f => path.basename(f.path)),
            ['dup_lower.pkt'],
            'exactly the lower case flow file, queued once'
        );

        const nodes = await spool.getNodesWithPendingMail();
        assert.equal(nodes.length, 1);

        await fsp.unlink(lowerRef);
        await fsp.unlink(upperRef);
    });

    it('honours an upper case .bsy written by another mailer', async () => {
        //  §5.1 makes .bsy the interlock between every program touching the
        //  spool. An exclusive create on our own lower case spelling would not
        //  collide with theirs, and both would believe they held the lock.
        await fsp.writeFile(path.join(outboundDir(tmpDir), '00680001.BSY'), '4242');

        const locked = await spool.acquireLock(TEST_ADDR);
        assert.ok(!locked, 'must not acquire a lock another mailer holds');
    });
});

// ── Point addresses ───────────────────────────────────────────────────────────
//
//  FTS-5005.003 §2: a point's flow and control files live in a "<nff>.pnt"
//  subdirectory of the boss node's outbound, named from the point number as 8
//  hex digits -- 1:104/1.45 is outbound/00680001.pnt/0000002d.*.
//
//  ftn_bso has always written that layout; the reader knew nothing about it, so
//  point mail was never shipped, and a poll of the point address was served the
//  boss node's mail instead.

describe('BsoSpool — point addresses (FTS-5005.003 §2)', () => {
    const POINT_ADDR = { zone: 1, net: 104, node: 1, point: 45 };

    beforeEach(cleanOutbound);

    async function writePointFlow(refFile, dirName = '00680001.pnt') {
        const pntDir = path.join(outboundDir(tmpDir), dirName);
        await fsp.mkdir(pntDir, { recursive: true });
        await fsp.writeFile(path.join(pntDir, '0000002d.clo'), `^${refFile}\n`);
        return pntDir;
    }

    it('finds mail in the boss node’s .pnt subdirectory', async () => {
        const refFile = path.join(tmpDir, 'point.pkt');
        await fsp.writeFile(refFile, 'DATA');
        await writePointFlow(refFile);

        const files = await spool.getOutboundFilesForNode(POINT_ADDR);
        assert.equal(files.length, 1);
        assert.equal(path.basename(files[0].path), 'point.pkt');

        await fsp.unlink(refFile);
    });

    it('reports the point as pending, at its full 4D address', async () => {
        const refFile = path.join(tmpDir, 'point2.pkt');
        await fsp.writeFile(refFile, 'DATA');
        await writePointFlow(refFile);

        const nodes = await spool.getNodesWithPendingMail();
        assert.equal(nodes.length, 1);
        assert.equal(nodes[0].toString(), '1:104/1.45');

        await fsp.unlink(refFile);
    });

    it('does not serve the boss node’s mail to a point', async () => {
        const bossRef = path.join(tmpDir, 'boss.pkt');
        await fsp.writeFile(bossRef, 'DATA');
        await fsp.writeFile(
            path.join(outboundDir(tmpDir), '00680001.clo'),
            `^${bossRef}\n`
        );

        const files = await spool.getOutboundFilesForNode(POINT_ADDR);
        assert.equal(files.length, 0, 'the point has no mail of its own');

        await fsp.unlink(bossRef);
    });

    it('keeps a point’s mail and its boss node’s mail apart', async () => {
        //  Both have mail queued at once, so neither assertion can pass merely
        //  because the other side's spool was never looked at.
        const bossRef = path.join(tmpDir, 'boss_own.pkt');
        const pointRef = path.join(tmpDir, 'point3.pkt');
        await fsp.writeFile(bossRef, 'DATA');
        await fsp.writeFile(pointRef, 'DATA');
        await fsp.writeFile(
            path.join(outboundDir(tmpDir), '00680001.clo'),
            `^${bossRef}\n`
        );
        await writePointFlow(pointRef);

        assert.deepEqual(
            (await spool.getOutboundFilesForNode(TEST_ADDR)).map(f =>
                path.basename(f.path)
            ),
            ['boss_own.pkt'],
            'the boss node gets its own mail, not the point’s'
        );
        assert.deepEqual(
            (await spool.getOutboundFilesForNode(POINT_ADDR)).map(f =>
                path.basename(f.path)
            ),
            ['point3.pkt'],
            'the point gets its own mail, not the boss node’s'
        );

        //  Both are pending, and as distinct addresses
        assert.deepEqual(
            (await spool.getNodesWithPendingMail()).map(a => a.toString()).sort(),
            ['1:104/1', '1:104/1.45']
        );

        await fsp.unlink(bossRef);
        await fsp.unlink(pointRef);
    });

    it('finds an upper case .PNT subdirectory', async () => {
        const refFile = path.join(tmpDir, 'point4.pkt');
        await fsp.writeFile(refFile, 'DATA');
        const pntDir = path.join(outboundDir(tmpDir), '00680001.PNT');
        await fsp.mkdir(pntDir, { recursive: true });
        await fsp.writeFile(path.join(pntDir, '0000002D.CLO'), `^${refFile}\n`);

        const files = await spool.getOutboundFilesForNode(POINT_ADDR);
        assert.equal(files.length, 1);

        await fsp.unlink(refFile);
    });

    it('locks a point inside its .pnt subdirectory', async () => {
        const locked = await spool.acquireLock(POINT_ADDR);
        assert.ok(locked);

        const bsy = path.join(outboundDir(tmpDir), '00680001.pnt', '0000002d.bsy');
        await fsp.access(bsy); // throws if the lock landed elsewhere

        //  The boss node is a different system and must remain pollable
        assert.ok(await spool.acquireLock(TEST_ADDR), 'boss lock is independent');

        await spool.releaseLock(POINT_ADDR);
        await spool.releaseLock(TEST_ADDR);
        assert.ok(await spool.acquireLock(POINT_ADDR), 'lock must be released');
        await spool.releaseLock(POINT_ADDR);
    });

    it('reaps a stale .bsy inside a .pnt subdirectory', async () => {
        const pntDir = path.join(outboundDir(tmpDir), '00680001.pnt');
        await fsp.mkdir(pntDir, { recursive: true });
        const bsy = path.join(pntDir, '0000002d.bsy');
        await fsp.writeFile(bsy, '1');

        const old = new Date(Date.now() - 60 * 60 * 1000);
        await fsp.utimes(bsy, old, old);

        assert.equal(await spool.reapStaleLocks(), 1);
    });

    it('ignores a point number of zero, which addresses the boss node', async () => {
        //  A real point sits alongside the bogus .0 entry, so the scan has to
        //  actually descend into the .pnt dir and discriminate -- rather than
        //  passing because it never looked inside at all.
        const zeroRef = path.join(tmpDir, 'point0.pkt');
        const realRef = path.join(tmpDir, 'point45.pkt');
        await fsp.writeFile(zeroRef, 'DATA');
        await fsp.writeFile(realRef, 'DATA');

        const pntDir = path.join(outboundDir(tmpDir), '00680001.pnt');
        await fsp.mkdir(pntDir, { recursive: true });
        await fsp.writeFile(path.join(pntDir, '00000000.clo'), `^${zeroRef}\n`);
        await fsp.writeFile(path.join(pntDir, '0000002d.clo'), `^${realRef}\n`);

        assert.deepEqual(
            (await spool.getNodesWithPendingMail()).map(a => a.toString()),
            ['1:104/1.45'],
            'the real point is reported; the .0 entry is not'
        );

        await fsp.unlink(zeroRef);
        await fsp.unlink(realRef);
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

    it("offers queued files even when the peer's M_EOB wins the race (#747)", done => {
        //
        //  An answering session resolves what it has for the caller
        //  asynchronously, after M_ADR. If the caller's own M_EOB arrives
        //  first -- which it routinely does, since the lookup touches the
        //  filesystem -- the session must still offer what that lookup finds.
        //
        //  It did not. attachSpoolToSession used holdSend()/releaseSend(), and
        //  |_sendHeld| is consulted in exactly one place: _enterTransfer()'s
        //  initial _sendNext(). It does not gate _sendNext() itself, and
        //  _onEob() calls _sendNext() directly once _remoteEOB is set. That
        //  found an empty queue, saw the answering-side "wait for the remote's
        //  M_EOB" condition already satisfied, and sent our M_EOB -- after
        //  which releaseSend()'s |!_localEOBSent| guard made it a no-op and the
        //  files were never offered.
        //
        //  |_eobHold| is tested inside _sendNext() where M_EOB would go out, so
        //  it holds however _sendNext() was reached. The delay below just makes
        //  the race deterministic; without the fix this fails every time.
        //
        //  Not TIC-specific -- it affects any answering session with mail
        //  queued for the caller -- but it matters most for file echoes,
        //  because a downlink polls its hub rather than being dialled.
        //
        //  Its own payload, not the shared |refFile|: a sibling test queues
        //  that one with '^' (delete after send), so reusing it here makes this
        //  test pass alone and fail in the suite.
        const ownFile = path.join(tmpDir, 'eob_race.pkt');
        const flowPath = path.join(outboundDir(tmpDir), '00020002.flo'); // net=2,node=2
        fsp.writeFile(ownFile, 'EOB_RACE_DATA').then(() => {
            fsp.writeFile(flowPath, `^${ownFile}\n`).then(() => {
                //  Lose the race on purpose: make the spool lookup slower than the
                //  client's M_EOB.
                const slowSpool = Object.create(spool);
                slowSpool.getOutboundFilesForNode = async addr => {
                    await new Promise(r => setTimeout(r, 120));
                    return spool.getOutboundFilesForNode(addr);
                };

                const server = net.createServer(serverSocket => {
                    const serverSess = new BinkpSession(serverSocket, {
                        role: 'answering',
                        addresses: ['1:1/1@testnet'],
                        getPassword: () => null,
                        tempDir: os.tmpdir(),
                    });
                    attachSpoolToSession(serverSess, slowSpool, null).then(() => {
                        serverSess.start();
                    });
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

                    let received = false;
                    clientSess.on('file-received', (name, size, ts, tmpPath) => {
                        received = true;
                        fsp.unlink(tmpPath).catch(() => {});
                    });

                    clientSess.on('session-end', () => {
                        server.close();
                        try {
                            assert.ok(
                                received,
                                'the caller must be offered its mail even though its M_EOB arrived first'
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
