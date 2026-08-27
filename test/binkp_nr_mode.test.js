'use strict';

const { strict: assert } = require('assert');
const fsp = require('fs/promises');

const { buildCommandFrame } = require('../core/binkp/frame');
const { Commands } = require('../core/binkp/commands');
const {
    makeScriptedPair,
    runAnswering,
    runSession,
    makeTempFile,
    exists,
} = require('./binkp_peer.js');

// ── Outbound NR mode — issue #724 ─────────────────────────────────────────────

describe('BinkpSession — NR mode sending (issue #724)', function () {
    this.timeout(10000);

    it('re-announces the file with M_FILE before sending data (FTS-1026)', async () => {
        const body = 'PACKET-BODY-FOR-NR-MODE';
        const f = await makeTempFile(body);

        const { session, peer } = await makeScriptedPair({ opts: ['NR', 'NDA'] });
        session.queueFile(f.filePath, f.name, f.size, f.timestamp, 'delete');

        await runSession(session);

        assert.equal(peer.received.length, 1, 'peer must have received the file');
        assert.equal(peer.received[0].data.toString(), body);

        //  The offer, then the re-announcement the spec requires. Without
        //  the second M_FILE a conforming receiver never opens the file and
        //  both sides sit until a session timeout.
        const headers = peer.fileHeaders(f.name);
        assert.equal(headers.length, 2, 'expected an offer and a re-announcement');
        assert.equal(headers[0].offset, -1, 'first M_FILE offers offset -1');
        assert.equal(headers[1].offset, 0, 'second M_FILE carries the real offset');
    });

    it('deletes the sent file once the peer acknowledges it', async () => {
        const f = await makeTempFile('DISPOSITION-DELETE');

        const { session } = await makeScriptedPair({ opts: ['NR'] });
        session.queueFile(f.filePath, f.name, f.size, f.timestamp, 'delete');

        await runSession(session);

        assert.equal(await exists(f.filePath), false, 'sent file should be gone');
    });

    it('resumes from the non-zero offset named in M_GET', async () => {
        const body = 'AAAABBBBCCCCDDDD';
        const f = await makeTempFile(body);

        const { session, peer } = await makeScriptedPair({
            opts: ['NR'],
            //  Peer already holds the first 8 bytes from an aborted session.
            getOffset: () => 8,
        });
        session.queueFile(f.filePath, f.name, f.size, f.timestamp, 'keep');

        await runSession(session);

        const headers = peer.fileHeaders(f.name);
        assert.equal(headers[1].offset, 8, 're-announcement carries the offset');
        assert.equal(
            peer.received[0].data.toString(),
            body.slice(8),
            'only the tail is retransmitted'
        );
    });

    it('sends several files in one batch', async () => {
        const a = await makeTempFile('FIRST-FILE');
        const b = await makeTempFile('SECOND-FILE');

        const { session, peer } = await makeScriptedPair({ opts: ['NR'] });
        session.queueFile(a.filePath, a.name, a.size, a.timestamp, 'keep');
        session.queueFile(b.filePath, b.name, b.size, b.timestamp, 'keep');

        await runSession(session);

        assert.equal(peer.received.length, 2);
        assert.deepEqual(peer.received.map(r => r.data.toString()).sort(), [
            'FIRST-FILE',
            'SECOND-FILE',
        ]);
    });

    it('keeps the GZ token on the re-announced M_FILE', async () => {
        const body = 'COMPRESS-ME-'.repeat(64);
        const f = await makeTempFile(body);

        const { session, peer } = await makeScriptedPair({
            opts: ['NR', 'EXTCMD', 'GZ'],
        });
        session.queueFile(f.filePath, f.name, f.size, f.timestamp, 'keep');

        await runSession(session);

        const headers = peer.fileHeaders(f.name);
        assert.equal(headers.length, 2);
        assert.ok(headers[0].gz, 'offer announces GZ');
        //  Dropping GZ from the second M_FILE would leave the receiver
        //  writing gzip bytes straight into the packet.
        assert.ok(headers[1].gz, 're-announcement must still announce GZ');
        assert.equal(peer.received[0].data.toString(), body);
    });

    it('handles a peer that answers the offer with M_GOT (already has it)', async () => {
        const f = await makeTempFile('ALREADY-THERE');

        const { session, peer } = await makeScriptedPair({
            opts: ['NR'],
            dupeNames: [f.name],
        });
        session.queueFile(f.filePath, f.name, f.size, f.timestamp, 'delete');

        //  A destructive skip: the peer has the file, so we drop ours.
        await runSession(session);

        assert.equal(peer.received.length, 0, 'nothing should be transferred');
        assert.equal(await exists(f.filePath), false, 'M_GOT still disposes of it');
    });
});

