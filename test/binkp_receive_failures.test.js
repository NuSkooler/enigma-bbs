'use strict';

const { strict: assert } = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { Commands } = require('../core/binkp/commands');
const { FreqResolver, attachFreqToSession } = require('../core/binkp/freq');
const { makeScriptedPair, runAnswering, runSession, exists } = require('./binkp_peer.js');

//
//  Issue #1090: an inbound file whose write fails, or a FREQ .req receive
//  that does not complete, left the session in the wrong state.
//
//  A failed write must be postponed with M_SKIP -- never acknowledged, never
//  handed on -- and must settle so the batch can close. Every M_EOB hold the
//  FREQ handler takes for a .req must be given back however that receive
//  ends. The failures here are hangs, so the deadlines are short.
//
const DEADLINE_MS = 3000;

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

function diskFull() {
    return Object.assign(new Error('ENOSPC: no space left on device, write'), {
        code: 'ENOSPC',
    });
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

function namesFor(frames, cmd) {
    return frames.filter(f => f.cmd === cmd).map(f => f.arg.split(' ')[0]);
}

//
//  Inbound write streams for files under |dir| that put their first 16K on
//  disk and fail from there on, the way a disk filling up mid-file does.
//  |paths| collects each temp path so a test can check that the partial
//  file is gone afterwards.
//
const WRITES_BEFORE_FULL = 0x4000;
function failWritesUnder(dir) {
    const real = fs.createWriteStream;
    const paths = [];
    fs.createWriteStream = function (p, ...rest) {
        const ws = real.call(fs, p, ...rest);
        if (typeof p !== 'string' || path.dirname(p) !== dir) {
            return ws;
        }
        paths.push(p);
        const write = ws._write.bind(ws);
        let room = WRITES_BEFORE_FULL;
        const limited = (chunk, cb) => {
            if (0 === room) {
                return cb(diskFull());
            }
            const part = chunk.slice(0, room);
            room -= part.length;
            write(part, null, err =>
                cb(err || (part.length < chunk.length ? diskFull() : null))
            );
        };
        ws._write = (chunk, enc, cb) => limited(chunk, cb);
        ws._writev = (chunks, cb) => limited(Buffer.concat(chunks.map(c => c.chunk)), cb);
        return ws;
    };
    return { paths, restore: () => (fs.createWriteStream = real) };
}

//  The same, but every write fails, including the first.
function failAllWritesUnder(dir) {
    const real = fs.createWriteStream;
    const paths = [];
    fs.createWriteStream = function (p, ...rest) {
        const ws = real.call(fs, p, ...rest);
        if (typeof p !== 'string' || path.dirname(p) !== dir) {
            return ws;
        }
        paths.push(p);
        ws._write = (chunk, enc, cb) => cb(diskFull());
        ws._writev = (chunks, cb) => cb(diskFull());
        return ws;
    };
    return { paths, restore: () => (fs.createWriteStream = real) };
}

// ── Cases 1-3: a failed write is postponed, not acknowledged ─────────────────

describe('BinkpSession — inbound write failures (#1090)', function () {
    this.timeout(DEADLINE_MS + 5000);

    let tmp;
    let restore;
    beforeEach(async () => {
        tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'binkp_1090_'));
        restore = null;
    });
    afterEach(async () => {
        if (restore) {
            restore();
        }
        await fsp.rm(tmp, { recursive: true, force: true });
    });

    //  Receive |files| from a scripted peer into |tmp|, and say what the
    //  session sent and handed on.
    async function receive(files, peerOpts = {}) {
        const { session, peer } = await makeScriptedPair(
            { filesToSend: files, ...peerOpts },
            { tempDir: tmp }
        );
        const sent = tapSent(session);
        const handedOn = [];
        const abandoned = [];
        session.on('file-received', (name, size, ts, p) => handedOn.push({ name, p }));
        session.on('file-abandoned', name => abandoned.push(name));
        await withDeadline(runSession(session), 'session');
        return { session, peer, sent, handedOn, abandoned };
    }

    const BIG = Buffer.alloc(3 * 0x4000 + 123, 'x');
    const GOOD = Buffer.from('a packet that writes fine');

    it('postpones a clear file whose write fails, and carries on', async () => {
        const failing = failWritesUnder(tmp);
        restore = failing.restore;

        const { sent, handedOn, abandoned, peer } = await receive([
            { name: 'full.pkt', size: BIG.length, timestamp: 1700000000, data: BIG },
        ]);
        restore();
        restore = null;

        assert.deepEqual(namesFor(sent, Commands.M_SKIP), ['full.pkt'], 'M_SKIP');
        assert.deepEqual(namesFor(sent, Commands.M_GOT), [], 'never M_GOT');
        assert.deepEqual(handedOn, [], 'not handed on');
        assert.deepEqual(abandoned, ['full.pkt'], "'file-abandoned' once");
        assert.deepEqual(peer.skipsReceived, ['full.pkt']);
        assert.equal(failing.paths.length, 1);
        assert.equal(await exists(failing.paths[0]), false, 'partial temp file removed');
    });

    it('postpones a clear file whose flush fails at the end', async () => {
        //  Small enough for one write, which fails: the error reaches the
        //  callback given to end() as well as the 'error' event.
        const failing = failAllWritesUnder(tmp);
        restore = failing.restore;

        const { sent, handedOn } = await receive([
            { name: 'small.pkt', size: GOOD.length, timestamp: 1700000000, data: GOOD },
        ]);

        assert.deepEqual(namesFor(sent, Commands.M_SKIP), ['small.pkt']);
        assert.deepEqual(namesFor(sent, Commands.M_GOT), []);
        assert.deepEqual(handedOn, []);
        assert.equal(await exists(failing.paths[0]), false, 'temp file removed');
    });

    it('postpones a compressed file whose write fails, and the session ends', async () => {
        const failing = failWritesUnder(tmp);
        restore = failing.restore;

        const body = Buffer.from(
            Array.from({ length: 4000 }, (_, i) => `line ${i}\n`).join('')
        );
        const { sent, handedOn } = await receive(
            [
                {
                    name: 'packed.pkt',
                    size: body.length,
                    timestamp: 1700000000,
                    data: body,
                    gzContainer: 'zlib',
                },
            ],
            { opts: ['EXTCMD', 'GZ'] }
        );

        assert.deepEqual(namesFor(sent, Commands.M_SKIP), ['packed.pkt'], 'M_SKIP');
        assert.deepEqual(namesFor(sent, Commands.M_GOT), [], 'never M_GOT');
        assert.deepEqual(handedOn, []);
        assert.equal(await exists(failing.paths[0]), false, 'partial temp file removed');
    });

    it('postpones a zero-byte file whose write fails, and the session ends', async () => {
        const real = fsp.writeFile;
        fsp.writeFile = (p, ...rest) =>
            typeof p === 'string' && path.dirname(p) === tmp
                ? Promise.reject(diskFull())
                : real.call(fsp, p, ...rest);
        restore = () => (fsp.writeFile = real);

        const { sent, handedOn, peer } = await receive([
            { name: 'empty.pkt', size: 0, timestamp: 1700000000, data: Buffer.alloc(0) },
            { name: 'good.pkt', size: GOOD.length, timestamp: 1700000001, data: GOOD },
        ]);

        assert.deepEqual(namesFor(sent, Commands.M_SKIP), ['empty.pkt'], 'M_SKIP');
        assert.deepEqual(namesFor(sent, Commands.M_GOT), ['good.pkt']);
        assert.deepEqual(
            handedOn.map(h => h.name),
            ['good.pkt']
        );
        assert.deepEqual(peer.skipsReceived, ['empty.pkt']);
        for (const h of handedOn) {
            await fsp.unlink(h.p).catch(() => {});
        }
    });

    it('a file after a failed one is still received', async () => {
        //  Only the first stream fails; the second file must arrive intact,
        //  so the postpone did not take the batch down with it.
        const real = fs.createWriteStream;
        let calls = 0;
        fs.createWriteStream = function (p, ...rest) {
            const ws = real.call(fs, p, ...rest);
            if (path.dirname(p) === tmp && 0 === calls++) {
                ws._write = (chunk, enc, cb) => cb(diskFull());
                ws._writev = (chunks, cb) => cb(diskFull());
            }
            return ws;
        };
        restore = () => (fs.createWriteStream = real);

        const { sent, handedOn } = await receive([
            { name: 'first.pkt', size: BIG.length, timestamp: 1700000000, data: BIG },
            { name: 'second.pkt', size: GOOD.length, timestamp: 1700000001, data: GOOD },
        ]);

        assert.deepEqual(namesFor(sent, Commands.M_SKIP), ['first.pkt']);
        assert.deepEqual(namesFor(sent, Commands.M_GOT), ['second.pkt']);
        assert.equal(handedOn.length, 1);
        assert.equal((await fsp.readFile(handedOn[0].p)).toString(), GOOD.toString());
    });
});

