'use strict';

const { strict: assert } = require('assert');
const { EventEmitter } = require('events');
const os = require('os');
const fs = require('fs');
const path = require('path');

//  No VM here: the worker is faked, as a real one behaves on terminate()
const ZMachineDoorModule = require('../core/zmachine_door/zmachine_door.js').getModule;
const { activeDoorInstances } = require('../core/zmachine_door/zmachine_door.js')._test;
const DoorUtil = require('../core/door_util.js');
const Events = require('../core/events.js');

const ClientDisconnected = Events.getSystemEvents().ClientDisconnected;

const tick = () => new Promise(resolve => setImmediate(resolve));

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
    client.session = { uniqueId: `zm-session-${sessionSeq++}` };
    client.node = 1;
    client.user = { getProperty: () => undefined };
    client.menuStack = { prev: () => {} };
    client.term = {
        output: new EventEmitter(),
        termWidth: 80,
        termHeight: 25,
        write() {},
        rawWrite() {},
    };
    return client;
}

//  As removeClient() does it: term.output is cleared, then ClientDisconnected
function hangUp(client) {
    client.term.output = null;
    Events.emit(ClientDisconnected, { client });
}

//  As user_time.js does it when the day's budget is gone
function timeUp(client) {
    client.timeUpEmitted = true;
    client.emit('time up');
}

//  terminate() gives 'exit' (code 1) and no 'stopped', as a real worker does
class FakeWorker extends EventEmitter {
    constructor(workerData) {
        super();
        this.workerData = workerData;
        this.posted = [];
        this.terminateCalls = 0;
        this.exited = false;
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
        if (!this.exited) {
            setImmediate(() => this.exit(1));
        }
        return Promise.resolve(1);
    }
}

