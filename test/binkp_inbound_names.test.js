'use strict';

//
//  Inbound file names at the session boundary: a name from the peer is
//  reduced to a plain file name before anything uses it, and a file whose
//  name does not reduce to one is answered on the wire without being stored.
//

const { strict: assert } = require('assert');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const { Commands } = require('../core/binkp/commands');
const {
    runAnswering,
    makeScriptedPair,
    runSession,
    removeTempFiles,
} = require('./binkp_peer');

//  at the root, so it runs once the whole run is done: the helper's temp
//  files belong to every suite in this file
after(removeTempFiles);

const TS = 1700000000;

function file(name, body, extra = {}) {
    const data = Buffer.from(body);
    return { name, size: data.length, timestamp: TS, data, ...extra };
}

function framesOf(peer, cmd) {
    return peer.framesIn.filter(f => f.cmd === cmd).map(f => f.arg);
}

//  Every event the session raised about inbound files, by name.
function recordInbound(session, into) {
    session.on('incoming-file', name => into.incoming.push(name));
    session.on('file-received', (name, size, ts, tempPath) =>
        into.received.push({ name, tempPath })
    );
}

describe('BinkP inbound file names', () => {
    let spoolRoot;
    let inbound;

    before(async () => {
        spoolRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'enigma_binkp_names_'));
        //  Deep enough that a name climbing two levels still lands inside
        //  spoolRoot, where the test can look for it.
        inbound = path.join(spoolRoot, 'a', 'b', 'inbound');
        await fsp.mkdir(inbound, { recursive: true });
    });

    after(async () => {
        await fsp.rm(spoolRoot, { recursive: true, force: true });
    });

    //  Every regular file under spoolRoot, relative to it.
    async function filesUnderRoot() {
        const out = [];
        const walk = async dir => {
            for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) {
                    await walk(p);
                } else {
                    out.push(path.relative(spoolRoot, p));
                }
            }
        };
        await walk(spoolRoot);
        return out.sort();
    }

    async function clearInbound() {
        for (const e of await fsp.readdir(inbound)) {
            await fsp.rm(path.join(inbound, e), { force: true });
        }
    }

    //  Run an answering session wired to a real spool, so a received file
    //  goes all the way to the inbound directory.
    async function receiveThroughSpool(filesToSend, peerOpts = {}) {
        await clearInbound();
        const { BsoSpool, attachSpoolToSession } = require('../core/binkp/bso_spool');
        const spool = new BsoSpool({
            paths: {
                outbound: path.join(spoolRoot, 'outbound'),
                inbound,
                secInbound: inbound,
            },
            networks: { testnet: { localAddress: '1:1/1', defaultZone: 1 } },
        });

        const seen = { incoming: [], received: [] };
        const { session, peer } = await runAnswering(
            { opts: [], filesToSend, ...peerOpts },
            {},
            sess => {
                recordInbound(sess, seen);
                //  The answering branch registers its listeners before its
                //  first await, so they are in place before start().
                attachSpoolToSession(sess, spool, null);
            }
        );
        //  Let the spool's asynchronous move settle.
        await new Promise(r => setTimeout(r, 50));
        return { session, peer, seen };
    }

    it('answers a name with path components with M_GOT and stores nothing', async () => {
        const { peer, seen } = await receiveThroughSpool([
            file('../../outside.pkt', 'NOT STORED'),
            file('0000fff0.pkt', 'STORED'),
        ]);

        assert.ok(
            framesOf(peer, Commands.M_GOT).includes(`../../outside.pkt 10 ${TS}`),
            'the refused file is acknowledged under the name the peer used'
        );
        assert.deepEqual(seen.incoming, ['0000fff0.pkt']);
        assert.deepEqual(
            seen.received.map(r => r.name),
            ['0000fff0.pkt']
        );
        assert.deepEqual(await filesUnderRoot(), [
            path.join('a', 'b', 'inbound', '0000fff0.pkt'),
        ]);
        assert.equal(
            await fsp.readFile(path.join(inbound, '0000fff0.pkt'), 'utf8'),
            'STORED'
        );
    });

    it('treats escaped path components the same as literal ones', async () => {
        const { peer, seen } = await receiveThroughSpool([
            file('..\\x2f..\\x2foutside.pkt', 'NOT STORED'),
            file('sub\\x5coutside.pkt', 'NOT STORED'),
            file('\\x2e\\x2e', 'NOT STORED'),
            file('.hidden', 'NOT STORED'),
            file('ok.pkt', 'OK'),
        ]);

        const gots = framesOf(peer, Commands.M_GOT);
        for (const wire of [
            '..\\x2f..\\x2foutside.pkt',
            'sub\\x5coutside.pkt',
            '\\x2e\\x2e',
            '.hidden',
        ]) {
            assert.ok(
                gots.some(g => g.startsWith(`${wire} `)),
                `M_GOT for ${wire}`
            );
        }
        assert.deepEqual(seen.incoming, ['ok.pkt']);
        assert.deepEqual(await filesUnderRoot(), [
            path.join('a', 'b', 'inbound', 'ok.pkt'),
        ]);
    });

    it('does the same for a pipelining sender with no EOF frames', async () => {
        const { seen } = await receiveThroughSpool(
            [
                file('../../outside.pkt', 'NOT STORED'),
                file('first.pkt', 'FIRST'),
                file('sub/outside.pkt', 'NOT STORED'),
                file('second.pkt', 'SECOND'),
            ],
            { pipeline: true, noEofFrame: true }
        );

        assert.deepEqual(seen.incoming, ['first.pkt', 'second.pkt']);
        assert.deepEqual(await filesUnderRoot(), [
            path.join('a', 'b', 'inbound', 'first.pkt'),
            path.join('a', 'b', 'inbound', 'second.pkt'),
        ]);
        assert.equal(
            await fsp.readFile(path.join(inbound, 'first.pkt'), 'utf8'),
            'FIRST'
        );
        assert.equal(
            await fsp.readFile(path.join(inbound, 'second.pkt'), 'utf8'),
            'SECOND'
        );
    });

    it('answers an NR offer of such a name with M_GOT rather than M_GET', async () => {
        const { peer, seen } = await receiveThroughSpool([
            file('../../outside.pkt', 'NOT STORED', { nr: true }),
            file('nr.pkt', 'NR OK', { nr: true }),
        ]);

        assert.ok(
            !framesOf(peer, Commands.M_GET).some(g => g.startsWith('../../outside.pkt ')),
            'no offset request for the refused file'
        );
        assert.ok(
            framesOf(peer, Commands.M_GOT).some(g => g.startsWith('../../outside.pkt ')),
            'M_GOT for the refused file'
        );
        assert.deepEqual(seen.incoming, ['nr.pkt']);
        assert.deepEqual(await filesUnderRoot(), [
            path.join('a', 'b', 'inbound', 'nr.pkt'),
        ]);
    });

    it('stores an escaped name decoded and acknowledges it in its wire form', async () => {
        const { peer, seen } = await receiveThroughSpool([
            file('my\\x20file.zip', 'SPACED'),
        ]);

        assert.deepEqual(seen.incoming, ['my file.zip']);
        assert.ok(
            framesOf(peer, Commands.M_GOT).includes(`my\\x20file.zip 6 ${TS}`),
            'M_GOT carries the name exactly as the sender wrote it'
        );
        assert.equal(
            await fsp.readFile(path.join(inbound, 'my file.zip'), 'utf8'),
            'SPACED'
        );
    });

    it('leaves ordinary names exactly as they were on the wire', async () => {
        const { peer } = await receiveThroughSpool([
            file('00010002.mo0', 'ARCMAIL'),
            file('NODELIST.Z45', 'NODELIST'),
        ]);

        assert.deepEqual(framesOf(peer, Commands.M_GOT), [
            `00010002.mo0 7 ${TS}`,
            `NODELIST.Z45 8 ${TS}`,
        ]);
        assert.deepEqual(await filesUnderRoot(), [
            path.join('a', 'b', 'inbound', '00010002.mo0'),
            path.join('a', 'b', 'inbound', 'NODELIST.Z45'),
        ]);
    });

    it('applies on the originating side too', async () => {
        const seen = { incoming: [], received: [] };
        const { session, peer } = await makeScriptedPair({
            opts: [],
            filesToSend: [file('../../outside.pkt', 'NOT STORED'), file('ok.pkt', 'OK')],
        });
        recordInbound(session, seen);

        await runSession(session);

        assert.ok(
            framesOf(peer, Commands.M_GOT).some(g => g.startsWith('../../outside.pkt ')),
            'M_GOT for the refused file'
        );
        assert.deepEqual(seen.incoming, ['ok.pkt']);
        assert.deepEqual(
            seen.received.map(r => r.name),
            ['ok.pkt']
        );
        await Promise.all(seen.received.map(r => fsp.rm(r.tempPath, { force: true })));
    });
});
