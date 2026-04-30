'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const { FrameParser, buildCommandFrame, buildDataFrame, EOF_FRAME } = require('./frame');
const { Commands, CommandNames, Opts } = require('./commands');
const { generateChallenge, computeResponse, verifyResponse } = require('./cram');
const Log = require('../logger').log;

const BINKP_VER = '1.1';
const SEND_CHUNK_SIZE = 4096;
const SESSION_TIMEOUT_MS = 300_000; // 5 min

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
        this._useEXTCMD = false;

        // Transfer state
        this._sendQueue = []; // { name, path, size, timestamp, disposition }
        this._currentSend = null; // { name, path, size, timestamp, disposition, offset, nrPending, readStream }
        this._currentRecv = null; // { name, size, timestamp, tempPath, bytesReceived, writeStream }
        this._pendingGots = new Map(); // `name\0size\0ts` → { name, path, size, timestamp, disposition }

        this._localEOBSent = false;
        this._localEOB = false;
        this._remoteEOB = false;

        this._sendHeld = false;
        this._timeoutHandle = null;

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

        const caps = [Opts.NR, Opts.EXTCMD];
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
        if (this._remoteOpts.has(Opts.EXTCMD)) {
            confirmedOpts.push(Opts.EXTCMD);
            this._useEXTCMD = true;
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
        if (this._remoteOpts.has(Opts.EXTCMD)) {
            this._useEXTCMD = true;
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
            this._localEOBSent = true;
            this._localEOB = true;
            this._sendCmd(Commands.M_EOB, '');
            this._checkDone();
            return;
        }

        const file = this._sendQueue.shift();
        this._currentSend = {
            ...file,
            offset: 0,
            nrPending: this._useNR,
            readStream: null,
        };

        const offset = this._useNR ? -1 : 0;
        this._sendCmd(
            Commands.M_FILE,
            `${file.name} ${file.size} ${file.timestamp} ${offset}`
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

        rs.on('data', chunk => {
            rs.pause();
            const ok = this._socket.write(buildDataFrame(chunk));
            if (ok) {
                rs.resume();
            } else {
                this._socket.once('drain', () => rs.resume());
            }
        });

        rs.on('end', () => {
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
        });

        rs.on('error', err => {
            Log.warn(
                { name: cs.name, error: err.message },
                '[BinkP] Error reading outbound file'
            );
            this._sendCmd(Commands.M_SKIP, `${cs.name} ${cs.size} ${cs.timestamp}`);
            this._currentSend = null;
            setImmediate(() => this._sendNext());
        });
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

        const [name, sizeStr, tsStr, offsetStr] = parts;
        const size = parseInt(sizeStr, 10);
        const timestamp = parseInt(tsStr, 10);
        const offset = parseInt(offsetStr, 10);

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
            writeStream: null,
        };

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

        // Cap to declared size — discard any overshoot
        const needed = cr.size - cr.bytesReceived;
        const slice = needed < data.length ? data.slice(0, needed) : data;

        cr.bytesReceived += slice.length;

        if (!cr.writeStream) {
            cr.writeStream = fs.createWriteStream(cr.tempPath);
        }
        cr.writeStream.write(slice);

        if (cr.bytesReceived >= cr.size) {
            this._finalizeReceive();
        }
    }

    _finalizeReceive() {
        const cr = this._currentRecv;
        if (!cr) return;
        this._currentRecv = null;

        const finish = () => {
            this._sendCmd(Commands.M_GOT, `${cr.name} ${cr.size} ${cr.timestamp}`);
            this.emit('file-received', cr.name, cr.size, cr.timestamp, cr.tempPath);
            this._checkDone();
        };

        if (cr.writeStream) {
            cr.writeStream.end(finish);
        } else {
            // Zero-byte file
            fsp.writeFile(cr.tempPath, Buffer.alloc(0))
                .then(finish)
                .catch(err => {
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
            this._finishSession();
        }
    }

    _finishSession() {
        if (this._state === 'done') return;
        this._state = 'done';
        if (this._timeoutHandle) clearTimeout(this._timeoutHandle);
        this.emit('session-end');
        setImmediate(() => this._destroy());
    }

    // ── Utility ─────────────────────────────────────────────────────────────

    _sendCmd(cmd, arg) {
        if (!this._socket.destroyed) {
            this._socket.write(buildCommandFrame(cmd, arg));
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

    _destroy() {
        if (this._timeoutHandle) clearTimeout(this._timeoutHandle);
        if (this._currentSend?.readStream) {
            this._currentSend.readStream.destroy();
        }
        if (this._currentRecv?.writeStream) {
            this._currentRecv.writeStream.destroy();
        }
        if (!this._socket.destroyed) {
            this._socket.destroy();
        }
    }

    _onSocketError(err) {
        Log.warn({ error: err.message }, '[BinkP] Socket error');
        this.emit('error', err);
        this._destroy();
    }

    _onSocketClose() {
        if (this._state !== 'done') {
            this.emit('disconnect');
        }
    }
}

module.exports = { BinkpSession };
