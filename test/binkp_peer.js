'use strict';

//
//  Shared BinkP test peer.
//
//  Not a test file (the mocha glob is *.test.js) — a scripted peer that
//  follows FTS-1026/1028/1029 the way binkd does rather than the way ENiGMA
//  happens to. ENiGMA-to-ENiGMA sessions agree with themselves by
//  construction, which is exactly how the defects in #723 and #724 stayed
//  invisible to the suite; driving one side from here does not let them.
//

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
        this.nzRequestedFor = null;
        //  binkd counts every command frame, sent and received, since the
        //  batch began, and only closes after one that carried nothing but
        //  the two M_EOBs (protocol.c:3275-3293).
        this.msgsInBatch = 0;
        this.batches = []; //  message count of each completed batch
        this.batchClosed = false;
        this.closed = false;
        this.nzRequests = []; //  files we were asked to resend in the clear
        this.skipsReceived = [];

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
        if ('transfer' === this.state) {
            ++this.msgsInBatch;
        }
        if (!this.socket.destroyed) {
            this.socket.write(buildCommandFrame(cmd, arg));
        }
    }

    _sendGreeting() {
        this._send(Commands.M_NUL, 'SYS Scripted Peer');
        //  |noVer| models a peer that never identifies its protocol version,
        //  which has to be read conservatively rather than assumed to be 1.1.
        if (!this.opts.noVer) {
            this._send(
                Commands.M_NUL,
                `VER binkd/1.1a-115/Linux binkp/${this.opts.protocolVer || '1.1'}`
            );
        }
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
        if ('transfer' === this.state) {
            ++this.msgsInBatch;
        }

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
            case Commands.M_SKIP:
                return this._onSkip(frame.arg);
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
            //  inflateSync, not gunzipSync: binkd calls inflateInit(), so
            //  only the RFC 1950 container decodes. A gzip header arrives
            //  here as the Z_DATA_ERROR that issue #723 was reported as.
            data: f.gz ? zlib.inflateSync(raw) : raw,
            //  Untouched wire bytes, so a test can look at the container
            //  rather than trusting that decoding happened to work.
            raw,
            gz: f.gz,
        };
        this.received.push(file);

        const action = this.opts.onComplete ? this.opts.onComplete(this, file) : 'got';

        if ('got' === action) {
            this._send(Commands.M_GOT, `${f.name} ${f.size} ${f.timestamp}`);
        } else if ('get' === action) {
            this._send(Commands.M_GET, `${f.name} ${f.size} ${f.timestamp} 0`);
        } else if ('get-nz' === action) {
            //  FTS-1029: ask for it again with compression switched off.
            this._send(Commands.M_GET, `${f.name} ${f.size} ${f.timestamp} 0 NZ`);
        } else if ('skip' === action) {
            this._send(Commands.M_SKIP, `${f.name} ${f.size} ${f.timestamp}`);
        }
    }

    _onEob() {
        this.remoteEOB = true;
        this._maybeEob();
        this._endOfBatch();
    }

    //  Both M_EOBs are in and nothing is in flight. binkd starts another
    //  batch unless this one was empty; |singleBatch| models a binkp/1.0
    //  peer, which always stops here.
    _endOfBatch() {
        //  Reached from both _onEob and _maybeEob, which can fire in the same
        //  tick when the two M_EOBs cross; count the batch once.
        if (this.batchClosed) {
            return;
        }
        if (!this.eobSent || !this.remoteEOB || this.currentSend || this.inFile) {
            return;
        }
        this.batchClosed = true;
        this.batches.push(this.msgsInBatch);
        if (this.msgsInBatch > 2 && !this.opts.singleBatch) {
            this.msgsInBatch = 0;
            this.eobSent = false;
            this.remoteEOB = false;
            this.batchClosed = false;
            this._sendNext();
            return;
        }
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
            this._sendFileHeader(file, -1, this._encode(file, 0).gz);
            return;
        }
        const { body, gz } = this._encode(file, 0);
        this._sendFileHeader(file, 0, gz);
        this._pump(body);
    }

    _sendFileHeader(file, offset, gz) {
        this._send(
            Commands.M_FILE,
            `${file.name} ${file.size} ${file.timestamp} ${offset}${gz ? ' GZ' : ''}`
        );
    }

    //  How a file goes on the wire. |gzContainer| lets a test model a
    //  conforming peer ('zlib', what FTS-1029 and binkd use), a pre-fix
    //  ENiGMA ('gzip'), or one whose output cannot be decoded at all
    //  ('corrupt'). An NZ request drops compression for that file.
    _encode(file, offset) {
        const raw = file.data.slice(offset);
        if (
            !file.gzContainer ||
            (this.nzRequestedFor === file.name && !this.opts.ignoreNZ)
        ) {
            return { body: raw, gz: false };
        }
        if ('gzip' === file.gzContainer) {
            return { body: zlib.gzipSync(raw), gz: true };
        }
        if ('corrupt' === file.gzContainer) {
            return { body: Buffer.from('this is not compressed at all'), gz: true };
        }
        return { body: zlib.deflateSync(raw), gz: true };
    }

    _onGet(arg) {
        const parts = arg.split(' ');
        const [name, , , offsetStr] = parts;
        const cs = this.currentSend;
        if (!cs || cs.name !== name) {
            return;
        }
        //  FTS-1029: NZ asks us to drop compression and send it again.
        if (parts.slice(4).includes('NZ')) {
            this.nzRequestedFor = name;
            this.nzRequests.push(name);
        }
        const offset = parseInt(offsetStr, 10);
        const { body, gz } = this._encode(cs, offset);
        //  |reannounce| defaults to true — a conforming sender re-announces
        //  before sending. Setting it false models a sender that goes
        //  straight to data, which is what ENiGMA itself used to do.
        if (false !== cs.reannounce) {
            this._sendFileHeader(cs, offset, gz);
        }
        this._pump(body);
    }

    _pump(body) {
        //  Frames cap at 0x7fff; chunk so a large body cannot overflow one.
        for (let i = 0; i < body.length; i += 0x4000) {
            this.socket.write(buildDataFrame(body.slice(i, i + 0x4000)));
        }
        this.socket.write(EOF_FRAME);
    }

    _onGot() {
        this.currentSend = null;
        this._sendNext();
    }

    //  FTS-1026 non-destructive skip: the receiver is postponing the file,
    //  so drop it and carry on with the batch rather than waiting forever.
    _onSkip(arg) {
        const [name] = arg.split(' ');
        this.skipsReceived.push(name);
        if (this.currentSend && this.currentSend.name === name) {
            this.currentSend = null;
        }
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
        this._endOfBatch();
    }

    //  binkp leaves it to the originating side to hang up.
    _maybeClose() {
        if ('originating' !== this.opts.role || this.closed) {
            return;
        }
        this.closed = true;
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

async function makeTempFile(content, suffix = '.pkt') {
    const filePath = path.join(
        TEMP_DIR,
        `binkp_nr_${Date.now()}_${Math.random().toString(36).slice(2)}${suffix}`
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

module.exports = {
    ScriptedPeer,
    makeScriptedPair,
    runAnswering,
    runSession,
    makeTempFile,
    exists,
    TEMP_DIR,
};
