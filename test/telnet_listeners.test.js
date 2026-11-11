/* eslint-disable no-console */
'use strict';

//
//  Named extra telnet listeners: loginServers.telnet.listeners (#593).
//
//  An install with no listeners configured must behave exactly as before:
//  one server, the same 'ready' payload. Named listeners are extras, so a bad
//  or unbindable one is logged and skipped and never fails the module.
//

const { strict: assert } = require('assert');
const net = require('net');
const _ = require('lodash');

const configModule = require('../core/config.js');
const loggerModule = require('../core/logger.js');

const TelnetPath = require.resolve('../core/servers/login/telnet.js');

function silenceConsole() {
    const original = { info: console.info, error: console.error };
    console.info = () => {};
    console.error = () => {};
    return () => {
        console.info = original.info;
        console.error = original.error;
    };
}

//  A log stub that remembers what it was told, by level
function makeLog() {
    const entries = [];
    const log = {
        entries,
        child: () => log,
    };
    ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].forEach(level => {
        log[level] = (obj, msg) => {
            entries.push({ level, obj, msg });
        };
    });
    return log;
}

//
//  telnet.js captures Config and Log at first require, so the test values
//  have to be in place before it is (re)loaded.
//
function loadTelnetWith(config) {
    const previousConfig = configModule._pushTestConfig(config);
    const previousLog = loggerModule.log;
    const log = makeLog();
    loggerModule.log = log;

    delete require.cache[TelnetPath];
    const telnet = require(TelnetPath);

    return {
        telnet,
        log,
        restore: () => {
            configModule._popTestConfig(previousConfig);
            loggerModule.log = previousLog;
            delete require.cache[TelnetPath];
        },
    };
}

function baseConfig(telnet) {
    return {
        debug: { assertsEnabled: false },
        menus: { cls: false },
        general: { boardName: 'ENiGMA½ BBS' },
        loginServers: {
            telnet: Object.assign(
                { port: 0, address: '127.0.0.1', firstMenu: 'telnetConnected' },
                telnet
            ),
        },
    };
}

function occupyPort(cb) {
    const blocker = net.createServer();
    blocker.listen(0, '127.0.0.1', () => {
        return cb(blocker.address().port, done => blocker.close(done));
    });
}

function startModule(telnet, cb) {
    const mod = new telnet.getModule();
    mod.createServer(createErr => {
        assert.equal(createErr, null);
        mod.listen(err => cb(err, mod));
    });
}

// ─── Resolving the listener map ──────────────────────────────────────────────

