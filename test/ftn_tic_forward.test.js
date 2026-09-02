'use strict';

//
//  End-to-end coverage for TIC forwarding to downlinks (#743).
//
//  tic_forward.test.js pins the *decisions*; this pins what actually lands in
//  the outbound spool -- the generated .tic, the flow file references, and the
//  gates that stop a file being re-announced under our name when it should not
//  be.
//
//  forwardTicToDownlinks() is driven directly with a hand-built |localInfo|
//  rather than through a whole import. The file-base half (scan, persist, area
//  storage) is thoroughly covered elsewhere and needs a live database; what is
//  interesting here begins once the payload is stored.
//

const { strict: assert } = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const paths = require('path');

const configModule = require('../core/config.js');
const TicFileInfo = require('../core/tic_file_info.js');

describe('TIC forwarding to downlinks', function () {
    let tmpDir;
    let outboundDir;
    let inst;
    let prevConfig;
    let seq = 0;

    const OUR_ADDR = '21:1/151';
    const UPLINK = '21:1/100';
    const DOWNLINK = '21:1/200';
    const AREA = 'FSX_GEN';

    //  21:1/200 -> net 1 (0001), node 200 (00c8)
    const FLOW_BASE = '000100c8';

    function makeConfig(overrides = {}) {
        const ticAreas = overrides.ticAreas || {
            fsx_gen: {
                areaTag: 'fsxGeneral',
                network: 'fsxnet',
                uplinks: [UPLINK],
                downlinks: [DOWNLINK],
            },
        };

        const nodes = overrides.nodes || {
            [UPLINK]: { tic: { password: 'UPPASS' } },
            [DOWNLINK]: { tic: { password: 'DOWNPASS' } },
        };

        return {
            debug: { assertsEnabled: false },
            general: { boardName: 'Test BBS' },
            fileBase: overrides.fileBase || { areas: {}, storageTags: {} },
            scannerTossers: {
                ftn_bso: {
                    defaultNetwork: 'fsxnet',
                    paths: { outbound: outboundDir },
                    tic: {},
                    ticAreas,
                    nodes,
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
        tmpDir = await fsp.mkdtemp(paths.join(os.tmpdir(), 'enigma_ticfwd_e2e_'));
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

    const DEFAULT_TIC = [
        'Area FSX_GEN',
        'File NODELIST.Z21',
        'Desc fsxNet nodelist',
        'Origin 21:1/100',
        'From 21:1/100',
        'Crc DEADBEEF',
        'Pw UPPASS',
        'Path 21:1/100 1756500001 Fri, 29 Aug 2026 12:00:01 GMT',
        'Seenby 21:1/100',
        'Seenby 21:1/151',
    ];

    function parseTic(lines = DEFAULT_TIC) {
        const p = paths.join(tmpDir, `IN${seq++}.TIC`);
        fs.writeFileSync(p, lines.join('\r\n'));
        return new Promise((resolve, reject) => {
            TicFileInfo.createFromFile(p, (e, i) => (e ? reject(e) : resolve(i)));
        });
    }

    //  A payload sitting in file base storage, as it would be after |store|.
    function storedPayload(name = 'NODELIST.Z21') {
        const dir = paths.join(tmpDir, 'filebase');
        fs.mkdirSync(dir, { recursive: true });
        const p = paths.join(dir, name);
        fs.writeFileSync(p, 'payload bytes');
        return p;
    }

    function localInfo(overrides = {}) {
        return Object.assign(
            {
                node: UPLINK,
                inboundType: 'secInbound',
                passwordVerified: true,
                externalAreaTag: AREA,
                newPath: storedPayload(),
                wasRenamedOnCollision: false,
                fileEntry: { meta: { file_crc32: 'deadbeef' } },
            },
            overrides
        );
    }

    function forward(info, ticLines) {
        return parseTic(ticLines).then(
            tic => new Promise(resolve => inst.forwardTicToDownlinks(tic, info, resolve))
        );
    }

    //  Everything queued for 21:1/200, as { flow, tics }
    async function spoolState() {
        const dir = paths.join(outboundDir, 'outbound');
        let entries = [];
        try {
            entries = await fsp.readdir(dir);
        } catch {
            return { flow: null, tics: [] };
        }

        const flowName = entries.find(e => e.toLowerCase().startsWith(FLOW_BASE));
        const flow = flowName
            ? await fsp.readFile(paths.join(dir, flowName), 'utf8')
            : null;

        const tics = [];
        for (const e of entries.filter(e => e.toLowerCase().endsWith('.tic'))) {
            tics.push({
                name: e,
                content: await fsp.readFile(paths.join(dir, e), 'utf8'),
            });
        }

        return { flow, tics, entries };
    }

    describe('the happy path', () => {
        it('writes a TIC and queues it behind the payload', async () => {
            const info = localInfo();
            await forward(info);

            const { flow, tics } = await spoolState();
            assert.equal(tics.length, 1, 'exactly one TIC for one downlink');

            //  FSC-0087: "The associated file [...] should always be sent
            //  FIRST." The payload carries no directive (it lives in the file
            //  base and is not ours to delete); the TIC gets '^'.
            const lines = flow.trim().split('\n');
            assert.equal(lines.length, 2);
            assert.equal(lines[0], info.newPath, 'payload first, no directive');
            assert.equal(
                lines[1],
                `^${paths.join(outboundDir, 'outbound', tics[0].name)}`
            );
        });

        it('names the TIC in DOS 8.3 form', async () => {
            //  FTS-5006 2.2: "A TIC file is a text file with a name in 8.3 DOS
            //  format with the extension .TIC."
            await forward(localInfo());
            const { tics } = await spoolState();
            assert.match(tics[0].name, /^[0-9a-f]{8}\.tic$/);
        });

        it('addresses the TIC from us to the downlink, with their password', async () => {
            await forward(localInfo());
            const { tics } = await spoolState();
            const c = tics[0].content;

            assert.ok(c.includes(`From ${OUR_ADDR}`));
            assert.ok(c.includes(`To ${DOWNLINK}`));
            assert.ok(c.includes('Pw DOWNPASS'));
            assert.ok(!c.includes('UPPASS'), "the uplink's password must not leak");
        });

        it('appends our Path line after the one we received', async () => {
            await forward(localInfo());
            const { tics } = await spoolState();
            const path = tics[0].content.split('\r\n').filter(l => l.startsWith('Path '));

            assert.equal(path.length, 2);
            assert.ok(path[0].startsWith('Path 21:1/100 '), 'theirs first');
            assert.ok(path[1].startsWith(`Path ${OUR_ADDR} `), 'ours last');
        });

        it('adds us and the downlink to Seenby', async () => {
            await forward(localInfo());
            const { tics } = await spoolState();
            assert.deepEqual(
                tics[0].content.split('\r\n').filter(l => l.startsWith('Seenby ')),
                ['Seenby 21:1/100', 'Seenby 21:1/151', 'Seenby 21:1/200']
            );
        });

        it('carries the computed CRC, not the announced one', async () => {
            await forward(localInfo({ fileEntry: { meta: { file_crc32: 'c0ffee' } } }));
            const { tics } = await spoolState();
            assert.ok(tics[0].content.includes('Crc 00C0FFEE'));
            assert.ok(!tics[0].content.includes('DEADBEEF'));
        });

        it('gives each downlink its own TIC and its own password', async () => {
            push({
                ticAreas: {
                    fsx_gen: {
                        network: 'fsxnet',
                        uplinks: [UPLINK],
                        downlinks: [DOWNLINK, '21:1/300'],
                    },
                },
                nodes: {
                    [UPLINK]: { tic: { password: 'UPPASS' } },
                    [DOWNLINK]: { tic: { password: 'DOWNPASS' } },
                    '21:1/300': { tic: { password: 'THIRDPASS' } },
                },
            });

            await forward(localInfo());
            const { tics } = await spoolState();
            assert.equal(tics.length, 2);

            const byTo = {};
            tics.forEach(t => {
                const to = /^To (.+)$/m.exec(t.content)[1].trim();
                byTo[to] = t.content;
            });

            assert.ok(byTo[DOWNLINK].includes('Pw DOWNPASS'));
            assert.ok(byTo['21:1/300'].includes('Pw THIRDPASS'));
            assert.ok(!byTo[DOWNLINK].includes('THIRDPASS'), 'no cross-contamination');
        });

        it("ships bare when the link's noTic is set", async () => {
            //  HTick's noTIC.
            push({
                ticAreas: {
                    fsx_gen: {
                        network: 'fsxnet',
                        uplinks: [UPLINK],
                        downlinks: [DOWNLINK],
                    },
                },
                nodes: {
                    [UPLINK]: { tic: { password: 'UPPASS' } },
                    [DOWNLINK]: { tic: { noTic: true } },
                },
            });

            const info = localInfo();
            await forward(info);

            const { flow, tics } = await spoolState();
            assert.equal(tics.length, 0, 'no TIC generated');
            assert.equal(flow.trim(), info.newPath, 'just the payload');
        });
    });

    describe('nothing is queued when it should not be', () => {
        async function assertNothingQueued() {
            const { flow, tics } = await spoolState();
            assert.equal(flow, null, 'no flow file');
            assert.equal(tics.length, 0, 'no TIC');
        }

        it('does nothing for an area with no downlinks — the leaf case', async () => {
            push({ ticAreas: { fsx_gen: { areaTag: 'fsxGeneral' } } });
            await forward(localInfo());
            await assertNothingQueued();
        });

        it('does nothing when the only downlink has already seen the file', async () => {
            await forward(localInfo(), DEFAULT_TIC.concat([`Seenby ${DOWNLINK}`]));
            await assertNothingQueued();
        });

        it('refuses a TIC from the unsecure inbound', async () => {
            //  Importing affects our own file base; forwarding makes third
            //  parties receive traffic our Path and Seenby vouch for. That must
            //  not rest on an unauthenticated peer, even where the operator has
            //  chosen to import from the open inbound.
            await forward(localInfo({ inboundType: 'inbound' }));
            await assertNothingQueued();
        });

        it('refuses when the sender was never actually authenticated', async () => {
            //  A node with no tic.password configured is never checked at all:
            //  validate() returns success without asking.
            await forward(localInfo({ passwordVerified: false }));
            await assertNothingQueued();
        });

        it('forwards unverified only when explicitly allowed', async () => {
            push({
                ticAreas: {
                    fsx_gen: {
                        network: 'fsxnet',
                        uplinks: [UPLINK],
                        downlinks: [DOWNLINK],
                    },
                },
                nodes: {
                    [UPLINK]: { tic: { allowUnverifiedForward: true } },
                    [DOWNLINK]: { tic: { password: 'DOWNPASS' } },
                },
            });
            await forward(localInfo({ passwordVerified: false }));
            const { tics } = await spoolState();
            assert.equal(tics.length, 1);
        });

        it('refuses a TIC addressed to somebody else', async () => {
            //  In transit through us. HTick refuses such a TIC outright unless
            //  configured to route it; we import but must not re-announce it
            //  under our own name.
            await forward(localInfo(), DEFAULT_TIC.concat(['To 21:9/9']));
            await assertNothingQueued();
        });

        it('forwards a TIC addressed to us', async () => {
            await forward(localInfo(), DEFAULT_TIC.concat([`To ${OUR_ADDR}`]));
            const { tics } = await spoolState();
            assert.equal(tics.length, 1);
        });

        it('refuses a file stored under a different name after a collision', async () => {
            //  BinkP offers a file by its actual basename, so announcing the
            //  name we were given while shipping "file(1).ext" leaves the
            //  downlink an orphan it can never pair up -- HTick resolves a
            //  payload strictly by name.
            await forward(
                localInfo({
                    newPath: storedPayload('NODELIST(1).Z21'),
                    wasRenamedOnCollision: true,
                })
            );
            await assertNothingQueued();
        });

        it('refuses when no network can be resolved for the area', async () => {
            push({
                ticAreas: { fsx_gen: { uplinks: [UPLINK], downlinks: ['99:1/1'] } },
                nodes: { [UPLINK]: { tic: { password: 'UPPASS' } } },
            });
            await forward(localInfo());
            await assertNothingQueued();
        });
    });

    describe('Replaces dequeues what the downlink has not yet received', () => {
        //
        //  FSC-0087: "File Forwarders should always delete and dequeue unsent
        //  TIC files when re-hatching the same or updated version of an
        //  associated file." Without it a downlink that has not polled in a
        //  week receives NODELIST.246 and then NODELIST.253 -- and worse,
        //  cleanupOldFile() unlinks the old payload, so the reference dangles
        //  and the downlink silently receives neither.
        //

        const OLD_NAME = 'NODELIST.Z20';

        //  Queue an old file plus its TIC the way forwarding writes them:
        //  payload with no directive, its TIC with '^', adjacent.
        async function queueOld() {
            const dir = paths.join(outboundDir, 'outbound');
            await fsp.mkdir(dir, { recursive: true });

            const oldPayload = storedPayload(OLD_NAME);
            const oldTic = paths.join(dir, 'aaaaaaaa.tic');
            await fsp.writeFile(oldTic, 'Area FSX_GEN\r\n');

            const flowPath = paths.join(dir, `${FLOW_BASE}.clo`);
            await fsp.writeFile(flowPath, `${oldPayload}\n^${oldTic}\n`);

            return { oldPayload, oldTic, flowPath, dir };
        }

        function replacing(oldPayload) {
            //  as |store| leaves it after findExistingItem matched
            return localInfo({
                existingFileId: 42,
                oldFileName: paths.basename(oldPayload),
                oldStorageTag: 'testStorage',
                oldPath: oldPayload,
            });
        }

        it('removes the superseded payload and its TIC from the flow file', async () => {
            const { oldPayload, oldTic, flowPath } = await queueOld();

            await forward(replacing(oldPayload));

            const flow = await fsp.readFile(flowPath, 'utf8');
            assert.ok(!flow.includes(oldPayload), 'old payload dequeued');
            assert.ok(!flow.includes(oldTic), 'its TIC dequeued too');
            assert.ok(!fs.existsSync(oldTic), 'and the orphan TIC removed');
        });

        it('queues the replacement in its place', async () => {
            const { oldPayload, flowPath } = await queueOld();
            const info = replacing(oldPayload);

            await forward(info);

            const flow = await fsp.readFile(flowPath, 'utf8');
            assert.ok(flow.includes(info.newPath), 'the new file is queued');
        });

        it('leaves a reference that has already been sent alone', async () => {
            //  '~' means delivered. Rewriting history helps nobody.
            const { oldPayload, flowPath } = await queueOld();
            await fsp.writeFile(flowPath, `~${oldPayload}\n`);

            await forward(replacing(oldPayload));

            const flow = await fsp.readFile(flowPath, 'utf8');
            assert.ok(flow.includes(`~${oldPayload}`), 'a sent entry survives');
        });

        it('leaves other queued files alone', async () => {
            const { oldPayload, flowPath, dir } = await queueOld();
            const unrelated = paths.join(dir, 'other.pkt');
            await fsp.appendFile(flowPath, `^${unrelated}\n`);

            await forward(replacing(oldPayload));

            const flow = await fsp.readFile(flowPath, 'utf8');
            assert.ok(flow.includes(unrelated), 'unrelated mail is untouched');
        });

        it('does nothing when the file was replaced in place', async () => {
            //  Same path in and out: the queued reference is still correct.
            const { flowPath } = await queueOld();
            const info = localInfo({ existingFileId: 42 });
            info.oldPath = info.newPath; //  replaced in place

            await forward(info);

            const flow = await fsp.readFile(flowPath, 'utf8');
            assert.ok(flow.includes('aaaaaaaa.tic'), 'nothing dequeued');
        });
    });

    describe('only an authorized sender may publish into an area', () => {
        //
        //  Everything else in the gate authenticates the sender; this is the
        //  only thing that authorizes it for the *echo* it is announcing into.
        //
        //  Without it, any node in nodes{} -- a downlink of an unrelated echo,
        //  an EchoMail-only link -- could announce a file into any area we
        //  carry and have us relay it to that area's subscribers under our own
        //  From, our own Path and a Seenby containing us. A read-only consumer
        //  of one echo would gain publish rights to every echo we carry.
        //
        //  htick runs the equivalent check (e_writeCheck) immediately before
        //  sendToLinks(), refusing with "Link %s not subscribed to File Area %s".
        //

        async function assertNothingQueued() {
            const { flow, tics } = await spoolState();
            assert.equal(flow, null, 'no flow file');
            assert.equal(tics.length, 0, 'no TIC');
        }

        it('refuses a sender that is not an uplink of the area', async () => {
            //  21:1/250 is a perfectly good configured node with its own TIC
            //  password -- it simply has no rights to this echo.
            push({
                nodes: {
                    [UPLINK]: { tic: { password: 'UPPASS' } },
                    [DOWNLINK]: { tic: { password: 'DOWNPASS' } },
                    '21:1/250': { tic: { password: 'INTRUDER' } },
                },
            });

            await forward(localInfo({ node: '21:1/250' }), [
                'Area FSX_GEN',
                'File NODELIST.Z21',
                'Origin 21:1/250',
                'From 21:1/250',
                'Crc DEADBEEF',
                'Pw INTRUDER',
                'Seenby 21:1/250',
            ]);

            await assertNothingQueued();
        });

        it('forwards for a sender that is an uplink', async () => {
            await forward(localInfo());
            const { tics } = await spoolState();
            assert.equal(tics.length, 1);
        });

        it('fails closed when the area names no uplinks at all', async () => {
            //  Silently relaying for an unspecified sender set is the outcome
            //  this exists to prevent, so "not configured" must mean "forward
            //  nothing" rather than "forward anything".
            push({
                ticAreas: {
                    fsx_gen: { network: 'fsxnet', downlinks: [DOWNLINK] },
                },
            });
            await forward(localInfo());
            await assertNothingQueued();
        });

        it('matches an uplink written in another dimension', async () => {
            //  FSC-0087 lets each hop rewrite address dimensions, so the From
            //  we receive need not be shaped like the config entry. A strict
            //  compare here would lock out a legitimate uplink.
            push({
                ticAreas: {
                    fsx_gen: {
                        network: 'fsxnet',
                        uplinks: ['21:1/100@fsxnet'],
                        downlinks: [DOWNLINK],
                    },
                },
            });
            await forward(localInfo());
            const { tics } = await spoolState();
            assert.equal(tics.length, 1, 'a 5D uplink must match a 3D From');
        });

        it('honours a wildcard uplink, for consistency with nodes{}', async () => {
            push({
                ticAreas: {
                    fsx_gen: {
                        network: 'fsxnet',
                        uplinks: ['21:1/*'],
                        downlinks: [DOWNLINK],
                    },
                },
            });
            await forward(localInfo());
            const { tics } = await spoolState();
            assert.equal(tics.length, 1);
        });

        it('accepts uplinks written as a space separated string', async () => {
            //  EchoMail uplinks may be written that way; be consistent.
            push({
                ticAreas: {
                    fsx_gen: {
                        network: 'fsxnet',
                        uplinks: `${UPLINK} 21:1/101`,
                        downlinks: [DOWNLINK],
                    },
                },
            });
            await forward(localInfo());
            const { tics } = await spoolState();
            assert.equal(tics.length, 1);
        });
    });

    describe('failure of one downlink does not cost the others', () => {
        it('keeps going after a downlink that cannot be queued', async () => {
            push({
                ticAreas: {
                    fsx_gen: {
                        network: 'fsxnet',
                        uplinks: [UPLINK],
                        downlinks: ['21:1/300', DOWNLINK],
                    },
                },
                nodes: {
                    [UPLINK]: { tic: { password: 'UPPASS' } },
                    [DOWNLINK]: { tic: { password: 'DOWNPASS' } },
                    '21:1/300': { tic: { password: 'THIRDPASS' } },
                },
            });

            //  Hold 21:1/300's flow lock so its append is refused; 21:1/200
            //  shares the directory but not the lock.
            const dir = paths.join(outboundDir, 'outbound');
            await fsp.mkdir(dir, { recursive: true });
            //  21:1/300 -> net 1 (0001), node 300 (012c)
            await fsp.writeFile(paths.join(dir, '0001012c.bsy'), '4242');

            const cfg = configModule.get();
            cfg.scannerTossers.ftn_bso.flowLockTimeoutMs = 150;

            await forward(localInfo());

            const { entries } = await spoolState();
            const flow200 = entries.find(e => e.toLowerCase().startsWith(FLOW_BASE));
            assert.ok(flow200, '21:1/200 must still have been queued');
        });

        it('does not leave a TIC behind when its queueing failed', async () => {
            push({
                ticAreas: {
                    fsx_gen: {
                        network: 'fsxnet',
                        uplinks: [UPLINK],
                        downlinks: [DOWNLINK],
                    },
                },
                nodes: {
                    [UPLINK]: { tic: { password: 'UPPASS' } },
                    [DOWNLINK]: { tic: { password: 'DOWNPASS' } },
                },
            });

            const dir = paths.join(outboundDir, 'outbound');
            await fsp.mkdir(dir, { recursive: true });
            await fsp.writeFile(paths.join(dir, `${FLOW_BASE}.bsy`), '4242');

            const cfg = configModule.get();
            cfg.scannerTossers.ftn_bso.flowLockTimeoutMs = 150;

            await forward(localInfo());

            const { tics } = await spoolState();
            assert.equal(
                tics.length,
                0,
                'an unreferenced TIC would sit in the outbound forever'
            );
        });
    });
});