describe('zmachine_door sessions', () => {
    let tmpDir;
    let game;
    let name;
    let doorSeq = 0;
    let workers;
    let trackEnds;
    let savedTrackEnd;

    before(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zm_test_'));
        game = path.join(tmpDir, 'game.z5');
        fs.writeFileSync(game, Buffer.from([5, 0, 0, 0]));
    });

    after(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    beforeEach(() => {
        name = `zmdoor${doorSeq++}`;
        workers = [];
        trackEnds = [];
        savedTrackEnd = DoorUtil.trackDoorRunEnd;
        DoorUtil.trackDoorRunEnd = info => trackEnds.push(info);
    });

    afterEach(() => {
        DoorUtil.trackDoorRunEnd = savedTrackEnd;
    });

    function startDoor(config, { client = fakeClient(), newWorker } = {}) {
        const m = new ZMachineDoorModule({
            menuConfig: { config: Object.assign({ name, game_path: game }, config) },
            client,
        });
        m.wentBack = 0;
        m.left = new Promise(resolve => {
            m.prevMenu = () => {
                m.wentBack += 1;
                resolve('prevMenu');
            };
        });
        m.pausePrompt = cb => {
            m.refused = true;
            cb();
        };
        m._newWorker =
            newWorker ||
            (workerData => {
                const w = new FakeWorker(workerData);
                workers.push(w);
                m.worker = w;
                return w;
            });
        m.initSequence();
        return m;
    }

    it('hangups free the slot: nodeMax + 1 hangups, then the door still starts', async () => {
        const baseline = Events.listenerCount(ClientDisconnected);
        for (let i = 0; i < 3; i++) {
            const m = startDoor({ nodeMax: 2 });
            assert.ok(!m.refused, `run ${i} was refused`);
            assert.ok(m.worker);
            const input = m.client.term.output;
            assert.equal(input.listenerCount('data'), 1);
            hangUp(m.client);
            assert.equal(activeDoorInstances[name], 0);
            assert.equal(m.worker.terminateCalls, 1);
            assert.deepEqual(m.worker.posted, [], 'no stop posted: terminated at once');
            assert.equal(input.listenerCount('data'), 0, 'input listener removed');
            assert.equal(m.wentBack, 0, 'a caller who is gone is not sent to a menu');
            await tick();
        }
        assert.equal(trackEnds.length, 3);
        assert.equal(Events.listenerCount(ClientDisconnected), baseline);

        const m = startDoor({ nodeMax: 2 });
        assert.ok(!m.refused);
        assert.ok(m.worker);
        m.worker.emit('message', { type: 'stopped', elapsed: 1 });
        await m.left;
    });

    it('a normal stop goes back to the menu and leaves no listeners', async () => {
        const client = fakeClient();
        const endBefore = client.listenerCount('end');
        const disconnectBefore = Events.listenerCount(ClientDisconnected);
        const input = client.term.output;
        const m = startDoor({}, { client });
        m.worker.emit('message', { type: 'stopped', elapsed: 1 });
        m.worker.exit(0);
        assert.equal(await m.left, 'prevMenu');
        assert.equal(client.listenerCount('end'), endBefore);
        assert.equal(Events.listenerCount(ClientDisconnected), disconnectBefore);
        assert.equal(input.listenerCount('data'), 0);
        assert.equal(m.worker.listenerCount('message'), 0);
        assert.equal(trackEnds.length, 1);
        assert.equal(activeDoorInstances[name], 0);
    });

    it('a second stopped message does not end the run twice', async () => {
        const a = startDoor({});
        const b = startDoor({});
        assert.equal(activeDoorInstances[name], 2);
        a.worker.emit('message', { type: 'stopped', elapsed: 1 });
        assert.doesNotThrow(() =>
            a.worker.emit('message', { type: 'stopped', elapsed: 2 })
        );
        await a.left;
        assert.equal(a.wentBack, 1);
        assert.equal(trackEnds.length, 1);
        assert.equal(activeDoorInstances[name], 1, 'one decrement, not two');
        hangUp(b.client);
        assert.equal(activeDoorInstances[name], 0);
    });

    it('a worker that exits without a word ends its run once; others go on', async () => {
        const a = startDoor({});
        const b = startDoor({});
        a.worker.exit(1);
        await a.left;
        assert.equal(activeDoorInstances[name], 1);
        assert.equal(trackEnds.length, 1);
        assert.ok(
            a.client.log.lines.some(l => 'warn' === l.level && /code 1/.test(l.obj.error))
        );
        hangUp(b.client);
        assert.equal(activeDoorInstances[name], 0);
        assert.equal(trackEnds.length, 2);
    });

    it('an error message, then exit: one finish', async () => {
        const m = startDoor({});
        m.worker.emit('message', { type: 'error', message: 'bad story file' });
        m.worker.exit(1);
        await m.left;
        assert.equal(trackEnds.length, 1);
        assert.equal(activeDoorInstances[name], 0);
    });

    it('a worker error event, then exit: one finish', async () => {
        const m = startDoor({});
        m.worker.emit('error', new Error('boom'));
        m.worker.exit(1);
        await m.left;
        assert.equal(trackEnds.length, 1);
        //  a late error after the run must not be unhandled
        m.worker.emit('error', new Error('late'));
    });

    it("another caller's hangup does not end this run", () => {
        const m = startDoor({});
        hangUp(fakeClient());
        assert.equal(m.worker.terminateCalls, 0);
        assert.equal(activeDoorInstances[name], 1);
        hangUp(m.client);
        assert.equal(activeDoorInstances[name], 0);
    });

    it('the worker cannot be started: the slot is freed', async () => {
        const m = startDoor(
            { nodeMax: 1 },
            {
                newWorker: () => {
                    throw new Error('no threads');
                },
            }
        );
        await m.left;
        assert.equal(activeDoorInstances[name], 0);
        assert.equal(trackEnds.length, 1);
        const next = startDoor({ nodeMax: 1 });
        assert.ok(next.worker);
        hangUp(next.client);
    });

    it('time-up ends the game at once: nothing more is written, no menu, no listeners', () => {
        const client = fakeClient();
        const disconnectBefore = Events.listenerCount(ClientDisconnected);
        const input = client.term.output;
        const m = startDoor({}, { client });
        m.worker.emit('message', { type: 'output', data: 'West of House\n' });
        const writes = [];
        client.term.write = client.term.rawWrite = d => writes.push(d);
        timeUp(client);
        assert.equal(m.worker.terminateCalls, 1);
        assert.equal(activeDoorInstances[name], 0);
        assert.equal(client.listenerCount('time up'), 0);
        assert.equal(Events.listenerCount(ClientDisconnected), disconnectBefore);
        assert.equal(input.listenerCount('data'), 0);
        m.worker.emit('message', { type: 'output', data: 'You are eaten by a grue.\n' });
        assert.deepEqual(writes, [], 'nothing written after time-up');
        assert.equal(m.wentBack, 0, 'timeUpLogoff owns the navigation');
        assert.equal(trackEnds.length, 1);
        assert.equal(m._run.reason, 'timeup');
    });

    it('leave() ends the game the same way', () => {
        const m = startDoor({});
        m.leave();
        assert.equal(m.worker.terminateCalls, 1);
        assert.equal(activeDoorInstances[name], 0);
        assert.equal(m._run.reason, 'leave');
        m.worker.emit('message', { type: 'stopped', elapsed: 1 });
        assert.equal(m.wentBack, 0);
    });

    it('time-up then hangup then leave(): one finish', () => {
        const m = startDoor({});
        timeUp(m.client);
        hangUp(m.client);
        m.leave();
        m.worker.exit(1);
        assert.equal(m._run.reason, 'timeup');
        assert.equal(trackEnds.length, 1);
        assert.equal(m.worker.terminateCalls, 1);
        assert.equal(activeDoorInstances[name], 0);
        assert.equal(m.wentBack, 0);
    });

    it('a game entered after time-up starts nothing', async () => {
        const client = fakeClient();
        client.timeUpEmitted = true;
        const m = startDoor({}, { client });
        await m.left;
        assert.equal(workers.length, 0);
        assert.equal(m._run, undefined);
    });

    it('a caller gone before the worker would start gets none', () => {
        const m = new ZMachineDoorModule({
            menuConfig: { config: { name, game_path: game, nodeMax: 1 } },
            client: fakeClient(),
        });
        m.prevMenu = () => assert.fail('no menu for a caller who is gone');
        m._newWorker = () => assert.fail('no worker for a caller who is gone');
        //  hang up the moment the slot is taken
        const begin = m._beginRun.bind(m);
        m._beginRun = () => {
            begin();
            hangUp(m.client);
        };
        m.initSequence();
        assert.equal(activeDoorInstances[name], 0);
        assert.equal(trackEnds.length, 0);
    });
});
