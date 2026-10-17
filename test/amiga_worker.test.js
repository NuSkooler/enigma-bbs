'use strict';

//
//  core/amiga_door/amiga_worker.js in a real worker thread, against a fake
//  enigma-vamiga (test/fixtures/amiga_worker/): the input queue, the order of
//  what goes to the shim, `d`, pause and resume and X handling.
//
const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

const protocol = require('../core/amiga_door/protocol.js');

const HARNESS = path.join(__dirname, 'fixtures/amiga_worker/harness.js');
const RS = protocol.RS;
const MaxInputQueueBytes = 64 * 1024; //  amiga_worker.js

const SESSION = { version: 1, door: 'BBS:Doors/X/x', node: 1 };

class TestWorker {
    constructor({ image, snapshot = true }) {
        this.messages = [];
        this.waiters = [];
        this.worker = new Worker(HARNESS, {
            workerData: {
                module: null,
                snapshot: snapshot ? new Uint8Array([1]) : null,
                image,
                machine: {},
                warpBootSeconds: 0,
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

    //  One emulated frame; resolves to the bytes the guest received
    async tick(room) {
        const p = this.next(m => 'fake' === m.type && 'ticked' === m.event);
        this.post({ type: 'fake', cmd: 'tick', room });
        return Buffer.from((await p).received);
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

    it('caps queued input without splitting an RS RS pair', async () => {
        await restored();
        //  the cut falls where the escaped RS would need two bytes and one is left
        const raw = Buffer.concat([
            Buffer.alloc(MaxInputQueueBytes - 1, 0x41),
            Buffer.from([RS, 0x42, 0x43]),
        ]);
        w.post({ type: 'input', data: raw });
        const got = await w.tick();
        assert.equal(got.length, MaxInputQueueBytes - 1);
        assert.ok(got.every(b => 0x41 === b));

        //  and the drop is counted in caller bytes
        w.shim(protocol.encode('X', { status: 'ok' }));
        const exit = w.next(m => 'exit' === m.type);
        await w.tick();
        assert.equal((await exit).inputDropped, 3);
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
});
