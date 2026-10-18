'use strict';

//
//  A stand-in for enigma-vamiga inside the worker thread. It is driven over
//  the worker's own parent port, so its commands and the worker's messages
//  stay in one order:
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
//    { type: 'fake', cmd: 'changes', chunks }  what hdfChangedChunks() returns
//    { type: 'fake', cmd: 'state' }            report pacer and settle state
//    { type: 'fake', cmd: 'hdfSize', size }    what hdfSize reports
//    { type: 'fake', cmd: 'failOnce', method, code }
//                                              the next fs[method] throws |code|
//    { type: 'fake', cmd: 'touchOnFsync', path }
//                                              the next fsyncSync also rewrites
//                                              |path|'s mtime (someone else
//                                              wrote the image mid-persist)
//
//  Replies: { type: 'fake', event: 'created' | 'ticked' | 'state', ... }
//  ('created' and 'state' carry the RTS/CTS handshake setting);
//  'ticked' carries the bytes the guest received during that frame.
//
const fs = require('fs');
const { EventEmitter } = require('events');
const { parentPort, workerData } = require('worker_threads');

let emu = null;
let pacer = null;

class VAmiga extends EventEmitter {
    static async create(opts) {
        emu = new VAmiga(opts);
        parentPort.postMessage({
            type: 'fake',
            event: 'created',
            hdf: opts.hdf,
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
        this.changes = [];
        this.settled = 0;
        this.baseline = opts.hdf || null;
        this.handshake = true === opts.serialHandshake;
        this.rts = true;
        this.size = fs.statSync(workerData.image).size;
    }

    get hdfSize() {
        return this.size;
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
        return this;
    }

    markHdfClean(baseline) {
        this.baseline = baseline;
        return this;
    }

    setOption() {}

    powerOn() {}

    stats() {
        return { wasmMemoryBytes: 0 };
    }

    takeSnapshot() {
        return new Uint8Array([1, 2, 3]);
    }

    runFrames(n) {
        this.settled += n;
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

    hdfChangedChunks() {
        return this.changes;
    }

    destroy() {}
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
            pacer.onFrame({ frames: 1, warping: false });
            parentPort.postMessage({
                type: 'fake',
                event: 'ticked',
                received: new Uint8Array(Buffer.concat(emu.received)),
            });
            break;
        }

        case 'changes':
            emu.changes = msg.chunks.map(c => ({
                offset: c.offset,
                data: Buffer.from(c.data),
            }));
            break;

        case 'hdfSize':
            emu.size = msg.size;
            break;

        case 'failOnce': {
            const original = fs[msg.method];
            fs[msg.method] = () => {
                fs[msg.method] = original;
                throw Object.assign(new Error(`${msg.code}: ${msg.method} (fake)`), {
                    code: msg.code,
                });
            };
            break;
        }

        case 'touchOnFsync': {
            const original = fs.fsyncSync;
            fs.fsyncSync = (...args) => {
                fs.fsyncSync = original;
                const r = original(...args);
                const later = new Date(Date.now() + 10000);
                fs.utimesSync(msg.path, later, later);
                return r;
            };
            break;
        }

        case 'state':
            parentPort.postMessage({
                type: 'fake',
                event: 'state',
                running: pacer ? pacer.running : null,
                settled: emu ? emu.settled : null,
                serialHandshake: emu ? emu.handshake : null,
            });
            break;

        default:
            break;
    }
});

module.exports = {
    VAmiga,
    Pacer,
    Compressor: { LZ4: 'lz4' },
};
