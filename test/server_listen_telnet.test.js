/* eslint-disable no-console */
'use strict';

//
//  Integration coverage for issue #547.
//
//  server_listen.test.js exercises the helper directly; this drives a real
//  server module end to end, so the wiring in telnet.js is covered too. Telnet
//  stands in for the rest: every login/content/chat server now routes its bind
//  through the same helper.
//

const { strict: assert } = require('assert');
const net = require('net');

const configModule = require('../core/config.js');

//  Quiet the startup reporting for this suite.
function silenceConsole() {
    const original = { info: console.info, error: console.error };
    console.info = () => {};
    console.error = () => {};
    return () => {
        console.info = original.info;
        console.error = original.error;
    };
}

function occupyPort(cb) {
    const blocker = net.createServer();
    blocker.listen(0, '127.0.0.1', () => {
        return cb(blocker.address().port, done => blocker.close(done));
    });
}

//
//  telnet.js captures `Config` at first require, so the test config has to be
//  in place before the module is (re)loaded — see the note in test/setup.js.
//
function loadTelnetWith(config) {
    const previous = configModule._pushTestConfig(config);
    delete require.cache[require.resolve('../core/servers/login/telnet.js')];
    const telnet = require('../core/servers/login/telnet.js');
    return {
        telnet,
        restore: () => {
            configModule._popTestConfig(previous);
            delete require.cache[require.resolve('../core/servers/login/telnet.js')];
        },
    };
}

describe('telnet server — bind failure reaches the startup callback (#547)', () => {
    let restoreConsole;

    beforeEach(() => {
        restoreConsole = silenceConsole();
    });

    afterEach(() => {
        restoreConsole();
    });

    it('calls back with an EADDRINUSE error when the port is taken', done => {
        occupyPort((port, release) => {
            const { telnet, restore } = loadTelnetWith({
                debug: { assertsEnabled: false },
                menus: { cls: false },
                loginServers: { telnet: { port, address: '127.0.0.1' } },
            });

            const mod = new telnet.getModule();
            mod.createServer(createErr => {
                assert.equal(createErr, null);

                mod.listen(err => {
                    assert.ok(err, 'listen() must report the bind failure');
                    assert.equal(err.bindFailure, true);
                    assert.equal(err.reasonCode, 'EADDRINUSE');
                    assert.match(err.message, /telnet server could not bind/);

                    restore();
                    release(() => done());
                });
            });
        });
    });

    it('calls back cleanly when the port is free', done => {
        const { telnet, restore } = loadTelnetWith({
            debug: { assertsEnabled: false },
            menus: { cls: false },
            loginServers: { telnet: { port: 0, address: '127.0.0.1' } },
        });

        const mod = new telnet.getModule();
        mod.createServer(() => {
            mod.listen(err => {
                assert.equal(err, null);
                assert.equal(mod.server.listening, true);

                mod.server.close(() => {
                    restore();
                    done();
                });
            });
        });
    });
});
