'use strict';

//
//  core/amiga_door/amiga_worker.js in a real worker thread, against a fake
//  enigma-vamiga 0.2.0 (test/fixtures/amiga_worker/): the input queue, the
//  order of what goes to the shim, `d`, pause and resume, X handling, the
//  file-backed disk (how the emulator is created, the sync when the worker
//  stops, persist: false) and a refused snapshot.
//
const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

const protocol = require('../core/amiga_door/protocol.js');

const HARNESS = path.join(__dirname, 'fixtures/amiga_worker/harness.js');
const RS = protocol.RS;
const MaxInputQueueBytes = 1024 * 1024; //  amiga_worker.js
const InputWindowBytes = 768; //  amiga_worker.js

const SESSION = { version: 1, door: 'BBS:Doors/X/x', node: 1 };

class TestWorker {
    constructor({
        image,
        snapshot = true,
        serialHandshake,
        legacyPackage,
        persist = true,
        refuseSnapshot,
    }) {
        this.messages = [];
        this.waiters = [];
        this.worker = new Worker(HARNESS, {
            workerData: {
                module: null,
                snapshot: snapshot ? new Uint8Array([1]) : null,
                image,
                persist,
                rom: '/roms/kick.rom',
                machine: { fastKb: 4096 },
                warpBootSeconds: 7,
                serialHandshake,
                legacyPackage,
                refuseSnapshot,
                session: SESSION,
            },
        });
        this.exited = new Promise(resolve => this.worker.once('exit', resolve));
        this.worker.on('message', msg => {
            this.messages.push(msg);
            this.waiters = this.waiters.filter(w => !w(msg));
        });
        this.worker.on('error', err => {
            this.error = err;
        });
    }

    //  The next message (from now on) that |pred| accepts
    next(pred) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('worker timed out')), 3000);
            this.waiters.push(msg => {
                if (!pred(msg)) {
                    return false;
                }
                clearTimeout(timer);
                resolve(msg);
                return true;
            });
        });
    }

    post(msg) {
        this.worker.postMessage(msg);
    }

    shim(bytes) {
        this.post({ type: 'fake', cmd: 'shim', bytes: new Uint8Array(bytes) });
    }

    //  One emulated frame; resolves to the bytes the guest received. |room|:
    //  what the core accepts; |pending|: bytes it still holds from before;
    //  |rts|: the guest's RTS from now on
    async tick(room, pending, rts) {
        const p = this.next(m => 'fake' === m.type && 'ticked' === m.event);
        this.post({ type: 'fake', cmd: 'tick', room, pending, rts });
        return Buffer.from((await p).received);
    }

    //  Frames until |bytes| have arrived or a frame brings nothing
    async drain(bytes) {
        const parts = [];
        let got = 0;
        for (;;) {
            const b = await this.tick();
            if (!b.length) {
                return Buffer.concat(parts);
            }
            parts.push(b);
            got += b.length;
            if (got >= bytes) {
                return Buffer.concat(parts);
            }
        }
    }

    async state() {
        const p = this.next(m => 'fake' === m.type && 'state' === m.event);
        this.post({ type: 'fake', cmd: 'state' });
        return p;
    }

    write(offset, data) {
        this.post({ type: 'fake', cmd: 'write', offset, data: new Uint8Array(data) });
    }

    //  Stop the worker; resolves to its 'synced' report (null if none)
    async stop() {
        this.post({ type: 'stop' });
        await this.exited;
        return this.messages.find(m => 'synced' === m.type) || null;
    }
}

const sFrameOf = buf => {
    //  the s frame at the head of |buf|, decoded, and what follows it
    assert.equal(buf[0], RS);
    assert.equal(String.fromCharCode(buf[1]), 's');
    const len = (buf[2] << 8) | buf[3];
    return {
        keys: protocol.parseKeys(buf.subarray(4, 4 + len)),
        rest: buf.subarray(4 + len),
    };
};

