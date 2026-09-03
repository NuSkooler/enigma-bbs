'use strict';

//
//  Coverage for TIC forwarding decisions (#743).
//
//  This is the part that must not be wrong. Getting it wrong in one direction
//  loops a file around the network forever; in the other, a downlink silently
//  never receives an echo. Neither shows up against a single well-behaved test
//  peer, so the cases below are deliberately the awkward ones.
//

const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const paths = require('path');

const TicFileInfo = require('../core/tic_file_info.js');
const ticForward = require('../core/tic_forward.js');

const { SkipReasons } = ticForward;

describe('TIC forwarding decisions', () => {
    let tmpDir;
    let seq = 0;

    before(() => {
        tmpDir = fs.mkdtempSync(paths.join(os.tmpdir(), 'enigma_ticfwd_'));
    });

    after(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function parse(lines) {
        const p = paths.join(tmpDir, `T${seq++}.TIC`);
        fs.writeFileSync(p, lines.join('\r\n'));
        return new Promise((resolve, reject) => {
            TicFileInfo.createFromFile(p, (err, i) => (err ? reject(err) : resolve(i)));
        });
    }

    const OURS = ['21:1/151'];
    const ZONE = 21;

    function select(info, downlinks, ourAddresses = OURS) {
        return ticForward.selectDownlinks({
            ticFileInfo: info,
            downlinks,
            ourAddresses,
            defaultZone: ZONE,
        });
    }

    const names = list => list.map(a => a.toString('4D'));
    const reasonFor = (skipped, addr) =>
        skipped.find(s => s.address.toString && s.address.toString('4D') === addr)
            ?.reason;

    describe('selectDownlinks', () => {
        it('forwards to a downlink that has not seen the file', async () => {
            const info = await parse([
                'Area FSX_GEN',
                'From 21:1/100',
                'Origin 21:1/100',
                'Seenby 21:1/100',
                'Seenby 21:1/151',
            ]);
            const { candidates } = select(info, ['21:1/200']);
            assert.deepEqual(names(candidates), ['21:1/200']);
        });

        it('skips a downlink already in the inbound Seenby', async () => {
            //  The loop guard. Without it the file goes round forever.
            const info = await parse([
                'From 21:1/100',
                'Seenby 21:1/100',
                'Seenby 21:1/200',
            ]);
            const { candidates, skipped } = select(info, ['21:1/200', '21:1/300']);
            assert.deepEqual(names(candidates), ['21:1/300']);
            assert.equal(reasonFor(skipped, '21:1/200'), SkipReasons.AlreadySeen);
        });

        it('skips the node that sent us the TIC', async () => {
            const info = await parse(['From 21:1/100', 'Seenby 21:1/151']);
            const { candidates, skipped } = select(info, ['21:1/100', '21:1/200']);
            assert.deepEqual(names(candidates), ['21:1/200']);
            assert.equal(reasonFor(skipped, '21:1/100'), SkipReasons.IsSender);
        });

        it("skips the TIC's To and the file's Origin", async () => {
            const info = await parse(['From 21:1/100', 'To 21:1/400', 'Origin 21:1/500']);
            const { candidates, skipped } = select(info, [
                '21:1/400',
                '21:1/500',
                '21:1/200',
            ]);
            assert.deepEqual(names(candidates), ['21:1/200']);
            assert.equal(reasonFor(skipped, '21:1/400'), SkipReasons.IsRecipient);
            assert.equal(reasonFor(skipped, '21:1/500'), SkipReasons.IsOrigin);
        });

        it('never forwards to one of our own addresses', async () => {
            const info = await parse(['From 21:1/100']);
            const { candidates, skipped } = select(
                info,
                ['21:1/151', '21:1/200'],
                ['21:1/151', '10:101/50']
            );
            assert.deepEqual(names(candidates), ['21:1/200']);
            assert.equal(reasonFor(skipped, '21:1/151'), SkipReasons.IsUs);
        });

        it('recognises our address on any network, not just this one', async () => {
            //  A multi-network system must not forward to itself because the
            //  AKA happens to belong to a different network.
            const info = await parse(['From 21:1/100']);
            const { candidates } = select(info, ['10:101/50'], ['21:1/151', '10:101/50']);
            assert.equal(candidates.length, 0);
        });

        describe('address shapes', () => {
            //  FSC-0087 permits 2D..5D and lets a forwarder rewrite dimensions
            //  per downlink, so a Seenby is in whatever shape the last hop
            //  chose. A strict comparison here re-forwards to a node that has
            //  already seen the file.

            it('matches a 5D Seenby against a 3D downlink', async () => {
                const info = await parse(['From 21:1/100', 'Seenby 21:1/200@fsxnet']);
                const { candidates, skipped } = select(info, ['21:1/200']);
                assert.equal(candidates.length, 0, 'must not re-forward');
                assert.equal(reasonFor(skipped, '21:1/200'), SkipReasons.AlreadySeen);
            });

            it('matches an explicit point 0 against a bare node', async () => {
                const info = await parse(['From 21:1/100', 'Seenby 21:1/200.0']);
                const { candidates } = select(info, ['21:1/200']);
                assert.equal(candidates.length, 0);
            });

            it('matches a zone-less Seenby using the area network zone', async () => {
                const info = await parse(['From 21:1/100', 'Seenby 1/200']);
                const { candidates } = select(info, ['21:1/200']);
                assert.equal(candidates.length, 0);
            });

            it('still distinguishes a real point from its boss node', async () => {
                const info = await parse(['From 21:1/100', 'Seenby 21:1/200.4']);
                const { candidates } = select(info, ['21:1/200']);
                assert.deepEqual(names(candidates), ['21:1/200']);
            });
        });

        it('reports an unparsable downlink rather than forwarding to it', async () => {
            const info = await parse(['From 21:1/100']);
            const { candidates, skipped } = select(info, ['not-an-address', '21:1/200']);
            assert.deepEqual(names(candidates), ['21:1/200']);
            assert.equal(skipped[0].reason, SkipReasons.Unparsable);
        });

        it('handles a TIC with no Seenby at all', async () => {
            //  Ordinary: our reader does not require one, and htick only warns.
            const info = await parse(['Area A', 'From 21:1/100']);
            const { candidates } = select(info, ['21:1/200']);
            assert.deepEqual(names(candidates), ['21:1/200']);
        });

        it('handles no downlinks configured — the leaf case', async () => {
            const info = await parse(['From 21:1/100', 'Seenby 21:1/100']);
            const { candidates, skipped } = select(info, []);
            assert.equal(candidates.length, 0);
            assert.equal(skipped.length, 0);
        });
    });

    describe('buildSeenby', () => {
        function build(info, downlinks, ourAddresses = OURS) {
            return ticForward.buildSeenby({
                ticFileInfo: info,
                downlinks,
                ourAddresses,
                defaultZone: ZONE,
            });
        }

        it('unions inbound, ours and every downlink, sorted', async () => {
            const info = await parse([
                'From 21:1/100',
                'Seenby 21:1/100',
                'Seenby 21:2/50',
            ]);
            assert.deepEqual(names(build(info, ['21:1/300', '21:1/200'])), [
                '21:1/100',
                '21:1/151',
                '21:1/200',
                '21:1/300',
                '21:2/50',
            ]);
        });

        it('includes a downlink we are not forwarding to on this pass', async () => {
            //  A downlink skipped because it is the sender still belongs in
            //  Seenby: it demonstrably has the file. htick does the same.
            const info = await parse(['From 21:1/100', 'Seenby 21:1/151']);
            const seenby = build(info, ['21:1/100']);
            assert.ok(names(seenby).includes('21:1/100'));
        });

        it('does not duplicate an address written in a different shape', async () => {
            const info = await parse(['Seenby 21:1/200@fsxnet', 'Seenby 21:1/300.0']);
            const seenby = build(info, ['21:1/200', '21:1/300']);
            assert.deepEqual(names(seenby), ['21:1/151', '21:1/200', '21:1/300']);
        });

        it('sorts points under their boss node', async () => {
            const info = await parse(['Seenby 21:1/200.4', 'Seenby 21:1/200']);
            assert.deepEqual(names(build(info, ['21:1/200.1'], [])), [
                '21:1/200',
                '21:1/200.1',
                '21:1/200.4',
            ]);
        });

        it('produces just us when nothing else is known', async () => {
            const info = await parse(['Area A']);
            assert.deepEqual(names(build(info, [])), ['21:1/151']);
        });
    });

    describe('downlinksOf', () => {
        it('reads an array', () => {
            assert.deepEqual(ticForward.downlinksOf({ downlinks: ['21:1/1'] }), [
                '21:1/1',
            ]);
        });

        it('reads a space separated string, as EchoMail uplinks may be written', () => {
            assert.deepEqual(ticForward.downlinksOf({ downlinks: '21:1/1 21:1/2' }), [
                '21:1/1',
                '21:1/2',
            ]);
        });

        it('is empty for an area with none, or no area at all', () => {
            assert.deepEqual(ticForward.downlinksOf({ areaTag: 'x' }), []);
            assert.deepEqual(ticForward.downlinksOf(undefined), []);
            assert.deepEqual(ticForward.downlinksOf('justAnAreaTag'), []);
        });
    });
});
