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
 * workerData shape:
 * {
 *   module:          WebAssembly.Module - enigma-vamiga's, compiled once by the parent
 *   snapshot:        Uint8Array|null    - booted machine to restore (SharedArrayBuffer backed);
 *                                         null to boot from the image
 *   image:           string             - HDF path; the persist baseline
 *   rom, extRom:     string|undefined   - Kickstart override paths (boot only)
 *   machine:         { cpu, chipKb, slowKb, fastKb, overclock } (boot only)
 *   warpBootSeconds: number             - first boot runs flat out this long
 *   session:         { ... }            - `s` frame keys; `now` is added when it is sent
 * }
 *
 * MessagePort protocol (worker -> parent):
 *   { type: 'snapshot', snapshot: Uint8Array, ms }      - booted, idle, warp over: cache me
 *   { type: 'ready', restored, ms, restoreMs, hello, stats } - `s` has been sent
 *   { type: 'output', data: Uint8Array }                - door bytes (frames removed), per frame batch
 *   { type: 'frame', frame: { type, keys } }            - H, R, L, C, E (protocol frames)
 *   { type: 'exit', status, keys }                      - the shim's X frame (the first one only)
 *   { type: 'persisted', chunks, bytes, ms, refused }   - answer to 'persist'; |refused| says why
 *                                                         nothing was written (the image changed)
 *   { type: 'inputFull', limit }                        - caller input reached MaxInputQueueBytes
 *                                                         (once per session; the excess is dropped)
 *   { type: 'error', message, code, fatal }             - see below
 *   { type: 'stopped' }                                 - answer to 'stop', worker exits
 *
 * MessagePort protocol (parent -> worker):
 *   { type: 'input', data }                - caller bytes (escaped here)
 *   { type: 'frame', frame: { type, keys } } - send a host frame (t, d, w, e); `d` drops queued
 *                                            input, but finishes a frame or RS RS pair already begun
 *   { type: 'pause' } / { type: 'resume' } - output back-pressure: stop / restart the emulator
 *   { type: 'persist', path, tmp }         - after X: settle, then write the changed HDF chunks
 *                                            into |tmp| (a copy of the image) and rename it over
 *                                            the image
 *   { type: 'stop' }                       - shut down
 */

const { isMainThread, workerData, parentPort } = require('worker_threads');

//  module_util.js' initializeModules() require()s every *.js under core/ (and
//  one directory down) to look for an optional moduleInitialize export.
//  Without this guard the worker setup below would run in the main thread.
if (isMainThread) {
    return;
}

const fs = require('fs');
const paths = require('path');
const protocol = require('./protocol.js');
const { HostLink } = require('./host_link.js');

const { RS } = protocol;

//
//  Serial line discipline (shim protocol section 15). Caller input is never
//  dropped for being early: it waits here until the guest has room. What is
//  in flight is bounded twice:
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

//  Persist granularity: what differs from the baseline is written in blocks of
//  this size (a multiple of the 512-byte sector).
const PersistChunkBytes = 64 * 1024;

//  Amiga time to let the guest's file system flush before persisting: X comes
//  after the door has exited plus the shim's 2 s drain, and AmigaOS writes
//  back dirty buffers within a few seconds. 150 frames = 3 s, computed flat
//  out (about 0.15 s of host time).
const PersistSettleFrames = 150;

const t0 = performance.now();

let emu = null;
let pacer = null;
let link = null;
let state = 'starting'; //  starting | booting | warpEnding | session | exited | stopping
let inputDropped = 0;
let inputFullReported = false;
let restoreMs = null;
let baselineStat = null; //  the image file as this session read it

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
//  May the host send now? The guest's RTS (CIA-B PA6), which axshim 1.5
//  drops when its receive ring fills and while it starts a door. enigma-vamiga
//  0.1.2 does not expose it, so this is always true and the core's own flow
//  control (patch 0001's byte holding, or vAmiga's SER.HANDSHAKE once the core
//  has it) holds what is in flight. When the package exposes the line, this
//  is the one line to change (e.g. `return emu.serialRts !== false;`); the
//  window above keeps what is already in flight within the shim's headroom.
//
function guestClearToSend() {
    return true;
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

    post({
        type: 'ready',
        restored: !!workerData.snapshot,
        ms: performance.now() - t0,
        restoreMs,
        hello: link.hello,
        stats,
    });
}

function takeSnapshot() {
    const ts = performance.now();
    let snapshot;
    try {
        const { Compressor } = require('enigma-vamiga');
        snapshot = emu.takeSnapshot({ compressor: Compressor.LZ4 });
    } catch (e) {
        //  not fatal: this session runs, the next one boots again
        postError(e, { during: 'snapshot', fatal: false });
        return;
    }
    const copy = new Uint8Array(snapshot); //  own ArrayBuffer, safe to transfer
    post({ type: 'snapshot', snapshot: copy, ms: performance.now() - ts }, [copy.buffer]);
}

