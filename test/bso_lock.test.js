'use strict';

//
//  Coverage for the FTS-5005.003 §5.1 ".bsy" flow file lock.
//
//  Background: core/scanner_tossers/ftn_bso.js appends reference records to BSO
//  flow files, and core/binkp/bso_spool.js rewrites those same files as entries
//  are sent -- _applyFlowDisposition reads the whole file, marks a line '~' and
//  writes it back. The writer took no lock, so an append landing between that
//  read and its write was *silently discarded*: no error, no log, the queued
//  file simply never shipped and its companion .tic orphaned in the outbound.
//
//  §5.1 puts the requirement on software, not on mailers:
//
//      "A bsy is a main control file that must be used by any software dealing
//       with flow files in BSO. [...] Any software must check this file before
//       doing any changes in flow files. If a bsy file exists all changes are
//       prohibited in any corresponding flow files."
//
//  Because NNNNnnnn.bsy is the standard name, honouring it also interlocks with
//  external mailers (binkd) for free -- they take the same lock. The older
//  "enigma.bsy" flag is a non-FTS-5005 name in the outbound *root* and cannot
//  serve this purpose.
//

const { strict: assert } = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const paths = require('path');

const bsoLock = require('../core/bso_lock.js');

describe('BSO .bsy flow file lock', function () {
    let tmpDir;
    let flowPath;
    let bsyPath;

    beforeEach(async () => {
        tmpDir = await fsp.mkdtemp(paths.join(os.tmpdir(), 'enigma_bsolock_'));
        flowPath = paths.join(tmpDir, '00da02bc.flo');
        bsyPath = paths.join(tmpDir, '00da02bc.bsy');
        await fsp.writeFile(flowPath, '^/spool/existing.pkt\n');
    });

    afterEach(async () => {
        await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    describe('bsyPathForFlowFile', () => {
        it('names the lock after the flow file, per §5.1', () => {
            assert.equal(bsoLock.bsyPathForFlowFile(flowPath), bsyPath);
        });

        it('handles every flow and direct-attach extension', () => {
            ['flo', 'clo', 'hlo', 'dlo', 'ilo', 'out', 'cut', 'hut'].forEach(ext => {
                assert.equal(
                    bsoLock.bsyPathForFlowFile(paths.join(tmpDir, `00da02bc.${ext}`)),
                    bsyPath
                );
            });
        });

        it("keeps a point's lock inside its .pnt subdirectory", () => {
            //  FTS-5005.003 §2: a point's files live under NNNNnnnn.pnt/, and
            //  deriving from the flow file keeps the lock beside them rather
            //  than in the boss node's directory.
            const pointFlow = paths.join(tmpDir, '00da02bc.pnt', '00000004.flo');
            assert.equal(
                bsoLock.bsyPathForFlowFile(pointFlow),
                paths.join(tmpDir, '00da02bc.pnt', '00000004.bsy')
            );
        });

        it('matches the case of the flow file extension', () => {
            assert.equal(
                bsoLock.bsyPathForFlowFile(paths.join(tmpDir, '00DA02BC.FLO')),
                paths.join(tmpDir, '00DA02BC.BSY')
            );
        });
    });

    describe('acquire / release', () => {
        it('creates the lock and reports success', async () => {
            assert.ok(await bsoLock.acquire(bsyPath));
            assert.ok(fs.existsSync(bsyPath));
        });

        it('records our pid first on its one line, as §5.1 permits', async () => {
            await bsoLock.acquire(bsyPath);
            const content = await fsp.readFile(bsyPath, 'utf8');
            assert.match(content, /^\d+ ENiGMA ([0-9a-f]{12}|-) [0-9a-f]{16}\n$/);
            assert.equal(parseInt(content, 10), process.pid);
            assert.equal(content.split('\n').length, 2, 'one line');
            assert.equal(bsoLock.parseLockContent(content).pid, process.pid);
            await bsoLock.release(bsyPath);
        });

        it('refuses a lock already held, and does not disturb it', async () => {
            await fsp.writeFile(bsyPath, '4242');
            assert.equal(await bsoLock.acquire(bsyPath), false);
            //  §5.1 warns that a careless create "quietly overwrites an
            //  existing file" -- the holder's pid must survive.
            assert.equal((await fsp.readFile(bsyPath, 'utf8')).trim(), '4242');
        });

        it("detects another mailer's lock written in a different case", async () => {
            //  FTS-5005.003 §2 asks software to handle both cases. An exclusive
            //  create on our own spelling would not collide, and both sides
            //  would believe they held the lock.
            await fsp.writeFile(paths.join(tmpDir, '00DA02BC.BSY'), '4242');
            assert.equal(await bsoLock.acquire(bsyPath), false);
        });

        it('releases, allowing a subsequent acquire', async () => {
            await bsoLock.acquire(bsyPath);
            await bsoLock.release(bsyPath);
            assert.ok(!fs.existsSync(bsyPath));
            assert.ok(await bsoLock.acquire(bsyPath));
        });

        it('releases idempotently when there is no lock', async () => {
            await bsoLock.release(bsyPath); //  must not throw
        });

        it('creates the lock directory when it does not exist yet', async () => {
            const pointBsy = paths.join(tmpDir, '00da02bc.pnt', '00000004.bsy');
            assert.ok(await bsoLock.acquire(pointBsy));
            assert.ok(fs.existsSync(pointBsy));
        });
    });

    describe('stale lock reaping', () => {
        it('reaps a lock older than the window and takes it', async () => {
            await fsp.writeFile(bsyPath, '4242');
            const old = new Date(Date.now() - 60 * 60 * 1000);
            await fsp.utimes(bsyPath, old, old);

            assert.ok(await bsoLock.acquire(bsyPath, { staleMaxAgeMs: 30 * 60 * 1000 }));
            assert.equal(parseInt(await fsp.readFile(bsyPath, 'utf8'), 10), process.pid);
            await bsoLock.release(bsyPath);
        });

        it('leaves a fresh lock alone', async () => {
            await fsp.writeFile(bsyPath, '4242');
            assert.equal(
                await bsoLock.acquire(bsyPath, { staleMaxAgeMs: 30 * 60 * 1000 }),
                false
            );
            assert.equal((await fsp.readFile(bsyPath, 'utf8')).trim(), '4242');
        });
    });

    describe('acquire when writing the lock fails', () => {
        it('removes the lock it created and rejects', async () => {
            const realOpen = fsp.open;
            let closed = false;
            fsp.open = async (p, flags, ...rest) => {
                const fh = await realOpen.call(fsp, p, flags, ...rest);
                if (p === bsyPath && 'wx' === flags) {
                    fh.writeFile = async () => {
                        throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
                    };
                    const close = fh.close.bind(fh);
                    fh.close = async () => {
                        closed = true;
                        return close();
                    };
                }
                return fh;
            };
            try {
                await assert.rejects(bsoLock.acquire(bsyPath), { code: 'ENOSPC' });
            } finally {
                fsp.open = realOpen;
            }
            assert.ok(closed, 'handle closed');
            assert.ok(!fs.existsSync(bsyPath), 'no lock left behind');
        });
    });

    describe('withFlowFileLock', () => {
        it('runs the work holding the lock, and releases afterwards', done => {
            let heldDuringWork = false;
            bsoLock.withFlowFileLock(
                flowPath,
                work => {
                    heldDuringWork = fs.existsSync(bsyPath);
                    work(null);
                },
                err => {
                    assert.ifError(err);
                    assert.ok(heldDuringWork, 'lock must be held while work runs');
                    assert.ok(!fs.existsSync(bsyPath), 'lock must be released');
                    done();
                }
            );
        });

        it('releases the lock when the work reports an error', done => {
            bsoLock.withFlowFileLock(
                flowPath,
                work => work(new Error('nope')),
                err => {
                    assert.equal(err.message, 'nope');
                    assert.ok(!fs.existsSync(bsyPath));
                    done();
                }
            );
        });

        it('releases the lock when the work throws', done => {
            bsoLock.withFlowFileLock(
                flowPath,
                () => {
                    throw new Error('boom');
                },
                err => {
                    assert.equal(err.message, 'boom');
                    assert.ok(!fs.existsSync(bsyPath), 'a throw must not leak the lock');
                    done();
                }
            );
        });

        it('reports Busy, and never runs the work, when the node is locked', done => {
            fs.writeFileSync(bsyPath, '4242');
            let ran = false;
            bsoLock.withFlowFileLock(
                flowPath,
                { timeoutMs: 150 },
                work => {
                    ran = true;
                    work(null);
                },
                err => {
                    assert.ok(err, 'a held lock must surface an error');
                    assert.ok(bsoLock.isBusyError(err), 'and it must be distinguishable');
                    assert.ok(!ran, 'work must not run while another party holds it');
                    //  The holder's lock must survive our failed attempt.
                    assert.equal(fs.readFileSync(bsyPath, 'utf8').trim(), '4242');
                    done();
                }
            );
        });

        it('waits out a short-lived holder rather than failing', done => {
            //  The common case is not a whole session but a sub-second flow
            //  file rewrite by a session finishing an entry.
            fs.writeFileSync(bsyPath, '4242');
            setTimeout(() => fs.unlinkSync(bsyPath), 120);

            bsoLock.withFlowFileLock(
                flowPath,
                { timeoutMs: 3000 },
                work => work(null),
                err => {
                    assert.ifError(err);
                    done();
                }
            );
        });

        it('serializes concurrent writers', done => {
            //  Two appenders racing on one flow file must not interleave.
            let active = 0;
            let maxActive = 0;
            let completed = 0;

            const one = () =>
                bsoLock.withFlowFileLock(
                    flowPath,
                    { timeoutMs: 3000 },
                    work => {
                        active++;
                        maxActive = Math.max(maxActive, active);
                        setTimeout(() => {
                            active--;
                            work(null);
                        }, 30);
                    },
                    err => {
                        assert.ifError(err);
                        if (++completed === 2) {
                            assert.equal(maxActive, 1, 'only one writer at a time');
                            done();
                        }
                    }
                );

            one();
            one();
        });
    });

    describe('FlowLockSet', () => {
        it('holds a lock under either spelling of its name', async () => {
            const lock = new bsoLock.FlowLockSet();
            assert.ok(await lock.acquire([bsyPath]));
            assert.ok(lock.holds(bsyPath));
            assert.ok(lock.holds(paths.join(tmpDir, '00DA02BC.BSY')));
            assert.ok(lock.holdsFlowFile(paths.join(tmpDir, '00DA02BC.FLO')));
            assert.ok(!lock.holds(paths.join(tmpDir, '00da02bd.bsy')));
            await lock.releaseAll();
            assert.ok(!fs.existsSync(bsyPath));
            assert.equal(lock.size, 0);
        });

        it('is all or nothing', async () => {
            const other = paths.join(tmpDir, 'sub', '00da02bc.bsy');
            await fsp.mkdir(paths.dirname(other));
            fs.writeFileSync(other, '4242');
            const lock = new bsoLock.FlowLockSet();
            assert.equal(await lock.acquire([bsyPath, other]), false);
            assert.equal(lock.size, 0);
            assert.ok(!fs.existsSync(bsyPath), 'the lock it did take is released');
            assert.equal(fs.readFileSync(other, 'utf8'), '4242');
        });

        it('is re-entrant, and takes a lock reached twice only once', async () => {
            const lock = new bsoLock.FlowLockSet();
            assert.ok(await lock.acquire([bsyPath, paths.join(tmpDir, '00DA02BC.BSY')]));
            assert.ok(await lock.acquire([bsyPath]));
            assert.equal(lock.size, 1);
            assert.equal(await new bsoLock.FlowLockSet().acquire([bsyPath]), false);
            await lock.releaseAll();
        });

        it('takes nothing once closed, and gives back what it was taking when closed', async () => {
            const lock = new bsoLock.FlowLockSet();
            const taking = lock.acquire([bsyPath]);
            await lock.close(); //  while that acquire is in flight
            assert.equal(await taking, false);
            assert.ok(!fs.existsSync(bsyPath), 'nothing left behind');
            assert.equal(await lock.acquire([bsyPath]), false);
            assert.ok(!fs.existsSync(bsyPath));
            assert.ok(lock.closed);
        });

        it('does not release a lock twice when closed during an acquire', async () => {
            //  p is taken, then close() releases it while q is being taken;
            //  another process takes p meanwhile. Giving q back must leave
            //  that other process's p alone.
            const p = bsyPath;
            const q = paths.join(tmpDir, 'other', '00da02bc.bsy');
            await fsp.mkdir(paths.dirname(q));
            const realOpen = fsp.open;
            let atGate;
            const reached = new Promise(r => (atGate = r));
            let openGate;
            const gate = new Promise(r => (openGate = r));
            fsp.open = async (file, flags, ...rest) => {
                if (file === q && 'wx' === flags) {
                    atGate();
                    await gate;
                }
                return realOpen.call(fsp, file, flags, ...rest);
            };
            try {
                const lock = new bsoLock.FlowLockSet();
                const taking = lock.acquire([p, q]);
                await reached;
                await lock.close();
                assert.ok(!fs.existsSync(p), 'close() released p');
                fs.writeFileSync(p, '4242'); //  someone else's now
                openGate();
                assert.equal(await taking, false);
                assert.equal(fs.readFileSync(p, 'utf8'), '4242', 'not ours to remove');
                assert.ok(!fs.existsSync(q), 'q given back');
            } finally {
                openGate();
                fsp.open = realOpen;
            }
        });

        it('with createDir false makes no directory and skips a lock that would need one', async () => {
            const missing = paths.join(tmpDir, 'nope', '00da02bc.bsy');
            const lock = new bsoLock.FlowLockSet();
            assert.equal(
                await lock.acquire([bsyPath, missing], { createDir: false }),
                true
            );
            assert.ok(lock.holds(bsyPath));
            assert.ok(!lock.holds(missing));
            assert.ok(!fs.existsSync(paths.dirname(missing)));
            await lock.close();
        });

        it('withFlowFileLock hands the work the lock set', done => {
            bsoLock.withFlowFileLock(
                flowPath,
                (work, lock) => {
                    try {
                        assert.ok(lock instanceof bsoLock.FlowLockSet);
                        bsoLock.assertFlowFileLockHeld(lock, flowPath);
                        work(null);
                    } catch (err) {
                        work(err);
                    }
                },
                done
            );
        });
    });

    describe('assertFlowFileLockHeld', () => {
        it('throws NotHeld without a lock, with the wrong lock, or with a lookalike', async () => {
            const wrong = new bsoLock.FlowLockSet();
            await wrong.acquire([paths.join(tmpDir, '00da02bd.bsy')]);
            const lookalike = { holds: () => true, holdsFlowFile: () => true };
            for (const lock of [null, undefined, wrong, lookalike]) {
                assert.throws(
                    () => bsoLock.assertFlowFileLockHeld(lock, flowPath),
                    err =>
                        bsoLock.isNotHeldError(err) && /Lock not held/.test(err.message)
                );
            }
            await wrong.releaseAll();
        });

        it('throws once the lock has been released', async () => {
            const lock = new bsoLock.FlowLockSet();
            await lock.acquire([bsyPath]);
            bsoLock.assertFlowFileLockHeld(lock, flowPath);
            await lock.releaseAll();
            assert.throws(() => bsoLock.assertFlowFileLockHeld(lock, flowPath), {
                reasonCode: bsoLock.ReasonCodes.NotHeld,
            });
        });
    });

    //  #1053: a lock held longer than the stale age, and a lock replaced
    //  underneath its holder. #1052: locks left by a process that is gone.
    describe('lock ownership, refresh and orphans', () => {
        const { spawnSync } = require('child_process');
        const ourHostId = bsoLock.lockHostId();
        const withIdentity = '-' !== ourHostId ? it : it.skip;
        const otherHostId =
            'aaaaaaaaaaaa' === ourHostId ? 'bbbbbbbbbbbb' : 'aaaaaaaaaaaa';

        //  A PID that was running a moment ago and is not now.
        const deadPid = () => {
            const child = spawnSync(process.execPath, ['-e', '']);
            return child.pid;
        };
        const lockLine = (pid, hostId, token = '0123456789abcdef') =>
            `${pid} ENiGMA ${hostId} ${token}\n`;
        const backdate = async (file, ageMs) => {
            const t = new Date(Date.now() - ageMs);
            await fsp.utimes(file, t, t);
        };

        afterEach(() => {
            //  Nothing a test leaves held may leak into the next one.
            bsoLock._releaseHeldSync();
        });

        it('release() leaves a lock that another holder put in its place', async () => {
            const lock = new bsoLock.FlowLockSet();
            assert.ok(await lock.acquire([bsyPath]));
            //  Reaped and taken by someone else meanwhile.
            await fsp.unlink(bsyPath);
            await fsp.writeFile(bsyPath, lockLine(4242, otherHostId));
            await lock.close();
            assert.equal(
                await fsp.readFile(bsyPath, 'utf8'),
                lockLine(4242, otherHostId),
                'the other holder keeps its lock'
            );
        });

        it('release() leaves a lock this process never took', async () => {
            await fsp.writeFile(bsyPath, '4242');
            await bsoLock.release(bsyPath);
            assert.equal(await fsp.readFile(bsyPath, 'utf8'), '4242');
        });

        it('refuses a second holder in this process however old the lock looks', async () => {
            const first = new bsoLock.FlowLockSet({ staleMaxAgeMs: 1000 });
            assert.ok(await first.acquire([bsyPath]));
            const content = await fsp.readFile(bsyPath, 'utf8');
            await backdate(bsyPath, 60 * 60 * 1000);

            const second = new bsoLock.FlowLockSet({ staleMaxAgeMs: 1000 });
            assert.equal(await second.acquire([bsyPath]), false);
            assert.equal(await bsoLock.acquire(bsyPath, { staleMaxAgeMs: 1000 }), false);
            assert.equal(await fsp.readFile(bsyPath, 'utf8'), content, 'not reaped');
            assert.ok(first.holds(bsyPath));
            await first.close();
        });

        it('touches a held lock, so another process does not reap it', async () => {
            const lock = new bsoLock.FlowLockSet({ staleMaxAgeMs: 500 });
            assert.ok(await lock.acquire([bsyPath]));
            await backdate(bsyPath, 60 * 60 * 1000);

            await bsoLock._refreshHeldNow();
            const ageMs = Date.now() - (await fsp.stat(bsyPath)).mtimeMs;
            assert.ok(ageMs < 5000, `refreshed (age ${ageMs} ms)`);

            //  Another process with a 500 ms stale age, once the lock is a
            //  little over that old by the clock but freshly touched.
            const child = spawnSync(
                process.execPath,
                [
                    '-e',
                    `require(${JSON.stringify(
                        require.resolve('../core/bso_lock.js')
                    )}).acquire(process.argv[1], { staleMaxAgeMs: 500 }).then(got => process.stdout.write(String(got)))`,
                    bsyPath,
                ],
                { encoding: 'utf8' }
            );
            assert.equal(child.stdout, 'false', child.stderr);
            assert.ok(lock.holds(bsyPath));
            await lock.close();
            assert.ok(!fs.existsSync(bsyPath));
        });

        it('refreshes on its own timer while held, and stops when released', async () => {
            assert.ok(await bsoLock.acquire(bsyPath, { refreshMs: 20 }));
            await backdate(bsyPath, 60 * 60 * 1000);
            await new Promise(r => setTimeout(r, 150));
            const ageMs = Date.now() - (await fsp.stat(bsyPath)).mtimeMs;
            assert.ok(ageMs < 5000, `refreshed by the timer (age ${ageMs} ms)`);
            await bsoLock.release(bsyPath);
            assert.equal(bsoLock.heldCount(), 0);
        });

        it('drops a held lock that was removed, and refuses its flow file from then on', async () => {
            const { rewriteFlowFile } = require('../core/bso_flow.js');
            const lock = new bsoLock.FlowLockSet();
            assert.ok(await lock.acquire([bsyPath]));
            await fsp.unlink(bsyPath);
            await bsoLock._refreshHeldNow();
            assert.ok(!lock.holds(bsyPath), 'no longer held');
            assert.equal(bsoLock.heldCount(), 0);
            await assert.rejects(
                rewriteFlowFile(flowPath, () => ({ mark: [0] }), { lock }),
                {
                    reasonCode: bsoLock.ReasonCodes.NotHeld,
                }
            );
            assert.equal(await fsp.readFile(flowPath, 'utf8'), '^/spool/existing.pkt\n');
        });

        it('drops a held lock that was replaced, and neither touches nor removes the new one', async () => {
            let lost = 0;
            assert.ok(await bsoLock.acquire(bsyPath, { onLost: () => lost++ }));
            await fsp.unlink(bsyPath);
            await fsp.writeFile(bsyPath, '4242');
            await backdate(bsyPath, 10 * 60 * 1000);
            const before = (await fsp.stat(bsyPath)).mtimeMs;

            await bsoLock._refreshHeldNow();
            assert.equal(lost, 1);
            assert.equal((await fsp.stat(bsyPath)).mtimeMs, before, 'not touched');
            await bsoLock.release(bsyPath);
            assert.equal(await fsp.readFile(bsyPath, 'utf8'), '4242');
        });

        it('takes a lock again at once after it was removed from under this process', async () => {
            assert.ok(await bsoLock.acquire(bsyPath));
            await fsp.unlink(bsyPath);
            assert.ok(await bsoLock.acquire(bsyPath), 'not still counted as held');
            await bsoLock.release(bsyPath);
        });

        withIdentity(
            'reaps our lock at once when its process on this machine is not running',
            async () => {
                await fsp.writeFile(bsyPath, lockLine(deadPid(), ourHostId));
                assert.ok(await bsoLock.acquire(bsyPath));
                assert.equal(
                    parseInt(await fsp.readFile(bsyPath, 'utf8'), 10),
                    process.pid
                );
                await bsoLock.release(bsyPath);
            }
        );

        withIdentity(
            'reaps our lock written by an earlier process with our PID',
            async () => {
                await fsp.writeFile(bsyPath, lockLine(process.pid, ourHostId));
                assert.ok(await bsoLock.acquire(bsyPath));
                await bsoLock.release(bsyPath);
            }
        );

        withIdentity('leaves our lock whose process is still running', async () => {
            await fsp.writeFile(bsyPath, lockLine(process.ppid, ourHostId));
            assert.equal(await bsoLock.acquire(bsyPath), false);
            assert.equal(
                await fsp.readFile(bsyPath, 'utf8'),
                lockLine(process.ppid, ourHostId)
            );
        });

        it('never judges a lock from another machine or namespace by its PID', async () => {
            await fsp.writeFile(bsyPath, lockLine(deadPid(), otherHostId));
            assert.equal(await bsoLock.acquire(bsyPath), false);
            await fsp.writeFile(bsyPath, lockLine(deadPid(), '-'));
            assert.equal(await bsoLock.acquire(bsyPath), false);
        });

        it('never judges a foreign lock by its PID', async () => {
            await fsp.writeFile(bsyPath, `${deadPid()}\n`);
            assert.equal(await bsoLock.acquire(bsyPath), false);
            await fsp.writeFile(bsyPath, '');
            assert.equal(await bsoLock.acquire(bsyPath), false);
        });

        it('reaps our lock left unrefreshed for five minutes; a foreign one waits for the stale age', async () => {
            const staleMaxAgeMs = 60 * 60 * 1000;
            await fsp.writeFile(bsyPath, lockLine(4242, otherHostId));
            await backdate(bsyPath, 4 * 60 * 1000);
            assert.equal(await bsoLock.acquire(bsyPath, { staleMaxAgeMs }), false);
            await backdate(bsyPath, 6 * 60 * 1000);
            assert.ok(await bsoLock.acquire(bsyPath, { staleMaxAgeMs }));
            await bsoLock.release(bsyPath);

            await fsp.writeFile(bsyPath, '4242\n');
            await backdate(bsyPath, 6 * 60 * 1000);
            assert.equal(await bsoLock.acquire(bsyPath, { staleMaxAgeMs }), false);
            await backdate(bsyPath, 61 * 60 * 1000);
            assert.ok(await bsoLock.acquire(bsyPath, { staleMaxAgeMs }));
            await bsoLock.release(bsyPath);
        });

        it('releases every held lock on exit, leaving any that were replaced', async () => {
            const other = paths.join(tmpDir, '00da02bd.bsy');
            assert.ok(await bsoLock.acquire(bsyPath));
            assert.ok(await bsoLock.acquire(other));
            await fsp.unlink(other);
            await fsp.writeFile(other, '4242');

            bsoLock._releaseHeldSync();
            assert.ok(!fs.existsSync(bsyPath));
            assert.equal(await fsp.readFile(other, 'utf8'), '4242');
            assert.equal(bsoLock.heldCount(), 0);
        });

        it('a refresh running while the lock is released leaves nothing behind', async () => {
            const lock = new bsoLock.FlowLockSet();
            assert.ok(await lock.acquire([bsyPath]));
            await Promise.all([bsoLock._refreshHeldNow(), lock.close()]);
            assert.ok(!fs.existsSync(bsyPath));
            assert.equal(bsoLock.heldCount(), 0);
        });

        it('whenNoneHeld() resolves once the last lock is released, or false at its timeout', async () => {
            assert.ok(await bsoLock.acquire(bsyPath));
            assert.equal(await bsoLock.whenNoneHeld(30), false);
            const waiting = bsoLock.whenNoneHeld(2000);
            await bsoLock.release(bsyPath);
            assert.equal(await waiting, true);
        });
    });
});
