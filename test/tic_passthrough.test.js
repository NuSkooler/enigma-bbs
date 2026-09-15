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

    it('takes an absent areaTag to mean the same thing', () => {
        //  There is no local area to store into, which is what passthrough is.
        assert.equal(ticPassthrough.isPassthroughArea({ downlinks: [DOWNLINK] }), true);
        assert.equal(ticPassthrough.isPassthroughArea({ areaTag: '' }), true);
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
});

describe('tic_passthrough — the Replaces glob', () => {
    const matches = (glob, name) => ticPassthrough.globToRegExp(glob).test(name);

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
        assert.ok(matches('cost$100.zip', 'cost$100.zip'));
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
