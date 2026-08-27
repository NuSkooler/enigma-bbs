/* eslint-disable no-console */
'use strict';

const { strict: assert } = require('assert');
const net = require('net');
const { execFileSync } = require('child_process');

const {
    listenServer,
    makeBindError,
    formatBindTarget,
    consoleStyle,
} = require('../core/server_listen.js');

// ── helpers ───────────────────────────────────────────────────────────────────

//  listenServer() and friends report to the console by design; keep the mocha
//  output readable and let individual tests assert on what was written.
function captureConsole() {
    const captured = { info: [], error: [] };
    const original = { info: console.info, error: console.error };

    console.info = (...args) => captured.info.push(args.join(' '));
    console.error = (...args) => captured.error.push(args.join(' '));

    captured.restore = () => {
        console.info = original.info;
        console.error = original.error;
    };
    return captured;
}

//  Occupy an ephemeral port and hand back both the port and a closer. Binding
//  port 0 lets the OS pick something guaranteed free, which avoids the flakiness
//  of hard-coding a port that may be in use on a developer's machine or in CI.
function occupyPort(cb) {
    const blocker = net.createServer();
    blocker.listen(0, '127.0.0.1', () => {
        return cb(blocker.address().port, done => blocker.close(done));
    });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('server_listen — bind result reporting', () => {
    let consoleOut;

    beforeEach(() => {
        consoleOut = captureConsole();
    });

    afterEach(() => {
        consoleOut.restore();
    });

    describe('listenServer', () => {
        it('calls back once with no error when the bind succeeds', done => {
            const server = net.createServer();
            let calls = 0;

            listenServer(server, { port: 0, address: '127.0.0.1', name: 'test' }, err => {
                calls += 1;
                assert.equal(err, null);
                assert.equal(server.listening, true);

                //  give any stray second callback a chance to land
                setTimeout(() => {
                    assert.equal(calls, 1);
                    server.close(() => done());
                }, 50);
            });
        });

        //
        //  Regression for #547: a second instance bound nothing, printed
        //  nothing and never exited. The root cause was that Node's
        //  listen(port, host, cb) callback is a one-shot 'listening' listener,
        //  so on EADDRINUSE it never fired and the startup waterfall in
        //  listening_server.js simply stopped advancing.
        //
        it('calls back with an error when the port is already in use', done => {
            occupyPort((port, release) => {
                const server = net.createServer();

                listenServer(
                    server,
                    { port, address: '127.0.0.1', name: 'telnet' },
                    err => {
                        assert.ok(err, 'expected a bind error');
                        assert.equal(err.bindFailure, true);
                        assert.equal(err.reasonCode, 'EADDRINUSE');
                        assert.match(err.message, /telnet server could not bind/);
                        assert.match(err.reason, /already in use/);
                        assert.equal(server.listening, false);

                        release(() => done());
                    }
                );
            });
        });

        it('calls back exactly once even though listen() never fires its callback', done => {
            occupyPort((port, release) => {
                const server = net.createServer();
                let calls = 0;

                listenServer(
                    server,
                    { port, address: '127.0.0.1', name: 'telnet' },
                    () => {
                        calls += 1;
                    }
                );

                setTimeout(() => {
                    assert.equal(calls, 1, 'callback should fire exactly once');
                    release(() => done());
                }, 100);
            });
        });

        it('reports the failure to the console so the operator sees it', done => {
            occupyPort((port, release) => {
                const server = net.createServer();

                listenServer(
                    server,
                    { port, address: '127.0.0.1', name: 'telnet' },
                    err => {
                        assert.equal(err.consoleReported, true);
                        assert.equal(consoleOut.error.length, 1);
                        assert.match(consoleOut.error[0], /telnet/);
                        assert.match(consoleOut.error[0], /FAILED/);
                        release(() => done());
                    }
                );
            });
        });

        it('reports a successful bind to the console', done => {
            const server = net.createServer();
            listenServer(
                server,
                { port: 0, address: '127.0.0.1', name: 'gopher' },
                () => {
                    assert.equal(consoleOut.info.length, 1);
                    assert.match(consoleOut.info[0], /gopher/);
                    assert.match(consoleOut.info[0], /listening on/);
                    server.close(() => done());
                }
            );
        });

        //  Once bound, a later socket error must not re-enter the callback --
        //  that would be a double call into async.series during startup.
        it('does not call back again on a post-bind error', done => {
            const server = net.createServer();
            let calls = 0;

            listenServer(server, { port: 0, address: '127.0.0.1', name: 'test' }, () => {
                calls += 1;

                //  Emitting 'error' with no listener would throw; the persistent
                //  handler installed after a successful bind should absorb it.
                assert.doesNotThrow(() => {
                    server.emit('error', new Error('later boom'));
                });

                setTimeout(() => {
                    assert.equal(calls, 1);
                    server.close(() => done());
                }, 50);
            });
        });

        it('surfaces a synchronous listen() throw as a bind error', done => {
            const server = net.createServer();

            //  A negative port makes Node throw rather than emit 'error'.
            listenServer(server, { port: -1, address: '127.0.0.1', name: 'web' }, err => {
                assert.ok(err, 'expected an error');
                assert.equal(err.bindFailure, true);
                done();
            });
        });
    });

    describe('formatBindTarget', () => {
        it('renders a configured address', () => {
            assert.equal(formatBindTarget('10.0.0.5', 8888), '10.0.0.5:8888');
        });

        //  Only BinkP defines an address default; every other server leaves it
        //  undefined and Node binds all interfaces.
        it('renders a missing address as a wildcard rather than "undefined"', () => {
            assert.equal(formatBindTarget(undefined, 8888), '*:8888');
        });
    });

    describe('makeBindError', () => {
        const opts = { name: 'telnet', port: 8888, address: '0.0.0.0' };

        it('explains EADDRINUSE in terms an operator can act on', () => {
            const err = makeBindError({ code: 'EADDRINUSE' }, opts);
            assert.match(err.reason, /0\.0\.0\.0:8888 is already in use/);
            assert.match(err.reason, /another ENiGMA½ instance/);
            assert.equal(err.reasonCode, 'EADDRINUSE');
        });

        it('explains EACCES as a privilege problem', () => {
            const err = makeBindError({ code: 'EACCES' }, { ...opts, port: 23 });
            assert.match(err.reason, /permission denied/);
            assert.match(err.reason, /below 1024/);
        });

        it('falls back to the underlying message for unknown codes', () => {
            const err = makeBindError({ code: 'EWAT', message: 'something odd' }, opts);
            assert.match(err.reason, /something odd/);
        });

        it('marks the error as a bind failure', () => {
            const err = makeBindError({ code: 'EADDRINUSE' }, opts);
            assert.equal(err.bindFailure, true);
        });
    });

    //
    //  server_listen runs before initializeDatabases(). stat_log.js captures
    //  dbs.system at load time, so anything that pulls it in this early leaves
    //  it undefined for the life of the process and StatLog.init() then throws
    //  'Cannot read properties of undefined (reading prepare)'. color_codes.js
    //  reaches it via predefined_mci -> message_area, which is why this module
    //  renders its own pipe codes. Guard that boundary.
    //
    describe('module isolation', () => {
        it('does not pull in the database-dependent module graph', () => {
            const probe = [
                `const { consoleStyle } = require(${JSON.stringify(
                    require.resolve('../core/server_listen.js')
                )});`,
                "consoleStyle('|07probe', { isTTY: true });",
                'const re = /core\\/(stat_log|message_area|predefined_mci|color_codes)\\.js$/;',
                'console.log(',
                '    JSON.stringify(Object.keys(require.cache).filter(f => re.test(f)))',
                ');',
            ].join('\n');

            const out = execFileSync(process.execPath, ['-e', probe], {
                encoding: 'utf8',
            });

            assert.deepEqual(
                JSON.parse(out.trim()),
                [],
                'server_listen must stay standalone at startup'
            );
        });
    });

    describe('consoleStyle', () => {
        const PIPE = '|10hello |15world';

        it('strips pipe codes when the stream is not a TTY', () => {
            assert.equal(consoleStyle(PIPE, { isTTY: false }), 'hello world');
        });

        it('emits ANSI when the stream is a TTY', () => {
            const out = consoleStyle(PIPE, { isTTY: true });
            assert.ok(out.includes('\u001b['), 'expected ANSI escapes');
            assert.ok(out.endsWith('\u001b[0m'), 'expected a trailing reset');
        });

        it('honours NO_COLOR even on a TTY', () => {
            const had = 'NO_COLOR' in process.env;
            const prev = process.env.NO_COLOR;
            process.env.NO_COLOR = '1';
            try {
                assert.equal(consoleStyle(PIPE, { isTTY: true }), 'hello world');
            } finally {
                if (had) {
                    process.env.NO_COLOR = prev;
                } else {
                    delete process.env.NO_COLOR;
                }
            }
        });
    });
});
