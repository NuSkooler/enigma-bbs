'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const { FrameParser, buildCommandFrame, buildDataFrame, EOF_FRAME } = require('./frame');
const { Commands, CommandNames, Opts } = require('./commands');
const { generateChallenge, computeResponse, verifyResponse } = require('./cram');
const Log = require('../logger').log;

const BINKP_VER = '1.1';
const SEND_CHUNK_SIZE = 4096;
const SESSION_TIMEOUT_MS = 300_000; // 5 min

//  Runaway guard only, not part of the protocol. A batch carrying nothing but
//  the two M_EOBs always ends the session, so this can only be reached by a
//  peer that keeps talking; better to hang up than to loop forever.
const MAX_BATCHES = 16;

// Extensions that are already compressed — don't waste CPU trying to GZ them.
// Arcmail day-of-week bundles (*.mo0, *.tu1, etc.) are also pre-compressed.
const ALREADY_COMPRESSED_RE = /\.(zip|arc|arj|lzh|lha|gz|bz2|zst|pk[34]|zoo)$/i;
const ARCMAIL_RE = /\.(su|mo|tu|we|th|fr|sa)[0-9a-z]$/i;

function _isCompressed(filename) {
    return ALREADY_COMPRESSED_RE.test(filename) || ARCMAIL_RE.test(filename);
}

//
//  BinkpSession — implements BinkP 1.1 as both answering and originating node.
//
//  opts:
//    role         : 'answering' | 'originating'
//    addresses    : string[]   — our 5D FTN addresses ('zone:net/node@domain')
//    systemName   : string
//    sysopName    : string
//    location     : string
//    mailerVer    : string     — e.g. 'ENiGMA/0.4.0'
//    getPassword  : (remoteAddrs: string[]) => string|null
//                             — called once remote addresses are known
//    sendIfPwd    : boolean    — refuse to send files on non-secure sessions
//    tempDir      : string     — directory for inbound temp files
//    hasFile      : (name, size, timestamp) => boolean
//                             — return true to skip (M_GOT) a duplicate inbound file
//
//  Events emitted:
//    'addresses'      (addrs: string[])                — remote's M_ADR received
//    'authenticated'  (isSecure: boolean)              — auth complete
//    'incoming-file'  (name, size, timestamp)          — inbound transfer started (M_FILE received)
//    'file-received'  (name, size, timestamp, tempPath) — inbound file ready
//    'file-sent'      (name, size, timestamp)          — outbound file acknowledged
//    'file-skipped'   (name, size, timestamp)          — remote sent M_SKIP
//    'busy'           (reason: string)                 — remote sent M_BSY
//    'session-end'    ()                               — clean finish
//    'disconnect'     ()                               — socket closed mid-session
//    'error'          (err)                            — fatal error
//
//  API:
//    queueFile(filePath, name, size, timestamp, disposition)
//      disposition: 'delete' | 'truncate' | 'keep'
//    start()
//
class BinkpSession extends EventEmitter {
    constructor(socket, opts) {
        super();
        this._socket = socket;
        this._opts = opts;

        this._parser = new FrameParser();
        this._state = 'handshake'; // 'handshake' | 'transfer' | 'done'
        this._authState = 'P_NULL'; // 'P_NULL' | 'P_SECURE' | 'P_NONSECURE'

        // Handshake tracking
        this._cramChallenge = null; // hex: challenge we issued (answering)
        this._remoteCramChallenge = null; // hex: challenge from answering side
        this._gotRemoteADR = false;
        this._sentPwd = false;
        this._remoteAddresses = [];
        this._remoteOpts = new Set();

        // Negotiated capabilities
        this._useNR = false;
        this._useND = false;
        this._useGZ = false;
        this._useEXTCMD = false;

        // Transfer state
        this._sendQueue = []; // { name, path, size, timestamp, disposition }
        this._currentSend = null; // { name, path, size, timestamp, disposition, offset, nrPending, readStream }
        this._currentRecv = null; // { name, size, timestamp, tempPath, bytesReceived, writeStream }
        //  Set when we have answered an NR-mode M_FILE (offset -1) with
        //  M_GET and are waiting for the sender to re-announce the file.
        this._pendingOffsetReq = null; // { name, size, timestamp, useGZ }
        this._pendingGots = new Map(); // `name\0size\0ts` → { name, path, size, timestamp, disposition }
        //  Disposition side effects -- the unlink or truncate of a file the
        //  remote has acknowledged -- still in flight. The session is not done
        //  until these land: 'session-end' is what callers act on, and what
        //  the process may exit after. A sent packet still on disk is picked
        //  up by the next outbound scan and delivered a second time.
        this._pendingDispositions = new Set();
        //  Files we have already asked to have resent uncompressed, so a
        //  second failure falls through to M_SKIP instead of looping.
        this._nzRequested = new Set();

        //  Inbound temp files we own. Added when we start writing one and
        //  removed on successful M_GOT — anything left here at _destroy()
        //  time is a partial that the peer dropped on us.
        this._inboundTempPaths = new Set();

        this._localEOBSent = false;
        this._localEOB = false;
        this._remoteEOB = false;

        //  binkp/1.1 batches. |_batchMsgCount| counts command frames both
        //  sent and received since the batch began, which is what decides
        //  whether another one follows -- see _onBatchComplete.
        this._batchMsgCount = 0;
        this._batchesDone = 0;
        this._remoteVer = null; // { major, minor } from the remote's VER

        this._sendHeld = false;
        this._timeoutHandle = null;
        this._batchEndPending = false;
        this._waitingForClose = false;
        this._eobHold = 0; // >0 means an async handler (e.g. FREQ) needs more time before M_EOB

        // Pause the socket so no data is consumed until start() is called.
        // This prevents frame processing before the application has finished
        // setting up event listeners and queuing initial files.
        socket.pause();
        socket.on('data', chunk => this._parser.push(chunk));
        socket.on('error', err => this._onSocketError(err));
        socket.on('close', () => this._onSocketClose());
        this._parser.on('frame', frame => this._onFrame(frame));
    }

    queueFile(filePath, name, size, timestamp, disposition) {
        this._sendQueue.push({ path: filePath, name, size, timestamp, disposition });
    }

    // Pause outbound file sending until releaseSend() is called.
    // Use this on answering sessions when you need to load outbound files
    // asynchronously after receiving the remote's M_ADR.
    holdSend() {
        this._sendHeld = true;
    }

    releaseSend() {
        if (!this._sendHeld) return;
        this._sendHeld = false;
        if (this._state === 'transfer' && !this._currentSend && !this._localEOBSent) {
            setImmediate(() => this._sendNext());
        }
    }

