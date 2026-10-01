'use strict';

const { strict: assert } = require('assert');

const Door = require('../core/door.js');

//
//  A door with |io: socket| gets a temporary TCP server to dial back on, and
//  whichever connection arrives first is piped to the caller's session. That
//  server must therefore listen on loopback only -- bound to the unspecified
//  address it hands the caller's keystrokes to whoever on the network connects
//  before the door does. A door config may name another interface with
//  |socketBindAddress| for the rare emulator that is not on this machine.
//

const UnspecifiedAddresses = ['::', '0.0.0.0'];

function makeClient() {
    const logged = { warn: [], debug: [], info: [] };
    return {
        logged,
        term: { output: { writableLength: 0 }, write: () => {} },
        log: {
            warn: (obj, msg) => logged.warn.push({ obj, msg }),
            debug: (obj, msg) => logged.debug.push({ obj, msg }),
            info: (obj, msg) => logged.info.push({ obj, msg }),
        },
    };
}

function prepareSocketDoor(options) {
    return new Promise((resolve, reject) => {
        const client = makeClient();
        const door = new Door(client);
        const cb = err => (err ? reject(err) : resolve({ door, client }));

        if (options) {
            door.prepare('socket', options, cb);
        } else {
            door.prepare('socket', cb);
        }
    });
}

describe('Door socket server bind address', () => {
    let door;

    afterEach(() => {
        if (door && door.sockServer) {
            door.sockServer.close();
        }
        door = null;
    });

    it('binds loopback by default', async () => {
        const prepared = await prepareSocketDoor();
        door = prepared.door;

        const address = door.sockServer.address();
        assert.equal(address.address, '127.0.0.1');
        assert.ok(
            !UnspecifiedAddresses.includes(address.address),
            `door socket server is reachable off-box at ${address.address}`
        );
        assert.ok(address.port > 0);
        assert.equal(door.sockServerBindAddress, '127.0.0.1');
        assert.equal(prepared.client.logged.warn.length, 0);
    });

    it('still binds loopback when no bind address is configured', async () => {
        //  what abracadabra passes for a door config without the setting
        const prepared = await prepareSocketDoor({ bindAddress: undefined });
        door = prepared.door;

        assert.equal(door.sockServer.address().address, '127.0.0.1');
    });

    it('honours a configured bind address, and says so in the log', async () => {
        //  the one case the setting exists for: an emulator somewhere else, so
        //  the server has to be reachable from off-box
        const prepared = await prepareSocketDoor({ bindAddress: '0.0.0.0' });
        door = prepared.door;

        assert.equal(door.sockServerBindAddress, '0.0.0.0');
        assert.equal(door.sockServer.address().address, '0.0.0.0');
        assert.equal(prepared.client.logged.warn.length, 1);
        assert.match(prepared.client.logged.warn[0].msg, /not loopback/);
    });

    it('reports a bind address this machine cannot listen on', async () => {
        //  .invalid never resolves (RFC 2606), so listen() errors rather than
        //  calling back -- the door must be told instead of waiting forever
        const client = makeClient();
        const badDoor = new Door(client);
        const err = await new Promise(resolve =>
            badDoor.prepare(
                'socket',
                { bindAddress: 'enigma-no-such-host.invalid' },
                resolve
            )
        );

        assert.ok(err, 'expected an error from prepare()');
        assert.match(err.message, /enigma-no-such-host\.invalid/);
        badDoor.sockServer.close();
    });

    it('does not start a server at all for io: stdio', async () => {
        const client = makeClient();
        const stdioDoor = new Door(client);
        await new Promise((resolve, reject) =>
            stdioDoor.prepare('stdio', { bindAddress: '0.0.0.0' }, err =>
                err ? reject(err) : resolve()
            )
        );

        assert.equal(stdioDoor.sockServer, undefined);
        assert.equal(client.logged.warn.length, 0);
    });
});

describe('Door.socketBindAddress()', () => {
    const noLog = { warn: () => {} };

    it('defaults to loopback', () => {
        assert.equal(Door.socketBindAddress(undefined, noLog), '127.0.0.1');
        assert.equal(Door.socketBindAddress(null, noLog), '127.0.0.1');
        assert.equal(Door.socketBindAddress('', noLog), '127.0.0.1');
        assert.equal(Door.socketBindAddress('   ', noLog), '127.0.0.1');
        assert.equal(Door.socketBindAddress(1234, noLog), '127.0.0.1');
    });

    it('trims and returns what was configured', () => {
        assert.equal(Door.socketBindAddress(' ::1 ', noLog), '::1');
        assert.equal(Door.socketBindAddress('10.0.0.5', noLog), '10.0.0.5');
    });

    it('warns only for a non-loopback address', () => {
        const warns = [];
        const log = { warn: (obj, msg) => warns.push({ obj, msg }) };

        ['127.0.0.1', '127.0.1.2', '::1', 'localhost', 'LOCALHOST'].forEach(addr => {
            Door.socketBindAddress(addr, log);
        });
        assert.equal(warns.length, 0);

        Door.socketBindAddress('10.0.0.5', log);
        Door.socketBindAddress('::', log);
        assert.equal(warns.length, 2);
        assert.equal(warns[0].obj.bindAddress, '10.0.0.5');
    });

    it('does not require a log', () => {
        assert.equal(Door.socketBindAddress('10.0.0.5'), '10.0.0.5');
    });
});
