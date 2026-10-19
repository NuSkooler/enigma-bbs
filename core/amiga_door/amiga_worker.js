/* jslint node: true */
'use strict';

/**
 * amiga_worker.js
 *
 * Worker thread that runs one emulated Amiga (enigma-vamiga) for a single
 * Amiga door session. Spawned by amiga_door.js via worker_threads; one worker
 * per session, never reused (shim protocol v1).
 *
 * The emulated Amiga runs the host shim (axshim, misc/amiga_door/), which
 * impersonates an AmiExpress node for the door and talks to us over the
 * emulated serial port: door terminal bytes unframed, control messages framed
 * (core/amiga_door/protocol.js).
 *
 * The door's disk is its image file (enigma-vamiga 0.2.0's file-backed disk):
 * the core reads the image page by page as the guest asks and, for a door
 * that persists, writes the guest's changes back as it makes them (write-through
 * when the drive goes idle). A door with persist: false runs with write-through
 * off: its changes stay in the core and go with it. At the end, whatever the
 * door's exit, 'stop' lets the guest's file system flush, then syncs the image.
 *
 * workerData shape:
 * {
 *   module:          WebAssembly.Module - enigma-vamiga's, compiled once by the parent
 *   snapshot:        Uint8Array|null    - booted machine to restore (SharedArrayBuffer backed);
 *                                         null to boot from the image
 *   image:           string             - the door's .hdf, the disk itself
 *   persist:         boolean            - false: nothing the guest writes reaches the image
 *   rom, extRom:     string|undefined   - Kickstart override paths (boot only)
 *   machine:         { cpu, chipKb, slowKb, fastKb, overclock } (boot only)
 *   warpBootSeconds: number             - first boot runs flat out this long
 *   serialHandshake: boolean|undefined  - the snapshot's machine ran with RTS/CTS on (its
 *                                         shim drives RTS); the shim's H decides from then on
 *   session:         { ... }            - `s` frame keys; `now` is added when it is sent
 * }
 *
 * MessagePort protocol (worker -> parent):
 *   { type: 'snapshotRefused', message }                - the core would not restore the
 *                                                         snapshot (another core version, or
 *                                                         another file); booting instead
 *   { type: 'snapshot', snapshot: Uint8Array, ms, serialHandshake, stat }
 *                                                       - booted, idle, warp over: cache me;
 *                                                         |stat| is the image's right after it
 *   { type: 'ready', restored, ms, restoreMs, hello, stats, serialHandshake }
 *                                                       - `s` has been sent
 *   { type: 'output', data: Uint8Array }                - door bytes (frames removed), per frame batch
 *   { type: 'frame', frame: { type, keys } }            - H, R, L, C, E (protocol frames)
 *   { type: 'exit', status, keys }                      - the shim's X frame (the first one only)
 *   { type: 'inputFull', limit }                        - caller input reached MaxInputQueueBytes
 *                                                         (once per session; the excess is dropped)
 *   { type: 'synced', writes, bytes, sessionWrites, ms, error, code, skipped }
 *                                                         (sessionWrites: null when the core's
 *                                                         write counters were unavailable)
 *                                                       - while stopping: the image holds what the
 *                                                         guest wrote (|error|: the sync failed;
 *                                                         |skipped|: persist is off)
 *   { type: 'error', message, code, fatal }             - see below
 *   { type: 'stopped' }                                 - answer to 'stop', worker exits
 *
 * MessagePort protocol (parent -> worker):
 *   { type: 'input', data }                - caller bytes (escaped here)
 *   { type: 'frame', frame: { type, keys } } - send a host frame (t, d, w, e); `d` drops queued
 *                                            input, but finishes a frame or RS RS pair already begun
 *   { type: 'pause' } / { type: 'resume' } - output back-pressure: stop / restart the emulator
 *   { type: 'stop' }                       - settle and sync the disk ('synced'), then shut down
 */

const { isMainThread, workerData, parentPort } = require('worker_threads');

