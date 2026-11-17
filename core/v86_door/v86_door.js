/* jslint node: true */
'use strict';

/**
 * v86_door.js — ENiGMA½ native x86/DOS door emulation module
 *
 * Boots a FreeDOS disk image in a v86 x86 emulator (worker thread) and bridges
 * the user's connection to the emulated COM1 port. No external emulator required.
 *
 * The emulator runs in a worker_threads Worker to avoid blocking ENiGMA's event loop.
 * A 1.44MB FAT12 floppy image containing the drop file is built in memory and
 * mounted as A: in FreeDOS. The op's AUTOEXEC.BAT copies it to the door directory.
 *
 * Config (menu.hjson):
 *   module: v86_door
 *   config: {
 *     name:         string   - door name (required, used for node count tracking)
 *     image:        string   - path to FreeDOS door disk image (required)
 *     dropFileType: string   - DORINFO | DOOR | DOOR32 (optional, default: none)
 *     nodeMax:      number   - max concurrent sessions, 0 = unlimited (default: 0)
 *     tooManyArt:   string   - art file to show when nodeMax exceeded (optional)
 *     memoryMb:     number   - guest RAM in MB (default: 64)
 *     biosPath:     string   - path to SeaBIOS image (default: {enigma_root}/bios/seabios.bin)
 *     vgaBiosPath:  string   - path to VGA BIOS image (default: {enigma_root}/bios/vgabios.bin)
 *   }
 *
 * Drop file filename on A: drive:
 *   DORINFO → DORINFOx.DEF (x = node-based suffix, per DORINFO spec)
 *   DOOR    → DOOR.SYS
 *   DOOR32  → door32.sys
 *
 * BIOS files are not bundled with the v86 npm package. install.sh downloads them automatically
 * to misc/v86_bios/. To download manually:
 *   curl -fL https://github.com/copy/v86/raw/master/bios/seabios.bin -o misc/v86_bios/seabios.bin
 *   curl -fL https://github.com/copy/v86/raw/master/bios/vgabios.bin -o misc/v86_bios/vgabios.bin
 */

const { MenuModule } = require('../menu_module.js');
const { Errors } = require('../enig_error.js');
//  through the module objects, not destructured, so that tests can stand in
const DoorUtil = require('../door_util.js');
const FatImage = require('./fat_image.js');
const Events = require('../events.js');
const DropFile = require('../dropfile.js');
const theme = require('../theme.js');
const ansi = require('../ansi_term.js');

//  deps
const async = require('async');
const _ = require('lodash');
const paths = require('path');
const { existsSync } = require('fs');
const fsp = require('fs').promises;
const { Worker } = require('worker_threads');

const WORKER_PATH = paths.join(__dirname, 'v86_worker.js');
const ENIGMA_ROOT = paths.join(__dirname, '..', '..');
const DEFAULT_BIOS_PATH = paths.join(ENIGMA_ROOT, 'misc', 'v86_bios', 'seabios.bin');
const DEFAULT_VGA_BIOS_PATH = paths.join(ENIGMA_ROOT, 'misc', 'v86_bios', 'vgabios.bin');

//  Track active instances per door name (mirrors abracadabra pattern)
const activeDoorInstances = {};

//  Sessions from the slot being taken until their image has been flushed
//  and released (see _finishRun()); what shutdown() waits for
const runningSessions = new Set();

const Timeouts = {
    //  how long a worker may take to stop after terminate() before the
    //  session flushes the image anyway
    terminateMs: 5 * 1000,
    //  how long a server shutdown waits for session-end image flushes
    shutdownFlushMs: 5 * 1000,
    //  how long an image no session uses is kept in memory
    imageIdleMs: 10 * 60 * 1000,
};

//  An image is read and written in pieces of this size, so that a large one
//  never holds the event loop for long
const ImageChunkBytes = 16 * 1024 * 1024;