    start() {
        this._socket.resume();
        this._resetTimeout();
        if (this._opts.role === 'answering') {
            this._sendAnsweringBanner();
        } else {
            this._sendOriginatingBanner();
        }
    }

    // ── Banner / handshake ──────────────────────────────────────────────────

    _sendAnsweringBanner() {
        // CRAM challenge MUST be the very first frame sent by the answering side
        this._cramChallenge = generateChallenge().toString('hex');
        this._sendCmd(Commands.M_NUL, `OPT CRAM-MD5-${this._cramChallenge}`);
        this._sendInfoFrames();
    }

    _sendOriginatingBanner() {
        this._sendInfoFrames();
        // M_PWD is deferred until we receive M_ADR from the answering side
    }

    _sendInfoFrames() {
        const {
            systemName = 'ENiGMA BBS',
            sysopName = 'SysOp',
            location = 'Unknown',
            mailerVer = 'ENiGMA/0.4.0',
            addresses = [],
        } = this._opts;

        this._sendCmd(Commands.M_NUL, `SYS ${systemName}`);
        this._sendCmd(Commands.M_NUL, `ZYZ ${sysopName}`);
        this._sendCmd(Commands.M_NUL, `LOC ${location}`);
        this._sendCmd(Commands.M_NUL, `NDL 115200,TCP,BINKP`);
        this._sendCmd(Commands.M_NUL, `TIME ${new Date().toUTCString()}`);
        this._sendCmd(Commands.M_NUL, `VER ${mailerVer} binkp/${BINKP_VER}`);
        this._sendCmd(Commands.M_ADR, addresses.join(' '));
    }

    _sendPwd() {
        if (this._sentPwd) return;
        this._sentPwd = true;

        const caps = [Opts.NDA, Opts.EXTCMD];
        if (this._gzAllowed()) {
            caps.splice(1, 0, Opts.GZ);
        }
        //  NR is a request that the *remote* send to us in NR mode, not an
        //  advert that we understand it (FTS-1028). It costs a round trip
        //  per file and the spec is explicit that it "degrades performance
        //  over regular quality connections and it should be used only if
        //  absolutely necessary", so it stays off unless a node opts in.
        //  Answering an inbound OPT NR is unconditional -- see _onPwd.
        if (this._wantNR()) {
            caps.unshift(Opts.NR);
        }
        this._sendCmd(Commands.M_NUL, `OPT ${caps.join(' ')}`);

        const password = this._lookupPassword();

        if (this._remoteCramChallenge && password) {
            const response = computeResponse(password, this._remoteCramChallenge);
            this._sendCmd(Commands.M_PWD, `CRAM-MD5-${response}`);
        } else {
            this._sendCmd(Commands.M_PWD, password || '-');
        }
    }

    //  Should we ask the remote to send to us in NR mode? |requestNR| is a
    //  boolean or a predicate over the remote's addresses, so the answering
    //  side can decide per node once M_ADR has arrived.
    _wantNR() {
        const requestNR = this._opts.requestNR;
        if (typeof requestNR === 'function') {
            return true === requestNR(this._remoteAddresses);
        }
        return true === requestNR;
    }

    //  May we compress for this peer? |gz| is a boolean or a predicate over
    //  the remote's addresses; absent means yes. Switching it off for a node
    //  neither advertises GZ nor compresses to it — an escape hatch for a
    //  peer whose decompressor we cannot fix.
    _gzAllowed() {
        const gz = this._opts.gz;
        if (undefined === gz || null === gz) {
            return true;
        }
        if (typeof gz === 'function') {
            return false !== gz(this._remoteAddresses);
        }
        return false !== gz;
    }

    _lookupPassword() {
        if (typeof this._opts.getPassword === 'function') {
            return this._opts.getPassword(this._remoteAddresses);
        }
        return this._opts.password || null;
    }

    // ── Frame dispatch ──────────────────────────────────────────────────────

    _onFrame(frame) {
        this._resetTimeout();

        if (frame.type === 'data') {
            return this._onDataFrame(frame.data);
        }

        const { cmd, arg } = frame;

        if (this._state === 'handshake') {
            this._onHandshakeCommand(cmd, arg);
        } else if (this._state === 'transfer') {
            ++this._batchMsgCount;
            this._onTransferCommand(cmd, arg);
        }
    }

    _onHandshakeCommand(cmd, arg) {
        switch (cmd) {
            case Commands.M_NUL:
                return this._onNul(arg);
            case Commands.M_ADR:
                return this._onAdr(arg);
            case Commands.M_PWD:
                return this._onPwd(arg);
            case Commands.M_OK:
                return this._onOk(arg);
            case Commands.M_ERR:
                return this._onRemoteErr(arg);
            case Commands.M_BSY:
                return this._onBsy(arg);
            default:
                Log.debug(
                    { cmd: CommandNames[cmd] || cmd },
                    '[BinkP] Unexpected command during handshake'
                );
        }
    }

    _onTransferCommand(cmd, arg) {
        switch (cmd) {
            case Commands.M_NUL:
                return; // informational only in transfer phase
            case Commands.M_FILE:
                return this._onFile(arg);
            case Commands.M_GOT:
                return this._onGot(arg);
            case Commands.M_GET:
                return this._onGet(arg);
            case Commands.M_EOB:
                return this._onEob();
            case Commands.M_SKIP:
                return this._onSkip(arg);
            case Commands.M_ERR:
                return this._onRemoteErr(arg);
            case Commands.M_BSY:
                return this._onBsy(arg);
            default:
                Log.debug(
                    { cmd: CommandNames[cmd] || cmd },
                    '[BinkP] Unexpected command during transfer'
                );
        }
    }

    // ── Handshake command handlers ──────────────────────────────────────────

    _onNul(arg) {
        const spaceIdx = arg.indexOf(' ');
        const keyword = spaceIdx < 0 ? arg : arg.slice(0, spaceIdx);
        const value = spaceIdx < 0 ? '' : arg.slice(spaceIdx + 1);

        if (keyword !== 'OPT') {
            if ('VER' === keyword) {
                //  e.g. "binkd/1.1a-115/Linux binkp/1.1"
                const m = /binkp\/(\d+)\.(\d+)/i.exec(value);
                if (m) {
                    this._remoteVer = {
                        major: parseInt(m[1], 10),
                        minor: parseInt(m[2], 10),
                    };
                }
            }
            return;
        }

        for (const token of value.split(/\s+/)) {
            if (token.startsWith('CRAM-MD5-')) {
                // Only valid as the very first frame from the answering side.
                // We gate on !_gotRemoteADR: if we've already seen M_ADR, the CRAM
                // window has closed and we must fall back to plaintext.
                if (this._opts.role === 'originating' && !this._gotRemoteADR) {
                    this._remoteCramChallenge = token.slice('CRAM-MD5-'.length);
                }
            } else {
                this._remoteOpts.add(token);
            }
        }
    }