// ── M_SKIP ────────────────────────────────────────────────────────────────────

describe('BinkpSession — M_SKIP handling (FTS-1026)', function () {
    this.timeout(10000);

    it('advances the batch when the offered file is skipped in NR mode', async () => {
        const skipped = await makeTempFile('SKIP-ME');
        const kept = await makeTempFile('SEND-ME');

        const { session, peer } = await makeScriptedPair({
            opts: ['NR'],
            skipNames: [skipped.name],
        });

        const skippedEvents = [];
        session.on('file-skipped', name => skippedEvents.push(name));

        session.queueFile(
            skipped.filePath,
            skipped.name,
            skipped.size,
            skipped.timestamp,
            'delete'
        );
        session.queueFile(kept.filePath, kept.name, kept.size, kept.timestamp, 'keep');

        //  Before the fix the skipped file stayed in _currentSend forever:
        //  the send loop never advanced and the session died on timeout.
        await runSession(session);

        assert.deepEqual(skippedEvents, [skipped.name]);
        assert.equal(peer.received.length, 1, 'the second file still goes out');
        assert.equal(peer.received[0].data.toString(), 'SEND-ME');
        assert.equal(
            await exists(skipped.filePath),
            true,
            'M_SKIP is non-destructive — the file stays for next session'
        );
    });

    it('completes when a fully sent file is skipped rather than acknowledged', async () => {
        const f = await makeTempFile('SENT-THEN-SKIPPED');

        const { session, peer } = await makeScriptedPair({
            opts: [],
            onComplete: () => 'skip',
        });

        let skippedName = null;
        session.on('file-skipped', name => {
            skippedName = name;
        });

        session.queueFile(f.filePath, f.name, f.size, f.timestamp, 'delete');

        //  The file has left _sendQueue and _currentSend by now and lives in
        //  _pendingGots, which _checkDone waits on.
        await runSession(session);

        assert.equal(skippedName, f.name);
        assert.equal(peer.received.length, 1);
        assert.equal(
            await exists(f.filePath),
            true,
            'a skipped file is kept even though it was transferred'
        );
    });

    it('ignores M_SKIP for a file we know nothing about', async () => {
        const f = await makeTempFile('UNRELATED');

        const { session } = await makeScriptedPair({
            opts: [],
            onComplete: peer => {
                peer._send(Commands.M_SKIP, 'ghost.pkt 10 12345');
                return 'got';
            },
        });
        session.queueFile(f.filePath, f.name, f.size, f.timestamp, 'keep');

        await runSession(session);
    });
});

// ── M_GET for a file awaiting M_GOT ───────────────────────────────────────────