describe('telnet listeners: resolveListeners()', () => {
    let resolveListeners;

    before(() => {
        //  lazily, so a cached copy from another suite does not matter
        resolveListeners = require(TelnetPath).resolveListeners;
    });

    it('has nothing to start when no listeners are configured', () => {
        const { listeners, skipped } = resolveListeners({ port: 8888 });
        assert.deepEqual(listeners, []);
        assert.deepEqual(skipped, []);
    });

    it('has nothing to start for an empty map', () => {
        const { listeners, skipped } = resolveListeners({ port: 8888, listeners: {} });
        assert.deepEqual(listeners, []);
        assert.deepEqual(skipped, []);
    });

    it('starts one listener per entry, with its own port and address', () => {
        const { listeners, skipped } = resolveListeners({
            port: 8888,
            address: '0.0.0.0',
            listeners: {
                c64: { port: 6400, address: '127.0.0.1', emulation: 'petscii' },
                atari: { port: '6401', address: '127.0.0.2' },
            },
        });

        assert.deepEqual(skipped, []);
        assert.deepEqual(
            listeners.map(l => _.pick(l, ['name', 'port', 'address'])),
            [
                { name: 'c64', port: 6400, address: '127.0.0.1' },
                { name: 'atari', port: 6401, address: '127.0.0.2' },
            ]
        );
        assert.equal(listeners[0].config.emulation, 'petscii');
    });

    it('defaults a listener address to the main telnet address', () => {
        const { listeners } = resolveListeners({
            port: 8888,
            address: '192.0.2.10',
            listeners: { second: { port: 8890 } },
        });
        assert.equal(listeners[0].address, '192.0.2.10');
    });

    it('leaves the address unset (every interface) when the main one is', () => {
        const { listeners } = resolveListeners({
            port: 8888,
            listeners: { second: { port: 8890 } },
        });
        assert.equal(listeners[0].address, undefined);
    });

    it('skips a disabled listener', () => {
        const { listeners, skipped } = resolveListeners({
            port: 8888,
            listeners: {
                off: { port: 8890, enabled: false },
                on: { port: 8891, enabled: true },
            },
        });
        assert.deepEqual(
            listeners.map(l => l.name),
            ['on']
        );
        assert.equal(skipped.length, 1);
        assert.equal(skipped[0].name, 'off');
        assert.equal(skipped[0].disabled, true);
    });

    it('skips a listener with a missing or invalid port', () => {
        const { listeners, skipped } = resolveListeners({
            port: 8888,
            listeners: {
                none: {},
                word: { port: 'telnet' },
                huge: { port: 70000 },
                negative: { port: -1 },
                good: { port: 8890 },
            },
        });
        assert.deepEqual(
            listeners.map(l => l.name),
            ['good']
        );
        assert.deepEqual(
            skipped.map(s => [s.name, s.reason]),
            [
                ['none', 'invalid port'],
                ['word', 'invalid port'],
                ['huge', 'invalid port'],
                ['negative', 'invalid port'],
            ]
        );
    });

    it('skips an entry that is not an object', () => {
        const { listeners, skipped } = resolveListeners({
            port: 8888,
            listeners: { odd: 8890 },
        });
        assert.deepEqual(listeners, []);
        assert.equal(skipped[0].name, 'odd');
    });

    it('skips everything when listeners is not a map', () => {
        const { listeners, skipped } = resolveListeners({
            port: 8888,
            listeners: [{ port: 8890 }],
        });
        assert.deepEqual(listeners, []);
        assert.equal(skipped.length, 1);
    });

    it('skips a listener on the main port', () => {
        const { listeners, skipped } = resolveListeners({
            port: 8888,
            listeners: { clash: { port: 8888 } },
        });
        assert.deepEqual(listeners, []);
        assert.equal(skipped[0].name, 'clash');
        assert.equal(skipped[0].conflictsWith, 'main');
    });

    it('skips a listener whose port another listener already has', () => {
        const { listeners, skipped } = resolveListeners({
            port: 8888,
            address: '127.0.0.1',
            listeners: {
                first: { port: 8890 },
                second: { port: '8890' },
            },
        });
        assert.deepEqual(
            listeners.map(l => l.name),
            ['first']
        );
        assert.equal(skipped[0].name, 'second');
        assert.equal(skipped[0].conflictsWith, 'first');
    });

    it('treats every interface as overlapping a specific address', () => {
        const { skipped } = resolveListeners({
            port: 8888,
            listeners: { specific: { port: 8888, address: '127.0.0.1' } },
        });
        assert.equal(skipped[0].conflictsWith, 'main');
    });

    it('does not confuse a listener named "main" with the main listener', () => {
        const { listeners, skipped } = resolveListeners({
            port: 8888,
            listeners: { main: { port: 8890 }, other: { port: 8890 } },
        });
        assert.deepEqual(
            listeners.map(l => l.name),
            ['main']
        );
        assert.match(skipped[0].reason, /used by the "main" listener/);
    });

    it('allows the same port on two different specific addresses', () => {
        const { listeners, skipped } = resolveListeners({
            port: 8888,
            address: '127.0.0.1',
            listeners: { other: { port: 8888, address: '127.0.0.2' } },
        });
        assert.deepEqual(skipped, []);
        assert.equal(listeners.length, 1);
    });

    it('never treats ephemeral port 0 as a clash', () => {
        const { listeners, skipped } = resolveListeners({
            port: 0,
            listeners: { a: { port: 0 }, b: { port: 0 } },
        });
        assert.deepEqual(skipped, []);
        assert.equal(listeners.length, 2);
    });
});