// ─── SAB image registry ───────────────────────────────────────────────────────
// Maps imagePath → {
//   path, sab: SharedArrayBuffer, refs, ready: Promise<SharedArrayBuffer>,
//   mtimeMs, size: the file as last read or written,
//   dirty: the last flush failed, so the SAB holds writes the file does not,
//   idleTimer, flushQueue: Promise (never rejects), flushPending: Promise | null
// }
//
// All concurrent sessions for the same image path share one SAB. Guest writes go
// directly into the SAB with no cross-instance coordination — this is an accepted
// race (Option A). In practice the window is tiny: simultaneous overlapping sector
// writes require two guests to be in the same FAT metadata or file-data sector at
// the exact same CPU cycle. For casual BBS use this is acceptable; implement the
// ENIGLOCK.COM TSR approach (Option C) if real-world corruption is observed.
//
// Each session holds a reference from acquireImage() until its flush at session
// end has landed (releaseImage()). When the last one is out the entry stays,
// idle, for Timeouts.imageIdleMs, and the next session reuses its SAB. Before
// it does, the file is checked: one changed on disk meanwhile (oputil v86
// console/desktop) is read again, into the same SAB if the size is unchanged,
// so that the change is not overwritten by the next flush. An entry whose last
// flush failed (dirty) keeps what the guests wrote over any change on disk,
// and is never dropped: the next session's flush tries the write again.
//
// flushQueue serializes SAB → disk writes so two exiting sessions never write
// the same path at the same time. At most one flush runs and one waits: a
// flush asked for while one is already waiting shares the waiting one, which
// reads the SAB only when it starts.
const imageRegistry = new Map();

//
//  Read the file into |sab| if it is the file's size, else into a new one.
//  Resolves with { sab, mtimeMs, size }.
//
async function readImage(imagePath, sab = null) {
    const fh = await fsp.open(imagePath, 'r');
    try {
        const { size, mtimeMs } = await fh.stat();
        if (!sab || sab.byteLength !== size) {
            sab = new SharedArrayBuffer(size);
        }
        let offset = 0;
        while (offset < size) {
            const length = Math.min(ImageChunkBytes, size - offset);
            const { bytesRead } = await fh.read(
                new Uint8Array(sab, offset, length),
                0,
                length,
                offset
            );
            if (0 === bytesRead) {
                throw new Error(`short read at ${offset} of ${size} bytes`);
            }
            offset += bytesRead;
        }
        return { sab, mtimeMs, size };
    } finally {
        await fh.close();
    }
}

//
//  Write the image over the file in place: never truncated, so a write that
//  is cut short (the process killed mid-flush) leaves a full-size image with
//  a mix of old and new sectors rather than a short one, and the file keeps
//  its inode, links, ownership and permissions, and works as a single-file
//  bind mount. Resolves with the file's { mtimeMs, size } once written.
//
async function writeImage(imagePath, sab) {
    const fh = await fsp.open(imagePath, 'r+');
    try {
        const view = new Uint8Array(sab);
        let offset = 0;
        while (offset < view.byteLength) {
            const length = Math.min(ImageChunkBytes, view.byteLength - offset);
            const { bytesWritten } = await fh.write(view, offset, length, offset);
            offset += bytesWritten;
        }
        await fh.sync();
    } finally {
        await fh.close();
    }
    const { mtimeMs, size } = await fsp.stat(imagePath);
    return { mtimeMs, size };
}

function setLoaded(entry, { sab, mtimeMs, size }) {
    entry.sab = sab;
    entry.mtimeMs = mtimeMs;
    entry.size = size;
    return sab;
}

//
//  An idle entry is about to be used again: read the file again if it has
//  changed on disk since it was last read or written, unless the entry holds
//  writes the file does not (dirty), which win.
//
async function refreshImage(entry, log) {
    const { mtimeMs, size } = await fsp.stat(entry.path);
    if (mtimeMs === entry.mtimeMs && size === entry.size) {
        return entry.sab;
    }
    if (entry.dirty) {
        (log || require('../logger.js').log).warn(
            { image: entry.path },
            'v86 door image changed on disk while a failed write was pending; keeping the image in memory, which the next write puts back'
        );
        return entry.sab;
    }
    return setLoaded(entry, await readImage(entry.path, entry.sab));
}

