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

        it('refreshes by writing its own line back: same content, same file, new mtime', async () => {
            assert.ok(await bsoLock.acquire(bsyPath));
            const before = await fsp.readFile(bsyPath, 'utf8');
            const { ino } = await fsp.stat(bsyPath);
            await backdate(bsyPath, 60 * 60 * 1000);
            await bsoLock._refreshHeldNow();
            const st = await fsp.stat(bsyPath);
            assert.equal(await fsp.readFile(bsyPath, 'utf8'), before);
            assert.equal(st.ino, ino, 'written in place');
            assert.ok(Date.now() - st.mtimeMs < 5000, 'mtime moved');
            await bsoLock.release(bsyPath);
        });

        describe('a lock that cannot be read', () => {
            //  Root reads anything; the mode below would not stop it.
            const canDeny =
                'function' === typeof process.getuid && 0 !== process.getuid();
            const denyIt = canDeny ? it : it.skip;
            const logged = [];
            const log = {
                info: (o, m) => logged.push(['info', m]),
                warn: (o, m) => logged.push(['warn', m]),
            };
            beforeEach(() => (logged.length = 0));
            afterEach(async () => {
                await fsp.chmod(bsyPath, 0o644).catch(() => {});
            });

            denyIt('is still held when this process tries to take it again', async () => {
                let lost = 0;
                assert.ok(await bsoLock.acquire(bsyPath, { log, onLost: () => lost++ }));
                await fsp.chmod(bsyPath, 0o000);
                assert.equal(await bsoLock.acquire(bsyPath, { log }), false);
                assert.equal(await bsoLock.reapIfStale(bsyPath, 0, log), false);
                assert.equal(lost, 0, 'not counted as lost');
                assert.equal(bsoLock.heldCount(), 1);
                await fsp.chmod(bsyPath, 0o644);
                await bsoLock.release(bsyPath);
                assert.ok(!fs.existsSync(bsyPath));
            });

            denyIt(
                'is left in place, with a warning, when it cannot be read to release it',
                async () => {
                    assert.ok(await bsoLock.acquire(bsyPath, { log }));
                    await fsp.chmod(bsyPath, 0o000);
                    await bsoLock.release(bsyPath);
                    assert.ok(fs.existsSync(bsyPath), 'not removed unread');
                    assert.equal(bsoLock.heldCount(), 0);
                    assert.ok(
                        logged.some(
                            ([lvl, m]) => 'warn' === lvl && /Could not read/.test(m)
                        )
                    );
                }
            );

            denyIt("is judged by age only when it is someone else's", async () => {
                await fsp.writeFile(
                    bsyPath,
                    `${process.pid} ENiGMA ${ourHostId} 0123456789abcdef\n`
                );
                await fsp.chmod(bsyPath, 0o000);
                assert.equal(
                    await bsoLock.reapIfStale(bsyPath, 60 * 1000, log),
                    false,
                    'fresh'
                );
                assert.ok(fs.existsSync(bsyPath));
                await backdate(bsyPath, 2 * 60 * 1000);
                assert.equal(
                    await bsoLock.reapIfStale(bsyPath, 60 * 1000, log),
                    true,
                    'stale'
                );
                assert.ok(!fs.existsSync(bsyPath));
            });

            denyIt(
                'is given up once it has not been refreshed for half the reap age',
                async () => {
                    let lost = 0;
                    assert.ok(
                        await bsoLock.acquire(bsyPath, {
                            log,
                            staleMaxAgeMs: 200, //  given up after 100 ms
                            refreshMs: 40,
                            onLost: () => lost++,
                        })
                    );
                    await fsp.chmod(bsyPath, 0o000);
                    await bsoLock._refreshHeldNow();
                    assert.equal(
                        bsoLock.heldCount(),
                        1,
                        'one failed touch is not enough'
                    );
                    await new Promise(r => setTimeout(r, 150));
                    await bsoLock._refreshHeldNow();
                    assert.equal(lost, 1);
                    assert.equal(bsoLock.heldCount(), 0);
                    assert.ok(
                        logged.some(
                            ([lvl, m]) => 'warn' === lvl && /no longer ours/.test(m)
                        )
                    );
                }
            );
        });

        it('is not given up when the wall clock jumps forward', async () => {
            let lost = 0;
            assert.ok(
                await bsoLock.acquire(bsyPath, {
                    staleMaxAgeMs: 200,
                    refreshMs: 40,
                    onLost: () => lost++,
                })
            );
            const realNow = Date.now;
            Date.now = () => realNow() + 60 * 60 * 1000; //  an NTP step, a resume
            try {
                await bsoLock._refreshHeldNow();
            } finally {
                Date.now = realNow;
            }
            assert.equal(lost, 0);
            assert.equal(bsoLock.heldCount(), 1);
            await bsoLock.release(bsyPath);
        });

        it('a tiny stale age does not give up a healthy lock', async () => {
            let lost = 0;
            assert.ok(
                await bsoLock.acquire(bsyPath, { staleMaxAgeMs: 0, onLost: () => lost++ })
            );
            for (let i = 0; i < 5; i++) {
                await new Promise(r => setTimeout(r, 10));
                await bsoLock._refreshHeldNow();
            }
            assert.equal(lost, 0);
            assert.equal(bsoLock.heldCount(), 1);
            await bsoLock.release(bsyPath);
        });

        it('finishes a refresh that the filesystem writes in pieces', async () => {
            assert.ok(await bsoLock.acquire(bsyPath));
            const content = await fsp.readFile(bsyPath, 'utf8');
            const realOpen = fsp.open;
            let writes = 0;
            fsp.open = async (file, flags, ...rest) => {
                const fh = await realOpen.call(fsp, file, flags, ...rest);
                if (file === bsyPath && 'r+' === flags) {
                    const write = fh.write.bind(fh);
                    //  At most 5 bytes per call.
                    fh.write = (buf, off, len, pos) => {
                        writes++;
                        return write(buf, off, Math.min(len, 5), pos);
                    };
                }
                return fh;
            };
            try {
                await bsoLock._refreshHeldNow();
            } finally {
                fsp.open = realOpen;
            }
            assert.equal(await fsp.readFile(bsyPath, 'utf8'), content);
            //  The same bytes go back, so a short write would leave the line
            //  intact; what matters is that all of it was written.
            assert.equal(
                writes,
                Math.ceil(Buffer.byteLength(content) / 5),
                'all of it written'
            );
            await bsoLock._refreshHeldNow();
            assert.equal(bsoLock.heldCount(), 1, 'not taken for replaced');
            await bsoLock.release(bsyPath);
            assert.ok(!fs.existsSync(bsyPath));
        });

        describe('a lock given up because it could not be refreshed', () => {
            const giveUp = async (opts = {}) => {
                const realOpen = fsp.open;
                fsp.open = async (file, flags, ...rest) => {
                    if (file === bsyPath && 'r+' === flags) {
                        throw Object.assign(new Error('EIO'), { code: 'EIO' });
                    }
                    return realOpen.call(fsp, file, flags, ...rest);
                };
                try {
                    await new Promise(r => setTimeout(r, 150));
                    await bsoLock._refreshHeldNow();
                } finally {
                    fsp.open = realOpen;
                }
                assert.equal(bsoLock.heldCount(), 0, 'given up');
                return opts;
            };
            const opts = { staleMaxAgeMs: 200, refreshMs: 1000 }; //  gives up after 2.5 s...
            const fast = { staleMaxAgeMs: 200, refreshMs: 40 }; //  ...or after 100 ms

            it('is still removed by release() while it holds our line', async () => {
                assert.ok(await bsoLock.acquire(bsyPath, fast));
                await giveUp();
                assert.ok(fs.existsSync(bsyPath));
                await bsoLock.release(bsyPath);
                assert.ok(!fs.existsSync(bsyPath));
            });

            it('is left by release() once another holder has replaced it', async () => {
                assert.ok(await bsoLock.acquire(bsyPath, fast));
                await giveUp();
                await fsp.unlink(bsyPath);
                await fsp.writeFile(bsyPath, '4242');
                await bsoLock.release(bsyPath);
                assert.equal(await fsp.readFile(bsyPath, 'utf8'), '4242');
            });

            it('is removed on exit, and by its lock set when closed', async () => {
                assert.ok(await bsoLock.acquire(bsyPath, fast));
                await giveUp();
                bsoLock._releaseHeldSync();
                assert.ok(!fs.existsSync(bsyPath), 'removed on exit');

                const lock = new bsoLock.FlowLockSet(fast);
                assert.ok(await lock.acquire([bsyPath]));
                await giveUp();
                assert.ok(!lock.holds(bsyPath));
                await lock.close();
                assert.ok(!fs.existsSync(bsyPath), 'removed by close()');
            });

            it('is not given up before 2.5 refresh intervals, whatever the stale age', async () => {
                assert.ok(await bsoLock.acquire(bsyPath, opts));
                const realOpen = fsp.open;
                fsp.open = async (file, flags, ...rest) => {
                    if (file === bsyPath && 'r+' === flags) {
                        throw Object.assign(new Error('EIO'), { code: 'EIO' });
                    }
                    return realOpen.call(fsp, file, flags, ...rest);
                };
                try {
                    await new Promise(r => setTimeout(r, 150));
                    await bsoLock._refreshHeldNow();
                } finally {
                    fsp.open = realOpen;
                }
                assert.equal(bsoLock.heldCount(), 1);
                await bsoLock.release(bsyPath);
            });
        });

        it('gives up a lock whose touch hangs', async () => {
            let lost = 0;
            assert.ok(
                await bsoLock.acquire(bsyPath, {
                    staleMaxAgeMs: 200,
                    refreshMs: 40,
                    onLost: () => lost++,
                })
            );
            const realOpen = fsp.open;
            let release;
            const gate = new Promise(r => (release = r));
            fsp.open = async (file, flags, ...rest) => {
                if (file === bsyPath && 'r+' === flags) {
                    await gate;
                }
                return realOpen.call(fsp, file, flags, ...rest);
            };
            try {
                bsoLock._refreshHeldNow(); //  hangs
                await new Promise(r => setTimeout(r, 150));
                await Promise.race([
                    bsoLock._refreshHeldNow(),
                    new Promise(r => setTimeout(r, 50)),
                ]);
                assert.equal(lost, 1);
                assert.equal(bsoLock.heldCount(), 0);
            } finally {
                fsp.open = realOpen;
                release();
            }
        });

        it('on exit removes a lock created but not yet written, and leaves one it did not create', async () => {
            const realOpen = fsp.open;
            let reached;
            const atGate = new Promise(r => (reached = r));
            let release;
            const gate = new Promise(r => (release = r));
            fsp.open = async (file, flags, ...rest) => {
                const fh = await realOpen.call(fsp, file, flags, ...rest);
                if (file === bsyPath && 'wx' === flags) {
                    const write = fh.writeFile.bind(fh);
                    fh.writeFile = async data => {
                        reached();
                        await gate;
                        return write(data);
                    };
                }
                return fh;
            };
            try {
                const taking = bsoLock.acquire(bsyPath);
                await atGate;
                assert.equal(fs.readFileSync(bsyPath, 'utf8'), '', 'created, empty');
                bsoLock._releaseHeldSync();
                assert.ok(!fs.existsSync(bsyPath), 'ours, so removed');
                release();
                await taking;
            } finally {
                fsp.open = realOpen;
                release();
            }

            //  Not created by us: an exit while our create is still pending
            //  must leave whatever is there.
            const other = paths.join(tmpDir, '00da02bd.bsy');
            let openGate;
            const createGate = new Promise(r => (openGate = r));
            let atCreate;
            const reachedCreate = new Promise(r => (atCreate = r));
            fsp.open = async (file, flags, ...rest) => {
                if (file === other && 'wx' === flags) {
                    atCreate();
                    await createGate;
                }
                return realOpen.call(fsp, file, flags, ...rest);
            };
            try {
                const taking = bsoLock.acquire(other);
                await reachedCreate;
                fs.writeFileSync(other, ''); //  someone else's, empty
                bsoLock._releaseHeldSync();
                assert.ok(fs.existsSync(other), 'not ours');
                openGate();
                assert.equal(await taking, false);
            } finally {
                fsp.open = realOpen;
                openGate();
            }
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
