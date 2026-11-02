'use strict';

const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const paths = require('path');

const pty = require('node-pty');
const Events = require('../core/events.js');
const FileTransferModule = require('../core/file_transfer.js').getModule;

//
//  A protocol program -- sz, rz, sexyz -- is killed when its caller hangs up,
//  rather than running on to its own timeout writing to nobody. These run a
//  real child (node itself) through the module's actual spawn path.
//
//  ClientDisconnected is raised for every node's hang-up, so the transfer has
//  to keep listening through other callers' disconnects and stop listening
//  once its program exits, however it exits.
//

const DisconnectEvent = Events.getSystemEvents().ClientDisconnected;

//  a child that says it is ready, then runs until something kills it
const LONG_RUNNER = "process.stdout.write('ready'); setInterval(() => {}, 1000);";

//  ...and one that shrugs off the hangup, as a badly behaved program might
const HANGUP_IGNORER =
    "process.on('SIGHUP', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000);";

function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return false;
    }
}

function makeClient(uniqueId) {
    const noop = () => {};
    const client = {
        session: { uniqueId },
        user: { username: 'tester' },
        output: '',
        term: {
            termWidth: 80,
            termHeight: 25,
            rawWrite: data => {
                client.output += data.toString();
                client.emitter.forEach(fn => fn(client.output));
            },
        },
        emitter: [],
        setTemporaryDirectDataHandler: noop,
        restoreDataHandler: noop,
        explicitActivityTimeUpdate: noop,
        log: { warn: noop, debug: noop, info: noop, trace: noop, error: noop },
    };
    client.waitForOutput = text =>
        new Promise(resolve => {
            if (client.output.includes(text)) {
                return resolve();
            }
            client.emitter.push(out => {
                if (out.includes(text)) {
                    resolve();
                }
            });
        });
    return client;
}

//  the module without its MenuModule constructor, which drags in the menu system
function makeTransfer(client, external, extra = {}) {
    const transfer = Object.create(FileTransferModule.prototype);
    return Object.assign(
        transfer,
        {
            client,
            direction: 'send',
            protocolConfig: { external },
            recvDirectory: os.tmpdir(),
            sendQueue: [],
        },
        extra
    );
}

function sendExternal(script) {
    return { sendCmd: process.execPath, sendArgs: ['-e', script, '{filePaths}'] };
}

//  resolves with what the transfer called back, or TimedOut if it never did
const TimedOut = Symbol('timed out');
function withDeadline(promise, ms) {
    return Promise.race([
        promise,
        new Promise(resolve => setTimeout(() => resolve(TimedOut), ms).unref()),
    ]);
}