// ─── The 'ready' payload ─────────────────────────────────────────────────────

describe('telnet listeners: ready payload', () => {
    let readyOptionsFor;

    before(() => {
        readyOptionsFor = require(TelnetPath).readyOptionsFor;
    });

    const config = listeners =>
        baseConfig({ firstMenu: 'telnetConnected', port: 8888, listeners });

    it('is exactly { firstMenu } for the main listener', () => {
        assert.deepEqual(readyOptionsFor(config(), undefined), {
            firstMenu: 'telnetConnected',
        });
    });

    it('stays exactly { firstMenu } for the main listener when named ones exist', () => {
        const c = config({ c64: { port: 6400, firstMenu: 'petsciiConnected' } });
        assert.deepEqual(readyOptionsFor(c, undefined), { firstMenu: 'telnetConnected' });
    });

    it("carries a named listener's own firstMenu and emulation", () => {
        const entry = { port: 6400, emulation: 'petscii', firstMenu: 'petsciiConnected' };
        const c = config({ c64: entry });
        const listener = { name: 'c64', port: 6400, address: '127.0.0.1', config: entry };

        assert.deepEqual(readyOptionsFor(c, listener), {
            firstMenu: 'petsciiConnected',
            listener: {
                name: 'c64',
                port: 6400,
                address: '127.0.0.1',
                emulation: 'petscii',
                firstMenu: 'petsciiConnected',
            },
        });
    });

    it('defaults a named listener firstMenu to the main one', () => {
        const entry = { port: 6400 };
        const c = config({ plain: entry });
        const listener = { name: 'plain', port: 6400, address: undefined, config: entry };

        const options = readyOptionsFor(c, listener);
        assert.equal(options.firstMenu, 'telnetConnected');
        assert.equal(options.listener.firstMenu, 'telnetConnected');
        assert.equal(options.listener.emulation, undefined);
    });

    it('reads firstMenu and emulation from the current configuration', () => {
        const started = { port: 6400, firstMenu: 'old' };
        const listener = { name: 'c64', port: 6400, address: undefined, config: started };
        const reloaded = config({
            c64: { port: 6400, firstMenu: 'new', emulation: 'x' },
        });

        const options = readyOptionsFor(reloaded, listener);
        assert.equal(options.firstMenu, 'new');
        assert.equal(options.listener.emulation, 'x');
        assert.equal(options.listener.port, 6400, 'the bound port, not a reloaded one');
    });

    it('keeps what it started with when the entry has since been removed', () => {
        const started = { port: 6400, firstMenu: 'old', emulation: 'petscii' };
        const listener = { name: 'c64', port: 6400, address: undefined, config: started };

        const options = readyOptionsFor(config(), listener);
        assert.equal(options.firstMenu, 'old');
        assert.equal(options.listener.emulation, 'petscii');
    });
});

// ─── The module end to end ───────────────────────────────────────────────────

