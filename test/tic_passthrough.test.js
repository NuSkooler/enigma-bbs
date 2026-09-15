'use strict';

//
//  Passthrough (transit) file areas (#753).
//
//  A hub carrying forty echoes for its downlinks should not need forty local
//  file areas. store() hard-failed without one, so it did.
//
//  The whole import waterfall is driven here, not a stub of it. That is
//  possible precisely because passthrough touches no database: there is no
//  FileEntry, no area storage and no scan, so what is left is configuration and
//  the filesystem. The file-base path cannot be tested this way, which is why
//  ftn_tic_import.test.js stubs the half below validation.
//

const { strict: assert } = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const paths = require('path');

const configModule = require('../core/config.js');
const CRC32 = require('../core/crc.js').CRC32;
const ticPassthrough = require('../core/tic_passthrough.js');

const OUR_ADDR = '21:1/151';
const UPLINK = '21:1/100';
const DOWNLINK = '21:1/200';
const AREA = 'FSX_GEN';

//  21:1/200 -> net 1 (0001), node 200 (00c8)
const FLOW_BASE = '000100c8';

describe('tic_passthrough — recognising a transit echo', () => {
    it('takes an explicit passthrough flag', () => {
        assert.equal(ticPassthrough.isPassthroughArea({ passthrough: true }), true);
    });

    it('does NOT infer it from an absent areaTag', () => {
        //
        //  It looks like it should mean the same thing, and inferring it was
        //  the original design. But this entry works today -- the key is
        //  matched against fileBase.areas as well as ticAreas, so the echo is
        //  stored there and its files stay:
        //
        //      fileBase: { areas:   { fsx_gen: {...} } }
        //      ticAreas: { fsx_gen: { uplinks: [...], downlinks: [...] } }
        //
        //  Inferring passthrough would silently reinterpret that, on upgrade,
        //  as "forward these and then delete them". A typo in areaTag would do
        //  the same. When guessing wrong destroys files, the flag is explicit.
        //
        assert.equal(ticPassthrough.isPassthroughArea({ downlinks: [DOWNLINK] }), false);
        assert.equal(ticPassthrough.isPassthroughArea({ areaTag: '' }), false);
        assert.equal(
            ticPassthrough.isPassthroughArea({ areaTgas: 'fsx_gen' }),
            false,
            'a misspelled areaTag must not become passthrough either'
        );
    });

    it('does not treat a stored area as passthrough', () => {
        assert.equal(ticPassthrough.isPassthroughArea({ areaTag: 'fsx_gen' }), false);
    });

    it('does not treat the bare string shorthand as passthrough', () => {
        //  A ticAreas value of "fsx_gen" is shorthand for { areaTag: "fsx_gen" }.
        assert.equal(ticPassthrough.isPassthroughArea('fsx_gen'), false);
        assert.equal(ticPassthrough.isPassthroughArea(undefined), false);
    });

    it('lets an explicit flag win over a present areaTag', () => {
        //  An operator moving an echo to passthrough should not have to delete
        //  the areaTag to be believed.
        assert.equal(
            ticPassthrough.isPassthroughArea({ passthrough: true, areaTag: 'x' }),
            true
        );
    });

    it('takes only a literal true, not anything truthy', () => {
        //  hjson will hand us a string for an unquoted value, and "false"
        //  is truthy. Turning a file echo into a deleting one on the strength
        //  of that is not a trade worth making.
        for (const v of ['true', 'false', 1, 'yes', {}]) {
            assert.equal(
                ticPassthrough.isPassthroughArea({ passthrough: v }),
                false,
                JSON.stringify(v)
            );
        }
    });
});

