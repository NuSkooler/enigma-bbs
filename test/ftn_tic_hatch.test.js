'use strict';

//
//  What a hatch puts in the outbound spool (#751).
//
//  tic_hatch.test.js pins the TIC we render from local metadata; this pins what
//  a downlink actually receives -- the generated .tic, the flow file references,
//  and the three fields that distinguish originating a file from passing one on:
//  Origin is us, Path begins with our line, and Seenby is us plus every
//  downlink.
//
//  announceTicToDownlinks() is driven directly, as ftn_tic_forward.test.js
//  drives forwardTicToDownlinks(). The file base half -- copy, scan, persist --
//  needs a live database and is exercised against a real instance instead.
//

const { strict: assert } = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const paths = require('path');

const configModule = require('../core/config.js');
const TicFileInfo = require('../core/tic_file_info.js');
const { buildHatchTic } = require('../core/tic_hatch.js');

describe('TIC hatching into the outbound', function () {
    let tmpDir;
    let outboundDir;
    let inst;
    let prevConfig;

    const OUR_ADDR = '21:1/151';
    const DOWNLINK_A = '21:1/200';
    const DOWNLINK_B = '21:1/300';
    const AREA = 'FSX_NODELIST';

    //  21:1/200 -> net 1 (0001), node 200 (00c8)
    const FLOW_A = '000100c8';
    //  21:1/300 -> node 300 (012c)
    const FLOW_B = '0001012c';

    function makeConfig(overrides = {}) {
        return {
            debug: { assertsEnabled: false },
            general: { boardName: 'Test BBS' },
            fileBase: { areas: {}, storageTags: {} },
            scannerTossers: {
                ftn_bso: {
                    defaultNetwork: 'fsxnet',
                    paths: { outbound: outboundDir },
                    tic: {},
                    ticAreas: overrides.ticAreas || {
                        fsx_nodelist: {
                            areaTag: 'fsx_nodelist',
                            network: 'fsxnet',
                            downlinks: [DOWNLINK_A],
                        },
                    },
                    nodes: overrides.nodes || {
                        [DOWNLINK_A]: { tic: { password: 'APASS' } },
                        [DOWNLINK_B]: { tic: { password: 'BPASS' } },
                    },
                },
            },
            messageNetworks: {
                ftn: {
                    networks: {
                        fsxnet: { localAddress: OUR_ADDR, defaultZone: 21 },
                    },
                },
            },
        };
    }

    function push(overrides) {
        if (prevConfig !== undefined) {
            configModule._popTestConfig(prevConfig);
        }
        prevConfig = configModule._pushTestConfig(makeConfig(overrides));
        const { getModule } = require('../core/scanner_tossers/ftn_bso.js');
        inst = new getModule();
    }

    beforeEach(async () => {
        tmpDir = await fsp.mkdtemp(paths.join(os.tmpdir(), 'enigma_tichatch_'));
        outboundDir = paths.join(tmpDir, 'outbound');
        await fsp.mkdir(outboundDir, { recursive: true });
        push();
    });

    afterEach(async () => {
        if (prevConfig !== undefined) {
            configModule._popTestConfig(prevConfig);
            prevConfig = undefined;
        }
        await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    //  A payload in file base storage, as it is after the copy/scan half.
    function storedPayload(name = 'nodelist.246') {
        const dir = paths.join(tmpDir, 'filebase');
        fs.mkdirSync(dir, { recursive: true });
        const p = paths.join(dir, name);
        fs.writeFileSync(p, 'nodelist bytes');
        return p;
    }

    //  Exactly what tic_hatch.hatch() hands announceTicToDownlinks().
    function hatchTic(overrides = {}) {
        return TicFileInfo.createFromString(
            buildHatchTic(
                Object.assign(
                    {
                        areaTag: AREA,
                        origin: OUR_ADDR,
                        fileName: 'NODELIST.246',
                        longFileName: 'nodelist.246',
                        size: 14,
                        date: 1757900000,
                        desc: 'fsxNet nodelist',
                    },
                    overrides
                )
            )
        );
    }

    function announce(
        localInfoOverrides = {},
        ticOverrides = {},
        areaTag = 'fsx_nodelist'
    ) {
        const cfg = configModule.get().scannerTossers.ftn_bso.ticAreas[areaTag];
        const downlinks = Array.isArray(cfg.downlinks)
            ? cfg.downlinks
            : String(cfg.downlinks).split(/\s+/);

        const localInfo = Object.assign(
            {
                externalAreaTag: AREA,
                areaTag: 'fsx_nodelist',
                newPath: storedPayload(),
                crc32: 'deadbeef',
                fileEntry: { meta: { file_crc32: 'deadbeef' } },
            },
            localInfoOverrides
        );

        return new Promise(resolve =>
            inst.announceTicToDownlinks(
                hatchTic(ticOverrides),
                localInfo,
                cfg,
                downlinks,
                () => resolve(localInfo)
            )
        );
    }

    async function spoolState() {
        const dir = paths.join(outboundDir, 'outbound');
        let entries = [];
        try {
            entries = await fsp.readdir(dir);
        } catch {
            return { flows: {}, tics: [], entries: [] };
        }

        const flows = {};
        for (const base of [FLOW_A, FLOW_B]) {
            const name = entries.find(e => e.toLowerCase().startsWith(base));
            flows[base] = name ? await fsp.readFile(paths.join(dir, name), 'utf8') : null;
        }

        const tics = [];
        for (const e of entries.filter(e => e.toLowerCase().endsWith('.tic'))) {
            tics.push({
                name: e,
                path: paths.join(dir, e),
                content: await fsp.readFile(paths.join(dir, e), 'utf8'),
            });
        }

        return { flows, tics, entries };
    }

    const valuesOf = (content, keyword) =>
        content
            .split('\r\n')
            .filter(l => l.startsWith(`${keyword} `))
            .map(l => l.slice(keyword.length + 1));

    const valueOf = (content, keyword) => valuesOf(content, keyword)[0];

    describe('the happy path', () => {
        it('queues the payload and its TIC, in that order', async () => {
            const info = await announce();
            const { flows, tics } = await spoolState();

            assert.equal(tics.length, 1, 'one TIC for one downlink');

            //  FSC-0087: the file goes FIRST, so a failed session cannot
            //  orphan the announcement. The payload lives in our file base and
            //  is not ours to delete, so it carries no directive; the
            //  generated TIC is disposable and gets '^'.
            const lines = flows[FLOW_A].trim().split('\n');
            assert.deepEqual(lines, [info.newPath, `^${tics[0].path}`]);
        });

        it('has the TIC deleted after sending and the payload kept', async () => {
            //  oputil fb hatch queues through the same writer; its '^' TIC
            //  must be in a mail directory (core/bso_flow_paths.js).
            await announce();

            const { buildSpool } = require('../core/binkp/util.js');
            const Address = require('../core/ftn_address.js');
            const files = await buildSpool(makeConfig()).getOutboundFilesForNode(
                Address.fromString(DOWNLINK_A)
            );

            assert.deepEqual(
                files.map(f => [
                    paths.extname(f.path).toLowerCase(),
                    f.disposition,
                    f.allowed,
                ]),
                [
                    ['.246', 'keep', true],
                    ['.tic', 'delete', true],
                ]
            );
        });

        it('names us as the Origin', async () => {
            //  The whole difference between hatching and forwarding. A
            //  downstream "Replaces" is scoped by origin, so this is what makes
            //  next week's nodelist supersede this week's four hops away.
            await announce();
            const { tics } = await spoolState();
            assert.equal(valueOf(tics[0].content, 'Origin'), OUR_ADDR);
        });

        it('starts the Path with our own line and nothing before it', async () => {
            await announce();
            const { tics } = await spoolState();

            const path = valuesOf(tics[0].content, 'Path');
            assert.equal(path.length, 1, 'a hatched file has taken no hops yet');
            assert.ok(
                path[0].startsWith(`${OUR_ADDR} `),
                `expected our address first, got ${path[0]}`
            );
        });

        it('seeds the Seenby with us and every downlink', async () => {
            push({
                ticAreas: {
                    fsx_nodelist: {
                        areaTag: 'fsx_nodelist',
                        network: 'fsxnet',
                        downlinks: [DOWNLINK_A, DOWNLINK_B],
                    },
                },
            });
            await announce();
            const { tics } = await spoolState();

            assert.equal(tics.length, 2, 'one TIC each');
            for (const tic of tics) {
                assert.deepEqual(
                    valuesOf(tic.content, 'Seenby').sort(),
                    [OUR_ADDR, DOWNLINK_A, DOWNLINK_B].sort(),
                    'every downlink gets the same complete list -- that is what ' +
                        'makes it a loop guard two hops out'
                );
            }
        });

        it('regenerates From, To and Pw per downlink', async () => {
            push({
                ticAreas: {
                    fsx_nodelist: {
                        areaTag: 'fsx_nodelist',
                        network: 'fsxnet',
                        downlinks: [DOWNLINK_A, DOWNLINK_B],
                    },
                },
            });
            await announce();
            const { tics } = await spoolState();

            const byTo = {};
            for (const tic of tics) {
                byTo[valueOf(tic.content, 'To')] = tic.content;
            }

            assert.deepEqual(Object.keys(byTo).sort(), [DOWNLINK_A, DOWNLINK_B].sort());
            assert.equal(valueOf(byTo[DOWNLINK_A], 'Pw'), 'APASS');
            assert.equal(valueOf(byTo[DOWNLINK_B], 'Pw'), 'BPASS');
            assert.equal(valueOf(byTo[DOWNLINK_A], 'From'), OUR_ADDR);
            assert.equal(valueOf(byTo[DOWNLINK_B], 'From'), OUR_ADDR);
        });

        it('carries the local metadata through to the downlink', async () => {
            await announce();
            const { tics } = await spoolState();

            assert.equal(valueOf(tics[0].content, 'Area'), AREA);
            assert.equal(valueOf(tics[0].content, 'File'), 'NODELIST.246');
            assert.equal(valueOf(tics[0].content, 'Lfile'), 'nodelist.246');
            assert.equal(valueOf(tics[0].content, 'Desc'), 'fsxNet nodelist');
            assert.equal(valueOf(tics[0].content, 'Size'), '14');
        });

        it('writes the computed Crc, uppercase and padded to eight', async () => {
            //  Every htick and Mystic downlink verifies this and rejects the
            //  file with our name on the From line if it disagrees.
            await announce({ fileEntry: { meta: { file_crc32: 'f401d4' } } });
            const { tics } = await spoolState();
            assert.equal(valueOf(tics[0].content, 'Crc'), '00F401D4');
        });
    });

    describe('the loop guard still applies', () => {
        it('does not announce back to a downlink that is one of our addresses', async () => {
            push({
                ticAreas: {
                    fsx_nodelist: {
                        areaTag: 'fsx_nodelist',
                        network: 'fsxnet',
                        downlinks: [OUR_ADDR, DOWNLINK_A],
                    },
                },
            });
            await announce();
            const { tics } = await spoolState();

            assert.equal(tics.length, 1);
            assert.equal(valueOf(tics[0].content, 'To'), DOWNLINK_A);
        });

        it('queues nothing when every downlink is skipped', async () => {
            push({
                ticAreas: {
                    fsx_nodelist: {
                        areaTag: 'fsx_nodelist',
                        network: 'fsxnet',
                        downlinks: [OUR_ADDR],
                    },
                },
            });
            await announce();

            const { tics, flows } = await spoolState();
            assert.equal(tics.length, 0);
            assert.ok(!flows[FLOW_A], 'no flow file should be created');
        });
    });

    describe('a hatch that supersedes an earlier one', () => {
        it('dequeues the old payload and its TIC from a downlink that has not collected them', async () => {
            //  FSC-0087: "File Forwarders should always delete and dequeue
            //  unsent TIC files when re-hatching the same or updated version of
            //  an associated file." Without this a fortnightly downlink
            //  receives day 246 and then day 253.
            const first = await announce();
            const before = await spoolState();
            assert.equal(before.tics.length, 1);
            const oldTicPath = before.tics[0].path;

            const second = await announce(
                {
                    newPath: storedPayload('nodelist.253'),
                    existingFileId: 1,
                    oldPath: first.newPath,
                },
                { fileName: 'NODELIST.253', longFileName: 'nodelist.253' }
            );

            const after = await spoolState();
            const lines = after.flows[FLOW_A].trim().split('\n');

            assert.ok(
                !lines.includes(first.newPath),
                'the superseded payload must be dequeued'
            );
            assert.ok(
                !lines.includes(`^${oldTicPath}`),
                'and the TIC announcing it, or the downlink gets an orphan'
            );
            assert.equal(
                fs.existsSync(oldTicPath),
                false,
                'the superseded TIC must be unlinked, not left in the outbound'
            );

            assert.equal(after.tics.length, 1, 'only the new TIC remains');
            assert.deepEqual(lines, [second.newPath, `^${after.tics[0].path}`]);
            assert.equal(valueOf(after.tics[0].content, 'File'), 'NODELIST.253');
        });

        it('leaves a reference the downlink has already collected alone', async () => {
            const first = await announce();
            const dir = paths.join(outboundDir, 'outbound');
            const flowName = (await fsp.readdir(dir)).find(e =>
                e.toLowerCase().startsWith(FLOW_A)
            );
            const flowPath = paths.join(dir, flowName);

            //  Mark everything sent, as a BinkP session does.
            const sent = (await fsp.readFile(flowPath, 'utf8'))
                .split('\n')
                .map(l => (l.trim() ? `~${l.trim().replace(/^\^/, '')}` : l))
                .join('\n');
            await fsp.writeFile(flowPath, sent);

            await announce(
                {
                    newPath: storedPayload('nodelist.253'),
                    existingFileId: 1,
                    oldPath: first.newPath,
                },
                { fileName: 'NODELIST.253' }
            );

            const content = await fsp.readFile(flowPath, 'utf8');
            assert.ok(
                content.includes(`~${first.newPath}`),
                'rewriting history helps nobody -- the downlink has the file'
            );
        });
    });

    describe('dequeueing from a flow file', () => {
        const latin1 = str => Buffer.from(str, 'latin1');
        let dir;
        let flowPath;

        beforeEach(async () => {
            dir = paths.join(outboundDir, 'outbound');
            await fsp.mkdir(dir, { recursive: true });
            flowPath = paths.join(dir, `${FLOW_A}.flo`);
        });

        const scrub = target =>
            new Promise(resolve => inst.scrubFlowFileRefs(flowPath, target, resolve));

        const append = (refs, directive) =>
            new Promise((resolve, reject) =>
                inst.flowFileAppendRefs(flowPath, refs, directive, undefined, err =>
                    err ? reject(err) : resolve()
                )
            );

        it('removes the flow file when only lines already sent are left', async () => {
            const tic = paths.join(dir, 'aaaa0001.tic');
            await fsp.writeFile(tic, 'Area X\r\n');
            await fsp.writeFile(flowPath, `~/fb/old.zip\n/fb/new.zip\n^${tic}\n`);

            await scrub('/fb/new.zip');

            assert.equal(fs.existsSync(flowPath), false, 'nothing is left to send');
            assert.equal(fs.existsSync(tic), false, 'its TIC is unlinked');
        });

        it('never removes a zero-length flow file (a poll request)', async () => {
            const dlo = paths.join(dir, `${FLOW_A}.dlo`);
            await fsp.writeFile(dlo, '');
            await new Promise(resolve =>
                inst.scrubFlowFileRefs(dlo, '/fb/new.zip', resolve)
            );
            assert.equal((await fsp.stat(dlo)).size, 0);
        });

        it('keeps every other line byte for byte', async () => {
            await fsp.writeFile(
                flowPath,
                Buffer.concat([
                    latin1('/fb/caf\xe9.zip\r\n'),
                    latin1('/fb/new.zip\r\n'),
                    latin1('  #/ob/0000fc9c.su0\r\n'),
                ])
            );
            await scrub('/fb/new.zip');
            assert.ok(
                (await fsp.readFile(flowPath)).equals(
                    Buffer.concat([
                        latin1('/fb/caf\xe9.zip\r\n'),
                        latin1('  #/ob/0000fc9c.su0\r\n'),
                    ])
                )
            );
        });

        it("leaves a '!' line naming the file alone: it is not queued", async () => {
            await fsp.writeFile(flowPath, '!/fb/new.zip\n/fb/other.zip\n');
            await scrub('/fb/new.zip');
            assert.equal(
                await fsp.readFile(flowPath, 'utf8'),
                '!/fb/new.zip\n/fb/other.zip\n'
            );
        });

        it('writes nothing while the node is busy', async () => {
            configModule.get().scannerTossers.ftn_bso.flowLockTimeoutMs = 50;
            const content = '/fb/new.zip\n';
            await fsp.writeFile(flowPath, content);
            await fsp.writeFile(paths.join(dir, `${FLOW_A}.bsy`), '99999');

            await scrub('/fb/new.zip');
            assert.equal(await fsp.readFile(flowPath, 'utf8'), content);
        });

        it('starts a new line when the last one has no line feed', async () => {
            await fsp.writeFile(flowPath, '~/fb/sent-by-someone-else.zip');
            await append(['/fb/a.zip'], '');
            await append(['/fb/b.zip'], '^');
            assert.equal(
                await fsp.readFile(flowPath, 'utf8'),
                '~/fb/sent-by-someone-else.zip\n/fb/a.zip\n^/fb/b.zip\n'
            );
        });

        it('writes a UTF-8 name as UTF-8', async () => {
            await append(['/fb/naïve.zip'], '');
            assert.ok(
                (await fsp.readFile(flowPath)).equals(
                    Buffer.from('/fb/naïve.zip\n', 'utf8')
                )
            );
        });
    });

    describe('a misconfigured echo', () => {
        it('queues nothing when the area names a network we do not have', async () => {
            push({
                ticAreas: {
                    fsx_nodelist: {
                        areaTag: 'fsx_nodelist',
                        network: 'nosuchnet',
                        downlinks: [DOWNLINK_A],
                    },
                },
            });

            await announce();

            const { entries } = await spoolState();
            assert.deepEqual(entries, [], 'better nothing than a TIC we cannot sign');
        });
    });
});
