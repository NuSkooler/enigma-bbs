'use strict';

const { strict: assert } = require('assert');
const net = require('net');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

//  Mock logger before loading any module that pulls it in
const loggerModule = require('../core/logger.js');
if (!loggerModule.log) {
    loggerModule.log = { warn() {}, info() {}, debug() {}, trace() {}, error() {} };
}

const { BinkpSession } = require('../core/binkp/session');

// ── helpers ───────────────────────────────────────────────────────────────────

const TEMP_DIR = os.tmpdir();

//  Default opts shared by tests — override per-test as needed
const ANSWERING_BASE = {
    role: 'answering',
    addresses: ['1:1/1@testnet'],
    systemName: 'Test Server',
    sysopName: 'TestOp',
    location: 'Testville',
    tempDir: TEMP_DIR,
};

const ORIGINATING_BASE = {
    role: 'originating',
    addresses: ['2:2/2@testnet'],
    systemName: 'Test Client',
    sysopName: 'TestOp',
    location: 'Clientville',
    tempDir: TEMP_DIR,
};

//  Create a connected pair of BinkpSessions over a loopback TCP socket.
//  Resolves with { clientSess, serverSess } before either session is started.
function makeSessionPair(clientOpts = {}, serverOpts = {}) {
    return new Promise((resolve, reject) => {
        let serverSess;
        const server = net.createServer(socket => {
            serverSess = new BinkpSession(socket, { ...ANSWERING_BASE, ...serverOpts });
        });

        server.on('error', reject);

        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            const clientSocket = net.createConnection(port, '127.0.0.1');

            clientSocket.on('error', reject);
            clientSocket.once('connect', () => {
                server.close(); // no more connections needed
                const clientSess = new BinkpSession(clientSocket, {
                    ...ORIGINATING_BASE,
                    ...clientOpts,
                });
                resolve({ clientSess, serverSess });
            });
        });
    });
}

//  Returns a Promise that resolves when an event fires, or rejects on 'error'.
function waitFor(emitter, event, rejectOn = 'error') {
    return new Promise((resolve, reject) => {
        emitter.once(event, (...args) => resolve(args));
        if (rejectOn) {
            emitter.once(rejectOn, err =>
                reject(err instanceof Error ? err : new Error(String(err)))
            );
        }
    });
}

//  Run both sessions to completion, resolving when both emit 'session-end'.
function runToEnd(clientSess, serverSess) {
    const clientDone = waitFor(clientSess, 'session-end');
    const serverDone = waitFor(serverSess, 'session-end');
    clientSess.start();
    serverSess.start();
    return Promise.all([clientDone, serverDone]);
}

//  Write a small temp file, return { filePath, size, timestamp }.
async function makeTempFile(content = 'TESTDATA') {
    const filePath = path.join(
        TEMP_DIR,
        `binkp_test_${Date.now()}_${Math.random().toString(36).slice(2)}.pkt`
    );
    await fsp.writeFile(filePath, content);
    const { size } = await fsp.stat(filePath);
    const timestamp = Math.floor(Date.now() / 1000);
    return { filePath, size, timestamp };
}

// ── Handshake — CRAM ──────────────────────────────────────────────────────────