    _onAdr(arg) {
        this._remoteAddresses = arg.split(/\s+/).filter(Boolean);
        this._gotRemoteADR = true;
        this.emit('addresses', this._remoteAddresses);

        if (this._opts.role === 'originating' && !this._sentPwd) {
            this._sendPwd();
        }
    }

    _onPwd(arg) {
        if (this._opts.role !== 'answering') {
            Log.warn('[BinkP] Received M_PWD as originating side — ignoring');
            return;
        }

        const password = this._lookupPassword();
        let isSecure = false;

        if (arg.startsWith('CRAM-MD5-') && this._cramChallenge && password) {
            isSecure = verifyResponse(
                password,
                this._cramChallenge,
                arg.slice('CRAM-MD5-'.length)
            );
        } else if (password) {
            isSecure = arg === password;
        }
        // If no password configured: non-secure (not an error)

        this._authState = isSecure ? 'P_SECURE' : 'P_NONSECURE';

        const confirmedOpts = [];
        //  FTS-1028: "If remote sends the M_NUL \"OPT NR\" frame, a mailer
        //  MUST send files in NR mode if it supports this." The frame is a
        //  request that *we* send in NR mode -- not a capability advert --
        //  so echoing it back is both the acknowledgement and our own
        //  request, and is only correct when we actually want NR inbound.
        if (this._remoteOpts.has(Opts.NR)) {
            this._useNR = true;
        }
        if (this._wantNR()) {
            confirmedOpts.push(Opts.NR);
        }
        // Prefer NDA (asymmetric) over ND; either means we wait for M_GOT before disposing
        if (this._remoteOpts.has(Opts.NDA)) {
            confirmedOpts.push(Opts.NDA);
            this._useND = true;
        } else if (this._remoteOpts.has(Opts.ND)) {
            confirmedOpts.push(Opts.ND);
            this._useND = true;
        }
        // GZ requires EXTCMD — only enable both together
        if (this._remoteOpts.has(Opts.EXTCMD)) {
            confirmedOpts.push(Opts.EXTCMD);
            this._useEXTCMD = true;
            if (this._remoteOpts.has(Opts.GZ) && this._gzAllowed()) {
                confirmedOpts.push(Opts.GZ);
                this._useGZ = true;
            }
        }

        if (confirmedOpts.length > 0) {
            this._sendCmd(Commands.M_NUL, `OPT ${confirmedOpts.join(' ')}`);
        }

        this._sendCmd(Commands.M_OK, isSecure ? 'secure' : 'non-secure');
        this.emit('authenticated', isSecure);
        this._enterTransfer();
    }

    _onOk(arg) {
        const isSecure = arg.trim() === 'secure';
        this._authState = isSecure ? 'P_SECURE' : 'P_NONSECURE';

        // Answering side confirms opts in M_NUL before M_OK; pick up what they confirmed
        if (this._remoteOpts.has(Opts.NR)) {
            this._useNR = true;
        }
        if (this._remoteOpts.has(Opts.NDA) || this._remoteOpts.has(Opts.ND)) {
            this._useND = true;
        }
        if (this._remoteOpts.has(Opts.EXTCMD)) {
            this._useEXTCMD = true;
            if (this._remoteOpts.has(Opts.GZ) && this._gzAllowed()) {
                this._useGZ = true;
            }
        }

        this.emit('authenticated', isSecure);
        this._enterTransfer();
    }

    _onRemoteErr(arg) {
        Log.warn({ reason: arg }, '[BinkP] Remote sent M_ERR');
        this.emit('error', new Error(`Remote error: ${arg}`));
        this._destroy();
    }

    _onBsy(arg) {
        Log.info({ reason: arg }, '[BinkP] Remote busy');
        this.emit('busy', arg);
        this._destroy();
    }

    // ── Transfer phase ──────────────────────────────────────────────────────

    _enterTransfer() {
        this._state = 'transfer';
        if (!this._sendHeld) {
            setImmediate(() => this._sendNext());
        }
    }

    _sendNext() {
        if (this._state !== 'transfer' || this._currentSend) return;

        if (this._localEOBSent) {
            //  M_EOB is already out, so nothing further will be offered this
            //  batch — but state can still settle after it (a late M_GOT
            //  clearing the last pending file, or an M_SKIP dropping the
            //  send in flight). Re-test for completion instead of just
            //  returning, or the batch reaches a finished state with nobody
            //  left to notice and the session hangs to its timeout.
            this._checkDone();
            return;
        }

        const canSend = !this._opts.sendIfPwd || this._authState === 'P_SECURE';

        if (!canSend || this._sendQueue.length === 0) {
            //  An async handler (e.g. FREQ resolver) holds M_EOB while it
            //  resolves files. Don't send M_EOB until the hold is released.
            if (this._eobHold > 0) return;
            //  Answering side defers M_EOB until the remote has sent its M_EOB.
            //  This gives async handlers time to process inbound files (e.g.
            //  .req FREQ requests) and queue responses before M_EOB goes out.
            //  _onEob will call _sendNext() again once _remoteEOB becomes true.
            if (this._opts.role === 'answering' && !this._remoteEOB) return;
            this._localEOBSent = true;
            this._localEOB = true;
            this._sendCmd(Commands.M_EOB, '');
            this._checkDone();
            return;
        }

        const file = this._sendQueue.shift();
        // GZ only when both sides negotiated EXTCMD+GZ and the file isn't
        // already compressed (arcmail bundles, zips, etc.)
        const useGZ = this._useGZ && this._useEXTCMD && !_isCompressed(file.name);
        this._currentSend = {
            ...file,
            offset: 0,
            nrPending: this._useNR,
            useGZ,
            readStream: null,
        };

        //  NR mode: offer the file with an offset of -1 and let the remote
        //  name the offset it wants (FTS-1028 sec. 2). _onGet resumes from there.
        this._sendFileHeader(this._useNR ? -1 : 0);

        if (!this._useNR) {
            this._pumpFile();
        }
        // else: wait for M_GET from remote before pumping
    }

