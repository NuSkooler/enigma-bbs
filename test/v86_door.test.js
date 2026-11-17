'use strict';

const { strict: assert } = require('assert');
const { EventEmitter } = require('events');
const os = require('os');
const fs = require('fs');
const path = require('path');

// v86_door has load-time requires for MenuModule, theme, ansi etc. that all
// eventually reach Config().  setup.js stubs Config.get before any test file
// loads, so we can require v86_door safely here.
const V86DoorModule = require('../core/v86_door/v86_door.js').getModule;
const { shutdown, _test } = require('../core/v86_door/v86_door.js');
const {
    imageRegistry,
    activeDoorInstances,
    runningSessions,
    Timeouts,
    acquireImage,
    releaseImage,
    flushImage,
} = _test;
const DoorUtil = require('../core/door_util.js');
const FatImage = require('../core/v86_door/fat_image.js');
const Events = require('../core/events.js');

const ClientDisconnected = Events.getSystemEvents().ClientDisconnected;

// ─── helpers ──────────────────────────────────────────────────────────────────

let tmpDir;

let imageSeq = 0;
function makeTempImage(size = 512) {
    const p = path.join(tmpDir, `image_${imageSeq++}.img`);
    const buf = Buffer.alloc(size);
    for (let i = 0; i < size; i++) buf[i] = i & 0xff;
    fs.writeFileSync(p, buf);
    return p;
}

const tick = () => new Promise(resolve => setImmediate(resolve));

async function waitFor(cond, what = 'condition') {
    for (let i = 0; i < 500; i++) {
        if (cond()) {
            return;
        }
        await tick();
    }
    throw new Error(`timed out waiting for ${what}`);
}

const quietLog = () => {
    const lines = [];
    const at = level => (obj, msg) => lines.push({ level, obj, msg });
    return {
        lines,
        trace: at('trace'),
        debug: at('debug'),
        info: at('info'),
        warn: at('warn'),
        error: at('error'),
        fatal: at('fatal'),
        child() {
            return this;
        },
    };
};

let sessionSeq = 0;
function fakeClient() {
    const client = new EventEmitter();
    client.log = quietLog();
    client.session = { uniqueId: `v86-session-${sessionSeq++}` };
    client.node = 1;
    client.user = { getProperty: () => undefined };
    client.menuStack = { prev: () => {} };
    client.term = {
        output: new EventEmitter(),
        termWidth: 80,
        termHeight: 25,
        write() {},
        rawWrite() {},
        passThroughWrite() {},
    };
    return client;
}

//  As removeClient() does it: client.end() clears term.output first, then
//  ClientDisconnected is emitted
function hangUp(client) {
    client.term.output = null;
    Events.emit(ClientDisconnected, { client });
}

//
//  A worker as the door sees a real one: terminate() ends it with 'exit'
//  (code 1) and no 'stopped' message. |holdTerminate| makes terminate()
//  return a promise the test settles with release().
//
class FakeWorker extends EventEmitter {
    constructor(workerData) {
        super();
        this.workerData = workerData;
        this.posted = [];
        this.terminateCalls = 0;
        this.exited = false;
        this.holdTerminate = false;
    }
    postMessage(msg) {
        this.posted.push(msg);
    }
    exit(code) {
        if (!this.exited) {
            this.exited = true;
            this.emit('exit', code);
        }
    }
    terminate() {
        this.terminateCalls += 1;
        if (this.exited) {
            return Promise.resolve(undefined);
        }
        if (this.holdTerminate) {
            return new Promise(resolve => {
                this.release = () => {
                    this.exit(1);
                    resolve(1);
                };
            });
        }
        setImmediate(() => this.exit(1));
        return Promise.resolve(1);
    }
    guestWrite(offset, value) {
        new Uint8Array(this.workerData.imageSab)[offset] = value;
    }
}

let bios;
let vgaBios;
let workers;
let trackEnds;
let savedTrackEnd;

//
//  A door module with the live parts stubbed: the worker (FakeWorker),
//  prevMenu() and pausePrompt(). |left| settles when it calls prevMenu().
//
function startDoor(config, { client = fakeClient(), holdTerminate = false } = {}) {
    const m = new V86DoorModule({
        menuConfig: {
            config: Object.assign({ biosPath: bios, vgaBiosPath: vgaBios }, config),
        },
        client,
    });
    m.left = new Promise(resolve => {
        m.prevMenu = () => resolve('prevMenu');
    });
    m.pausePrompt = cb => {
        m.refused = true;
        cb();
    };
    m._newWorker = workerData => {
        const w = new FakeWorker(workerData);
        w.holdTerminate = holdTerminate;
        workers.push(w);
        m.worker = w;
        return w;
    };
    m.client = client;
    m.initSequence();
    return m;
}