describe('File transfer: kill the protocol program on hang-up', function () {
    this.timeout(10000);

    let originalSpawn;
    let spawned;

    beforeEach(() => {
        originalSpawn = pty.spawn;
        spawned = [];
        pty.spawn = (...args) => {
            const proc = originalSpawn.apply(pty, args);
            spawned.push(proc);
            return proc;
        };
    });

    afterEach(() => {
        pty.spawn = originalSpawn;
        //  never leave a child behind for the rest of the suite, pass or fail
        spawned.forEach(proc => {
            try {
                process.kill(proc.pid, 'SIGKILL');
            } catch (e) {
                //  already gone
            }
        });
    });

    function run(transfer, args) {
        return new Promise(resolve =>
            transfer.executeExternalProtocolHandler(args, {}, (err, exitInfo) =>
                resolve({ err, exitInfo })
            )
        );
    }

    it('survives another caller hanging up, then dies with its own', async () => {
        const baseline = Events.listenerCount(DisconnectEvent);
        const client = makeClient('node1-session');
        const transfer = makeTransfer(client, sendExternal(LONG_RUNNER));

        const done = run(transfer, ['-e', LONG_RUNNER]);
        await client.waitForOutput('ready');
        const pid = spawned[0].pid;

        Events.emit(DisconnectEvent, {
            client: makeClient('node2-session'),
            connectionCount: 1,
        });
        assert.ok(isAlive(pid), 'another caller hanging up killed the transfer');
        assert.equal(Events.listenerCount(DisconnectEvent), baseline + 1);

        Events.emit(DisconnectEvent, { client, connectionCount: 0 });

        const result = await withDeadline(done, 3000);
        assert.notEqual(
            result,
            TimedOut,
            'the program was still running after the hang-up'
        );
        assert.ok(!isAlive(pid), 'the protocol program is still alive');
        assert.equal(result.err.reasonCode, 'EBADEXIT');
        assert.ok(result.exitInfo.signal, 'expected the exit to record a signal');
        assert.equal(Events.listenerCount(DisconnectEvent), baseline);
    });

    it('stops listening when the program exits by itself', async () => {
        const baseline = Events.listenerCount(DisconnectEvent);
        const client = makeClient('node1-session');
        const script = 'setTimeout(() => {}, 50);';
        const transfer = makeTransfer(client, sendExternal(script));

        const { err, exitInfo } = await run(transfer, ['-e', script]);
        assert.equal(err, null);
        assert.equal(exitInfo.exitCode, 0);
        assert.equal(Events.listenerCount(DisconnectEvent), baseline);
    });

    it('stops listening when the program fails by itself', async () => {
        const baseline = Events.listenerCount(DisconnectEvent);
        const client = makeClient('node1-session');
        const script = 'process.exit(3);';
        const transfer = makeTransfer(client, sendExternal(script));

        const { err, exitInfo } = await run(transfer, ['-e', script]);
        assert.equal(err.reasonCode, 'EBADEXIT');
        assert.equal(exitInfo.exitCode, 3);
        assert.equal(Events.listenerCount(DisconnectEvent), baseline);
    });

    it('sends SIGKILL to a program that ignores the hangup', async () => {
        const baseline = Events.listenerCount(DisconnectEvent);
        const client = makeClient('node1-session');
        const transfer = makeTransfer(client, sendExternal(HANGUP_IGNORER), {
            protocolKillGraceMs: 200,
        });

        const done = run(transfer, ['-e', HANGUP_IGNORER]);
        await client.waitForOutput('ready');
        const pid = spawned[0].pid;

        Events.emit(DisconnectEvent, { client, connectionCount: 0 });

        const result = await withDeadline(done, 3000);
        assert.notEqual(result, TimedOut, 'the program outlived the grace period');
        assert.ok(!isAlive(pid));
        assert.equal(result.exitInfo.signal, os.constants.signals.SIGKILL);
        assert.equal(Events.listenerCount(DisconnectEvent), baseline);
    });

    it('starts nothing for a caller who has already hung up', async () => {
        const baseline = Events.listenerCount(DisconnectEvent);
        const client = makeClient('node1-session');
        client.clientEnded = true;
        const transfer = makeTransfer(client, sendExternal(LONG_RUNNER));

        const result = await withDeadline(run(transfer, ['-e', LONG_RUNNER]), 1000);
        assert.equal(spawned.length, 0, 'a protocol program was started');
        assert.equal(result.err.reasonCode, 'EDISCONNECTED');
        assert.equal(Events.listenerCount(DisconnectEvent), baseline);
    });

    it('does not count a download killed by the hang-up as sent', async () => {
        const client = makeClient('node1-session');
        const transfer = makeTransfer(client, sendExternal(LONG_RUNNER), {
            sendQueue: [{ path: '/tmp/never-sent.zip', fileId: 1 }],
        });

        const done = new Promise(resolve => transfer.sendFiles(err => resolve(err)));
        await client.waitForOutput('ready');

        Events.emit(DisconnectEvent, { client, connectionCount: 0 });

        const err = await withDeadline(done, 3000);
        assert.notEqual(err, TimedOut, 'the program was still running after the hang-up');
        assert.ok(err, 'a killed download was reported as a success');
        assert.ok(!transfer.sendQueue[0].sent, 'a killed download was marked sent');
    });

    it('does not count a download killed by anyone else as sent', async () => {
        const client = makeClient('node1-session');
        const script = "process.kill(process.pid, 'SIGTERM');";
        const transfer = makeTransfer(client, sendExternal(script), {
            sendQueue: [{ path: '/tmp/never-sent.zip', fileId: 1 }],
        });

        const err = await new Promise(resolve => transfer.sendFiles(resolve));
        assert.ok(err, 'a program killed by a signal was reported as a success');
        assert.equal(err.reasonCode, 'EBADEXIT');
        assert.ok(!transfer.sendQueue[0].sent);
    });

    describe('an upload cut off by the hang-up', () => {
        let recvDir;

        beforeEach(() => {
            recvDir = fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-ft-hangup-'));
        });

        afterEach(() => {
            fs.rmSync(recvDir, { recursive: true, force: true });
        });

        it('keeps only the files its DSZLOG confirms', async () => {
            //  one file finished and logged, a second still arriving
            const script = [
                "const fs = require('fs');",
                "fs.writeFileSync('done.zip', Buffer.alloc(12));",
                'fs.appendFileSync(process.env.DSZLOG,',
                "  'R      12 115200 bps   12 cps   0 errors     0 1024 done.zip 0\\n');",
                "fs.writeFileSync('partial.zip', Buffer.alloc(5));",
                "process.stdout.write('ready');",
                'setInterval(() => {}, 1000);',
            ].join('\n');

            const client = makeClient('node1-session');
            const transfer = makeTransfer(
                client,
                {
                    recvCmd: process.execPath,
                    recvArgs: ['-e', script],
                    dszLog: true,
                },
                { direction: 'recv', recvDirectory: recvDir }
            );

            const done = new Promise(resolve => transfer.recvFiles(resolve));
            await client.waitForOutput('ready');

            Events.emit(DisconnectEvent, { client, connectionCount: 0 });

            const err = await withDeadline(done, 3000);
            assert.notEqual(
                err,
                TimedOut,
                'the program was still running after the hang-up'
            );
            assert.equal(err, null, 'expected the DSZLOG salvage to keep done.zip');
            assert.deepEqual(transfer.recvFilePaths, [paths.join(recvDir, 'done.zip')]);
        });
    });
});