//  module_util.js' initializeModules() require()s every *.js under core/ (and
//  one directory down) to look for an optional moduleInitialize export.
//  Without this guard the worker setup below would run in the main thread.
if (isMainThread) {
    return;
}

const fs = require('fs');
const protocol = require('./protocol.js');
const { HostLink } = require('./host_link.js');

const { RS } = protocol;

//
//  Serial line discipline (misc/amiga_door/README.md, "Serial line"). Caller
//  input is never dropped for being early: it waits here until the guest has
//  room. What is in flight is bounded twice:
//
//  - InputWindowBytes: at most this many bytes sit in the core's receive
//    buffer (SerServer, 8 KB) that the guest's UART has not taken yet
//    (|serialInPending|). The shim drops RTS at 3/4 of its 4 KB ring, which
//    leaves 1 KB for what is already on its way: a window below that keeps a
//    sender that only stops writing when RTS drops lossless, and keeps a `d`
//    from queueing behind kilobytes of typeahead the door has not read.
//  - MaxInputQueueBytes: what waits here. A caller pasting a megabyte into a
//    door that reads nothing is not typing; past this the excess is dropped,
//    counted (X `inputDropped`) and reported once ('inputFull').
//
const InputWindowBytes = 768;
const MaxInputQueueBytes = 1024 * 1024;

//  Amiga time to let the guest's file system flush before the final sync: X
//  comes after the door has exited plus the shim's 2 s drain, and AmigaOS
//  writes back dirty buffers within a few seconds. 150 frames = 3 s, computed
//  flat out (about 0.2 s of host time).
const SettleFrames = 150;

//  A stop that finds the carrier gone (`d` sent) with the door still running:
//  frames, pumped like the Pacer's, for the door to see it and the shim to
//  answer X. 100 frames = 2 s of Amiga time, flat out (about 0.15 s of host
//  time); well inside the parent's shutdown budget (3 s).
const CarrierGraceFrames = 100;

const t0 = performance.now();

//  When the guest's writes reach the image: as the door makes them (the core
//  writes back once the drive has been idle for 100 ms of Amiga time), or, for
//  a door that keeps nothing, never
const writeThrough = false === workerData.persist ? 'never' : 'onIdle';

let emu = null;
let pacer = null;
let link = null;
let state = 'starting'; //  starting | booting | warpEnding | session | exited | stopping
let inputDropped = 0;
let inputFullReported = false;
let carrierGone = false; //  a `d` was passed to the shim
let restored = false;
let restoreMs = null;
let writesAtStart = 0; //  the core's writes to the image before the session began
let handshake = false; //  the core's RTS/CTS handshake (SER.HANDSHAKE) is on

//
//  Host -> shim bytes waiting for room in the guest's receive buffer, in
//  order: [{ frame, buf, started, rsOpen }]. |frame| segments are whole
//  protocol frames, the others escaped caller input. |started| means part of
//  the segment has gone out; |rsOpen| that what went out of a data segment
//  ends with the first byte of an RS RS pair, which the shim is waiting to
//  see completed.
//
let outQueue = [];
let queuedDataBytes = 0;

function post(msg, transfer) {
    try {
        parentPort.postMessage(msg, transfer);
    } catch (e) {
        //  parent gone; nothing to tell
    }
}

function postError(err, extra = {}) {
    post(
        Object.assign(
            {
                type: 'error',
                message: err.message || String(err),
                code: err.code,
                name: err.name,
            },
            extra
        )
    );
}

//  How many bytes of |raw| fit in |room| once escaped (an RS doubles)
function fitEscaped(raw, room) {
    let cost = 0;
    let take = 0;
    for (; take < raw.length; take++) {
        const c = RS === raw[take] ? 2 : 1;
        if (cost + c > room) {
            break;
        }
        cost += c;
    }
    return take;
}

function enqueue(frame, bytes) {
    if (!bytes.length) {
        return;
    }
    const tail = outQueue[outQueue.length - 1];
    if (!frame && tail && !tail.frame) {
        tail.buf = Buffer.concat([tail.buf, bytes]);
    } else {
        outQueue.push({ frame, buf: Buffer.from(bytes), started: false, rsOpen: false });
    }
    if (!frame) {
        queuedDataBytes += bytes.length;
    }
}

