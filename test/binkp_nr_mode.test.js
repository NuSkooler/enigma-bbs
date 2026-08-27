'use strict';

const { strict: assert } = require('assert');
const net = require('net');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const { BinkpSession } = require('../core/binkp/session');
const {
    FrameParser,
    buildCommandFrame,
    buildDataFrame,
    EOF_FRAME,
} = require('../core/binkp/frame');
const { Commands } = require('../core/binkp/commands');

const TEMP_DIR = os.tmpdir();

//
//  A scripted answering-side peer that follows FTS-1026/FTS-1028 the way
//  binkd does rather than the way ENiGMA happens to.
//
//  Two of its behaviours are the whole reason this file exists, and neither
//  is reachable with an ENiGMA-to-ENiGMA session pair:
//
//    * after answering an offset request (M_FILE with an offset of -1) with
//      M_GET, it closes its inbound file and waits for a *fresh* M_FILE --
//      binkd's start_file_recv does exactly this (fclose + TF_ZERO) because
//      FTS-1026 makes M_FILE the only thing that opens a file: "Until the
//      next M_FILE command is received, all data frames must carry data
//      from this file";
//
//    * data frames arriving with no file open are discarded in silence --
//      binkd guards its entire data path with `else if (state->in.f)`.
//
//  Together those turn a missing M_FILE re-announcement into a mutual stall
//  that only ends at a session timeout, with no error on the wire. That is
//  issue #724.
//
class ScriptedPeer {
    //  opts:
    //    opts       : string[]  — tokens for the OPT frame we reply with
    //    secure     : boolean   — M_OK argument
    //    dupeNames  : string[]  — answer M_FILE for these with M_GOT (binkd inb_test)
    //    skipNames  : string[]  — answer M_FILE for these with M_SKIP
    //    getOffset  : (name, size) => number — offset to answer an M_FILE "-1" with
    //    onComplete : (peer, file) => 'got'|'get'|'skip'|'none'
    //                             — what to answer a fully received file with
    //    filesToSend: [{ name, size, timestamp, data, nr, reannounce }]
    constructor(socket, opts = {}) {
        this.opts = opts;
        this.socket = socket;
        this.parser = new FrameParser();

        this.received = []; //  { name, size, timestamp, data }
        this.framesIn = []; //  { cmd, arg } received from the session
        this.inFile = null;
        this.state = 'handshake';
        this.remoteEOB = false;
        this.eobSent = false;
        this.sendQueue = (opts.filesToSend || []).slice();
        this.currentSend = null;

        socket.on('error', () => {});
        socket.on('data', chunk => this.parser.push(chunk));
        this.parser.on('frame', frame => this._onFrame(frame));

        this._sendGreeting();
    }

    //  Every M_FILE the session sent us, as { name, size, timestamp, offset }.
    fileHeaders(name) {
        return this.framesIn
            .filter(f => f.cmd === Commands.M_FILE)
            .map(f => {
                const [n, size, timestamp, offset] = f.arg.split(' ');
                return {
                    name: n,
                    size: parseInt(size, 10),
                    timestamp: parseInt(timestamp, 10),
                    offset: parseInt(offset, 10),
                    gz: f.arg.split(' ').slice(4).includes('GZ'),
                };
            })
            .filter(h => undefined === name || h.name === name);
    }

    _send(cmd, arg) {
        if (!this.socket.destroyed) {
            this.socket.write(buildCommandFrame(cmd, arg));
        }
    }

    _sendGreeting() {
        this._send(Commands.M_NUL, 'SYS Scripted Peer');
        this._send(Commands.M_NUL, 'VER binkd/1.1a-115/Linux binkp/1.1');
        this._send(Commands.M_ADR, '1:1/1@testnet');
    }

    //  Originating role: the answering side speaks first, and we answer its
    //  M_ADR with our options and password. binkd does the same.
    _onAdr() {
        if ('originating' !== this.opts.role) {
            return;
        }
        const opts = this.opts.opts || [];
        if (opts.length) {
            this._send(Commands.M_NUL, `OPT ${opts.join(' ')}`);
        }
        this._send(Commands.M_PWD, '-');
    }

    _onOk() {
        this.state = 'transfer';
        this._sendNext();
        this._maybeEob();
    }

    _onFrame(frame) {
        if ('data' === frame.type) {
            return this._onData(frame.data);
        }

        this.framesIn.push({ cmd: frame.cmd, arg: frame.arg });

        switch (frame.cmd) {
            case Commands.M_PWD:
                return this._onPwd();
            case Commands.M_ADR:
                return this._onAdr();
            case Commands.M_OK:
                return this._onOk();
            case Commands.M_FILE:
                return this._onFile(frame.arg);
            case Commands.M_GET:
                return this._onGet(frame.arg);
            case Commands.M_GOT:
                return this._onGot();
            case Commands.M_EOB:
                return this._onEob();
            default:
                return;
        }
    }