describe('telnet listeners: server module', () => {
    let restoreConsole;
    let loaded;

    beforeEach(() => {
        restoreConsole = silenceConsole();
    });

    afterEach(done => {
        restoreConsole();
        if (!loaded) {
            return done();
        }
        const { mod, restore } = loaded;
        loaded = null;
        const finish = () => {
            restore();
            done();
        };
        return mod ? mod.shutdown(finish) : finish();
    });

    function start(telnetConfig, cb) {
        const { telnet, log, restore } = loadTelnetWith(baseConfig(telnetConfig));
        loaded = { restore };
        startModule(telnet, (err, mod) => {
            loaded.mod = mod;
            return cb(err, mod, log);
        });
    }

    it('runs a single server when no listeners are configured', done => {
        start({}, (err, mod, log) => {
            assert.equal(err, null);
            assert.equal(mod.server.listening, true);
            assert.deepEqual(mod.extraListeners, []);

            const listening = log.entries.filter(
                e => 'Listening for connections' === e.msg
            );
            assert.equal(listening.length, 1);
            assert.deepEqual(Object.keys(listening[0].obj).sort(), [
                'address',
                'port',
                'server',
            ]);
            assert.deepEqual(
                log.entries.filter(e => 'error' === e.level),
                []
            );
            done();
        });
    });

    it('runs one more server per listener, on its address', done => {
        start(
            {
                listeners: {
                    one: { port: 0, emulation: 'petscii' },
                    two: { port: 0, address: '127.0.0.1', firstMenu: 'other' },
                },
            },
            (err, mod, log) => {
                assert.equal(err, null);
                assert.equal(mod.server.listening, true);
                assert.equal(mod.extraListeners.length, 2);

                const ports = new Set([mod.server.address().port]);
                mod.extraListeners.forEach(l => {
                    assert.equal(l.server.listening, true, l.name);
                    assert.equal(l.server.address().address, '127.0.0.1');
                    ports.add(l.server.address().port);
                });
                assert.equal(ports.size, 3, 'three distinct ports');

                const named = log.entries.filter(
                    e => 'Listening for connections' === e.msg && e.obj.listener
                );
                assert.deepEqual(
                    named.map(e => e.obj.listener),
                    ['one', 'two']
                );
                assert.equal(named[0].obj.emulation, 'petscii');
                done();
            }
        );
    });

    it('leaves out a disabled listener', done => {
        start({ listeners: { off: { port: 0, enabled: false } } }, (err, mod, log) => {
            assert.equal(err, null);
            assert.deepEqual(mod.extraListeners, []);
            assert.ok(
                log.entries.some(
                    e => 'info' === e.level && /"off" is disabled/.test(e.msg)
                )
            );
            done();
        });
    });

    it('skips a bad port and a port in use without failing listen()', done => {
        occupyPort((busyPort, release) => {
            start(
                {
                    listeners: {
                        bad: { port: 'nope' },
                        busy: { port: busyPort, address: '127.0.0.1' },
                        good: { port: 0 },
                    },
                },
                (err, mod, log) => {
                    release(() => {
                        assert.equal(err, null, 'listen() must still succeed');
                        assert.equal(mod.server.listening, true);

                        const byName = _.keyBy(mod.extraListeners, 'name');
                        assert.equal(byName.bad, undefined);
                        assert.equal(byName.busy.failed, true);
                        assert.equal(byName.busy.server.listening, false);
                        assert.equal(byName.good.server.listening, true);

                        const errors = log.entries.filter(e => 'error' === e.level);
                        assert.ok(errors.some(e => /"bad" skipped/.test(e.msg)));
                        assert.ok(
                            errors.some(e => /"busy" could not listen/.test(e.msg))
                        );
                        done();
                    });
                }
            );
        });
    });

    it('skips a listener on the main port without failing listen()', done => {
        occupyPort((port, release) => {
            //  free it again so the main listener can have it
            release(() => {
                start({ port, listeners: { dup: { port } } }, (err, mod, log) => {
                    assert.equal(err, null);
                    assert.equal(mod.server.address().port, port);
                    assert.deepEqual(mod.extraListeners, []);
                    assert.ok(
                        log.entries.some(
                            e =>
                                'error' === e.level &&
                                /"dup" skipped: port already used by the main/.test(e.msg)
                        )
                    );
                    done();
                });
            });
        });
    });

    it('still fails listen() when the main port cannot bind', done => {
        occupyPort((port, release) => {
            start({ port, listeners: { extra: { port: 0 } } }, err => {
                release(() => {
                    assert.ok(err);
                    assert.equal(err.reasonCode, 'EADDRINUSE');
                    done();
                });
            });
        });
    });

    it('stops every server on shutdown', done => {
        start({ listeners: { a: { port: 0 } } }, (err, mod) => {
            assert.equal(err, null);
            const servers = [mod.server, mod.extraListeners[0].server];
            loaded.mod = null; //  shutting down here instead
            mod.shutdown(() => {
                servers.forEach(s => assert.equal(s.listening, false));
                done();
            });
        });
    });

    //
    //  A real connection on each port, with handleNewClient() replaced so
    //  nothing past the 'ready' event runs.
    //
    function readyFrom(mod, port, cb) {
        mod.handleNewClient = client => {
            client.once('ready', options => {
                socket.destroy();
                return cb(options);
            });
            client._clientReady(); //  rather than wait out the TTYPE timeout
        };
        const socket = net.connect(port, '127.0.0.1');
        socket.on('error', () => {});
    }

    it('emits the main payload on the main port and the listener one on a named port', done => {
        start(
            {
                firstMenu: 'telnetConnected',
                listeners: {
                    c64: { port: 0, emulation: 'petscii', firstMenu: 'petsciiConnected' },
                },
            },
            (err, mod) => {
                assert.equal(err, null);
                const named = mod.extraListeners[0];

                readyFrom(mod, mod.server.address().port, mainOptions => {
                    assert.deepEqual(mainOptions, { firstMenu: 'telnetConnected' });

                    readyFrom(mod, named.server.address().port, namedOptions => {
                        assert.deepEqual(namedOptions, {
                            firstMenu: 'petsciiConnected',
                            listener: {
                                name: 'c64',
                                port: 0,
                                address: '127.0.0.1',
                                emulation: 'petscii',
                                firstMenu: 'petsciiConnected',
                            },
                        });
                        done();
                    });
                });
            }
        );
    });
});