//
//  Caller bytes, raw. Cut to what the queue has room for *before* escaping,
//  so a cut never falls between the two bytes of an escaped 0x1E: half a
//  pair followed by the next frame's RS would read as a literal 0x1E and the
//  frame would be lost.
//
function queueInput(raw) {
    if (state === 'exited' || state === 'stopping') {
        return;
    }
    const take = fitEscaped(raw, MaxInputQueueBytes - queuedDataBytes);
    if (take < raw.length) {
        inputDropped += raw.length - take;
        if (!inputFullReported) {
            inputFullReported = true;
            post({ type: 'inputFull', limit: MaxInputQueueBytes });
        }
    }
    if (take > 0) {
        enqueue(false, protocol.escapeData(raw.subarray(0, take)));
    }
}

function sendHostFrame(frame) {
    if (!frame || !frame.type) {
        return;
    }
    const bytes = protocol.encode(frame.type, frame.keys || {});
    if ('d' === frame.type) {
        carrierGone = true;
        //  Carrier is gone or time is up: whatever the caller typed before
        //  that is moot, and the shim drops bytes after `d` anyway. What is
        //  already on its way must still arrive whole, though: the shim is
        //  mid-frame (or mid RS RS pair) until it has, and would otherwise
        //  read `d` as the rest of it.
        const keep = [];
        for (const seg of outQueue) {
            if (seg.frame) {
                keep.push(seg);
            } else if (seg.started && seg.rsOpen) {
                keep.push({
                    frame: false,
                    buf: Buffer.from([RS]),
                    started: true,
                    rsOpen: true,
                });
            }
        }
        outQueue = keep;
        queuedDataBytes = keep.reduce(
            (n, seg) => n + (seg.frame ? 0 : seg.buf.length),
            0
        );
    }
    enqueue(true, bytes);
}

//  Does the written prefix |buf[0, n)| leave an RS RS pair half sent? |open|:
//  whether what went before it did.
function rsPairOpen(buf, n, open) {
    let i = n - 1;
    let run = 0;
    while (i >= 0 && RS === buf[i]) {
        ++run;
        --i;
    }
    if (i < 0) {
        run += open ? 1 : 0; //  the run carries on from before
    }
    return 1 === run % 2;
}

//
//  RTS/CTS on the emulated null modem (enigma-vamiga 0.1.3, vAmiga's
//  SER.HANDSHAKE): the core then starts a byte only while the guest's RTS is
//  asserted. axshim 1.5 and later drive RTS; an older shim never touches it,
//  and on AROS it boots deasserted, so with the handshake on such an image
//  would receive nothing. The shim's H frame says which it is: `shim=axshim
//  1.5`. Before an H (a restored snapshot) workerData says what the machine
//  that made the snapshot ran with.
//
function shimDrivesRts(hello) {
    const m = /^axshim (\d+)\.(\d+)/.exec((hello && hello.shim) || '');
    if (!m) {
        return false;
    }
    const major = parseInt(m[1], 10);
    return major > 1 || (1 === major && parseInt(m[2], 10) >= 5);
}

//  enigma-vamiga 0.1.2 and older have no handshake (nor guestRts)
function canHandshake(VAmiga) {
    return 'function' === typeof VAmiga.prototype.setSerialHandshake;
}

function setHandshake(on) {
    if (on === handshake || 'function' !== typeof emu.setSerialHandshake) {
        return;
    }
    emu.setSerialHandshake(on);
    handshake = on;
}

//
//  May the host send now? The guest's RTS (CIA-B PA6), which axshim 1.5
//  drops when its receive ring is three quarters full and while it starts a
//  door. With the handshake on the core holds back what it has already
//  accepted, so this only keeps more from piling up behind it; the window
//  above keeps what is in flight within the shim's headroom. Without the
//  handshake (an older shim, or an older package) RTS means nothing and the
//  core's byte holding (patch 0001) is all there is.
//
function guestClearToSend() {
    return !handshake || emu.guestRts;
}

