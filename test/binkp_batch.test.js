'use strict';

const { strict: assert } = require('assert');

const {
    makeScriptedPair,
    runAnswering,
    runSession,
    makeTempFile,
} = require('./binkp_peer.js');

//
//  binkp/1.1 batching.
//
//  A session is a series of batches. Each ends when both sides have sent
//  M_EOB, and another follows unless the batch carried nothing but that pair
//  — so a session that moved any mail always ends on a trailing empty batch.
//  binkd decides this by counting every command frame it sent and received
//  since the batch began (protocol.c:3275-3293); because each frame is
//  counted once by its sender and once by its receiver, both sides arrive at
//  the same total and take the same decision.
//
//  Skipping the empty batch does not lose mail, which is why it went
//  unnoticed: it leaves the peer waiting for an M_EOB that never arrives
//  until something times out. binkd then books an otherwise successful
//  session as failed, and on our side the node's lock stays held for the
//  duration, so a crashmail dispatch to that node in the meantime is skipped.
//

describe('BinkpSession — binkp/1.1 batching', function () {
    this.timeout(10000);

    it('follows a batch that carried a file with an empty one', async () => {
        const f = await makeTempFile('BATCHED');
        const { session, peer } = await makeScriptedPair({ opts: [] });
        session.queueFile(f.filePath, f.name, f.size, f.timestamp, 'keep');

        await runSession(session);

        assert.equal(peer.batches.length, 2, 'one working batch, then an empty one');
        assert.ok(peer.batches[0] > 2, 'the first batch carried more than the M_EOBs');
        assert.equal(peer.batches[1], 2, 'the last batch is just the two M_EOBs');
        assert.equal(peer.received[0].data.toString(), 'BATCHED');
    });

    it('ends after a single batch when nothing was transferred', async () => {
        const { session, peer } = await makeScriptedPair({ opts: [] });

        await runSession(session);

        //  An empty session is already an empty batch; adding another would
        //  be a pointless round trip on every poll of a quiet node.
        assert.deepEqual(peer.batches, [2]);
    });

    it('keeps batching while files keep moving', async () => {
        const a = await makeTempFile('FIRST');
        const b = await makeTempFile('SECOND');

        const { session, peer } = await makeScriptedPair({
            opts: [],
            filesToSend: [
                {
                    name: 'inbound.pkt',
                    size: 7,
                    timestamp: 1700000000,
                    data: Buffer.from('INBOUND'),
                },
            ],
        });
        session.queueFile(a.filePath, a.name, a.size, a.timestamp, 'keep');
        session.queueFile(b.filePath, b.name, b.size, b.timestamp, 'keep');

        await runSession(session);

        assert.equal(peer.batches[peer.batches.length - 1], 2, 'ends on an empty batch');
        assert.equal(peer.received.length, 2, 'both files still went out');
    });

    it('does the same when we are the answering side', async () => {
        const f = await makeTempFile('ANSWERED');

        const { peer } = await runAnswering({ opts: [] }, {}, session => {
            session.queueFile(f.filePath, f.name, f.size, f.timestamp, 'keep');
        });

        assert.equal(peer.batches[peer.batches.length - 1], 2);
        assert.equal(peer.received[0].data.toString(), 'ANSWERED');
    });

    it('carries a file queued by the onBatchEnd hook', async () => {
        const first = await makeTempFile('BATCH-ONE');
        const second = await makeTempFile('BATCH-TWO');

        let queued = false;
        const { session, peer } = await makeScriptedPair(
            { opts: [] },
            {
                onBatchEnd: sess => {
                    if (queued) {
                        return;
                    }
                    queued = true;
                    sess.queueFile(
                        second.filePath,
                        second.name,
                        second.size,
                        second.timestamp,
                        'keep'
                    );
                },
            }
        );
        session.queueFile(
            first.filePath,
            first.name,
            first.size,
            first.timestamp,
            'keep'
        );

        await runSession(session);

        assert.deepEqual(
            peer.received.map(r => r.data.toString()),
            ['BATCH-ONE', 'BATCH-TWO']
        );
        assert.equal(peer.batches[peer.batches.length - 1], 2);
    });
});