// ─── Configuration validation ────────────────────────────────────────────────

describe('telnet listeners: config validation', () => {
    let validate;
    let IssueCodes;

    before(() => {
        const { buildSchema } = require('../core/config/schema');
        const { validateConfig } = require('../core/config/validate');
        const DefaultConfig = require('../core/config_default');
        IssueCodes = require('../core/config/issue').IssueCodes;

        const schema = buildSchema();
        validate = user =>
            validateConfig(user, _.merge(DefaultConfig(), _.cloneDeep(user)), schema);
    });

    it('finds nothing in an existing telnet block', () => {
        assert.deepEqual(
            validate({
                loginServers: {
                    telnet: {
                        port: 8888,
                        address: '0.0.0.0',
                        enabled: true,
                        firstMenu: 'telnetConnected',
                    },
                },
            }),
            []
        );
    });

    it('finds nothing in a well formed listener map', () => {
        assert.deepEqual(
            validate({
                loginServers: {
                    telnet: {
                        port: 8888,
                        listeners: {
                            c64: {
                                port: 6400,
                                address: '127.0.0.1',
                                emulation: 'petscii',
                                firstMenu: 'petsciiConnected',
                                enabled: true,
                            },
                            minimal: { port: 6401 },
                        },
                    },
                },
            }),
            []
        );
    });

    it('reports an unknown key inside a listener, with a suggestion', () => {
        const issues = validate({
            loginServers: {
                telnet: { listeners: { c64: { port: 6400, firstMenus: 'x' } } },
            },
        });
        assert.equal(issues.length, 1);
        assert.equal(issues[0].code, IssueCodes.UnknownKey);
        assert.equal(issues[0].path, 'loginServers.telnet.listeners.c64.firstMenus');
        assert.equal(issues[0].suggestion, 'firstMenu');
    });

    it('reports a wrongly typed listener value', () => {
        const issues = validate({
            loginServers: {
                telnet: { listeners: { c64: { port: 6400, enabled: 'yes' } } },
            },
        });
        assert.deepEqual(
            issues.map(i => [i.code, i.path]),
            [[IssueCodes.TypeMismatch, 'loginServers.telnet.listeners.c64.enabled']]
        );
    });

    it('does not report listener names as unknown keys', () => {
        const issues = validate({
            loginServers: { telnet: { listeners: { anything_at_all: { port: 6400 } } } },
        });
        assert.deepEqual(issues, []);
    });
});