    //
    //  Emit M_FILE for the current send at |offset|.
    //
    //  M_FILE is the only thing that opens a file on the receiving side --
    //  FTS-1026: "Until the next M_FILE command is received, all data frames
    //  must carry data from this file" -- and a receiver that has answered
    //  with M_GET has already torn its inbound state down (binkd closes the
    //  file and zeroes its receive struct the moment it sends M_GET). So
    //  every start *or restart* of a transfer must be preceded by a fresh
    //  M_FILE, which FTS-1026 spells out under M_GET: "proceed with
    //  transmission of the file requested starting with an appropriate
    //  M_FILE".
    //
    _sendFileHeader(offset) {
        const cs = this._currentSend;
        if (!cs) return;
        // Append GZ token only when EXTCMD is active — old implementations
        // without EXTCMD concatenate extra tokens into the filename.
        const gzToken = cs.useGZ ? ' GZ' : '';
        this._sendCmd(
            Commands.M_FILE,
            `${cs.name} ${cs.size} ${cs.timestamp} ${offset}${gzToken}`
        );
    }

    //  Tear down whatever is feeding an in-flight send. Safe when nothing is
    //  in flight: an NR-mode send sits with a null readStream while it waits
    //  for M_GET. Listeners come off first so a destroy can't re-enter
    //  _sendNext through the 'error'/'end' handlers _pumpFile installed.
    _teardownSendStreams(cs) {
        if (!cs) return;
        if (cs.drainHandler) {
            this._socket.removeListener('drain', cs.drainHandler);
            cs.drainHandler = null;
        }
        for (const key of ['deflateStream', 'readStream']) {
            const stream = cs[key];
            if (!stream) continue;
            stream.removeAllListeners();
            stream.on('error', () => {});
            stream.destroy();
            cs[key] = null;
        }
    }

    _pumpFile() {
        const cs = this._currentSend;
        if (!cs || this._state !== 'transfer') return;

        const rs = fs.createReadStream(cs.path, {
            start: cs.offset,
            highWaterMark: SEND_CHUNK_SIZE,
        });
        cs.readStream = rs;

        const onSendError = err => {
            Log.warn(
                { name: cs.name, error: err.message },
                '[BinkP] Error reading outbound file'
            );
            this._sendCmd(Commands.M_SKIP, `${cs.name} ${cs.size} ${cs.timestamp}`);
            this._currentSend = null;
            setImmediate(() => this._sendNext());
        };

        const onAllDataSent = () => {
            cs.drainHandler = null;
            this._socket.write(EOF_FRAME);
            const key = `${cs.name}\0${cs.size}\0${cs.timestamp}`;
            this._pendingGots.set(key, {
                name: cs.name,
                path: cs.path,
                size: cs.size,
                timestamp: cs.timestamp,
                disposition: cs.disposition,
            });
            this._currentSend = null;
            setImmediate(() => this._sendNext());
        };

        const sendChunk = (source, chunk) => {
            source.pause();
            const ok = this._socket.write(buildDataFrame(chunk));
            if (ok) {
                source.resume();
                return;
            }
            //  Backpressure: wait for the socket to drain before reading on.
            //  The handler is parked on |cs| so _teardownSendStreams can take
            //  it off again — an M_GET or M_SKIP can retire this send while a
            //  chunk is still waiting, and a stale listener would otherwise
            //  sit on the socket resuming a stream nobody is reading.
            const onDrain = () => {
                cs.drainHandler = null;
                source.resume();
            };
            cs.drainHandler = onDrain;
            this._socket.once('drain', onDrain);
        };

        if (!cs.useGZ) {
            rs.on('data', chunk => sendChunk(rs, chunk));
            rs.on('end', onAllDataSent);
            rs.on('error', onSendError);
            return;
        }

        //  GZ path: drive the compressor explicitly rather than via pipe,
        //  keeping the same pause/resume back-pressure pattern on the output.
        //
        //  createDeflate, not createGzip: FTS-1029 specifies zlib's own
        //  compress()/compress2(), i.e. the RFC 1950 container -- two header
        //  bytes and an Adler-32 tail. gzip (RFC 1952) wraps the same deflate
        //  payload in a different header, and a decoder expecting one rejects
        //  the other outright. binkd calls deflateInit()/inflateInit(), which
        //  is RFC 1950, and answers a gzip header with Z_DATA_ERROR (-3).
        const gz = zlib.createDeflate();
        cs.deflateStream = gz; // stored so _destroy can clean it up

        gz.on('data', chunk => sendChunk(gz, chunk));
        gz.on('end', onAllDataSent);
        gz.on('error', onSendError);

        rs.on('data', chunk => {
            rs.pause();
            const ok = gz.write(chunk);
            if (ok) {
                rs.resume();
            } else {
                gz.once('drain', () => rs.resume());
            }
        });
        rs.on('end', () => gz.end());
        rs.on('error', onSendError);
    }

    //
    //  M_GET: the remote wants us to (re)start a file at a given offset. In
    //  NR mode this is the answer to the -1 we offered; outside it, it is a
    //  resume request for a partial the remote already holds.
    //
    _onGet(arg) {
        const parts = arg.split(' ');
        if (parts.length < 4) {
            Log.warn({ arg }, '[BinkP] Malformed M_GET');
            return;
        }

        const [name, sizeStr, tsStr, offsetStr] = parts;
        const offset = parseInt(offsetStr, 10);
        if (!Number.isFinite(offset) || offset < 0) {
            Log.warn({ arg }, '[BinkP] M_GET with an unusable offset');
            return;
        }

        //  FTS-1029: an NZ token on M_GET asks us to switch compression off
        //  and resend. Treat it as final for the session rather than for the
        //  one file — a peer that could not decompress this will not manage
        //  the next one either.
        if (this._useEXTCMD && parts.slice(4).includes('NZ')) {
            if (this._useGZ) {
                Log.info({ name }, '[BinkP] Remote asked for uncompressed transfer (NZ)');
            }
            this._useGZ = false;
            if (this._currentSend) {
                this._currentSend.useGZ = false;
            }
        }

        if (this._currentSend && this._currentSend.name === name) {
            return this._restartSend(offset);
        }

        //  FTS-1026 also requires us to recognise an M_GET naming "a file
        //  that have been transmitted, but we are still waiting an M_GOT
        //  acknowledge for it" -- the race the spec calls out, where we
        //  finish a file and move on to the next before its M_GET lands.
        //  Dropping it strands the remote until a session timeout.
        const key = `${name}\0${sizeStr}\0${tsStr}`;
        const pending = this._pendingGots.get(key);
        if (!pending) {
            Log.warn({ name }, '[BinkP] M_GET for unknown or inactive file');
            return;
        }

        this._pendingGots.delete(key);

        //  Anything in flight goes back to the head of the queue so it is
        //  re-offered once the re-requested file has been dealt with.
        if (this._currentSend) {
            const displaced = this._currentSend;
            this._teardownSendStreams(displaced);
            this._sendQueue.unshift({
                path: displaced.path,
                name: displaced.name,
                size: displaced.size,
                timestamp: displaced.timestamp,
                disposition: displaced.disposition,
            });
        }

        this._currentSend = {
            ...pending,
            offset: 0,
            nrPending: false,
            useGZ: this._useGZ && this._useEXTCMD && !_isCompressed(pending.name),
            readStream: null,
        };
        this._restartSend(offset);
    }