describe('tic_passthrough — the Replaces glob', () => {
    const matches = (glob, name) => ticPassthrough.globMatches(glob, name);

    it("matches '*' and '?' the way a DOS pattern does", () => {
        assert.ok(matches('NODELIST.*', 'nodelist.246'));
        assert.ok(matches('NODELIST.2?6', 'NODELIST.246'));
        assert.ok(!matches('NODELIST.*', 'readme.txt'));
    });

    it('is anchored, so a pattern cannot match a longer name', () => {
        assert.ok(!matches('APP.ZIP', 'APP.ZIP.BAK'));
        assert.ok(!matches('APP', 'MYAPP'));
    });

    it('is case insensitive, as 8.3 names are', () => {
        assert.ok(matches('nodelist.*', 'NODELIST.246'));
    });

    it('treats every other character literally, never as a regexp', () => {
        //  "Replaces" comes off a peer's TIC. A '.' acting as a wildcard would
        //  make "A.ZIP" match "AXZIP"; a '(' would throw.
        assert.ok(!matches('A.ZIP', 'AXZIP'));
        assert.ok(matches('A.ZIP', 'A.ZIP'));
        assert.doesNotThrow(() => matches('bad(pattern[', 'anything'));
        assert.ok(matches('bad(pattern[', 'bad(pattern['));
        assert.ok(matches('cost$100.zip', 'cost$100.zip'));
    });

    it('handles the degenerate patterns without special-casing them', () => {
        assert.ok(matches('*', 'anything'));
        assert.ok(matches('**', 'x'));
        assert.ok(matches('*X', 'X'), 'a leading star may match nothing');
        assert.ok(matches('X*', 'X'), 'and so may a trailing one');
        assert.ok(matches('', ''));
        assert.ok(!matches('', 'x'));
        assert.ok(!matches('?', ''), "'?' requires a character");
    });

    it('matches a run of wildcards in linear time, not exponential', () => {
        //
        //  The reason this is a scanner and not a RegExp. Mapping '*' to '.*'
        //  backtracks catastrophically: against this same 34-character name,
        //  six stars took 43ms, eight took 1.5s and ten took 36s -- about 5x
        //  per added star. "Replaces" comes off a peer's TIC and is matched
        //  synchronously inside an import pass, so that is a remote peer
        //  wedging the event loop for as long as it likes. Not even the import
        //  watchdog fires, because its setTimeout cannot run either.
        //
        //  A generous budget: the point is the difference between milliseconds
        //  and minutes, not a precise timing assertion on a shared CI box.
        //
        const name = 'FSXNET-2026-01-01-NODELIST-BIG.ZIP';
        const started = Date.now();

        for (const stars of [10, 20, 40, 60]) {
            assert.equal(
                matches('*'.repeat(stars) + 'zz', name),
                false,
                `${stars} stars should simply not match`
            );
        }

        const elapsed = Date.now() - started;
        assert.ok(
            elapsed < 1000,
            `four hostile patterns should take milliseconds, took ${elapsed}ms`
        );
    });
});

