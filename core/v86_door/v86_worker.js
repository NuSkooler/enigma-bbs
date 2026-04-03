/* jslint node: true */
'use strict';

/**
 * v86_worker.js
 *
 * Worker thread that runs a v86 x86 emulator instance for a single DOS door session.
 * Spawned by v86_door.js via worker_threads. Communicates with the main thread via
 * MessagePort for I/O and lifecycle events.
 *
 * workerData shape:
 * {
 *   imagePath:    string   - path to the FreeDOS door disk image (hda)
 *   floppyBuffer: Buffer   - 1.44MB FAT12 floppy image with drop file (fda / A:)
 *   memoryMb:     number   - guest RAM in MB (default 64)
 *   biosPath:     string   - path to SeaBIOS image
 *   vgaBiosPath:  string   - path to VGA BIOS image
 * }
 *
 * MessagePort protocol (worker → parent):
 *   { type: 'ready' }                      - emulator loaded, serial I/O active
 *   { type: 'output', data: Buffer }        - bytes from COM1 (serial0-output-byte)
 *   { type: 'stopped', elapsed: number }   - emulator halted, worker will exit
 *   { type: 'error', message: string }     - fatal error before ready
 *
 * MessagePort protocol (parent → worker):
 *   { type: 'input', data: Buffer }        - bytes to send to COM1
 *   { type: 'stop' }                       - request clean shutdown
 */

const { workerData, parentPort } = require('worker_threads');
const { readFileSync } = require('fs');

const t0 = Date.now();

// ─── Load disk image synchronously ───────────────────────────────────────────
// async: true deadlocks in Node.js — v86's CPU loop starves the event loop,
// so disk read callbacks never fire. Sync load is required.

let diskBuffer;
try {
    diskBuffer = readFileSync(workerData.imagePath);
} catch (err) {
    parentPort.postMessage({
        type: 'error',
        message: `Cannot read disk image: ${err.message}`,
    });
    process.exit(1);
}

let biosBuffer;
let vgaBiosBuffer;
try {
    biosBuffer = readFileSync(workerData.biosPath);
    vgaBiosBuffer = readFileSync(workerData.vgaBiosPath);
} catch (err) {
    parentPort.postMessage({
        type: 'error',
        message: `Cannot read BIOS: ${err.message}`,
    });
    process.exit(1);
}

// ─── Start emulator ───────────────────────────────────────────────────────────

let V86;
let v86WasmPath;
try {
    ({ V86 } = require('v86'));
    // Resolve the WASM file relative to the v86 package — not relative to CWD
    v86WasmPath = require('path').join(
        require('path').dirname(require.resolve('v86')),
        'v86.wasm'
    );
} catch (err) {
    parentPort.postMessage({ type: 'error', message: `Cannot load v86: ${err.message}` });
    process.exit(1);
}

const memoryMb = workerData.memoryMb || 64;

const emulator = new V86({
    wasm_path: v86WasmPath,
    bios: {
        buffer: biosBuffer.buffer.slice(
            biosBuffer.byteOffset,
            biosBuffer.byteOffset + biosBuffer.byteLength
        ),
    },
    vga_bios: {
        buffer: vgaBiosBuffer.buffer.slice(
            vgaBiosBuffer.byteOffset,
            vgaBiosBuffer.byteOffset + vgaBiosBuffer.byteLength
        ),
    },

    // HDD: door image (C: in FreeDOS) — sync, no async (would deadlock)
    hda: {
        buffer: diskBuffer.buffer.slice(
            diskBuffer.byteOffset,
            diskBuffer.byteOffset + diskBuffer.byteLength
        ),
        async: false,
    },

    // Floppy: drop file image (A: in FreeDOS)
    fda: {
        buffer: workerData.floppyBuffer.buffer.slice(
            workerData.floppyBuffer.byteOffset,
            workerData.floppyBuffer.byteOffset + workerData.floppyBuffer.byteLength
        ),
        async: false,
    },

    // Boot from HDD first. Without this, v86 defaults to floppy-first (boot_order 801)
    // when fda is set. Our FAT12 floppy has a valid 0x55AA boot signature (written by fatfs)
    // but no bootable code — the CPU would execute garbage and hang.
    boot_order: 786,

    memory_size: memoryMb * 1024 * 1024,
    vga_memory_size: 2 * 1024 * 1024,

    screen_dummy: true,
    autostart: true,
    disable_keyboard: true,
    disable_mouse: true,
});

// ─── Lifecycle ────────────────────────────────────────────────────────────────

emulator.add_listener('emulator-loaded', () => {
    // Assert DCD + DSR + CTS on COM1 so door games see a live connection
    emulator.serial_set_modem_status(0, 0xb0);
    parentPort.postMessage({ type: 'ready' });
});

// ─── Serial I/O ───────────────────────────────────────────────────────────────

// Buffer serial output and flush in batches — one postMessage per byte would
// generate hundreds of cross-thread messages per second during ANSI rendering.
let outputBuf = [];
let flushTimer = null;

emulator.add_listener('serial0-output-byte', byte => {
    outputBuf.push(byte);
    if (!flushTimer) {
        flushTimer = setTimeout(() => {
            parentPort.postMessage({ type: 'output', data: Buffer.from(outputBuf) });
            outputBuf = [];
            flushTimer = null;
        }, 5);
    }
});

parentPort.on('message', msg => {
    switch (msg.type) {
        case 'input':
            emulator.serial0_send(Buffer.from(msg.data).toString('binary'));
            break;

        case 'stop':
            shutdown();
            break;

        default:
            break;
    }
});

// ─── Shutdown ────────────────────────────────────────────────────────────────

let shutdownStarted = false;

function shutdown() {
    if (shutdownStarted) return;
    shutdownStarted = true;
    emulator.stop();
    setTimeout(() => {
        const elapsed = Date.now() - t0;
        parentPort.postMessage({ type: 'stopped', elapsed });
        process.exit(0);
    }, 500);
}

emulator.add_listener('emulator-stopped', () => {
    shutdown();
});

// Detect CPU halt: FDAPM POWEROFF halts the CPU but doesn't always fire
// 'emulator-stopped'. If the instruction counter stops advancing (with ic > 1M),
// the CPU is halted — trigger shutdown.
let lastInsnCount = 0;
let haltTicks = 0;
const HALT_TICKS_REQUIRED = 2; // 2 × 5s = 10 seconds of no progress

const haltTimer = setInterval(() => {
    const ic = emulator.get_instruction_counter();
    if (ic === lastInsnCount && ic > 1_000_000) {
        haltTicks++;
        if (haltTicks >= HALT_TICKS_REQUIRED) {
            clearInterval(haltTimer);
            shutdown();
        }
    } else {
        haltTicks = 0;
    }
    lastInsnCount = ic;
}, 5000);