// ── Peers that do not batch ───────────────────────────────────────────────────

describe('BinkpSession — batching against older peers', function () {
    this.timeout(10000);

    it('does not offer another batch to a binkp/1.0 peer', async () => {
        const f = await makeTempFile('OLD-PEER');
        const { session, peer } = await makeScriptedPair({
            opts: [],
            protocolVer: '1.0',
            singleBatch: true,
        });
        session.queueFile(f.filePath, f.name, f.size, f.timestamp, 'keep');

        await runSession(session);

        //  binkd stops after the first batch below 1.1, so a second M_EOB
        //  round would be talking to nobody.
        assert.equal(peer.batches.length, 1);
        assert.equal(peer.received[0].data.toString(), 'OLD-PEER');
    });

    it('does not assume 1.1 from a peer that never sent VER', async () => {
        const f = await makeTempFile('NO-VER');
        const { session, peer } = await makeScriptedPair({
            opts: [],
            noVer: true,
            singleBatch: true,
        });
        session.queueFile(f.filePath, f.name, f.size, f.timestamp, 'keep');

        await runSession(session);

        assert.equal(peer.batches.length, 1);
        assert.equal(peer.received[0].data.toString(), 'NO-VER');
    });

    it('finishes cleanly when the caller hangs up a batch early', async () => {
        //  We answer, expect another batch, and the caller closes instead.
        //  Everything had been acknowledged, so that is a clean end rather
        //  than a dropped session — the caller simply counted the session
        //  over one batch sooner than we did.
        const f = await makeTempFile('EARLY-CLOSE');

        const { peer } = await runAnswering(
            { opts: [], singleBatch: true },
            {},
            session => {
                session.queueFile(f.filePath, f.name, f.size, f.timestamp, 'keep');
            }
        );

        assert.equal(peer.batches.length, 1, 'the caller stopped after one batch');
        assert.equal(peer.received[0].data.toString(), 'EARLY-CLOSE');
    });
});

// ── The counting rule itself ──────────────────────────────────────────────────

describe('BinkpSession — batch continuation rule', function () {
    this.timeout(10000);

    async function session() {
        const { session: s } = await makeScriptedPair({ opts: [] });
        return s;
    }

    it('needs more than the two M_EOBs to continue', async () => {
        const s = await session();
        s._remoteVer = { major: 1, minor: 1 };

        s._batchMsgCount = 2;
        assert.equal(s._shouldStartAnotherBatch(), false);
        s._batchMsgCount = 3;
        assert.equal(s._shouldStartAnotherBatch(), true);

        s._destroy();
    });

    it('needs the remote to be above binkp/1.0', async () => {
        const s = await session();
        s._batchMsgCount = 10;

        s._remoteVer = null;
        assert.equal(s._shouldStartAnotherBatch(), false, 'no VER seen');
        s._remoteVer = { major: 1, minor: 0 };
        assert.equal(s._shouldStartAnotherBatch(), false, 'binkp/1.0');
        s._remoteVer = { major: 1, minor: 1 };
        assert.equal(s._shouldStartAnotherBatch(), true, 'binkp/1.1');
        s._remoteVer = { major: 2, minor: 0 };
        assert.equal(s._shouldStartAnotherBatch(), true, 'anything newer');

        s._destroy();
    });

    it('stops after the batch limit however talkative the peer is', async () => {
        const s = await session();
        s._remoteVer = { major: 1, minor: 1 };
        s._batchMsgCount = 1000;

        s._batchesDone = 15;
        assert.equal(s._shouldStartAnotherBatch(), true);
        s._batchesDone = 16;
        assert.equal(
            s._shouldStartAnotherBatch(),
            false,
            'a peer that never falls quiet must not hold the session open'
        );

        s._destroy();
    });

    it('reads the version out of the VER frame', async () => {
        const { session: s } = await makeScriptedPair({ opts: [] });
        await runSession(s);
        assert.deepEqual(s._remoteVer, { major: 1, minor: 1 });
    });
});