describe('BinkpSession — CRAM authentication', () => {
    it('answering side sends CRAM challenge as the very first frame', done => {
        const server = net.createServer(socket => {
            const frames = [];
            socket.once('data', chunk => {
                // Parse the first frame manually: check T bit + OPT CRAM-MD5
                const isCommand = (chunk[0] & 0x80) !== 0;
                const size = ((chunk[0] & 0x7f) << 8) | chunk[1];
                const payload = chunk.slice(2, 2 + size);
                frames.push({
                    isCommand,
                    cmdId: payload[0],
                    arg: payload.slice(1).toString(),
                });
                socket.destroy();
                server.close(() => {
                    try {
                        assert.ok(frames[0].isCommand, 'first frame must be a command');
                        assert.equal(
                            frames[0].cmdId,
                            0,
                            'first frame must be M_NUL (id=0)'
                        );
                        assert.ok(
                            frames[0].arg.startsWith('OPT CRAM-MD5-'),
                            `first M_NUL arg must be CRAM challenge, got: "${frames[0].arg}"`
                        );
                        done();
                    } catch (e) {
                        done(e);
                    }
                });
            });
        });

        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            const sess = new BinkpSession(net.createConnection(port, '127.0.0.1'), {
                ...ANSWERING_BASE,
                getPassword: () => 'pass',
            });
            sess.start();
        });
    });

    it('authenticates securely when both sides share a password (CRAM-MD5)', async () => {
        const pw = 'sharedSecret42';
        const { clientSess, serverSess } = await makeSessionPair(
            { getPassword: () => pw },
            { getPassword: () => pw }
        );

        const serverAuth = waitFor(serverSess, 'authenticated');
        const clientAuth = waitFor(clientSess, 'authenticated');

        clientSess.start();
        serverSess.start();

        const [[serverIsSecure], [clientIsSecure]] = await Promise.all([
            serverAuth,
            clientAuth,
        ]);
        assert.ok(serverIsSecure, 'server should report secure session');
        assert.ok(clientIsSecure, 'client should report secure session');

        await Promise.all([
            waitFor(clientSess, 'session-end', null),
            waitFor(serverSess, 'session-end', null),
        ]);
    });

    it('results in non-secure session when no password is configured', async () => {
        const { clientSess, serverSess } = await makeSessionPair(
            { getPassword: () => null },
            { getPassword: () => null }
        );

        const serverAuth = waitFor(serverSess, 'authenticated');
        const clientAuth = waitFor(clientSess, 'authenticated');

        clientSess.start();
        serverSess.start();

        const [[serverIsSecure], [clientIsSecure]] = await Promise.all([
            serverAuth,
            clientAuth,
        ]);
        assert.ok(!serverIsSecure, 'server should report non-secure session');
        assert.ok(!clientIsSecure, 'client should report non-secure session');

        await Promise.all([
            waitFor(clientSess, 'session-end', null),
            waitFor(serverSess, 'session-end', null),
        ]);
    });

    it('results in non-secure session when passwords do not match', async () => {
        const { clientSess, serverSess } = await makeSessionPair(
            { getPassword: () => 'wrong' },
            { getPassword: () => 'right' }
        );

        const serverAuth = waitFor(serverSess, 'authenticated');
        const clientAuth = waitFor(clientSess, 'authenticated');

        clientSess.start();
        serverSess.start();

        const [[serverIsSecure]] = await Promise.all([serverAuth, clientAuth]);
        assert.ok(!serverIsSecure, 'server should report non-secure (bad password)');

        await Promise.all([
            waitFor(clientSess, 'session-end', null),
            waitFor(serverSess, 'session-end', null),
        ]);
    });
});

// ── Handshake — address exchange ──────────────────────────────────────────────

describe('BinkpSession — address exchange', () => {
    it("each side receives the other's addresses via the addresses event", async () => {
        const { clientSess, serverSess } = await makeSessionPair();

        const serverAddrsP = waitFor(serverSess, 'addresses');
        const clientAddrsP = waitFor(clientSess, 'addresses');

        clientSess.start();
        serverSess.start();

        const [[serverGotAddrs], [clientGotAddrs]] = await Promise.all([
            serverAddrsP,
            clientAddrsP,
        ]);

        assert.deepEqual(serverGotAddrs, ORIGINATING_BASE.addresses);
        assert.deepEqual(clientGotAddrs, ANSWERING_BASE.addresses);

        await Promise.all([
            waitFor(clientSess, 'session-end', null),
            waitFor(serverSess, 'session-end', null),
        ]);
    });
});

// ── Session lifecycle — no files ──────────────────────────────────────────────

describe('BinkpSession — session lifecycle', () => {
    it('both sessions emit session-end when there are no files to exchange', async () => {
        const { clientSess, serverSess } = await makeSessionPair();
        await runToEnd(clientSess, serverSess);
        // If we reach here without timeout, both sessions ended cleanly
    });
});

// ── File transfer ─────────────────────────────────────────────────────────────

