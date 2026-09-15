'use strict';

//
//  A file echo carried on more than one network (#757).
//
//  A ticAreas entry named a single network, whose localAddress signed the
//  outgoing From, Path and Seenby for every downlink. Worse, when no network
//  was named the area took one from the *first* downlink's zone and used it for
//  all of them -- so an echo fed to a Fidonet link and an fsxNet link announced
//  both under whichever address happened to come first, and the link in the
//  other network received a TIC from an address it does not know us by.
//
//  What lands in the spool is what matters here, so this drives
//  forwardTicToDownlinks() and reads the outbound, as ftn_tic_forward.test.js
//  does.
//

const { strict: assert } = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const paths = require('path');

const configModule = require('../core/config.js');
const TicFileInfo = require('../core/tic_file_info.js');

describe('TIC forwarding across two networks', function () {
    this.timeout(20000);

    let tmpDir;
    let outboundDir;
    let inst;
    let prevConfig;
    let seq = 0;

    const FIDO_US = '1:103/705';
    const FSX_US = '21:1/121';

    const UPLINK = '21:1/100';
    const FSX_DOWN = '21:1/200';
    const FIDO_DOWN = '1:103/999';

    const AREA = 'MULTI_GEN';

    function makeConfig(overrides = {}) {
        return {
            debug: { assertsEnabled: false },
            general: { boardName: 'Test BBS' },
            fileBase: { areas: {}, storageTags: {} },
            scannerTossers: {
                ftn_bso: {
                    defaultNetwork: overrides.defaultNetwork,
                    paths: { outbound: outboundDir },
                    tic: {},
                    ticAreas: overrides.ticAreas || {
                        multi_gen: {
                            areaTag: 'multiGeneral',
                            uplinks: [UPLINK],
                            downlinks: [FSX_DOWN, FIDO_DOWN],
                        },
                    },
                    nodes: overrides.nodes || {
                        [UPLINK]: { tic: { password: 'UPPASS' } },
                        [FSX_DOWN]: { tic: { password: 'FSXPASS' } },
                        [FIDO_DOWN]: { tic: { password: 'FIDOPASS' } },
                    },
                },
            },
            messageNetworks: {
                ftn: {
                    networks: overrides.networks || {
                        fidonet: { localAddress: FIDO_US, defaultZone: 1 },
                        fsxnet: { localAddress: FSX_US, defaultZone: 21 },
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
        tmpDir = await fsp.mkdtemp(paths.join(os.tmpdir(), 'enigma_ticmulti_'));
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

    const TIC = [
        `Area ${AREA}`,
        'File COOLAPP.ZIP',
        'Desc a cool app',
        `Origin ${UPLINK}`,
        `From ${UPLINK}`,
        'Crc DEADBEEF',
        'Pw UPPASS',
        `Path ${UPLINK} 1756500001 Fri, 29 Aug 2026 12:00:01 GMT`,
        `Seenby ${UPLINK}`,
    ];

    function parseTic(lines = TIC) {
        const p = paths.join(tmpDir, `IN${seq++}.TIC`);
        fs.writeFileSync(p, lines.join('\r\n') + '\r\n');
        return new Promise((resolve, reject) =>
            TicFileInfo.createFromFile(p, (e, i) => (e ? reject(e) : resolve(i)))
        );
    }

    function storedPayload(name = 'COOLAPP.ZIP') {
        const dir = paths.join(tmpDir, 'filebase');
        fs.mkdirSync(dir, { recursive: true });
        const p = paths.join(dir, name);
        fs.writeFileSync(p, 'payload bytes');
        return p;
    }

    function forward(overrides = {}, ticLines) {
        const localInfo = Object.assign(
            {
                node: UPLINK,
                inboundType: 'secInbound',
                passwordVerified: true,
                externalAreaTag: AREA,
                areaTag: 'multiGeneral',
                newPath: storedPayload(),
                wasRenamedOnCollision: false,
                fileEntry: { meta: { file_crc32: 'deadbeef' } },
            },
            overrides
        );

        return parseTic(ticLines).then(
            tic =>
                new Promise(resolve =>
                    inst.forwardTicToDownlinks(tic, localInfo, () => resolve(localInfo))
                )
        );
    }

    //  Every generated TIC in the outbound tree, keyed by its "To" address.
    async function ticsByRecipient() {
        const found = {};

        const walk = async dir => {
            let entries = [];
            try {
                entries = await fsp.readdir(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const e of entries) {
                const full = paths.join(dir, e.name);
                if (e.isDirectory()) {
                    await walk(full);
                } else if (e.name.toLowerCase().endsWith('.tic')) {
                    const content = await fsp.readFile(full, 'utf8');
                    const to = content
                        .split('\r\n')
                        .find(l => l.startsWith('To '))
                        .slice(3);
                    found[to] = { content, path: full, dir };
                }
            }
        };

        await walk(outboundDir);
        return found;
    }

    const values = (content, keyword) =>
        content
            .split('\r\n')
            .filter(l => l.startsWith(`${keyword} `))
            .map(l => l.slice(keyword.length + 1));

    const value = (content, keyword) => values(content, keyword)[0];

    describe('one AKA per downlink', () => {
        it('addresses each downlink from the AKA in its own network', async () => {
            //  The defect: both previously came from whichever network the
            //  first downlink's zone resolved to.
            await forward();
            const tics = await ticsByRecipient();

            assert.deepEqual(Object.keys(tics).sort(), [FIDO_DOWN, FSX_DOWN].sort());
            assert.equal(value(tics[FSX_DOWN].content, 'From'), FSX_US);
            assert.equal(value(tics[FIDO_DOWN].content, 'From'), FIDO_US);
        });

        it('writes each downlink a Path line in its own network', async () => {
            await forward();
            const tics = await ticsByRecipient();

            const fsxPath = values(tics[FSX_DOWN].content, 'Path');
            const fidoPath = values(tics[FIDO_DOWN].content, 'Path');

            assert.equal(fsxPath.length, 2, "the uplink's line, then ours");
            assert.ok(fsxPath[1].startsWith(`${FSX_US} `));
            assert.ok(fidoPath[1].startsWith(`${FIDO_US} `));
        });

        it('files each downlink under its own network’s outbound', async () => {
            //  The From line and the directory the file is queued in have to
            //  agree, or the mailer dials the right node from the wrong
            //  identity.
            //
            //  fidonet is first listed and no defaultNetwork is set, so it owns
            //  the bare "outbound" directory (FTS-5005 / bso_util); fsxnet gets
            //  its own. Two directories is the point -- one would mean one AKA.
            await forward();
            const tics = await ticsByRecipient();

            assert.equal(paths.basename(tics[FSX_DOWN].dir), 'fsxnet');
            assert.equal(paths.basename(tics[FIDO_DOWN].dir), 'outbound');
            assert.notEqual(tics[FSX_DOWN].dir, tics[FIDO_DOWN].dir);
        });

        it('follows defaultNetwork when it names the other one', async () => {
            push({ defaultNetwork: 'fsxnet' });
            await forward();
            const tics = await ticsByRecipient();

            assert.equal(paths.basename(tics[FSX_DOWN].dir), 'outbound');
            assert.equal(paths.basename(tics[FIDO_DOWN].dir), 'fidonet');
        });

        it('gives each its own password', async () => {
            await forward();
            const tics = await ticsByRecipient();
            assert.equal(value(tics[FSX_DOWN].content, 'Pw'), 'FSXPASS');
            assert.equal(value(tics[FIDO_DOWN].content, 'Pw'), 'FIDOPASS');
        });
    });

    describe('the loop guard', () => {
        it('names every AKA in play in the Seenby, not only one', async () => {
            //  Seenby is matched by a peer against the address *it* knows us
            //  by -- tickit does it with literal string equality. A peer that
            //  knows us by our Fidonet address would not find an fsxNet-only
            //  Seenby and would forward the file straight back.
            await forward();
            const tics = await ticsByRecipient();

            for (const to of [FSX_DOWN, FIDO_DOWN]) {
                const seenby = values(tics[to].content, 'Seenby');
                assert.ok(seenby.includes(FSX_US), `${to} is missing our fsxNet AKA`);
                assert.ok(seenby.includes(FIDO_US), `${to} is missing our Fidonet AKA`);
            }
        });

        it('gives every downlink the same complete Seenby', async () => {
            await forward();
            const tics = await ticsByRecipient();

            assert.deepEqual(
                values(tics[FSX_DOWN].content, 'Seenby').sort(),
                values(tics[FIDO_DOWN].content, 'Seenby').sort(),
                'a shared list is what lets a peer two hops out see who has it'
            );
        });

        it('does not name an AKA belonging to a network this echo never touches', async () => {
            //  True, but noise: an address on a network the echo is not carried
            //  on has nothing to do with this file, and it would propagate into
            //  every downstream TIC.
            push({
                networks: {
                    fidonet: { localAddress: FIDO_US, defaultZone: 1 },
                    fsxnet: { localAddress: FSX_US, defaultZone: 21 },
                    spooknet: { localAddress: '700:100/28', defaultZone: 700 },
                },
            });

            await forward();
            const tics = await ticsByRecipient();
            assert.ok(!values(tics[FSX_DOWN].content, 'Seenby').includes('700:100/28'));
        });

        it('still treats all our addresses as us when selecting downlinks', async () => {
            //  A downlink list naming one of our own AKAs is a config error,
            //  not a peer, whichever network it belongs to.
            push({
                ticAreas: {
                    multi_gen: {
                        areaTag: 'multiGeneral',
                        uplinks: [UPLINK],
                        downlinks: [FIDO_US, FSX_DOWN],
                    },
                },
            });

            await forward();
            const tics = await ticsByRecipient();
            assert.deepEqual(Object.keys(tics), [FSX_DOWN]);
        });
    });

    describe('overrides', () => {
        it('lets a node name the AKA to address it from', async () => {
            //  htick's per-link |ourAka|. The link knows us by our Fidonet
            //  address even though its own is in zone 21.
            push({
                nodes: {
                    [UPLINK]: { tic: { password: 'UPPASS' } },
                    [FSX_DOWN]: { tic: { password: 'FSXPASS', network: 'fidonet' } },
                    [FIDO_DOWN]: { tic: { password: 'FIDOPASS' } },
                },
            });

            await forward();
            const tics = await ticsByRecipient();
            assert.equal(value(tics[FSX_DOWN].content, 'From'), FIDO_US);
            assert.equal(value(tics[FIDO_DOWN].content, 'From'), FIDO_US);
        });

        it('honours a node-level network as well as a tic-scoped one', async () => {
            push({
                nodes: {
                    [UPLINK]: { tic: { password: 'UPPASS' } },
                    [FSX_DOWN]: { network: 'fidonet', tic: { password: 'FSXPASS' } },
                    [FIDO_DOWN]: { tic: { password: 'FIDOPASS' } },
                },
            });

            await forward();
            const tics = await ticsByRecipient();
            assert.equal(value(tics[FSX_DOWN].content, 'From'), FIDO_US);
        });

        it('keeps an area-level network meaning exactly what it did', async () => {
            //  The knob #743 shipped. A configuration that pinned an area must
            //  not start being second-guessed by distance matching.
            push({
                ticAreas: {
                    multi_gen: {
                        areaTag: 'multiGeneral',
                        network: 'fidonet',
                        uplinks: [UPLINK],
                        downlinks: [FSX_DOWN, FIDO_DOWN],
                    },
                },
            });

            await forward();
            const tics = await ticsByRecipient();
            assert.equal(value(tics[FSX_DOWN].content, 'From'), FIDO_US);
            assert.equal(value(tics[FIDO_DOWN].content, 'From'), FIDO_US);
        });

        it('lets a node override the area, being more specific', async () => {
            push({
                ticAreas: {
                    multi_gen: {
                        areaTag: 'multiGeneral',
                        network: 'fidonet',
                        uplinks: [UPLINK],
                        downlinks: [FSX_DOWN, FIDO_DOWN],
                    },
                },
                nodes: {
                    [UPLINK]: { tic: { password: 'UPPASS' } },
                    [FSX_DOWN]: { tic: { password: 'FSXPASS', network: 'fsxnet' } },
                    [FIDO_DOWN]: { tic: { password: 'FIDOPASS' } },
                },
            });

            await forward();
            const tics = await ticsByRecipient();
            assert.equal(value(tics[FSX_DOWN].content, 'From'), FSX_US);
            assert.equal(value(tics[FIDO_DOWN].content, 'From'), FIDO_US);
        });

        it('falls back to the closest AKA when a named network is not configured', async () => {
            push({
                nodes: {
                    [UPLINK]: { tic: { password: 'UPPASS' } },
                    [FSX_DOWN]: { tic: { password: 'FSXPASS', network: 'nosuchnet' } },
                    [FIDO_DOWN]: { tic: { password: 'FIDOPASS' } },
                },
            });

            await forward();
            const tics = await ticsByRecipient();
            assert.equal(
                value(tics[FSX_DOWN].content, 'From'),
                FSX_US,
                'a typo must not cost the downlink its file'
            );
        });
    });

    describe('a single network system is unaffected', () => {
        it('behaves exactly as before', async () => {
            push({
                networks: { fsxnet: { localAddress: FSX_US, defaultZone: 21 } },
                ticAreas: {
                    multi_gen: {
                        areaTag: 'multiGeneral',
                        uplinks: [UPLINK],
                        downlinks: [FSX_DOWN],
                    },
                },
            });

            await forward();
            const tics = await ticsByRecipient();

            assert.deepEqual(Object.keys(tics), [FSX_DOWN]);
            assert.equal(value(tics[FSX_DOWN].content, 'From'), FSX_US);
            assert.deepEqual(
                values(tics[FSX_DOWN].content, 'Seenby').sort(),
                [UPLINK, FSX_US, FSX_DOWN].sort(),
                'one AKA, so nothing new appears'
            );
        });
    });

    describe('the Replaces dequeue follows the AKA', () => {
        it('scrubs each downlink from the outbound it was actually queued in', async () => {
            //  A superseded file lives in whichever network directory it was
            //  filed under. Scrubbing the area's directory for every downlink
            //  would leave it queued for the ones filed elsewhere.
            const first = await forward();

            const before = await ticsByRecipient();
            assert.equal(Object.keys(before).length, 2);

            await forward({
                newPath: storedPayload('COOLAPP2.ZIP'),
                existingFileId: 1,
                oldPath: first.newPath,
            });

            //  Every flow file in the tree, whichever network directory it is in.
            const flowLines = [];
            const walk = async dir => {
                for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
                    const full = paths.join(dir, e.name);
                    if (e.isDirectory()) {
                        await walk(full);
                    } else if (/\.(flo|clo|dlo|hlo|ilo)$/i.test(e.name)) {
                        flowLines.push(...(await fsp.readFile(full, 'utf8')).split('\n'));
                    }
                }
            };
            await walk(outboundDir);

            assert.ok(
                !flowLines.some(l => l.trim().endsWith(first.newPath)),
                'the superseded payload must be gone from every network directory'
            );
            for (const to of [FSX_DOWN, FIDO_DOWN]) {
                assert.ok(
                    !fs.existsSync(before[to].path),
                    `${to}'s superseded TIC must be unlinked`
                );
            }
        });
    });
});