async function startRunning(config, opts) {
    const n = workers.length;
    const m = startDoor(config, opts);
    await waitFor(() => workers.length > n || m.refused, 'the worker to start');
    return m;
}

//  everything a run hangs off is back where it was
function listenerSnapshot(m) {
    return {
        disconnect: Events.listenerCount(ClientDisconnected),
        end: m.client.listenerCount('end'),
    };
}

async function settled(m) {
    await m._run.settled;
}

//  drop an image's entry, idle timer and all
function forgetImage(p) {
    const entry = imageRegistry.get(p);
    if (entry && entry.idleTimer) {
        clearTimeout(entry.idleTimer);
    }
    imageRegistry.delete(p);
}

//  kept in memory with no session using it, waiting out its idle time
function isIdle(p) {
    const entry = imageRegistry.get(p);
    return !!entry && 0 === entry.refs && !!entry.idleTimer;
}

//  count the opens of image files, by flags
function countOpens() {
    const realOpen = fs.promises.open;
    const counts = { r: 0, 'r+': 0 };
    fs.promises.open = async (p, flags) => {
        counts[flags] = (counts[flags] || 0) + 1;
        return realOpen(p, flags);
    };
    counts.restore = () => (fs.promises.open = realOpen);
    return counts;
}

//  rewrite a file with its byte |at| set to |value|, and a later mtime
function changeOnDisk(p, at, value, size) {
    const data = fs.readFileSync(p);
    const out = Buffer.alloc(size || data.length);
    data.copy(out, 0, 0, Math.min(data.length, out.length));
    out[at] = value;
    fs.writeFileSync(p, out);
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(p, later, later);
}

