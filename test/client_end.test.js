'use strict';

const { strict: assert } = require('assert');

const { Client } = require('../core/client.js');
const UserProps = require('../core/user_property.js');
const Events = require('../core/events.js');

//
//  Client.end() is reached more than once on any server initiated
//  disconnect: end() -> disconnect() -> socket 'close' ->
//  clientConnections.removeClient() -> client.end(). The idle timeout, the
//  "all nodes are busy" refusal and @systemMethod:logoff all go round that
//  loop, so the teardown has to be safe to call again -- and the transport
//  disconnect has to keep happening, since removeClient() calling end() is
//  how the system guarantees the connection is gone.
//

function makeClient(opts = {}) {
    const client = new Client();

    client.counts = { leave: 0, persist: 0, disconnect: 0, termDisconnect: 0 };
    client.persisted = [];

    client.term = {
        disconnect: () => (client.counts.termDisconnect += 1),
    };

    const currentModule =
        false === opts.inModule ? null : { leave: () => (client.counts.leave += 1) };
    client.menuStack = { getCurrentModule: currentModule, currentModule };

    client.user = {
        isAuthenticated: () => false !== opts.authenticated,
        getProperty: () => 7,
        persistProperty: (name, value) => {
            client.counts.persist += 1;
            client.persisted.push([name, value]);
        },
    };

    if (false !== opts.hasDisconnect) {
        client.disconnect = () => (client.counts.disconnect += 1);
    }

    return client;
}

describe('Client.end()', () => {
    describe('teardown runs once', () => {
        it('leaves the current module exactly once', () => {
            const client = makeClient();
            client.end();
            client.end();
            client.end();
            assert.equal(client.counts.leave, 1);
        });

        it('persists minutes online exactly once', () => {
            const client = makeClient();
            client.end();
            client.end();
            assert.equal(client.counts.persist, 1);
            assert.deepEqual(client.persisted, [[UserProps.MinutesOnlineTotalCount, 7]]);
        });

        it('disconnects the terminal exactly once', () => {
            const client = makeClient();
            client.end();
            client.end();
            assert.equal(client.counts.termDisconnect, 1);
        });

        it('removes the theme listener exactly once', () => {
            const client = makeClient();
            const themeChanged = Events.getSystemEvents().ThemeChanged;
            const before = Events.listenerCount(themeChanged);

            client.end();
            const afterFirst = Events.listenerCount(themeChanged);
            assert.equal(afterFirst, before - 1, 'the constructor added one');

            client.end();
            assert.equal(
                Events.listenerCount(themeChanged),
                afterFirst,
                'a second end() must not remove somebody else s listener'
            );
        });

        it('records that it has ended', () => {
            const client = makeClient();
            assert.equal(client.clientEnded, false, 'false, not undefined');
            client.end();
            assert.equal(client.clientEnded, true);
        });
    });

    describe('the transport disconnect is not guarded', () => {
        //
        //  removeClient() opens with end() precisely to be sure the socket is
        //  gone. Skipping it on a later call would risk leaving one open if
        //  an earlier call threw on its way there.
        //
        it('disconnects on every call', () => {
            const client = makeClient();
            client.end();
            client.end();
            client.end();
            assert.equal(client.counts.disconnect, 3);
        });

        it('still disconnects when the first teardown threw', () => {
            const client = makeClient();
            client.menuStack = {
                getCurrentModule: {
                    leave: () => {
                        throw new Error('module cleanup blew up');
                    },
                },
            };

            assert.throws(() => client.end(), /blew up/);
            assert.equal(client.counts.disconnect, 0, 'the throw got there first');

            //  ...and removeClient() comes along behind it
            client.end();
            assert.equal(client.counts.disconnect, 1, 'the socket still gets closed');
        });

        //  "We can end up calling 'end' before TTY/etc. is established, e.g. with SSH"
        it('falls back to output.end() when there is no disconnect()', () => {
            const client = makeClient({ hasDisconnect: false });
            let outputEnds = 0;
            client.output = { end: () => (outputEnds += 1) };
            client.end();
            client.end();
            assert.equal(outputEnds, 2);
        });

        it('swallows a disconnect that throws, as it always has', () => {
            const client = makeClient({ hasDisconnect: false });
            client.output = null; //  never established
            assert.doesNotThrow(() => client.end());
            assert.doesNotThrow(() => client.end());
        });
    });

    describe('the cases the teardown has to tolerate', () => {
        it('ends a session that never reached a module', () => {
            const client = makeClient({ inModule: false });
            client.end();
            client.end();
            assert.equal(client.counts.leave, 0);
            assert.equal(client.counts.disconnect, 2);
        });

        it('does not persist minutes online for an unauthenticated session', () => {
            const client = makeClient({ authenticated: false });
            client.end();
            client.end();
            assert.equal(client.counts.persist, 0);
        });

        it('ends a session with no terminal', () => {
            const client = makeClient();
            client.term = null;
            assert.doesNotThrow(() => client.end());
            assert.equal(client.counts.leave, 1);
        });
    });

    //
    //  The loop this exists for, played out in order.
    //
    describe('the removeClient loop', () => {
        it('tears down once across end -> close -> removeClient -> end', () => {
            const client = makeClient();

            //  a kick writes, then ends; the socket close brings removeClient
            //  round behind it with a second end()
            client.disconnect = () => {
                client.counts.disconnect += 1;
                if (1 === client.counts.disconnect) {
                    client.end(); //  stands in for 'close' -> removeClient()
                }
            };

            client.end();

            assert.equal(client.counts.leave, 1, 'module cleanup runs once');
            assert.equal(client.counts.persist, 1, 'minutes online written once');
            assert.equal(client.counts.termDisconnect, 1);
            assert.equal(client.counts.disconnect, 2, 'both calls close the socket');
        });
    });
});