describe('BinkpSession — file transfer', () => {
    let testFile;

    before(async () => {
        testFile = await makeTempFile('PKT:HELLO FIDONET WORLD');
    });

    after(async () => {
        await fsp.unlink(testFile.filePath).catch(() => {});
    });

    it('originating side sends a file and receives acknowledgement', async () => {
        const { clientSess, serverSess } = await makeSessionPair();

        let serverReceived = null;
        serverSess.on('file-received', (name, size, ts, tempPath) => {
            serverReceived = { name, size, ts, tempPath };
        });

        let clientFileSent = false;
        clientSess.on('file-sent', name => {
            clientFileSent = true;
        });

        clientSess.queueFile(
            testFile.filePath,
            'test.pkt',
            testFile.size,
            testFile.timestamp,
            'keep'
        );

        await runToEnd(clientSess, serverSess);

        assert.ok(serverReceived, 'server should have received a file');
        assert.equal(serverReceived.name, 'test.pkt');
        assert.equal(serverReceived.size, testFile.size);
        assert.ok(clientFileSent, 'client should have received file-sent event');

        // Verify content
        const received = await fsp.readFile(serverReceived.tempPath);
        assert.equal(received.toString(), 'PKT:HELLO FIDONET WORLD');
        await fsp.unlink(serverReceived.tempPath).catch(() => {});
    });

    it('answering side sends a file to the originating side', async () => {
        const { clientSess, serverSess } = await makeSessionPair();

        let clientReceived = null;
        clientSess.on('file-received', (name, size, ts, tempPath) => {
            clientReceived = { name, size, ts, tempPath };
        });

        serverSess.on('authenticated', () => {
            serverSess.queueFile(
                testFile.filePath,
                'fromserver.pkt',
                testFile.size,
                testFile.timestamp,
                'keep'
            );
        });

        await runToEnd(clientSess, serverSess);

        assert.ok(clientReceived, 'client should have received a file from server');
        assert.equal(clientReceived.name, 'fromserver.pkt');

        const received = await fsp.readFile(clientReceived.tempPath);
        assert.equal(received.toString(), 'PKT:HELLO FIDONET WORLD');
        await fsp.unlink(clientReceived.tempPath).catch(() => {});
    });

    it('transfers files in both directions simultaneously', async () => {
        const clientFile = await makeTempFile('FROM_CLIENT');
        const serverFile = await makeTempFile('FROM_SERVER');

        const { clientSess, serverSess } = await makeSessionPair();

        let clientReceived = null;
        let serverReceived = null;

        clientSess.on('file-received', (name, size, ts, tempPath) => {
            clientReceived = tempPath;
        });
        serverSess.on('file-received', (name, size, ts, tempPath) => {
            serverReceived = tempPath;
        });

        clientSess.queueFile(
            clientFile.filePath,
            'from_client.pkt',
            clientFile.size,
            clientFile.timestamp,
            'keep'
        );
        serverSess.on('authenticated', () => {
            serverSess.queueFile(
                serverFile.filePath,
                'from_server.pkt',
                serverFile.size,
                serverFile.timestamp,
                'keep'
            );
        });

        await runToEnd(clientSess, serverSess);

        assert.ok(serverReceived, 'server should have received client file');
        assert.ok(clientReceived, 'client should have received server file');

        const srv = await fsp.readFile(serverReceived);
        const cli = await fsp.readFile(clientReceived);
        assert.equal(srv.toString(), 'FROM_CLIENT');
        assert.equal(cli.toString(), 'FROM_SERVER');

        await Promise.all([
            fsp.unlink(serverReceived).catch(() => {}),
            fsp.unlink(clientReceived).catch(() => {}),
            fsp.unlink(clientFile.filePath).catch(() => {}),
            fsp.unlink(serverFile.filePath).catch(() => {}),
        ]);
    });

    it('fires file-sent on the sending side after M_GOT', async () => {
        const { clientSess, serverSess } = await makeSessionPair();

        const sentNames = [];
        clientSess.on('file-sent', name => sentNames.push(name));
        serverSess.on('file-received', (name, size, ts, tempPath) => {
            fsp.unlink(tempPath).catch(() => {});
        });

        clientSess.queueFile(
            testFile.filePath,
            'ack.pkt',
            testFile.size,
            testFile.timestamp,
            'keep'
        );

        await runToEnd(clientSess, serverSess);

        assert.deepEqual(sentNames, ['ack.pkt']);
    });

    it('deletes the outbound file when disposition is delete', async () => {
        const tmpFile = await makeTempFile('DISPOSABLE');
        const { clientSess, serverSess } = await makeSessionPair();

        serverSess.on('file-received', (name, size, ts, tempPath) => {
            fsp.unlink(tempPath).catch(() => {});
        });

        clientSess.queueFile(
            tmpFile.filePath,
            'delete_me.pkt',
            tmpFile.size,
            tmpFile.timestamp,
            'delete'
        );

        await runToEnd(clientSess, serverSess);

        // File should have been deleted after M_GOT
        await assert.rejects(
            fsp.access(tmpFile.filePath),
            { code: 'ENOENT' },
            'sent file should be deleted'
        );
    });
});

// ── NR mode ───────────────────────────────────────────────────────────────────

