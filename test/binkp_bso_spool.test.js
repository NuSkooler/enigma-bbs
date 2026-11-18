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
const { FlowLockSet } = require('../core/bso_lock');
const { listQueued } = require('./helpers/bso_listing');

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

//  spool -> the lock set lockedFiles() took for it, released by
//  cleanOutbound().
const heldLocks = new Map();

//
//  What is queued for |addr|, read as a session reads it: holding the node's
//  locks, so each disposeFn() marks its line under them. rewriteFlowFile()
//  refuses to change a flow file without its lock.
//
async function lockedFiles(sp, addr) {
    if (!heldLocks.has(sp)) {
        heldLocks.set(sp, sp.newLockSet());
    }
    const lock = heldLocks.get(sp);
    assert.ok(await sp.lockNode(addr, lock), 'node lock taken');
    return sp.getOutboundFilesForNode(addr, { lock });
}

//  Just what is queued: under the lock lockedFiles() holds for |sp| if
//  there is one, otherwise under a lock taken and released around it.
async function listFiles(sp, addr) {
    return heldLocks.has(sp) ? lockedFiles(sp, addr) : listQueued(sp, addr);
}

async function releaseHeldLocks() {
    const locks = Array.from(heldLocks.values());
    heldLocks.clear();
    await Promise.all(locks.map(l => l.close()));
}