//  Bytes the core has accepted that the guest's UART has not taken yet
function inFlight() {
    const n = emu.serialInPending;
    return Number.isInteger(n) && n > 0 ? n : 0;
}

//  As much of the queue as the window, and the core's receive buffer, take
function pumpInput() {
    if (!guestClearToSend()) {
        return;
    }
    let room = InputWindowBytes - inFlight();
    while (outQueue.length && room > 0) {
        const seg = outQueue[0];
        const offer = Math.min(room, seg.buf.length);
        const n = emu.serialWrite(seg.buf.subarray(0, offer));
        if (n > 0) {
            if (!seg.frame) {
                queuedDataBytes -= n;
                seg.rsOpen = rsPairOpen(seg.buf, n, seg.rsOpen);
            }
            seg.started = true;
            room -= n;
        }
        if (n >= seg.buf.length) {
            outQueue.shift();
            continue;
        }
        seg.buf = seg.buf.subarray(n);
        if (n < offer) {
            return; //  the core's buffer is full
        }
    }
}

function startSession() {
    state = 'session';

    //  A restored snapshot's clock is the snapshot's: `now` (and `tz`) set it.
    const keys = Object.assign({}, workerData.session, {
        now: Math.floor(Date.now() / 1000),
    });
    const sFrame = protocol.encode('s', keys);

    //  typeahead that arrived while we booted goes after `s`
    outQueue.unshift({ frame: true, buf: sFrame, started: false, rsOpen: false });

    let stats = null;
    try {
        stats = emu.stats();
    } catch (e) {
        //  informational only
    }
    try {
        writesAtStart = emu.hdfWriteStats.writes;
    } catch (e) {
        writesAtStart = null; //  the session's writes will be unknown
    }

    post({
        type: 'ready',
        restored,
        ms: performance.now() - t0,
        restoreMs,
        hello: link.hello,
        stats,
        serialHandshake: handshake,
    });
}

//
//  Snapshot the booted machine for the cache, with the image's stat taken
//  right after it: the snapshot holds the image's path and the guest's caches
//  of its file system, so it is good only while the file is exactly this one
//  (snapshot_cache.js). Taking it writes the core's pending changes into the
//  image first, whatever the write-through; for a door that keeps nothing
//  there is no snapshot when the boot has changed the disk (an AROS boot
//  writes nothing, but an image's startup sequence might).
//
function takeSnapshot() {
    const ts = performance.now();
    let snapshot;
    let stat;
    try {
        if ('never' === writeThrough && emu.hdfPending) {
            throw new Error(
                'the boot wrote to the disk, and persist is off: not snapshotting, which ' +
                    'would write it into the image (every session of this door boots)'
            );
        }
        const { Compressor } = require('enigma-vamiga');
        snapshot = emu.takeSnapshot({ compressor: Compressor.LZ4 });
        const s = fs.statSync(workerData.image);
        stat = { size: s.size, mtimeMs: s.mtimeMs, ino: s.ino, dev: s.dev };
    } catch (e) {
        //  not fatal: this session runs, the next one boots again
        postError(e, { during: 'snapshot', fatal: false });
        return;
    }
    const copy = new Uint8Array(snapshot); //  own ArrayBuffer, safe to transfer
    post(
        {
            type: 'snapshot',
            snapshot: copy,
            ms: performance.now() - ts,
            serialHandshake: handshake,
            stat,
        },
        [copy.buffer]
    );
}