    //  Seek the current send to |offset| and (re)start it, announcing the
    //  new position with an M_FILE first -- see _sendFileHeader.
    _restartSend(offset) {
        const cs = this._currentSend;
        if (!cs) return;

        this._teardownSendStreams(cs);

        if (offset > cs.size) {
            //  Past EOF. binkd answers this with M_ERR and drops the
            //  session; clamping costs nothing, keeps the batch alive and
            //  still leaves the file with us until the remote acknowledges.
            Log.warn(
                { name: cs.name, offset, size: cs.size },
                '[BinkP] M_GET offset past end of file; clamping'
            );
            offset = cs.size;
        }

        cs.offset = offset;
        cs.nrPending = false;
        this._sendFileHeader(offset);
        this._pumpFile();
    }

    _onGot(arg) {
        const parts = arg.split(' ');
        if (parts.length < 3) return;
        const [name, sizeStr, tsStr] = parts;
        const key = `${name}\0${sizeStr}\0${tsStr}`;

        const pending = this._pendingGots.get(key);
        if (pending) {
            this._pendingGots.delete(key);
            this._applyDisposition(pending);
            this.emit('file-sent', name, parseInt(sizeStr), parseInt(tsStr));
            this._checkDone();
            return;
        }

        // Destructive skip: remote M_GOT'd a file we haven't finished sending yet
        const queueIdx = this._sendQueue.findIndex(
            f =>
                f.name === name &&
                String(f.size) === sizeStr &&
                String(f.timestamp) === tsStr
        );
        if (queueIdx >= 0) {
            const [skipped] = this._sendQueue.splice(queueIdx, 1);
            this._applyDisposition(skipped);
            Log.debug({ name }, '[BinkP] Destructive skip via M_GOT (queued file)');
            this._checkDone();
            return;
        }

        if (
            this._currentSend &&
            this._currentSend.name === name &&
            String(this._currentSend.size) === sizeStr
        ) {
            Log.debug({ name }, '[BinkP] Destructive skip via M_GOT (active send)');
            this._teardownSendStreams(this._currentSend);
            this._applyDisposition(this._currentSend);
            this._currentSend = null;
            setImmediate(() => this._sendNext());
        }
    }

    _applyDisposition(file) {
        let work;
        if (file.disposition === 'delete') {
            work = fsp
                .unlink(file.path)
                .catch(err =>
                    Log.warn(
                        { path: file.path, error: err.message },
                        '[BinkP] Could not delete sent file'
                    )
                );
        } else if (file.disposition === 'truncate') {
            work = fsp
                .truncate(file.path, 0)
                .catch(err =>
                    Log.warn(
                        { path: file.path, error: err.message },
                        '[BinkP] Could not truncate sent file'
                    )
                );
        }

        //  Not awaited here -- the protocol must keep moving -- but tracked so
        //  the session can settle it before ending. Already .catch()'d above,
        //  so it always resolves and can never wedge _finishSession().
        if (work) {
            this._pendingDispositions.add(work);
            work.finally(() => this._pendingDispositions.delete(work));
        }
    }

    _onFile(arg) {
        const parts = arg.split(' ');
        if (parts.length < 4) {
            Log.warn({ arg }, '[BinkP] Malformed M_FILE');
            return;
        }

        //  Remote started a new batch after we both exchanged M_EOB.
        //  Reset our EOB state and re-enter the send loop so we'll send
        //  our own M_EOB for this batch (even if we have nothing to send).
        if (this._localEOB && this._remoteEOB) {
            this._localEOB = false;
            this._localEOBSent = false;
            this._remoteEOB = false;
            this._waitingForClose = false;
            setImmediate(() => this._sendNext());
        }

        //  Any M_FILE supersedes an outstanding offset request, whether it
        //  is the re-announcement we asked for or the sender moving on.
        this._pendingOffsetReq = null;

        const [name, sizeStr, tsStr, offsetStr] = parts;
        const size = parseInt(sizeStr, 10);
        const timestamp = parseInt(tsStr, 10);
        const offset = parseInt(offsetStr, 10);

        // Extra tokens (e.g. GZ) are only valid when EXTCMD was negotiated —
        // without it, old implementations concatenate them into the filename.
        //  The token is explicit per file, so honour it whenever extended
        //  commands are in play and let the container sniffing sort the rest
        //  out. binkd does the same. The EXTCMD gate stays because without
        //  it an old implementation folds extra tokens into the filename.
        const useGZ = this._useEXTCMD && parts.slice(4).includes('GZ');

        // Duplicate detection
        if (
            typeof this._opts.hasFile === 'function' &&
            this._opts.hasFile(name, size, timestamp)
        ) {
            this._sendCmd(Commands.M_GOT, `${name} ${size} ${timestamp}`);
            return;
        }

        //  NR mode: the sender offered -1 and wants us to name the offset
        //  (FTS-1028 sec. 2). Answer with M_GET and stop here — nothing is
        //  being received yet. The transfer only begins when the sender
        //  re-announces the file with an M_FILE carrying the real offset,
        //  which FTS-1026 requires of it under M_GET. Building the receive
        //  now would build it twice and fire 'incoming-file' twice with it.
        if (offset === -1) {
            // :TODO: check for existing partial file and respond with its size
            this._pendingOffsetReq = { name, size, timestamp, useGZ };
            this._sendCmd(Commands.M_GET, `${name} ${size} ${timestamp} 0`);
            return;
        }

        this._beginReceive({ name, size, timestamp, useGZ });
    }

    //
    //  Set up inbound state for one file and tell listeners about it.
    //
    //  'incoming-file' must fire exactly once per received file: the FREQ
    //  handler pairs it with holdEOB() and releases on 'file-received', so a
    //  second emit for the same file pins the hold above zero and the batch
    //  never sends M_EOB.
    //
    _beginReceive({ name, size, timestamp, useGZ }) {
        this._pendingOffsetReq = null;
        this._closeOutstandingReceive();

        const tempPath = path.join(
            this._opts.tempDir || os.tmpdir(),
            `binkp_in_${Date.now()}_${Math.random().toString(36).slice(2)}.dt`
        );

        this._currentRecv = {
            name,
            size,
            timestamp,
            tempPath,
            bytesReceived: 0,
            useGZ,
            writeStream: null,
            // GZ: collect raw compressed wire-bytes; decompress all at once on EOF
            compressedChunks: useGZ ? [] : null,
        };

        //  Notify listeners that an inbound transfer is starting. The FREQ
        //  handler uses this to call holdEOB() before the async file write
        //  completes — earlier than the 'file-received' event.
        this.emit('incoming-file', name, size, timestamp);
    }

