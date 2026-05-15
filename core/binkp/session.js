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

// Extensions that are already compressed — don't waste CPU trying to GZ them.
// Arcmail day-of-week bundles (*.mo0, *.tu1, etc.) are also pre-compressed.
const ALREADY_COMPRESSED_RE = /\.(zip|arc|arj|lzh|lha|gz|bz2|zst|pk[34]|zoo)$/i;
const ARCMAIL_RE = /\.(su|mo|tu|we|th|fr|sa)[0-9a-z]$/i;

function _isCompressed(filename) {
    return ALREADY_COMPRESSED_RE.test(filename) || ARCMAIL_RE.test(filename);
}

// binkd versions with a known-buggy NR implementation — force symmetric NR workaround
const BUGGY_NR_PATTERNS = [
    'binkd/0.9/',
    'binkd/0.9.1/',
    'binkd/0.9.2/',
    'binkd/0.9.3/',
    'binkd/0.9.3x/',
    'binkd/0.9.4/',
];

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
        this._buggyNR = false;

        // Negotiated capabilities
        this._useNR = false;
        this._useND = false;
        this._useGZ = false;
        this._useEXTCMD = false;

        // Transfer state
        this._sendQueue = []; // { name, path, size, timestamp, disposition }
        this._currentSend = null; // { name, path, size, timestamp, disposition, offset, nrPending, readStream }
        this._currentRecv = null; // { name, size, timestamp, tempPath, bytesReceived, writeStream }
        this._pendingGots = new Map(); // `name\0size\0ts` → { name, path, size, timestamp, disposition }

        //  Inbound temp files we own. Added when we start writing one and
        //  removed on successful M_GOT — anything left here at _destroy()
        //  time is a partial that the peer dropped on us.
        this._inboundTempPaths = new Set();

        this._localEOBSent = false;
        this._localEOB = false;
        this._remoteEOB = false;

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

        const caps = [Opts.NR, Opts.NDA, Opts.GZ, Opts.EXTCMD];
        this._sendCmd(Commands.M_NUL, `OPT ${caps.join(' ')}`);

        const password = this._lookupPassword();

        if (this._remoteCramChallenge && password) {
            const response = computeResponse(password, this._remoteCramChallenge);
            this._sendCmd(Commands.M_PWD, `CRAM-MD5-${response}`);
        } else {
            this._sendCmd(Commands.M_PWD, password || '-');
        }
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
            if (keyword === 'VER') {
                this._buggyNR = BUGGY_NR_PATTERNS.some(p => value.includes(p));
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
        if (this._remoteOpts.has(Opts.NR) && !this._buggyNR) {
            confirmedOpts.push(Opts.NR);
            this._useNR = true;
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
            if (this._remoteOpts.has(Opts.GZ)) {
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
        if (this._remoteOpts.has(Opts.NR) && !this._buggyNR) {
            this._useNR = true;
        }
        if (this._remoteOpts.has(Opts.NDA) || this._remoteOpts.has(Opts.ND)) {
            this._useND = true;
        }
        if (this._remoteOpts.has(Opts.EXTCMD)) {
            this._useEXTCMD = true;
            if (this._remoteOpts.has(Opts.GZ)) {
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

        if (this._localEOBSent) return;

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

        const offset = this._useNR ? -1 : 0;
        // Append GZ token only when EXTCMD is active — old implementations
        // without EXTCMD concatenate extra tokens into the filename.
        const gzToken = useGZ ? ' GZ' : '';
        this._sendCmd(
            Commands.M_FILE,
            `${file.name} ${file.size} ${file.timestamp} ${offset}${gzToken}`
        );

        if (!this._useNR) {
            this._pumpFile();
        }
        // else: wait for M_GET from remote before pumping
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
            } else {
                this._socket.once('drain', () => source.resume());
            }
        };

        if (!cs.useGZ) {
            rs.on('data', chunk => sendChunk(rs, chunk));
            rs.on('end', onAllDataSent);
            rs.on('error', onSendError);
            return;
        }

        //  GZ path: drive the gzip transform explicitly rather than via pipe,
        //  keeping the same pause/resume back-pressure pattern on the output.
        const gz = zlib.createGzip();
        cs.gzipStream = gz; // stored so _destroy can clean it up

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

    _onGet(arg) {
        // NR mode: remote tells us the offset to resume from
        const parts = arg.split(' ');
        if (parts.length < 4) return;

        const [name, , , offsetStr] = parts;
        const offset = parseInt(offsetStr, 10);

        if (!this._currentSend || this._currentSend.name !== name) {
            Log.warn({ name }, '[BinkP] M_GET for unknown or inactive file');
            return;
        }

        this._currentSend.offset = Math.max(0, offset);
        this._currentSend.nrPending = false;
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
            return;
        }

        if (
            this._currentSend &&
            this._currentSend.name === name &&
            String(this._currentSend.size) === sizeStr
        ) {
            Log.debug({ name }, '[BinkP] Destructive skip via M_GOT (active send)');
            if (this._currentSend.readStream) {
                this._currentSend.readStream.destroy();
            }
            this._applyDisposition(this._currentSend);
            this._currentSend = null;
            setImmediate(() => this._sendNext());
        }
    }

    _applyDisposition(file) {
        if (file.disposition === 'delete') {
            fsp.unlink(file.path).catch(err =>
                Log.warn(
                    { path: file.path, error: err.message },
                    '[BinkP] Could not delete sent file'
                )
            );
        } else if (file.disposition === 'truncate') {
            fsp.truncate(file.path, 0).catch(err =>
                Log.warn(
                    { path: file.path, error: err.message },
                    '[BinkP] Could not truncate sent file'
                )
            );
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

        const [name, sizeStr, tsStr, offsetStr] = parts;
        const size = parseInt(sizeStr, 10);
        const timestamp = parseInt(tsStr, 10);
        const offset = parseInt(offsetStr, 10);

        // Extra tokens (e.g. GZ) are only valid when EXTCMD was negotiated —
        // without it, old implementations concatenate them into the filename.
        const useGZ = this._useEXTCMD && this._useGZ && parts.slice(4).includes('GZ');

        // Duplicate detection
        if (
            typeof this._opts.hasFile === 'function' &&
            this._opts.hasFile(name, size, timestamp)
        ) {
            this._sendCmd(Commands.M_GOT, `${name} ${size} ${timestamp}`);
            return;
        }

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

        // NR mode: sender sent offset=-1 requesting us to provide our resume offset
        if (offset === -1) {
            // :TODO: check for existing partial file and respond with its size
            this._sendCmd(Commands.M_GET, `${name} ${size} ${timestamp} 0`);
        }
    }

    _onDataFrame(data) {
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
                cr.gunzip = zlib.createGunzip();
                cr.gunzip.on('error', err => {
                    Log.warn(
                        { name: cr.name, error: err.message },
                        '[BinkP] Inbound GZ decompress error'
                    );
                });
                cr.gunzip.pipe(cr.writeStream);
            }

            this._inboundTempPaths.add(cr.tempPath);
        }

        if (cr.useGZ) {
            //  GZ: wire carries compressed bytes whose count differs from the
            //  declared (uncompressed) file size. Pass the full chunk through
            //  to gunzip — do NOT cap against cr.size — and rely solely on the
            //  EOF frame (data.length === 0 path above) to trigger finalize.
            cr.gunzip.write(data);
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

    _finalizeReceive() {
        const cr = this._currentRecv;
        if (!cr || cr._finalizing) return;
        cr._finalizing = true;
        //  Do NOT clear this._currentRecv yet. _checkDone must not consider
        //  the receive complete until finish() has sent M_GOT. If M_EOB
        //  arrives while we are waiting for the async writeStream flush, a
        //  premature _checkDone would close the session before M_GOT is sent
        //  and the client would wait forever.

        const finish = () => {
            this._currentRecv = null;
            //  File handed off to the listener; ownership of the temp file
            //  passes to whatever moves it into the inbound spool. Drop our
            //  tracking entry so _destroy() doesn't unlink it from under
            //  the consumer.
            this._inboundTempPaths.delete(cr.tempPath);
            this._sendCmd(Commands.M_GOT, `${cr.name} ${cr.size} ${cr.timestamp}`);
            this.emit('file-received', cr.name, cr.size, cr.timestamp, cr.tempPath);
            this._checkDone();
        };

        if (cr.gunzip) {
            // Wait for the writeStream to finish draining all decompressed bytes
            // before calling finish. gunzip 'finish' (writable side) precedes
            // the piped writeStream 'finish'; listen on writeStream.
            cr.writeStream.once('finish', finish);
            cr.gunzip.end();
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
        this._checkDone();
        //  Answering side defers M_EOB until _remoteEOB is true. Now that
        //  it is, unblock the send loop so M_EOB (or queued FREQ files) go out.
        if (this._opts.role === 'answering' && !this._localEOBSent) {
            setImmediate(() => this._sendNext());
        }
    }

    _onSkip(arg) {
        const parts = arg.split(' ');
        if (parts.length < 3) return;
        const [name, sizeStr, tsStr] = parts;
        this.emit('file-skipped', name, parseInt(sizeStr), parseInt(tsStr));
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
            const hookQueuedFiles = this._sendQueue.length > queueBefore;
            if (hookQueuedFiles) {
                //  Hook added files — start another batch. Reset both EOB
                //  flags; remote will send a new M_EOB when its side is done.
                this._localEOB = false;
                this._localEOBSent = false;
                this._remoteEOB = false;
                setImmediate(() => this._sendNext());
            } else if (this._opts.role === 'originating') {
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

    _finishSession() {
        if (this._state === 'done') return;
        this._state = 'done';
        if (this._timeoutHandle) clearTimeout(this._timeoutHandle);
        this.emit('session-end');
        setImmediate(() => this._destroy(true));
    }

    // ── Utility ─────────────────────────────────────────────────────────────

    _sendCmd(cmd, arg) {
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
        if (this._currentSend?.gzipStream) {
            this._currentSend.gzipStream.destroy();
        }
        if (this._currentSend?.readStream) {
            this._currentSend.readStream.destroy();
        }
        if (this._currentRecv?.gunzip) {
            this._currentRecv.gunzip.destroy();
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
            const cleanEnd =
                this._localEOB &&
                this._remoteEOB &&
                this._pendingGots.size === 0 &&
                !this._currentSend &&
                recvDone;

            if (this._waitingForClose || cleanEnd) {
                this._finishSession();
            } else {
                this.emit('disconnect');
            }
        }
    }
}

module.exports = { BinkpSession };
