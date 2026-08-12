/* eslint-env mocha */
'use strict';

//
//  Regression coverage for FTN inbound bundle import/cleanup.
//
//  Background: inbound mail arrives as compressed "bundle" files (day-of-week
//  extensions such as .mo0, .tu1, ...).  performImport() runs each cycle under a
//  5-minute watchdog.  A prior implementation extracted + tossed *every* bundle
//  first and only removed the source bundles in a final waterfall stage.  On a
//  large backlog that final stage was never reached before the watchdog forced
//  completion, so no bundle was ever removed and the same backlog was re-tossed
//  forever (see logs: "FTN watchdog timeout; forcing completion" + endless
//  "imported with 0 new message(s), N duplicate(s) skipped").
//
//  The fix makes cleanup per-bundle: extract -> toss -> archive + unlink the
//  source, one bundle at a time, so partial progress is durable and the backlog
//  drains monotonically even if a pass is interrupted.
//
//  These tests exercise the REAL importFromDirectory / importBundles /
//  importPacketFilesFromDirectory / maybeArchiveImportFile code, stubbing only
//  the leaf dependencies (archive extraction and DB packet import) so no
//  archiver binaries or message database are required.
//

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const paths = require('path');

//  Day-of-week bundle extensions understood by the importer's bundle regexp.
const BUNDLE_EXTS = [
    'su0',
    'mo0',
    'tu0',
    'we0',
    'th0',
    'fr0',
    'sa0',
    'mo1',
    'tu1',
    'we2',
    'th3',
    'fr4',
    'sa5',
    'su9',
];

let FtnBso;

function makeTempDir(prefix) {
    return fs.mkdtempSync(paths.join(os.tmpdir(), prefix));
}

