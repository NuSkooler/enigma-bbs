'use strict';

//
//  A stand-in for enigma-vamiga 0.2.0 inside the worker thread: a file-backed
//  disk whose guest writes reach the image as write-through says. It is
//  driven over the worker's own parent port, so its commands and the worker's
//  messages stay in one order:
//
//    { type: 'fake', cmd: 'shim', bytes }      the shim sends these bytes
//    { type: 'fake', cmd: 'tick', room, pending, rts }
//                                              run one frame; the core accepts at
//                                              most |room| bytes (default: all) and
//                                              reports |pending| (default 0) of the
//                                              ones before as not yet taken by the
//                                              guest (serialInPending); |rts|, when
//                                              given, is the guest's RTS from now on
//                                              (guestRts, initially true)
//    { type: 'fake', cmd: 'write', offset, data }
//                                              the guest writes the disk: a dirty
//                                              page that reaches the image at the
//                                              next frame unless writeThrough is
//                                              'never' (the drive going idle), or on
//                                              hdfFlush()/hdfSync()/takeSnapshot()
//    { type: 'fake', cmd: 'settleWrite', offset, data }
//                                              the same, made by the guest only
//                                              once the worker runs frames to let
//                                              its file system flush
//    { type: 'fake', cmd: 'failSync', message } the next hdfSync() throws
//    { type: 'fake', cmd: 'state' }            report pacer, settle and disk state
//
//  workerData.refuseSnapshot: loadSnapshot() throws a VAmigaError, as 0.2.0
//  does for a 0.1.x snapshot or one of another file.
//  workerData.legacyPackage: no setSerialHandshake, serialHandshake, guestRts or
//  serialInPending (enigma-vamiga 0.1.2 and older).
//
//  Replies: { type: 'fake', event: 'created' | 'ticked' | 'state', ... }
//  ('created' carries the create() options that matter here, and 'state' the
//  RTS/CTS handshake setting); 'ticked' carries the bytes the guest received
//  during that frame.
//
const fs = require('fs');
const { EventEmitter } = require('events');
const { parentPort, workerData } = require('worker_threads');

let emu = null;
let pacer = null;
let creates = 0;

class VAmigaError extends Error {
    constructor(message) {
        super(message);
        this.name = 'VAmigaError';
        this.code = 'EVAMIGA_CORE';
    }
}

class VAmiga extends EventEmitter {
    static async create(opts) {
        emu = new VAmiga(opts);
        creates += 1;
        parentPort.postMessage({
            type: 'fake',
            event: 'created',
            creates,
            hdf: opts.hdf,
            writeThrough: opts.writeThrough,
            fastKb: opts.fastKb,
            rom: opts.rom,
            warpBootSeconds: opts.warpBootSeconds,
            serialHandshake: opts.serialHandshake,
        });
        return emu;
    }

    constructor(opts) {
        super();
        this.opts = opts;
        this.toHost = [];
        this.received = [];
        this.room = Infinity;
        this.pending = 0;
        this.settled = 0;
        this.syncs = 0;
        this.handshake = true === opts.serialHandshake;
        this.rts = true;
        this.file = opts.hdf && 'file' === opts.hdf.mode ? opts.hdf.path : null;
        this._writeThrough = opts.writeThrough || 'never';
        this.dirty = []; //  [{ offset, data }] the image does not have yet
        this.onSettle = []; //  writes the guest makes when given time to flush
        this.io = { writes: 0, bytes: 0, ms: 0 };
        this.failSync = null;
        this.destroyed = false;
    }

    get hdfSize() {
        return this.file ? fs.statSync(this.file).size : 0;
    }

    get hdfMode() {
        return this.file ? 'file' : null;
    }

    get hdfPath() {
        return this.file;
    }

    get hdfPending() {
        return this.dirty.length > 0;
    }

    get writeThrough() {
        return this._writeThrough;
    }

    setWriteThrough(mode) {
        this._writeThrough = mode;
        if ('never' !== mode) {
            this.hdfFlush();
        }
        return this;
    }

    get hdfWriteStats() {
        return Object.assign({}, this.io);
    }

    hdfFlush() {
        const before = this.io.writes;
        const fd = fs.openSync(this.file, 'r+');
        try {
            for (const { offset, data } of this.dirty) {
                fs.writeSync(fd, data, 0, data.length, offset);
                this.io.writes += 1;
                this.io.bytes += data.length;
            }
        } finally {
            fs.closeSync(fd);
        }
        this.dirty = [];
        return { writes: this.io.writes - before };
    }

