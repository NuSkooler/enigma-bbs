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

        it('records our pid, as §5.1 permits', async () => {
            await bsoLock.acquire(bsyPath);
            assert.equal(
                (await fsp.readFile(bsyPath, 'utf8')).trim(),
                String(process.pid)
            );
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
            assert.equal(
                (await fsp.readFile(bsyPath, 'utf8')).trim(),
                String(process.pid)
            );
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
});