function clearIdleTimer(entry) {
    if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
    }
}

//  Take a reference on |imagePath|'s entry, loading the image on first use.
//  Resolves with the entry; rejects (holding no reference) if it cannot load.
function acquireImage(imagePath, log) {
    let entry = imageRegistry.get(imagePath);
    const forget = err => {
        if (imageRegistry.get(imagePath) === entry) {
            imageRegistry.delete(imagePath);
        }
        throw err;
    };
    if (!entry) {
        entry = {
            path: imagePath,
            sab: null,
            refs: 0,
            mtimeMs: null,
            size: null,
            dirty: false,
            idleTimer: null,
            flushQueue: Promise.resolve(),
            flushPending: null,
        };
        entry.ready = readImage(imagePath).then(r => setLoaded(entry, r), forget);
        imageRegistry.set(imagePath, entry);
    } else if (0 === entry.refs) {
        //  idle: whoever comes next while this runs shares it
        clearIdleTimer(entry);
        entry.ready = entry.flushQueue
            .then(() => refreshImage(entry, log))
            .catch(err => {
                if (entry.dirty) {
                    //  the file cannot be checked; what is in memory is
                    //  what the next write puts back
                    return entry.sab;
                }
                return forget(err);
            });
    }
    entry.refs += 1;
    return entry.ready.then(
        () => entry,
        err => {
            entry.refs -= 1;
            throw err;
        }
    );
}

//  Drop a reference. Once the last is gone and its flush is done the entry
//  is idle; it is dropped after Timeouts.imageIdleMs unless it is dirty or
//  in use again by then.
function releaseImage(entry) {
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs > 0) {
        return Promise.resolve();
    }
    return entry.flushQueue.then(() => {
        if (0 !== entry.refs || imageRegistry.get(entry.path) !== entry) {
            return;
        }
        clearIdleTimer(entry);
        entry.idleTimer = setTimeout(() => {
            entry.idleTimer = null;
            if (
                0 === entry.refs &&
                !entry.dirty &&
                imageRegistry.get(entry.path) === entry
            ) {
                imageRegistry.delete(entry.path);
            }
        }, Timeouts.imageIdleMs);
        entry.idleTimer.unref();
    });
}

//
//  Queue a write of |entry|'s SAB to its file. Resolves with { ok, error }
//  and never rejects: a failed flush is logged, marks the entry dirty, and
//  does not keep later ones from running.
//
function flushImage(entry, log) {
    if (!entry || !entry.sab) {
        return Promise.resolve({ ok: false, error: 'not loaded' });
    }
    if (entry.flushPending) {
        return entry.flushPending;
    }
    const flush = entry.flushQueue
        .then(() => {
            //  started: a flush asked for from now on reads the SAB again
            entry.flushPending = null;
            return writeImage(entry.path, entry.sab);
        })
        .then(
            ({ mtimeMs, size }) => {
                entry.mtimeMs = mtimeMs;
                entry.size = size;
                entry.dirty = false;
                return { ok: true };
            },
            err => {
                entry.dirty = true;
                if (log) {
                    log.warn(
                        { image: entry.path, error: err.message },
                        'v86 door image flush failed; what the guest wrote since the last flush is not on disk yet (kept in memory and written at the next session end)'
                    );
                }
                return { ok: false, error: err.message };
            }
        );
    entry.flushPending = flush;
    entry.flushQueue = flush;
    return flush;
}

//  terminate() and wait for the thread to go, at most |ms|
function terminateWorker(worker, ms) {
    return new Promise(resolve => {
        const timer = setTimeout(resolve, ms);
        let stopping;
        try {
            stopping = Promise.resolve(worker.terminate());
        } catch (e) {
            stopping = Promise.resolve();
        }
        stopping
            .catch(() => {})
            .then(() => {
                clearTimeout(timer);
                resolve();
            });
    });
}

//  so that no idle image's timer is left behind at shutdown
function clearIdleTimers() {
    for (const entry of imageRegistry.values()) {
        clearIdleTimer(entry);
    }
}