function rmrf(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

function bundleName(index) {
    const ext = BUNDLE_EXTS[index % BUNDLE_EXTS.length];
    //  zero-padded so lexical order == creation order (readdir stability)
    return `bundle${String(index).padStart(4, '0')}.${ext}`;
}

function seedBacklog(dir, count) {
    const names = [];
    for (let i = 0; i < count; ++i) {
        const name = bundleName(i);
        fs.writeFileSync(paths.join(dir, name), `bundle-${i}-payload`);
        names.push(name);
    }
    return names;
}

//  Count remaining bundle files (ignores any stray non-bundle artifacts).
function countBundles(dir) {
    const re = /\.(su|mo|tu|we|th|fr|sa)[0-9a-z]$/i;
    return fs.readdirSync(dir).filter(f => re.test(f)).length;
}

//
//  Build a real FTN module instance wired to a scratch backlog/temp/reject
//  layout, with leaf dependencies replaced by controllable stubs.
//
function makeHarness(overrides = {}) {
    const backlogDir = makeTempDir('ftn-backlog-');
    const tempDir = makeTempDir('ftn-temp-');
    const rejectDir = makeTempDir('ftn-reject-');

    const inst = new FtnBso.getModule();
    inst.moduleConfig = { paths: { reject: rejectDir } }; //  retain intentionally unset
    inst.importTempDir = tempDir;

    const tossed = []; //  packet paths handed to the (stubbed) DB import

    //  Own archUtil object so we never mutate the shared ArchiveUtil singleton.
    inst.archUtil = {
        detectType: (path, cb) => {
            const archName = overrides.detectType ? overrides.detectType(path) : 'zip';
            return cb(null, archName);
        },
        extractTo:
            overrides.extractTo ||
            ((archivePath, extractPath, archType, cb) => {
                //  default "good" extraction: emit one packet per bundle
                const pkt = paths.join(extractPath, `${paths.basename(archivePath)}.pkt`);
                fs.writeFileSync(pkt, 'PKT');
                return cb(null);
            }),
    };

    inst.importMessagesFromPacketFile =
        overrides.importPacket ||
        ((packetPath, password, cb) => {
            tossed.push(packetPath);
            return cb(null);
        });

    inst.processTicFilesInDirectory = (dir, cb) => cb(null);

    return {
        inst,
        backlogDir,
        tempDir,
        rejectDir,
        tossed,
        cleanup: () => {
            rmrf(backlogDir);
            rmrf(tempDir);
            rmrf(rejectDir);
        },
    };
}

function importOnce(inst, backlogDir) {
    return new Promise((resolve, reject) => {
        inst.importFromDirectory('secInbound', backlogDir, err =>
            err ? reject(err) : resolve()
        );
    });
}

describe('FTN BSO inbound bundle import', () => {
    before(() => {
        //  ftn_bso captures Config/Log at require time; test/setup.js has already
        //  installed quiet stubs. The methods under test read only instance state.
        FtnBso = require('../core/scanner_tossers/ftn_bso.js');
    });

    let h;
    afterEach(() => {
        if (h) {
            h.cleanup();
            h = null;
        }
    });

    it('drains an entire backlog in a single pass and tosses every bundle', async () => {
        h = makeHarness();
        const N = 25;
        seedBacklog(h.backlogDir, N);
        assert.strictEqual(countBundles(h.backlogDir), N);

        await importOnce(h.inst, h.backlogDir);

        assert.strictEqual(countBundles(h.backlogDir), 0, 'all bundles removed');
        assert.strictEqual(h.tossed.length, N, 'every bundle tossed exactly once');
        //  temp dir must not accumulate extracted packets across bundles
        const leftoverPkts = fs
            .readdirSync(h.tempDir)
            .filter(f => f.toLowerCase().endsWith('.pkt'));
        assert.strictEqual(leftoverPkts.length, 0, 'temp dir left clean');
        //  good bundles are not archived to the reject dir
        assert.strictEqual(fs.readdirSync(h.rejectDir).length, 0, 'reject dir empty');
    });

    //
    //  Core regression guard. The old all-or-nothing cleanup removed nothing
    //  until the very end, so at extract time for bundle i, all N sources still
    //  existed. With per-bundle cleanup, bundle i-1 is fully removed before
    //  bundle i is extracted, so exactly i sources are gone when extract(i) runs.
    //
    it('removes each bundle before starting the next (durable incremental progress)', async () => {
        const remainingAtExtract = [];
        const backlogRef = { dir: null };

        h = makeHarness({
            extractTo: (archivePath, extractPath, archType, cb) => {
                remainingAtExtract.push(countBundles(backlogRef.dir));
                fs.writeFileSync(
                    paths.join(extractPath, `${paths.basename(archivePath)}.pkt`),
                    'PKT'
                );
                return cb(null);
            },
        });
        backlogRef.dir = h.backlogDir;

        const N = 12;
        seedBacklog(h.backlogDir, N);
        await importOnce(h.inst, h.backlogDir);

        assert.strictEqual(remainingAtExtract.length, N, 'extracted every bundle');
        //  Strictly monotonic cleanup: N, N-1, ..., 1
        remainingAtExtract.forEach((remaining, i) => {
            assert.strictEqual(
                remaining,
                N - i,
                `at extract #${i}, expected ${
                    N - i
                } bundles left but found ${remaining} ` +
                    `(old cleanup-at-end behavior would report ${N})`
            );
        });
        assert.strictEqual(countBundles(h.backlogDir), 0);
    });

    //
    //  Reproduces the production failure mode: one bundle "hangs" (its extract
    //  never calls back) so the watchdog abandons the caller mid-pass. Everything
    //  already processed must stay removed, and a later cycle must finish the job.
    //
    it('keeps partial progress when a pass is interrupted, and resumes to full drain', async () => {
        const N = 10;
        const HANG_AT = 4; //  0-based index of the bundle that stalls on cycle 1

        let cycle = 0;
        let callInCycle = 0;
        let onAbandon = null;

        h = makeHarness({
            extractTo: (archivePath, extractPath, archType, cb) => {
                if (cycle === 1 && callInCycle === HANG_AT) {
                    //  Simulate a stalled extraction: never call cb. The watchdog
                    //  would fire here and force-complete the *caller* while this
                    //  work is abandoned. Signal the harness to stop awaiting.
                    ++callInCycle;
                    if (onAbandon) onAbandon();
                    return;
                }
                ++callInCycle;
                fs.writeFileSync(
                    paths.join(extractPath, `${paths.basename(archivePath)}.pkt`),
                    'PKT'
                );
                return cb(null);
            },
        });

        seedBacklog(h.backlogDir, N);

        //  Cycle 1: runs until the stalled bundle, then we abandon the caller
        //  (mirrors guardedCall firing cb on watchdog timeout).
        cycle = 1;
        callInCycle = 0;
        await new Promise(resolve => {
            onAbandon = resolve;
            //  If it somehow completes without hanging, resolve anyway.
            h.inst.importFromDirectory('secInbound', h.backlogDir, () => resolve());
        });

        //  Bundles 0..HANG_AT-1 fully processed + unlinked; HANG_AT..N-1 remain.
        assert.strictEqual(
            countBundles(h.backlogDir),
            N - HANG_AT,
            'interrupted pass left exactly the unprocessed remainder on disk'
        );
        assert.strictEqual(h.tossed.length, HANG_AT, 'only completed bundles tossed');

        //  Cycle 2: fresh trigger, no stall — must finish draining the remainder.
        cycle = 2;
        callInCycle = 0;
        await importOnce(h.inst, h.backlogDir);

        assert.strictEqual(countBundles(h.backlogDir), 0, 'resume drained the backlog');
        assert.strictEqual(
            h.tossed.length,
            N,
            'all bundles tossed across the two cycles (remainder re-tossed once)'
        );
    });

    //
    //  A bundle we cannot process (unknown archive type or failed extraction)
    //  must still be removed from the inbound dir (archived to the reject dir),
    //  otherwise a single poison bundle would wedge the backlog forever.
    //
    it('removes un-processable bundles (unknown type / extract failure) so they cannot wedge the queue', async () => {
        h = makeHarness({
            detectType: path => {
                //  bundle named with "unknown" => archUtil cannot classify it
                return paths.basename(path).includes('unknown') ? undefined : 'zip';
            },
            extractTo: (archivePath, extractPath, archType, cb) => {
                if (paths.basename(archivePath).includes('badx')) {
                    return cb(new Error('corrupt archive'));
                }
                fs.writeFileSync(
                    paths.join(extractPath, `${paths.basename(archivePath)}.pkt`),
                    'PKT'
                );
                return cb(null);
            },
        });

        //  1 good, 1 unknown-type, 1 extract-failure
        fs.writeFileSync(paths.join(h.backlogDir, 'good0001.mo0'), 'x');
        fs.writeFileSync(paths.join(h.backlogDir, 'unknown01.tu0'), 'x');
        fs.writeFileSync(paths.join(h.backlogDir, 'badx0001.we0'), 'x');
        assert.strictEqual(countBundles(h.backlogDir), 3);

        await importOnce(h.inst, h.backlogDir);

        assert.strictEqual(
            countBundles(h.backlogDir),
            0,
            'all bundles removed from inbound, including the un-processable ones'
        );
        assert.strictEqual(h.tossed.length, 1, 'only the good bundle produced a toss');
        //  The two bad bundles are preserved in the reject dir for inspection.
        const rejects = fs.readdirSync(h.rejectDir);
        assert.strictEqual(rejects.length, 2, 'both bad bundles archived as rejects');
        assert.ok(
            rejects.every(f => f.startsWith('reject-bundle--')),
            'rejects archived with expected naming'
        );
    });
});