describe('tic_passthrough — the transit directory', () => {
    let prevConfig;
    let root;

    beforeEach(() => {
        root = fs.mkdtempSync(paths.join(os.tmpdir(), 'enigma_transit_dir_'));
        prevConfig = configModule._pushTestConfig({
            debug: { assertsEnabled: false },
            scannerTossers: {
                ftn_bso: { paths: { ticTransit: root }, ticAreas: {} },
            },
        });
    });

    afterEach(() => {
        configModule._popTestConfig(prevConfig);
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('gives each echo its own directory, lowercased', () => {
        assert.equal(
            ticPassthrough.transitDirFor('FSX_GEN'),
            paths.join(root, 'fsx_gen')
        );
        assert.equal(
            ticPassthrough.transitDirFor('fsx_gen'),
            ticPassthrough.transitDirFor('FSX_GEN'),
            'one echo must not get two directories on a case sensitive filesystem'
        );
    });

    it('cannot be walked out of by an area tag', () => {
        //  validate() has already matched the tag against a configured
        //  ticAreas key by the time we are called, but this builds a path and
        //  does not take that on trust.
        for (const evil of ['../../etc', '..', '/abs/path', 'a/../../b']) {
            const dir = ticPassthrough.transitDirFor(evil);
            assert.ok(dir.startsWith(root + paths.sep), `${evil} escaped to ${dir}`);
        }
    });
});

describe('TIC passthrough end to end', function () {
    this.timeout(20000);

    let tmpDir;
    let inst;
    let prevConfig;
    let seq = 0;

    const dirs = () => ({
        outbound: paths.join(tmpDir, 'ob'),
        secInbound: paths.join(tmpDir, 'secin'),
        inbound: paths.join(tmpDir, 'in'),
        reject: paths.join(tmpDir, 'reject'),
        ticTransit: paths.join(tmpDir, 'transit'),
    });

    function makeConfig(overrides = {}) {
        const d = dirs();
        return {
            debug: { assertsEnabled: false },
            menus: { cls: false },
            general: { boardName: 'Test BBS' },
            //  No file base areas at all -- the point of the exercise.
            fileBase: { areas: {}, storageTags: {} },
            scannerTossers: {
                ftn_bso: {
                    defaultNetwork: 'fsxnet',
                    paths: d,
                    tic: Object.assign({ secureInOnly: true }, overrides.tic),
                    ticAreas: overrides.ticAreas || {
                        fsx_gen: {
                            passthrough: true,
                            network: 'fsxnet',
                            uplinks: [UPLINK],
                            downlinks: [DOWNLINK],
                        },
                    },
                    nodes: {
                        [UPLINK]: { tic: { password: 'UPPASS' } },
                        [DOWNLINK]: { tic: { password: 'DOWNPASS' } },
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
        inst.moduleConfig = configModule.get().scannerTossers.ftn_bso;
    }

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(paths.join(os.tmpdir(), 'enigma_passthru_'));
        Object.values(dirs()).forEach(d => fs.mkdirSync(d, { recursive: true }));
        push();
    });

    afterEach(() => {
        if (prevConfig !== undefined) {
            configModule._popTestConfig(prevConfig);
            prevConfig = undefined;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    //  A TIC and its payload, as an uplink delivers them into the secure inbound.
    function deliver({
        fileName = 'COOLAPP.ZIP',
        content = 'payload v1',
        replaces,
        sha256 = false,
    } = {}) {
        const d = dirs();
        fs.writeFileSync(paths.join(d.secInbound, fileName), content);

        const crc = new CRC32();
        crc.update(Buffer.from(content));

        const fields = [
            `Area ${AREA}`,
            `File ${fileName}`,
            'Desc a cool app',
            `Origin ${UPLINK}`,
            `From ${UPLINK}`,
            `Crc ${crc.finalize().toString(16).toUpperCase()}`,
            `Size ${Buffer.byteLength(content)}`,
            'Pw UPPASS',
            `Path ${UPLINK} 1756500001 Fri, 29 Aug 2026 12:00:01 GMT`,
            `Seenby ${UPLINK}`,
        ];
        if (replaces) {
            fields.splice(7, 0, `Replaces ${replaces}`);
        }

        //  Mystic and tickit send this; htick does not. When it is present our
        //  reader verifies it and ignores the announced Crc.
        if (sha256) {
            fields.push(
                `Sha256 ${require('crypto')
                    .createHash('sha256')
                    .update(Buffer.from(content))
                    .digest('hex')}`
            );
        }

        const ticPath = paths.join(d.secInbound, `T000000${seq++}.TIC`);
        fs.writeFileSync(ticPath, fields.join('\r\n') + '\r\n');
        return ticPath;
    }

    //  One import pass over the secure inbound, plus the transit sweep.
    function importOnce() {
        return new Promise(resolve => {
            inst.importFromDirectory('secInbound', dirs().secInbound, () =>
                inst.sweepTransitFiles(() => resolve())
            );
        });
    }

    const transitFiles = (area = 'fsx_gen') => {
        try {
            return fs.readdirSync(paths.join(dirs().ticTransit, area)).sort();
        } catch {
            return [];
        }
    };

    async function spoolState() {
        const dir = paths.join(dirs().outbound, 'outbound');
        let entries = [];
        try {
            entries = await fsp.readdir(dir);
        } catch {
            return { flow: null, tics: [], entries: [] };
        }

        const flowName = entries.find(e => e.toLowerCase().startsWith(FLOW_BASE));
        const flow = flowName
            ? await fsp.readFile(paths.join(dir, flowName), 'utf8')
            : null;

        const tics = entries.filter(e => e.toLowerCase().endsWith('.tic'));
        return { flow, tics, entries, dir, flowName };
    }

    it('carries a file with no local file base area at all', async () => {
        //  The blocker: store() called getFileAreaByTag() and hard-failed
        //  Errors.UnexpectedState without one, so a hub had to keep an area
        //  per echo for files its own users would never browse.
        deliver();
        await importOnce();

        assert.deepEqual(transitFiles(), ['COOLAPP.ZIP']);

        const { flow, tics } = await spoolState();
        assert.equal(tics.length, 1, 'one TIC for the downlink');

        const lines = flow.trim().split('\n');
        assert.equal(
            lines[0],
            paths.join(dirs().ticTransit, 'fsx_gen', 'COOLAPP.ZIP'),
            'the payload is queued from transit, not from file base storage'
        );
        assert.ok(lines[1].startsWith('^'), 'and its TIC behind it');
    });

    it('drains the inbound and rejects nothing', async () => {
        deliver();
        await importOnce();

        assert.deepEqual(fs.readdirSync(dirs().secInbound), []);
        assert.deepEqual(fs.readdirSync(dirs().reject), []);
    });

    it('announces it under our name, keeping the hatcher as Origin', async () => {
        deliver();
        await importOnce();

        const { dir, tics } = await spoolState();
        const content = fs.readFileSync(paths.join(dir, tics[0]), 'utf8');
        const value = k =>
            content
                .split('\r\n')
                .filter(l => l.startsWith(`${k} `))
                .map(l => l.slice(k.length + 1));

        assert.deepEqual(value('Origin'), [UPLINK], 'the hatcher, not us');
        assert.deepEqual(value('From'), [OUR_ADDR]);
        assert.deepEqual(value('To'), [DOWNLINK]);
        assert.deepEqual(value('Pw'), ['DOWNPASS']);
        assert.equal(value('Path').length, 2, "the uplink's line, then ours");
        assert.ok(value('Path')[1].startsWith(`${OUR_ADDR} `));
        assert.deepEqual(value('Seenby').sort(), [UPLINK, OUR_ADDR, DOWNLINK].sort());
    });

    describe('the sweep', () => {
        it('keeps a file a downlink has not collected', async () => {
            deliver();
            await importOnce();
            await importOnce(); //  a second pass, nothing collected in between

            assert.deepEqual(
                transitFiles(),
                ['COOLAPP.ZIP'],
                'it is still owed to the downlink'
            );
        });

        it('keeps a file whose reference is marked sent', async () => {
            //  A '~' line is history and the flow file is about to be drained
            //  anyway. Deleting underneath it buys nothing and makes "why is
            //  this gone?" unanswerable.
            deliver();
            await importOnce();

            const { dir, flowName } = await spoolState();
            const flowPath = paths.join(dir, flowName);
            const sent = fs
                .readFileSync(flowPath, 'utf8')
                .split('\n')
                .map(l => (l.trim() ? `~${l.trim().replace(/^\^/, '')}` : l))
                .join('\n');
            fs.writeFileSync(flowPath, sent);

            await importOnce();
            assert.deepEqual(transitFiles(), ['COOLAPP.ZIP']);
        });

        it('removes a file no flow file references any more', async () => {
            //  The downlink has collected everything and the flow file drained,
            //  exactly as it does after a successful session.
            deliver();
            await importOnce();

            const { dir, flowName } = await spoolState();
            fs.unlinkSync(paths.join(dir, flowName));

            await importOnce();
            assert.deepEqual(
                transitFiles(),
                [],
                'nobody owes it, so it is not ours to keep'
            );
        });

        it('sweeps nothing when a flow file cannot be read', async () => {
            //
            //  inspectOutbound() is a report: it skips what it cannot read and
            //  carries on. A node whose flow file we could not read therefore
            //  contributes zero references, which looks exactly like a node
            //  that owes nothing -- and the sweep would delete every file that
            //  node was still owed. An incomplete answer has to be no answer.
            //
            deliver();
            await importOnce();
            assert.deepEqual(transitFiles(), ['COOLAPP.ZIP']);

            const { dir, flowName } = await spoolState();
            const flowPath = paths.join(dir, flowName);
            const saved = fs.readFileSync(flowPath);

            //  Unreadable rather than absent: absent means the node genuinely
            //  owes nothing, which is the case the sweep is *for*.
            fs.chmodSync(flowPath, 0o000);

            try {
                await importOnce();
            } finally {
                fs.chmodSync(flowPath, 0o644);
                fs.writeFileSync(flowPath, saved);
            }

            assert.deepEqual(
                transitFiles(),
                ['COOLAPP.ZIP'],
                'a file we cannot prove is unwanted must be kept'
            );
        });

        it('leaves another echo’s transit files alone', async () => {
            deliver();
            await importOnce();

            const otherDir = paths.join(dirs().ticTransit, 'other_echo');
            fs.mkdirSync(otherDir, { recursive: true });
            fs.writeFileSync(paths.join(otherDir, 'THEIRS.ZIP'), 'x');

            const { dir, flowName } = await spoolState();
            fs.unlinkSync(paths.join(dir, flowName));
            await importOnce();

            //  other_echo is not a configured passthrough area, so the sweep
            //  must not walk it at all.
            assert.deepEqual(fs.readdirSync(otherDir), ['THEIRS.ZIP']);
        });
    });

    it('forwards a Sha256-bearing TIC with a Crc line', async () => {
        //
        //  validate() verifies whichever digest is stronger and used to record
        //  only that one. A stored area never noticed the gap, because the
        //  scanner computes file_crc32 on the way into the file base and the
        //  writer prefers it. A passthrough area skips the scanner, so it
        //  forwarded with no Crc at all -- and Crc is a required field, so
        //  every downlink rejected the TIC outright. Silent non-delivery.
        //
        const payload = 'sha256 payload bytes';
        deliver({ content: payload, sha256: true });
        await importOnce();

        const { dir, tics } = await spoolState();
        assert.equal(tics.length, 1);

        const content = fs.readFileSync(paths.join(dir, tics[0]), 'utf8');
        const crc = content.split('\r\n').find(l => l.startsWith('Crc '));

        assert.ok(crc, `the forwarded TIC must carry a Crc, got:\n${content}`);

        //
        //  The *right* Crc, not merely a line shaped like one. Asserting only
        //  the shape passes when the digest is never fed any data: an unfed
        //  CRC-32 finalises to 00000000, which is eight hex digits and a lie.
        //  Every htick and Mystic downlink verifies this number and rejects the
        //  file with our name on the From line when it disagrees.
        //
        const expected = new CRC32();
        expected.update(Buffer.from(payload));
        assert.equal(
            crc,
            `Crc ${`00000000${expected.finalize().toString(16)}`
                .slice(-8)
                .toUpperCase()}`,
            'the Crc must be computed from the payload we actually forward'
        );
    });

    it('does not stall the import on a hostile Replaces pattern', async () => {
        //
        //  The pattern reaches us from a peer's TIC and is matched
        //  synchronously inside the import pass. With a regex built by mapping
        //  '*' to '.*', ten stars against a name this length took 36 seconds of
        //  blocked event loop -- every user session, the web server and every
        //  timer with it, and not even the import watchdog fires because its
        //  setTimeout cannot run either.
        //
        //  Driven through the real import path rather than the matcher alone,
        //  because the matcher being linear is only useful if it is the thing
        //  actually called.
        //
        push({ tic: { allowReplace: true } });

        deliver({ fileName: 'FSXNET-2026-01-01-NODELIST-BIG.ZIP', content: 'a' });
        await importOnce();
        assert.deepEqual(transitFiles(), ['FSXNET-2026-01-01-NODELIST-BIG.ZIP']);

        deliver({
            fileName: 'OTHER.ZIP',
            content: 'b',
            replaces: '*'.repeat(30) + 'zz',
        });

        const started = Date.now();
        await importOnce();
        const elapsed = Date.now() - started;

        assert.ok(
            elapsed < 5000,
            `a hostile pattern must not stall the pass, took ${elapsed}ms`
        );
    });

    describe('a downlink that is busy must not cost us the file', () => {
        //
        //  The file base is what makes a failed forward survivable for a
        //  stored area: the payload stays put and the downlink simply missed
        //  it. A passthrough area has no such copy, so "queued for nobody" and
        //  "swept" are the same thing -- and a node holding its FTS-5005 .bsy
        //  is the ordinary state of one that is mid-session, which is exactly
        //  when performImport runs (NewInboundBSO triggers it).
        //
        const bsoLock = require('../core/bso_lock');

        //  The canonical per-node lock a BinkP session would hold.
        function lockPathFor(base) {
            return paths.join(dirs().outbound, 'outbound', `${base}.bsy`);
        }

        it('keeps the file and holds the TIC when every downlink is busy', async () => {
            const bsy = lockPathFor(FLOW_BASE);
            await fsp.mkdir(paths.dirname(bsy), { recursive: true });
            assert.equal(
                await bsoLock.acquire(bsy, { staleMaxAgeMs: 600000 }),
                true,
                'the test could not take the lock it means to hold'
            );

            try {
                deliver({ fileName: 'IMPORTANT.ZIP', content: 'irreplaceable' });
                await importOnce();
            } finally {
                await bsoLock.release(bsy);
            }

            //  Nothing queued, so nothing may have been thrown away.
            assert.deepEqual(
                transitFiles(),
                [],
                'the transit copy goes, since nothing references it'
            );
            assert.deepEqual(
                fs.readdirSync(dirs().reject),
                [],
                'and it must not be rejected -- a busy node is a deferral'
            );

            const inbound = fs.readdirSync(dirs().secInbound);
            assert.ok(
                inbound.includes('IMPORTANT.ZIP'),
                `the payload must stay in the inbound, got ${inbound}`
            );
            assert.equal(
                inbound.filter(f => f.toUpperCase().endsWith('.TIC')).length,
                1,
                'and so must the TIC announcing it, for the next pass'
            );
        });

        it('delivers it on the next pass once the lock is released', async () => {
            const bsy = lockPathFor(FLOW_BASE);
            await fsp.mkdir(paths.dirname(bsy), { recursive: true });
            await bsoLock.acquire(bsy, { staleMaxAgeMs: 600000 });

            try {
                deliver({ fileName: 'IMPORTANT.ZIP', content: 'irreplaceable' });
                await importOnce();
            } finally {
                await bsoLock.release(bsy);
            }

            await importOnce();

            assert.deepEqual(transitFiles(), ['IMPORTANT.ZIP']);
            assert.deepEqual(fs.readdirSync(dirs().secInbound), []);

            const { flow, tics } = await spoolState();
            assert.equal(tics.length, 1);
            assert.ok(flow.includes('IMPORTANT.ZIP'));
        });

        it('still sweeps a file that is genuinely owed to nobody', async () => {
            //  The distinction the fix turns on: "we tried every downlink and
            //  got none" is a deferral, but "every downlink already has it" is
            //  success, and that file is correctly swept.
            push({
                ticAreas: {
                    fsx_gen: {
                        passthrough: true,
                        network: 'fsxnet',
                        uplinks: [UPLINK],
                        //  the only downlink is the sender, so it is skipped
                        downlinks: [UPLINK],
                    },
                },
            });

            deliver();
            await importOnce();

            assert.deepEqual(transitFiles(), [], 'owed to nobody, so not kept');
            assert.deepEqual(
                fs.readdirSync(dirs().secInbound),
                [],
                'and not held for a retry that would never differ'
            );
        });
    });

    describe('a re-announced name', () => {
        it('is refused while the first is still queued', async () => {
            //  The file base gave us this for free: a collision was renamed and
            //  forwardTicToDownlinks() then refused to forward it. Transit has
            //  to store under the announced name or the downlink gets an
            //  orphan, so the answer is to refuse instead.
            deliver({ content: 'payload v1' });
            await importOnce();

            const before = await spoolState();

            deliver({ content: 'payload v2' });
            await importOnce();

            assert.equal(
                fs.readFileSync(
                    paths.join(dirs().ticTransit, 'fsx_gen', 'COOLAPP.ZIP'),
                    'utf8'
                ),
                'payload v1',
                'the bytes under a queued reference must not change'
            );

            const after = await spoolState();
            assert.equal(after.flow, before.flow, 'and nothing new may be queued');
            assert.ok(
                fs.readdirSync(dirs().reject).length > 0,
                'the duplicate is archived rather than silently dropped'
            );
        });

        it('replaces one nobody is waiting for', async () => {
            deliver({ content: 'payload v1' });
            await importOnce();

            //  Collected and drained.
            const { dir, flowName } = await spoolState();
            fs.unlinkSync(paths.join(dir, flowName));
            //  ...but the sweep has not run, so the file is still sitting there.

            deliver({ content: 'payload v2' });
            await importOnce();

            assert.equal(
                fs.readFileSync(
                    paths.join(dirs().ticTransit, 'fsx_gen', 'COOLAPP.ZIP'),
                    'utf8'
                ),
                'payload v2',
                'a leftover is safe to replace'
            );
        });
    });

    describe('Replaces', () => {
        it('dequeues the superseded transit file and its TIC', async () => {
            push({ tic: { allowReplace: true } });

            deliver({ fileName: 'COOLAPP.ZIP', content: 'v1' });
            await importOnce();

            const first = await spoolState();
            const firstTic = paths.join(first.dir, first.tics[0]);

            deliver({
                fileName: 'COOLAPP2.ZIP',
                content: 'v2',
                replaces: 'COOLAPP.*',
            });
            await importOnce();

            assert.deepEqual(
                transitFiles(),
                ['COOLAPP2.ZIP'],
                'the superseded payload must go'
            );
            assert.equal(
                fs.existsSync(firstTic),
                false,
                'and the TIC announcing it, or the downlink gets an orphan'
            );

            const after = await spoolState();
            assert.equal(after.tics.length, 1);
            const lines = after.flow.trim().split('\n');
            assert.equal(lines.length, 2, 'exactly the new pair is queued');
            assert.ok(lines[0].endsWith('COOLAPP2.ZIP'));
        });

        it('supersedes a file under the same name, which is the weekly case', async () => {
            //
            //  The single most routine thing in a file echo: a nodelist or
            //  infopack re-hatched every week under the name it always has.
            //  It lands on the same name as the copy already in transit, so a
            //  plain duplicate check refuses it -- and then the downlink
            //  receives week 1 forever, with every later week rejected, for as
            //  long as it stays offline. The stored path overwrites in place;
            //  so does this.
            //
            push({ tic: { allowReplace: true } });

            deliver({ fileName: 'FSXNET.ZIP', content: 'week 1' });
            await importOnce();
            assert.deepEqual(transitFiles(), ['FSXNET.ZIP']);

            const first = await spoolState();
            assert.equal(first.tics.length, 1, 'week 1 is queued and uncollected');

            deliver({
                fileName: 'FSXNET.ZIP',
                content: 'week 2',
                replaces: 'FSXNET.ZIP',
            });
            await importOnce();

            assert.deepEqual(
                fs.readdirSync(dirs().reject),
                [],
                'a supersede is not a duplicate and must not be rejected'
            );
            assert.equal(
                fs.readFileSync(
                    paths.join(dirs().ticTransit, 'fsx_gen', 'FSXNET.ZIP'),
                    'utf8'
                ),
                'week 2',
                'the downlink must end up owed the new file, not the old one'
            );

            //  And the stale announcement must not still be queued alongside it.
            const after = await spoolState();
            assert.equal(
                after.tics.length,
                1,
                `exactly one TIC should be queued, got ${after.tics.length}`
            );
        });

        it('refuses a pattern matching more than one transit file', async () => {
            push({ tic: { allowReplace: true } });

            //  Two differently named files carried at once -- ordinary for a
            //  busy echo, and both still queued for the downlink.
            deliver({ fileName: 'APP1.ZIP', content: 'a' });
            await importOnce();
            deliver({ fileName: 'APP2.ZIP', content: 'b' });
            await importOnce();

            assert.deepEqual(transitFiles(), ['APP1.ZIP', 'APP2.ZIP']);

            //  "APP*" now spans both. Guessing would dequeue a real file from
            //  every downlink, so it is refused.
            fs.rmSync(dirs().reject, { recursive: true, force: true });
            fs.mkdirSync(dirs().reject, { recursive: true });

            deliver({ fileName: 'APP3.ZIP', content: 'c', replaces: 'APP*' });
            await importOnce();

            assert.ok(
                fs.readdirSync(dirs().reject).length > 0,
                'an ambiguous Replaces is refused, not guessed at'
            );
            assert.ok(
                transitFiles().includes('APP1.ZIP') &&
                    transitFiles().includes('APP2.ZIP'),
                'and neither candidate is touched'
            );
        });
    });

    it('still refuses a sender that is not an uplink of the echo', async () => {
        //  Nothing is stored, so forwarding under our name is the *only* thing
        //  a transit file is ever used for. The publish check is what stops an
        //  unrelated node laundering a file through us.
        push({
            ticAreas: {
                fsx_gen: {
                    passthrough: true,
                    network: 'fsxnet',
                    uplinks: ['21:1/999'],
                    downlinks: [DOWNLINK],
                },
            },
        });

        deliver();
        await importOnce();

        const { entries } = await spoolState();
        assert.deepEqual(entries, [], 'nothing may be queued for the downlink');
    });
});