//
//  Server shutdown (bbs.js shutdownSystem, after the callers have been
//  disconnected): end every session still running and wait, at most
//  |timeoutMs|, for each one's image flush. Best effort: what has not been
//  flushed by then is logged. Calls back without an error, always.
//
function shutdown(cb, { timeoutMs = Timeouts.shutdownFlushMs, log } = {}) {
    clearIdleTimers();
    const sessions = [...runningSessions];
    if (0 === sessions.length) {
        return cb(null);
    }
    log = log || require('../logger.js').log;
    const t0 = Date.now();

    for (const s of sessions) {
        try {
            s._stopRun('shutdown');
        } catch (e) {
            //  best effort; it is reported as not flushed
        }
    }

    let timer = null;
    let reported = false;
    const report = () => {
        if (reported) {
            return;
        }
        reported = true;
        clearTimeout(timer);
        clearIdleTimers();

        //  by image: sessions on the same image share its flushes
        const images = new Map();
        for (const s of sessions) {
            const run = s._run;
            if (!run.image) {
                continue; //  never got as far as the image
            }
            const was = images.get(run.image.path);
            const r = run.flushResult;
            const now = r ? (r.ok ? 'ok' : r.error) : 'not finished';
            if (!was || 'ok' === was) {
                images.set(run.image.path, now);
            }
        }
        const flushed = [];
        const notFlushed = [];
        for (const [image, r] of images) {
            if ('ok' === r) {
                flushed.push(image);
            } else {
                notFlushed.push({ image, why: r });
            }
        }
        (notFlushed.length ? log.warn : log.info).call(
            log,
            { flushed, notFlushed, ms: Date.now() - t0 },
            `v86 doors at shutdown: ${flushed.length} images flushed, ${notFlushed.length} not`
        );
        return cb(null);
    };

    timer = setTimeout(report, timeoutMs);
    Promise.all(sessions.map(s => s._run.settled)).then(report);
}

exports.moduleInfo = {
    name: 'V86Door',
    desc: 'Native x86/DOS Door Emulation via v86',
    author: 'NuSkooler',
};