    _onPwd() {
        if ('originating' === this.opts.role) {
            return;
        }
        const opts = this.opts.opts || [];
        if (opts.length) {
            this._send(Commands.M_NUL, `OPT ${opts.join(' ')}`);
        }
        this._send(Commands.M_OK, this.opts.secure ? 'secure' : 'non-secure');
        this.state = 'transfer';
        this._sendNext();
    }

    // ── receiving ────────────────────────────────────────────────────────────

    _onFile(arg) {
        const parts = arg.split(' ');
        const [name, sizeStr, tsStr, offsetStr] = parts;
        const size = parseInt(sizeStr, 10);
        const timestamp = parseInt(tsStr, 10);
        const offset = parseInt(offsetStr, 10);
        const gz = parts.slice(4).includes('GZ');

        if ((this.opts.dupeNames || []).includes(name)) {
            //  binkd's inb_test path: acknowledge without ever receiving.
            this.inFile = null;
            return this._send(Commands.M_GOT, `${name} ${size} ${timestamp}`);
        }

        if ((this.opts.skipNames || []).includes(name)) {
            this.inFile = null;
            return this._send(Commands.M_SKIP, `${name} ${size} ${timestamp}`);
        }

        if (-1 === offset) {
            //  Answer the offset request and tear the receive down, exactly
            //  as binkd does. Nothing is received until a fresh M_FILE.
            const at = this.opts.getOffset ? this.opts.getOffset(name, size) : 0;
            this.inFile = null;
            return this._send(Commands.M_GET, `${name} ${size} ${timestamp} ${at}`);
        }

        this.awaitingReannounce = false;
        this.inFile = { name, size, timestamp, offset, gz, chunks: [], bytes: 0 };
    }

    _onData(data) {
        //  No open file: binkd drops the bytes without a word.
        if (!this.inFile) {
            return;
        }

        if (0 === data.length) {
            return this._finishRecv();
        }

        this.inFile.chunks.push(data);
        this.inFile.bytes += data.length;

        //  Interrupt the transfer once we hold |getAfterBytes| and ask for it
        //  again from |getAfterOffset|. The partial is dropped and further
        //  data ignored until a fresh M_FILE arrives -- the same discipline
        //  binkd applies whenever it emits an M_GET.
        if (
            undefined !== this.opts.getAfterBytes &&
            !this.getIssued &&
            this.inFile.bytes >= this.opts.getAfterBytes &&
            this.inFile.bytes < this.inFile.size - this.inFile.offset
        ) {
            this.getIssued = true;
            const f = this.inFile;
            this.awaitingReannounce = true;
            this.inFile = null;
            return this._send(
                Commands.M_GET,
                `${f.name} ${f.size} ${f.timestamp} ${this.opts.getAfterOffset || 0}`
            );
        }

        //  GZ frames carry compressed bytes, so the declared size says
        //  nothing about how many arrive; wait for the EOF frame.
        if (
            !this.inFile.gz &&
            this.inFile.bytes >= this.inFile.size - this.inFile.offset
        ) {
            this._finishRecv();
        }
    }

    _finishRecv() {
        const f = this.inFile;
        if (!f) {
            return;
        }
        this.inFile = null;

        const raw = Buffer.concat(f.chunks);
        const file = {
            name: f.name,
            size: f.size,
            timestamp: f.timestamp,
            offset: f.offset,
            data: f.gz ? zlib.gunzipSync(raw) : raw,
        };
        this.received.push(file);

        const action = this.opts.onComplete ? this.opts.onComplete(this, file) : 'got';

        if ('got' === action) {
            this._send(Commands.M_GOT, `${f.name} ${f.size} ${f.timestamp}`);
        } else if ('get' === action) {
            this._send(Commands.M_GET, `${f.name} ${f.size} ${f.timestamp} 0`);
        } else if ('skip' === action) {
            this._send(Commands.M_SKIP, `${f.name} ${f.size} ${f.timestamp}`);
        }
    }

    _onEob() {
        this.remoteEOB = true;
        this._maybeEob();
        this._maybeClose();
    }

    // ── sending ──────────────────────────────────────────────────────────────

    _sendNext() {
        if ('transfer' !== this.state || this.currentSend) {
            return this._maybeEob();
        }

        const file = this.sendQueue.shift();
        if (!file) {
            return this._maybeEob();
        }

        this.currentSend = file;
        if (file.nr) {
            //  Offer it the NR way and wait for the session's M_GET.
            this._send(Commands.M_FILE, `${file.name} ${file.size} ${file.timestamp} -1`);
            return;
        }
        this._send(Commands.M_FILE, `${file.name} ${file.size} ${file.timestamp} 0`);
        this._pump(0);
    }