    //
    //  FTS-1026: "Until the next M_FILE command is received, all data frames
    //  must carry data from this file". So an M_FILE -- or an M_EOB -- is the
    //  sender telling us the previous file is over, whether or not it also
    //  sent a zero-length data frame. binkd never sends one.
    //
    _closeOutstandingReceive() {
        const cr = this._currentRecv;
        if (!cr || cr._finalizing) return;
        if (cr.inflate) {
            //  Decompression is async, so the byte count is not final yet;
            //  ending the inflate stream settles it and finish() checks.
            return this._finalizeReceive(cr);
        }
        if (cr.bytesReceived >= cr.size) {
            return this._finalizeReceive(cr);
        }
        this._abandonShortReceive(cr);
    }

    //
    //  A file the sender walked away from mid-transfer. Silence would strand
    //  it: the sender is waiting on an M_GOT that is never coming and will
    //  sit there to its own timeout. M_SKIP is the FTS-1026 answer -- a
    //  non-destructive postpone that leaves the file with the sender for
    //  another session and lets this batch finish -- and is what
    //  _onInflateError already does when it gives up on a file.
    //
    _abandonShortReceive(cr) {
        Log.warn(
            { name: cr.name, got: cr.bytesReceived, want: cr.size },
            '[BinkP] Inbound file ended short; leaving it with the sender'
        );
        this._abandonReceive(cr);
        this._sendCmd(Commands.M_SKIP, `${cr.name} ${cr.size} ${cr.timestamp}`);
        this._checkDone();
    }

    _onDataFrame(data) {
        //  A sender that answers our M_GET with data but no fresh M_FILE is
        //  not following FTS-1026, but the bytes are on the wire and
        //  discarding them would hang the batch. Adopt the outstanding
        //  offset request as the active receive instead.
        if (!this._currentRecv && this._pendingOffsetReq) {
            this._beginReceive(this._pendingOffsetReq);
        }

        const cr = this._currentRecv;

        if (!cr) {
            // Zero-length frame with no active receive can happen if sender
            // is in NR mode and we already sent M_GOT for this file
            return;
        }

        if (data.length === 0) {
            // EOF frame
            this._finalizeReceive();
            return;
        }

        if (!cr.writeStream) {
            cr.writeStream = fs.createWriteStream(cr.tempPath);
            //  We're going to destroy this stream from _destroy() on
            //  abnormal session end, which can race with in-flight writes
            //  and surface as an async ERR_STREAM_DESTROYED. The unlink
            //  in _destroy supersedes any half-written data anyway, so
            //  swallow the error here rather than letting it bubble to
            //  uncaughtException.
            cr.writeStream.on('error', err => {
                Log.warn(
                    { name: cr.name, error: err.message },
                    '[BinkP] Inbound write error'
                );
            });

            if (cr.useGZ) {
                //  createUnzip rather than createInflate: it sniffs the
                //  header and takes either container. Correct senders use
                //  RFC 1950, but ENiGMA itself sent RFC 1952 until this was
                //  fixed, and the GZ option carries no version to tell them
                //  apart -- so accepting both is what keeps a mixed-version
                //  network working while operators upgrade.
                cr.inflate = zlib.createUnzip();
                cr.inflate.on('error', err => this._onInflateError(cr, err));
                cr.inflate.pipe(cr.writeStream);

                //  Count what comes *out* of the decompressor, so the GZ path
                //  finishes on the declared size the same way the clear one
                //  does. |cr| is captured rather than read back off the
                //  session: zlib is async, so by the time these land the
                //  batch may already have moved on to another file.
                cr.inflate.on('data', chunk => {
                    cr.bytesReceived += chunk.length;
                    if (cr.bytesReceived >= cr.size) {
                        this._finalizeReceive(cr);
                    }
                });
            }

            this._inboundTempPaths.add(cr.tempPath);
        }

        if (cr.useGZ) {
            //  GZ: the wire carries compressed bytes whose count has nothing
            //  to do with the declared (uncompressed) size, so the chunk goes
            //  through whole — capping it here would truncate the stream.
            //  Finalizing is driven by the decompressed count instead; see
            //  the 'data' handler above.
            cr.inflate.write(data);
        } else {
            //  Non-GZ: cap to declared size and finalize early if we've
            //  received exactly the right number of bytes.
            const needed = cr.size - cr.bytesReceived;
            const slice = needed < data.length ? data.slice(0, needed) : data;
            cr.bytesReceived += slice.length;
            cr.writeStream.write(slice);
            if (cr.bytesReceived >= cr.size) {
                this._finalizeReceive();
            }
        }
    }

    //
    //  Inbound decompression failed. The bytes are unrecoverable, but the
    //  file need not be: FTS-1029 lets a receiver switch compression off
    //  mid-session by answering with an M_GET carrying an NZ token, asking
    //  for the file again in the clear. Without that the batch simply stops
    //  — we never send M_GOT, the sender waits out its timeout, and the mail
    //  comes back on every poll from then on with nothing to show why.
    //
    _onInflateError(cr, err) {
        if (this._currentRecv !== cr) {
            return; //  already torn down
        }

        Log.warn(
            { name: cr.name, error: err.message },
            '[BinkP] Inbound decompression failed'
        );

        this._abandonReceive(cr);

        const key = `${cr.name}\0${cr.size}\0${cr.timestamp}`;
        if (this._useEXTCMD && !this._nzRequested.has(key)) {
            this._nzRequested.add(key);
            Log.info(
                { name: cr.name },
                '[BinkP] Requesting an uncompressed retransmit (NZ)'
            );
            this._sendCmd(Commands.M_GET, `${cr.name} ${cr.size} ${cr.timestamp} 0 NZ`);
            return;
        }

        //  Nothing further to try: either the peer has no EXTCMD to carry the
        //  token, or the clear retransmit failed too. A non-destructive skip
        //  leaves the file with the sender for another session and lets this
        //  batch finish rather than hang.
        this._sendCmd(Commands.M_SKIP, `${cr.name} ${cr.size} ${cr.timestamp}`);
        this._checkDone();
    }

