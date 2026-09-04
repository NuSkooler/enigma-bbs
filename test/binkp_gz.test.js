'use strict';

const { strict: assert } = require('assert');
const fsp = require('fs/promises');
const zlib = require('zlib');

const { Commands } = require('../core/binkp/commands');
const {
    makeScriptedPair,
    runAnswering,
    runSession,
    makeTempFile,
} = require('./binkp_peer.js');

//  Compresses well, so a GZ transfer is visibly smaller than the source and
//  a container mistake cannot hide behind a payload that barely shrinks.
const COMPRESSIBLE = 'ENiGMA-BinkP-GZ-'.repeat(512);

//  What the session announced in its OPT frame.
function announcedOpts(peer) {
    const frame = peer.framesIn.find(
        f => f.cmd === Commands.M_NUL && f.arg.startsWith('OPT ')
    );
    return frame ? frame.arg.slice(4).split(' ') : [];
}

// ── Container format — issue #723 ─────────────────────────────────────────────

describe('BinkpSession — GZ container format (FTS-1029)', function () {
    this.timeout(10000);

    it('compresses into the zlib container, not gzip', async () => {
        const f = await makeTempFile(COMPRESSIBLE);
        const { session, peer } = await makeScriptedPair({
            opts: ['EXTCMD', 'GZ'],
        });
        session.queueFile(f.filePath, f.name, f.size, f.timestamp, 'keep');

        await runSession(session);

        const got = peer.received[0];
        assert.ok(got.gz, 'the file should have been announced with GZ');

        //  FTS-1029 specifies zlib's compress()/compress2(), i.e. RFC 1950.
        //  binkd decodes with inflateInit() and answers anything else with
        //  Z_DATA_ERROR (-3), which is how #723 surfaced.
        assert.notDeepEqual(
            [got.raw[0], got.raw[1]],
            [0x1f, 0x8b],
            'RFC 1952 (gzip) magic must not appear on the wire'
        );
        assert.equal(got.raw[0] & 0x0f, 8, 'zlib header: deflate method');
        assert.equal(
            ((got.raw[0] << 8) | got.raw[1]) % 31,
            0,
            'zlib header: FCHECK must make the first two bytes divisible by 31'
        );

        assert.equal(got.data.toString(), COMPRESSIBLE, 'round trips intact');
        assert.ok(got.raw.length < f.size, 'and was actually compressed');
    });

    it('leaves already-compressed files alone', async () => {
        //  Arcmail bundles are named for the day of the week; _isCompressed
        //  skips them, so no GZ token and no wasted CPU.
        const f = await makeTempFile(COMPRESSIBLE, '.mo0');
        const { session, peer } = await makeScriptedPair({
            opts: ['EXTCMD', 'GZ'],
        });
        session.queueFile(f.filePath, f.name, f.size, f.timestamp, 'keep');

        await runSession(session);

        assert.equal(peer.received[0].gz, false);
        assert.equal(peer.received[0].data.toString(), COMPRESSIBLE);
    });

    it('does not compress when the remote never offered GZ', async () => {
        const f = await makeTempFile(COMPRESSIBLE);
        const { session, peer } = await makeScriptedPair({ opts: ['EXTCMD'] });
        session.queueFile(f.filePath, f.name, f.size, f.timestamp, 'keep');

        await runSession(session);

        assert.equal(peer.received[0].gz, false);
        assert.equal(peer.received[0].data.toString(), COMPRESSIBLE);
    });
});

// ── Receiving either container ────────────────────────────────────────────────