function handleFrame(frame) {
    switch (frame.type) {
        case 'H':
            //  at boot, and after each `s` from axshim 1.5 on
            setHandshake(shimDrivesRts(frame.keys));
            break;

        case 'R':
            if ('booting' === state) {
                //  Booted and idle. Stop warping now and snapshot once a
                //  frame has run at real speed: a snapshot taken inside the
                //  warp window restores into a 20x guest clock. setWarp(false)
                //  does not end a warp boot on this core; zeroing the option
                //  does, on the next frame.
                emu.setOption('AMIGA.WARP_BOOT', 0);
                state = 'warpEnding';
            }
            break;

        case 'X':
            //  One X per session, and only once it has started: a second
            //  one, or one before `s`, is not ours to act on
            if ('session' !== state) {
                postError(new Error(`unexpected X frame (${state})`), {
                    during: 'session',
                    fatal: false,
                });
                return;
            }
            state = 'exited';
            outQueue = [];
            queuedDataBytes = 0;
            post({
                type: 'exit',
                status: frame.keys.status,
                keys: frame.keys,
                inputDropped,
            });
            return;

        default:
            break;
    }

    post({ type: 'frame', frame: { type: frame.type, keys: frame.keys } });
}

function onFrame({ warping }) {
    //  shim -> host
    const out = emu.serialRead();
    const data = [];
    for (const e of link.push(out)) {
        if (e.frame) {
            handleFrame(e.frame);
        } else if ('session' === state) {
            data.push(e.data);
        }
        //  door bytes outside a session (there should be none) are dropped
    }
    if (data.length) {
        //  An exact-size copy, transferred: posting a Buffer would clone the
        //  whole (pooled, 8 KB) ArrayBuffer behind it.
        const bytes = new Uint8Array(1 === data.length ? data[0] : Buffer.concat(data));
        post({ type: 'output', data: bytes }, [bytes.buffer]);
    }

    if ('warpEnding' === state && !warping) {
        takeSnapshot();
        startSession();
    }

    //  host -> shim, as much as the guest's receive buffer takes; nothing
    //  before `s` (startSession() puts it at the head of the queue)
    if ('session' === state && outQueue.length) {
        pumpInput();
    }
}

//
//  The door is over (its X, or the parent gave up on it): give the guest's
//  file system time to write back what it still buffers, then have the core
//  write the rest of its changes into the image and fsync it. With
//  write-through on, most of the session's writes are in the image already;
//  this is the remainder. A failure is reported, never thrown: the image keeps
//  what reached it, in place (there is no copy to fall back to).
//
function syncDisk() {
    if ('never' === writeThrough) {
        return post({ type: 'synced', skipped: true });
    }
    const ts = performance.now();
    try {
        emu.runFrames(SettleFrames);
        emu.serialRead(); //  the shim's R after X; nobody is listening
    } catch (e) {
        //  a halted or failed machine: sync what the core has
    }
    let error = null;
    try {
        emu.hdfSync();
    } catch (e) {
        error = e;
    }
    //  Writes unknown (the core would not say, or never did at the start):
    //  sessionWrites is null, and the parent treats the image as written.
    let stats = { writes: null, bytes: null };
    let sessionWrites = null;
    try {
        const now = emu.hdfWriteStats;
        stats = now;
        if (Number.isFinite(now.writes) && Number.isFinite(writesAtStart)) {
            sessionWrites = Math.max(0, now.writes - writesAtStart);
        }
    } catch (e) {
        //  stays unknown
    }
    post({
        type: 'synced',
        writes: stats.writes,
        bytes: stats.bytes,
        sessionWrites,
        ms: performance.now() - ts,
        error: error ? error.message || String(error) : undefined,
        code: error ? error.code : undefined,
    });
}

//
//  Stopping with the carrier gone and the door still running (the server is
//  shutting down): the Pacer is stopped, so nothing else would deliver the
//  queued `d` or hear the shim's X. Run frames, pumping the serial line each
//  one, until X arrives or the grace is used up. A door that has not answered
//  by then is synced where it stands, like a power cut.
//
function deliverCarrierLoss() {
    try {
        for (let i = 0; i < CarrierGraceFrames && 'session' === state; ++i) {
            if (outQueue.length) {
                pumpInput();
            }
            emu.runFrames(1);
            onFrame({ warping: false });
        }
    } catch (e) {
        //  a halted or failed machine: sync what the core has
    }
}

