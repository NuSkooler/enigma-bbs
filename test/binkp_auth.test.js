'use strict';

//
//  Answering-side authentication: a caller presenting an address we hold a
//  password for has to give that password, or the session ends with M_ERR
//  "Bad password" before any transfer -- as binkd does. Mail is only ever
//  queued for addresses the session authenticated.
//

const { strict: assert } = require('assert');
const fsp = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');

const { BinkpSession } = require('../core/binkp/session');
const {
    BsoSpool,
    attachSpoolToSession,
    nodeBaseName,
} = require('../core/binkp/bso_spool');
const { FrameParser, buildCommandFrame } = require('../core/binkp/frame');
const { Commands } = require('../core/binkp/commands');
const { computeResponse } = require('../core/binkp/cram');

//  Three nodes in zone 1: two with different passwords, one with none.
const NODE_A = { zone: 1, net: 100, node: 1 };
const NODE_B = { zone: 1, net: 100, node: 2 };
const NODE_C = { zone: 1, net: 100, node: 3 };
const PASSWORDS = {
    '1:100/1': 'alpha',
    '1:100/2': 'bravo',
};

function addrStr(a) {
    return `${a.zone}:${a.net}/${a.node}@testnet`;
}

//  Same shape as the scanner/tosser's lookup: the distinct passwords
//  configured for the presented addresses.
function getPassword(remoteAddrs) {
    const out = new Set();
    for (const a of remoteAddrs) {
        const pw = PASSWORDS[a.split('@')[0]];
        if (pw) out.add(pw);
    }
    return Array.from(out);
}

//
//  A raw originating peer. It presents |addresses| and answers with |pwd|,
//  or with a CRAM-MD5 response computed from |cramPassword| against the
//  challenge the answering side sent. It records every command frame, and
//  answers every M_FILE with M_GOT so a sent file completes.
//
function rawCaller(port, { addresses, pwd = '-', cramPassword = null }) {
    return new Promise(resolve => {
        const socket = net.createConnection(port, '127.0.0.1');
        const parser = new FrameParser();
        const frames = [];
        let challenge = null;
        let sentPwd = false;
        let eobSent = false;

        const send = (cmd, arg) => {
            if (!socket.destroyed) socket.write(buildCommandFrame(cmd, arg));
        };

        socket.on('error', () => {});
        socket.on('data', chunk => parser.push(chunk));
        socket.on('close', () => resolve(frames));

        socket.once('connect', () => {
            send(Commands.M_NUL, 'SYS Raw Caller');
            send(Commands.M_NUL, 'VER rawcaller/1.0 binkp/1.0');
            send(Commands.M_ADR, addresses.join(' '));
        });

        parser.on('frame', frame => {
            if ('data' === frame.type) return;
            frames.push({ cmd: frame.cmd, arg: frame.arg });

            if (Commands.M_NUL === frame.cmd) {
                const m = /^OPT .*CRAM-MD5-([0-9a-f]+)/i.exec(frame.arg);
                if (m) challenge = m[1];
            } else if (Commands.M_ADR === frame.cmd && !sentPwd) {
                sentPwd = true;
                send(
                    Commands.M_PWD,
                    cramPassword && challenge
                        ? `CRAM-MD5-${computeResponse(cramPassword, challenge)}`
                        : pwd
                );
            } else if (Commands.M_OK === frame.cmd) {
                send(Commands.M_EOB, '');
                eobSent = true;
            } else if (Commands.M_FILE === frame.cmd) {
                const [name, size, ts] = frame.arg.split(' ');
                send(Commands.M_GOT, `${name} ${size} ${ts}`);
            } else if (Commands.M_EOB === frame.cmd && eobSent) {
                //  binkp/1.0: one batch, then the caller hangs up.
                socket.end();
            } else if (Commands.M_ERR === frame.cmd) {
                socket.end();
            }
        });
    });
}

function namesOf(frames, cmd) {
    return frames.filter(f => f.cmd === cmd).map(f => f.arg.split(' ')[0]);
}