describe('BinkpSession — GZ inbound compatibility', function () {
    this.timeout(10000);

    async function receiveWith(gzContainer) {
        const body = Buffer.from(COMPRESSIBLE);
        let tempPath = null;
        const { session } = await makeScriptedPair({
            opts: ['EXTCMD', 'GZ'],
            filesToSend: [
                {
                    name: 'inbound.pkt',
                    size: body.length,
                    timestamp: 1700000000,
                    data: body,
                    gzContainer,
                },
            ],
        });
        session.on('file-received', (name, size, ts, p) => {
            tempPath = p;
        });
        await runSession(session);
        assert.ok(tempPath, 'file should have been received');
        const received = await fsp.readFile(tempPath);
        await fsp.unlink(tempPath).catch(() => {});
        return received;
    }

    it('accepts the zlib container a conforming peer sends', async () => {
        assert.equal((await receiveWith('zlib')).toString(), COMPRESSIBLE);
    });

    it('still accepts the gzip container an older ENiGMA sends', async () => {
        //  The GZ option carries no version, so old and new peers cannot tell
        //  each other apart. Sniffing the header on receive is what keeps a
        //  half-upgraded network moving.
        assert.equal((await receiveWith('gzip')).toString(), COMPRESSIBLE);
    });
});

// ── Recovering from a decompression failure ───────────────────────────────────

describe('BinkpSession — undecodable inbound compression', function () {
    this.timeout(10000);

    function corruptSender(extra = {}) {
        const body = Buffer.from(COMPRESSIBLE);
        return {
            opts: ['EXTCMD', 'GZ'],
            filesToSend: [
                {
                    name: 'broken.pkt',
                    size: body.length,
                    timestamp: 1700000000,
                    data: body,
                    gzContainer: 'corrupt',
                },
            ],
            ...extra,
        };
    }

    it('asks for an uncompressed retransmit and recovers the file', async () => {
        let tempPath = null;
        const { session, peer } = await makeScriptedPair(corruptSender());
        session.on('file-received', (name, size, ts, p) => {
            tempPath = p;
        });

        await runSession(session);

        //  FTS-1029 lets a receiver switch compression off mid-session with
        //  an NZ token on M_GET. Without it the batch simply stops: no
        //  M_GOT, and the mail returns on every poll with nothing logged to
        //  say why.
        assert.deepEqual(peer.nzRequests, ['broken.pkt']);
        assert.ok(tempPath, 'the retransmit should have been received');
        assert.equal((await fsp.readFile(tempPath)).toString(), COMPRESSIBLE);
        await fsp.unlink(tempPath).catch(() => {});
    });

    it('skips the file and finishes the batch if the retry fails too', async () => {
        const skipped = [];
        const { session, peer } = await makeScriptedPair(
            corruptSender({ ignoreNZ: true })
        );
        session.on('file-skipped', name => skipped.push(name));

        //  Completing at all is the assertion: giving up has to leave the
        //  session able to finish rather than hanging to its timeout.
        await runSession(session);

        assert.deepEqual(peer.nzRequests, ['broken.pkt'], 'asked exactly once');
        assert.equal(session._currentRecv, null);
    });

    it('leaves no partial behind when it gives up', async () => {
        const { session } = await makeScriptedPair(corruptSender({ ignoreNZ: true }));
        await runSession(session);
        assert.equal(session._inboundTempPaths.size, 0);
    });
});

// ── Honouring an inbound NZ request ───────────────────────────────────────────

describe('BinkpSession — NZ requested by the remote', function () {
    this.timeout(10000);

    it('resends without compression when asked', async () => {
        const f = await makeTempFile(COMPRESSIBLE);

        let asked = false;
        const { session, peer } = await makeScriptedPair({
            opts: ['EXTCMD', 'GZ'],
            onComplete: () => {
                if (!asked) {
                    asked = true;
                    return 'get-nz';
                }
                return 'got';
            },
        });
        session.queueFile(f.filePath, f.name, f.size, f.timestamp, 'keep');

        await runSession(session);

        const headers = peer.fileHeaders(f.name);
        assert.ok(headers[0].gz, 'first attempt was compressed');
        assert.equal(
            headers[headers.length - 1].gz,
            false,
            'the retransmit must drop the GZ token'
        );
        assert.equal(
            peer.received[peer.received.length - 1].data.toString(),
            COMPRESSIBLE
        );
    });

    it('stays off for the rest of the session', async () => {
        const f = await makeTempFile(COMPRESSIBLE);

        let asked = false;
        const { session, peer } = await makeScriptedPair({
            opts: ['EXTCMD', 'GZ'],
            onComplete: () => {
                if (!asked) {
                    asked = true;
                    return 'get-nz';
                }
                return 'got';
            },
        });
        session.queueFile(f.filePath, f.name, f.size, f.timestamp, 'keep');

        await runSession(session);

        //  A peer that could not decompress one file will not manage the
        //  next either, so NZ turns compression off for the session rather
        //  than for the one file. Asserted on the session rather than on a
        //  later file: whatever was already on the wire when the NZ landed
        //  went out compressed, and no amount of correctness changes that.
        assert.ok(asked, 'the peer did send an NZ request');
        assert.equal(session._useGZ, false, 'compression is off for good');
        assert.equal(
            peer.received[peer.received.length - 1].data.toString(),
            COMPRESSIBLE
        );
    });
});