function handleFrame(frame) {
    switch (frame.type) {
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

function sameFile(a, b) {
    return (
        a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.dev === b.dev
    );
}

function fsyncDir(dir) {
    let fd;
    try {
        fd = fs.openSync(dir, 'r');
        fs.fsyncSync(fd);
    } catch (e) {
        //  not every platform syncs a directory; the rename stands regardless
    } finally {
        if (undefined !== fd) {
            fs.closeSync(fd);
        }
    }
}

//  A persist copies the image and renames the copy over it: the image's
//  directory must be writable with room for a second copy, and the image must
//  be a plain file, not a single-file bind mount (a rename onto one fails).
const PersistEnvErrors = ['EACCES', 'EPERM', 'EXDEV', 'EBUSY'];
const PersistHint =
    'persist needs a writable directory for the image with free space for a ' +
    'copy of it, and an image that is not a single-file bind mount';
const StaleTmpMs = 60 * 60 * 1000;

//  Remove this image's own abandoned copies (<image>.<pid>.<ms>.persist, a
//  crashed or killed persist) older than an hour; nothing else is touched.
function removeStaleCopies(target) {
    try {
        const dir = paths.dirname(target);
        const name = paths.basename(target);
        const mine = new RegExp(
            `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d+\\.\\d+\\.persist$`
        );
        for (const f of fs.readdirSync(dir)) {
            if (!mine.test(f)) {
                continue;
            }
            const full = paths.join(dir, f);
            try {
                if (Date.now() - fs.statSync(full).mtimeMs > StaleTmpMs) {
                    fs.unlinkSync(full);
                }
            } catch (e) {
                //  gone already, or not ours to remove
            }
        }
    } catch (e) {
        //  best effort
    }
}

//
//  Write the session's disk changes back to the image, atomically: the image
//  is copied to |tmp| beside it, the changed chunks go into the copy, the
//  copy is synced and renamed over the image. A crash, a kill or a full disk
//  at any point leaves the image as it was, never half written.
//
//  Nothing is written when the image is no longer the file this session read
//  its baseline from (someone else wrote it meanwhile): the changes would be
//  measured against the wrong disk.
//
function persist(path, tmp) {
    const ts = performance.now();
    let tmpMade = false;
    try {
        if (pacer) {
            pacer.stop();
        }
        emu.runFrames(PersistSettleFrames);
        emu.serialRead(); //  the shim's R after X; nobody is listening

        const target = fs.realpathSync(path);
        const changed = () =>
            baselineStat && !sameFile(baselineStat, fs.statSync(target));
        const refuse = () =>
            post({
                type: 'persisted',
                chunks: 0,
                bytes: 0,
                ms: performance.now() - ts,
                refused: 'the image changed during the session',
            });

        if (changed()) {
            return refuse();
        }

        const chunks = emu.hdfChangedChunks(PersistChunkBytes);
        let bytes = 0;
        if (chunks.length) {
            removeStaleCopies(target);
            tmp = tmp || `${target}.${process.pid}.${Date.now()}.persist`;
            if (paths.dirname(paths.resolve(tmp)) !== paths.dirname(target)) {
                throw new Error(`persist: ${tmp} is not beside ${target}`);
            }
            fs.copyFileSync(target, tmp, fs.constants.COPYFILE_EXCL);
            tmpMade = true;
            const fd = fs.openSync(tmp, 'r+');
            try {
                const size = fs.fstatSync(fd).size;
                if (size !== emu.hdfSize) {
                    throw new Error(
                        `persist: ${target} is ${size} bytes, the disk is ${emu.hdfSize}`
                    );
                }
                for (const { offset, data } of chunks) {
                    let w = 0;
                    while (w < data.length) {
                        w += fs.writeSync(fd, data, w, data.length - w, offset + w);
                    }
                    bytes += data.length;
                }
                fs.fsyncSync(fd);
            } finally {
                fs.closeSync(fd);
            }
            //  last look: the copy was taken from the file we expect
            if (changed()) {
                fs.unlinkSync(tmp);
                tmpMade = false;
                return refuse();
            }
            fs.renameSync(tmp, target);
            tmpMade = false;
            fsyncDir(paths.dirname(target));
        }
        post({
            type: 'persisted',
            chunks: chunks.length,
            bytes,
            ms: performance.now() - ts,
        });
    } catch (e) {
        if (tmpMade) {
            try {
                fs.unlinkSync(tmp);
            } catch (e2) {
                //  best effort
            }
        }
        if (PersistEnvErrors.includes(e.code)) {
            e.message = `${e.message} (${PersistHint})`;
        }
        postError(e, { during: 'persist', fatal: true });
    }
}

function stop() {
    if ('stopping' === state) {
        return;
    }
    state = 'stopping';
    try {
        if (pacer) {
            pacer.stop();
        }
        if (emu) {
            emu.destroy();
        }
    } catch (e) {
        //  going away regardless
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

        case 'persist':
            return persist(msg.path, msg.tmp);

        case 'stop':
            return stop();

        default:
            return;
    }
});

async function main() {
    let VAmiga;
    let Pacer;
    try {
        ({ VAmiga, Pacer } = require('enigma-vamiga'));
    } catch (e) {
        postError(new Error(`Cannot load enigma-vamiga: ${e.message}`), { fatal: true });
        return process.exit(1);
    }

    try {
        //  before the image is read: a write after this shows at persist time
        baselineStat = fs.statSync(workerData.image);
        if (workerData.snapshot) {
            //  RAM sizes are irrelevant here (the snapshot brings its own
            //  configuration); a small one keeps the peak down
            emu = await VAmiga.create({
                module: workerData.module,
                fastKb: 0,
                slowKb: 0,
            });
            const tr = performance.now();
            emu.loadSnapshot(workerData.snapshot);
            //  persist against the image file, not the snapshot's disk
            emu.markHdfClean(workerData.image);
            restoreMs = performance.now() - tr;
            link = new HostLink({ helloSeen: true });
        } else {
            const m = workerData.machine || {};
            emu = await VAmiga.create({
                module: workerData.module,
                hdf: workerData.image,
                rom: workerData.rom,
                ext: workerData.extRom,
                cpu: m.cpu,
                chipKb: m.chipKb,
                slowKb: m.slowKb,
                fastKb: m.fastKb,
                overclock: m.overclock,
                warpBootSeconds: workerData.warpBootSeconds,
            });
            link = new HostLink();
        }
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

    if (workerData.snapshot) {
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