describe('BinkpSession — M_GET after transmission (FTS-1026)', function () {
    this.timeout(10000);

    it('retransmits a file it is still awaiting M_GOT for', async () => {
        const body = 'RE-REQUEST-THIS';
        const f = await makeTempFile(body);

        let asked = false;
        const { session, peer } = await makeScriptedPair({
            opts: [],
            onComplete: () => {
                //  First completion: ask for it again instead of
                //  acknowledging, the race FTS-1026 calls out under M_GET.
                if (!asked) {
                    asked = true;
                    return 'get';
                }
                return 'got';
            },
        });
        session.queueFile(f.filePath, f.name, f.size, f.timestamp, 'delete');

        await runSession(session);

        assert.equal(peer.received.length, 2, 'file should have been sent twice');
        assert.equal(peer.received[1].data.toString(), body);
        assert.equal(await exists(f.filePath), false);
    });

    it('ignores M_GET naming a file that is not ours', async () => {
        const f = await makeTempFile('MIND-YOUR-OWN');

        const { session, peer } = await makeScriptedPair({
            opts: [],
            onComplete: p => {
                p._send(Commands.M_GET, 'nothing-of-ours.pkt 4 12345 0');
                return 'got';
            },
        });
        session.queueFile(f.filePath, f.name, f.size, f.timestamp, 'keep');

        await runSession(session);

        assert.equal(peer.received.length, 1, 'the stray M_GET changes nothing');
    });
});

// ── Inbound NR mode ───────────────────────────────────────────────────────────

describe('BinkpSession — NR mode receiving', function () {
    this.timeout(10000);

    it('emits incoming-file once when the sender re-announces after M_GET', async () => {
        const body = Buffer.from('INBOUND-NR-BODY');
        const { session, peer } = await makeScriptedPair({
            opts: ['NR'],
            filesToSend: [
                {
                    name: 'inbound.pkt',
                    size: body.length,
                    timestamp: 1700000000,
                    data: body,
                    nr: true,
                },
            ],
        });

        const incoming = [];
        const receivedPaths = [];
        session.on('incoming-file', name => incoming.push(name));
        session.on('file-received', (name, size, ts, tempPath) => {
            receivedPaths.push(tempPath);
        });

        await runSession(session);

        //  Two M_FILE frames arrive for one file. Emitting 'incoming-file'
        //  for both leaves the FREQ handler's holdEOB() unbalanced and the
        //  batch never sends M_EOB.
        assert.deepEqual(incoming, ['inbound.pkt'], 'exactly one incoming-file');
        assert.equal(receivedPaths.length, 1);
        assert.equal((await fsp.readFile(receivedPaths[0])).toString(), body.toString());
        await fsp.unlink(receivedPaths[0]).catch(() => {});
        assert.ok(peer.framesIn.some(f => f.cmd === Commands.M_GET));
    });

    it('still receives from a sender that skips the re-announcement', async () => {
        const body = Buffer.from('LENIENT-PATH');
        const { session } = await makeScriptedPair({
            opts: ['NR'],
            filesToSend: [
                {
                    name: 'lenient.pkt',
                    size: body.length,
                    timestamp: 1700000000,
                    data: body,
                    nr: true,
                    //  Older ENiGMA answered M_GET with data and no M_FILE.
                    reannounce: false,
                },
            ],
        });

        const incoming = [];
        let tempPath = null;
        session.on('incoming-file', name => incoming.push(name));
        session.on('file-received', (name, size, ts, p) => {
            tempPath = p;
        });

        await runSession(session);

        assert.deepEqual(incoming, ['lenient.pkt']);
        assert.ok(tempPath, 'file must still be received');
        assert.equal((await fsp.readFile(tempPath)).toString(), body.toString());
        await fsp.unlink(tempPath).catch(() => {});
    });
});

// ── Negotiation ───────────────────────────────────────────────────────────────