// ── Per-node opt-out ──────────────────────────────────────────────────────────

describe('BinkpSession — GZ opt-out', function () {
    this.timeout(10000);

    it('neither advertises nor uses GZ when switched off', async () => {
        const f = await makeTempFile(COMPRESSIBLE);
        const { session, peer } = await makeScriptedPair(
            { opts: ['EXTCMD', 'GZ'] },
            { gz: false }
        );
        session.queueFile(f.filePath, f.name, f.size, f.timestamp, 'keep');

        await runSession(session);

        assert.ok(!announcedOpts(peer).includes('GZ'), 'GZ must not be offered');
        assert.equal(peer.received[0].gz, false);
        assert.equal(peer.received[0].data.toString(), COMPRESSIBLE);
    });

    it('still decodes a file the remote compresses anyway', async () => {
        //  The GZ token on M_FILE is explicit per file, so honour it rather
        //  than writing compressed bytes straight into the packet. binkd
        //  accepts it unconditionally too.
        const body = Buffer.from(COMPRESSIBLE);
        let tempPath = null;
        const { session } = await makeScriptedPair(
            {
                opts: ['EXTCMD', 'GZ'],
                filesToSend: [
                    {
                        name: 'anyway.pkt',
                        size: body.length,
                        timestamp: 1700000000,
                        data: body,
                        gzContainer: 'zlib',
                    },
                ],
            },
            { gz: false }
        );
        session.on('file-received', (name, size, ts, p) => {
            tempPath = p;
        });

        await runSession(session);

        assert.ok(tempPath);
        assert.equal((await fsp.readFile(tempPath)).toString(), COMPRESSIBLE);
        await fsp.unlink(tempPath).catch(() => {});
    });

    it('resolves the opt-out per node on the answering side', async () => {
        const f = await makeTempFile(COMPRESSIBLE);
        const seen = [];

        const { peer } = await runAnswering(
            { opts: ['EXTCMD', 'GZ'] },
            {
                gz: addrs => {
                    seen.push(...addrs);
                    return false;
                },
            },
            session => {
                session.queueFile(f.filePath, f.name, f.size, f.timestamp, 'keep');
            }
        );

        assert.ok(seen.includes('1:1/1@testnet'), 'predicate sees the remote address');
        assert.equal(peer.received[0].gz, false);
    });
});

// ── Finishing without a terminator frame — issue #745 ─────────────────

