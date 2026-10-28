'use strict';

const { strict: assert } = require('assert');
const { EventEmitter } = require('events');

const pty = require('node-pty');
const Events = require('../core/events.js');
const Door = require('../core/door.js');

//
//  A running door is killed when its caller hangs up. ClientDisconnected is a
//  system event every node's hang-up raises, so the door must keep listening
//  through other callers' disconnects -- a once() listener was used up by the
//  first of them, and this caller's own hang-up then left the door running.
//

const DisconnectEvent = Events.getSystemEvents().ClientDisconnected;

function makeFakePty() {
    const fake = new EventEmitter();
    fake.pid = 4242;
    fake.killed = 0;
    fake.kill = () => {
        fake.killed += 1;
    };
    fake.onData = () => {};
    fake.onExit = handler => {
        fake.exit = () => handler({ exitCode: 0, signal: 0 });
    };
    return fake;
}

function makeClient(uniqueId) {
    const noop = () => {};
    return {
        session: { uniqueId },
        user: { userId: 1, getSanitizedName: () => 'tester' },
        term: {
            termWidth: 80,
            termHeight: 25,
            write: noop,
            output: { writableLength: 0, pipe: noop, unpipe: noop, resume: noop },
        },
        log: { warn: noop, debug: noop, info: noop, trace: noop },
    };
}

function runStdioDoor(client, fakePty) {
    const door = new Door(client);
    return new Promise((resolve, reject) => {
        door.prepare('stdio', err => {
            if (err) {
                return reject(err);
            }
            const exited = new Promise(resolveExit =>
                door.run({ cmd: '/bin/true', args: [], node: 1, env: {} }, resolveExit)
            );
            //  run() spawns synchronously once its series reaches the door
            setImmediate(() => resolve({ door, exited, fakePty }));
        });
    });
}

describe('Door: kill on hang-up', () => {
    let originalSpawn;
    let fakePty;

    beforeEach(() => {
        originalSpawn = pty.spawn;
        fakePty = makeFakePty();
        pty.spawn = () => fakePty;
    });

    afterEach(() => {
        pty.spawn = originalSpawn;
    });

    it('survives another caller hanging up, then kills on its own', async () => {
        const baseline = Events.listenerCount(DisconnectEvent);
        const { exited } = await runStdioDoor(makeClient('node1-session'), fakePty);

        Events.emit(DisconnectEvent, { client: { session: { uniqueId: 'node2' } } });
        assert.equal(fakePty.killed, 0, 'another caller hanging up killed the door');
        assert.equal(Events.listenerCount(DisconnectEvent), baseline + 1);

        Events.emit(DisconnectEvent, {
            client: { session: { uniqueId: 'node1-session' } },
        });
        assert.ok(fakePty.killed >= 1, 'own hang-up did not kill the door');
        assert.equal(Events.listenerCount(DisconnectEvent), baseline);

        fakePty.exit();
        await exited;
    });

    it('stops listening when the door exits by itself', async () => {
        const baseline = Events.listenerCount(DisconnectEvent);
        const { exited } = await runStdioDoor(makeClient('node1-session'), fakePty);
        assert.equal(Events.listenerCount(DisconnectEvent), baseline + 1);

        fakePty.exit();
        await exited;

        assert.equal(Events.listenerCount(DisconnectEvent), baseline);
    });
});