describe('BinkpSession — NR mode', () => {
    it('negotiates NR mode when both sides support it', async () => {
        let nrNegotiated = false;

        const { clientSess, serverSess } = await makeSessionPair();

        // Patch: observe the _useNR flag after authenticated
        serverSess.on('authenticated', () => {
            nrNegotiated = serverSess._useNR;
        });

        clientSess.start();
        serverSess.start();

        await Promise.all([
            waitFor(clientSess, 'session-end', null),
            waitFor(serverSess, 'session-end', null),
        ]);

        assert.ok(
            nrNegotiated,
            'NR mode should be negotiated when both sides announce it'
        );
    });
});

// ── Duplicate detection ───────────────────────────────────────────────────────

describe('BinkpSession — duplicate detection (hasFile)', () => {
    it('sends M_GOT immediately when hasFile returns true for an inbound file', async () => {
        const f = await makeTempFile('DUPLICATE_FILE');

        const { clientSess, serverSess } = await makeSessionPair(
            {},
            {
                // Server claims it already has the file
                hasFile: (name, size, ts) => name === 'dup.pkt',
            }
        );

        let serverFileReceived = false;
        serverSess.on('file-received', () => {
            serverFileReceived = true;
        });

        clientSess.queueFile(f.filePath, 'dup.pkt', f.size, f.timestamp, 'keep');

        await runToEnd(clientSess, serverSess);

        assert.ok(
            !serverFileReceived,
            'server should not have received a file it already has'
        );

        await fsp.unlink(f.filePath).catch(() => {});
    });
});

// ── sendIfPwd ─────────────────────────────────────────────────────────────────

describe('BinkpSession — sendIfPwd', () => {
    it('does not send files on a non-secure session when sendIfPwd is true', async () => {
        const f = await makeTempFile('SECURE_ONLY');

        const { clientSess, serverSess } = await makeSessionPair(
            { sendIfPwd: true, getPassword: () => null },
            { getPassword: () => null }
        );

        let serverFileReceived = false;
        serverSess.on('file-received', () => {
            serverFileReceived = true;
        });

        clientSess.queueFile(f.filePath, 'secret.pkt', f.size, f.timestamp, 'keep');

        await runToEnd(clientSess, serverSess);

        assert.ok(!serverFileReceived, 'file should not be sent on a non-secure session');

        await fsp.unlink(f.filePath).catch(() => {});
    });

    it('sends files on a secure session even when sendIfPwd is true', async () => {
        const f = await makeTempFile('SECURE_OK');
        const pw = 'securepass';

        const { clientSess, serverSess } = await makeSessionPair(
            { sendIfPwd: true, getPassword: () => pw },
            { getPassword: () => pw }
        );

        let serverFileReceived = false;
        serverSess.on('file-received', (name, size, ts, tempPath) => {
            serverFileReceived = true;
            fsp.unlink(tempPath).catch(() => {});
        });

        clientSess.queueFile(f.filePath, 'secured.pkt', f.size, f.timestamp, 'keep');

        await runToEnd(clientSess, serverSess);

        assert.ok(serverFileReceived, 'file should be sent when session is secure');

        await fsp.unlink(f.filePath).catch(() => {});
    });
});

// ── M_SKIP ────────────────────────────────────────────────────────────────────

describe('BinkpSession — M_SKIP handling', () => {
    it('emits file-skipped when remote sends M_SKIP', done => {
        //  Build a raw M_SKIP frame directly; inject it into a session via a
        //  passthrough server that speaks just enough BinkP to exercise the handler.
        const { buildCommandFrame } = require('../core/binkp/frame');
        const { Commands } = require('../core/binkp/commands');

        const server = net.createServer(serverSocket => {
            const sess = new BinkpSession(serverSocket, ANSWERING_BASE);
            sess.on('authenticated', () => {
                // Send a M_SKIP frame as if we're skipping a file
                serverSocket.write(
                    buildCommandFrame(Commands.M_SKIP, 'test.pkt 1234 1700000000')
                );
                // Then EOB so the session can end
                serverSocket.write(buildCommandFrame(Commands.M_EOB, ''));
            });
            sess.start();
        });

        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            const clientSocket = net.createConnection(port, '127.0.0.1');
            const clientSess = new BinkpSession(clientSocket, ORIGINATING_BASE);

            clientSess.on('file-skipped', (name, size, ts) => {
                server.close();
                try {
                    assert.equal(name, 'test.pkt');
                    assert.equal(size, 1234);
                    assert.equal(ts, 1700000000);
                    done();
                } catch (e) {
                    done(e);
                }
            });

            clientSess.on('error', done);
            clientSess.start();
        });
    });
});
