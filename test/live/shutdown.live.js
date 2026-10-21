'use strict';

//
//  Stop a real instance with SIGTERM and with SIGINT.
//
//  test/bbs_shutdown.test.js drives the shutdown function with fake steps;
//  only a real ./main.js shows that the signal handlers are actually
//  installed at startup and that the real steps run to "Goodbye!" and exit 0.
//  Before SIGTERM had a handler, Node's default ended the process on the spot
//  with no shutdown at all (status 143 from a shell).
//
//  Each run gets its own throwaway configuration tree under the OS temp
//  directory -- databases, logs, an empty menu file -- and only telnet,
//  on a port the OS picks. Nothing touches the checkout's own config/.
//

const { strict: assert } = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const paths = require('path');
const hjson = require('hjson');
const { spawn } = require('child_process');

const REPO_ROOT = paths.join(__dirname, '..', '..');

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

function writeInstance(dir, port) {
    const configDir = paths.join(dir, 'config');
    ['config', 'security', 'db/mods', 'logs', 'drop', 'mail'].forEach(d =>
        fs.mkdirSync(paths.join(dir, d), { recursive: true })
    );

    fs.writeFileSync(paths.join(configDir, 'menu.hjson'), '{ menus: {}, prompts: {} }\n');

    const config = {
        general: {
            boardName: 'Shutdown Test',
            menuFile: paths.join(configDir, 'menu.hjson'),
            achievementFile: paths.join(REPO_ROOT, 'config', 'achievements.hjson'),
        },
        paths: {
            config: configDir + paths.sep,
            security: paths.join(dir, 'security') + paths.sep,
            db: paths.join(dir, 'db') + paths.sep,
            modsDb: paths.join(dir, 'db', 'mods') + paths.sep,
            logs: paths.join(dir, 'logs') + paths.sep,
            dropFiles: paths.join(dir, 'drop') + paths.sep,
            emailInbound: paths.join(dir, 'mail') + paths.sep,
        },
        loginServers: {
            telnet: { enabled: true, port, address: '127.0.0.1' },
            ssh: { enabled: false },
            webSocket: { ws: { enabled: false }, wss: { enabled: false } },
        },
        contentServers: {
            web: { http: { enabled: false }, https: { enabled: false } },
            gopher: { enabled: false },
            nntp: { nntp: { enabled: false }, nntps: { enabled: false } },
        },
        chatServers: { mrc: { enabled: false } },
    };

    fs.writeFileSync(
        paths.join(configDir, 'config.hjson'),
        hjson.stringify(config, { emitRootBraces: true, space: 4, eol: '\n' })
    );
    return configDir + paths.sep;
}

//  A new caller on |port|: resolves with how the connection ended (an error
//  code, or 'closed') and how many bytes the server sent first. A caller the
//  telnet server accepts is sent its option negotiation at once.
function probe(port) {
    return new Promise(resolve => {
        let bytes = 0;
        let how = 'closed';
        const c = net.connect(port, '127.0.0.1');
        c.setTimeout(3000, () => {
            how = 'timeout';
            c.destroy();
        });
        c.on('data', chunk => {
            bytes += chunk.length;
        });
        c.on('error', e => {
            how = e.code;
        });
        c.on('close', () => resolve({ how, bytes }));
    });
}

//  Start ./main.js, wait for "System started!", send |signal|, and resolve
//  with what it printed, how it exited, and how long that took. As soon as
//  it says it is shutting down, a new caller tries to connect: |probe| is
//  what that caller got.
function startAndStop(configDir, signal, port) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['main.js', '--config', configDir], {
            cwd: REPO_ROOT,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        let signalledAt = null;
        let probed = null;

        const giveUp = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`instance did not start and stop in time:\n${output}`));
        }, 25000);

        const onData = chunk => {
            output += chunk;
            if (signalledAt === null && output.includes('System started!')) {
                signalledAt = Date.now();
                child.kill(signal);
            }
            if (probed === null && output.includes('Shutting down...')) {
                probed = probe(port);
            }
        };
        child.stdout.setEncoding('utf8').on('data', onData);
        child.stderr.setEncoding('utf8').on('data', onData);

        child.on('error', reject);
        child.on('exit', (code, sig) => {
            clearTimeout(giveUp);
            const ms = signalledAt === null ? null : Date.now() - signalledAt;
            Promise.resolve(probed).then(probe => {
                resolve({ output, code, signal: sig, ms, probe });
            });
        });
    });
}

function logMessages(dir) {
    const logFile = paths.join(dir, 'logs', 'enigma-bbs.log');
    return fs
        .readFileSync(logFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => {
            try {
                return JSON.parse(line).msg;
            } catch (e) {
                return '';
            }
        });
}

describe('shutdown on a signal (live)', function () {
    this.timeout(40000);

    ['SIGTERM', 'SIGINT'].forEach(signal => {
        describe(signal, () => {
            let dir;
            let result;

            before(async () => {
                dir = fs.mkdtempSync(paths.join(os.tmpdir(), 'enigma-shutdown-'));
                const port = await freePort();
                const configDir = writeInstance(dir, port);
                result = await startAndStop(configDir, signal, port);
            });

            after(() => {
                if (dir) {
                    fs.rmSync(dir, { recursive: true, force: true });
                }
            });

            it('started', () => {
                assert.ok(result.ms !== null, `never started:\n${result.output}`);
            });

            it('shuts down in order and exits 0', () => {
                assert.equal(result.signal, null, 'killed by the signal itself');
                assert.equal(result.code, 0, result.output);

                const out = result.output;
                const shutting = out.indexOf(`Received ${signal}. Shutting down...`);
                const goodbye = out.indexOf('Goodbye!');
                assert.ok(shutting > -1, out);
                assert.ok(goodbye > shutting, out);
            });

            it('within a few seconds', () => {
                assert.ok(result.ms < 5000, `took ${result.ms} ms`);
            });

            it('logs each step in order: listeners closed, callers disconnected, done', () => {
                const msgs = logMessages(dir);
                const order = [
                    `Received ${signal}. Shutting down...`,
                    'Stopped listening for new connections',
                    'Disconnected callers',
                    'Shutdown complete',
                ].map(m => [m, msgs.indexOf(m)]);
                order.forEach(([m, at], i) => {
                    assert.ok(at > -1, `no "${m}":\n${msgs.join('\n')}`);
                    if (i > 0) {
                        assert.ok(at > order[i - 1][1], `"${m}" out of order`);
                    }
                });
            });

            it('turns away a caller who connects once the shutdown has begun', () => {
                //  The listener closes in the same tick that prints "Shutting
                //  down...". The kernel may still complete the caller's
                //  handshake just before that and then reset it, so what
                //  shows the caller was never taken on is that the server
                //  sent nothing
                assert.ok(result.probe, 'never probed');
                const { how, bytes } = result.probe;
                assert.equal(bytes, 0, `the server took the caller on (${how})`);
                assert.ok(
                    ['ECONNREFUSED', 'ECONNRESET', 'closed'].includes(how),
                    `a new caller got: ${how}`
                );
            });
        });
    });
});
