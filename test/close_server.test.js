'use strict';

//
//  server_listen.closeServer(): the one copy shared by listening_server.js and
//  the telnet server's own shutdown (they had drifted apart; #1017).
//

const { strict: assert } = require('assert');
const { EventEmitter } = require('events');
const net = require('net');

const { closeServer } = require('../core/server_listen.js');

function makeLog() {
    const entries = [];
    const log = {};
    ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].forEach(level => {
        log[level] = (obj, msg) => entries.push({ level, obj, msg });
    });
    log.entries = entries;
    return log;
}

describe('server_listen closeServer()', function () {
    it('a net.Server that never listened counts as stopped at once', done => {
        closeServer(net.createServer(), makeLog(), 'test', done);
    });

    it('stops a listening net.Server without waiting for open connections', done => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
            const sock = net.connect(server.address().port, '127.0.0.1', () => {
                closeServer(server, makeLog(), 'test', () => {
                    assert.equal(server.listening, false);
                    sock.destroy();
                    return done();
                });
            });
        });
    });

    //  ssh2's Server has no .listening; address() is null once it has stopped
    it('an ssh2-style server whose address() is null counts as stopped', done => {
        const server = new EventEmitter();
        server.close = () => {}; //  callback held back, as with open connections
        server.address = () => null;
        closeServer(server, makeLog(), 'ssh', done);
    });

    it('an ssh2-style server still reporting an address waits for close()', done => {
        const server = new EventEmitter();
        let closeCb;
        server.close = cb => (closeCb = cb);
        server.address = () => ({ port: 1 });

        let called = 0;
        closeServer(server, makeLog(), 'ssh', () => (called += 1));
        assert.equal(called, 0);
        closeCb();
        closeCb(); //  and only once
        assert.equal(called, 1);
        return done();
    });

    it('a close() that throws is logged and counts as stopped', done => {
        const log = makeLog();
        const server = {
            close: () => {
                throw new Error('nope');
            },
        };
        closeServer(server, log, 'broken', () => {
            assert.equal(log.entries.length, 1);
            assert.equal(log.entries[0].level, 'warn');
            assert.equal(log.entries[0].obj.server, 'broken');
            return done();
        });
    });
});