describe('BinkP answering-side authentication', () => {
    let root;
    let spool;
    const outFiles = {};

    before(async () => {
        root = await fsp.mkdtemp(path.join(os.tmpdir(), 'enigma_binkp_auth_'));
        spool = new BsoSpool({
            paths: {
                outbound: root,
                inbound: path.join(root, 'inbound'),
                secInbound: path.join(root, 'secinbound'),
            },
            networks: { testnet: { localAddress: '1:1/1', defaultZone: 1 } },
        });
    });

    after(async () => {
        await fsp.rm(root, { recursive: true, force: true });
    });

    //  A fresh direct-attach netmail packet for each node before every test.
    beforeEach(async () => {
        const dir = path.join(root, 'outbound');
        await fsp.rm(dir, { recursive: true, force: true });
        await fsp.mkdir(dir, { recursive: true });
        for (const [label, a] of Object.entries({ A: NODE_A, B: NODE_B, C: NODE_C })) {
            const p = path.join(dir, `${nodeBaseName(a)}.out`);
            await fsp.writeFile(p, `MAIL FOR ${label}`);
            outFiles[label] = p;
        }
    });

    async function stillQueued(label) {
        try {
            return (await fsp.readFile(outFiles[label], 'utf8')) === `MAIL FOR ${label}`;
        } catch (err) {
            if ('ENOENT' === err.code) {
                return false; //  sent and disposed of
            }
            throw err;
        }
    }

    //  Run one answering session against a raw caller. Resolves with what
    //  the caller saw and what the session reported.
    function runAnsweringSession(callerOpts) {
        return new Promise((resolve, reject) => {
            const result = {
                authenticated: null,
                authAddresses: null,
                error: null,
                ended: false,
            };
            let callerFrames = null;
            let sessionDone = false;
            const maybeResolve = () => {
                if (callerFrames && sessionDone) {
                    resolve({ ...result, frames: callerFrames });
                }
            };

            const server = net.createServer(socket => {
                server.close();
                const session = new BinkpSession(socket, {
                    role: 'answering',
                    addresses: ['1:1/1@testnet'],
                    tempDir: os.tmpdir(),
                    getPassword,
                });
                session.on('authenticated', (secure, addrs) => {
                    result.authenticated = secure;
                    result.authAddresses = addrs;
                });
                session.on('error', err => {
                    result.error = err;
                    sessionDone = true;
                    maybeResolve();
                });
                session.on('session-end', () => {
                    result.ended = true;
                    sessionDone = true;
                    maybeResolve();
                });
                session.on('disconnect', () => {
                    sessionDone = true;
                    maybeResolve();
                });
                attachSpoolToSession(session, spool, null).catch(reject);
                session.start();
            });
            server.on('error', reject);
            server.listen(0, '127.0.0.1', () => {
                rawCaller(server.address().port, callerOpts)
                    .then(frames => {
                        callerFrames = frames;
                        maybeResolve();
                    })
                    .catch(reject);
            });
        });
    }

    function assertRefused(r) {
        assert.ok(r.error, 'the session ends in an error');
        assert.match(r.error.message, /Bad password/);
        assert.equal(r.authenticated, null, 'never authenticated');
        assert.deepEqual(namesOf(r.frames, Commands.M_ERR), ['Bad']);
        assert.equal(
            r.frames.find(f => f.cmd === Commands.M_ERR).arg,
            'Bad password',
            'the same text binkd sends'
        );
        assert.deepEqual(namesOf(r.frames, Commands.M_OK), [], 'no M_OK');
        assert.deepEqual(namesOf(r.frames, Commands.M_FILE), [], 'no file offered');
    }

    it('refuses a wrong plain password and leaves the outbound untouched', async () => {
        const r = await runAnsweringSession({
            addresses: [addrStr(NODE_A)],
            pwd: 'not-alpha',
        });
        assertRefused(r);
        assert.ok(await stillQueued('A'));
    });

    it('refuses a missing password for a passworded address', async () => {
        const r = await runAnsweringSession({ addresses: [addrStr(NODE_A)], pwd: '-' });
        assertRefused(r);
        assert.ok(await stillQueued('A'));
    });

    it('refuses a wrong CRAM-MD5 response and leaves the outbound untouched', async () => {
        const r = await runAnsweringSession({
            addresses: [addrStr(NODE_A)],
            cramPassword: 'not-alpha',
        });
        assertRefused(r);
        assert.ok(await stillQueued('A'));
    });

    it('accepts the right plain password and sends the mail', async () => {
        const r = await runAnsweringSession({
            addresses: [addrStr(NODE_A)],
            pwd: 'alpha',
        });
        assert.equal(r.error, null);
        assert.equal(r.authenticated, true);
        assert.equal(namesOf(r.frames, Commands.M_FILE).length, 1);
        assert.ok(!(await stillQueued('A')), 'sent and removed');
        assert.ok(await stillQueued('B'));
        assert.ok(await stillQueued('C'));
    });

    it('accepts the right CRAM-MD5 response and sends the mail', async () => {
        const r = await runAnsweringSession({
            addresses: [addrStr(NODE_A)],
            cramPassword: 'alpha',
        });
        assert.equal(r.error, null);
        assert.equal(r.authenticated, true);
        assert.equal(namesOf(r.frames, Commands.M_FILE).length, 1);
        assert.ok(!(await stillQueued('A')));
    });

    it('keeps an address with no password non-secure, and still sends its mail', async () => {
        const r = await runAnsweringSession({ addresses: [addrStr(NODE_C)], pwd: '-' });
        assert.equal(r.error, null);
        assert.equal(r.authenticated, false);
        assert.deepEqual(r.authAddresses, [addrStr(NODE_C)]);
        assert.equal(namesOf(r.frames, Commands.M_FILE).length, 1);
        assert.ok(!(await stillQueued('C')));
        assert.ok(await stillQueued('A'));
    });

    it('takes an unexpected password from an unpassworded address as non-secure', async () => {
        const r = await runAnsweringSession({
            addresses: [addrStr(NODE_C)],
            pwd: 'anything',
        });
        assert.equal(r.error, null);
        assert.equal(r.authenticated, false);
        assert.ok(!(await stillQueued('C')));
    });

    describe('several addresses in one M_ADR', () => {
        it('refuses a passworded plus an unpassworded address with the wrong password', async () => {
            const r = await runAnsweringSession({
                addresses: [addrStr(NODE_C), addrStr(NODE_A)],
                pwd: 'wrong',
            });
            assertRefused(r);
            assert.ok(await stillQueued('A'));
            assert.ok(await stillQueued('C'));
        });

        it('refuses them with no password at all', async () => {
            const r = await runAnsweringSession({
                addresses: [addrStr(NODE_C), addrStr(NODE_A)],
                pwd: '-',
            });
            assertRefused(r);
            assert.ok(await stillQueued('A'));
            assert.ok(await stillQueued('C'));
        });

        it('covers both once the password matches, as binkd does', async () => {
            const r = await runAnsweringSession({
                addresses: [addrStr(NODE_C), addrStr(NODE_A)],
                pwd: 'alpha',
            });
            assert.equal(r.error, null);
            assert.equal(r.authenticated, true);
            assert.deepEqual(r.authAddresses, [addrStr(NODE_C), addrStr(NODE_A)]);
            assert.equal(namesOf(r.frames, Commands.M_FILE).length, 2);
            assert.ok(!(await stillQueued('A')));
            assert.ok(!(await stillQueued('C')));
            assert.ok(await stillQueued('B'), 'not presented, not sent');
        });

        it('refuses addresses whose passwords differ, whichever one is given', async () => {
            for (const pwd of ['alpha', 'bravo']) {
                const r = await runAnsweringSession({
                    addresses: [addrStr(NODE_A), addrStr(NODE_B)],
                    pwd,
                });
                assertRefused(r);
            }
            assert.ok(await stillQueued('A'));
            assert.ok(await stillQueued('B'));
        });
    });
});