    _onGet(arg) {
        const [name, sizeStr, tsStr, offsetStr] = arg.split(' ');
        const cs = this.currentSend;
        if (!cs || cs.name !== name) {
            return;
        }
        const offset = parseInt(offsetStr, 10);
        //  |reannounce| defaults to true — a conforming sender re-announces
        //  before sending. Setting it false models a sender that goes
        //  straight to data, which is what ENiGMA itself used to do.
        if (false !== cs.reannounce) {
            this._send(Commands.M_FILE, `${name} ${sizeStr} ${tsStr} ${offset}`);
        }
        this._pump(offset);
    }

    _pump(offset) {
        const cs = this.currentSend;
        const body = cs.data.slice(offset);
        if (body.length) {
            this.socket.write(buildDataFrame(body));
        }
        this.socket.write(EOF_FRAME);
    }

    _onGot() {
        this.currentSend = null;
        this._sendNext();
    }

    _maybeEob() {
        if (this.eobSent || this.currentSend || this.sendQueue.length) {
            return;
        }
        //  The answering side holds its M_EOB until the caller's arrives;
        //  the originating side leads. Getting this backwards deadlocks the
        //  pair, since ENiGMA's answering side defers in the same way.
        if ('originating' !== this.opts.role && !this.remoteEOB) {
            return;
        }
        this.eobSent = true;
        this._send(Commands.M_EOB, '');
        this._maybeClose();
    }

    //  binkp leaves it to the originating side to hang up.
    _maybeClose() {
        if ('originating' !== this.opts.role) {
            return;
        }
        if (!this.eobSent || !this.remoteEOB || this.inFile || this.currentSend) {
            return;
        }
        setImmediate(() => this.socket.end());
    }
}

//  Stand up a ScriptedPeer on loopback and point an originating BinkpSession
//  at it. Resolves with { session, peer } before the session is started.
function makeScriptedPair(peerOpts = {}, sessionOpts = {}) {
    return new Promise((resolve, reject) => {
        let peer;
        const server = net.createServer(socket => {
            peer = new ScriptedPeer(socket, peerOpts);
        });
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            const socket = net.createConnection(port, '127.0.0.1');
            socket.on('error', reject);
            socket.once('connect', () => {
                server.close();
                const session = new BinkpSession(socket, {
                    role: 'originating',
                    addresses: ['2:2/2@testnet'],
                    systemName: 'Test Client',
                    tempDir: TEMP_DIR,
                    ...sessionOpts,
                });
                resolve({ session, peer });
            });
        });
    });
}

//  The mirror of makeScriptedPair: ENiGMA answers and the scripted peer
//  originates. |onSession| runs before start() so a test can queue outbound
//  files. Resolves once the answering session finishes.
function runAnswering(peerOpts = {}, sessionOpts = {}, onSession = () => {}) {
    return new Promise((resolve, reject) => {
        let peer;
        const server = net.createServer(socket => {
            const session = new BinkpSession(socket, {
                role: 'answering',
                addresses: ['1:1/1@testnet'],
                systemName: 'Test Server',
                tempDir: TEMP_DIR,
                ...sessionOpts,
            });
            const finish = err => {
                server.close();
                return err ? reject(err) : resolve({ session, peer });
            };
            session.on('session-end', () => finish());
            session.on('error', e => finish(e));
            session.on('disconnect', () => finish(new Error('Remote disconnected')));
            onSession(session);
            session.start();
        });
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const socket = net.createConnection(server.address().port, '127.0.0.1');
            socket.on('error', reject);
            socket.once('connect', () => {
                peer = new ScriptedPeer(socket, { role: 'originating', ...peerOpts });
            });
        });
    });
}

//  Run an originating session against a scripted peer to completion.
function runSession(session) {
    return new Promise((resolve, reject) => {
        session.on('session-end', resolve);
        session.on('error', reject);
        session.on('disconnect', () => reject(new Error('Remote disconnected')));
        session.start();
    });
}

async function makeTempFile(content) {
    const filePath = path.join(
        TEMP_DIR,
        `binkp_nr_${Date.now()}_${Math.random().toString(36).slice(2)}.pkt`
    );
    await fsp.writeFile(filePath, content);
    const { size } = await fsp.stat(filePath);
    return {
        filePath,
        size,
        timestamp: Math.floor(Date.now() / 1000),
        name: path.basename(filePath),
    };
}

function exists(filePath) {
    return fsp
        .access(filePath)
        .then(() => true)
        .catch(() => false);
}

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
