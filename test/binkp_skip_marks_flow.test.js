'use strict';

//
//  A destructive skip -- the remote answering M_GOT for a file we have queued
//  or are still sending -- finishes with the file exactly as a full send does:
//  its disposition, and its flow file line marked '~' (issue #1045).
//
//  A real originating BinkpSession with the spool attached, against the
//  scripted peer. NR mode holds each offer until the peer answers it, which
//  makes both skip branches deterministic: the offered file is the one in
//  flight, and every file behind it is still queued.
//

const { strict: assert } = require('assert');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const {
    BsoSpool,
    attachSpoolToSession,
    nodeBaseName,
} = require('../core/binkp/bso_spool');
const Address = require('../core/ftn_address');
const {
    makeScriptedPair,
    runSession,
    exists,
    removeTempFiles,
} = require('./binkp_peer.js');

//  at the root, so it runs once the whole run is done: the helper's temp
//  files belong to every suite in this file
after(removeTempFiles);
const { listQueued } = require('./helpers/bso_listing');

//  The scripted peer presents 1:1/1.
const PEER_ADDR = { zone: 1, net: 1, node: 1 };

describe('BinkP — a file skipped with M_GOT is marked in its flow file (#1045)', function () {
    this.timeout(10000);

    let tmpDir;
    let outDir;
    let spool;

    before(async () => {
        tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'enigma_binkp_skip_'));
        outDir = path.join(tmpDir, 'outbound');
        await fsp.mkdir(outDir, { recursive: true });
        await fsp.mkdir(path.join(tmpDir, 'inbound'), { recursive: true });
        await fsp.mkdir(path.join(tmpDir, 'secinbound'), { recursive: true });
        spool = new BsoSpool({
            paths: {
                outbound: tmpDir,
                inbound: path.join(tmpDir, 'inbound'),
                secInbound: path.join(tmpDir, 'secinbound'),
            },
            networks: {
                testnet: { localAddress: '1:1/100', defaultZone: 1 },
            },
        });
    });

    after(async () => {
        await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    beforeEach(async () => {
        const entries = await fsp.readdir(outDir);
        await Promise.all(
            entries.map(e =>
                fsp.rm(path.join(outDir, e), { recursive: true, force: true })
            )
        );
    });

    const flowPath = () => path.join(outDir, `${nodeBaseName(PEER_ADDR)}.flo`);
    const bsyPath = () => path.join(outDir, `${nodeBaseName(PEER_ADDR)}.bsy`);

    async function payload(name, content) {
        const p = path.join(outDir, name);
        await fsp.writeFile(p, content);
        const st = await fsp.stat(p);
        return {
            path: p,
            name,
            size: st.size,
            timestamp: Math.floor(st.mtimeMs / 1000),
            gotArg() {
                return `${this.name} ${this.size} ${this.timestamp}`;
            },
        };
    }

    //  Run the session to its end, then wait for the spool to release the
    //  node's .bsy: it settles the flow file bookkeeping first.
    async function run(peerOpts) {
        const { session, peer } = await makeScriptedPair({ opts: ['NR'], ...peerOpts });
        const sent = [];
        session.on('file-sent', name => sent.push(name));
        await attachSpoolToSession(session, spool, [new Address(PEER_ADDR)]);
        await runSession(session);
        for (let i = 0; i < 100 && (await exists(bsyPath())); i++) {
            await new Promise(r => setTimeout(r, 20));
        }
        assert.equal(await exists(bsyPath()), false, 'the session released its lock');
        return { peer, sent };
    }

    //  The flow file goes once nothing is left in it to send; while it is
    //  there, every line must be marked.
    async function assertAllMarked() {
        let content = null;
        try {
            content = await fsp.readFile(flowPath(), 'utf8');
        } catch (err) {
            assert.equal(err.code, 'ENOENT', err.message);
        }
        if (null !== content) {
            content
                .split('\n')
                .filter(l => l.trim().length)
                .forEach(l =>
                    assert.ok(
                        l.startsWith('~'),
                        `line left unmarked, so offered again next session: ${l}`
                    )
                );
        }
        const again = await listQueued(spool, PEER_ADDR);
        assert.equal(again.length, 0, 'nothing is queued for the next session');
    }

    it('marks a queued file the remote acknowledges before it is offered', async () => {
        const first = await payload('first.pkt', 'FIRST');
        const queued = await payload('queued.zip', 'QUEUED-BUT-ALREADY-THERE');
        await fsp.writeFile(flowPath(), `${first.path}\n${queued.path}\n`);

        const { peer, sent } = await run({
            alsoGot: name => (name === first.name ? [queued.gotArg()] : []),
        });

        assert.deepEqual(
            peer.received.map(f => f.name),
            [first.name],
            'the acknowledged file is never sent'
        );
        assert.deepEqual(sent.sort(), [first.name, queued.name].sort());
        await assertAllMarked();
        assert.equal(await exists(queued.path), true, 'a plain line keeps its file');
    });

    it('marks the file in flight when the remote acknowledges it', async () => {
        const inFlight = await payload('inflight.pkt', 'ALREADY-THERE');
        await fsp.writeFile(flowPath(), `${inFlight.path}\n`);

        const { peer, sent } = await run({ dupeNames: [inFlight.name] });

        assert.equal(peer.received.length, 0, 'nothing is transferred');
        assert.deepEqual(sent, [inFlight.name]);
        await assertAllMarked();
        assert.equal(await exists(inFlight.path), true, 'a plain line keeps its file');
    });

    it('deletes a ^ file in flight and marks its line', async () => {
        const inFlight = await payload('caret.pkt', 'DELETE-AFTER-SEND');
        await fsp.writeFile(flowPath(), `^${inFlight.path}\n`);

        const { peer, sent } = await run({ dupeNames: [inFlight.name] });

        assert.equal(peer.received.length, 0, 'nothing is transferred');
        assert.deepEqual(sent, [inFlight.name]);
        assert.equal(await exists(inFlight.path), false, 'the ^ file is deleted');
        await assertAllMarked();
    });

    it('deletes a queued ^ file and marks its line', async () => {
        const first = await payload('lead.pkt', 'LEAD');
        const queued = await payload('queued.pkt', 'DELETE-AFTER-SEND');
        await fsp.writeFile(flowPath(), `${first.path}\n^${queued.path}\n`);

        const { peer, sent } = await run({
            alsoGot: name => (name === first.name ? [queued.gotArg()] : []),
        });

        assert.deepEqual(
            peer.received.map(f => f.name),
            [first.name]
        );
        assert.deepEqual(sent.sort(), [first.name, queued.name].sort());
        assert.equal(await exists(queued.path), false, 'the ^ file is deleted');
        await assertAllMarked();
    });
});