// Reset the outbound dir between tests so they don't step on each other
async function cleanOutbound() {
    await releaseHeldLocks();
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

        const files = await lockedFiles(spool, TEST_ADDR);
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
        const again = await listFiles(spool, TEST_ADDR);
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
        //  Left by another program that crashed. One this process holds is
        //  never reaped by it, however old it looks.
        const bsyPath = path.join(outboundDir(tmpDir), '00680001.bsy');
        await fsp.mkdir(path.dirname(bsyPath), { recursive: true });
        await fsp.writeFile(bsyPath, '4242\n');
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

    //  #1052: a restart after a crash or a SIGKILL during a session.
    it('reapStaleLocks removes, whatever its age, our lock whose process on this machine is gone', async function () {
        const bsoLock = require('../core/bso_lock');
        const hostId = bsoLock.lockHostId();
        if ('-' === hostId) {
            return this.skip(); //  no boot id / PID namespace to compare
        }
        const { spawnSync } = require('child_process');
        const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
        const s = freshSpool(30 * 60 * 1000);

        const goneHolder = path.join(outboundDir(tmpDir), '00680001.bsy');
        const liveHolder = path.join(outboundDir(tmpDir), '00680002.bsy');
        const foreign = path.join(outboundDir(tmpDir), '00680003.bsy');
        await fsp.writeFile(goneHolder, `${deadPid} ENiGMA ${hostId} 0123456789abcdef\n`);
        await fsp.writeFile(
            liveHolder,
            `${process.ppid} ENiGMA ${hostId} 0123456789abcdef\n`
        );
        await fsp.writeFile(foreign, `${deadPid}\n`); //  e.g. binkd's

        assert.equal(await s.reapStaleLocks(), 1);
        await assert.rejects(fsp.access(goneHolder), { code: 'ENOENT' });
        await assert.doesNotReject(fsp.access(liveHolder));
        await assert.doesNotReject(fsp.access(foreign));
        await fsp.unlink(liveHolder);
        await fsp.unlink(foreign);
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

        const files = await listFiles(spool, TEST_ADDR);
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

        const files = await listFiles(spool, TEST_ADDR);
        assert.equal(files.length, 0);
    });

    it('direct-attach disposeFn is null (BinkpSession owns the file)', async () => {
        //  Direct-attach files have no flow-file annotation step, and the
        //  session layer (BinkpSession._applyDisposition) already unlinks
        //  the file based on the queued disposition. The spool layer has
        //  no post-send work to do for direct-attach — disposeFn is null.
        const outPath = path.join(outboundDir(tmpDir), '00680001.out');
        await fsp.writeFile(outPath, 'DATA');

        const files = await listFiles(spool, TEST_ADDR);
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

        const files = await listFiles(spool, TEST_ADDR);
        assert.equal(files.length, 1);
        assert.equal(files[0].path, referencedFile);
        assert.equal(files[0].disposition, 'keep');
    });

    it('returns a delete-disposition entry from a ^ prefixed line', async () => {
        const flowPath = path.join(outboundDir(tmpDir), '00680001.flo');
        await fsp.writeFile(flowPath, `^${referencedFile}\n`);

        const files = await listFiles(spool, TEST_ADDR);
        assert.equal(files.length, 1);
        assert.equal(files[0].disposition, 'delete');
    });

    it('returns a delete-disposition entry from a - prefixed line', async () => {
        const flowPath = path.join(outboundDir(tmpDir), '00680001.flo');
        await fsp.writeFile(flowPath, `-${referencedFile}\n`);

        const files = await listFiles(spool, TEST_ADDR);
        assert.equal(files.length, 1);
        assert.equal(files[0].disposition, 'delete');
    });

    it('returns a truncate-disposition entry from a # prefixed line', async () => {
        const flowPath = path.join(outboundDir(tmpDir), '00680001.flo');
        await fsp.writeFile(flowPath, `#${referencedFile}\n`);

        const files = await listFiles(spool, TEST_ADDR);
        assert.equal(files.length, 1);
        assert.equal(files[0].disposition, 'truncate');
    });

    it('skips ~ prefixed (already-sent) lines', async () => {
        const flowPath = path.join(outboundDir(tmpDir), '00680001.flo');
        await fsp.writeFile(flowPath, `~${referencedFile}\n`);

        const files = await listFiles(spool, TEST_ADDR);
        assert.equal(files.length, 0);
    });

    it('skips lines where the referenced file is missing from disk', async () => {
        const flowPath = path.join(outboundDir(tmpDir), '00680001.flo');
        await fsp.writeFile(flowPath, '/nonexistent/path/file.pkt\n');

        const files = await listFiles(spool, TEST_ADDR);
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
        const files = await listFiles(emptySpool, TEST_ADDR);
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

        const files = await lockedFiles(spool, TEST_ADDR);
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

        const files = await lockedFiles(spool, TEST_ADDR);
        await files[0].disposeFn();

        await assert.doesNotReject(fsp.access(referencedFile));
        await assert.rejects(fsp.access(flowPath), { code: 'ENOENT' });
    });

    it('truncate disposition: leaves file alone, GCs the (now all-tilded) flow file', async () => {
        await fsp.writeFile(flowPath, `#${referencedFile}\n`);

        const files = await lockedFiles(spool, TEST_ADDR);
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

            const files = await lockedFiles(spool, TEST_ADDR);
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
            const remaining = await listFiles(spool, TEST_ADDR);
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

            const files = await lockedFiles(spool, TEST_ADDR);
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
        const files = await lockedFiles(spool, TEST_ADDR);

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

    //  The session hands over plain file names only; receiveFile holds the
    //  same line for any other caller.
    describe('only ever writes directly into the inbound directory', () => {
        const tag = `recv_plain_${process.pid}_${Date.now()}`;
        const cases = [
            ['one parent component', `../${tag}_a.pkt`],
            ['two parent components', `../../${tag}_b.pkt`],
            ['a subdirectory', `sub/${tag}_c.pkt`],
            ['a backslash parent component', `..\\${tag}_d.pkt`],
            ['an absolute path', `/${tag}_e.pkt`],
            ['..', '..'],
            ['.', '.'],
            ['an empty name', ''],
            ['a leading dot', `.${tag}_f`],
            ['a NUL', `${tag}\0_g.pkt`],
        ];

        for (const [label, name] of cases) {
            it(`refuses ${label} and removes the temp file`, async () => {
                const tmpFile = path.join(
                    os.tmpdir(),
                    `bso_recv_plain_${Date.now()}_${Math.random().toString(36).slice(2)}.dt`
                );
                await fsp.writeFile(tmpFile, 'DATA');

                const before = await fsp.readdir(path.join(tmpDir, 'inbound'));

                await assert.rejects(
                    spool.receiveFile(tmpFile, name, false),
                    /not a plain file name/
                );

                await assert.rejects(fsp.access(tmpFile), { code: 'ENOENT' });
                assert.deepEqual(
                    await fsp.readdir(path.join(tmpDir, 'inbound')),
                    before,
                    'nothing new in inbound'
                );
                for (const dir of [tmpDir, path.dirname(tmpDir), os.tmpdir()]) {
                    const stray = (await fsp.readdir(dir)).filter(e => e.includes(tag));
                    assert.deepEqual(stray, [], `nothing new in ${dir}`);
                }
            });
        }
    });

    it('still accepts a long name with spaces', async () => {
        const tmpFile = path.join(os.tmpdir(), `bso_recv_long_${Date.now()}.dt`);
        await fsp.writeFile(tmpFile, 'LONG');

        const name = 'A Long File Name With Spaces.tar.gz';
        const finalPath = await spool.receiveFile(tmpFile, name, false);
        assert.equal(finalPath, path.join(tmpDir, 'inbound', name));

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
//
//  The fixtures use the #734 shape: a packet queued in outbound.002/ and moved
//  by hand into outbound/, so the stored path's directory is an outbound one.

//  Where a packet used to live before it was moved into outbound/
function zone2Path(name) {
    return path.join(tmpDir, 'outbound.002', name);
}

describe('BsoSpool — dangling and rescued flow references', () => {
    beforeEach(cleanOutbound);

    it('resolves a reference by basename in the flow file directory', async () => {
        const moved = path.join(outboundDir(tmpDir), 'moved.pkt');
        await fsp.writeFile(moved, 'MOVED');

        //  The stored path is where the packet used to live
        const flowPath = path.join(outboundDir(tmpDir), '00680001.flo');
        await fsp.writeFile(flowPath, `^${zone2Path('moved.pkt')}\n`);

        const files = await listFiles(spool, TEST_ADDR);
        assert.equal(files.length, 1, 'the moved packet must still be found');
        assert.equal(files[0].path, moved);
        assert.equal(files[0].disposition, 'delete');
    });

    it('marks a rescued entry sent using the line as written', async () => {
        const moved = path.join(outboundDir(tmpDir), 'rescued.pkt');
        await fsp.writeFile(moved, 'RESCUED');

        const stale = zone2Path('rescued.pkt');
        const flowPath = path.join(outboundDir(tmpDir), '00680001.flo');
        await fsp.writeFile(flowPath, `^${stale}\nkeepme\n`);

        const files = await lockedFiles(spool, TEST_ADDR);
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
        await fsp.writeFile(flowPath, `^${zone2Path('pending_moved.pkt')}\n`);

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

        const files = await listFiles(spool, TEST_ADDR);
        assert.equal(files.length, 0);
    });

    it('skips a reference that names a directory', async () => {
        //  A directory would queue, then fail to open at send time, and its
        //  node would stay pending forever.
        const dir = path.join(outboundDir(tmpDir), 'itsadir');
        await fsp.mkdir(dir, { recursive: true });

        const flowPath = path.join(outboundDir(tmpDir), '00680001.flo');
        await fsp.writeFile(flowPath, `^${dir}\n`);

        assert.deepEqual(await listFiles(spool, TEST_ADDR), []);
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
                await listFiles(spool, TEST_ADDR),
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
        await fsp.writeFile(flowPath, '^C:\\fido\\outbound\\aabbccdd.pkt\n');

        const files = await listFiles(spool, TEST_ADDR);
        assert.equal(files.length, 1);
        assert.equal(files[0].path, here);
    });
});

// ── flow file path rules ──────────────────────────────────────────────────────
//
//  Which files a flow file line may act on (core/bso_flow_paths.js): the
//  basename rescue above only for the entries it exists for, deletes and
//  truncates only inside the mail directories, and nothing at all from a
//  protected directory.

//  Push everything queued for |addr| through a real session pair and wait
//  until the sending side has finished, dispositions included.
function sendThroughSession(sendingSpool, addr) {
    const Address = require('../core/ftn_address');
    return new Promise((resolve, reject) => {
        const received = [];
        const server = net.createServer(serverSocket => {
            const serverSess = new BinkpSession(serverSocket, {
                role: 'answering',
                addresses: [`${addr.zone}:${addr.net}/${addr.node}@testnet`],
                getPassword: () => null,
                tempDir: os.tmpdir(),
            });
            serverSess.on('file-received', (name, size, ts, tmpPath) => {
                received.push(name);
                fsp.unlink(tmpPath).catch(() => {});
            });
            serverSess.on('error', () => {});
            serverSess.start();
        });

        server.listen(0, '127.0.0.1', async () => {
            const { port } = server.address();
            const clientSess = new BinkpSession(net.createConnection(port, '127.0.0.1'), {
                role: 'originating',
                addresses: ['1:2/2@testnet'],
                getPassword: () => null,
                tempDir: os.tmpdir(),
            });
            try {
                await attachSpoolToSession(clientSess, sendingSpool, [new Address(addr)]);
            } catch (e) {
                server.close();
                return reject(e);
            }
            //  The flow file bookkeeping for each sent file joins
            //  BsoSpool._flowWrites when the file is marked sent, and nothing
            //  awaits it before 'session-end' (the session does not track it
            //  yet). Drain it, or a rewrite still in flight -- which unlinks
            //  the flow file once its last line is marked -- lands on the
            //  next test's flow file of the same name.
            clientSess.on('session-end', async () => {
                server.close();
                while (BsoSpool._flowWrites.size > 0) {
                    await Promise.allSettled(Array.from(BsoSpool._flowWrites.values()));
                }
                resolve(received);
            });
            clientSess.on('error', err => {
                server.close();
                reject(err);
            });
            clientSess.start();
        });
    });
}

//  The flow file is marked after 'file-sent', which the session does not wait
//  for; give it a moment.
async function flowContentSettled(flowPath, done) {
    for (let i = 0; i < 50; i++) {
        const content = await fsp.readFile(flowPath, 'utf8').catch(() => null);
        if (done(content)) {
            return content;
        }
        await new Promise(r => setTimeout(r, 20));
    }
    return fsp.readFile(flowPath, 'utf8').catch(() => null);
}

async function exists(p) {
    return fsp.lstat(p).then(
        () => true,
        () => false
    );
}

describe('BsoSpool — basename rescue applies only where it belongs', () => {
    beforeEach(cleanOutbound);

    const flowPath = () => path.join(outboundDir(tmpDir), '00680001.flo');

    it('never rescues a send-and-keep line, even onto a packet', async () => {
        //  A kept file lives in the file base, never in the outbound, so the
        //  rescue could only ever find some other file there.
        await fsp.writeFile(path.join(outboundDir(tmpDir), 'moved.pkt'), 'PKT');
        await fsp.writeFile(flowPath(), `${zone2Path('moved.pkt')}\n`);

        assert.deepEqual(await listFiles(spool, TEST_ADDR), []);
        assert.deepEqual(await spool.getNodesWithPendingMail(), []);
    });

    it('sends nothing for a dangling keep line when outbound/00680025.out is present', async () => {
        const other = path.join(outboundDir(tmpDir), '00680025.out');
        await fsp.writeFile(other, 'NETMAIL FOR SOMEONE ELSE');
        await fsp.writeFile(
            flowPath(),
            `${path.join(tmpDir, 'filebase', 'area', '00680025.out')}\n`
        );

        const files = await listFiles(spool, TEST_ADDR);
        assert.deepEqual(
            files.map(f => f.path),
            [],
            "another node's netmail must not be offered"
        );

        //  And the listing agrees: the entry is missing, not pending.
        const node = (await spool.inspectOutbound()).find(
            n => 104 === n.address.net && 1 === n.address.node
        );
        assert.equal(node.entries[0].status, 'missing');
    });

    it('never rescues onto a BSO control or flow file name', async () => {
        const names = [
            '00680025.flo',
            '00680025.hlo',
            '00680025.out',
            '00680025.cut',
            '00680025.bsy',
            '00680025.csy',
            '00680025.hld',
            '00680025.try',
            '00680025.req',
            'enigma.bsy',
        ];
        for (const name of names) {
            await cleanOutbound();
            const victim = path.join(outboundDir(tmpDir), name);
            await fsp.writeFile(victim, 'CONTROL');
            await fsp.writeFile(flowPath(), `^${zone2Path(name)}\n`);

            const files = await listFiles(spool, TEST_ADDR);
            assert.deepEqual(
                files.filter(f => f.path === victim),
                [],
                `${name} must not be rescued`
            );
            assert.ok(await exists(victim), `${name} must be left alone`);
        }
    });

    it("does not rescue htick's routed-transit form ^<inbound>/<name>", async () => {
        //  htick queues a file passing through as ^<its inbound>/<name>. That
        //  name came from elsewhere; a same-named file in our outbound is not it.
        const sameName = path.join(outboundDir(tmpDir), 'nodediff.a21');
        await fsp.writeFile(sameName, 'NOT THE TRANSIT FILE');
        await fsp.writeFile(
            flowPath(),
            `^${path.join(tmpDir, 'husky', 'inbound', 'nodediff.a21')}\n`
        );

        assert.deepEqual(await listFiles(spool, TEST_ADDR), []);
        assert.ok(await exists(sameName));
    });

    it('still rescues bundles, including day extensions ending in "ut"', async () => {
        //  A Sunday or Tuesday bundle with sequence letter t is .sut / .tut;
        //  those must not be mistaken for netmail flow files (.?ut).
        for (const name of [
            '0000fc9c.mo0',
            '0000fc9c.sut',
            '0000fc9c.tut',
            'deadbeef.tic',
        ]) {
            await cleanOutbound();
            const here = path.join(outboundDir(tmpDir), name);
            await fsp.writeFile(here, 'BUNDLE');
            await fsp.writeFile(flowPath(), `^${zone2Path(name)}\n`);

            const files = await listFiles(spool, TEST_ADDR);
            assert.deepEqual(
                files.map(f => f.path),
                [here],
                `${name} should be rescued`
            );
        }
    });

    it('rescues from a configured network directory name and a point directory', async () => {
        const multi = new BsoSpool({
            ...makeConfig(tmpDir),
            networks: {
                testnet: { localAddress: '1:1/100', defaultZone: 1 },
                fsxnet: { localAddress: '21:1/100', defaultZone: 21 },
            },
            defaultNetwork: 'testnet',
        });
        for (const stored of [
            path.join('/old', 'fsxnet', 'moved.pkt'),
            path.join('/old', 'fsxnet.015', 'moved.pkt'),
            path.join('/old', 'outbound', '00680001.pnt', 'moved.pkt'),
        ]) {
            await cleanOutbound();
            const here = path.join(outboundDir(tmpDir), 'moved.pkt');
            await fsp.writeFile(here, 'PKT');
            await fsp.writeFile(flowPath(), `^${stored}\n`);

            const files = await listFiles(multi, TEST_ADDR);
            assert.deepEqual(
                files.map(f => f.path),
                [here],
                `${stored} should be rescued`
            );
        }
    });

    describe('a file moved beside the flow file that the entry may not use', () => {
        //  Not sent, but not missing either: the file is right there. It must
        //  be reported as such and never pruned, or a relocation would strand
        //  it -- the mail is still on disk, with nothing left pointing at it.
        const loggerModule = require('../core/logger.js');

        const CASES = {
            'a ^ line whose directory is not named like an outbound': {
                name: 'a.pkt',
                line: () => `^/old/spool/out/a.pkt`,
            },
            'a keep line': {
                name: 'd.tic',
                line: () => `/old/outbound/d.tic`,
            },
        };

        Object.entries(CASES).forEach(([label, { name, line }]) => {
            it(`${label}: misfiled, not sent, never pruned`, async () => {
                const beside = path.join(outboundDir(tmpDir), name);
                await fsp.writeFile(beside, 'STILL HERE');
                await fsp.writeFile(flowPath(), `${line()}\n`);

                assert.deepEqual(await listFiles(spool, TEST_ADDR), []);

                const node = (await spool.inspectOutbound()).find(
                    n => 104 === n.address.net && 1 === n.address.node
                );
                assert.equal(node.entries[0].status, 'misfiled');
                assert.equal(node.entries[0].besideFlowFile, beside);

                const dry = await spool.pruneMissingRefs(TEST_ADDR, { dryRun: true });
                assert.deepEqual(dry.removed, []);
                const wet = await spool.pruneMissingRefs(TEST_ADDR, { dryRun: false });
                assert.deepEqual(wet.removed, []);
                assert.equal(await fsp.readFile(flowPath(), 'utf8'), `${line()}\n`);
                assert.ok(await exists(beside));
            });
        });

        it('says so in the warning, distinct from a missing file', async () => {
            await fsp.writeFile(path.join(outboundDir(tmpDir), 'w.pkt'), 'HERE');
            //  A flow file name no other test warns about.
            const ownFlow = path.join(outboundDir(tmpDir), '00680001.hlo');
            await fsp.writeFile(ownFlow, '^/old/spool/out/w.pkt\n');

            const warnings = [];
            const original = loggerModule.log.warn;
            loggerModule.log.warn = (fields, message) =>
                warnings.push({ fields, message });
            try {
                await listFiles(spool, TEST_ADDR);
            } finally {
                loggerModule.log.warn = original;
            }

            const mine = warnings.filter(w => w.fields && w.fields.flowFile === ownFlow);
            assert.equal(mine.length, 1);
            assert.match(mine[0].message, /beside the flow file/);
            assert.doesNotMatch(mine[0].message, /never receive/);
        });

        it('a control file name beside the flow file is still just missing', async () => {
            //  That file belongs to some other node; the entry stays prunable.
            await fsp.writeFile(
                path.join(outboundDir(tmpDir), '00680025.out'),
                'NETMAIL'
            );
            await fsp.writeFile(flowPath(), '/fb/area/00680025.out\n');

            const node = (await spool.inspectOutbound()).find(
                n => 104 === n.address.net && 1 === n.address.node
            );
            assert.equal(node.entries[0].status, 'missing');
        });
    });

    it('does not rescue a reference whose directory is not an outbound', async () => {
        await fsp.writeFile(path.join(outboundDir(tmpDir), 'moved.pkt'), 'PKT');
        await fsp.writeFile(
            flowPath(),
            `^${path.join(tmpDir, 'somewhere', 'moved.pkt')}\n`
        );
        assert.deepEqual(await listFiles(spool, TEST_ADDR), []);
    });
});

describe('BsoSpool — deletes and truncates only inside the mail directories', () => {
    beforeEach(cleanOutbound);

    let outside;
    beforeEach(async () => {
        outside = path.join(tmpDir, 'elsewhere');
        await fsp.rm(outside, { recursive: true, force: true });
        await fsp.mkdir(outside, { recursive: true });
    });

    const flowPath = () => path.join(outboundDir(tmpDir), '00680001.flo');

    it('sends a ^ file outside them but leaves it in place, and marks the line', async () => {
        const file = path.join(outside, 'attach.zip');
        await fsp.writeFile(file, 'ATTACHMENT');
        await fsp.writeFile(flowPath(), `^${file}\n`);

        const files = await listFiles(spool, TEST_ADDR);
        assert.equal(files.length, 1);
        assert.equal(files[0].disposition, 'delete');
        assert.equal(files[0].allowed, false);

        const received = await sendThroughSession(spool, TEST_ADDR);
        assert.deepEqual(received, ['attach.zip'], 'it is still sent');
        assert.equal(await fsp.readFile(file, 'utf8'), 'ATTACHMENT', 'and kept');

        //  Nothing else left live, so the flow file goes as usual.
        const content = await flowContentSettled(flowPath(), c => null === c);
        assert.equal(content, null, 'the entry is finished with as usual');
    });

    it('sends a # file outside them without truncating it', async () => {
        const file = path.join(outside, 'log.txt');
        await fsp.writeFile(file, 'KEEP ME WHOLE');
        await fsp.writeFile(flowPath(), `#${file}\nkeep-the-flow-alive\n`);

        await sendThroughSession(spool, TEST_ADDR);
        assert.equal(await fsp.readFile(file, 'utf8'), 'KEEP ME WHOLE');

        const content = await flowContentSettled(flowPath(), c => c && c.includes('~'));
        assert.ok(content.includes(`~${file}`), `marked sent, got:\n${content}`);
    });

    it('still deletes and truncates inside the outbound and the inbound', async () => {
        const pkt = path.join(outboundDir(tmpDir), 'a1b2c3d4.pkt');
        const trunc = path.join(outboundDir(tmpDir), 'list.txt');
        const inbound = path.join(tmpDir, 'inbound', 'transit.zip');
        await fsp.writeFile(pkt, 'PKT');
        await fsp.writeFile(trunc, 'TRUNC');
        await fsp.writeFile(inbound, 'TRANSIT');
        await fsp.writeFile(flowPath(), `^${pkt}\n#${trunc}\n^${inbound}\n`);

        const files = await listFiles(spool, TEST_ADDR);
        assert.deepEqual(
            files.map(f => f.allowed),
            [true, true, true]
        );

        await sendThroughSession(spool, TEST_ADDR);
        assert.equal(await exists(pkt), false);
        assert.equal((await fsp.stat(trunc)).size, 0);
        assert.equal(await exists(inbound), false);
        await fsp.unlink(trunc).catch(() => {});
    });

    it('carries them out in a directory listed in flowDispositionRoots', async () => {
        const listed = new BsoSpool({
            ...makeConfig(tmpDir),
            flowPaths: { dispositionRoots: [outside] },
        });
        const file = path.join(outside, 'attach.zip');
        await fsp.writeFile(file, 'ATTACHMENT');
        await fsp.writeFile(flowPath(), `^${file}\n`);

        const files = await listFiles(listed, TEST_ADDR);
        assert.equal(files[0].allowed, true);

        await sendThroughSession(listed, TEST_ADDR);
        assert.equal(await exists(file), false);
    });

    it('judges a symlink by where it leads: no truncating a file outside through a link', async () => {
        const target = path.join(outside, 'precious.db');
        await fsp.writeFile(target, 'PRECIOUS');
        const link = path.join(outboundDir(tmpDir), 'innocent.mo1');
        await fsp.symlink(target, link);
        await fsp.writeFile(flowPath(), `#${link}\n`);

        const files = await listFiles(spool, TEST_ADDR);
        assert.equal(files[0].allowed, false);

        await sendThroughSession(spool, TEST_ADDR);
        assert.equal(await fsp.readFile(target, 'utf8'), 'PRECIOUS');
    });

    it('removes a ^ symlink in the outbound, not what it points to', async () => {
        //  unlink() removes the entry, never its target, so a delete is judged
        //  by where the entry is.
        const target = path.join(outside, 'elsewhere.zip');
        await fsp.writeFile(target, 'TARGET');
        const link = path.join(outboundDir(tmpDir), 'linked.zip');
        await fsp.symlink(target, link);
        await fsp.writeFile(flowPath(), `^${link}\n`);

        const files = await listFiles(spool, TEST_ADDR);
        assert.equal(files[0].allowed, true);

        const received = await sendThroughSession(spool, TEST_ADDR);
        assert.deepEqual(received, ['linked.zip'], 'sent');
        assert.equal(await exists(link), false, 'the link is removed');
        assert.equal(await fsp.readFile(target, 'utf8'), 'TARGET', 'the target is not');
    });

    it('never truncates through a symlink, even one inside the outbound', async () => {
        const target = path.join(outboundDir(tmpDir), 'real.txt');
        await fsp.writeFile(target, 'REAL');
        const link = path.join(outboundDir(tmpDir), 'link.txt');
        await fsp.symlink(target, link);
        await fsp.writeFile(flowPath(), `#${link}\n`);

        await sendThroughSession(spool, TEST_ADDR);
        assert.equal(await fsp.readFile(target, 'utf8'), 'REAL');
    });

    it('lists an entry that will be kept as such', async () => {
        const file = path.join(outside, 'attach.zip');
        await fsp.writeFile(file, 'A');
        await fsp.writeFile(flowPath(), `^${file}\n`);

        const node = (await spool.inspectOutbound()).find(
            n => 104 === n.address.net && 1 === n.address.node
        );
        assert.equal(node.entries[0].status, 'pending');
        assert.equal(node.entries[0].dispositionAllowed, false);
    });

    it('warns about a kept entry once per flow file per window', async () => {
        const loggerModule = require('../core/logger.js');
        const throttled = new BsoSpool(
            Object.assign(makeConfig(tmpDir), { flowRefWarnRepeatMs: 60000 })
        );
        await fsp.writeFile(path.join(outside, 'a.zip'), 'A');
        await fsp.writeFile(path.join(outside, 'b.zip'), 'B');
        //  A flow file path no other test uses, so the throttle starts clean.
        const ownFlow = path.join(outboundDir(tmpDir), '00680001.dlo');
        await fsp.writeFile(
            ownFlow,
            `^${path.join(outside, 'a.zip')}\n^${path.join(outside, 'b.zip')}\n`
        );

        const warnings = [];
        const original = loggerModule.log.warn;
        loggerModule.log.warn = (fields, message) => warnings.push({ fields, message });
        try {
            await listFiles(throttled, TEST_ADDR);
            await listFiles(throttled, TEST_ADDR);
        } finally {
            loggerModule.log.warn = original;
        }

        const kept = warnings.filter(w => /outside the mail directories/.test(w.message));
        assert.equal(kept.length, 1);
        assert.match(kept[0].message, /flowDispositionRoots/);
    });
});

describe('BsoSpool — protected directories', () => {
    beforeEach(cleanOutbound);

    let configDir;
    let secret;
    let guarded;

    beforeEach(async () => {
        configDir = path.join(tmpDir, 'config');
        await fsp.mkdir(configDir, { recursive: true });
        secret = path.join(configDir, 'config.hjson');
        await fsp.writeFile(secret, '{ secret: true }');
        guarded = new BsoSpool({
            ...makeConfig(tmpDir),
            flowPaths: { protectedDirs: [configDir] },
        });
    });

    const flowPath = () => path.join(outboundDir(tmpDir), '00680001.flo');

    for (const directive of ['^', '#', '-', '']) {
        it(`never queues a file in one ("${directive}" line)`, async () => {
            await fsp.writeFile(flowPath(), `${directive}${secret}\n`);

            assert.deepEqual(await listFiles(guarded, TEST_ADDR), []);
            assert.deepEqual(
                await guarded.getNodesWithPendingMail(),
                [],
                'and the node is not dialled for it'
            );
        });
    }

    it('shows it as refused, leaves the file and the line alone, and warns at once then per window', async () => {
        const loggerModule = require('../core/logger.js');
        const line = `^${secret}`;
        await fsp.writeFile(flowPath(), `${line}\n`);

        //  A flow file of its own, so no earlier test has used up the window.
        const ownFlow = path.join(outboundDir(tmpDir), '00680001.ilo');
        await fsp.writeFile(ownFlow, `${line}\n`);
        const windowed = new BsoSpool({
            ...makeConfig(tmpDir),
            flowPaths: { protectedDirs: [configDir] },
            flowRefWarnRepeatMs: 60000,
        });

        const warnings = [];
        const original = loggerModule.log.warn;
        loggerModule.log.warn = (fields, message) => warnings.push({ fields, message });
        try {
            await listFiles(windowed, TEST_ADDR);
            await windowed.getNodesWithPendingMail();
            await listFiles(windowed, TEST_ADDR);
        } finally {
            loggerModule.log.warn = original;
        }
        const refusedFor = flow =>
            warnings.filter(
                w => /protected directory/.test(w.message) && w.fields.flowFile === flow
            ).length;
        assert.equal(
            refusedFor(ownFlow),
            1,
            'said straight away, then held for the window'
        );
        await fsp.unlink(ownFlow);

        await sendThroughSession(guarded, TEST_ADDR);
        assert.equal(await fsp.readFile(secret, 'utf8'), '{ secret: true }');
        assert.equal(await fsp.readFile(flowPath(), 'utf8'), `${line}\n`, 'unmarked');

        const node = (await guarded.inspectOutbound()).find(
            n => 104 === n.address.net && 1 === n.address.node
        );
        assert.equal(node.entries[0].status, 'refused');

        //  and prune is not a way to clear it either
        const { removed } = await guarded.pruneMissingRefs(TEST_ADDR, { dryRun: true });
        assert.deepEqual(removed, []);
    });

    it('refuses a link in the outbound that leads into one', async () => {
        const link = path.join(outboundDir(tmpDir), 'harmless.pkt');
        await fsp.symlink(secret, link);
        await fsp.writeFile(flowPath(), `${link}\n`);

        assert.deepEqual(await listFiles(guarded, TEST_ADDR), []);
    });

    it('refuses a direct-attach netmail file that is a link into one', async () => {
        await fsp.symlink(secret, path.join(outboundDir(tmpDir), '00680001.out'));

        assert.deepEqual(await listFiles(guarded, TEST_ADDR), []);
        assert.deepEqual(await guarded.getNodesWithPendingMail(), []);
    });

    it('does not let flowDispositionRoots reach into one', async () => {
        const widened = new BsoSpool({
            ...makeConfig(tmpDir),
            flowPaths: { protectedDirs: [configDir], dispositionRoots: [tmpDir] },
        });
        await fsp.writeFile(flowPath(), `^${secret}\n`);
        assert.deepEqual(await listFiles(widened, TEST_ADDR), []);
    });

    it('keeps mail flowing when the mail directories sit inside one', async () => {
        //  config.hjson kept at the top of the install makes the whole tree
        //  "the directory of the loaded config file". The mail directories
        //  under it are more specific and stay in use; everything else in it
        //  stays refused.
        const wholeTree = new BsoSpool({
            ...makeConfig(tmpDir),
            flowPaths: { protectedDirs: [tmpDir] },
        });
        const pkt = path.join(outboundDir(tmpDir), 'a1b2c3d4.pkt');
        await fsp.writeFile(pkt, 'PKT');
        const loose = path.join(tmpDir, 'loose.txt');
        await fsp.writeFile(loose, 'LOOSE');
        await fsp.writeFile(flowPath(), `^${pkt}\n^${loose}\n`);

        const files = await listFiles(wholeTree, TEST_ADDR);
        assert.deepEqual(
            files.map(f => [f.path, f.allowed]),
            [[pkt, true]]
        );
    });

    it('refuses a fallback onto a file it cannot send', async () => {
        //  The rescue result is checked like any other path: an outbound
        //  placed inside a protected directory with no exemption for it.
        const sealed = new BsoSpool({
            ...makeConfig(tmpDir),
            flowPaths: { protectedDirs: [outboundDir(tmpDir)] },
        });
        await fsp.writeFile(path.join(outboundDir(tmpDir), 'moved.pkt'), 'PKT');
        await fsp.writeFile(flowPath(), `^${zone2Path('moved.pkt')}\n`);

        assert.deepEqual(await listFiles(sealed, TEST_ADDR), []);
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

        const warnings = await captureWarnings(() => listFiles(spool, TEST_ADDR));

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

    it('says it once while the repeat window is open', async () => {
        //  A poll every minute must not put a line in the log every minute.
        //  |flowRefWarnRepeatMs| is a real operator knob (see config_default);
        //  a short one here keeps the test honest without stubbing the clock,
        //  which would shift time for everything else in the process too --
        //  .bsy staleness is clock-based, so that coupling is not hypothetical.
        const quiet = new BsoSpool(
            Object.assign(makeConfig(tmpDir), { flowRefWarnRepeatMs: 60000 })
        );
        await fsp.writeFile(
            path.join(outboundDir(tmpDir), '00680001.flo'),
            `^${path.join(tmpDir, 'gone', 'repeat.zip')}\n`
        );

        const warnings = await captureWarnings(async () => {
            await listFiles(quiet, TEST_ADDR);
            await listFiles(quiet, TEST_ADDR);
            await listFiles(quiet, TEST_ADDR);
        });

        assert.equal(
            warnings.filter(w => w.fields && 'repeat.zip' === w.fields.file).length,
            1,
            'three passes inside the window is still one warning'
        );
    });

    it('says it again once the window has passed', async () => {
        //  The regression that matters: a throttle stuck shut is the silence
        //  this whole change exists to remove.
        const chatty = new BsoSpool(
            Object.assign(makeConfig(tmpDir), { flowRefWarnRepeatMs: 20 })
        );
        await fsp.writeFile(
            path.join(outboundDir(tmpDir), '00680001.flo'),
            `^${path.join(tmpDir, 'gone', 'again.zip')}\n`
        );

        const warnings = await captureWarnings(async () => {
            await listFiles(chatty, TEST_ADDR);
            await new Promise(r => setTimeout(r, 60)); //  3x the window
            await listFiles(chatty, TEST_ADDR);
        });

        assert.equal(
            warnings.filter(w => w.fields && 'again.zip' === w.fields.file).length,
            2,
            'a standing fault has to keep saying so'
        );
    });

    it('reports each missing file, not just the first one seen', async () => {
        const one = path.join(tmpDir, 'gone', 'one.zip');
        const two = path.join(tmpDir, 'gone', 'two.zip');
        await fsp.writeFile(
            path.join(outboundDir(tmpDir), '00680001.flo'),
            `^${one}\n^${two}\n`
        );

        const warnings = await captureWarnings(() => listFiles(spool, TEST_ADDR));

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

//
//  #862. A forwarded file is queued as its payload followed immediately by the
//  generated TIC announcing it. Only the payload can go missing -- the TIC sits
//  in the outbound where we wrote it -- so pruning by "is the file gone?" takes
//  the payload and leaves the announcement queued and sendable. The downlink
//  then collects a TIC for a file it never receives.
//
describe('BsoSpool — pruning a forwarded file takes its TIC with it', () => {
    beforeEach(cleanOutbound);

    //  What forwardTicToOneDownlink() writes: payload with no directive (it
    //  lives in our file base), then its TIC with '^' (disposable), in one
    //  append so the pair stays adjacent.
    async function seedForward({ payloadExists = false } = {}) {
        const payload = path.join(tmpDir, 'filebase', 'NODELIST.246');
        const ticPath = path.join(outboundDir(tmpDir), '0a1b2c3d.tic');
        const flowPath = path.join(outboundDir(tmpDir), '00680001.flo');

        if (payloadExists) {
            await fsp.mkdir(path.dirname(payload), { recursive: true });
            await fsp.writeFile(payload, 'NODELIST');
        }
        await fsp.writeFile(ticPath, 'Area NODELIST\r\nFile NODELIST.246\r\n');
        await fsp.writeFile(flowPath, `${payload}\n^${ticPath}\n`);

        return { payload, ticPath, flowPath };
    }

    const exists = p =>
        fsp
            .access(p)
            .then(() => true)
            .catch(() => false);

    it('dequeues the TIC announcing a payload that has gone', async () => {
        const { payload, ticPath, flowPath } = await seedForward();

        await spool.pruneMissingRefs(TEST_ADDR, { dryRun: false });

        const content = await fsp.readFile(flowPath, 'utf8').catch(() => '');
        assert.ok(!content.includes(payload), 'the missing payload must be gone');
        assert.ok(
            !content.includes(ticPath),
            'and so must the TIC announcing it -- otherwise the downlink ' +
                'receives an announcement for a file we never send'
        );
    });

    it('unlinks the TIC, which nothing references any more', async () => {
        const { ticPath } = await seedForward();

        await spool.pruneMissingRefs(TEST_ADDR, { dryRun: false });

        assert.equal(
            await exists(ticPath),
            false,
            "a '^' file with no reference left would sit in the outbound forever"
        );
    });

    it('reports the TIC as well, so the operator is not told half a story', async () => {
        const { payload, ticPath } = await seedForward();

        const { removed } = await spool.pruneMissingRefs(TEST_ADDR, { dryRun: false });

        assert.deepEqual(
            removed.map(e => e.path).sort(),
            [payload, ticPath].sort(),
            'both lines went, so both must be reported'
        );
        assert.deepEqual(
            removed.filter(e => 'companion' === e.status).map(e => e.path),
            [ticPath],
            'the TIC is distinguishable from a second missing file'
        );
    });

    it('leaves a forward whose payload is still there completely alone', async () => {
        //  The ordinary case, and the one that must not regress: nothing is
        //  missing, so nothing is pruned and the pair ships as queued.
        const { payload, ticPath, flowPath } = await seedForward({
            payloadExists: true,
        });
        const before = await fsp.readFile(flowPath, 'utf8');

        const { removed } = await spool.pruneMissingRefs(TEST_ADDR, { dryRun: false });

        assert.deepEqual(removed, []);
        assert.equal(await fsp.readFile(flowPath, 'utf8'), before);
        assert.ok(await exists(ticPath), 'the TIC must still be on disk');
        assert.ok(await exists(payload), 'and so must the payload');
    });

    it('does not take a TIC that has already been sent', async () => {
        //  '~' means the downlink has it. Removing the line changes nothing
        //  it holds, and unlinking the file destroys the record.
        const payload = path.join(tmpDir, 'filebase', 'GONE.246');
        const ticPath = path.join(outboundDir(tmpDir), 'deadbeef.tic');
        const flowPath = path.join(outboundDir(tmpDir), '00680001.flo');

        //  Something still sendable, so the flow file survives the prune and
        //  can be read back -- an all-'~' file is removed outright.
        const live = path.join(outboundDir(tmpDir), 'live.pkt');
        await fsp.writeFile(live, 'LIVE');
        await fsp.writeFile(ticPath, 'Area NODELIST\r\n');
        await fsp.writeFile(flowPath, `${payload}\n~${ticPath}\n^${live}\n`);

        await spool.pruneMissingRefs(TEST_ADDR, { dryRun: false });

        assert.ok(await exists(ticPath), 'a sent TIC must survive');
        assert.ok(
            (await fsp.readFile(flowPath, 'utf8')).includes(`~${ticPath}`),
            'and so must its sent marker'
        );
    });

    it('unlinks the TIC even when the outbound tree has moved', async () => {
        //
        //  resolveFlowRef() deliberately falls back to the referenced basename
        //  beside the flow file when the stored absolute path no longer
        //  resolves -- a relocated outbound, or a sysop recovering mail filed
        //  in the wrong directory. Unlinking the raw reference text therefore
        //  missed the file in exactly the case that fallback exists for,
        //  dequeuing the line and leaving the orphan this is meant to remove.
        //
        const dir = outboundDir(tmpDir);
        const flowPath = path.join(dir, '00680001.flo');

        //  Both references carry a path from the *old* location; only the TIC
        //  is actually present, beside the flow file.
        const stalePayload = '/old/enigma/filebase/NODELIST.246';
        const staleTic = '/old/enigma/outbound/0a1b2c3d.tic';
        const realTic = path.join(dir, '0a1b2c3d.tic');
        await fsp.writeFile(realTic, 'Area NODELIST\r\n');
        await fsp.writeFile(flowPath, `${stalePayload}\n^${staleTic}\n`);

        const { removed } = await spool.pruneMissingRefs(TEST_ADDR, { dryRun: false });

        assert.equal(
            await exists(realTic),
            false,
            'the TIC beside the flow file is the one the reference resolves to'
        );
        assert.deepEqual(
            removed.filter(e => 'companion' === e.status).map(e => e.path),
            [realTic],
            'and the operator is shown the path that actually went'
        );
    });

    it("never unlinks outside the flow file's own directory", async () => {
        //
        //  A generated TIC is always written beside its flow file, so that is
        //  both the right fallback and a containment rule. The reference is the
        //  one part of a flow file we did not necessarily write, and oputil runs
        //  as whatever user the operator is, from an arbitrary directory.
        //
        const dir = outboundDir(tmpDir);
        const flowPath = path.join(dir, '00680001.flo');

        const outsider = path.join(tmpDir, 'passwd.tic');
        await fsp.writeFile(outsider, 'NOT OURS');

        await fsp.writeFile(
            flowPath,
            `${path.join(tmpDir, 'gone', 'x.zip')}\n^../passwd.tic\n`
        );

        await spool.pruneMissingRefs(TEST_ADDR, { dryRun: false });

        assert.ok(
            await exists(outsider),
            'a traversing reference must not reach outside the outbound directory'
        );
    });

    it('leaves the flow file alone when the rewrite fails', async () => {
        //
        //  Unlinking before writing meant a failed rewrite left the flow file
        //  naming TICs that no longer existed -- the dangling reference #735 is
        //  about -- while the caller reported the entries as merely busy.
        //
        const dir = outboundDir(tmpDir);
        const flowPath = path.join(dir, '00680001.flo');
        const ticPath = path.join(dir, 'deadbeef.tic');
        const gone = path.join(tmpDir, 'gone', 'vanished.zip');
        const live = path.join(dir, 'live.pkt');

        await fsp.writeFile(live, 'LIVE');
        await fsp.writeFile(ticPath, 'Area A\r\n');
        await fsp.writeFile(flowPath, `${gone}\n^${ticPath}\n^${live}\n`);
        const before = await fsp.readFile(flowPath, 'utf8');

        //  Make the rewrite fail the way a full or read-only volume would:
        //  the new copy cannot be put in place.
        const realRename = fsp.rename;
        fsp.rename = async (from, to, ...rest) => {
            if (to === flowPath) {
                const err = new Error('ENOSPC: no space left on device');
                err.code = 'ENOSPC';
                throw err;
            }
            return realRename(from, to, ...rest);
        };

        try {
            await spool.pruneMissingRefs(TEST_ADDR, { dryRun: false });
        } finally {
            fsp.rename = realRename;
        }

        assert.deepEqual(
            (await fsp.readdir(dir)).filter(n => n.startsWith('.enigma-flow-')),
            [],
            'and the temporary copy is cleaned up'
        );

        assert.equal(
            await fsp.readFile(flowPath, 'utf8'),
            before,
            'the flow file must be untouched'
        );
        assert.ok(
            await exists(ticPath),
            'and its TIC must still exist, or the reference dangles'
        );
    });

    it('takes only the TIC belonging to the payload that went', async () => {
        const keep = path.join(tmpDir, 'filebase', 'KEEP.ZIP');
        const keepTic = path.join(outboundDir(tmpDir), '11111111.tic');
        const gone = path.join(tmpDir, 'filebase', 'GONE.ZIP');
        const goneTic = path.join(outboundDir(tmpDir), '22222222.tic');
        const flowPath = path.join(outboundDir(tmpDir), '00680001.flo');

        await fsp.mkdir(path.dirname(keep), { recursive: true });
        await fsp.writeFile(keep, 'KEEP');
        await fsp.writeFile(keepTic, 'Area A\r\n');
        await fsp.writeFile(goneTic, 'Area A\r\n');
        await fsp.writeFile(flowPath, `${keep}\n^${keepTic}\n${gone}\n^${goneTic}\n`);

        await spool.pruneMissingRefs(TEST_ADDR, { dryRun: false });

        const content = await fsp.readFile(flowPath, 'utf8');
        assert.ok(content.includes(keep), 'the live payload must survive');
        assert.ok(content.includes(keepTic), 'and the TIC announcing it');
        assert.ok(!content.includes(gone), 'the missing payload must go');
        assert.ok(!content.includes(goneTic), 'and the TIC announcing it');
        assert.ok(await exists(keepTic), 'the live TIC must still be on disk');
        assert.equal(await exists(goneTic), false, 'the dequeued one must not');
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

        const files = await listFiles(spool, TEST_ADDR);
        assert.equal(files.length, 1, 'per-node lookup must find it');
        assert.equal(path.basename(files[0].path), 'UPPER.PKT');

        const nodes = await spool.getNodesWithPendingMail();
        assert.equal(nodes.length, 1, 'scan and lookup must agree');

        await fsp.unlink(refFile);
    });

    it('finds an upper case direct-attach file', async () => {
        await fsp.writeFile(path.join(outboundDir(tmpDir), '00680001.CUT'), 'PKTDATA');

        const files = await listFiles(spool, TEST_ADDR);
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

        const files = await listFiles(spool, TEST_ADDR);
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

        const files = await listFiles(spool, POINT_ADDR);
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

        const files = await listFiles(spool, POINT_ADDR);
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
            (await listFiles(spool, TEST_ADDR)).map(f => path.basename(f.path)),
            ['boss_own.pkt'],
            'the boss node gets its own mail, not the point’s'
        );
        assert.deepEqual(
            (await listFiles(spool, POINT_ADDR)).map(f => path.basename(f.path)),
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

        const files = await listFiles(spool, POINT_ADDR);
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
                slowSpool.getOutboundFilesForNode = async (addr, opts) => {
                    await new Promise(r => setTimeout(r, 120));
                    return spool.getOutboundFilesForNode(addr, opts);
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

// ── flow line directives, read and written through core/bso_flow.js ─────────

describe('BsoSpool — every directive, read the way other mailers read it', () => {
    beforeEach(cleanOutbound);

    const flowPath = () => path.join(outboundDir(tmpDir), '00680001.flo');
    const latin1 = s => Buffer.from(s, 'latin1');

    function entriesFor(report) {
        const node = report.find(
            n => 104 === n.address.net && 1 === n.address.node && !n.address.point
        );
        return node ? node.entries : [];
    }

    async function packet(name, content = 'PKT') {
        const p = path.join(outboundDir(tmpDir), name);
        await fsp.writeFile(p, content);
        return p;
    }

    it("'!' is skip: not sent, not pending, listed as skip", async () => {
        const p = await packet('skipme.pkt');
        await fsp.writeFile(flowPath(), `!${p}\n`);

        assert.deepEqual(await listFiles(spool, TEST_ADDR), []);
        assert.deepEqual(await spool.getNodesWithPendingMail(), []);
        const entries = entriesFor(await spool.inspectOutbound());
        assert.equal(entries.length, 1);
        assert.equal(entries[0].status, 'skip');
        assert.equal(entries[0].path, p);
    });

    it("'@' is send and keep", async () => {
        const p = await packet('keepme.pkt');
        await fsp.writeFile(flowPath(), `@${p}\n`);

        const files = await lockedFiles(spool, TEST_ADDR);
        assert.equal(files.length, 1);
        assert.equal(files[0].path, p);
        assert.equal(files[0].disposition, 'keep');
        assert.equal((await spool.getNodesWithPendingMail()).length, 1);

        await files[0].disposeFn();
        await assert.rejects(fsp.access(flowPath()), { code: 'ENOENT' });
        await assert.doesNotReject(fsp.access(p), 'kept');
    });

    it('an unknown leading character is not sent, warned about, listed, and kept', async () => {
        const p = await packet('dollar.pkt');
        const other = await packet('other.pkt');
        await fsp.writeFile(flowPath(), `$${p}\n^${other}\n`);

        const loggerModule = require('../core/logger.js');
        const warnings = [];
        const original = loggerModule.log.warn;
        loggerModule.log.warn = (fields, message) => warnings.push({ fields, message });
        let files;
        try {
            files = await lockedFiles(spool, TEST_ADDR);
        } finally {
            loggerModule.log.warn = original;
        }

        assert.deepEqual(
            files.map(f => f.path),
            [other]
        );
        assert.ok(
            warnings.some(w => /not a directive and path/.test(w.message)),
            JSON.stringify(warnings)
        );

        const entries = entriesFor(await spool.inspectOutbound());
        const unknown = entries.find(e => 'unknown' === e.status);
        assert.ok(unknown, JSON.stringify(entries));
        assert.equal(unknown.line, `$${p}`);

        //  Sending the rest does not remove the line, or the flow file.
        await files[0].disposeFn();
        assert.equal(await fsp.readFile(flowPath(), 'utf8'), `$${p}\n~${other}\n`);
    });

    it('an invalid line (NUL) is not sent, not pruned, and keeps its flow file', async () => {
        const other = await packet('other.pkt');
        const bad = `^${path.join(outboundDir(tmpDir), 'a')}\x00b.pkt`;
        await fsp.writeFile(flowPath(), `${bad}\n^${other}\n`);

        const files = await lockedFiles(spool, TEST_ADDR);
        assert.deepEqual(
            files.map(f => f.path),
            [other]
        );

        const entries = entriesFor(await spool.inspectOutbound());
        assert.equal(
            entries.find(e => 'invalid' === e.status).reason,
            'control character'
        );

        const { removed } = await spool.pruneMissingRefs(TEST_ADDR, { dryRun: false });
        assert.deepEqual(removed, []);

        await files[0].disposeFn();
        assert.equal(await fsp.readFile(flowPath(), 'latin1'), `${bad}\n~${other}\n`);
    });

    it('a bare relative name resolves beside the flow file, never in the working directory', async () => {
        const cwdDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'enigma_bso_cwd_'));
        await fsp.mkdir(path.join(cwdDir, 'config'));
        const decoy = path.join(cwdDir, 'config', 'x.hjson');
        await fsp.writeFile(decoy, 'DECOY');

        const prevCwd = process.cwd();
        process.chdir(cwdDir);
        try {
            await fsp.writeFile(flowPath(), '^config/x.hjson\n');
            assert.deepEqual(await listFiles(spool, TEST_ADDR), []);
            assert.equal(entriesFor(await spool.inspectOutbound())[0].status, 'missing');

            //  The same name beside the flow file is what it means.
            const beside = await packet('rel.pkt');
            await fsp.writeFile(flowPath(), '^rel.pkt\n');
            const files = await listFiles(spool, TEST_ADDR);
            assert.deepEqual(
                files.map(f => f.path),
                [beside]
            );
            assert.equal(files[0].disposition, 'delete');
            assert.equal(await fsp.readFile(decoy, 'utf8'), 'DECOY');
        } finally {
            process.chdir(prevCwd);
            await fsp.rm(cwdDir, { recursive: true, force: true });
        }
    });

    it('queues the same line once, and sending it marks every copy', async () => {
        const p = await packet('dup.pkt');
        const keep = await packet('keep.pkt');
        await fsp.writeFile(flowPath(), `^${p}\n${keep}\n^${p}\n`);

        const files = await lockedFiles(spool, TEST_ADDR);
        assert.deepEqual(
            files.map(f => f.path),
            [p, keep]
        );

        await files[0].disposeFn();
        assert.equal(await fsp.readFile(flowPath(), 'utf8'), `~${p}\n${keep}\n~${p}\n`);
    });

    it('marking a line keeps other lines byte for byte: latin1, CRLF, a BinkleyTerm space', async () => {
        const p = await packet('mine.pkt');
        const before = Buffer.concat([
            latin1('/fb/caf\xe9.zip\r\n'),
            latin1(`^${p}\r\n`),
            latin1(' /fb/old-style.zip\n'),
            Buffer.from('/fb/naïve.zip\n', 'utf8'),
        ]);
        await fsp.writeFile(flowPath(), before);

        const files = await lockedFiles(spool, TEST_ADDR);
        assert.deepEqual(
            files.map(f => f.path),
            [p]
        );
        await files[0].disposeFn();

        const after = await fsp.readFile(flowPath());
        assert.ok(
            after.equals(
                Buffer.concat([
                    latin1('/fb/caf\xe9.zip\r\n'),
                    latin1(`~${p}\r\n`),
                    latin1(' /fb/old-style.zip\n'),
                    Buffer.from('/fb/naïve.zip\n', 'utf8'),
                ])
            ),
            after.toString('latin1')
        );
    });

    it('a path that is not UTF-8 is not sent; listed as invalid while there, missing when gone', async () => {
        const dir = outboundDir(tmpDir);
        const name = latin1('caf\xe9.pkt');
        await fsp.writeFile(Buffer.concat([Buffer.from(`${dir}/`), name]), 'PKT');
        await fsp.writeFile(
            flowPath(),
            Buffer.concat([latin1('^'), Buffer.from(`${dir}/`), name, latin1('\n')])
        );

        assert.deepEqual(await listFiles(spool, TEST_ADDR), []);
        assert.deepEqual(await spool.getNodesWithPendingMail(), []);
        let entries = entriesFor(await spool.inspectOutbound());
        assert.equal(entries[0].status, 'invalid');
        assert.match(entries[0].reason, /UTF-8/);

        await fsp.unlink(Buffer.concat([Buffer.from(`${dir}/`), name]));
        entries = entriesFor(await spool.inspectOutbound());
        assert.equal(entries[0].status, 'missing');
    });

    it('never deletes a pre-existing zero-length flow file (a poll request) when pruning or marking', async () => {
        const dlo = path.join(outboundDir(tmpDir), '00680001.dlo');
        await fsp.writeFile(dlo, '');

        //  Nothing to send, but the node is due a call (#1047), and the
        //  listing says why.
        assert.deepEqual(await listFiles(spool, TEST_ADDR), []);
        assert.deepEqual(
            (await spool.getNodesWithPendingMail()).map(a => a.toString()),
            ['1:104/1']
        );
        assert.deepEqual(
            entriesFor(await spool.inspectOutbound()).map(e => [e.status, e.path]),
            [['poll', dlo]]
        );
        await spool.pruneMissingRefs(TEST_ADDR, { dryRun: false });

        //  And sending another flavour's last entry leaves it alone.
        const p = await packet('crash.pkt');
        await fsp.writeFile(flowPath(), `^${p}\n`);
        const files = await lockedFiles(spool, TEST_ADDR);
        await files[0].disposeFn();

        assert.equal((await fsp.stat(dlo)).size, 0);
    });

    it('an empty flow file is not unreadable to the transit sweep', async () => {
        await fsp.writeFile(flowPath(), '');
        const unreadable = [];
        await spool.inspectOutbound({ onUnreadable: p => unreadable.push(p) });
        assert.deepEqual(unreadable, []);
    });

    it('a listing taken while a line is being marked still sees every reference', async () => {
        //  The transit sweep deletes what no flow file references. A flow
        //  file read mid-rewrite used to come back empty, so a payload still
        //  owed to a downlink looked unreferenced.
        const p = await packet('sent.pkt');
        const payload = path.join(tmpDir, 'transit-payload.zip');
        await fsp.writeFile(payload, 'PAYLOAD');
        await fsp.writeFile(flowPath(), `^${p}\n${payload}\n`);

        const files = await lockedFiles(spool, TEST_ADDR);
        const realRename = fsp.rename;
        let listing;
        const unreadable = [];
        fsp.rename = async (from, to) => {
            if (to === flowPath()) {
                listing = await spool.inspectOutbound({
                    onUnreadable: f => unreadable.push(f),
                });
            }
            return realRename(from, to);
        };
        try {
            await files[0].disposeFn();
        } finally {
            fsp.rename = realRename;
        }

        assert.deepEqual(unreadable, []);
        assert.ok(
            entriesFor(listing).some(e => e.path === payload),
            JSON.stringify(entriesFor(listing))
        );
        assert.equal(await fsp.readFile(flowPath(), 'utf8'), `~${p}\n${payload}\n`);
    });

    it('treats a zero-length read of a non-empty flow file as unreadable', async () => {
        await fsp.writeFile(flowPath(), `^${path.join(tmpDir, 'x.pkt')}\n`);
        const realOpen = fsp.open;
        fsp.open = async (...args) => {
            const fh = await realOpen(...args);
            if (args[0] === flowPath()) {
                fh.readFile = async () => Buffer.alloc(0);
            }
            return fh;
        };
        const unreadable = [];
        try {
            await spool.inspectOutbound({ onUnreadable: f => unreadable.push(f) });
        } finally {
            fsp.open = realOpen;
        }
        assert.deepEqual(unreadable, [flowPath()]);
    });

    it('prune keeps other lines byte for byte and removes a ~-only result', async () => {
        const gone = path.join(tmpDir, 'gone', 'vanished.pkt');
        await fsp.writeFile(
            flowPath(),
            Buffer.concat([latin1(`^${gone}\r\n`), latin1('~/fb/caf\xe9.zip\r\n')])
        );
        const { removed } = await spool.pruneMissingRefs(TEST_ADDR, { dryRun: false });
        assert.equal(removed.length, 1);
        await assert.rejects(fsp.access(flowPath()), { code: 'ENOENT' });

        const live = await packet('live.pkt');
        await fsp.writeFile(
            flowPath(),
            Buffer.concat([
                latin1(`!/fb/caf\xe9.zip\r\n`),
                latin1(`^${gone}\n`),
                latin1(`^${live}\r\n`),
            ])
        );
        await spool.pruneMissingRefs(TEST_ADDR, { dryRun: false });
        assert.ok(
            (await fsp.readFile(flowPath())).equals(
                Buffer.concat([latin1(`!/fb/caf\xe9.zip\r\n`), latin1(`^${live}\r\n`)])
            )
        );
    });

    it('reaps a temporary file left by an unfinished rewrite once it is stale', async () => {
        const old = path.join(outboundDir(tmpDir), '.enigma-flow-00680001.flo.1.aa.tmp');
        const fresh = path.join(
            outboundDir(tmpDir),
            '.enigma-flow-00680001.flo.2.bb.tmp'
        );
        await fsp.writeFile(old, 'x');
        await fsp.writeFile(fresh, 'x');
        const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
        await fsp.utimes(old, past, past);

        const reaper = new BsoSpool({
            ...makeConfig(tmpDir),
            staleLockMaxAgeMs: 60 * 1000,
        });
        await reaper.reapStaleLocks();

        await assert.rejects(fsp.access(old), { code: 'ENOENT' });
        await assert.doesNotReject(fsp.access(fresh));
    });
});

describe('attachSpoolToSession — the same file listed twice', () => {
    it('marks both lines when the file is sent', async () => {
        const EventEmitter = require('events');
        const session = new EventEmitter();
        session.queueFile = () => {};

        const calls = [];
        const entry = n => ({
            path: '/ob/x.pkt',
            name: 'x.pkt',
            size: 3,
            timestamp: 1000,
            disposition: 'delete',
            disposeFn: async () => calls.push(n),
        });
        const fakeSpool = {
            getOutboundFilesForNode: async () => [entry(1), entry(2)],
            receiveFile: async () => {},
        };

        const disposeMap = await attachSpoolToSession(session, fakeSpool, [TEST_ADDR], {
            lock: new FlowLockSet(),
        });
        await disposeMap.get('x.pkt\u00003\u00001000')();
        assert.deepEqual(calls, [1, 2]);
    });
});

describe('BsoSpool — the session locks every directory holding the node', () => {
    //  With makeConfig, testnet is the default network, so its pre-0.5.1-beta
    //  directory "testnet/" is a legacy directory the spool still drains.
    const legacyDir = () => path.join(tmpDir, 'testnet');
    const canonicalBsy = () => path.join(outboundDir(tmpDir), '00680001.bsy');
    const legacyBsy = () => path.join(legacyDir(), '00680001.bsy');
    const legacyFlow = () => path.join(legacyDir(), '00680001.flo');
    const exists = p =>
        fsp.access(p).then(
            () => true,
            () => false
        );

    beforeEach(cleanOutbound);
    afterEach(() => fsp.rm(legacyDir(), { recursive: true, force: true }));

    it('covers each directory that exists, creating none', async () => {
        assert.deepEqual(await spool.lockPathsForNode(TEST_ADDR), [canonicalBsy()]);
        await fsp.mkdir(legacyDir());
        assert.deepEqual(await spool.lockPathsForNode(TEST_ADDR), [
            canonicalBsy(),
            legacyBsy(),
        ]);
        assert.equal(await exists(legacyBsy()), false, 'listing creates nothing');
    });

    it('marks a legacy directory flow file under the lock beside it', async () => {
        await fsp.mkdir(legacyDir());
        const pkt = path.join(legacyDir(), 'legacy.pkt');
        await fsp.writeFile(pkt, 'PKT');
        await fsp.writeFile(legacyFlow(), `^${pkt}\n/fb/keep.zip\n`);

        const lock = spool.newLockSet();
        assert.equal(await spool.lockNode(TEST_ADDR, lock), true);
        try {
            assert.ok(await exists(legacyBsy()), 'the legacy directory is locked');

            //  Another writer of that flow file is kept out for the session.
            const { withFlowFileLock, isBusyError } = require('../core/bso_lock');
            const busy = await new Promise(resolve =>
                withFlowFileLock(
                    legacyFlow(),
                    { timeoutMs: 100 },
                    done => done(null),
                    err => resolve(isBusyError(err))
                )
            );
            assert.ok(busy, 'a writer beside the legacy flow file finds it locked');

            const files = await spool.getOutboundFilesForNode(TEST_ADDR, { lock });
            assert.deepEqual(
                files.map(f => f.path),
                [pkt]
            );
            await files[0].disposeFn();
            assert.equal(
                await fsp.readFile(legacyFlow(), 'utf8'),
                `~${pkt}\n/fb/keep.zip\n`
            );
        } finally {
            await lock.releaseAll();
        }
        assert.equal(await exists(legacyBsy()), false);
        assert.equal(await exists(canonicalBsy()), false);
    });

    //  The session deletes or truncates a sent file only while it still
    //  holds the lock covering it (BinkpSession._applyDisposition).
    it('reports, per file, whether the lock covering it is still held', async () => {
        await fsp.mkdir(outboundDir(tmpDir), { recursive: true });
        const pkt = path.join(outboundDir(tmpDir), 'queued.pkt');
        await fsp.writeFile(pkt, 'PKT');
        await fsp.writeFile(path.join(outboundDir(tmpDir), '00680001.flo'), `^${pkt}\n`);
        await fsp.writeFile(path.join(outboundDir(tmpDir), '00680001.out'), 'NETMAIL');

        const lock = spool.newLockSet();
        assert.equal(await spool.lockNode(TEST_ADDR, lock), true);
        try {
            const files = await spool.getOutboundFilesForNode(TEST_ADDR, { lock });
            assert.equal(files.length, 2);
            assert.ok(
                files.every(f => f.stillLocked()),
                'held'
            );

            //  Removed underneath the session.
            await fsp.unlink(canonicalBsy());
            await require('../core/bso_lock')._refreshHeldNow();
            assert.ok(
                files.every(f => !f.stillLocked()),
                'no longer held'
            );
        } finally {
            await lock.releaseAll();
        }
    });

    it('does not read a flow file in a directory the lock does not cover', async () => {
        await fsp.mkdir(legacyDir());
        const pkt = path.join(legacyDir(), 'legacy.pkt');
        await fsp.writeFile(pkt, 'PKT');
        await fsp.writeFile(legacyFlow(), `^${pkt}\n`);

        //  Only the canonical lock, as a session that started before the
        //  legacy directory appeared would hold.
        const lock = spool.newLockSet();
        assert.equal(await lock.acquire([canonicalBsy()]), true);
        try {
            assert.deepEqual(
                await spool.getOutboundFilesForNode(TEST_ADDR, { lock }),
                []
            );
        } finally {
            await lock.releaseAll();
        }
    });

    it('is all or nothing: a busy legacy lock leaves the canonical one untaken', async () => {
        await fsp.mkdir(legacyDir());
        await fsp.writeFile(legacyBsy(), '4242'); //  held by another process

        const lock = spool.newLockSet();
        assert.equal(await spool.lockNode(TEST_ADDR, lock), false);
        assert.equal(lock.size, 0);
        assert.equal(await exists(canonicalBsy()), false);
        assert.equal(
            await fsp.readFile(legacyBsy(), 'utf8'),
            '4242',
            'not ours to touch'
        );
    });

    it('refuses to list without the lock set, or with a lookalike', async () => {
        const { isNotHeldError } = require('../core/bso_lock');
        await fsp.writeFile(
            path.join(outboundDir(tmpDir), '00680001.flo'),
            '/fb/x.zip\n'
        );
        for (const opts of [
            undefined,
            {},
            { lock: { holds: () => true, closed: false } },
        ]) {
            await assert.rejects(spool.getOutboundFilesForNode(TEST_ADDR, opts), err =>
                isNotHeldError(err)
            );
        }
        await assert.rejects(
            spool._parseFlowFile(
                path.join(outboundDir(tmpDir), '00680001.flo'),
                TEST_ADDR
            ),
            err => isNotHeldError(err)
        );
    });

    it('a closed lock set lists nothing, even part way through', async () => {
        const pkt = path.join(outboundDir(tmpDir), 'closed.pkt');
        await fsp.writeFile(pkt, 'PKT');
        await fsp.writeFile(path.join(outboundDir(tmpDir), '00680001.flo'), `^${pkt}\n`);
        const lock = spool.newLockSet();
        assert.ok(await spool.lockNode(TEST_ADDR, lock));
        await lock.close();
        assert.deepEqual(await spool.getOutboundFilesForNode(TEST_ADDR, { lock }), []);
        assert.equal(await spool.lockNode(TEST_ADDR, lock), false, 'closed for good');
        assert.equal(await exists(canonicalBsy()), false);
    });

    describe('a point directory spelled in upper case', () => {
        const POINT = { zone: 1, net: 104, node: 1, point: 45 };
        const upperDir = () => path.join(outboundDir(tmpDir), '00680001.PNT');
        const lowerDir = () => path.join(outboundDir(tmpDir), '00680001.pnt');

        async function queuePointMail() {
            await fsp.mkdir(upperDir());
            const pkt = path.join(upperDir(), 'point.pkt');
            await fsp.writeFile(pkt, 'PKT');
            await fsp.writeFile(path.join(upperDir(), '0000002D.CLO'), `^${pkt}\n`);
            return pkt;
        }

        for (const createDirs of [false, true]) {
            it(`is locked and read where it is, with no second spelling made (createDirs: ${createDirs})`, async () => {
                const pkt = await queuePointMail();
                const lock = spool.newLockSet();
                assert.ok(await spool.lockNode(POINT, lock, { createDirs }));
                try {
                    assert.deepEqual(lock.paths, [path.join(upperDir(), '0000002d.bsy')]);
                    assert.equal(await exists(lowerDir()), false);
                    const files = await spool.getOutboundFilesForNode(POINT, { lock });
                    assert.deepEqual(
                        files.map(f => f.path),
                        [pkt]
                    );
                } finally {
                    await lock.releaseAll();
                }
                assert.equal(await exists(lowerDir()), false);
            });
        }
    });

    it('is re-entrant on a lock the set already holds', async () => {
        const lock = spool.newLockSet();
        assert.equal(await spool.lockNode(TEST_ADDR, lock), true);
        try {
            assert.equal(await spool.lockNode(TEST_ADDR, lock), true);
            assert.equal(await spool.lockNode(TEST_ADDR, spool.newLockSet()), false);
        } finally {
            await lock.releaseAll();
        }
        assert.equal(await exists(canonicalBsy()), false);
    });
});

describe('attachSpoolToSession — settle() before the lock is released', () => {
    const EventEmitter = require('events');

    async function attached(disposeFn) {
        const session = new EventEmitter();
        session.queueFile = () => {};
        const fakeSpool = {
            getOutboundFilesForNode: async () => [
                {
                    path: '/ob/x.pkt',
                    name: 'x.pkt',
                    size: 3,
                    timestamp: 1000,
                    disposition: 'delete',
                    disposeFn,
                },
            ],
            receiveFile: async () => {},
        };
        const disposeMap = await attachSpoolToSession(session, fakeSpool, [TEST_ADDR], {
            lock: new FlowLockSet(),
        });
        return { session, disposeMap };
    }

    it('resolves at once when nothing is in flight', async () => {
        const { disposeMap } = await attached(async () => {});
        assert.equal(disposeMap.pending, 0);
        assert.equal(await disposeMap.settle(), true);
    });

    it('waits for a flow file rewrite still running when the session ends', async () => {
        let release;
        const gate = new Promise(r => (release = r));
        let finished = false;
        const { session, disposeMap } = await attached(async () => {
            await gate;
            finished = true;
        });

        session.emit('file-sent', 'x.pkt', 3, 1000);
        assert.equal(disposeMap.pending, 1, 'tracked as soon as the file is sent');

        let settled = null;
        const settling = disposeMap.settle().then(v => (settled = v));
        await new Promise(r => setTimeout(r, 50));
        assert.equal(settled, null, 'still waiting for the rewrite');

        release();
        assert.equal(await settling, true);
        assert.ok(finished, 'the rewrite finished before settle() resolved');
        assert.equal(disposeMap.pending, 0);
    });

    it('does not reject when the rewrite fails', async () => {
        const { session, disposeMap } = await attached(async () => {
            throw new Error('disk full');
        });
        session.emit('file-sent', 'x.pkt', 3, 1000);
        assert.equal(await disposeMap.settle(), true);
    });

    it('gives up after the timeout so a stuck write cannot hold the lock forever', async () => {
        const { session, disposeMap } = await attached(() => new Promise(() => {}));
        session.emit('file-sent', 'x.pkt', 3, 1000);
        const started = Date.now();
        assert.equal(await disposeMap.settle(50), false);
        assert.ok(Date.now() - started < 1000);
    });
});

describe('BsoSpool — a real session marks lines and keeps the rest byte for byte', () => {
    beforeEach(cleanOutbound);

    it('marks every copy of what was sent, deletes the ^ file, and leaves other lines exactly as they were', done => {
        const dir = outboundDir(tmpDir);
        const flowPath = path.join(dir, '00020002.flo'); //  1:2/2, the caller
        const pkt = path.join(dir, 'aabbccdd.pkt');
        const foreign = Buffer.from('!/fb/caf\xe9.zip\r\n', 'latin1');

        const received = [];
        const finish = err => {
            server.close();
            done(err);
        };

        const check = async () => {
            //  Flow file bookkeeping runs on 'file-sent' and is not awaited
            //  by the session, so give it a moment.
            const deadline = Date.now() + 2000;
            let content;
            for (;;) {
                content = await fsp.readFile(flowPath);
                if (!content.includes(Buffer.from(`^${pkt}`)) || Date.now() > deadline)
                    break;
                await new Promise(r => setTimeout(r, 20));
            }
            assert.deepEqual(received, ['aabbccdd.pkt'], 'sent once');
            assert.ok(
                content.equals(
                    Buffer.concat([
                        foreign,
                        Buffer.from(`~${pkt}\n$kept-by-other-software\n~${pkt}\n`),
                    ])
                ),
                content.toString('latin1')
            );
            await assert.rejects(fsp.access(pkt), { code: 'ENOENT' });
        };

        let server;
        fsp.writeFile(pkt, 'PKT')
            .then(() =>
                fsp.writeFile(
                    flowPath,
                    Buffer.concat([
                        foreign,
                        Buffer.from(`^${pkt}\n$kept-by-other-software\n^${pkt}\n`),
                    ])
                )
            )
            .then(() => {
                server = net.createServer(serverSocket => {
                    const serverSess = new BinkpSession(serverSocket, {
                        role: 'answering',
                        addresses: ['1:1/1@testnet'],
                        getPassword: () => null,
                        tempDir: os.tmpdir(),
                    });
                    attachSpoolToSession(serverSess, spool, null).then(() =>
                        serverSess.start()
                    );
                });

                server.listen(0, '127.0.0.1', async () => {
                    const clientSocket = net.createConnection(
                        server.address().port,
                        '127.0.0.1'
                    );
                    const clientSess = new BinkpSession(clientSocket, {
                        role: 'originating',
                        addresses: ['1:2/2@testnet'],
                        getPassword: () => null,
                        tempDir: os.tmpdir(),
                    });
                    //  As the existing session test does; nothing is queued for
                    //  1:1/1, and received files go to the spool's inbound.
                    await attachSpoolToSession(clientSess, spool, [
                        { zone: 1, net: 1, node: 1 },
                    ]);
                    clientSess.on('file-received', name => received.push(name));
                    clientSess.on('session-end', () => {
                        check().then(() => finish(), finish);
                    });
                    clientSess.on('error', finish);
                    clientSess.start();
                });
            })
            .catch(done);
    });
});

describe('BsoSpool — review follow-ups', () => {
    beforeEach(cleanOutbound);

    const flowPath = () => path.join(outboundDir(tmpDir), '00680001.flo');
    const entriesFor = report => {
        const node = report.find(n => 104 === n.address.net && 1 === n.address.node);
        return node ? node.entries : [];
    };

    it('a byte order mark before the first line neither hides its directive nor gets it pruned', async () => {
        const pkt = path.join(outboundDir(tmpDir), 'bom.pkt');
        await fsp.writeFile(pkt, 'PKT');
        const bom = Buffer.from([0xef, 0xbb, 0xbf]);
        await fsp.writeFile(flowPath(), Buffer.concat([bom, Buffer.from(`^${pkt}\n`)]));

        const files = await listFiles(spool, TEST_ADDR);
        assert.deepEqual(
            files.map(f => [f.path, f.disposition]),
            [[pkt, 'delete']]
        );
        assert.equal(entriesFor(await spool.inspectOutbound())[0].status, 'pending');

        const { removed } = await spool.pruneMissingRefs(TEST_ADDR, { dryRun: false });
        assert.deepEqual(removed, []);
        assert.ok(
            (await fsp.readFile(flowPath())).equals(
                Buffer.concat([bom, Buffer.from(`^${pkt}\n`)])
            )
        );
    });

    it('lists a relative ~ or ! line relative to the flow file, not the working directory', async () => {
        await fsp.writeFile(flowPath(), '~sub/sent.zip\n!other.zip\n/abs/x.zip\n');
        const entries = entriesFor(await spool.inspectOutbound());
        assert.equal(
            entries.find(e => 'sent' === e.status).path,
            path.join(outboundDir(tmpDir), 'sub', 'sent.zip')
        );
        assert.equal(
            entries.find(e => 'skip' === e.status).path,
            path.join(outboundDir(tmpDir), 'other.zip')
        );
    });
});

describe('BsoSpool — a flow file that is a symlink', () => {
    beforeEach(cleanOutbound);

    async function linkedFlow(targetDir) {
        await fsp.mkdir(targetDir, { recursive: true });
        const pkt = path.join(outboundDir(tmpDir), 'linked.pkt');
        await fsp.writeFile(pkt, 'PKT');
        const target = path.join(targetDir, 'shared.flo');
        await fsp.writeFile(target, `^${pkt}\n`);
        const link = path.join(outboundDir(tmpDir), '00680001.flo');
        await fsp.symlink(target, link);
        return { pkt, target, link };
    }

    it('marks the file it leads to and removes only the link', async () => {
        const elsewhere = path.join(tmpDir, 'elsewhere');
        const { pkt, target, link } = await linkedFlow(elsewhere);
        try {
            const files = await lockedFiles(spool, TEST_ADDR);
            await files[0].disposeFn();
            await assert.rejects(fsp.lstat(link), { code: 'ENOENT' });
            assert.equal(await fsp.readFile(target, 'utf8'), `~${pkt}\n`);
        } finally {
            await fsp.rm(elsewhere, { recursive: true, force: true });
        }
    });

    describe('a link into a protected directory', () => {
        let prot;
        let guarded;
        let linked;

        beforeEach(async () => {
            prot = path.join(tmpDir, 'protected-cfg');
            linked = await linkedFlow(prot);
            guarded = new BsoSpool({
                ...makeConfig(tmpDir),
                flowPaths: { protectedDirs: [prot] },
            });
        });

        afterEach(async () => {
            await fsp.rm(prot, { recursive: true, force: true });
        });

        it('is not read: nothing queued, nothing pending, warned once per window', async () => {
            const loggerModule = require('../core/logger.js');
            const warnings = [];
            const original = loggerModule.log.warn;
            loggerModule.log.warn = (fields, message) =>
                warnings.push({ fields, message });
            try {
                assert.deepEqual(await listFiles(guarded, TEST_ADDR), []);
                assert.deepEqual(await guarded.getNodesWithPendingMail(), []);
            } finally {
                loggerModule.log.warn = original;
            }
            const linkWarnings = warnings.filter(w =>
                /link into a protected directory/.test(w.message)
            );
            assert.equal(linkWarnings.length, 1, JSON.stringify(warnings));
            assert.ok(
                linkWarnings.every(w => w.fields.path === linked.link),
                JSON.stringify(linkWarnings)
            );
        });

        it('is listed as one refused entry for the flow file, and prune leaves it alone', async () => {
            const node = (await guarded.inspectOutbound()).find(
                n => 104 === n.address.net && 1 === n.address.node
            );
            assert.equal(node.entries.length, 1);
            assert.equal(node.entries[0].status, 'refused');
            assert.equal(node.entries[0].path, linked.link);
            assert.equal(node.entries[0].linkTarget, await fsp.realpath(linked.target));

            const { removed } = await guarded.pruneMissingRefs(TEST_ADDR, {
                dryRun: false,
            });
            assert.deepEqual(removed, []);
            assert.ok((await fsp.lstat(linked.link)).isSymbolicLink());
            assert.equal(await fsp.readFile(linked.target, 'utf8'), `^${linked.pkt}\n`);
        });

        it('is not changed by marking', async () => {
            const lock = guarded.newLockSet();
            assert.ok(await guarded.lockNode(TEST_ADDR, lock));
            try {
                await guarded._applyFlowDisposition(
                    linked.link,
                    0,
                    `^${linked.pkt}`,
                    await guarded.flowPathPolicy(),
                    lock
                );
            } finally {
                await lock.releaseAll();
            }
            assert.ok((await fsp.lstat(linked.link)).isSymbolicLink());
            assert.equal(await fsp.readFile(linked.target, 'utf8'), `^${linked.pkt}\n`);
        });
    });
});

//
//  #1047: a zero-length flow file is a poll request (FTS-5005.003 §3.2, §3.4):
//  call the node even though nothing is queued, and remove the file after a
//  successful session with it. Hold (.hlo, .hut) means wait for the node to
//  call us, so an empty one is neither a reason to dial nor removed.
//
describe('BsoSpool — poll requests (zero-length flow files)', () => {
    const EventEmitter = require('events');

    beforeEach(cleanOutbound);

    const ob = (name = '') => path.join(outboundDir(tmpDir), name);
    const exists = p =>
        fsp.lstat(p).then(
            () => true,
            () => false
        );
    const pending = async () =>
        (await spool.getNodesWithPendingMail()).map(a => a.toString());

    for (const ext of ['ilo', 'clo', 'dlo', 'flo', 'iut', 'cut', 'dut', 'out']) {
        it(`an empty .${ext} makes the node due a call`, async () => {
            await fsp.writeFile(ob(`00680001.${ext}`), '');
            assert.deepEqual(await pending(), ['1:104/1']);
        });
    }

    for (const ext of ['hlo', 'hut']) {
        it(`an empty .${ext} (hold) does not`, async () => {
            await fsp.writeFile(ob(`00680001.${ext}`), '');
            assert.deepEqual(await pending(), []);
            assert.deepEqual(await spool.inspectOutbound(), []);
        });
    }

    it('upper case names count too', async () => {
        await fsp.writeFile(ob('00680001.CLO'), '');
        assert.deepEqual(await pending(), ['1:104/1']);
    });

    it('a symlink to an empty file is not a poll request', async () => {
        const target = path.join(tmpDir, 'empty-target');
        await fsp.writeFile(target, '');
        await fsp.symlink(target, ob('00680001.clo'));
        try {
            assert.deepEqual(await pending(), []);
        } finally {
            await fsp.unlink(target);
        }
    });

    it('resolves a point and a zone directory to the right address', async () => {
        const pnt = ob('00680001.pnt');
        await fsp.mkdir(pnt);
        await fsp.writeFile(path.join(pnt, '0000002d.clo'), '');
        const zone2 = path.join(tmpDir, 'outbound.002');
        await fsp.mkdir(zone2);
        try {
            await fsp.writeFile(path.join(zone2, '00010002.flo'), '');
            assert.deepEqual((await pending()).sort(), ['1:104/1.45', '2:1/2']);
        } finally {
            await fsp.rm(zone2, { recursive: true, force: true });
        }
    });

    it('is listed by inspectOutbound() as a poll entry with its age', async () => {
        await fsp.writeFile(ob('00680001.clo'), '');
        const [node] = await spool.inspectOutbound();
        assert.equal(node.address.toString(), '1:104/1');
        assert.equal(node.entries.length, 1);
        const e = node.entries[0];
        assert.equal(e.kind, 'poll');
        assert.equal(e.status, 'poll');
        assert.equal(e.path, ob('00680001.clo'));
        assert.equal(e.size, 0);
        assert.ok(e.timestamp > 0);
    });

    it('getOutboundFilesForNode() reports poll requests through onPollFile, not as files to send', async () => {
        await fsp.writeFile(ob('00680001.clo'), '');
        await fsp.writeFile(ob('00680001.out'), '');
        await fsp.writeFile(ob('00680001.hlo'), '');
        const lock = spool.newLockSet();
        try {
            assert.ok(await spool.lockNode(TEST_ADDR, lock));
            const polls = [];
            const files = await spool.getOutboundFilesForNode(TEST_ADDR, {
                lock,
                onPollFile: p => polls.push(p),
            });
            assert.deepEqual(files, []);
            assert.deepEqual(polls.sort(), [ob('00680001.clo'), ob('00680001.out')]);
        } finally {
            await lock.close();
        }
    });

    describe('removePollFiles()', () => {
        it('keeps the file if the lock is lost while its size is being checked', async () => {
            const clo = ob('00680001.clo');
            await fsp.writeFile(clo, '');
            const lock = spool.newLockSet();
            assert.ok(await spool.lockNode(TEST_ADDR, lock));

            //  settle() gave up and closed the lock mid-check; another mailer
            //  then took the node and queued mail into the file
            const realLstat = fsp.lstat;
            fsp.lstat = async p => {
                const st = await realLstat(p);
                if (p === clo) {
                    await lock.close();
                }
                return st;
            };
            try {
                assert.deepEqual(await spool.removePollFiles([clo], { lock }), []);
            } finally {
                fsp.lstat = realLstat;
                await lock.close();
            }
            assert.equal(await exists(clo), true);
        });

        it('removes an empty poll file while holding its lock', async () => {
            const clo = ob('00680001.clo');
            await fsp.writeFile(clo, '');
            const lock = spool.newLockSet();
            assert.ok(await spool.lockNode(TEST_ADDR, lock));

            const realUnlink = fsp.unlink;
            let heldAtUnlink = null;
            fsp.unlink = async p => {
                if (p === clo) heldAtUnlink = lock.holdsFlowFile(clo);
                return realUnlink(p);
            };
            try {
                assert.deepEqual(await spool.removePollFiles([clo], { lock }), [clo]);
            } finally {
                fsp.unlink = realUnlink;
                await lock.close();
            }
            assert.equal(heldAtUnlink, true, 'the .bsy was held at the unlink');
            assert.equal(await exists(clo), false);
        });

        it('keeps a poll file that gained content', async () => {
            const clo = ob('00680001.clo');
            await fsp.writeFile(clo, '');
            const lock = spool.newLockSet();
            assert.ok(await spool.lockNode(TEST_ADDR, lock));
            try {
                await fsp.writeFile(clo, '^/somewhere/mail.pkt\n');
                assert.deepEqual(await spool.removePollFiles([clo], { lock }), []);
            } finally {
                await lock.close();
            }
            assert.equal(await fsp.readFile(clo, 'utf8'), '^/somewhere/mail.pkt\n');
        });

        it('keeps it without the lock, or once the lock is released', async () => {
            const clo = ob('00680001.clo');
            await fsp.writeFile(clo, '');
            assert.deepEqual(await spool.removePollFiles([clo], {}), []);

            const lock = spool.newLockSet();
            assert.ok(await spool.lockNode(TEST_ADDR, lock));
            await lock.close();
            assert.deepEqual(await spool.removePollFiles([clo], { lock }), []);

            //  A lock on some other node does not cover it either.
            const other = spool.newLockSet();
            assert.ok(await spool.lockNode({ zone: 1, net: 104, node: 2 }, other));
            try {
                assert.deepEqual(await spool.removePollFiles([clo], { lock: other }), []);
            } finally {
                await other.close();
            }
            assert.equal(await exists(clo), true);
        });

        it('a file already gone is not an error', async () => {
            const lock = spool.newLockSet();
            assert.ok(await spool.lockNode(TEST_ADDR, lock));
            try {
                assert.deepEqual(
                    await spool.removePollFiles([ob('00680001.clo')], { lock }),
                    []
                );
            } finally {
                await lock.close();
            }
        });
    });

    describe('attachSpoolToSession()', () => {
        async function attachedWithLock() {
            const session = new EventEmitter();
            session.queueFile = () => {};
            const lock = spool.newLockSet();
            assert.ok(await spool.lockNode(TEST_ADDR, lock));
            const disposeMap = await attachSpoolToSession(session, spool, [TEST_ADDR], {
                lock,
            });
            return { session, lock, disposeMap };
        }

        it('removes the poll file when the session ends well, before settle() resolves', async () => {
            const clo = ob('00680001.clo');
            await fsp.writeFile(clo, '');
            const { session, lock, disposeMap } = await attachedWithLock();
            try {
                session.emit('addresses', ['1:104/1@fidonet']);
                session.emit('session-end');
                assert.equal(await disposeMap.settle(), true);
                assert.equal(await exists(clo), false);
            } finally {
                await lock.close();
            }
        });

        for (const event of ['disconnect', 'error', 'busy']) {
            it(`keeps the poll file after '${event}'`, async () => {
                const clo = ob('00680001.clo');
                await fsp.writeFile(clo, '');
                const { session, lock, disposeMap } = await attachedWithLock();
                try {
                    session.on('error', () => {}); //  an unhandled 'error' throws
                    session.emit(event, new Error('gone'));
                    await disposeMap.settle();
                    assert.equal(await exists(clo), true);
                } finally {
                    await lock.close();
                }
            });
        }

        it('keeps a hold file, and a poll file that gained mail during the session', async () => {
            const hlo = ob('00680001.hlo');
            const clo = ob('00680001.clo');
            await fsp.writeFile(hlo, '');
            await fsp.writeFile(clo, '');
            const { session, lock, disposeMap } = await attachedWithLock();
            try {
                await fsp.writeFile(clo, '^/somewhere/mail.pkt\n');
                session.emit('session-end');
                await disposeMap.settle();
                assert.equal(await exists(hlo), true);
                assert.equal(await fsp.readFile(clo, 'utf8'), '^/somewhere/mail.pkt\n');
            } finally {
                await lock.close();
            }
        });

        it('keeps the poll file when the system we called did not present the address we dialled', async () => {
            const clo = ob('00680001.clo');
            await fsp.writeFile(clo, '');
            const { session, lock, disposeMap } = await attachedWithLock();
            try {
                session.emit('addresses', ['1:104/2', '2:250/1']);
                session.emit('session-end');
                await disposeMap.settle();
                assert.equal(await exists(clo), true);
            } finally {
                await lock.close();
            }
        });

        it('takes the dialled address in any of the forms a mailer presents it', async () => {
            for (const presented of [
                '1:104/1',
                '1:104/1.0',
                '104/1',
                '1:104/1@fidonet',
            ]) {
                const clo = ob('00680001.clo');
                await fsp.writeFile(clo, '');
                const { session, lock, disposeMap } = await attachedWithLock();
                try {
                    session.emit('addresses', ['2:250/1', presented]);
                    session.emit('session-end');
                    await disposeMap.settle();
                    assert.equal(await exists(clo), false, presented);
                } finally {
                    await lock.close();
                }
            }
        });

        it('a poll file created after the session read the outbound is left for the next one', async () => {
            const clo = ob('00680001.clo');
            const { session, lock, disposeMap } = await attachedWithLock();
            try {
                await fsp.writeFile(clo, '');
                session.emit('session-end');
                await disposeMap.settle();
                assert.equal(await exists(clo), true);
            } finally {
                await lock.close();
            }
        });
    });

    it('a real session removes the poll file on both sides: the node we called, and the node that called us', done => {
        const callerPoll = ob('00020002.clo'); //  1:2/2 calls in
        const calledPoll = ob('00010001.flo'); //  1:1/1 is the node it called
        const holdPoll = ob('00020002.hlo');

        let server;
        const finish = err => {
            server.close();
            done(err);
        };

        const check = async () => {
            //  The answering side removes its poll as it releases its locks,
            //  just after its own 'session-end'; give it a moment.
            const deadline = Date.now() + 2000;
            while ((await exists(callerPoll)) && Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 20));
            }
            assert.equal(await exists(callerPoll), false, 'answering side removed it');
            assert.equal(await exists(calledPoll), false, 'originating side removed it');
            assert.equal(await exists(holdPoll), true, 'hold is not a poll request');
        };

        Promise.all([
            fsp.writeFile(callerPoll, ''),
            fsp.writeFile(calledPoll, ''),
            fsp.writeFile(holdPoll, ''),
        ])
            .then(() => {
                server = net.createServer(serverSocket => {
                    const serverSess = new BinkpSession(serverSocket, {
                        role: 'answering',
                        addresses: ['1:1/1@testnet'],
                        getPassword: () => null,
                        tempDir: os.tmpdir(),
                    });
                    attachSpoolToSession(serverSess, spool, null).then(() =>
                        serverSess.start()
                    );
                });

                server.listen(0, '127.0.0.1', async () => {
                    const clientSocket = net.createConnection(
                        server.address().port,
                        '127.0.0.1'
                    );
                    const clientSess = new BinkpSession(clientSocket, {
                        role: 'originating',
                        addresses: ['1:2/2@testnet'],
                        getPassword: () => null,
                        tempDir: os.tmpdir(),
                    });
                    const lock = spool.newLockSet();
                    const callee = { zone: 1, net: 1, node: 1 };
                    assert.ok(await spool.lockNode(callee, lock));
                    const disposeMap = await attachSpoolToSession(
                        clientSess,
                        spool,
                        [callee],
                        { lock }
                    );
                    clientSess.on('session-end', async () => {
                        await disposeMap.settle();
                        await lock.close();
                        check().then(() => finish(), finish);
                    });
                    clientSess.on('error', finish);
                    clientSess.start();
                });
            })
            .catch(done);
    });
});
