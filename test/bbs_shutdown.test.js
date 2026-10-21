'use strict';

//
//  core/bbs.js shutdownSystem: which signals start it, that it runs once,
//  the order of its steps, the safety timer that ends one that hangs, the
//  file-area web step it used to get wrong (it called startup()), and the
//  log flush before it exits.
//
//  test/live/shutdown.live.js sends the signals to a real instance.
//

const { strict: assert } = require('assert');
const { EventEmitter } = require('events');
const net = require('net');
const paths = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const REPO_ROOT = paths.join(__dirname, '..');

//  A shutdown with fake steps, exit, log and console, recording what happens.
//  |steps| is called with the record, for step() below.
function harness({ steps, timeoutMs = 5000, flush = cb => cb() } = {}) {
    const { createShutdown } = require('../core/bbs.js');
    const rec = { exits: [], out: [], log: [], ran: [] };
    //  once rec.broken is set, rec.breakAfterStart ('out' or 'log') throws
    const breaks = what => {
        if (rec.broken && rec.breakAfterStart === what) {
            throw new Error(`${what} broke`);
        }
    };
    const record = level => (obj, msg) => {
        breaks('log');
        rec.log.push({ level, obj, msg: typeof obj === 'string' ? obj : msg });
    };
    const log = {
        info: record('info'),
        warn: record('warn'),
        error: record('error'),
    };
    const out = {
        info: msg => {
            breaks('out');
            rec.out.push(msg);
        },
        error: msg => {
            breaks('out');
            rec.out.push(msg);
        },
    };
    rec.done = new Promise(resolve => {
        rec.shutdown = createShutdown({
            steps: steps(rec),
            timeoutMs,
            flush,
            log,
            out,
            exit: code => {
                rec.exits.push(code);
                resolve(code);
            },
        });
    });
    return rec;
}

