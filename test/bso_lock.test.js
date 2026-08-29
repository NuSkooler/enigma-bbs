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
});
