'use strict';

//
//  oputil fb hatch -- the whole operation, end to end (#751).
//
//  tic_hatch.test.js covers the pure parts and ftn_tic_hatch.test.js covers
//  what reaches the spool. Neither touched hatch() itself: the copy, the scan,
//  the persist, the collision handling and the supersede. Four defects lived in
//  exactly that gap, including one that announced a name it did not ship.
//
//  Driven as a real process, like oputil_bso.test.js, because the alternative
//  is standing up a file database and a storage tree inside the test runner and
//  fighting the module cache for Config -- which is the machinery that made
//  this half untested in the first place.
//

const { strict: assert } = require('assert');
const { execFileSync } = require('child_process');
const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO_ROOT = path.join(__dirname, '..');

//  21:1/200 -> net 1 (0001), node 200 (00c8)
const FLOW_BASE = '000100c8';

describe('oputil fb hatch', function () {
    //  Each case spawns node and opens the databases.
    this.timeout(60000);

    let tmpDir;
    let seq = 0;

    before(async () => {
        tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'enigma_fb_hatch_'));
    });

    after(async () => {
        await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    async function makeFixture() {
        const root = path.join(tmpDir, `f${seq++}`);
        const storage = path.join(root, 'filebase', 'nodelist');
        for (const d of [
            path.join(root, 'db'),
            path.join(root, 'logs'),
            path.join(root, 'ob'),
            path.join(root, 'staging'),
            storage,
        ]) {
            await fsp.mkdir(d, { recursive: true });
        }

        await fsp.writeFile(
            path.join(root, 'config.hjson'),
            `{
                general: { boardName: "Hatch Test" }
                paths: { db: "${path.join(root, 'db')}", logs: "${path.join(
                    root,
                    'logs'
                )}" }
                loginServers: { telnet: { enabled: false }, ssh: { enabled: false } }
                fileBase: {
                    areaStoragePrefix: "${path.join(root, 'filebase')}/"
                    storageTags: { nodelist_main: "nodelist" }
                    areas: {
                        fsx_nodelist: {
                            name: "Nodelist"
                            desc: "Weekly"
                            storageTags: [ "nodelist_main" ]
                        }
                    }
                }
                messageNetworks: {
                    ftn: { networks: { fsxnet: { localAddress: "21:1/151", defaultZone: 21 } } }
                }
                scannerTossers: {
                    ftn_bso: {
                        defaultNetwork: "fsxnet"
                        paths: { outbound: "${path.join(root, 'ob')}" }
                        nodes: { "21:1/200": { tic: { password: "DOWNPASS" } } }
                        ticAreas: {
                            fsx_nodelist: {
                                areaTag: "fsx_nodelist"
                                network: "fsxnet"
                                uplinks: [ "21:1/100" ]
                                downlinks: [ "21:1/200" ]
                            }
                        }
                    }
                }
            }`
        );

        return { root, storage, staging: path.join(root, 'staging') };
    }

    //  oputil's getConfigPath() concatenates rather than joins.
    function hatch(root, args) {
        try {
            const out = execFileSync(
                process.execPath,
                ['./oputil.js', '-c', `${root}${path.sep}`, 'fb', 'hatch', ...args],
                { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe' }
            );
            return { code: 0, out };
        } catch (err) {
            return { code: err.status, out: `${err.stdout || ''}${err.stderr || ''}` };
        }
    }

    const stored = storage => fs.readdirSync(storage).sort();

    function spool(root) {
        const dir = path.join(root, 'ob', 'outbound');
        let entries = [];
        try {
            entries = fs.readdirSync(dir);
        } catch {
            return { tics: [], flow: null };
        }
        const flowName = entries.find(e => e.toLowerCase().startsWith(FLOW_BASE));
        return {
            dir,
            tics: entries.filter(e => e.toLowerCase().endsWith('.tic')),
            flow: flowName ? fs.readFileSync(path.join(dir, flowName), 'utf8') : null,
        };
    }

    const ticValue = (content, keyword) => {
        const line = content.split('\r\n').find(l => l.startsWith(`${keyword} `));
        return line ? line.slice(keyword.length + 1) : undefined;
    };

    // ── the name we announce is the name we ship ──────────────────────────────

    it('ships the file under exactly the name the TIC announces', async () => {
        //
        //  BinkP offers a file by its basename and htick pairs a payload
        //  strictly by "File" -- case-adaptation only, no Lfile fallback, and
        //  our own reader is the same. Announcing one name while shipping
        //  another leaves the downlink an orphan it can never pair up, which is
        //  the very thing forwardTicToDownlinks() refuses to do for a
        //  collision-renamed import.
        //
        const { root, storage, staging } = await makeFixture();
        const src = path.join(staging, 'fsxnet-infopack.zip');
        await fsp.writeFile(src, 'infopack');

        const { code } = hatch(root, ['fsx_nodelist', src, '--desc', 'fsxNet infopack']);
        assert.equal(code, 0);

        const { dir, tics, flow } = spool(root);
        assert.equal(tics.length, 1);
        const content = fs.readFileSync(path.join(dir, tics[0]), 'utf8');

        const announced = ticValue(content, 'File');
        assert.equal(announced, 'FSXNET-I.ZIP', 'the 8.3 name, per FTS-5006');
        assert.deepEqual(
            stored(storage),
            [announced],
            'and the file base copy must carry that same name'
        );
        assert.equal(
            path.basename(flow.trim().split('\n')[0]),
            announced,
            'and so must the basename queued for the downlink'
        );

        //  The long name still travels, for receivers that honour it.
        assert.equal(ticValue(content, 'Lfile'), 'fsxnet-infopack.zip');
    });

    it('needs no Lfile when the name is already 8.3', async () => {
        const { root, staging } = await makeFixture();
        const src = path.join(staging, 'NODELIST.246');
        await fsp.writeFile(src, 'nodelist');

        assert.equal(hatch(root, ['fsx_nodelist', src]).code, 0);

        const { dir, tics } = spool(root);
        const content = fs.readFileSync(path.join(dir, tics[0]), 'utf8');
        assert.equal(ticValue(content, 'File'), 'NODELIST.246');
        assert.equal(ticValue(content, 'Lfile'), undefined);
    });

    // ── --replaces ────────────────────────────────────────────────────────────

    it('supersedes the file it matched and no other', async () => {
        //
        //  |dst| is derived from the *new* file's name and has nothing to do
        //  with the entry --replaces matched, so the update branch overwrote
        //  whatever happened to share the new name -- leaving that entry's row
        //  describing bytes that no longer existed, and two rows sharing one
        //  physical file.
        //
        const { root, storage, staging } = await makeFixture();

        const readme = path.join(staging, 'readme.txt');
        await fsp.writeFile(readme, 'AAAA');
        assert.equal(hatch(root, ['fsx_nodelist', readme, '--desc', 'r']).code, 0);

        const nodelist = path.join(staging, 'nodelist.246');
        await fsp.writeFile(nodelist, 'BBBB');
        assert.equal(hatch(root, ['fsx_nodelist', nodelist, '--desc', 'n']).code, 0);

        //  A *different* readme.txt, superseding the nodelist.
        const other = path.join(staging, 'v2');
        await fsp.mkdir(other, { recursive: true });
        const readme2 = path.join(other, 'readme.txt');
        await fsp.writeFile(readme2, 'CCCC');

        const { out } = hatch(root, [
            'fsx_nodelist',
            readme2,
            '--desc',
            'r2',
            '--replaces',
            'NODELIST.*',
        ]);

        assert.match(out, /already exists/, 'it must refuse rather than overwrite');
        assert.equal(
            fs.readFileSync(path.join(storage, 'README.TXT'), 'utf8'),
            'AAAA',
            "the unrelated entry's bytes must survive"
        );
        assert.deepEqual(
            stored(storage),
            ['NODELIST.246', 'README.TXT'],
            'and nothing may be left behind'
        );
    });

    it('replaces a weekly file in place, dequeuing the old pair', async () => {
        const { root, storage, staging } = await makeFixture();

        const first = path.join(staging, 'nodelist.246');
        await fsp.writeFile(first, 'week 246');
        assert.equal(
            hatch(root, ['fsx_nodelist', first, '--replaces', 'NODELIST.*']).code,
            0
        );

        const before = spool(root);
        assert.equal(before.tics.length, 1);
        const oldTic = path.join(before.dir, before.tics[0]);

        const second = path.join(staging, 'nodelist.253');
        await fsp.writeFile(second, 'week 253');
        const { out } = hatch(root, ['fsx_nodelist', second, '--replaces', 'NODELIST.*']);

        assert.match(out, /Replaces\s+NODELIST\.246/, 'it must say what it superseded');
        assert.deepEqual(stored(storage), ['NODELIST.253'], 'the old physical file goes');

        const after = spool(root);
        assert.equal(after.tics.length, 1, 'and so does the TIC announcing it');
        assert.equal(fs.existsSync(oldTic), false);
        assert.deepEqual(
            after.flow
                .trim()
                .split('\n')
                .map(l => path.basename(l)),
            ['NODELIST.253', after.tics[0]]
        );
    });

    // ── failure paths leave nothing behind ────────────────────────────────────

    it('leaves no orphan in the area when it refuses a collision', async () => {
        const { root, storage, staging } = await makeFixture();
        const src = path.join(staging, 'nodelist.246');
        await fsp.writeFile(src, 'first');
        assert.equal(hatch(root, ['fsx_nodelist', src]).code, 0);

        const other = path.join(staging, 'again');
        await fsp.mkdir(other, { recursive: true });
        const dupe = path.join(other, 'nodelist.246');
        await fsp.writeFile(dupe, 'second');

        const { code, out } = hatch(root, ['fsx_nodelist', dupe]);

        assert.notEqual(code, 0, 'a refusal must not look like success');
        assert.match(out, /already exists/);
        assert.deepEqual(
            stored(storage),
            ['NODELIST.246'],
            'the renamed copy must be taken back out'
        );
        assert.equal(
            fs.readFileSync(path.join(storage, 'NODELIST.246'), 'utf8'),
            'first'
        );
    });

    it('copies through a symlink rather than storing the link', async () => {
        //
        //  fs.stat() follows a link, but fs-extra's copy does not -- it copies
        //  the link, target string and all. A relative one then dangles in the
        //  file base. Hatching from a "latest" pointer is an obvious thing to
        //  want.
        //
        const { root, storage, staging } = await makeFixture();
        await fsp.writeFile(path.join(staging, 'nodelist.253'), 'week 253');
        await fsp.symlink('nodelist.253', path.join(staging, 'NODELIST.LST'));

        const { code } = hatch(root, [
            'fsx_nodelist',
            path.join(staging, 'NODELIST.LST'),
        ]);
        assert.equal(code, 0);

        const dst = path.join(storage, 'NODELIST.LST');
        assert.equal(
            fs.lstatSync(dst).isSymbolicLink(),
            false,
            'a link in the file base dangles as soon as the source moves'
        );
        assert.equal(fs.readFileSync(dst, 'utf8'), 'week 253');
    });

    // ── the CLI contract ──────────────────────────────────────────────────────

    it('honours --dry-run wherever it appears, and writes nothing', async () => {
        //
        //  A flag missing from minimist's boolean list binds the next
        //  positional as its value, so "--dry-run AREA FILE" made dry-run the
        //  string "AREA" -- and `true === argv['dry-run']` is then false, i.e.
        //  a real hatch when the operator asked to be shown one.
        //
        for (const args of [
            ['--dry-run', 'fsx_nodelist', 'SRC'],
            ['fsx_nodelist', 'SRC', '--dry-run'],
        ]) {
            const { root, storage, staging } = await makeFixture();
            const src = path.join(staging, 'nodelist.246');
            await fsp.writeFile(src, 'nodelist');

            const { code, out } = hatch(
                root,
                args.map(a => (a === 'SRC' ? src : a))
            );

            assert.equal(code, 0, `${args}`);
            assert.match(out, /Would hatch/, `${args}`);
            assert.deepEqual(stored(storage), [], `${args}: nothing may be written`);
            assert.deepEqual(spool(root).tics, [], `${args}: and nothing queued`);
        }
    });

    it('refuses a value flag given without a value', async () => {
        //  Otherwise it is boolean true, and "Replaces true" goes into the TIC.
        const { root, staging } = await makeFixture();
        const src = path.join(staging, 'nodelist.246');
        await fsp.writeFile(src, 'nodelist');

        const { code, out } = hatch(root, ['fsx_nodelist', src, '--replaces']);
        assert.notEqual(code, 0);
        assert.match(out, /--replaces needs a value/);
    });
});