// ── Case 5: a zero-byte write landing after teardown ─────────────────────────

describe('BinkpSession — zero-byte write after teardown (#1090)', function () {
    this.timeout(DEADLINE_MS + 5000);

    let tmp;
    let realWriteFile;
    beforeEach(async () => {
        tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'binkp_1090_'));
        realWriteFile = fsp.writeFile;
    });
    afterEach(async () => {
        fsp.writeFile = realWriteFile;
        await fsp.rm(tmp, { recursive: true, force: true });
    });

    it('leaves no empty temp file behind', async () => {
        let release;
        const gate = new Promise(resolve => (release = resolve));
        let tempPath = null;
        let started;
        const writeStarted = new Promise(resolve => (started = resolve));
        let written;
        const writeDone = new Promise(resolve => (written = resolve));

        //  Hold the write until the session has been torn down.
        fsp.writeFile = (p, ...rest) => {
            if (typeof p !== 'string' || path.dirname(p) !== tmp) {
                return realWriteFile.call(fsp, p, ...rest);
            }
            tempPath = p;
            started();
            return gate
                .then(() => realWriteFile.call(fsp, p, ...rest))
                .finally(() => written());
        };

        const { session } = await makeScriptedPair(
            {
                filesToSend: [
                    {
                        name: 'empty.pkt',
                        size: 0,
                        timestamp: 1700000000,
                        data: Buffer.alloc(0),
                    },
                ],
            },
            { tempDir: tmp }
        );
        const handedOn = [];
        session.on('file-received', name => handedOn.push(name));
        session.on('error', () => {});
        session.on('disconnect', () => {});
        session.start();

        await withDeadline(writeStarted, 'zero-byte write');
        session._destroy();
        //  Let _destroy's unlink run first: the file does not exist yet.
        await new Promise(resolve => setTimeout(resolve, 50));
        release();
        await writeDone;
        await new Promise(resolve => setTimeout(resolve, 50));

        assert.deepEqual(handedOn, [], 'not handed on after teardown');
        assert.equal(await exists(tempPath), false, 'no empty temp file left');
    });
});