describe('BinkpSession — addresses a session may carry mail for', () => {
    function sessionWith(remoteAddresses) {
        const sock = new net.Socket();
        const s = new BinkpSession(sock, {
            role: 'answering',
            addresses: ['1:1/1@testnet'],
            getPassword,
        });
        s._remoteAddresses = remoteAddresses;
        return s;
    }

    it('a secure session covers every presented address', () => {
        const s = sessionWith([addrStr(NODE_A), addrStr(NODE_C)]);
        assert.deepEqual(s._authenticatedAddresses(true), [
            addrStr(NODE_A),
            addrStr(NODE_C),
        ]);
    });

    it('a non-secure session covers only addresses with no password', () => {
        const s = sessionWith([addrStr(NODE_A), addrStr(NODE_C), addrStr(NODE_B)]);
        assert.deepEqual(s._authenticatedAddresses(false), [addrStr(NODE_C)]);
    });

    it('nothing is sent before authentication has completed', () => {
        const s = sessionWith([addrStr(NODE_C)]);
        const writes = [];
        s._socket.write = buf => writes.push(buf);
        s._state = 'transfer';
        s.queueFile('/nonexistent', 'x.pkt', 1, 1, 'keep');
        s._sendNext();
        assert.deepEqual(writes, []);
        assert.equal(s._sendQueue.length, 1, 'still queued, not offered');
    });
});
