'use strict';

//
//  EchoMail bundle names (issue #1027).
//
//  getOutgoingBundleFileName() takes the first day-of-week name (.mo0 ...
//  .moz) not already in the destination's outbound directory, and the bundle
//  is built under that name in the export temp area before it is moved there.
//  The export scan exports its areas in parallel, so two areas with the same
//  uplink could both pick a name before either bundle existed. Archivers add
//  to an archive that is already there, or, run at the same moment, keep only
//  the last one to finish: one area's bundle carried the other's packets, the
//  second move failed, and mail went out twice or not at all.
//
//  Names are now claimed in process, as packet names are, and released once
//  the bundle is in outbound or has failed to get there.
//

const { strict: assert } = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { createHarness, NODES, U1, U2, LOCAL } = require('./ftn_export_harness.js');
const Address = require('../core/ftn_address.js');

describe('ftn_bso — EchoMail bundle names (#1027)', function () {
    this.timeout(20000);

    const h = createHarness();
    before(() => h.setup('ftnbundle'));
    after(() => h.teardown());

    const outboundDir = () => path.join(h.root, 'outbound', 'outbound');
    const tempDir = () => path.join(h.root, 'temp');

    beforeEach(async () => {
        h.logged.length = 0;
        h.db.exec(
            'DELETE FROM message_area_last_scan; DELETE FROM message_meta; DELETE FROM message;'
        );
        for (const d of ['outbound', 'temp']) {
            await fsp.rm(path.join(h.root, d), { recursive: true, force: true });
            await fsp.mkdir(path.join(h.root, d), { recursive: true });
        }
    });

    //
    //  A module whose U1 takes bundles, built by a stand-in archiver. Like zip
    //  and 7za it adds to an archive that is already there: each entry is the
    //  packet's name and contents. With |holdUntil| set, each call waits until
    //  that many calls have arrived (or a short timer runs out, so a run in
    //  which they never do cannot hang), and then all of them go ahead.
    //
    function makeBundlingModule({ holdUntil = 0, failCompress = false } = {}) {
        const mod = h.makeModule();
        mod.moduleConfig = Object.assign({}, mod.moduleConfig, {
            nodes: Object.assign({}, NODES, {
                [U1]: Object.assign({}, NODES[U1], { archiveType: 'zip' }),
            }),
        });

        const calls = [];
        let held = [];
        const releaseHeld = () => {
            const go = held;
            held = [];
            go.forEach(fn => fn());
        };

        mod.archUtil = {
            haveArchiver: type => 'zip' === type,
            compressTo: (type, archivePath, files, cb) => {
                calls.push({ archivePath, files });
                const run = () => {
                    let existing = '';
                    try {
                        existing = fs.readFileSync(archivePath, 'latin1');
                    } catch (e) {
                        //  a new archive
                    }
                    const added = files
                        .map(f => `${path.basename(f)}\n${fs.readFileSync(f, 'latin1')}`)
                        .join('\n');
                    fs.writeFileSync(archivePath, existing + added, 'latin1');
                    return cb(failCompress ? new Error('archiver failed') : null);
                };
                held.push(run);
                if (held.length >= holdUntil) {
                    return releaseHeld();
                }
                setTimeout(releaseHeld, 500);
            },
        };

        return { mod, calls };
    }

    async function u1Refs() {
        const flow = (await fsp.readdir(outboundDir()).catch(() => [])).find(
            f => '00da02bd.clo' === f.toLowerCase()
        );
        if (!flow) {
            return [];
        }
        return (await fsp.readFile(path.join(outboundDir(), flow), 'utf8'))
            .split('\n')
            .filter(Boolean)
            .map(l => l.replace(/^[\^#~!@-]/, ''));
    }

    function pendingRows() {
        return h.db
            .prepare(
                `SELECT COUNT(*) AS n FROM message_meta
                WHERE meta_category = 'System' AND meta_name = ?;`
            )
            .get(h.Message.SystemMetaNames.FtnExportPending).n;
    }

    function failures() {
        return h.logged.filter(l => 'error' === l.level || 'warn' === l.level);
    }

    //  The name an export would pick for U1 now, asked of a module of its
    //  own so that nothing is left claimed in the one under test.
    function firstBundleName() {
        return new Promise((resolve, reject) =>
            h
                .makeModule()
                .getOutgoingBundleFileName(
                    outboundDir(),
                    Address.fromString(LOCAL),
                    Address.fromString(U1),
                    (err, p) => (err ? reject(err) : resolve(path.basename(p)))
                )
        );
    }

    const bundleNameRe = /^0000000[0-9a-f]\.[a-z]{2}[0-9a-z]$/;

    //  Two bundles for U1, each with exactly one of the two messages.
    async function assertTwoSeparateBundles(mod, calls, subjects) {
        const names = calls.map(c => path.basename(c.archivePath));
        assert.equal(names.length, 2, 'two bundles built for U1');
        assert.notEqual(names[0], names[1], 'each bundle has its own name');

        const refs = await u1Refs();
        assert.equal(refs.length, 2, 'U1 is sent both bundles');
        const contents = [];
        for (const ref of refs) {
            assert.match(path.basename(ref), bundleNameRe);
            contents.push(await fsp.readFile(ref, 'latin1'));
        }
        for (const subject of subjects) {
            assert.equal(
                contents.filter(c => c.includes(subject)).length,
                1,
                `"${subject}" is in exactly one bundle`
            );
        }
        assert.ok(
            contents.every(c => subjects.filter(s => c.includes(s)).length === 1),
            'each bundle holds one message'
        );
        assert.deepEqual(failures(), [], 'nothing failed');
        assert.equal(pendingRows(), 0, 'nothing is owed afterwards');
        assert.equal(mod.claimedBundleNames.size, 0, 'every claim was released');
    }

    it('two areas sharing a bundled uplink in one export scan get separate bundles', async () => {
        //  Each compress waits for the other, so both areas have picked a
        //  name before either bundle exists.
        const { mod, calls } = makeBundlingModule({ holdUntil: 2 });
        await h.addLocal({ areaTag: 'local_a', subject: 'from area A' });
        await h.addLocal({ areaTag: 'relay_a', subject: 'from area B' });

        const { err } = await h.runExportScan(mod);
        assert.ok(!err, err && err.message);

        await assertTwoSeparateBundles(mod, calls, ['from area A', 'from area B']);
    });

    it('two export calls running at once for the same area get separate bundles', async () => {
        //  An @immediate export alongside a scan, as after the export watchdog.
        const { mod, calls } = makeBundlingModule({ holdUntil: 2 });
        const a = await h.addLocal({ subject: 'first call' });
        const b = await h.addLocal({ subject: 'second call' });

        const results = await Promise.all([
            h.runLiveExport(mod, a),
            h.runLiveExport(mod, b),
        ]);
        results.forEach(({ err }) => assert.ok(!err, err && err.message));

        await assertTwoSeparateBundles(mod, calls, ['first call', 'second call']);
    });

    it('removes bundled packets from the temp area once the bundle is in outbound', async () => {
        const { mod, calls } = makeBundlingModule();
        const a = await h.addLocal({ subject: 'bundled, then gone' });
        const b = await h.addLocal({ subject: 'also bundled' });

        //  U1 takes bundles, U2 bare packets.
        const { err } = await new Promise(resolve =>
            mod.exportEchoMailMessagesToUplinks(
                [a.messageUuid, b.messageUuid],
                { network: 'testnet', tag: 'LOCAL_A', uplinks: [U1, U2] },
                [U1, U2],
                e => resolve({ err: e })
            )
        );
        assert.ok(!err, err && err.message);

        assert.equal(calls.length, 1);
        assert.ok(calls[0].files.length > 0);
        const left = await fsp.readdir(tempDir());
        assert.deepEqual(left, [], 'nothing left in the temp area');
        const refs = await u1Refs();
        assert.equal(refs.length, 1);
        const bundle = await fsp.readFile(refs[0], 'latin1');
        assert.ok(
            bundle.includes('bundled, then gone') && bundle.includes('also bundled')
        );
    });

    describe('getOutgoingBundleFileName()', () => {
        const local = Address.fromString(LOCAL);
        const dest = Address.fromString(U1);
        const pick = mod =>
            new Promise((resolve, reject) =>
                mod.getOutgoingBundleFileName(outboundDir(), local, dest, (err, p) =>
                    err ? reject(err) : resolve(p)
                )
            );

        beforeEach(() => fsp.mkdir(outboundDir(), { recursive: true }));

        it('does not hand out a claimed name until it is released', async () => {
            const mod = h.makeModule();
            const first = await pick(mod);
            const second = await pick(mod);
            assert.match(path.basename(first), bundleNameRe);
            assert.notEqual(first, second);
            assert.match(path.basename(first), /0$/);
            assert.match(path.basename(second), /1$/);

            mod.releaseBundleName(first);
            assert.equal(await pick(mod), first, 'released, so offered again');
        });

        it('claims made at the same moment get different names', async () => {
            const mod = h.makeModule();
            const names = await Promise.all([pick(mod), pick(mod), pick(mod)]);
            assert.equal(new Set(names).size, 3);
        });

        it('a name another export delivers while this one is checking is not handed out', async () => {
            //  While this pick is checking a name, another export in the
            //  same process takes the first name it can, delivers a bundle
            //  under it into outbound and releases it -- all before this
            //  pick has finished checking.
            const mod = h.makeModule();
            const gfs = require('graceful-fs');
            const savedStat = gfs.stat;
            let other = null;
            gfs.stat = function (p, cb) {
                if (null === other && p.startsWith(tempDir())) {
                    other = 'running';
                    gfs.stat = savedStat;
                    return pick(mod).then(name => {
                        fs.writeFileSync(name, 'delivered by the other export');
                        mod.releaseBundleName(name);
                        other = name;
                        savedStat.call(gfs, p, cb);
                    }, cb);
                }
                return savedStat.call(gfs, p, cb);
            };
            let mine;
            try {
                mine = await pick(mod);
            } finally {
                gfs.stat = savedStat;
            }
            assert.ok(other && 'running' !== other, 'the other export ran');
            assert.notEqual(mine, other, 'not the name the other export delivered');
            assert.equal(fs.existsSync(mine), false, 'not a name already in outbound');
        });

        it('passes over a name in outbound in upper case, or left in the temp area', async () => {
            const mod = h.makeModule();
            const base = await firstBundleName();
            const stem = base.slice(0, -1);

            await fsp.writeFile(path.join(outboundDir(), base.toUpperCase()), 'x');
            await fsp.writeFile(path.join(tempDir(), `${stem}1`), 'x');

            assert.equal(path.basename(await pick(mod)), `${stem}2`);
            assert.deepEqual(
                Array.from(mod.claimedBundleNames),
                [`${stem}2`],
                'names found taken are not left claimed'
            );
        });
    });

    it('a bundle is never built on top of a file left in the temp area', async () => {
        const { mod, calls } = makeBundlingModule();
        const a = await h.addLocal({ subject: 'fresh bundle' });

        //  Leftovers under the first two names this export could pick.
        const stem = (await firstBundleName()).slice(0, -1);
        for (const suffix of ['0', '1']) {
            await fsp.writeFile(path.join(tempDir(), `${stem}${suffix}`), 'LEFTOVER\n');
        }

        const { err } = await h.runLiveExport(mod, a);
        assert.ok(!err, err && err.message);
        assert.equal(calls.length, 1);
        const refs = await u1Refs();
        assert.equal(refs.length, 1);
        const bundle = await fsp.readFile(refs[0], 'latin1');
        assert.ok(bundle.includes('fresh bundle'));
        assert.ok(!bundle.includes('LEFTOVER'), 'nothing from the leftover');
    });

    it('an archiver that throws ends the export with an error and releases the name', async () => {
        const { mod } = makeBundlingModule();
        mod.archUtil.compressTo = () => {
            throw new Error('unusable archiver entry');
        };
        const a = await h.addLocal({ subject: 'archiver throws' });

        const { err } = await h.runLiveExport(mod, a);
        assert.ok(err, 'the export finishes, and reports the failure');
        assert.equal(mod.claimedBundleNames.size, 0, 'claim released');
        assert.deepEqual(await u1Refs(), [], 'nothing sent to U1');
        assert.equal(pendingRows() > 0, true, 'still owed to U1');
    });

    it('a failed compress removes the temp bundle and releases the name', async () => {
        const { mod } = makeBundlingModule({ failCompress: true });
        const a = await h.addLocal({ subject: 'will fail' });

        const { err } = await h.runLiveExport(mod, a);
        assert.ok(err, 'the export reports the failure');

        const leftovers = (await fsp.readdir(tempDir())).filter(f =>
            bundleNameRe.test(f)
        );
        assert.deepEqual(leftovers, [], 'no temp bundle left behind');
        assert.equal(mod.claimedBundleNames.size, 0, 'claim released');
        assert.deepEqual(await u1Refs(), [], 'nothing sent to U1');
    });

    it('a failed move into outbound removes the temp bundle and releases the name', async () => {
        const { mod } = makeBundlingModule();
        const a = await h.addLocal({ subject: 'move fails' });

        //  The name the bundle will get, and a move into outbound that fails.
        const expected = await firstBundleName();
        const fse = require('fs-extra');
        const savedMove = fse.move;
        fse.move = (src, dst, cb) =>
            /\.[a-z]{2}[0-9a-z]$/.test(dst)
                ? setImmediate(() => cb(new Error('move failed')))
                : savedMove.call(fse, src, dst, cb);
        let res;
        try {
            res = await h.runLiveExport(mod, a);
        } finally {
            fse.move = savedMove;
        }
        assert.ok(res.err, 'the export reports the failure');

        assert.equal(
            fs.existsSync(path.join(tempDir(), expected)),
            false,
            'no temp bundle left behind'
        );
        assert.equal(mod.claimedBundleNames.size, 0, 'claim released');

        //  The retry takes the same name and builds a new bundle.
        h.logged.length = 0;
        const { mod: retryMod, calls } = makeBundlingModule();
        const again = await h.runExportScan(retryMod);
        assert.ok(!again.err, again.err && again.err.message);
        assert.equal(calls.length, 1);
        assert.equal(path.basename(calls[0].archivePath), expected);
        const refs = await u1Refs();
        assert.equal(refs.length, 1);
        assert.ok((await fsp.readFile(refs[0], 'latin1')).includes('move fails'));
        assert.equal(pendingRows(), 0);
    });
});