describe('BinkpSession — NR negotiation (FTS-1028)', function () {
    this.timeout(10000);

    //  Grab the OPT tokens the session announced.
    function announcedOpts(peer) {
        const frame = peer.framesIn.find(
            f => f.cmd === Commands.M_NUL && f.arg.startsWith('OPT ')
        );
        return frame ? frame.arg.slice(4).split(' ') : [];
    }

    it('does not request NR by default', async () => {
        const { session, peer } = await makeScriptedPair({ opts: [] });
        await runSession(session);

        assert.ok(
            !announcedOpts(peer).includes('NR'),
            'NR costs a round trip per file and the spec says to use it only when necessary'
        );
        assert.equal(session._useNR, false);
    });

    it('requests NR when the node opts in', async () => {
        const { session, peer } = await makeScriptedPair(
            { opts: [] },
            { requestNR: true }
        );
        await runSession(session);

        assert.ok(announcedOpts(peer).includes('NR'));
    });

    it('sends in NR mode when the remote asks, even if we did not', async () => {
        const f = await makeTempFile('MUST-HONOUR');
        const { session, peer } = await makeScriptedPair({ opts: ['NR'] });
        session.queueFile(f.filePath, f.name, f.size, f.timestamp, 'keep');

        await runSession(session);

        //  FTS-1028: "If remote sends the M_NUL 'OPT NR' frame, a mailer
        //  MUST send files in NR mode if it supports this."
        assert.ok(!announcedOpts(peer).includes('NR'), 'we did not ask for NR');
        assert.equal(peer.fileHeaders(f.name)[0].offset, -1, 'but we send in NR mode');
    });

    it('does not enter NR mode when the remote never asks', async () => {
        const f = await makeTempFile('PLAIN-SEND');
        const { session, peer } = await makeScriptedPair({ opts: ['NDA', 'EXTCMD'] });
        session.queueFile(f.filePath, f.name, f.size, f.timestamp, 'keep');

        await runSession(session);

        const headers = peer.fileHeaders(f.name);
        assert.equal(headers.length, 1, 'one M_FILE, no offset round trip');
        assert.equal(headers[0].offset, 0);
    });

    it('is not fooled by a version string that used to trip the NR denylist', async () => {
        //  binkd's own 0.9.x denylist drives the opposite workaround --
        //  forcing NR *on* -- so mirroring it here only broke NR against
        //  peers that had asked for it.
        const f = await makeTempFile('OLD-BINKD');
        const { session, peer } = await makeScriptedPair({ opts: ['NR'] });
        peer.socket.write(
            buildCommandFrame(Commands.M_NUL, 'VER binkd/0.9.4/Linux binkp/1.0')
        );
        session.queueFile(f.filePath, f.name, f.size, f.timestamp, 'keep');

        await runSession(session);

        //  The remote asked for NR, so we owe it NR regardless of what its
        //  VER says; suppressing NR here was never the workaround binkd's
        //  own denylist performs.
        assert.equal(peer.fileHeaders(f.name)[0].offset, -1);
        assert.equal(peer.received.length, 1);
        assert.equal(peer.received[0].data.toString(), 'OLD-BINKD');
    });
});

// ── NR mode with the roles reversed ───────────────────────────────────────────

describe('BinkpSession — NR mode as the answering side', function () {
    this.timeout(10000);

    it('honours an inbound OPT NR when sending', async () => {
        const body = 'ANSWERING-SIDE-NR';
        const f = await makeTempFile(body);

        const { peer } = await runAnswering({ opts: ['NR'] }, {}, session => {
            session.queueFile(f.filePath, f.name, f.size, f.timestamp, 'keep');
        });

        const headers = peer.fileHeaders(f.name);
        assert.equal(headers.length, 2, 'offer plus re-announcement');
        assert.equal(headers[0].offset, -1);
        assert.equal(headers[1].offset, 0);
        assert.equal(peer.received.length, 1);
        assert.equal(peer.received[0].data.toString(), body);
    });

    it('stays out of NR mode when the caller does not ask', async () => {
        const f = await makeTempFile('ANSWERING-PLAIN');

        const { peer } = await runAnswering({ opts: ['NDA'] }, {}, session => {
            session.queueFile(f.filePath, f.name, f.size, f.timestamp, 'keep');
        });

        const headers = peer.fileHeaders(f.name);
        assert.equal(headers.length, 1, 'one M_FILE, no offset round trip');
        assert.equal(headers[0].offset, 0);
        assert.equal(peer.received[0].data.toString(), 'ANSWERING-PLAIN');
    });

    it('receives an NR-mode file and emits incoming-file once', async () => {
        const body = Buffer.from('INBOUND-TO-ANSWERING');
        const incoming = [];
        let tempPath = null;

        await runAnswering(
            {
                opts: ['NR'],
                filesToSend: [
                    {
                        name: 'answered.pkt',
                        size: body.length,
                        timestamp: 1700000000,
                        data: body,
                        nr: true,
                    },
                ],
            },
            {},
            session => {
                session.on('incoming-file', name => incoming.push(name));
                session.on('file-received', (name, size, ts, p) => {
                    tempPath = p;
                });
            }
        );

        assert.deepEqual(incoming, ['answered.pkt']);
        assert.ok(tempPath);
        assert.equal((await fsp.readFile(tempPath)).toString(), body.toString());
        await fsp.unlink(tempPath).catch(() => {});
    });
});