    //  Drop a partial receive and everything holding on to it.
    _abandonReceive(cr) {
        for (const key of ['inflate', 'writeStream']) {
            const stream = cr[key];
            if (!stream) continue;
            stream.removeAllListeners();
            stream.on('error', () => {});
            stream.destroy();
            cr[key] = null;
        }
        this._currentRecv = null;
        this._inboundTempPaths.delete(cr.tempPath);
        fsp.unlink(cr.tempPath).catch(err => {
            if ('ENOENT' !== err.code) {
                Log.warn(
                    { path: cr.tempPath, error: err.message },
                    '[BinkP] Could not remove abandoned inbound temp file'
                );
            }
        });
    }

    _finalizeReceive(cr = this._currentRecv) {
        if (!cr || cr._finalizing) return;
        cr._finalizing = true;
        //  Do NOT clear this._currentRecv yet. _checkDone must not consider
        //  the receive complete until finish() has sent M_GOT. If M_EOB
        //  arrives while we are waiting for the async writeStream flush, a
        //  premature _checkDone would close the session before M_GOT is sent
        //  and the client would wait forever.

        const finish = () => {
            if (this._currentRecv === cr) {
                this._currentRecv = null;
            }
            //  Short of the size the sender announced: something ended the
            //  transfer early. M_GOT would tell the sender we hold a good
            //  copy and let it apply its disposition, so stay quiet and let
            //  it offer the file again next session.
            if (cr.bytesReceived < cr.size) {
                this._abandonShortReceive(cr);
                return;
            }

            //  File handed off to the listener; ownership of the temp file
            //  passes to whatever moves it into the inbound spool. Drop our
            //  tracking entry so _destroy() doesn't unlink it from under
            //  the consumer.
            this._inboundTempPaths.delete(cr.tempPath);
            this._sendCmd(Commands.M_GOT, `${cr.name} ${cr.size} ${cr.timestamp}`);
            this.emit('file-received', cr.name, cr.size, cr.timestamp, cr.tempPath);
            this._checkDone();
        };

        if (cr.inflate) {
            // Wait for the writeStream to finish draining all decompressed bytes
            // before calling finish. The decompressor's 'finish' (writable side)
            // precedes the piped writeStream 'finish'; listen on writeStream.
            cr.writeStream.once('finish', finish);
            cr.inflate.end();
        } else if (cr.writeStream) {
            cr.writeStream.end(finish);
        } else {
            // Zero-byte file — writeStream was never opened
            this._inboundTempPaths.add(cr.tempPath);
            fsp.writeFile(cr.tempPath, Buffer.alloc(0))
                .then(finish)
                .catch(err => {
                    this._currentRecv = null;
                    this._inboundTempPaths.delete(cr.tempPath);
                    Log.warn(
                        { name: cr.name, error: err.message },
                        '[BinkP] Could not write empty inbound file'
                    );
                    this._checkDone();
                });
        }
    }

    _onEob() {
        this._remoteEOB = true;
        this._closeOutstandingReceive();
        //  The remote is done sending; anything we asked an offset for is
        //  not coming this session.
        this._pendingOffsetReq = null;
        this._checkDone();
        //  Answering side defers M_EOB until _remoteEOB is true. Now that
        //  it is, unblock the send loop so M_EOB (or queued FREQ files) go out.
        if (this._opts.role === 'answering' && !this._localEOBSent) {
            setImmediate(() => this._sendNext());
        }
    }

    //
    //  M_SKIP: FTS-1026 non-destructive skip — "the remote should postpone
    //  sending the file until next session". The file stays on disk (no
    //  disposition is applied), but we have to stop tracking it: a skipped
    //  file left in _currentSend stalls the send loop, and one left in
    //  _pendingGots blocks _checkDone. Either way the batch hangs until a
    //  session timeout, which is the same failure NR mode used to produce.
    //
    _onSkip(arg) {
        const parts = arg.split(' ');
        if (parts.length < 3) return;
        const [name, sizeStr, tsStr] = parts;

        const skipped = () => {
            this.emit('file-skipped', name, parseInt(sizeStr, 10), parseInt(tsStr, 10));
        };

        const key = `${name}\0${sizeStr}\0${tsStr}`;
        if (this._pendingGots.delete(key)) {
            Log.debug({ name }, '[BinkP] M_SKIP for a file awaiting M_GOT');
            skipped();
            this._checkDone();
            return;
        }

        const queueIdx = this._sendQueue.findIndex(
            f =>
                f.name === name &&
                String(f.size) === sizeStr &&
                String(f.timestamp) === tsStr
        );
        if (queueIdx >= 0) {
            this._sendQueue.splice(queueIdx, 1);
            Log.debug({ name }, '[BinkP] M_SKIP for a queued file');
            skipped();
            this._checkDone();
            return;
        }

        //  Name + size only, matching _onGot's active-send check: some
        //  mailers echo a normalised timestamp back at us.
        if (
            this._currentSend &&
            this._currentSend.name === name &&
            String(this._currentSend.size) === sizeStr
        ) {
            Log.debug({ name }, '[BinkP] M_SKIP for the file in flight');
            this._teardownSendStreams(this._currentSend);
            this._currentSend = null;
            skipped();
            setImmediate(() => this._sendNext());
            return;
        }

        skipped();
    }

    _checkDone() {
        if (
            this._localEOB &&
            this._remoteEOB &&
            this._pendingGots.size === 0 &&
            !this._currentSend &&
            !this._currentRecv
        ) {
            this._onBatchComplete();
        }
    }

    //  Called when both sides have exchanged M_EOB and all transfers are settled.
    //  If opts.onBatchEnd is provided, call it so the application can queue files
    //  for another batch (e.g. FREQ responses). If new files were queued, reset
    //  EOB state and restart sending; otherwise end the session.
    _onBatchComplete() {
        if (this._batchEndPending) return;
        this._batchEndPending = true;

        const hook = this._opts.onBatchEnd;

        //  Snapshot queue depth before calling the hook so we can detect
        //  whether the hook itself added files (vs. pre-existing unsent ones).
        const queueBefore = this._sendQueue.length;

        const afterHook = () => {
            this._batchEndPending = false;
            ++this._batchesDone;

            //  Hook added files — start another batch to carry them.
            if (this._sendQueue.length > queueBefore) {
                return this._startNextBatch();
            }

            //  binkp/1.1 batching: a batch that carried more than the two
            //  M_EOBs is followed by another, and only an empty batch ends
            //  the session. Skipping that leaves a 1.1 peer waiting for an
            //  M_EOB that never comes — binkd sits until its own timeout and
            //  books the session as failed even though the mail arrived,
            //  while we hold the node's lock for the duration and skip any
            //  crashmail for it in the meantime.
            //
            //  Both sides count every command frame, sent and received, so
            //  they arrive at the same total and reach the same decision.
            if (this._shouldStartAnotherBatch()) {
                return this._startNextBatch();
            }

            if (this._opts.role === 'originating') {
                //  Originating side controls session lifetime: nothing left →
                //  close the connection.
                this._finishSession();
            } else {
                //  Answering side never closes proactively. Wait for the
                //  originating node to close; _onSocketClose handles cleanup.
                this._waitingForClose = true;
            }
        };

        if (!hook) {
            afterHook();
            return;
        }

        Promise.resolve(hook(this))
            .then(afterHook)
            .catch(err => {
                Log.warn(
                    { error: err.message },
                    '[BinkP] onBatchEnd hook error; ending session'
                );
                this._batchEndPending = false;
                this._finishSession();
            });
    }

