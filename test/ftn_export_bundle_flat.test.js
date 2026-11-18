'use strict';

//
//  EchoMail bundle entries (issue #1078).
//
//  The export handed the archiver absolute packet paths and no working
//  directory. Info-ZIP (the default) and 7-Zip store the path of each file they
//  are given, so a bundle's entries came out as
//  tmp/enigftnexport-<session>/xxxxxxxx.pkt. A tosser that extracts with paths
//  then finds its packets in subdirectories.
//
//  Packets are now named relative to the export temp area and the archiver is
//  run from there, as the Blue Wave and QWK packers already do, so every
//  archiver builds a flat bundle. Each test here runs a real archiver, as
//  configured by default, and is skipped where it is not installed.
//

const { strict: assert } = require('assert');
const { spawnSync } = require('child_process');
const fsp = require('fs/promises');
const path = require('path');

const { createHarness, NODES, U1 } = require('./ftn_export_harness.js');
const ArchiveUtil = require('../core/archive_util.js');
const defaultArchivers = require('../core/config_default.js')().archives.archivers;

const installed = cmd => !spawnSync(cmd, ['--help'], { stdio: 'ignore' }).error;

//  Entry names in the zip at |archivePath|, through whichever lister is here.
function listZipEntries(archivePath) {
    if (installed('unzip')) {
        const res = spawnSync('unzip', ['-Z1', archivePath], { encoding: 'latin1' });
        assert.equal(res.status, 0, res.stderr);
        return res.stdout.split('\n').filter(Boolean);
    }
    const res = spawnSync('7za', ['l', '-ba', '-slt', archivePath], {
        encoding: 'latin1',
    });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout
        .split('\n')
        .filter(l => l.startsWith('Path = '))
        .map(l => l.slice('Path = '.length).trim());
}

describe('ftn_bso — EchoMail bundles hold bare packet names (#1078)', function () {
    this.timeout(20000);

    const h = createHarness();
    before(() => h.setup('ftnflat'));
    after(() => h.teardown());

    const outboundDir = () => path.join(h.root, 'outbound', 'outbound');

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

    //  A module whose U1 takes bundles, built by the real |archiverName|
    //  with its default arguments.
    function makeBundlingModule(archiverName) {
        const archiver = defaultArchivers[archiverName];
        const mod = h.makeModule();
        mod.moduleConfig = Object.assign({}, mod.moduleConfig, {
            nodes: Object.assign({}, NODES, {
                [U1]: Object.assign({}, NODES[U1], { archiveType: 'zip' }),
            }),
        });
        const archUtil = new ArchiveUtil();
        archUtil.getArchiver = () => archiver;
        archUtil.haveArchiver = () => true;
        mod.archUtil = archUtil;
        return mod;
    }

    async function u1Bundle() {
        const flow = (await fsp.readdir(outboundDir()).catch(() => [])).find(
            f => '00da02bd.clo' === f.toLowerCase()
        );
        assert.ok(flow, 'U1 has a flow file');
        const refs = (await fsp.readFile(path.join(outboundDir(), flow), 'utf8'))
            .split('\n')
            .filter(Boolean)
            .map(l => l.replace(/^[\^#~!@-]/, ''));
        assert.equal(refs.length, 1, 'U1 is sent one bundle');
        return refs[0];
    }

    for (const archiverName of ['InfoZip', '7Zip']) {
        it(`${archiverName}: every entry is a bare packet name`, async function () {
            const cmd = defaultArchivers[archiverName].compress.cmd;
            if (!installed(cmd) || !(installed('unzip') || installed('7za'))) {
                return this.skip();
            }

            const mod = makeBundlingModule(archiverName);
            //  enough to fill more than one packet (packetTargetByteSize is small)
            for (let n = 1; n <= 3; ++n) {
                await h.addLocal({
                    subject: `flat bundle ${n}`,
                    body: `Body ${n}. ${'x'.repeat(600)}`,
                });
            }

            const { err } = await h.runExportScan(mod);
            assert.ok(!err, err && err.message);

            const entries = listZipEntries(await u1Bundle());
            assert.ok(entries.length > 1, `several packets, got ${entries.length}`);
            for (const entry of entries) {
                assert.match(
                    entry,
                    /^[0-9a-f]{8}\.pkt$/i,
                    `"${entry}" is a bare packet name`
                );
            }
            assert.deepEqual(
                h.logged.filter(l => 'error' === l.level || 'warn' === l.level),
                [],
                'nothing failed'
            );
        });
    }
});