    hdfSync() {
        this.syncs += 1;
        if (this.failSync) {
            const message = this.failSync;
            this.failSync = null;
            throw new VAmigaError(message);
        }
        return this.hdfFlush();
    }

    get serialInPending() {
        return this.pending;
    }

    get guestRts() {
        return this.rts;
    }

    get serialHandshake() {
        return this.handshake;
    }

    setSerialHandshake(on) {
        this.handshake = !!on;
        return this;
    }

    loadSnapshot() {
        if (workerData.refuseSnapshot) {
            throw new VAmigaError('Snapshot was created with an older version of vAmiga');
        }
        return this;
    }

    setOption() {}

    powerOn() {}

    stats() {
        return {
            wasmMemoryBytes: 0,
            hdfMode: this.hdfMode,
            hdfPending: this.hdfPending,
            hdfWrites: this.io.writes,
            hdfBytesWritten: this.io.bytes,
        };
    }

    takeSnapshot() {
        //  as the core: pending changes go into the file first, whatever the mode
        if (this.file) {
            this.hdfFlush();
        }
        return new Uint8Array([1, 2, 3]);
    }

    runFrames(n) {
        this.settled += n;
        if (this.onSettle.length) {
            this.dirty.push(...this.onSettle);
            this.onSettle = [];
        }
        if ('never' !== this._writeThrough && this.dirty.length) {
            this.hdfFlush(); //  the drive went idle
        }
        return false;
    }

    serialRead() {
        const out = Buffer.concat(this.toHost);
        this.toHost = [];
        return out;
    }

    serialWrite(buf) {
        const n = Math.min(buf.length, this.room);
        this.room -= n;
        if (n > 0) {
            this.received.push(Buffer.from(buf.subarray(0, n)));
        }
        return n;
    }

    destroy() {
        //  as the core: what was never written goes with the emulator
        this.dirty = [];
        this.destroyed = true;
    }
}

if (workerData.legacyPackage) {
    for (const k of [
        'setSerialHandshake',
        'serialHandshake',
        'guestRts',
        'serialInPending',
    ]) {
        delete VAmiga.prototype[k];
    }
}

class Pacer {
    constructor(e, { onFrame }) {
        this.onFrame = onFrame;
        this._running = false;
        pacer = this;
    }

    get running() {
        return this._running;
    }

    start() {
        this._running = true;
        return this;
    }

    stop() {
        this._running = false;
        return this;
    }
}

parentPort.on('message', msg => {
    if ('fake' !== msg.type) {
        return;
    }
    switch (msg.cmd) {
        case 'shim':
            emu.toHost.push(Buffer.from(msg.bytes));
            break;

        case 'tick': {
            emu.room = undefined === msg.room ? Infinity : msg.room;
            emu.pending = msg.pending || 0;
            if (undefined !== msg.rts) {
                emu.rts = msg.rts;
            }
            emu.received = [];
            //  the frame's disk activity: write-through when the drive idles
            if ('never' !== emu._writeThrough && emu.dirty.length) {
                emu.hdfFlush();
            }
            pacer.onFrame({ frames: 1, warping: false });
            parentPort.postMessage({
                type: 'fake',
                event: 'ticked',
                received: new Uint8Array(Buffer.concat(emu.received)),
            });
            break;
        }

        case 'write':
            emu.dirty.push({ offset: msg.offset, data: Buffer.from(msg.data) });
            break;

        case 'settleWrite':
            emu.onSettle.push({ offset: msg.offset, data: Buffer.from(msg.data) });
            break;

        case 'failSync':
            emu.failSync = msg.message;
            break;

        case 'state':
            parentPort.postMessage({
                type: 'fake',
                event: 'state',
                running: pacer ? pacer.running : null,
                settled: emu ? emu.settled : null,
                syncs: emu ? emu.syncs : null,
                pending: emu ? emu.hdfPending : null,
                writeThrough: emu ? emu.writeThrough : null,
                serialHandshake: emu ? emu.handshake : null,
            });
            break;

        default:
            break;
    }
});

module.exports = {
    VAmiga,
    VAmigaError,
    Pacer,
    Compressor: { LZ4: 'lz4' },
};