// ── Case 4: every FREQ hold is given back ────────────────────────────────────

describe('FREQ — M_EOB holds for a .req that does not complete (#1090)', function () {
    this.timeout(DEADLINE_MS + 5000);

    let tmp;
    let served;
    beforeEach(async () => {
        tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'binkp_1090_'));
        served = path.join(tmp, 'NODELIST.365');
        await fsp.writeFile(served, 'nodelist for FREQ');
    });
    afterEach(async () => {
        await fsp.rm(tmp, { recursive: true, force: true });
    });

    const REQ = Buffer.from('NODELIST\r\n');

    //  ENiGMA answers with FREQ attached; the scripted peer calls in and
    //  sends |files|. Resolves once the answering session ends.
    async function answerFreq(files, peerOpts = {}) {
        let sent;
        let session;
        const result = runAnswering(
            { filesToSend: files, ...peerOpts },
            { tempDir: tmp },
            s => {
                session = s;
                sent = tapSent(s);
                attachFreqToSession(s, new FreqResolver({ magic: { NODELIST: served } }));
                s.on('file-received', (name, size, ts, p) => {
                    setImmediate(() => fsp.unlink(p).catch(() => {}));
                });
            }
        );
        const { peer } = await withDeadline(result, 'answering session');
        return { session, peer, sent };
    }

    it('releases the hold of a .req that ended short, then serves it on re-announce', async () => {
        const { session, peer, sent } = await answerFreq([
            //  Announced longer than what is sent, then sent again whole.
            {
                name: '00010001.req',
                size: REQ.length + 10,
                timestamp: 1700000000,
                data: REQ,
            },
            { name: '00010001.req', size: REQ.length, timestamp: 1700000001, data: REQ },
        ]);

        assert.deepEqual(namesFor(sent, Commands.M_SKIP), ['00010001.req']);
        assert.deepEqual(namesFor(sent, Commands.M_GOT), ['00010001.req']);
        assert.ok(namesFor(sent, Commands.M_EOB).length >= 1, 'M_EOB was sent');
        assert.equal(session._eobHold, 0, 'no hold left');
        assert.deepEqual(
            peer.received.map(f => f.name),
            ['NODELIST.365'],
            'the request was served'
        );
    });

    it('releases the hold of a .req that ended short and never came back', async () => {
        const { session, sent } = await answerFreq([
            {
                name: '00010001.req',
                size: REQ.length + 10,
                timestamp: 1700000000,
                data: REQ,
            },
        ]);

        assert.deepEqual(namesFor(sent, Commands.M_SKIP), ['00010001.req']);
        assert.ok(namesFor(sent, Commands.M_EOB).length >= 1, 'M_EOB was sent');
        assert.equal(session._eobHold, 0);
    });

    it('takes no extra hold for a .req announced again after an NZ request', async () => {
        const { session, peer, sent } = await answerFreq(
            [
                {
                    name: '00010001.req',
                    size: REQ.length,
                    timestamp: 1700000000,
                    data: REQ,
                    gzContainer: 'corrupt',
                },
            ],
            { opts: ['EXTCMD', 'GZ'] }
        );

        assert.deepEqual(peer.nzRequests, ['00010001.req'], 'NZ asked for');
        assert.deepEqual(namesFor(sent, Commands.M_GOT), ['00010001.req']);
        assert.ok(namesFor(sent, Commands.M_EOB).length >= 1, 'M_EOB was sent');
        assert.equal(session._eobHold, 0);
        assert.deepEqual(
            peer.received.map(f => f.name),
            ['NODELIST.365'],
            'the request was served'
        );
    });

    it('releases the hold of a .req whose write fails', async () => {
        const real = fs.createWriteStream;
        fs.createWriteStream = function (p, ...rest) {
            const ws = real.call(fs, p, ...rest);
            if (typeof p === 'string' && path.dirname(p) === tmp) {
                ws._write = (chunk, enc, cb) => cb(diskFull());
                ws._writev = (chunks, cb) => cb(diskFull());
            }
            return ws;
        };
        try {
            const { session, sent } = await answerFreq([
                {
                    name: '00010001.req',
                    size: REQ.length,
                    timestamp: 1700000000,
                    data: REQ,
                },
            ]);
            assert.deepEqual(namesFor(sent, Commands.M_SKIP), ['00010001.req']);
            assert.deepEqual(namesFor(sent, Commands.M_GOT), []);
            assert.ok(namesFor(sent, Commands.M_EOB).length >= 1, 'M_EOB was sent');
            assert.equal(session._eobHold, 0);
        } finally {
            fs.createWriteStream = real;
        }
    });

    it('a .req received whole is still served (control)', async () => {
        const { session, peer, sent } = await answerFreq([
            { name: '00010001.req', size: REQ.length, timestamp: 1700000000, data: REQ },
        ]);
        assert.deepEqual(namesFor(sent, Commands.M_GOT), ['00010001.req']);
        assert.equal(session._eobHold, 0);
        assert.deepEqual(
            peer.received.map(f => f.name),
            ['NODELIST.365']
        );
    });

    it("gives back a .req's hold when the session is torn down mid-receive", async () => {
        const { BinkpSession } = require('../core/binkp/session');
        const net = require('net');
        const { ScriptedPeer } = require('./binkp_peer.js');

        //  A .req announced but never finished: the peer stops sending after
        //  the first chunk, and the session is torn down.
        const big = Buffer.alloc(0x6000, 'N');
        await new Promise((resolve, reject) => {
            const server = net.createServer(socket => {
                server.close();
                const session = new BinkpSession(socket, {
                    role: 'answering',
                    addresses: ['1:1/1@testnet'],
                    systemName: 'Test Server',
                    tempDir: tmp,
                });
                attachFreqToSession(session, new FreqResolver({}));
                session.on('error', () => {});
                session.on('disconnect', () => {});
                session.on('incoming-file', () => {
                    assert.equal(session._eobHold, 1, 'hold taken');
                    setTimeout(() => {
                        session._destroy();
                        try {
                            assert.equal(session._eobHold, 0, 'hold given back');
                            resolve();
                        } catch (e) {
                            reject(e);
                        }
                    }, 20);
                });
                session.start();
            });
            server.listen(0, '127.0.0.1', () => {
                const socket = net.createConnection(server.address().port, '127.0.0.1');
                socket.on('error', () => {});
                socket.once('connect', () => {
                    const peer = new ScriptedPeer(socket, {
                        role: 'originating',
                        noEofFrame: true,
                        filesToSend: [
                            {
                                name: '00010001.req',
                                size: big.length * 2,
                                timestamp: 1700000000,
                                data: big,
                            },
                        ],
                    });
                    peer.socket.on('close', () => {});
                });
            });
        });
    });
});
