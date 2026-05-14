'use strict';

const { strict: assert } = require('assert');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const net = require('net');

const { BinkpSession } = require('../core/binkp/session');
const { FreqResolver, attachFreqToSession, REQ_FILE_RE } = require('../core/binkp/freq');

// ── helpers ───────────────────────────────────────────────────────────────────

const TEMP_DIR = os.tmpdir();

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

async function makeTempFile(content = 'TESTDATA', suffix = '.pkt') {
    const filePath = path.join(
        TEMP_DIR,
        `binkp_freq_test_${Date.now()}_${Math.random().toString(36).slice(2)}${suffix}`
    );
    await fsp.writeFile(filePath, content);
    const { size } = await fsp.stat(filePath);
    const timestamp = Math.floor(Date.now() / 1000);
    return { filePath, size, timestamp };
}

async function makeTempDir() {
    const dir = path.join(TEMP_DIR, `binkp_freq_dir_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    await fsp.mkdir(dir);
    return dir;
}

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
                server.close();
                const clientSess = new BinkpSession(clientSocket, {
                    ...ORIGINATING_BASE,
                    ...clientOpts,
                });
                resolve({ clientSess, serverSess });
            });
        });
    });
}

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

function runToEnd(clientSess, serverSess) {
    const clientDone = waitFor(clientSess, 'session-end');
    const serverDone = waitFor(serverSess, 'session-end');
    clientSess.start();
    serverSess.start();
    return Promise.all([clientDone, serverDone]);
}

// ── FreqResolver unit tests ───────────────────────────────────────────────────

describe('FreqResolver', () => {
    let dir;
    let nodelistPath;
    let zipPath;

    before(async () => {
        dir = await makeTempDir();
        nodelistPath = path.join(dir, 'NODELIST.365');
        zipPath = path.join(dir, 'files.zip');
        await fsp.writeFile(nodelistPath, 'nodelist data');
        await fsp.writeFile(zipPath, 'zip data');
    });

    after(async () => {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    });

    it('resolves a magic name to the configured file', async () => {
        const resolver = new FreqResolver({ magic: { NODELIST: nodelistPath } });
        const results = await resolver.resolveNames(['NODELIST']);
        assert.equal(results.length, 1);
        assert.equal(results[0].filePath, nodelistPath);
    });

    it('magic name lookup is case-insensitive', async () => {
        const resolver = new FreqResolver({ magic: { NODELIST: nodelistPath } });
        const results = await resolver.resolveNames(['nodelist']);
        assert.equal(results.length, 1);
    });

    it('finds a file by exact name in a search dir', async () => {
        const resolver = new FreqResolver({ dirs: [dir] });
        const results = await resolver.resolveNames(['files.zip']);
        assert.equal(results.length, 1);
        assert.equal(results[0].name, 'files.zip');
    });

    it('finds the newest nodelist-style versioned file by prefix', async () => {
        // Create two versioned files; the newer one should win
        const older = path.join(dir, 'NODELIST.001');
        const newer = path.join(dir, 'NODELIST.002');
        await fsp.writeFile(older, 'old');
        await new Promise(r => setTimeout(r, 10)); // ensure different mtime
        await fsp.writeFile(newer, 'new');

        const resolver = new FreqResolver({ dirs: [dir] });
        const results = await resolver.resolveNames(['NODELIST']);
        assert.equal(results.length, 1);
        assert.ok(
            results[0].name === 'NODELIST.002' || results[0].name === 'NODELIST.365',
            `expected newest NODELIST file, got ${results[0].name}`
        );

        await fsp.unlink(older).catch(() => {});
        await fsp.unlink(newer).catch(() => {});
    });

    it('returns empty for an unresolvable name', async () => {
        const resolver = new FreqResolver({ dirs: [dir] });
        const results = await resolver.resolveNames(['DOESNOTEXIST']);
        assert.equal(results.length, 0);
    });

    it('respects maxFiles limit', async () => {
        const resolver = new FreqResolver({
            magic: { NODELIST: nodelistPath, FILES: zipPath },
            maxFiles: 1,
        });
        const results = await resolver.resolveNames(['NODELIST', 'FILES']);
        assert.equal(results.length, 1);
    });

    it('resolveReqFile parses newline-separated names and strips passwords', async () => {
        const reqFile = await makeTempFile('NODELIST\nfiles.zip!secret\n\n', '.req');
        const resolver = new FreqResolver({ magic: { NODELIST: nodelistPath }, dirs: [dir] });
        const results = await resolver.resolveReqFile(reqFile.filePath);
        assert.equal(results.length, 2);
        const names = results.map(r => r.name);
        assert.ok(names.some(n => n === 'NODELIST.365'), 'expected nodelist');
        assert.ok(names.some(n => n === 'files.zip'), 'expected zip');
        await fsp.unlink(reqFile.filePath).catch(() => {});
    });
});

// ── REQ_FILE_RE ───────────────────────────────────────────────────────────────

describe('REQ_FILE_RE', () => {
    it('matches .req extension', () => {
        assert.ok(REQ_FILE_RE.test('0001000f.req'));
        assert.ok(REQ_FILE_RE.test('something.REQ'));
    });
    it('does not match other extensions', () => {
        assert.ok(!REQ_FILE_RE.test('nodelist.365'));
        assert.ok(!REQ_FILE_RE.test('packet.pkt'));
    });
});

// ── End-to-end FREQ session test ──────────────────────────────────────────────

describe('BinkpSession — FREQ end-to-end', () => {
    let freqDir;
    let nodelistFile;

    before(async () => {
        freqDir = await makeTempDir();
        nodelistFile = path.join(freqDir, 'NODELIST.365');
        await fsp.writeFile(nodelistFile, 'nodelist content for FREQ');
    });

    after(async () => {
        await fsp.rm(freqDir, { recursive: true, force: true }).catch(() => {});
    });

    it('server serves FREQ files in the same batch when client sends a .req file', async () => {
        const resolver = new FreqResolver({ magic: { NODELIST: nodelistFile } });
        const clientReceived = [];

        const { clientSess, serverSess } = await makeSessionPair({}, {});

        attachFreqToSession(serverSess, resolver);
        serverSess.on('file-received', (name, size, ts, tempPath) => {
            fsp.unlink(tempPath).catch(() => {});
        });

        clientSess.on('file-received', (name, size, ts, tempPath) => {
            clientReceived.push(name);
            fsp.unlink(tempPath).catch(() => {});
        });

        const reqFile = await makeTempFile('NODELIST\n', '.req');
        clientSess.queueFile(reqFile.filePath, '00010001.req', reqFile.size, reqFile.timestamp, 'keep');

        await runToEnd(clientSess, serverSess);

        await fsp.unlink(reqFile.filePath).catch(() => {});

        assert.ok(
            clientReceived.includes('NODELIST.365'),
            `client should receive NODELIST.365 as FREQ response; got: ${clientReceived}`
        );
    });

    it('server skips FREQ when no .req files were received', async () => {
        const resolver = new FreqResolver({ magic: { NODELIST: nodelistFile } });
        const clientReceived = [];

        const { clientSess, serverSess } = await makeSessionPair({}, {});

        attachFreqToSession(serverSess, resolver);
        serverSess.on('file-received', (name, size, ts, tempPath) => {
            fsp.unlink(tempPath).catch(() => {});
        });

        clientSess.on('file-received', (name, size, ts, tempPath) => {
            clientReceived.push(name);
            fsp.unlink(tempPath).catch(() => {});
        });

        const pkt = await makeTempFile('some mail', '.pkt');
        clientSess.queueFile(pkt.filePath, 'mail.pkt', pkt.size, pkt.timestamp, 'keep');

        await runToEnd(clientSess, serverSess);

        await fsp.unlink(pkt.filePath).catch(() => {});

        assert.equal(clientReceived.length, 0, 'client should receive no FREQ response');
    });
});