describe('amiga_door worker', function () {
    this.timeout(10000);

    let dir;
    let image;
    let w;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amiga_worker_test_'));
        image = path.join(dir, 'door.hdf');
        fs.writeFileSync(image, Buffer.alloc(8192));
    });

    afterEach(async () => {
        if (w) {
            await w.stop();
            w = null;
        }
        fs.rmSync(dir, { recursive: true, force: true });
    });

    //  A restored session with `s` already delivered
    async function restored() {
        w = new TestWorker({ image });
        await w.next(m => 'ready' === m.type);
        const first = await w.tick();
        assert.equal(sFrameOf(first).keys.door, SESSION.door);
        return w;
    }

    it('sends s first, then the typeahead that came while booting', async () => {
        w = new TestWorker({ image, snapshot: false });
        await w.next(m => 'fake' === m.type && 'created' === m.event);
        w.post({ type: 'input', data: Buffer.from('ab') });
        w.post({ type: 'input', data: Buffer.from([RS, 0x63]) });
        assert.equal((await w.tick()).length, 0, 'nothing before the shim is ready');

        w.shim(
            Buffer.concat([protocol.encode('H', { version: 1 }), protocol.encode('R')])
        );
        const snapshot = w.next(m => 'snapshot' === m.type);
        const ready = w.next(m => 'ready' === m.type);
        const got = await w.tick();
        await snapshot;
        assert.equal((await ready).restored, false);

        const { keys, rest } = sFrameOf(got);
        assert.equal(keys.door, SESSION.door);
        assert.ok(keys.now > 0, 'the worker adds now');
        assert.deepEqual([...rest], [0x61, 0x62, RS, RS, 0x63]);
    });

    it('feeds at most a window of bytes the guest has not taken', async () => {
        await restored();
        w.post({ type: 'input', data: Buffer.alloc(4000, 0x41) });
        assert.equal(
            (await w.tick()).length,
            InputWindowBytes,
            'an empty line: a window'
        );
        assert.equal(
            (await w.tick(undefined, 500)).length,
            InputWindowBytes - 500,
            'the core still holds 500: the rest of the window'
        );
        assert.equal(
            (await w.tick(undefined, InputWindowBytes)).length,
            0,
            'a full window: nothing'
        );
        assert.equal((await w.tick(100)).length, 100, 'the core accepted 100 of them');
        const rest = await w.drain(4000);
        assert.equal(rest.length, 4000 - 2 * InputWindowBytes + 500 - 100);
    });

    it('never drops a paste the guest is slow to take, and keeps its order', async () => {
        await restored();
        const paste = Buffer.from(
            Array.from({ length: 16384 }, (_, i) => 0x20 + ((i * 31 + 7) % 95))
        );
        //  pasted in pieces, while the guest takes a little at a time
        for (let i = 0; i < paste.length; i += 1000) {
            w.post({ type: 'input', data: paste.subarray(i, i + 1000) });
        }
        const parts = [];
        let got = 0;
        while (got < paste.length) {
            const b = await w.tick(37 + (got % 300));
            assert.ok(b.length > 0, 'something every frame');
            parts.push(b);
            got += b.length;
        }
        assert.deepEqual(Buffer.concat(parts), paste);

        w.shim(protocol.encode('X', { status: 'ok' }));
        const exit = w.next(m => 'exit' === m.type);
        await w.tick();
        assert.equal((await exit).inputDropped, 0);
        assert.ok(!w.messages.some(m => 'inputFull' === m.type));
    });

    it('turns the RTS/CTS handshake on for axshim 1.5 and later, from the H frame', async () => {
        w = new TestWorker({ image, snapshot: false });
        const created = await w.next(m => 'fake' === m.type && 'created' === m.event);
        assert.equal(created.serialHandshake, false, 'no H yet: off');
        w.shim(
            Buffer.concat([
                protocol.encode('H', { version: 1, shim: 'axshim 1.5', baud: 38400 }),
                protocol.encode('R'),
            ])
        );
        const snapshot = w.next(m => 'snapshot' === m.type);
        const ready = w.next(m => 'ready' === m.type);
        await w.tick();
        assert.equal((await snapshot).serialHandshake, true, 'the cache learns it too');
        assert.equal((await ready).serialHandshake, true);
        assert.equal((await w.state()).serialHandshake, true);

        //  an older shim (an image rebuilt back, say) turns it off again
        w.shim(protocol.encode('H', { version: 1, shim: 'axshim 1.4' }));
        await w.tick();
        assert.equal((await w.state()).serialHandshake, false);
    });

    it('holds input while the guest has RTS off, with the handshake on only', async () => {
        //  restored from the snapshot of a machine that ran with it
        w = new TestWorker({ image, serialHandshake: true });
        const created = await w.next(m => 'fake' === m.type && 'created' === m.event);
        assert.equal(created.serialHandshake, true);
        await w.next(m => 'ready' === m.type);
        assert.equal(sFrameOf(await w.tick()).keys.door, SESSION.door);

        w.post({ type: 'input', data: Buffer.alloc(1000, 0x41) });
        assert.equal((await w.tick(undefined, 0, false)).length, 0, 'RTS off: nothing');
        assert.equal((await w.tick()).length, 0, 'still off');
        assert.equal(
            (await w.tick(undefined, 0, true)).length,
            InputWindowBytes,
            'RTS on'
        );

        //  axshim 1.4 never raises RTS: with its H the handshake goes and RTS is ignored
        w.shim(protocol.encode('H', { version: 1, shim: 'axshim 1.4' }));
        await w.tick(0, 0, false);
        assert.equal((await w.state()).serialHandshake, false);
        assert.equal((await w.tick()).length, 1000 - InputWindowBytes);
    });

    it('without the handshake API (enigma-vamiga 0.1.2) leaves it off and ignores RTS', async () => {
        w = new TestWorker({ image, snapshot: false, legacyPackage: true });
        const created = await w.next(m => 'fake' === m.type && 'created' === m.event);
        assert.equal(created.serialHandshake, undefined, 'no option for the core');
        w.shim(
            Buffer.concat([
                protocol.encode('H', { version: 1, shim: 'axshim 1.5', baud: 38400 }),
                protocol.encode('R'),
            ])
        );
        const ready = w.next(m => 'ready' === m.type);
        assert.equal(sFrameOf(await w.tick()).keys.door, SESSION.door);
        assert.equal(
            (await ready).serialHandshake,
            false,
            'an axshim 1.5 H changes nothing'
        );
        assert.equal((await w.state()).serialHandshake, false);

        //  RTS off and bytes said to be pending mean nothing without the API:
        //  guestClearToSend() is true and nothing counts as in flight
        w.post({ type: 'input', data: Buffer.alloc(1000, 0x41) });
        assert.equal((await w.tick(undefined, 500, false)).length, InputWindowBytes);
        assert.equal(
            (await w.tick(undefined, 500, false)).length,
            1000 - InputWindowBytes
        );
    });

    it('caps queued input without splitting an RS RS pair, and says so once', async () => {
        await restored();
        //  the cut falls where the escaped RS would need two bytes and one is left
        const raw = Buffer.concat([
            Buffer.alloc(MaxInputQueueBytes - 1, 0x41),
            Buffer.from([RS, 0x42, 0x43]),
        ]);
        const full = w.next(m => 'inputFull' === m.type);
        w.post({ type: 'input', data: raw });
        assert.equal((await full).limit, MaxInputQueueBytes);
        //  one byte of room is left: 'm' fits, 'ore' does not
        w.post({ type: 'input', data: Buffer.from('more') });

        const got = await w.drain(MaxInputQueueBytes);
        assert.equal(got.length, MaxInputQueueBytes);
        assert.ok(got.subarray(0, -1).every(b => 0x41 === b));
        assert.equal(got[got.length - 1], 0x6d);
        //  room again: later input is taken
        w.post({ type: 'input', data: Buffer.from('ok') });
        assert.deepEqual([...(await w.tick())], [0x6f, 0x6b]);

        //  and the drop is counted in caller bytes, the warning given once
        w.shim(protocol.encode('X', { status: 'ok' }));
        const exit = w.next(m => 'exit' === m.type);
        await w.tick();
        assert.equal((await exit).inputDropped, 3 + 3);
        assert.equal(w.messages.filter(m => 'inputFull' === m.type).length, 1);
    });

    it('escapes 0x1E in caller input', async () => {
        await restored();
        w.post({ type: 'input', data: Buffer.from([0x41, RS, 0x42]) });
        assert.deepEqual([...(await w.tick())], [0x41, RS, RS, 0x42]);
    });

    it('d completes an RS RS pair already half sent, then drops the rest', async () => {
        await restored();
        w.post({ type: 'input', data: Buffer.from([0x41, 0x42, RS, 0x43, 0x44]) });
        //  A B RS | RS C D: the guest takes three bytes
        assert.deepEqual([...(await w.tick(3))], [0x41, 0x42, RS]);
        w.post({ type: 'frame', frame: { type: 'd', keys: { reason: 'hangup' } } });
        const got = await w.tick();
        assert.deepEqual(
            [...got],
            [RS, ...protocol.encode('d', { reason: 'hangup' })],
            'the pair is finished, C D are dropped'
        );
    });

    it('d drops unsent input but not a frame already begun', async () => {
        await restored();
        const t = protocol.encode('t', { timeleft: 12 });
        w.post({ type: 'frame', frame: { type: 't', keys: { timeleft: 12 } } });
        w.post({ type: 'input', data: Buffer.from('typed') });
        assert.deepEqual([...(await w.tick(2))], [...t.subarray(0, 2)]);
        w.post({ type: 'frame', frame: { type: 'd', keys: { reason: 'timeup' } } });
        const got = await w.tick();
        assert.deepEqual(
            [...got],
            [...t.subarray(2), ...protocol.encode('d', { reason: 'timeup' })]
        );
    });

    it('d with nothing in flight drops all queued input', async () => {
        await restored();
        w.post({ type: 'input', data: Buffer.from([0x41, RS, 0x42]) });
        w.post({ type: 'frame', frame: { type: 'd', keys: { reason: 'break' } } });
        assert.deepEqual(
            [...(await w.tick())],
            [...protocol.encode('d', { reason: 'break' })]
        );
    });

    it('pauses and resumes the emulator', async () => {
        await restored();
        assert.equal((await w.state()).running, true);
        w.post({ type: 'pause' });
        assert.equal((await w.state()).running, false);
        w.post({ type: 'resume' });
        assert.equal((await w.state()).running, true);
    });

    it('acts on the first X only', async () => {
        await restored();
        const exits = [];
        w.worker.on('message', m => 'exit' === m.type && exits.push(m));
        const problem = w.next(m => 'error' === m.type);
        w.shim(
            Buffer.concat([
                protocol.encode('X', { status: 'carrier' }),
                protocol.encode('X', { status: 'ok' }),
            ])
        );
        await w.tick();
        const err = await problem;
        assert.equal(err.fatal, false);
        assert.match(err.message, /unexpected X/);
        assert.equal(exits.length, 1);
        assert.equal(exits[0].status, 'carrier');
        //  input after X goes nowhere
        w.post({ type: 'input', data: Buffer.from('x') });
        assert.equal((await w.tick()).length, 0);
    });

    it('ignores an X before the session has started', async () => {
        w = new TestWorker({ image, snapshot: false });
        await w.next(m => 'fake' === m.type && 'created' === m.event);
        const problem = w.next(m => 'error' === m.type);
        w.shim(
            Buffer.concat([
                protocol.encode('H', { version: 1 }),
                protocol.encode('X', { status: 'ok' }),
            ])
        );
        await w.tick();
        assert.equal((await problem).fatal, false);
        assert.ok(!w.messages.some(m => 'exit' === m.type));
    });

    // ─── the file-backed disk ────────────────────────────────────────────────

    const page = (byte, n = 512) => new Uint8Array(n).fill(byte);
    const imageAt = (offset, n = 512) =>
        fs.readFileSync(image).subarray(offset, offset + n);

    //  Boot: H and R, then a frame at real speed; resolves to the snapshot
    async function booted(worker) {
        worker.shim(
            Buffer.concat([protocol.encode('H', { version: 1 }), protocol.encode('R')])
        );
        const snapshot = worker.next(m => 'snapshot' === m.type);
        await worker.tick();
        return snapshot;
    }

    async function exitWith(status) {
        w.shim(protocol.encode('X', { status }));
        const exit = w.next(m => 'exit' === m.type);
        await w.tick();
        return exit;
    }

    it('restores onto the image file, writing through on idle', async () => {
        w = new TestWorker({ image });
        const created = await w.next(m => 'fake' === m.type && 'created' === m.event);
        assert.deepEqual(created.hdf, { path: image, mode: 'file' });
        assert.equal(created.writeThrough, 'onIdle');
        assert.equal(created.fastKb, 0, 'the snapshot brings its own machine');
        assert.equal(created.rom, undefined);
        assert.equal((await w.next(m => 'ready' === m.type)).restored, true);
    });

    it('boots onto the image file with the machine', async () => {
        w = new TestWorker({ image, snapshot: false });
        const created = await w.next(m => 'fake' === m.type && 'created' === m.event);
        assert.deepEqual(created.hdf, { path: image, mode: 'file' });
        assert.equal(created.writeThrough, 'onIdle');
        assert.equal(created.fastKb, 4096);
        assert.equal(created.rom, '/roms/kick.rom');
        assert.equal(created.warpBootSeconds, 7);
    });

    it("persist: false creates the disk with write-through 'never'", async () => {
        w = new TestWorker({ image, persist: false });
        const created = await w.next(m => 'fake' === m.type && 'created' === m.event);
        assert.deepEqual(created.hdf, { path: image, mode: 'file' });
        assert.equal(created.writeThrough, 'never');
    });

    it("sends the snapshot with the image's stat taken after it", async () => {
        w = new TestWorker({ image, snapshot: false });
        await w.next(m => 'fake' === m.type && 'created' === m.event);
        //  a boot-time write: the snapshot flushes it into the file first
        w.write(4096, page(0x55));
        const snap = await booted(w);
        const st = fs.statSync(image);
        assert.deepEqual(snap.stat, {
            size: st.size,
            mtimeMs: st.mtimeMs,
            ino: st.ino,
            dev: st.dev,
        });
        assert.ok(imageAt(4096).every(b => 0x55 === b));
        assert.equal(w.messages.find(m => 'ready' === m.type).restored, false);
    });

    it('boots when the core refuses the snapshot, and says so', async () => {
        w = new TestWorker({ image, refuseSnapshot: true, serialHandshake: true });
        const refused = await w.next(m => 'snapshotRefused' === m.type);
        assert.match(refused.message, /older version of vAmiga/);
        assert.equal(refused.code, 'EVAMIGA_CORE');
        const created = await w.next(
            m => 'fake' === m.type && 'created' === m.event && 2 === m.creates
        );
        assert.equal(created.warpBootSeconds, 7, 'a boot this time');
        assert.equal(created.fastKb, 4096);
        assert.equal(created.serialHandshake, false, 'until the shim says hello');
        assert.deepEqual(created.hdf, { path: image, mode: 'file' });

        const snapshot = await booted(w);
        assert.ok(snapshot.stat, 'the new snapshot goes to the cache');
        assert.equal(w.messages.find(m => 'ready' === m.type).restored, false);
    });

    for (const status of ['ok', 'carrier', 'timeout', 'break', 'error']) {
        it(`syncs the image when stopped after X status=${status}`, async () => {
            await restored();
            w.write(0, page(0xaa));
            await w.tick(); //  idle: written through
            assert.ok(
                imageAt(0).every(b => 0xaa === b),
                'written as the door goes'
            );
            //  what the guest's file system still buffers when the door ends
            w.post({ type: 'fake', cmd: 'settleWrite', offset: 512, data: page(0xbb) });
            await exitWith(status);
            const synced = await w.stop();
            w = null;
            assert.equal(synced.error, undefined);
            assert.equal(synced.writes, 2);
            assert.equal(synced.bytes, 1024);
            assert.equal(synced.sessionWrites, 2);
            assert.ok(
                imageAt(512).every(b => 0xbb === b),
                'flushed after settling'
            );
        });
    }

    it('syncs a door still running when the parent gives up on it', async () => {
        await restored();
        w.post({ type: 'frame', frame: { type: 'd', keys: { reason: 'hangup' } } });
        await w.tick();
        w.post({ type: 'fake', cmd: 'settleWrite', offset: 1024, data: page(0xcc) });
        //  no X: the shim never answered
        const synced = await w.stop();
        w = null;
        assert.equal(synced.sessionWrites, 1);
        assert.ok(imageAt(1024).every(b => 0xcc === b));
    });

    describe('stop with the carrier gone', function () {
        const dBytes = [RS, 0x64];
        const hasD = b => Buffer.from(b).includes(Buffer.from(dBytes));

        it("delivers a pending d and takes the shim's X within the window", async () => {
            await restored();
            w.post({ type: 'fake', cmd: 'answerD', frames: 40, status: 'carrier' });
            w.post({ type: 'frame', frame: { type: 'd', keys: { reason: 'shutdown' } } });
            //  no frame has run: only stop() can deliver it
            const exit = w.next(m => 'exit' === m.type);
            const destroyed = w.next(m => 'fake' === m.type && 'destroyed' === m.event);
            w.post({ type: 'fake', cmd: 'settleWrite', offset: 512, data: page(0xdd) });
            const synced = await w.stop();
            w = null;
            assert.equal((await exit).status, 'carrier', 'a normal exit');
            assert.ok(hasD((await destroyed).received), 'd reached the shim');
            assert.equal(synced.sessionWrites, 1);
            assert.ok(imageAt(512).every(b => 0xdd === b));
        });

        it('syncs a silent door within the window, where it stands', async () => {
            await restored();
            w.post({ type: 'frame', frame: { type: 'd', keys: { reason: 'shutdown' } } });
            const destroyed = w.next(m => 'fake' === m.type && 'destroyed' === m.event);
            const t = Date.now();
            const synced = await w.stop();
            const ms = Date.now() - t;
            assert.ok(!w.messages.some(m => 'exit' === m.type), 'no X came');
            w = null;
            assert.ok(hasD((await destroyed).received), 'd reached the shim');
            assert.ok(synced, 'synced');
            assert.ok(ms < 2000, `bounded (${ms} ms)`);
        });

        it('runs no extra frames for a stop without d, beyond the settle', async () => {
            await restored();
            const destroyed = w.next(m => 'fake' === m.type && 'destroyed' === m.event);
            await w.stop();
            const received = (await destroyed).received;
            w = null;
            assert.ok(!hasD(received));
        });
    });

    it('settles only when stopped, and reports a session that wrote nothing', async () => {
        await restored();
        await exitWith('ok');
        assert.equal((await w.state()).settled, 0, 'X alone runs nothing flat out');
        const synced = await w.stop();
        w = null;
        assert.equal(synced.writes, 0);
        assert.equal(synced.sessionWrites, 0);
        assert.equal(synced.error, undefined);
    });

    it('reports the session writes as unknown when the core cannot count them', async () => {
        await restored();
        w.write(0, page(0x11));
        w.post({ type: 'fake', cmd: 'failStats' });
        const synced = await w.stop();
        w = null;
        assert.equal(synced.sessionWrites, null);
        assert.equal(synced.error, undefined, 'the sync itself went through');
        assert.ok(imageAt(0).every(b => 0x11 === b));
    });

    it('counts only the writes made after the session started', async () => {
        w = new TestWorker({ image, snapshot: false });
        await w.next(m => 'fake' === m.type && 'created' === m.event);
        w.write(0, page(0x11)); //  at boot
        await booted(w);
        const synced = await w.stop();
        w = null;
        assert.equal(synced.writes, 1);
        assert.equal(synced.sessionWrites, 0);
    });

    it('reports a sync that fails, and still stops', async () => {
        await restored();
        w.post({ type: 'fake', cmd: 'failSync', message: 'EIO: i/o error' });
        await exitWith('ok');
        const synced = await w.stop();
        w = null;
        assert.match(synced.error, /EIO/);
        assert.equal(synced.code, 'EVAMIGA_CORE');
    });

    it('persist: false never writes the image, not even at the end', async () => {
        const before = fs.readFileSync(image);
        w = new TestWorker({ image, persist: false });
        await w.next(m => 'ready' === m.type);
        await w.tick();
        w.write(0, page(0xaa));
        await w.tick();
        await w.tick();
        assert.equal((await w.state()).pending, true, 'kept in the core');
        w.post({ type: 'fake', cmd: 'settleWrite', offset: 512, data: page(0xbb) });
        await exitWith('ok');
        const synced = await w.stop();
        w = null;
        assert.deepEqual(synced, { type: 'synced', skipped: true });
        assert.deepEqual(fs.readFileSync(image), before);
    });

    it('persist: false takes no snapshot of a boot that wrote the disk', async () => {
        const before = fs.readFileSync(image);
        w = new TestWorker({ image, persist: false, snapshot: false });
        await w.next(m => 'fake' === m.type && 'created' === m.event);
        w.write(0, page(0x22));
        const problem = w.next(m => 'error' === m.type);
        w.shim(
            Buffer.concat([protocol.encode('H', { version: 1 }), protocol.encode('R')])
        );
        await w.tick();
        const err = await problem;
        assert.equal(err.during, 'snapshot');
        assert.equal(err.fatal, false);
        assert.match(err.message, /persist is off/);
        assert.ok(!w.messages.some(m => 'snapshot' === m.type));
        assert.equal(w.messages.find(m => 'ready' === m.type).restored, false);
        await w.stop();
        w = null;
        assert.deepEqual(fs.readFileSync(image), before);
    });

    it('persist: false snapshots a boot that left the disk alone', async () => {
        w = new TestWorker({ image, persist: false, snapshot: false });
        await w.next(m => 'fake' === m.type && 'created' === m.event);
        const snap = await booted(w);
        assert.equal(snap.stat.size, 8192);
    });
});
