'use strict';

const { strict: assert } = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');

const { BinkpSession } = require('../core/binkp/session');
const { Commands } = require('../core/binkp/commands');
const {
    makeScriptedPair,
    runSession,
    exists,
    removeTempFiles,
} = require('./binkp_peer.js');

//  at the root, so it runs once the whole run is done: the helper's temp
//  files belong to every suite in this file
after(removeTempFiles);

//
//  Issue #1043: a compressed file followed by a clear one in a pipelined
//  batch left the session open until the five-minute timeout.
//
//  A compressed receive is finished asynchronously: zlib has to drain and
//  the write stream flush before its M_GOT goes out. The M_FILE for the next
//  file replaces it as the current receive meanwhile, and a clear file flushes
//  sooner. Once that one was acknowledged nothing the batch-end test looked
//  at was still open, so the receiver closed the batch and sent the next
//  batch's M_EOB *before* the compressed file's M_GOT. The sender, which
//  sends M_EOB without waiting for its M_GOTs, counted that M_EOB as part of
//  the first batch, then threw it away when the batch turned over, and both
//  sides sat waiting for an M_EOB from the other.
//
//  binkd holds its M_EOB until every file is acknowledged, so against binkd
//  the window never opens; it takes an ENiGMA sender. The deadlines here are
//  short on purpose: the failure is a hang, and it should fail in seconds.
//
const DEADLINE_MS = 3000;

const COMPRESSIBLE = 'ENiGMA-BinkP-1043-'.repeat(1024);

