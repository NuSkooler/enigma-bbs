'use strict';

//
//  core/amiga_door/amiga_worker.js in a real worker thread, against a fake
//  enigma-vamiga (test/fixtures/amiga_worker/): the input queue, the order of
//  what goes to the shim, `d`, pause and resume, persisting and X handling.
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
    constructor({ image, snapshot = true, serialHandshake, legacyPackage }) {
        this.messages = [];
        this.waiters = [];
        this.worker = new Worker(HARNESS, {
            workerData: {
                module: null,
                snapshot: snapshot ? new Uint8Array([1]) : null,
                image,
                machine: {},
                warpBootSeconds: 0,
                serialHandshake,
                legacyPackage,
                session: SESSION,
            },
        });
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

    async stop() {
        const exited = new Promise(resolve => this.worker.once('exit', resolve));
        this.post({ type: 'stop' });
        await exited;
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

    async function exited() {
        await restored();
        w.shim(protocol.encode('X', { status: 'ok' }));
        const exit = w.next(m => 'exit' === m.type);
        await w.tick();
        await exit;
    }

    it('persists by renaming a written copy over the image', async () => {
        await exited();
        const before = fs.statSync(image);
        w.post({
            type: 'fake',
            cmd: 'changes',
            chunks: [{ offset: 512, data: new Uint8Array(512).fill(0xaa) }],
        });
        const tmp = `${image}.test.persist`;
        const done = w.next(m => 'persisted' === m.type);
        w.post({ type: 'persist', path: image, tmp });
        const msg = await done;
        assert.equal(msg.chunks, 1);
        assert.equal(msg.bytes, 512);
        assert.equal(msg.refused, undefined);

        const after = fs.readFileSync(image);
        assert.equal(after.length, 8192);
        assert.ok(after.subarray(512, 1024).every(b => 0xaa === b));
        assert.ok(after.subarray(0, 512).every(b => 0 === b));
        assert.notEqual(
            fs.statSync(image).ino,
            before.ino,
            'replaced, not written in place'
        );
        assert.deepEqual(fs.readdirSync(dir), ['door.hdf'], 'no temporary file left');
        assert.ok((await w.state()).settled >= 150, 'the guest was given time to flush');
    });

    it('writes nothing when nothing changed', async () => {
        await exited();
        const before = fs.statSync(image);
        const done = w.next(m => 'persisted' === m.type);
        w.post({ type: 'persist', path: image, tmp: `${image}.test.persist` });
        assert.equal((await done).chunks, 0);
        assert.equal(fs.statSync(image).ino, before.ino);
        assert.deepEqual(fs.readdirSync(dir), ['door.hdf']);
    });

    it('refuses to persist over an image that changed during the session', async () => {
        await exited();
        //  someone else wrote the image meanwhile
        fs.writeFileSync(image, Buffer.alloc(8192, 0x11));
        fs.utimesSync(image, new Date(), new Date(Date.now() + 5000));
        w.post({
            type: 'fake',
            cmd: 'changes',
            chunks: [{ offset: 0, data: new Uint8Array(512).fill(0xaa) }],
        });
        const done = w.next(m => 'persisted' === m.type);
        w.post({ type: 'persist', path: image, tmp: `${image}.test.persist` });
        const msg = await done;
        assert.equal(msg.chunks, 0);
        assert.match(msg.refused, /changed/);
        assert.ok(
            fs.readFileSync(image).every(b => 0x11 === b),
            'left alone'
        );
        assert.deepEqual(fs.readdirSync(dir), ['door.hdf']);
    });

    //  A persist that fails after the copy exists leaves the image as it was
    //  and removes the copy.
    async function persistFails(arrange) {
        await exited();
        const before = fs.readFileSync(image);
        w.post({
            type: 'fake',
            cmd: 'changes',
            chunks: [{ offset: 0, data: new Uint8Array(512).fill(0xaa) }],
        });
        arrange();
        const settled = w.next(m => 'error' === m.type || 'persisted' === m.type);
        w.post({ type: 'persist', path: image, tmp: `${image}.test.persist` });
        const msg = await settled;
        assert.deepEqual(fs.readFileSync(image), before, 'the image is untouched');
        assert.deepEqual(fs.readdirSync(dir), ['door.hdf'], 'no temporary file left');
        return msg;
    }

    it('removes the copy when it is not the size of the disk', async () => {
        const err = await persistFails(() =>
            w.post({ type: 'fake', cmd: 'hdfSize', size: 4096 })
        );
        assert.equal('error', err.type);
        assert.equal(err.during, 'persist');
        assert.match(err.message, /is 8192 bytes, the disk is 4096/);
    });

    it('removes the copy when the rename fails', async () => {
        const err = await persistFails(() =>
            w.post({ type: 'fake', cmd: 'failOnce', method: 'renameSync', code: 'EIO' })
        );
        assert.equal(err.during, 'persist');
        assert.equal(err.code, 'EIO');
        assert.doesNotMatch(err.message, /bind mount/, 'no hint for an unrelated error');
    });

    it('explains a rename the file system refuses', async () => {
        const err = await persistFails(() =>
            w.post({ type: 'fake', cmd: 'failOnce', method: 'renameSync', code: 'EBUSY' })
        );
        assert.equal(err.code, 'EBUSY');
        assert.match(err.message, /writable directory.*free space.*bind mount/);
    });

    it('explains a copy the directory refuses', async () => {
        const err = await persistFails(() =>
            w.post({
                type: 'fake',
                cmd: 'failOnce',
                method: 'copyFileSync',
                code: 'EACCES',
            })
        );
        assert.equal(err.code, 'EACCES');
        assert.match(err.message, /writable directory/);
    });

    it('removes the copy when the image changes while it is written', async () => {
        const msg = await persistFails(() =>
            w.post({ type: 'fake', cmd: 'touchOnFsync', path: image })
        );
        assert.equal(msg.type, 'persisted');
        assert.equal(msg.chunks, 0);
        assert.match(msg.refused, /changed/);
    });

    it('removes only its own stale copies, and only old ones', async () => {
        await exited();
        const hour = 60 * 60 * 1000;
        const stale = `${image}.123.456.persist`;
        const fresh = `${image}.123.789.persist`;
        const other = path.join(dir, 'other.hdf.123.456.persist');
        const odd = `${image}.x.persist`;
        for (const f of [stale, fresh, other, odd]) {
            fs.writeFileSync(f, 'x');
        }
        const old = new Date(Date.now() - 2 * hour);
        for (const f of [stale, other, odd]) {
            fs.utimesSync(f, old, old);
        }
        w.post({
            type: 'fake',
            cmd: 'changes',
            chunks: [{ offset: 0, data: new Uint8Array(512).fill(0xaa) }],
        });
        const done = w.next(m => 'persisted' === m.type);
        w.post({ type: 'persist', path: image, tmp: `${image}.test.persist` });
        assert.equal((await done).chunks, 1);
        assert.deepEqual(
            fs.readdirSync(dir).sort(),
            [
                'door.hdf',
                path.basename(fresh),
                path.basename(odd),
                path.basename(other),
            ].sort()
        );
    });

    it('refuses a temporary file that is not beside the image', async () => {
        await exited();
        w.post({
            type: 'fake',
            cmd: 'changes',
            chunks: [{ offset: 0, data: new Uint8Array(512).fill(0xaa) }],
        });
        const failed = w.next(m => 'error' === m.type);
        w.post({
            type: 'persist',
            path: image,
            tmp: path.join(os.tmpdir(), 'elsewhere.persist'),
        });
        const err = await failed;
        assert.equal(err.during, 'persist');
        assert.match(err.message, /not beside/);
        assert.ok(fs.readFileSync(image).every(b => 0 === b));
        assert.deepEqual(fs.readdirSync(dir), ['door.hdf']);
    });
});