describe('v86_door', () => {
    before(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v86_test_'));
        bios = makeTempImage(16);
        vgaBios = makeTempImage(16);
    });

    after(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    beforeEach(() => {
        workers = [];
        trackEnds = [];
        savedTrackEnd = DoorUtil.trackDoorRunEnd;
        DoorUtil.trackDoorRunEnd = info => trackEnds.push(info);
    });

    afterEach(() => {
        DoorUtil.trackDoorRunEnd = savedTrackEnd;
    });

    // ─── SAB registry ─────────────────────────────────────────────────────────────

    describe('v86_door image registry', () => {
        let tmpPath;

        beforeEach(() => {
            tmpPath = makeTempImage(256);
        });

        afterEach(() => {
            forgetImage(tmpPath);
        });

        it('acquireImage loads the file into a SharedArrayBuffer', async () => {
            const entry = await acquireImage(tmpPath);
            assert.ok(entry.sab instanceof SharedArrayBuffer);
            assert.deepEqual(Buffer.from(entry.sab), fs.readFileSync(tmpPath));
            assert.equal(entry.refs, 1);
        });

        it('loads a file larger than one read chunk', async () => {
            const big = makeTempImage(17 * 1024 * 1024 + 3);
            try {
                const entry = await acquireImage(big);
                assert.deepEqual(Buffer.from(entry.sab), fs.readFileSync(big));
                await releaseImage(entry);
            } finally {
                fs.unlinkSync(big);
            }
        });

        it('concurrent acquires share one entry and one SAB', async () => {
            const [a, b] = await Promise.all([
                acquireImage(tmpPath),
                acquireImage(tmpPath),
            ]);
            assert.equal(a, b);
            assert.equal(a.refs, 2);
            const view = new Uint8Array(a.sab);
            view[0] = 0xde;
            assert.equal(new Uint8Array(b.sab)[0], 0xde);
        });

        it('a failed load leaves no entry and holds no reference', async () => {
            const dir = fs.mkdtempSync(path.join(tmpDir, 'dir_'));
            await assert.rejects(acquireImage(dir));
            assert.equal(imageRegistry.has(dir), false);
        });

        it('the last release keeps the entry idle; the next acquire reuses its SAB', async () => {
            const a = await acquireImage(tmpPath);
            const b = await acquireImage(tmpPath);
            await releaseImage(a);
            assert.equal(imageRegistry.get(tmpPath), b, 'still held by the second');
            assert.equal(isIdle(tmpPath), false);

            await releaseImage(b);
            assert.ok(isIdle(tmpPath));

            const opens = countOpens();
            try {
                const c = await acquireImage(tmpPath);
                assert.equal(c, a);
                assert.equal(c.sab, a.sab, 'the same buffer');
                assert.equal(c.idleTimer, null, 'the idle timer is cancelled');
                assert.equal(opens.r, 0, 'an unchanged file is not read again');
            } finally {
                opens.restore();
            }
        });

        it('a change on disk while idle, same size, is read into the same SAB', async () => {
            const a = await acquireImage(tmpPath);
            const sab = a.sab;
            await releaseImage(a);
            changeOnDisk(tmpPath, 0, 0x77);
            const b = await acquireImage(tmpPath);
            assert.equal(b.sab, sab, 'no new buffer');
            assert.equal(new Uint8Array(b.sab)[0], 0x77);
            assert.equal(b.mtimeMs, fs.statSync(tmpPath).mtimeMs);
        });

        it('a change on disk while idle, new size, gets a new SAB', async () => {
            const a = await acquireImage(tmpPath);
            const sab = a.sab;
            await releaseImage(a);
            changeOnDisk(tmpPath, 300, 0x66, 512);
            const b = await acquireImage(tmpPath);
            assert.notEqual(b.sab, sab);
            assert.equal(b.sab.byteLength, 512);
            assert.equal(new Uint8Array(b.sab)[300], 0x66);
            assert.equal(b.size, 512);
        });

        it('two acquires of an idle, changed file share one reload', async () => {
            const a = await acquireImage(tmpPath);
            await releaseImage(a);
            changeOnDisk(tmpPath, 1, 0x55);
            const opens = countOpens();
            try {
                const [b, c] = await Promise.all([
                    acquireImage(tmpPath),
                    acquireImage(tmpPath),
                ]);
                assert.equal(b, c);
                assert.equal(b.refs, 2);
                assert.equal(opens.r, 1, 'read once');
                assert.equal(new Uint8Array(b.sab)[1], 0x55);
            } finally {
                opens.restore();
            }
        });

        it('a failed flush leaves the entry dirty: kept, its writes win, a later flush clears it', async () => {
            const log = quietLog();
            const dir = fs.mkdtempSync(path.join(tmpDir, 'dirty_'));
            const p = path.join(dir, 'door.img');
            fs.writeFileSync(p, Buffer.alloc(16));
            const savedIdleMs = Timeouts.imageIdleMs;
            try {
                const a = await acquireImage(p, log);
                new Uint8Array(a.sab)[0] = 0x11;
                fs.chmodSync(p, 0o444);
                fs.renameSync(p, p + '.away'); //  the write cannot open it
                const r = await flushImage(a, log);
                assert.equal(r.ok, false);
                assert.equal(a.dirty, true);

                //  the idle timer leaves a dirty entry alone
                Timeouts.imageIdleMs = 5;
                await releaseImage(a);
                await new Promise(resolve => setTimeout(resolve, 30));
                assert.equal(imageRegistry.get(p), a, 'a dirty entry is not dropped');

                //  meanwhile the file comes back, changed
                fs.renameSync(p + '.away', p);
                fs.chmodSync(p, 0o644);
                changeOnDisk(p, 0, 0x99);

                const b = await acquireImage(p, log);
                assert.equal(b, a);
                assert.equal(new Uint8Array(b.sab)[0], 0x11, "the guest's write wins");
                assert.ok(
                    log.lines.some(
                        l => 'warn' === l.level && /changed on disk/.test(l.msg)
                    )
                );

                //  the next session end writes it, and the entry is clean
                const r2 = await flushImage(b, log);
                assert.deepEqual(r2, { ok: true });
                assert.equal(b.dirty, false);
                assert.equal(fs.readFileSync(p)[0], 0x11);
                assert.equal(b.mtimeMs, fs.statSync(p).mtimeMs);
            } finally {
                Timeouts.imageIdleMs = savedIdleMs;
                forgetImage(p);
            }
        });

        it('the idle timer drops a clean entry, not one in use again', async () => {
            const savedIdleMs = Timeouts.imageIdleMs;
            Timeouts.imageIdleMs = 5;
            try {
                const a = await acquireImage(tmpPath);
                await releaseImage(a);
                const b = await acquireImage(tmpPath);
                await new Promise(resolve => setTimeout(resolve, 30));
                assert.equal(imageRegistry.get(tmpPath), b, 'in use: kept');

                await releaseImage(b);
                assert.ok(isIdle(tmpPath));
                await new Promise(resolve => setTimeout(resolve, 30));
                assert.equal(
                    imageRegistry.has(tmpPath),
                    false,
                    'idle and clean: dropped'
                );

                const c = await acquireImage(tmpPath);
                assert.notEqual(c, a, 'loaded afresh');
            } finally {
                Timeouts.imageIdleMs = savedIdleMs;
            }
        });

        it('the idle timer does not drop an entry whose refs came back', async () => {
            //  the guard itself, should a timer fire while the entry is in use
            const savedIdleMs = Timeouts.imageIdleMs;
            Timeouts.imageIdleMs = 5;
            try {
                const a = await acquireImage(tmpPath);
                await releaseImage(a);
                a.refs = 1; //  in use, without acquire() cancelling the timer
                await new Promise(resolve => setTimeout(resolve, 30));
                assert.equal(imageRegistry.get(tmpPath), a);
                a.refs = 0;
            } finally {
                Timeouts.imageIdleMs = savedIdleMs;
            }
        });

        it('an acquire while the last flush is in flight reuses the entry', async () => {
            const a = await acquireImage(tmpPath);
            new Uint8Array(a.sab)[0] = 0x42;
            const flushing = flushImage(a);
            const released = releaseImage(a);
            const b = await acquireImage(tmpPath);
            await flushing;
            await released;
            assert.equal(b, a, 'the same entry, not a re-read of a file being written');
            assert.equal(imageRegistry.get(tmpPath), a);
            assert.equal(fs.readFileSync(tmpPath)[0], 0x42);
        });
    });

    // ─── SAB flush ────────────────────────────────────────────────────────────────

    describe('v86_door flushImage', () => {
        let tmpPath;
        let entry;

        beforeEach(async () => {
            tmpPath = makeTempImage(256);
            entry = await acquireImage(tmpPath);
        });

        afterEach(() => {
            forgetImage(tmpPath);
        });

        it('writes SAB contents back to disk', async () => {
            const view = new Uint8Array(entry.sab);
            view[0] = 0xca;
            view[1] = 0xfe;

            const r = await flushImage(entry);
            assert.deepEqual(r, { ok: true });

            const written = fs.readFileSync(tmpPath);
            assert.equal(written[0], 0xca);
            assert.equal(written[1], 0xfe);
        });

        it('writes in place: the same inode, nothing truncated past the image', async () => {
            const { ino } = fs.statSync(tmpPath);
            fs.appendFileSync(tmpPath, Buffer.from([0xaa, 0xbb]));
            new Uint8Array(entry.sab)[5] = 0x55;
            await flushImage(entry);
            const st = fs.statSync(tmpPath);
            assert.equal(st.ino, ino);
            assert.equal(st.size, 258);
            const written = fs.readFileSync(tmpPath);
            assert.equal(written[5], 0x55);
            assert.equal(written[257], 0xbb);
        });

        it('serializes concurrent flushes — last flush wins at byte level', async () => {
            const view = new Uint8Array(entry.sab);
            view[0] = 0x01;
            flushImage(entry);

            view[0] = 0x02;
            await flushImage(entry);

            const written = fs.readFileSync(tmpPath);
            assert.equal(written[0], 0x02, 'last enqueued flush should win');
        });

        it('coalesces: one running and one waiting, however many are asked for', async () => {
            const writes = [];
            const realOpen = fs.promises.open;
            fs.promises.open = async (p, flags) => {
                if ('r+' === flags) {
                    writes.push(p);
                }
                return realOpen(p, flags);
            };
            try {
                const first = flushImage(entry);
                //  the first has not started yet: these share it
                const more = [flushImage(entry), flushImage(entry)];
                assert.equal(more[0], first);
                assert.equal(more[1], first);
                await first;
                assert.equal(writes.length, 1);

                //  one running, then any number asked for while it runs share
                //  one more
                const running = flushImage(entry);
                await tick();
                const waiting = [flushImage(entry), flushImage(entry), flushImage(entry)];
                assert.notEqual(waiting[0], running);
                assert.equal(waiting[1], waiting[0]);
                assert.equal(waiting[2], waiting[0]);
                await Promise.all(waiting);
                assert.equal(writes.length, 3);
            } finally {
                fs.promises.open = realOpen;
            }
        });

        it('a write that makes no progress fails rather than looping', async () => {
            const realOpen = fs.promises.open;
            fs.promises.open = async (p, flags) => {
                const fh = await realOpen(p, flags);
                if ('r+' === flags) {
                    fh.write = async () => ({ bytesWritten: 0 });
                }
                return fh;
            };
            try {
                const r = await flushImage(entry, quietLog());
                assert.equal(r.ok, false);
                assert.match(r.error, /short write/);
                assert.equal(entry.dirty, true);
            } finally {
                fs.promises.open = realOpen;
            }
        });

        it('a failed flush is logged and does not keep later ones from landing', async () => {
            const log = quietLog();
            const dir = fs.mkdtempSync(path.join(tmpDir, 'gone_'));
            const p = path.join(dir, 'door.img');
            fs.writeFileSync(p, Buffer.alloc(16));
            const e = await acquireImage(p);
            try {
                fs.rmSync(dir, { recursive: true });
                new Uint8Array(e.sab)[0] = 1;
                const r1 = await flushImage(e, log);
                assert.equal(r1.ok, false);
                assert.ok(
                    log.lines.some(l => 'warn' === l.level && /flush failed/.test(l.msg))
                );

                fs.mkdirSync(dir);
                fs.writeFileSync(p, Buffer.alloc(16));
                new Uint8Array(e.sab)[0] = 2;
                const r2 = await flushImage(e, log);
                assert.deepEqual(r2, { ok: true });
                assert.equal(fs.readFileSync(p)[0], 2);
            } finally {
                forgetImage(p);
            }
        });
    });

    // ─── door sessions ────────────────────────────────────────────────────────────

    describe('v86_door sessions', () => {
        let img;
        let name;
        let doorSeq = 0;
        let savedTerminateMs;

        beforeEach(() => {
            img = makeTempImage(512);
            name = `v86door${doorSeq++}`;
            savedTerminateMs = Timeouts.terminateMs;
        });

        afterEach(() => {
            Timeouts.terminateMs = savedTerminateMs;
            assert.equal(runningSessions.size, 0, 'no session left running');
            forgetImage(img);
        });

        it('hangups free the slot: nodeMax + 1 hangups, then the door still starts', async () => {
            const baseline = Events.listenerCount(ClientDisconnected);
            for (let i = 0; i < 3; i++) {
                const m = await startRunning({ name, image: img, nodeMax: 2 });
                assert.ok(!m.refused, `run ${i} was refused`);
                assert.equal(activeDoorInstances[name], 1);
                const input = m.client.term.output;
                hangUp(m.client);
                assert.equal(activeDoorInstances[name], 0);
                assert.equal(m.worker.terminateCalls, 1);
                await settled(m);
                assert.equal(input.listenerCount('data'), 0, 'input listener removed');
            }
            assert.equal(trackEnds.length, 3, 'trackDoorRunEnd once per run');
            assert.equal(Events.listenerCount(ClientDisconnected), baseline);

            const m = await startRunning({ name, image: img, nodeMax: 2 });
            assert.ok(!m.refused);
            assert.ok(m.worker);
            m.worker.emit('message', { type: 'stopped', elapsed: 10 });
            assert.equal(await m.left, 'prevMenu');
            await settled(m);
        });

        it('a hangup does not go back to the menu, and the guest writes reach disk', async () => {
            const m = await startRunning({ name, image: img });
            let wentBack = false;
            m.prevMenu = () => (wentBack = true);
            m.worker.guestWrite(3, 0xee);
            hangUp(m.client);
            await settled(m);
            assert.equal(fs.readFileSync(img)[3], 0xee);
            assert.equal(wentBack, false);
            assert.ok(isIdle(img), 'released, kept idle');
        });

        it('the flush waits for the worker to stop', async () => {
            const m = await startRunning({ name, image: img }, { holdTerminate: true });
            hangUp(m.client);
            assert.equal(activeDoorInstances[name], 0, 'slot freed at once');
            //  the thread is still going: what it writes now is kept too
            m.worker.guestWrite(7, 0x99);
            await tick();
            assert.notEqual(fs.readFileSync(img)[7], 0x99);
            m.worker.release();
            await settled(m);
            assert.equal(fs.readFileSync(img)[7], 0x99);
        });

        it('a worker that does not stop is given up on after the terminate timeout', async () => {
            Timeouts.terminateMs = 20;
            const m = await startRunning({ name, image: img }, { holdTerminate: true });
            m.worker.guestWrite(8, 0x12);
            hangUp(m.client);
            await settled(m);
            assert.equal(fs.readFileSync(img)[8], 0x12);
            m.worker.release();
        });

        it('a normal stop flushes, goes back to the menu, and leaves no listeners', async () => {
            const client = fakeClient();
            const before = listenerSnapshot({ client });
            const input = client.term.output;
            const m = await startRunning({ name, image: img }, { client });
            assert.equal(input.listenerCount('data'), 1);
            m.worker.guestWrite(0, 0x5a);
            m.worker.emit('message', { type: 'stopped', elapsed: 10 });
            m.worker.exit(0);
            assert.equal(await m.left, 'prevMenu');
            await settled(m);
            assert.deepEqual(listenerSnapshot(m), before);
            assert.equal(input.listenerCount('data'), 0);
            assert.equal(m.worker.listenerCount('message'), 0);
            assert.equal(m.worker.listenerCount('exit'), 0);
            assert.equal(trackEnds.length, 1);
            assert.equal(fs.readFileSync(img)[0], 0x5a);
            assert.equal(m.worker.terminateCalls, 1, 'terminated even after stopped');
        });

        it('a worker error message, then exit: one finish', async () => {
            const m = await startRunning({ name, image: img });
            m.worker.emit('message', { type: 'error', message: 'no BIOS' });
            m.worker.exit(1);
            assert.equal(await m.left, 'prevMenu');
            await settled(m);
            assert.equal(trackEnds.length, 1);
            assert.equal(activeDoorInstances[name], 0);
        });

        it('a worker error event, then exit: one finish', async () => {
            const m = await startRunning({ name, image: img });
            m.worker.emit('error', new Error('boom'));
            m.worker.exit(1);
            await m.left;
            await settled(m);
            assert.equal(trackEnds.length, 1);
            //  a late error after the run must not be unhandled
            m.worker.emit('error', new Error('late'));
        });

        it('a worker that exits without a word ends its run once, flushed; others go on', async () => {
            const a = await startRunning({ name, image: img });
            const b = await startRunning({ name, image: img });
            assert.equal(activeDoorInstances[name], 2);
            a.worker.guestWrite(1, 0x31);
            a.worker.exit(1);
            await a.left;
            assert.equal(activeDoorInstances[name], 1, 'one decrement, not two');
            await settled(a);
            assert.equal(fs.readFileSync(img)[1], 0x31);
            assert.equal(imageRegistry.has(img), true, 'still held by the other session');
            assert.ok(
                a.client.log.lines.some(
                    l => 'warn' === l.level && /code 1/.test(l.obj.error)
                )
            );

            hangUp(b.client);
            await settled(b);
            assert.equal(activeDoorInstances[name], 0);
            assert.equal(trackEnds.length, 2);
            assert.ok(isIdle(img));
        });

        it('two concurrent sessions: idle only after the last ends and its flush lands', async () => {
            const a = await startRunning({ name, image: img, nodeMax: 2 });
            const b = await startRunning(
                { name, image: img, nodeMax: 2 },
                { holdTerminate: true }
            );
            assert.equal(a.worker.workerData.imageSab, b.worker.workerData.imageSab);
            const entry = imageRegistry.get(img);
            assert.equal(entry.refs, 2);

            a.worker.guestWrite(10, 0xa1);
            hangUp(a.client);
            await settled(a);
            assert.equal(imageRegistry.get(img), entry);
            assert.equal(entry.refs, 1);
            assert.equal(fs.readFileSync(img)[10], 0xa1);

            b.worker.guestWrite(11, 0xb2);
            hangUp(b.client);
            assert.equal(activeDoorInstances[name], 0);
            await tick();
            assert.equal(isIdle(img), false, 'not idle until b has flushed');
            b.worker.release();
            await settled(b);
            assert.equal(fs.readFileSync(img)[11], 0xb2);
            assert.ok(isIdle(img), 'idle only once b has flushed');
        });

        it('a session started while the last flush writes uses the image in memory', async () => {
            const realOpen = fs.promises.open;
            let openGate;
            const gate = new Promise(resolve => (openGate = resolve));
            let writing = false;
            fs.promises.open = async (p, flags) => {
                if ('r+' === flags) {
                    writing = true;
                    await gate;
                }
                return realOpen(p, flags);
            };
            try {
                const a = await startRunning({ name, image: img });
                const entry = imageRegistry.get(img);
                a.worker.guestWrite(12, 0xc3);
                hangUp(a.client);
                await waitFor(() => writing, 'the flush to start');

                const b = await startRunning({ name, image: img });
                assert.equal(b.worker.workerData.imageSab, entry.sab);
                assert.equal(new Uint8Array(b.worker.workerData.imageSab)[12], 0xc3);
                openGate();
                await settled(a);
                assert.equal(imageRegistry.get(img), entry, 'b still holds it');
                hangUp(b.client);
                await settled(b);
                assert.equal(fs.readFileSync(img)[12], 0xc3);
            } finally {
                openGate();
                fs.promises.open = realOpen;
            }
        });

        it("another caller's hangup does not end this run", async () => {
            const m = await startRunning({ name, image: img });
            hangUp(fakeClient());
            await tick();
            assert.equal(m.worker.terminateCalls, 0);
            assert.equal(activeDoorInstances[name], 1);
            hangUp(m.client);
            await settled(m);
        });

        describe('early failures free the slot', () => {
            async function thenStarts(cfg) {
                const m = await startRunning({ name, image: img, nodeMax: 1 });
                assert.ok(!m.refused, `refused after ${cfg}`);
                m.worker.emit('message', { type: 'stopped', elapsed: 1 });
                await m.left;
                await settled(m);
                assert.equal(activeDoorInstances[name], 0);
            }

            it('BBSDEV drop file', async () => {
                const m = startDoor({
                    name,
                    image: img,
                    nodeMax: 1,
                    dropFileType: 'BBSDEV',
                });
                await m.left;
                await settled(m);
                assert.equal(workers.length, 0);
                assert.equal(activeDoorInstances[name], 0);
                assert.equal(trackEnds.length, 0, 'no run was begun');
                await thenStarts('BBSDEV');
            });

            it('the floppy cannot be built', async () => {
                const saved = FatImage.createFloppyWithFiles;
                FatImage.createFloppyWithFiles = () =>
                    Promise.reject(new Error('disk full'));
                try {
                    const m = startDoor({
                        name,
                        image: img,
                        nodeMax: 1,
                        runBatch: 'DOOR',
                    });
                    await m.left;
                    await settled(m);
                    assert.equal(activeDoorInstances[name], 0);
                } finally {
                    FatImage.createFloppyWithFiles = saved;
                }
                await thenStarts('floppy failure');
            });

            it('the image cannot be loaded', async () => {
                const dir = fs.mkdtempSync(path.join(tmpDir, 'notanimage_'));
                const m = startDoor({ name, image: dir, nodeMax: 1 });
                await m.left;
                await settled(m);
                assert.equal(activeDoorInstances[name], 0);
                assert.equal(trackEnds.length, 1, 'the run had begun');
                assert.equal(imageRegistry.has(dir), false);
                await thenStarts('load failure');
            });

            it('the worker cannot be started', async () => {
                const m = new V86DoorModule({
                    menuConfig: {
                        config: {
                            name,
                            image: img,
                            nodeMax: 1,
                            biosPath: bios,
                            vgaBiosPath: vgaBios,
                        },
                    },
                    client: fakeClient(),
                });
                m.left = new Promise(resolve => (m.prevMenu = () => resolve()));
                m._newWorker = () => {
                    throw new Error('no threads');
                };
                m.initSequence();
                await m.left;
                await settled(m);
                assert.equal(activeDoorInstances[name], 0);
                assert.equal(trackEnds.length, 1);
                assert.ok(isIdle(img), 'the image is released');
                await thenStarts('worker failure');
            });
        });

        it('a hangup while the floppy is built starts no worker and calls back once', async () => {
            let resolveFloppy;
            const saved = FatImage.createFloppyWithFiles;
            FatImage.createFloppyWithFiles = () =>
                new Promise(resolve => (resolveFloppy = resolve));
            const rejections = [];
            const onRejection = e => rejections.push(e);
            process.on('unhandledRejection', onRejection);
            try {
                const baseline = Events.listenerCount(ClientDisconnected);
                const m = startDoor({ name, image: img, nodeMax: 1, runBatch: 'DOOR' });
                await waitFor(() => resolveFloppy, 'the floppy build');
                let wentBack = false;
                m.prevMenu = () => (wentBack = true);
                hangUp(m.client);
                assert.equal(
                    activeDoorInstances[name],
                    1,
                    'held until the step is through'
                );
                resolveFloppy(Buffer.alloc(1474560));
                await settled(m);
                await tick();
                assert.equal(workers.length, 0, 'no worker for a caller who is gone');
                assert.equal(activeDoorInstances[name], 0);
                assert.equal(wentBack, false);
                assert.equal(trackEnds.length, 0);
                assert.equal(Events.listenerCount(ClientDisconnected), baseline);
                assert.deepEqual(rejections, []);
            } finally {
                FatImage.createFloppyWithFiles = saved;
                process.removeListener('unhandledRejection', onRejection);
            }
            await thenStartsAgain();

            async function thenStartsAgain() {
                const m = await startRunning({ name, image: img, nodeMax: 1 });
                assert.ok(m.worker);
                hangUp(m.client);
                await settled(m);
            }
        });

        it('a hangup while the image loads starts no worker and releases the image', async () => {
            const m = startDoor({ name, image: img, nodeMax: 1 });
            //  the load is under way (async) by the time initSequence() returns
            hangUp(m.client);
            await settled(m);
            assert.equal(workers.length, 0);
            assert.equal(activeDoorInstances[name], 0);
            assert.equal(trackEnds.length, 1);
            assert.ok(isIdle(img));
        });

        it('back-to-back sessions reuse the same SAB', async () => {
            const a = await startRunning({ name, image: img });
            a.worker.guestWrite(20, 0x20);
            hangUp(a.client);
            await settled(a);
            const opens = countOpens();
            try {
                const b = await startRunning({ name, image: img });
                assert.equal(b.worker.workerData.imageSab, a.worker.workerData.imageSab);
                assert.equal(new Uint8Array(b.worker.workerData.imageSab)[20], 0x20);
                assert.equal(opens.r, 0, 'not read again');
                hangUp(b.client);
                await settled(b);
            } finally {
                opens.restore();
            }
        });

        describe('server shutdown', () => {
            let savedShutdownTerminateMs;

            beforeEach(() => {
                savedShutdownTerminateMs = Timeouts.shutdownTerminateMs;
            });

            afterEach(() => {
                Timeouts.shutdownTerminateMs = savedShutdownTerminateMs;
                _test.resetShutdown();
            });

            it('calls back at once with nothing running', done => {
                shutdown(done, { log: quietLog() });
            });

            it('ends a run still going and flushes its image', async () => {
                const m = await startRunning({ name, image: img });
                m.worker.guestWrite(2, 0xd2);
                const log = quietLog();
                await new Promise(resolve => shutdown(resolve, { timeoutMs: 2000, log }));
                assert.equal(m.worker.terminateCalls, 1);
                assert.equal(activeDoorInstances[name], 0);
                assert.equal(fs.readFileSync(img)[2], 0xd2);
                const line = log.lines.find(l => /at shutdown/.test(l.msg));
                assert.equal(line.level, 'info');
                assert.match(line.msg, /1 images flushed, 0 not/);
            });

            it('waits for a flush begun by the hangup just before', async () => {
                const m = await startRunning({ name, image: img });
                m.worker.guestWrite(4, 0xd4);
                hangUp(m.client); //  closeConnections
                const log = quietLog();
                await new Promise(resolve => shutdown(resolve, { timeoutMs: 2000, log }));
                assert.equal(fs.readFileSync(img)[4], 0xd4);
                assert.match(
                    log.lines.find(l => /at shutdown/.test(l.msg)).msg,
                    /1 images/
                );
            });

            it('a worker slow to stop still lets the flush land within the budget', async () => {
                Timeouts.terminateMs = 5000;
                Timeouts.shutdownTerminateMs = 50;
                const a = await startRunning(
                    { name, image: img, nodeMax: 2 },
                    { holdTerminate: true }
                );
                const b = await startRunning(
                    { name, image: img, nodeMax: 2 },
                    { holdTerminate: true }
                );
                a.worker.guestWrite(5, 0xd5);
                hangUp(a.client); //  closeConnections, before the shutdown step
                const log = quietLog();
                const t0 = Date.now();
                //  b is still running: the shutdown step ends it
                await new Promise(resolve => shutdown(resolve, { timeoutMs: 1000, log }));
                assert.ok(Date.now() - t0 < 900, 'did not wait out terminateMs');
                assert.equal(fs.readFileSync(img)[5], 0xd5);
                assert.match(
                    log.lines.find(l => /at shutdown/.test(l.msg)).msg,
                    /1 images flushed, 0 not/
                );
                a.worker.release();
                b.worker.release();
            });

            it('gives up on a flush that does not finish in time, and says so', async () => {
                const realOpen = fs.promises.open;
                let openGate;
                const gate = new Promise(resolve => (openGate = resolve));
                fs.promises.open = async (p, flags) => {
                    if ('r+' === flags) {
                        await gate; //  a write that hangs
                    }
                    return realOpen(p, flags);
                };
                try {
                    const m = await startRunning({ name, image: img });
                    const log = quietLog();
                    const t0 = Date.now();
                    await new Promise(resolve =>
                        shutdown(resolve, { timeoutMs: 50, log })
                    );
                    assert.ok(Date.now() - t0 < 1000);
                    const line = log.lines.find(l => /at shutdown/.test(l.msg));
                    assert.equal(line.level, 'warn');
                    assert.match(line.msg, /0 images flushed, 1 not/);
                    openGate();
                    await settled(m);
                } finally {
                    openGate();
                    fs.promises.open = realOpen;
                }
            });

            //  an idle image whose last write failed, with no session left
            async function dirtyIdleImage() {
                const dir = fs.mkdtempSync(path.join(tmpDir, 'shutdirty_'));
                const p = path.join(dir, 'door.img');
                fs.writeFileSync(p, Buffer.alloc(16));
                const entry = await acquireImage(p);
                new Uint8Array(entry.sab)[3] = 0x33;
                fs.renameSync(p, p + '.away');
                const r = await flushImage(entry);
                assert.equal(r.ok, false);
                await releaseImage(entry);
                assert.ok(isIdle(p) && entry.dirty);
                return { p, entry };
            }

            it('writes an idle image whose last write failed, and says so', async () => {
                const { p, entry } = await dirtyIdleImage();
                try {
                    fs.renameSync(p + '.away', p);
                    const log = quietLog();
                    await new Promise(resolve =>
                        shutdown(resolve, { timeoutMs: 2000, log })
                    );
                    assert.equal(fs.readFileSync(p)[3], 0x33);
                    assert.equal(entry.dirty, false);
                    const line = log.lines.find(l => /at shutdown/.test(l.msg));
                    assert.equal(line.level, 'info');
                    assert.match(line.msg, /1 images flushed, 0 not/);
                    assert.deepEqual(line.obj.flushed, [p]);
                } finally {
                    forgetImage(p);
                }
            });

            it('reports an idle image whose write fails again as not flushed', async () => {
                const { p } = await dirtyIdleImage();
                try {
                    const log = quietLog();
                    await new Promise(resolve =>
                        shutdown(resolve, { timeoutMs: 2000, log })
                    );
                    const line = log.lines.find(l => /at shutdown/.test(l.msg));
                    assert.equal(line.level, 'warn');
                    assert.match(line.msg, /0 images flushed, 1 not/);
                    assert.equal(line.obj.notFlushed[0].image, p);
                } finally {
                    forgetImage(p);
                }
            });

            it('clears idle timers', async () => {
                const m = await startRunning({ name, image: img });
                hangUp(m.client);
                await settled(m);
                assert.ok(isIdle(img));
                await new Promise(resolve => shutdown(resolve, { log: quietLog() }));
                assert.equal(imageRegistry.get(img).idleTimer, null);
            });
        });
    });
});