//
//  ENiGMA ends every file it sends with a zero-length data frame, and until
//  #745 the GZ receive path treated that frame as the only thing that could
//  finish a file. It is not part of the protocol: FTS-1026 gives the size in
//  M_FILE and binkd's receive loop finishes on that count alone
//  (`ftello(state->in.f) == state->in.size`), never sending a terminator of
//  its own. Both halves of this describe run against |noEofFrame|, so a
//  regression here is the five-minute hang the issue reported.
//
describe('BinkpSession — inbound with no terminator frame', function () {
    this.timeout(10000);

    //  Receive |filesToSend| from a binkd-shaped peer and hand back what
    //  arrived, keyed by name, along with the peer for M_GOT assertions.
    async function receiveFrom(filesToSend, peerOpts = {}, sessionOpts = {}) {
        const paths = [];
        const { session, peer } = await makeScriptedPair(
            {
                opts: ['EXTCMD', 'GZ'],
                noEofFrame: true,
                filesToSend,
                ...peerOpts,
            },
            sessionOpts
        );
        session.on('file-received', (name, size, ts, p) => paths.push({ name, p }));

        await runSession(session);

        const files = {};
        for (const { name, p } of paths) {
            files[name] = await fsp.readFile(p);
            await fsp.unlink(p).catch(() => {});
        }
        return { files, peer };
    }

    function gotNames(peer) {
        return peer.framesIn
            .filter(f => f.cmd === Commands.M_GOT)
            .map(f => f.arg.split(' ')[0]);
    }

    it('finishes a GZ file on the size M_FILE declared', async () => {
        const body = Buffer.from(COMPRESSIBLE);
        const { files, peer } = await receiveFrom([
            {
                name: 'noeof.pkt',
                size: body.length,
                timestamp: 1700000000,
                data: body,
                gzContainer: 'zlib',
            },
        ]);

        assert.equal(files['noeof.pkt'].toString(), COMPRESSIBLE);
        assert.deepEqual(gotNames(peer), ['noeof.pkt']);
    });

    it('still finishes an uncompressed one', async () => {
        const body = Buffer.from(COMPRESSIBLE);
        const { files, peer } = await receiveFrom([
            { name: 'clear.pkt', size: body.length, timestamp: 1700000000, data: body },
        ]);

        assert.equal(files['clear.pkt'].toString(), COMPRESSIBLE);
        assert.deepEqual(gotNames(peer), ['clear.pkt']);
    });

    //
    //  The one that the obvious fix gets wrong. Counting decompressed bytes
    //  is necessary but not sufficient: zlib is asynchronous, so in a
    //  pipelined batch every M_FILE is parsed before a single byte comes
    //  back out of the decompressor. Finishing has to key off the file the
    //  bytes belong to, and a fresh M_FILE has to close the one before it,
    //  or files are quietly dropped while the session still reports success.
    //
    it('keeps every file of a pipelined batch apart', async () => {
        const bodies = {};
        const filesToSend = [0, 1, 2, 3].map(i => {
            const name = `batch${i}.pkt`;
            //  Sizes either side of a frame boundary, and distinct contents
            //  so a mix-up cannot pass as a coincidence.
            const data = Buffer.alloc(1 + i * 30000, 0x41 + i);
            bodies[name] = data;
            return {
                name,
                size: data.length,
                timestamp: 1700000000 + i,
                data,
                gzContainer: 'zlib',
            };
        });

        const { files, peer } = await receiveFrom(filesToSend, { pipeline: true });

        for (const name of Object.keys(bodies)) {
            assert.ok(files[name], `${name} was never received`);
            assert.deepEqual(files[name], bodies[name], `${name} came back wrong`);
        }
        assert.deepEqual(gotNames(peer).sort(), Object.keys(bodies).sort());
    });

    it('does not acknowledge a file that stops short', async () => {
        //  The peer announces more than it sends and then moves on to the
        //  next file. M_GOT would tell it we hold a good copy and let it
        //  apply its disposition, so the truncated one has to go
        //  unacknowledged -- postponed with M_SKIP -- while the batch
        //  carries on and the good file still arrives.
        const good = Buffer.from(COMPRESSIBLE);
        const { files, peer } = await receiveFrom(
            [
                {
                    name: 'short.pkt',
                    size: good.length + 4096,
                    timestamp: 1700000000,
                    data: good,
                    gzContainer: 'zlib',
                },
                {
                    name: 'good.pkt',
                    size: good.length,
                    timestamp: 1700000001,
                    data: good,
                    gzContainer: 'zlib',
                },
            ],
            { pipeline: true }
        );

        assert.deepEqual(gotNames(peer), ['good.pkt'], 'only the whole file');
        assert.equal(files['short.pkt'], undefined, 'the partial is not handed on');
        assert.deepEqual(peer.skipsReceived, ['short.pkt'], 'and is postponed');
        assert.equal(files['good.pkt'].toString(), COMPRESSIBLE);
    });

    it('does not feed a file we refuse into the one before it', async () => {
        //  A pipelining sender has a file's data on the wire behind its
        //  M_FILE, so a duplicate we answer with M_GOT still arrives. The
        //  M_FILE has to end the previous receive on that path too -- it
        //  returns before _beginReceive -- or those bytes are appended to
        //  the previous file's decompressor, one file's contents decoded as
        //  part of another's.
        //
        //  Asserted on where each data frame lands rather than on the bytes
        //  that come out: whether the damage surfaces depends on how zlib
        //  happens to be scheduled, and the size cap hides it whenever the
        //  surplus lands past the declared size. The routing is what is
        //  actually wrong, and it is deterministic.
        const wanted = Buffer.alloc(20000, 0x41);
        const dupe = Buffer.alloc(20000, 0x5a);

        const stray = [];
        const filesToSend = [
            {
                name: 'wanted.pkt',
                size: wanted.length,
                timestamp: 1700000000,
                data: wanted,
                gzContainer: 'zlib',
            },
            {
                name: 'dupe.pkt',
                size: dupe.length,
                timestamp: 1700000001,
                data: dupe,
                gzContainer: 'zlib',
            },
        ];

        const paths = [];
        const { session, peer } = await makeScriptedPair(
            {
                opts: ['EXTCMD', 'GZ'],
                noEofFrame: true,
                pipeline: true,
                filesToSend,
            },
            { hasFile: name => 'dupe.pkt' === name }
        );

        //  Every data frame that reaches an open receive belonging to some
        //  other file is a frame written into the wrong stream.
        let sawDupeHeader = false;
        const onData = session._onDataFrame.bind(session);
        session._onDataFrame = data => {
            const cr = session._currentRecv;
            if (sawDupeHeader && data.length && cr && !cr._finalizing) {
                stray.push(cr.name);
            }
            return onData(data);
        };
        const onFile = session._onFile.bind(session);
        session._onFile = arg => {
            if (arg.startsWith('dupe.pkt ')) {
                sawDupeHeader = true;
            }
            return onFile(arg);
        };

        session.on('file-received', (name, size, ts, p) => paths.push({ name, p }));
        await runSession(session);

        const files = {};
        for (const { name, p } of paths) {
            files[name] = await fsp.readFile(p);
            await fsp.unlink(p).catch(() => {});
        }

        assert.deepEqual(stray, [], "the dupe's frames went into an open receive");
        assert.ok(files['wanted.pkt'], 'the file we wanted was never received');
        assert.deepEqual(files['wanted.pkt'], wanted, 'and must not carry the dupe');
        assert.equal(files['dupe.pkt'], undefined, 'the dupe is not handed on');
        //  Both are acknowledged: the dupe because we already hold it.
        assert.deepEqual(
            peer.framesIn
                .filter(f => f.cmd === Commands.M_GOT)
                .map(f => f.arg.split(' ')[0])
                .sort(),
            ['dupe.pkt', 'wanted.pkt']
        );
    });

    it('tearing one receive down does not cancel the next', async () => {
        //  Ending a receive is asynchronous for a compressed file, so the
        //  teardown lands after the batch has already opened the file behind
        //  it. _abandonReceive used to clear _currentRecv unconditionally,
        //  cancelling that one -- every frame still arriving for it was then
        //  discarded and the batch hung.
        //
        //  Whether any frames are actually stranded depends on how the
        //  sender's writes happen to be split, so the assertion is on the
        //  invariant rather than on the fallout: tearing down one file may
        //  never cancel a different one.
        const short = Buffer.alloc(20000, 0x41);
        const rest = Buffer.alloc(256 * 1024, 0x42);

        const stolen = [];
        const filesToSend = [
            {
                name: 'short.pkt',
                size: short.length + 4096, //  more than it will send
                timestamp: 1700000000,
                data: short,
                gzContainer: 'zlib',
            },
            {
                name: 'rest.pkt',
                size: rest.length,
                timestamp: 1700000001,
                data: rest,
                gzContainer: 'zlib',
            },
        ];

        const paths = [];
        const { session, peer } = await makeScriptedPair({
            opts: ['EXTCMD', 'GZ'],
            noEofFrame: true,
            pipeline: true,
            filesToSend,
        });

        const abandon = session._abandonReceive.bind(session);
        session._abandonReceive = cr => {
            const before = session._currentRecv;
            abandon(cr);
            if (before && before !== cr && null === session._currentRecv) {
                stolen.push({ dropped: cr.name, cancelled: before.name });
            }
        };

        session.on('file-received', (name, size, ts, p) => paths.push({ name, p }));
        await runSession(session);

        const files = {};
        for (const { name, p } of paths) {
            files[name] = await fsp.readFile(p);
            await fsp.unlink(p).catch(() => {});
        }

        assert.deepEqual(stolen, [], 'a teardown cancelled an unrelated receive');
        assert.ok(files['rest.pkt'], 'the file behind it was never received');
        assert.equal(files['rest.pkt'].length, rest.length);
        assert.equal(files['short.pkt'], undefined, 'the short one is not handed on');
        assert.deepEqual(
            peer.framesIn
                .filter(f => f.cmd === Commands.M_GOT)
                .map(f => f.arg.split(' ')[0]),
            ['rest.pkt']
        );
    });

    it('still asks for a clear retransmit once the batch has moved on', async () => {
        //  Decompression fails asynchronously, so by the time it does the
        //  sender is already several files further along. Answering only for
        //  the file that happens to be current drops this one on the floor:
        //  no M_GET, no M_SKIP, and a sender left waiting on an M_GOT that is
        //  never coming. FTS-1029's NZ recovery has to work here too.
        const bad = Buffer.alloc(20000, 0x41);
        const good = Buffer.alloc(20000, 0x42);

        const { files, peer } = await receiveFrom(
            [
                {
                    name: 'bad.pkt',
                    size: bad.length,
                    timestamp: 1700000000,
                    data: bad,
                    gzContainer: 'corrupt',
                },
                {
                    name: 'good.pkt',
                    size: good.length,
                    timestamp: 1700000001,
                    data: good,
                    gzContainer: 'zlib',
                },
            ],
            { pipeline: true }
        );

        const nz = peer.framesIn.filter(
            f => f.cmd === Commands.M_GET && f.arg.endsWith(' NZ')
        );
        assert.equal(nz.length, 1, 'the uncompressed retransmit was never asked for');
        assert.ok(nz[0].arg.startsWith('bad.pkt '), 'and must name the file that failed');

        //  The retransmit arrives in the clear, so both files land.
        assert.deepEqual(files['bad.pkt'], bad, 'the retransmit was not recovered');
        assert.deepEqual(files['good.pkt'], good);
    });

    it('cuts a file that runs past its announced size back to it', async () => {
        //  The clear path caps every chunk against the declared size, but a
        //  compressed one cannot be measured until it is decompressed, so
        //  the surplus reaches the disk before anyone can object. Both paths
        //  have to hand on the file the sender described, no more.
        const body = Buffer.from(COMPRESSIBLE);
        const declared = body.length - 100;
        const { files, peer } = await receiveFrom([
            {
                name: 'over.pkt',
                size: declared,
                timestamp: 1700000000,
                data: body,
                gzContainer: 'zlib',
            },
        ]);

        assert.deepEqual(gotNames(peer), ['over.pkt']);
        assert.equal(files['over.pkt'].length, declared, 'trimmed to the declared size');
        assert.deepEqual(files['over.pkt'], body.slice(0, declared));
    });
});

// ── Sanity: the fixture really is asymmetric ──────────────────────────────────

describe('zlib containers are not interchangeable', () => {
    it('inflate rejects a gzip stream, which is what #723 hit', () => {
        assert.throws(
            () => zlib.inflateSync(zlib.gzipSync(Buffer.from('hello'))),
            /incorrect header check/
        );
    });
});
