'use strict';

const { strict: assert } = require('assert');
const net = require('net');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

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

// ── GZ compression round-trip ─────────────────────────────────────────────────

describe('BinkpSession — GZ compression', () => {
    it('transfers a file with GZ compression and delivers correct content', async () => {
        const f = await makeTempFile('COMPRESSED_PAYLOAD_TEST_DATA_123456');

        const { clientSess, serverSess } = await makeSessionPair();

        // Both sessions negotiate GZ by default (advertised in OPT).
        // Verify GZ is actually active on both sides after auth.
        let serverGzActive = false;
        serverSess.on('authenticated', () => {
            serverGzActive = serverSess._useGZ;
        });

        let received = null;
        serverSess.on('file-received', async (name, size, ts, tempPath) => {
            received = { name, size, ts, tempPath };
        });

        clientSess.queueFile(f.filePath, 'gz_test.pkt', f.size, f.timestamp, 'keep');

        await runToEnd(clientSess, serverSess);

        assert.ok(serverGzActive, 'GZ should be negotiated between both sessions');
        assert.ok(received, 'server should have received the file');
        assert.equal(received.name, 'gz_test.pkt');
        assert.equal(received.size, f.size);

        const content = await fsp.readFile(received.tempPath);
        assert.equal(content.toString(), 'COMPRESSED_PAYLOAD_TEST_DATA_123456');

        await fsp.unlink(received.tempPath).catch(() => {});
        await fsp.unlink(f.filePath).catch(() => {});
    });

    it('skips GZ for already-compressed extensions (.zip)', async () => {
        // Create a fake .zip file (content doesn't matter — we're testing OPT token)
        const filePath = path.join(TEMP_DIR, `binkp_test_gz_skip_${Date.now()}.zip`);
        await fsp.writeFile(filePath, 'FAKE_ZIP_CONTENT');
        const { size } = await fsp.stat(filePath);
        const timestamp = Math.floor(Date.now() / 1000);

        const { clientSess, serverSess } = await makeSessionPair();

        // Intercept M_FILE to check the GZ token is NOT appended
        let mFileArg = null;
        const origSendCmd = clientSess._sendCmd.bind(clientSess);
        clientSess._sendCmd = (cmd, arg) => {
            const { Commands } = require('../core/binkp/commands');
            if (cmd === Commands.M_FILE) mFileArg = arg;
            return origSendCmd(cmd, arg);
        };

        let received = null;
        serverSess.on('file-received', (name, size, ts, tempPath) => {
            received = { tempPath };
        });

        clientSess.queueFile(filePath, 'archive.zip', size, timestamp, 'keep');
        await runToEnd(clientSess, serverSess);

        assert.ok(mFileArg, 'M_FILE should have been sent');
        assert.ok(!mFileArg.includes(' GZ'), 'GZ token must not appear for .zip files');
        assert.ok(received, 'file should still be received successfully');

        await fsp.unlink(received.tempPath).catch(() => {});
        await fsp.unlink(filePath).catch(() => {});
    });
});

// ── Multi-batch ───────────────────────────────────────────────────────────────

describe('BinkpSession — multi-batch (onBatchEnd)', () => {
    //  In BinkP, the ORIGINATING node controls session lifetime. After both
    //  sides exchange M_EOB, the originating node decides whether to start
    //  another batch (by queuing more files in onBatchEnd) or to close.
    //  The answering node waits for the originating node to close.

    it('originating side starts a second batch via onBatchEnd', async () => {
        const batch1 = await makeTempFile('BATCH_ONE');
        const batch2 = await makeTempFile('BATCH_TWO');

        let batchCount = 0;

        //  Client (originating) has the hook; server (answering) has none.
        const { clientSess, serverSess } = await makeSessionPair(
            {
                onBatchEnd: sess => {
                    batchCount++;
                    if (batchCount === 1) {
                        //  Queue a second file — this triggers a new batch.
                        sess.queueFile(
                            batch2.filePath,
                            'batch2.pkt',
                            batch2.size,
                            batch2.timestamp,
                            'keep'
                        );
                    }
                    //  batchCount === 2: nothing more → originating closes.
                },
            },
            {} // server has no hook — waits for originating to close
        );

        const serverReceived = [];
        serverSess.on('file-received', (name, size, ts, tempPath) => {
            serverReceived.push(name);
            fsp.unlink(tempPath).catch(() => {});
        });

        clientSess.queueFile(
            batch1.filePath,
            'batch1.pkt',
            batch1.size,
            batch1.timestamp,
            'keep'
        );

        await runToEnd(clientSess, serverSess);

        assert.equal(batchCount, 2, 'onBatchEnd should fire for each batch');
        assert.ok(serverReceived.includes('batch1.pkt'), 'server should receive batch1');
        assert.ok(serverReceived.includes('batch2.pkt'), 'server should receive batch2');

        await fsp.unlink(batch1.filePath).catch(() => {});
        await fsp.unlink(batch2.filePath).catch(() => {});
    });

    it('ends session normally when onBatchEnd queues nothing', async () => {
        const f = await makeTempFile('SINGLE_BATCH');
        let batchCount = 0;

        const { clientSess, serverSess } = await makeSessionPair(
            {
                onBatchEnd: () => {
                    batchCount++;
                    // queue nothing — originating closes after this
                },
            },
            {}
        );

        serverSess.on('file-received', (name, size, ts, tempPath) => {
            fsp.unlink(tempPath).catch(() => {});
        });

        clientSess.queueFile(f.filePath, 'only.pkt', f.size, f.timestamp, 'keep');
        await runToEnd(clientSess, serverSess);

        assert.equal(batchCount, 1);
        await fsp.unlink(f.filePath).catch(() => {});
    });

    it('session ends cleanly when onBatchEnd rejects', async () => {
        const f = await makeTempFile('ERR_BATCH');

        const { clientSess, serverSess } = await makeSessionPair(
            {
                onBatchEnd: () => Promise.reject(new Error('hook failure')),
            },
            {}
        );

        serverSess.on('file-received', (name, size, ts, tempPath) => {
            fsp.unlink(tempPath).catch(() => {});
        });

        clientSess.queueFile(f.filePath, 'err.pkt', f.size, f.timestamp, 'keep');

        await runToEnd(clientSess, serverSess);

        await fsp.unlink(f.filePath).catch(() => {});
    });
});