// ── Restarting a transfer already in flight ───────────────────────────────────

describe('BinkpSession — mid-transfer restart', function () {
    this.timeout(20000);

    //  Big enough to span many SEND_CHUNK_SIZE frames and to make the socket
    //  apply back-pressure, so the restart lands while a chunk is parked
    //  waiting on 'drain'.
    const SIZE = 1024 * 1024;
    const RESUME_AT = 512 * 1024;

    function makeBody() {
        const buf = Buffer.allocUnsafe(SIZE);
        for (let i = 0; i < SIZE; ++i) {
            buf[i] = (i * 31) & 0xff;
        }
        return buf;
    }

    it('seeks and re-announces when M_GET arrives mid-flight', async () => {
        const body = makeBody();
        const f = await makeTempFile(body);

        const { session, peer } = await makeScriptedPair({
            opts: ['NR'],
            getAfterBytes: 64 * 1024,
            getAfterOffset: RESUME_AT,
        });
        session.queueFile(f.filePath, f.name, f.size, f.timestamp, 'keep');

        await runSession(session);

        assert.deepEqual(
            peer.fileHeaders(f.name).map(h => h.offset),
            [-1, 0, RESUME_AT],
            'offer, re-announcement, then the seek the remote asked for'
        );
        assert.equal(peer.received.length, 1);
        assert.ok(
            peer.received[0].data.equals(body.slice(RESUME_AT)),
            'only the requested tail is retransmitted, byte for byte'
        );
    });

    it('takes a parked back-pressure handler off the socket when a send is retired', async () => {
        const { session } = await makeScriptedPair({ opts: [] });

        //  Back-pressure is not reachable over loopback: _pumpFile keeps a
        //  single SEND_CHUNK_SIZE frame in flight and that is well under a
        //  socket's write high-water mark, so write() never returns false.
        //  Park the handler the way sendChunk would and check the teardown
        //  clears it, rather than pretending the network can be provoked
        //  into doing it here.
        const handler = () => {};
        const cs = { drainHandler: handler };
        session._socket.once('drain', handler);
        assert.equal(session._socket.listenerCount('drain'), 1);

        session._teardownSendStreams(cs);

        assert.equal(
            session._socket.listenerCount('drain'),
            0,
            'retiring a send must not strand its drain handler on the socket'
        );
        assert.equal(cs.drainHandler, null);
        session._destroy();
    });

    it('transfers a large file over NR without interruption', async () => {
        const body = makeBody();
        const f = await makeTempFile(body);

        const { session, peer } = await makeScriptedPair({ opts: ['NR'] });
        session.queueFile(f.filePath, f.name, f.size, f.timestamp, 'keep');

        await runSession(session);

        assert.equal(peer.received.length, 1);
        assert.ok(peer.received[0].data.equals(body), 'received byte for byte');
    });
});