    //  Another batch follows unless this one was empty. Gated on the remote
    //  actually speaking binkp/1.1: a 1.0 peer closes after the first batch,
    //  so offering it a second one would strand us.
    _shouldStartAnotherBatch() {
        if (this._batchMsgCount <= 2) {
            return false; //  our M_EOB and theirs, nothing else
        }
        if (this._batchesDone >= MAX_BATCHES) {
            Log.warn(
                { batches: this._batchesDone },
                '[BinkP] Batch limit reached; ending session'
            );
            return false;
        }
        const ver = this._remoteVer;
        return !!ver && ver.major * 100 + ver.minor > 100;
    }

    _startNextBatch() {
        this._batchMsgCount = 0;
        this._localEOB = false;
        this._localEOBSent = false;
        this._remoteEOB = false;
        this._waitingForClose = false;
        setImmediate(() => this._sendNext());
    }

    _finishSession() {
        if (this._state === 'done') return;
        this._state = 'done';
        if (this._timeoutHandle) clearTimeout(this._timeoutHandle);

        //  |_state| is already 'done', so nothing re-enters while we wait for
        //  the sent files to actually be gone (see |_pendingDispositions|).
        const pending = Array.from(this._pendingDispositions);
        if (0 === pending.length) {
            return this._emitSessionEnd();
        }

        Promise.all(pending).then(() => this._emitSessionEnd());
    }

    _emitSessionEnd() {
        this.emit('session-end');
        setImmediate(() => this._destroy(true));
    }

    // ── Utility ─────────────────────────────────────────────────────────────

    _sendCmd(cmd, arg) {
        if (this._state === 'transfer') {
            ++this._batchMsgCount;
        }
        if (!this._socket.destroyed) {
            this._socket.write(buildCommandFrame(cmd, arg));
        }
    }

    isSecure() {
        return this._authState === 'P_SECURE';
    }

    //  Increment the M_EOB hold counter. While held > 0, _sendNext will not
    //  send M_EOB even when the send queue drains. Call releaseEOB() when done.
    holdEOB() {
        this._eobHold++;
    }

    //  Decrement the hold counter. When it reaches 0, resume _sendNext so
    //  M_EOB (or newly queued files) can be processed.
    releaseEOB() {
        this._eobHold = Math.max(0, this._eobHold - 1);
        if (this._eobHold === 0 && this._state === 'transfer') {
            setImmediate(() => this._sendNext());
        }
    }

    sendError(msg) {
        Log.warn({ msg }, '[BinkP] Sending M_ERR');
        this._sendCmd(Commands.M_ERR, msg);
        this._destroy();
    }

    sendBusy(msg) {
        Log.info({ msg }, '[BinkP] Sending M_BSY');
        this._sendCmd(Commands.M_BSY, msg);
        this._destroy();
    }

    _resetTimeout() {
        if (this._timeoutHandle) clearTimeout(this._timeoutHandle);
        this._timeoutHandle = setTimeout(() => {
            Log.warn('[BinkP] Session timeout');
            this.sendError('Session timeout');
        }, SESSION_TIMEOUT_MS);
    }

    _destroy(graceful = false) {
        if (this._timeoutHandle) clearTimeout(this._timeoutHandle);
        if (this._currentSend?.deflateStream) {
            this._currentSend.deflateStream.destroy();
        }
        if (this._currentSend?.readStream) {
            this._currentSend.readStream.destroy();
        }
        if (this._currentRecv?.inflate) {
            this._currentRecv.inflate.destroy();
        }
        if (this._currentRecv?.writeStream) {
            this._currentRecv.writeStream.destroy();
        }
        //  Unlink any inbound temp files we never finished receiving. The
        //  set is empty in the happy path; entries here mean the peer
        //  dropped mid-transfer.
        for (const tempPath of this._inboundTempPaths) {
            fsp.unlink(tempPath).catch(err => {
                if (err.code !== 'ENOENT') {
                    Log.warn(
                        { path: tempPath, error: err.message },
                        '[BinkP] Could not remove orphaned inbound temp file'
                    );
                }
            });
        }
        this._inboundTempPaths.clear();
        if (!this._socket.destroyed) {
            if (graceful) {
                //  Graceful FIN: peer reads all buffered data (including any
                //  in-flight M_EOB) before the connection closes. allowHalfOpen
                //  defaults to false so the peer will reciprocate automatically.
                this._socket.end();
            } else {
                this._socket.destroy();
            }
        }
    }

    _onSocketError(err) {
        Log.warn({ error: err.message }, '[BinkP] Socket error');
        this.emit('error', err);
        this._destroy();
    }

    _onSocketClose() {
        if (this._state !== 'done') {
            //  Either the answering side was explicitly waiting for the
            //  originating node to close (_waitingForClose), OR both sides
            //  completed M_EOB exchange with nothing pending (cleanEnd) — the
            //  latter catches the race where socket close arrives before
            //  _waitingForClose is set.
            //  A receive is "done enough" for a clean end if it's in the
            //  finalizing state: EOF was received and we're just waiting for
            //  the async writeStream flush. The file was fully transferred.
            const recvDone = !this._currentRecv || this._currentRecv._finalizing;
            //  A close between batches counts too: the peer decided the
            //  session was over one batch sooner than we did, and with
            //  nothing outstanding there is nothing to report.
            const settled = (this._localEOB && this._remoteEOB) || this._batchesDone > 0;
            const cleanEnd =
                settled && this._pendingGots.size === 0 && !this._currentSend && recvDone;

            if (this._waitingForClose || cleanEnd) {
                this._finishSession();
            } else {
                this.emit('disconnect');
            }
        }
    }
}

module.exports = { BinkpSession };