exports.getModule = class V86DoorModule extends MenuModule {
    constructor(options) {
        super(options);

        this.config = options.menuConfig.config || {};
        this.config.nodeMax = this.config.nodeMax || 0;
        this.config.memoryMb = this.config.memoryMb || 64;

        this.config.biosPath = this.config.biosPath || DEFAULT_BIOS_PATH;
        this.config.vgaBiosPath = this.config.vgaBiosPath || DEFAULT_VGA_BIOS_PATH;
    }

    initSequence() {
        const self = this;

        async.series(
            [
                function validateConfig(callback) {
                    return self.validateConfigFields(
                        { name: 'string', image: 'string' },
                        callback
                    );
                },

                function checkBios(callback) {
                    for (const [label, p] of [
                        ['biosPath', self.config.biosPath],
                        ['vgaBiosPath', self.config.vgaBiosPath],
                    ]) {
                        if (!existsSync(p)) {
                            return callback(
                                Errors.MissingConfig(
                                    `v86_door: ${label} not found: ${p}\n` +
                                        'Download BIOS files from https://github.com/copy/v86/tree/master/bios'
                                )
                            );
                        }
                    }
                    return callback(null);
                },

                function checkImage(callback) {
                    if (!existsSync(self.config.image)) {
                        return callback(
                            Errors.MissingConfig(
                                `v86_door: disk image not found: ${self.config.image}`
                            )
                        );
                    }
                    return callback(null);
                },

                function validateNodeCount(callback) {
                    const name = self.config.name;
                    if (
                        self.config.nodeMax > 0 &&
                        _.isNumber(activeDoorInstances[name]) &&
                        activeDoorInstances[name] + 1 > self.config.nodeMax
                    ) {
                        self.client.log.info(
                            { name, activeCount: activeDoorInstances[name] },
                            `Too many active instances of door "${name}"`
                        );

                        if (_.isString(self.config.tooManyArt)) {
                            theme.displayThemeArt(
                                { client: self.client, name: self.config.tooManyArt },
                                () => {
                                    self.pausePrompt(() =>
                                        callback(
                                            Errors.AccessDenied(
                                                'Too many active instances'
                                            )
                                        )
                                    );
                                }
                            );
                        } else {
                            self.client.term.write(
                                '\nToo many active instances. Try again later.\n'
                            );
                            self.pausePrompt(() =>
                                callback(Errors.AccessDenied('Too many active instances'))
                            );
                        }
                    } else {
                        self._beginRun();
                        return callback(null);
                    }
                },

                function buildFloppy(callback) {
                    const dropFileType = (self.config.dropFileType || '').toUpperCase();
                    const hasDropFile = dropFileType && dropFileType !== 'NONE';
                    const hasRunBatch =
                        _.isString(self.config.runBatch) &&
                        self.config.runBatch.trim().length > 0;

                    if (!hasDropFile && !hasRunBatch) {
                        self.floppyBuffer = null;
                        return callback(null);
                    }

                    const floppyFiles = [];
                    let dropFileName = '';

                    if (hasDropFile) {
                        //  BBSDEV.DRP is found through an environment
                        //  variable the guest never sees, and its serial modes
                        //  name a host descriptor rather than the guest's COM1
                        if ('BBSDEV' === dropFileType) {
                            return callback(
                                Errors.MissingConfig(
                                    'v86_door: BBSDEV.DRP needs the BBSDEV_DRP environment variable, which a v86 guest cannot be given (use DORINFO, DOOR, or DOOR32)'
                                )
                            );
                        }

                        const dropFile = new DropFile(self.client, {
                            fileType: dropFileType,
                            //  the guest sees COM1; v86_worker bridges the
                            //  user's connection to serial0
                            commType: 'serial',
                        });
                        if (!dropFile.isSupported()) {
                            return callback(
                                Errors.MissingConfig(
                                    `v86_door: unsupported dropFileType "${dropFileType}" (use DORINFO, DOOR, or DOOR32)`
                                )
                            );
                        }
                        dropFileName = dropFile.fileName;
                        floppyFiles.push({
                            name: dropFileName,
                            content: dropFile.getContents(),
                        });
                    }

                    if (hasRunBatch) {
                        //  Variable substitution: {dropFile}, {node}, {baud}
                        const runBatchText = self.config.runBatch
                            .replace(/\{dropFile\}/gi, dropFileName)
                            .replace(/\{node\}/gi, String(self.client.node))
                            .replace(/\{baud\}/gi, '57600');

                        //  Normalize to CRLF — DOS requires it
                        const runBatchCrlf = runBatchText
                            .replace(/\r\n/g, '\n')
                            .replace(/\n/g, '\r\n');

                        floppyFiles.push({
                            name: 'RUN.BAT',
                            content: Buffer.from(runBatchCrlf, 'ascii'),
                        });
                    }

                    //  callback is outside the promise chain: a throw further
                    //  along the series must not come back here as a rejection
                    //  and call it a second time
                    FatImage.createFloppyWithFiles(floppyFiles).then(
                        img => {
                            self.floppyBuffer = img;
                            setImmediate(() => callback(null));
                        },
                        err => setImmediate(() => callback(err))
                    );
                },

                function loadImage(callback) {
                    const run = self._run;
                    if (run.hungUp) {
                        return callback(null); //  gone while the floppy was built
                    }

                    run.doorTracking = DoorUtil.trackDoorRunBegin(
                        self.client,
                        self.config.name
                    );

                    //  Load (or reuse) the SAB-backed disk image for this session
                    acquireImage(self.config.image, self.client.log).then(
                        entry => {
                            run.image = entry;
                            setImmediate(() => callback(null));
                        },
                        err => setImmediate(() => callback(err))
                    );
                },

                function runDoor(callback) {
                    if (self._run.hungUp) {
                        return callback(null); //  gone while the image loaded
                    }
                    return self._runWorker(callback);
                },
            ],
            err => self._finishRun(err)
        );
    }

    //  seam for tests: the thread the emulator runs in
    _newWorker(workerData) {
        return new Worker(WORKER_PATH, { workerData });
    }

    //
    //  The slot is taken: from here every way out goes through _finishRun().
    //  The hangup watcher is set now, not when the worker starts, so a caller
    //  who hangs up while the floppy is built or the image loads is noticed
    //  and no worker is started for them.
    //
    _beginRun() {
        this._incrementInstances();

        const run = {
            finished: false,
            hungUp: false,
            reason: null,
            worker: null,
            done: null,
            spinner: null,
            inputSource: null,
            onClientData: null,
            doorTracking: null,
            image: null,
            flushResult: null,
        };
        run.settled = new Promise(resolve => (run.settle = resolve));
        this._run = run;
        runningSessions.add(this);

        run.onDisconnect = evt => {
            if (
                _.get(evt, 'client.session.uniqueId') ===
                _.get(this.client, 'session.uniqueId')
            ) {
                this._stopRun('hangup');
            }
        };
        Events.on(Events.getSystemEvents().ClientDisconnected, run.onDisconnect);
    }

    //  The caller is gone, or the server is stopping: end the run now if the
    //  worker is going, else when the step under way calls back
    _stopRun(reason) {
        const run = this._run;
        if (!run || run.finished || run.hungUp) {
            return;
        }
        run.hungUp = true;
        run.reason = reason;
        if (run.done) {
            run.done(null);
        }
    }

    _runWorker(callback) {
        const self = this;
        const run = self._run;
        const doorName = self.config.name;

        let called = false;
        run.done = err => {
            if (called) {
                return;
            }
            called = true;
            return callback(err);
        };

        const workerData = {
            imageSab: run.image.sab,
            floppyBuffer: self.floppyBuffer || Buffer.alloc(0),
            memoryMb: self.config.memoryMb,
            biosPath: self.config.biosPath,
            vgaBiosPath: self.config.vgaBiosPath,
        };

        let worker;
        try {
            worker = self._newWorker(workerData);
        } catch (err) {
            return run.done(err);
        }
        run.worker = worker;

        //  Loading spinner — shown until the first serial byte arrives
        const SPINNER_FRAMES = ['|', '/', '-', '\\'];
        let spinnerIdx = 0;
        let firstOutput = true;

        self.client.term.write(ansi.resetScreen());
        self.client.term.write(`\r\n  Loading ${doorName}... ${SPINNER_FRAMES[0]}`);

        run.spinner = setInterval(() => {
            spinnerIdx = (spinnerIdx + 1) % SPINNER_FRAMES.length;
            self.client.term.rawWrite(
                Buffer.from(`\r  Loading ${doorName}... ${SPINNER_FRAMES[spinnerIdx]}`)
            );
        }, 150);

        const stopSpinner = () => {
            if (!firstOutput) return;
            firstOutput = false;
            clearInterval(run.spinner);
            self.client.term.write(ansi.resetScreen());
        };

        //  Client → COM1. The stream is kept: client.end() clears
        //  term.output before ClientDisconnected reaches us.
        run.onClientData = data => {
            worker.postMessage({ type: 'input', data });
        };
        run.inputSource = self.client.term.output;
        if (run.inputSource) {
            run.inputSource.on('data', run.onClientData);
        }

        run.onWorkerMessage = msg => {
            switch (msg.type) {
                case 'ready':
                    self.client.log.info({ name: doorName }, 'v86 emulator ready');
                    break;

                case 'output':
                    stopSpinner();
                    self.client.term.passThroughWrite(Buffer.from(msg.data));
                    break;

                case 'stopped': {
                    const secs = (msg.elapsed / 1000).toFixed(1);
                    self.client.log.info(
                        { name: doorName, elapsed: secs },
                        'v86 emulator stopped'
                    );
                    return run.done(null);
                }

                case 'error':
                    self.client.log.warn(
                        { name: doorName, error: msg.message },
                        'v86 worker error'
                    );
                    return run.done(new Error(msg.message));

                default:
                    break;
            }
        };

        run.onWorkerError = err => {
            self.client.log.warn(
                { name: doorName, error: err.message },
                'v86 worker thread error'
            );
            return run.done(err);
        };

        //  A worker that goes without saying so first (killed, out of memory,
        //  the emulator aborted) ends the run too. After 'stopped' or 'error'
        //  this does nothing: messages arrive before 'exit'.
        run.onWorkerExit = code => {
            if (0 === code) {
                return run.done(null);
            }
            return run.done(new Error(`v86 worker exited unexpectedly (code ${code})`));
        };

        worker.on('message', run.onWorkerMessage);
        worker.on('error', run.onWorkerError);
        worker.on('exit', run.onWorkerExit);
    }

    //
    //  The single way out once the slot is taken (the series' final callback),
    //  whatever ended the run. It stops the worker, frees the slot at once, and
    //  then, once the thread is gone, writes the image to disk and lets go of
    //  it. A hangup ends the worker at once: what the guest wrote is already in
    //  the shared image, and the worker's own 'stop' saves nothing more.
    //
    _finishRun(err) {
        const run = this._run;

        if (!run) {
            //  ended before a slot was taken (bad config, too many callers)
            if (err) {
                this.client.log.warn({ error: err.message }, 'v86_door error');
            }
            return this.prevMenu();
        }

        if (run.finished) {
            return;
        }
        run.finished = true;

        Events.removeListener(
            Events.getSystemEvents().ClientDisconnected,
            run.onDisconnect
        );
        clearInterval(run.spinner);
        if (run.inputSource) {
            run.inputSource.removeListener('data', run.onClientData);
        }

        let stopped = Promise.resolve();
        if (run.worker) {
            const worker = run.worker;
            worker.removeListener('message', run.onWorkerMessage);
            worker.removeListener('error', run.onWorkerError);
            worker.removeListener('exit', run.onWorkerExit);
            //  a late 'error' from a worker we no longer listen to must not
            //  become an unhandled one
            worker.on('error', () => {});
            //  always, even after 'stopped': no thread outlives its run
            stopped = terminateWorker(worker, Timeouts.terminateMs);
        }

        if (run.doorTracking) {
            DoorUtil.trackDoorRunEnd(run.doorTracking);
            run.doorTracking = null;
        }
        this._decrementInstances();

        if (err) {
            this.client.log.warn({ error: err.message }, 'v86_door error');
        } else if (run.hungUp) {
            this.client.log.info(
                { name: this.config.name, reason: run.reason },
                'shutdown' === run.reason
                    ? 'Server shutting down — terminating v86 worker'
                    : 'Client disconnected — terminating v86 worker'
            );
        }

        const log = this.client.log;
        const image = run.image;
        stopped
            .then(() => {
                if (!image) {
                    return;
                }
                if (!run.worker) {
                    //  no guest ran for this session: nothing to write
                    run.flushResult = { ok: true, skipped: true };
                    return releaseImage(image);
                }
                return flushImage(image, log).then(result => {
                    run.flushResult = result;
                    return releaseImage(image);
                });
            })
            .catch(e => {
                log.warn({ error: e.message }, 'v86 door session end failed');
            })
            .then(() => {
                runningSessions.delete(this);
                run.settle();
            });

        if (!run.hungUp) {
            this.prevMenu();
        }
    }

    _incrementInstances() {
        const name = this.config.name;
        activeDoorInstances[name] = (activeDoorInstances[name] || 0) + 1;
        this._instanceIncremented = true;
    }

    _decrementInstances() {
        if (this._instanceIncremented) {
            const name = this.config.name;
            activeDoorInstances[name] = Math.max(0, (activeDoorInstances[name] || 1) - 1);
            this._instanceIncremented = false;
        }
    }
};

//  For bbs.js shutdownSystem
exports.shutdown = shutdown;

//  Exported for unit tests only — not part of the public API
exports._test = {
    imageRegistry,
    activeDoorInstances,
    runningSessions,
    Timeouts,
    acquireImage,
    releaseImage,
    flushImage,
    readImage,
    writeImage,
};