function stop() {
    if ('stopping' === state) {
        return;
    }
    try {
        if (pacer) {
            pacer.stop();
        }
    } catch (e) {
        //  going away regardless
    }
    if (emu && carrierGone && 'session' === state) {
        deliverCarrierLoss();
    }
    state = 'stopping';
    if (emu) {
        syncDisk();
        try {
            emu.destroy();
        } catch (e) {
            //  going away regardless
        }
    }
    post({ type: 'stopped' });
    process.exit(0);
}

parentPort.on('message', msg => {
    switch (msg.type) {
        case 'input':
            return queueInput(Buffer.from(msg.data));

        case 'frame':
            if (state === 'exited' || state === 'stopping') {
                return;
            }
            return sendHostFrame(msg.frame);

        case 'pause':
            if (pacer && 'session' === state) {
                pacer.stop();
            }
            return;

        case 'resume':
            if (pacer && !pacer.running && ('session' === state || 'exited' === state)) {
                pacer.start();
            }
            return;

        case 'stop':
            return stop();

        default:
            return;
    }
});

//
//  The emulator for this session, on the image file. A restore needs an
//  emulator with the same file-backed disk (the snapshot names the image's
//  path); its RAM sizes are irrelevant (the snapshot brings its own
//  configuration) and small ones keep the peak down. A boot gets the machine.
//
function createEmulator(VAmiga, boot) {
    const common = {
        module: workerData.module,
        hdf: { path: workerData.image, mode: 'file' },
        writeThrough,
    };
    if (canHandshake(VAmiga)) {
        common.serialHandshake = handshake;
    }
    if (!boot) {
        return VAmiga.create(Object.assign(common, { fastKb: 0, slowKb: 0 }));
    }
    const m = workerData.machine || {};
    return VAmiga.create(
        Object.assign(common, {
            rom: workerData.rom,
            ext: workerData.extRom,
            cpu: m.cpu,
            chipKb: m.chipKb,
            slowKb: m.slowKb,
            fastKb: m.fastKb,
            overclock: m.overclock,
            warpBootSeconds: workerData.warpBootSeconds,
        })
    );
}

async function main() {
    let VAmiga;
    let Pacer;
    try {
        ({ VAmiga, Pacer } = require('enigma-vamiga'));
    } catch (e) {
        postError(new Error(`Cannot load enigma-vamiga: ${e.message}`), { fatal: true });
        return process.exit(1);
    }

    //  until the shim's H says otherwise (a boot sees it before anything is sent)
    handshake = canHandshake(VAmiga) && true === workerData.serialHandshake;

    try {
        if (workerData.snapshot) {
            emu = await createEmulator(VAmiga, false);
            const tr = performance.now();
            try {
                emu.loadSnapshot(workerData.snapshot);
                restored = true;
                restoreMs = performance.now() - tr;
            } catch (e) {
                //  A snapshot of another core (0.1.x), of another file, or
                //  whose file did not open (VAmigaError): the cache drops it,
                //  and this session boots instead
                post({ type: 'snapshotRefused', message: e.message, code: e.code });
                try {
                    emu.destroy();
                } catch (e2) {
                    //  replaced below regardless
                }
                emu = null;
                handshake = false;
            }
        }
        if (!emu) {
            emu = await createEmulator(VAmiga, true);
        }
        link = new HostLink({ helloSeen: restored });
    } catch (e) {
        //  ConfigError (EVAMIGA_CONFIG) or VAmigaError (EVAMIGA_CORE)
        postError(e, { during: 'create', fatal: true });
        return process.exit(1);
    }

    emu.on('message', m => {
        if ('CPU_HALT' === m.name) {
            postError(new Error('The emulated CPU halted'), {
                code: 'CPU_HALT',
                fatal: true,
            });
            if (pacer) {
                pacer.stop();
            }
        }
    });

    if (restored) {
        startSession();
    } else {
        emu.powerOn();
        state = 'booting';
    }

    pacer = new Pacer(emu, {
        onFrame,
        onError: err => postError(err, { during: 'run', fatal: true }),
    }).start();
}

main();