function withDeadline(promise, what, ms = DEADLINE_MS) {
    let timer;
    const deadline = new Promise((resolve, reject) => {
        timer = setTimeout(
            () => reject(new Error(`${what}: still open after ${ms}ms`)),
            ms
        );
    });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

//  The command frames |session| sends once transfer has begun, in order.
function tapSent(session) {
    const sent = [];
    const send = session._sendCmd.bind(session);
    session._sendCmd = (cmd, arg) => {
        if ('transfer' === session._state) {
            sent.push({ cmd, arg });
        }
        return send(cmd, arg);
    };
    return sent;
}

//  The frame count of each batch |session| completes, as the peer's
//  |batches| records it, so the two sides can be compared.
function tapBatches(session) {
    const batches = [];
    const complete = session._onBatchComplete.bind(session);
    session._onBatchComplete = () => {
        if (!session._batchEndPending) {
            batches.push(session._batchMsgCount);
        }
        return complete();
    };
    return batches;
}

//  Every M_GOT has to come before the receiver's second M_EOB: that M_EOB
//  opens the next batch, and an M_GOT behind it is counted in the wrong one.
function assertGotsBeforeSecondEob(frames, fileCount) {
    const eobs = frames
        .map((f, i) => (f.cmd === Commands.M_EOB ? i : -1))
        .filter(i => i >= 0);
    const gots = frames
        .map((f, i) => (f.cmd === Commands.M_GOT ? i : -1))
        .filter(i => i >= 0);
    assert.equal(gots.length, fileCount, 'one M_GOT per file');
    assert.ok(eobs.length >= 2, 'the receiver opened a second batch');
    for (const i of gots) {
        assert.ok(
            i < eobs[1],
            `M_GOT ${frames[i].arg} went out after the second M_EOB: ` +
                frames.map(f => f.cmd).join(',')
        );
    }
}

// ── Two ENiGMA sessions ───────────────────────────────────────────────────────

describe('BinkpSession — compressed then clear in one batch (#1043)', function () {
    this.timeout(DEADLINE_MS + 5000);

    let tmp;
    beforeEach(async () => {
        tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'binkp_1043_'));
    });
    afterEach(async () => {
        await fsp.rm(tmp, { recursive: true, force: true });
    });

    //  The answering session sends |kinds| ('pkt' goes compressed, 'zip'
    //  goes clear) and the originating one receives them, both on defaults.
    async function sendBetweenSessions(kinds) {
        const files = [];
        for (const [i, kind] of kinds.entries()) {
            const name = 'pkt' === kind ? `0000aa0${i}.pkt` : `arc${i}.zip`;
            const data = Buffer.from(
                'pkt' === kind ? `${i}:${COMPRESSIBLE}` : `ZIP-${i}-${'z'.repeat(i + 1)}`
            );
            const filePath = path.join(tmp, name);
            await fsp.writeFile(filePath, data);
            files.push({ name, data, filePath, timestamp: 1700000000 + i });
        }

        const ended = (session, who, resolve, reject) => {
            session.on('session-end', resolve);
            session.on('disconnect', () => reject(new Error(`${who} disconnected`)));
            session.on('error', reject);
        };

        let answeringSession;
        const answeringEnded = new Promise((resolve, reject) => {
            answeringSession = session => ended(session, 'sender', resolve, reject);
        });
        //  Awaited below; this only keeps an early failure from being
        //  reported as unhandled while the receiver is still running.
        answeringEnded.catch(() => {});
        const server = net.createServer(socket => {
            const answering = new BinkpSession(socket, {
                role: 'answering',
                addresses: ['1:1/1@testnet'],
                getPassword: () => null,
                tempDir: tmp,
            });
            for (const f of files) {
                answering.queueFile(
                    f.filePath,
                    f.name,
                    f.data.length,
                    f.timestamp,
                    'keep'
                );
            }
            answeringSession(answering);
            answering.start();
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

        const socket = net.createConnection(server.address().port, '127.0.0.1');
        await new Promise((resolve, reject) => {
            socket.once('connect', resolve);
            socket.once('error', reject);
        });
        const receiving = new BinkpSession(socket, {
            role: 'originating',
            addresses: ['1:2/2@testnet'],
            getPassword: () => null,
            tempDir: tmp,
        });
        const sent = tapSent(receiving);
        const received = {};
        receiving.on('file-received', (name, size, ts, p) => {
            received[name] = fs.readFileSync(p);
        });
        const receiverEnded = new Promise((resolve, reject) =>
            ended(receiving, 'receiver', resolve, reject)
        );
        receiving.start();

        try {
            await withDeadline(receiverEnded, 'receiver');
            //  The answering side ends once the originating one closes;
            //  give it the same short leash.
            await withDeadline(answeringEnded, 'sender');
        } finally {
            server.close();
            socket.destroy();
        }

        for (const f of files) {
            assert.ok(received[f.name], `${f.name} was never received`);
            assert.deepEqual(received[f.name], f.data, `${f.name} came back wrong`);
        }
        assertGotsBeforeSecondEob(sent, files.length);
    }

    for (const kinds of [
        ['pkt', 'zip'],
        ['pkt', 'zip', 'zip'],
        ['pkt', 'zip', 'pkt', 'zip'],
    ]) {
        it(`ends after ${kinds.join(', ')}`, () => sendBetweenSessions(kinds));
    }

    //  Controls: the compressed file is last, or nothing settles sooner than
    //  it. These never hung, and must not start to.
    for (const kinds of [
        ['zip', 'pkt'],
        ['pkt', 'pkt'],
    ]) {
        it(`still ends after ${kinds.join(', ')}`, () => sendBetweenSessions(kinds));
    }
});

// ── A scripted sender ─────────────────────────────────────────────────────────

describe('BinkpSession — receiving from a sender that sends M_EOB early (#1043)', function () {
    this.timeout(DEADLINE_MS + 5000);

    const packed = Buffer.from(COMPRESSIBLE);
    const clear = Buffer.from('CLEAR-ARCHIVE-BYTES');
    const filesToSend = [
        {
            name: '0000bb00.pkt',
            size: packed.length,
            timestamp: 1700000000,
            data: packed,
            gzContainer: 'zlib',
        },
        { name: 'arc1.zip', size: clear.length, timestamp: 1700000001, data: clear },
    ];

    async function receive(peerOpts) {
        const { session, peer } = await makeScriptedPair({
            opts: ['EXTCMD', 'GZ'],
            pipeline: true,
            filesToSend,
            ...peerOpts,
        });
        const batches = tapBatches(session);
        const received = {};
        session.on('file-received', (name, size, ts, p) => {
            received[name] = fs.readFileSync(p);
            fs.unlink(p, () => {});
        });

        try {
            await withDeadline(runSession(session), 'session');
        } catch (err) {
            session._destroy();
            throw err;
        }

        for (const f of filesToSend) {
            assert.deepEqual(received[f.name], f.data, `${f.name} came back wrong`);
        }
        //  Both sides counted the same frames into the same batches, and so
        //  agreed on which one was empty.
        assert.deepEqual(batches, peer.batches, 'the two sides count batches alike');
        return peer;
    }

    it('acknowledges both files before it opens the next batch', async () => {
        const peer = await receive({ eobWithoutGots: true });
        //  What the session sent, as the peer saw it.
        assertGotsBeforeSecondEob(peer.framesIn, filesToSend.length);
    });

    it('still ends against a sender that waits for its M_GOTs, as binkd does', async () => {
        const peer = await receive({});
        assertGotsBeforeSecondEob(peer.framesIn, filesToSend.length);
    });
});

// ── Teardown ──────────────────────────────────────────────────────────────────

//
//  A session torn down mid-batch unlinks its partial inbound files. Any
//  receive still being flushed at that point must not go on to hand its file
//  over afterwards: the listener would get a path that no longer exists, for
//  a file whose M_GOT never reached the sender.
//
describe('BinkpSession — no inbound file is handed on after teardown', function () {
    this.timeout(DEADLINE_MS + 5000);

    function settle(session) {
        return withDeadline(
            new Promise(resolve => {
                session.once('session-end', resolve);
                session.once('disconnect', resolve);
            }),
            'teardown'
        );
    }

    it('drops a compressed file still flushing behind the current one', async () => {
        const packed = Buffer.from(COMPRESSIBLE);
        const clear = Buffer.from('CLEAR-ARCHIVE-BYTES');
        const { session } = await makeScriptedPair({
            opts: ['EXTCMD', 'GZ'],
            pipeline: true,
            filesToSend: [
                {
                    name: '0000cc00.pkt',
                    size: packed.length,
                    timestamp: 1700000000,
                    data: packed,
                    gzContainer: 'zlib',
                },
                {
                    name: 'arc1.zip',
                    size: clear.length,
                    timestamp: 1700000001,
                    data: clear,
                },
            ],
        });
        session.on('error', () => {});

        //  Hold the compressed receive in its finalizing state -- ended, not
        //  yet flushed -- so the clear file overtakes it deterministically.
        let held = null;
        let packedRecv = null;
        const onData = session._onDataFrame.bind(session);
        session._onDataFrame = data => {
            onData(data);
            const cr = session._currentRecv;
            if (cr && cr.inflate && !packedRecv) {
                packedRecv = cr;
                const end = cr.inflate.end.bind(cr.inflate);
                cr.inflate.end = (...args) => {
                    held = () => end(...args);
                    return cr.inflate;
                };
            }
        };

        let tornDown = false;
        const after = [];
        const clearReceived = new Promise(resolve => {
            session.on('file-received', (name, size, ts, p) => {
                if (tornDown) {
                    after.push(name);
                }
                if ('arc1.zip' === name) {
                    resolve(p);
                }
            });
        });
        const settled = settle(session);
        session.start();

        const clearPath = await withDeadline(clearReceived, 'clear file');
        await fsp.unlink(clearPath).catch(() => {});
        assert.ok(packedRecv, 'the compressed file was received');
        assert.ok(held, 'and is being finalized');
        assert.notEqual(session._currentRecv, packedRecv, 'behind the current receive');

        session.abort('test teardown');
        tornDown = true;
        held();
        await settled;
        //  zlib and the write stream are asynchronous; give them the time a
        //  late hand-off would need to show up.
        await new Promise(resolve => setTimeout(resolve, 150));

        assert.deepEqual(after, [], 'a file was handed on after teardown');
        assert.equal(await exists(packedRecv.tempPath), false, 'its partial is removed');
    });

    it('drops a clear file whose flush is cut short', async () => {
        const clear = Buffer.alloc(64 * 1024, 0x43);
        const { session } = await makeScriptedPair({
            opts: [],
            filesToSend: [
                {
                    name: 'arc0.zip',
                    size: clear.length,
                    timestamp: 1700000000,
                    data: clear,
                },
            ],
        });
        session.on('error', () => {});

        //  Tear down the moment the write stream is told to end. Destroying
        //  it still runs the callback end() was given, with an error.
        let tornDown = false;
        let cutRecv = null;
        const finalize = session._finalizeReceive.bind(session);
        session._finalizeReceive = (cr = session._currentRecv) => {
            finalize(cr);
            if (!tornDown && cr && cr.writeStream && !cr.inflate) {
                cutRecv = cr;
                tornDown = true;
                session._destroy();
            }
        };

        const after = [];
        session.on('file-received', name => {
            if (tornDown) {
                after.push(name);
            }
        });
        const settled = settle(session);
        session.start();
        await settled;
        await new Promise(resolve => setTimeout(resolve, 150));

        assert.ok(cutRecv, 'the teardown happened mid-flush');
        assert.deepEqual(after, [], 'a file was handed on after teardown');
    });
});