const step = (rec, name, run) => ({
    name,
    run: cb => {
        rec.ran.push(name);
        return run ? run(cb) : setImmediate(cb);
    },
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('bbs.js shutdown', function () {
    describe('signals', () => {
        it('SIGINT and SIGTERM both start it, each named', () => {
            const {
                registerShutdownSignals,
                ShutdownSignals,
            } = require('../core/bbs.js');
            assert.deepEqual([...ShutdownSignals].sort(), ['SIGINT', 'SIGTERM']);

            const proc = new EventEmitter();
            const calls = [];
            registerShutdownSignals(signal => calls.push(signal), proc);

            assert.equal(proc.listenerCount('SIGINT'), 1);
            assert.equal(proc.listenerCount('SIGTERM'), 1);

            //  Node passes (name, number) to a signal listener
            proc.emit('SIGTERM', 'SIGTERM', 15);
            proc.emit('SIGINT', 'SIGINT', 2);
            assert.deepEqual(calls, ['SIGTERM', 'SIGINT']);
        });
    });

    describe('createShutdown()', () => {
        it('runs every step in order, then says goodbye and exits 0', async () => {
            const r = harness({
                steps: rec => ['one', 'two', 'three'].map(n => step(rec, n)),
            });
            r.shutdown('SIGTERM');
            assert.equal(await r.done, 0);
            assert.deepEqual(r.ran, ['one', 'two', 'three']);
            assert.equal(r.out[0], 'Received SIGTERM. Shutting down...');
            assert.equal(r.out[r.out.length - 1], 'Goodbye!');
            assert.deepEqual(r.exits, [0]);
        });

        it('runs once: a second signal of either kind is logged and ignored', async () => {
            let release;
            const r = harness({
                steps: rec => [
                    step(rec, 'slow', cb => {
                        release = cb;
                    }),
                    step(rec, 'after'),
                ],
            });

            r.shutdown('SIGINT');
            r.shutdown('SIGTERM');
            r.shutdown('SIGINT');
            release();
            assert.equal(await r.done, 0);
            await delay(20);

            assert.deepEqual(r.ran, ['slow', 'after']);
            assert.deepEqual(r.exits, [0]);
            assert.deepEqual(
                r.out.filter(l => /already in progress/.test(l)),
                [
                    'Shutdown already in progress; ignoring SIGTERM',
                    'Shutdown already in progress; ignoring SIGINT',
                ]
            );
            assert.equal(r.out.filter(l => /Shutting down/.test(l)).length, 1);
        });

        it('exits non-zero, naming the step, when a step never finishes', async () => {
            const r = harness({
                timeoutMs: 40,
                steps: rec => [
                    step(rec, 'fine'),
                    step(rec, 'hangs', () => {}),
                    step(rec, 'never'),
                ],
            });

            r.shutdown('SIGTERM');
            assert.equal(await r.done, 1);
            assert.deepEqual(r.ran, ['fine', 'hangs']);

            const err = r.log.find(l => l.level === 'error');
            assert.ok(err, 'logs the timeout');
            assert.equal(err.obj.step, 'hangs');
            assert.match(err.msg, /step "hangs" never completed/);
            assert.ok(!r.out.includes('Goodbye!'));
        });

        it('does not exit a second time when a hung step finishes after the timeout', async () => {
            let late;
            const r = harness({
                timeoutMs: 20,
                steps: rec => [
                    step(rec, 'late', cb => {
                        late = cb;
                    }),
                ],
            });

            r.shutdown('SIGTERM');
            assert.equal(await r.done, 1);
            late();
            await delay(20);
            assert.deepEqual(r.exits, [1]);
        });

        it('clears the safety timer on the normal path', async () => {
            const r = harness({ timeoutMs: 30, steps: rec => [step(rec, 'quick')] });

            r.shutdown('SIGINT');
            assert.equal(await r.done, 0);
            await delay(60);
            assert.deepEqual(r.exits, [0]);
        });

        it('keeps going past a step that throws', async () => {
            const r = harness({
                steps: rec => [
                    step(rec, 'throws', () => {
                        throw new Error('boom');
                    }),
                    step(rec, 'after'),
                ],
            });

            r.shutdown('SIGTERM');
            assert.equal(await r.done, 0);
            assert.deepEqual(r.ran, ['throws', 'after']);
            const warn = r.log.find(l => l.level === 'warn');
            assert.equal(warn.obj.step, 'throws');
        });

        it('still exits when the last report or the flush throws', async () => {
            for (const hang of [false, true]) {
                for (const what of ['out', 'log', 'flush']) {
                    const r = harness({
                        timeoutMs: 30,
                        flush:
                            'flush' === what
                                ? () => {
                                      throw new Error('flush broke');
                                  }
                                : cb => cb(),
                        steps: rec => [step(rec, 'only', hang ? () => {} : undefined)],
                    });
                    //  break the console or the log only once the shutdown
                    //  has begun, so it is the last lines that fail
                    r.breakAfterStart = what;
                    r.shutdown('SIGTERM');
                    r.broken = true;
                    assert.equal(await r.done, hang ? 1 : 0, `${what}, hang=${hang}`);
                    await delay(5);
                    assert.deepEqual(r.exits, [hang ? 1 : 0], `${what}, hang=${hang}`);
                }
            }
        });

        it('lets the log catch up before it exits, either way', async () => {
            for (const hang of [false, true]) {
                const order = [];
                const r = harness({
                    timeoutMs: 30,
                    flush: cb => {
                        order.push('flush');
                        setImmediate(cb);
                    },
                    steps: rec => [step(rec, 'only', hang ? () => {} : undefined)],
                });
                r.done.then(code => order.push(`exit ${code}`));
                r.shutdown('SIGTERM');
                await r.done;
                assert.deepEqual(order, ['flush', `exit ${hang ? 1 : 0}`]);
            }
        });
    });

    describe('Log.flush()', () => {
        const Log = require('../core/logger.js');
        let savedLog;
        let tmpDir;

        before(() => {
            savedLog = Log.log;
            tmpDir = fs.mkdtempSync(paths.join(os.tmpdir(), 'enigma-flush-'));
        });

        after(() => {
            Log.log = savedLog;
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('calls back at once when nothing is queued', done => {
            Log.log = { streams: [] };
            Log.flush(done);
        });

        it('calls back once queued writes have reached the file', done => {
            const file = paths.join(tmpDir, 'log');
            const w = fs.createWriteStream(file);
            const line = 'x'.repeat(99) + '\n';
            for (let i = 0; i < 2000; i++) {
                w.write(line);
            }
            assert.ok(w.writableLength > 0, 'nothing queued; the test proves nothing');

            //  the shape of bunyan's rotating-file stream: it wraps the
            //  fs.WriteStream as .stream
            Log.log = { streams: [{ stream: { stream: w } }] };
            Log.flush(() => {
                assert.equal(w.writableLength, 0);
                assert.equal(fs.statSync(file).size, 2000 * line.length);
                w.end(done);
            });
        });

        it('gives up after its timeout', done => {
            const stuck = { writableLength: 1, write: () => true };
            Log.log = { streams: [{ stream: stuck }] };
            const t0 = Date.now();
            Log.flush(() => {
                assert.ok(Date.now() - t0 >= 20);
                return done();
            }, 25);
        });
    });

    describe('listening_server closeListeners()', () => {
        const { closeListeners } = require('../core/listening_server.js');

        function fakeLog() {
            const lines = [];
            const record = level => (obj, msg) => lines.push({ level, obj, msg });
            return { lines, info: record('info'), warn: record('warn') };
        }

        //  a server-like object whose close() stops it at once, as a
        //  net.Server's does, and whose callback waits (here: forever) for
        //  open connections to end
        function fakeServer(calls, name) {
            return {
                listening: true,
                close() {
                    calls.push(name);
                    this.listening = false;
                },
            };
        }

        function run(servers, timeoutMs = 1000) {
            const log = fakeLog();
            const t0 = Date.now();
            return new Promise(resolve =>
                closeListeners(servers, { timeoutMs, log }, err =>
                    resolve({ err, log, ms: Date.now() - t0 })
                )
            );
        }

        it('calls a module shutdown(), closes the servers it keeps, and empties the registry', async () => {
            const calls = [];
            const servers = {
                own: {
                    instance: {
                        shutdown: cb => {
                            calls.push('own.shutdown');
                            setImmediate(cb);
                        },
                        //  shutdown() is the module's own business
                        server: fakeServer(calls, 'own.server'),
                    },
                },
                telnet: { instance: { server: fakeServer(calls, 'telnet') } },
                web: {
                    instance: {
                        httpServer: fakeServer(calls, 'http'),
                        httpsServer: fakeServer(calls, 'https'),
                    },
                },
                websocket: {
                    instance: {
                        insecure: { httpServer: fakeServer(calls, 'ws') },
                        secure: { httpServer: fakeServer(calls, 'wss') },
                    },
                },
                nntp: {
                    instance: {
                        nntpServer: { server: fakeServer(calls, 'nntp') },
                        nntpsServer: { server: fakeServer(calls, 'nntps') },
                    },
                },
                //  an ssh2 Server has no .listening; address() is null once closed
                ssh: {
                    instance: {
                        server: {
                            open: true,
                            close() {
                                calls.push('ssh');
                                this.open = false;
                            },
                            address() {
                                return this.open ? { port: 22 } : null;
                            },
                        },
                    },
                },
                neither: { instance: { somethingElse: true } },
            };

            const { err, log, ms } = await run(servers);
            assert.ifError(err);
            assert.ok(ms < 500, `took ${ms} ms`);
            assert.deepEqual(
                [...calls].sort(),
                [
                    'http',
                    'https',
                    'nntp',
                    'nntps',
                    'own.shutdown',
                    'ssh',
                    'telnet',
                    'ws',
                    'wss',
                ].sort()
            );
            assert.deepEqual(servers, {});
            assert.ok(!log.lines.some(l => l.level === 'warn'), 'nothing was late');
            const done = log.lines.find(
                l => l.msg === 'Stopped listening for new connections'
            );
            assert.ok(done, 'logs that it stopped listening');
            assert.equal(done.obj.servers.length, 7);
        });

        it('gives up on a server that never confirms, within its bound, naming it', async () => {
            const servers = {
                stuck: { instance: { server: { close: () => {} } } },
                stuckOwn: { instance: { shutdown: () => {} } },
                fine: { instance: { server: fakeServer([], 'fine') } },
            };

            const { err, log, ms } = await run(servers, 50);
            assert.ifError(err);
            assert.ok(ms >= 40 && ms < 500, `took ${ms} ms`);
            assert.deepEqual(servers, {});
            const warn = log.lines.find(l => l.level === 'warn');
            assert.ok(warn, 'logs the late servers');
            assert.deepEqual([...warn.obj.servers].sort(), ['stuck', 'stuckOwn']);
        });

        it('keeps going past a server that throws', async () => {
            const calls = [];
            const servers = {
                throws: {
                    instance: {
                        server: {
                            close: () => {
                                throw new Error('boom');
                            },
                        },
                    },
                },
                fine: { instance: { server: fakeServer(calls, 'fine') } },
            };

            const { err, log, ms } = await run(servers);
            assert.ifError(err);
            assert.ok(ms < 500, `took ${ms} ms`);
            assert.deepEqual(calls, ['fine']);
            assert.deepEqual(servers, {});
            assert.ok(
                log.lines.some(l => l.level === 'warn' && l.obj.server === 'throws')
            );
        });

        it('calls back at once with nothing to close', async () => {
            const { err, ms } = await run({});
            assert.ifError(err);
            assert.ok(ms < 100);
        });

        it('stops a real net.Server accepting, without waiting for open connections', async () => {
            const server = net.createServer(() => {});
            await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
            const { port } = server.address();

            const open = net.connect(port, '127.0.0.1');
            await new Promise(resolve => open.on('connect', resolve));

            try {
                const { err, log, ms } = await run({ telnet: { instance: { server } } });
                assert.ifError(err);
                assert.ok(ms < 500, `took ${ms} ms`);
                assert.ok(!log.lines.some(l => l.level === 'warn'));

                const refused = await new Promise(resolve => {
                    const c = net.connect(port, '127.0.0.1');
                    c.on('connect', () => {
                        c.destroy();
                        resolve(null);
                    });
                    c.on('error', e => resolve(e.code));
                });
                assert.equal(refused, 'ECONNREFUSED');
                assert.ok(!open.destroyed, 'the open connection was left alone');
            } finally {
                open.destroy();
            }
        });
    });

    describe('the real steps', () => {
        it('stops listening first, then callers, then Amiga doors, and the rest after', () => {
            const { shutdownSteps } = require('../core/bbs.js');
            assert.deepEqual(
                shutdownSteps.map(s => s.name),
                [
                    'stopListeningServers',
                    'closeConnections',
                    'stopAmigaDoors',
                    'stopEventScheduler',
                    'stopFileAreaWeb',
                    'stopMsgNetwork',
                ]
            );
        });

        describe('stopFileAreaWeb', () => {
            const modPath = require.resolve('../core/file_area_web.js');
            let saved;
            const calls = [];

            before(() => {
                //  a stand-in, so the real module and everything it loads
                //  (databases, the web server) stay out of this process
                saved = require.cache[modPath];
                require.cache[modPath] = {
                    id: modPath,
                    filename: modPath,
                    loaded: true,
                    exports: {
                        startup: cb => {
                            calls.push('startup');
                            return cb(null);
                        },
                        shutdown: cb => {
                            calls.push('shutdown');
                            return cb(null);
                        },
                    },
                };
            });

            after(() => {
                if (saved) {
                    require.cache[modPath] = saved;
                } else {
                    delete require.cache[modPath];
                }
            });

            it('calls shutdown(), not startup()', done => {
                const { shutdownSteps } = require('../core/bbs.js');
                const s = shutdownSteps.find(s => s.name === 'stopFileAreaWeb');
                s.run(err => {
                    assert.ifError(err);
                    assert.deepEqual(calls, ['shutdown']);
                    return done();
                });
            });
        });
    });

    //
    //  The real file_area_web.js, in a child process: it pulls in the
    //  databases and the web server at load, which must not leak into the
    //  rest of the suite.
    //
    describe('file_area_web shutdown()', function () {
        this.timeout(20000);

        function inChild(script) {
            return spawnSync(
                process.execPath,
                [
                    '-e',
                    `require(${JSON.stringify(paths.join(REPO_ROOT, 'test', 'setup.js'))});
                    const web = require(${JSON.stringify(
                        paths.join(REPO_ROOT, 'core', 'file_area_web.js')
                    )});
                    ${script}`,
                ],
                { encoding: 'utf8', timeout: 15000 }
            );
        }

        it('is safe when startup() never ran', () => {
            const r = inChild(`
                web.shutdown(err => {
                    console.log('shutdown:' + (err ? err.message : 'ok'));
                });
            `);
            assert.equal(r.status, 0, r.stderr);
            assert.match(r.stdout, /shutdown:ok/);
        });

        it('clears pending expiry timers, so they cannot hold the process open', () => {
            //  An hour-long timer keeps this child alive unless shutdown()
            //  clears it; spawnSync's timeout would then kill it
            const r = inChild(`
                const moment = require('moment');
                web.scheduleExpire('abc', moment().add(1, 'hour'));
                web.shutdown(() => {
                    console.log('timers:' + Object.keys(web.expireTimers).length);
                });
            `);
            assert.equal(r.signal, null, 'the child had to be killed');
            assert.equal(r.status, 0, r.stderr);
            assert.match(r.stdout, /timers:0/);
        });
    });
});
