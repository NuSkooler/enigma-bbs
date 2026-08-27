#!/usr/bin/env node
'use strict';

//
//  binkp_interop.js — run ENiGMA½'s native BinkP mailer against a real binkd
//  and report what actually crossed the wire.
//
//  ENiGMA-to-ENiGMA tests agree with themselves by construction: every bug in
//  issue #724 (NR mode) was invisible to the unit suite because both ends made
//  the same wrong assumption. This drives the session against binkd instead,
//  which is where a spec deviation shows up as a stall or a dropped file.
//
//  binkd is not needed to run the test suite and this script is not part of
//  it. Getting one, without root:
//
//    apt-get download binkd && dpkg-deb -x binkd_*.deb ./binkd-root
//    node dev_util/binkp_interop.js --binkd ./binkd-root/usr/sbin/binkd
//
//  Otherwise it is picked up from $BINKD or from PATH.
//
//  Usage:
//    node dev_util/binkp_interop.js [options]
//
//  Options:
//    --binkd PATH    binkd binary       (default: $BINKD, else from PATH)
//    --scenario S    call | answer | both               (default: both)
//                      call   — ENiGMA originates, binkd answers
//                      answer — binkd originates, ENiGMA answers
//    --no-nd         Drop -nd from binkd's node entry. binkd asks for NR mode
//                    when a node carries -nr or -nd, so -nd (the default here)
//                    is what puts the session into NR mode at all.
//    --no-gz         Suppress GZ on our side. Worth doing while issue #723 is
//                    open, since a decompression failure masks everything else.
//    --size N        Bytes per test file                (default: 20000)
//    --timeout N     Seconds to allow per scenario      (default: 30)
//    --work DIR      Scratch directory  (default: a fresh mkdtemp, removed after)
//    --keep          Keep the scratch directory and print its path
//    --verbose       Dump binkd's session log
//    --help          Show this message
//

const net = require('net');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const { BinkpSession } = require('../core/binkp/session.js');

const OUR_ADDR = '2:2/2@testnet';
const BINKD_ADDR = '1:1/1@testnet';
const SESSION_PWD = 'interop';

// ─── CLI args ─────────────────────────────────────────────────────────────────

const opts = {
    binkd: process.env.BINKD || null,
    scenario: 'both',
    nd: true,
    gz: true,
    size: 20000,
    timeout: 30,
    work: null,
    keep: false,
    verbose: false,
};

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; ++i) {
    switch (argv[i]) {
        case '--binkd':
            opts.binkd = argv[++i];
            break;
        case '--scenario':
            opts.scenario = argv[++i];
            break;
        case '--no-nd':
            opts.nd = false;
            break;
        case '--no-gz':
            opts.gz = false;
            break;
        case '--size':
            opts.size = parseInt(argv[++i], 10);
            break;
        case '--timeout':
            opts.timeout = parseInt(argv[++i], 10);
            break;
        case '--work':
            opts.work = argv[++i];
            break;
        case '--keep':
            opts.keep = true;
            break;
        case '--verbose':
            opts.verbose = true;
            break;
        case '--help':
            printUsageAndExit(0);
            break;
        default:
            console.error(`Unknown option: ${argv[i]}`);
            printUsageAndExit(1);
    }
}

function printUsageAndExit(code) {
    const header = fs.readFileSync(__filename, 'utf8');
    const usage = header.slice(
        header.indexOf('//  Usage:'),
        header.indexOf('\n\nconst net')
    );
    console.log(usage.replace(/^\/\/ ?/gm, ''));
    process.exit(code);
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function locateBinkd() {
    if (opts.binkd) {
        if (!fs.existsSync(opts.binkd)) {
            fail(`binkd not found at ${opts.binkd}`);
        }
        return path.resolve(opts.binkd);
    }
    try {
        return execFileSync('sh', ['-c', 'command -v binkd'], {
            encoding: 'utf8',
        }).trim();
    } catch (e) {
        fail(
            'binkd not found — pass --binkd PATH or set $BINKD (see the header of this file)'
        );
    }
}

function fail(msg) {
    console.error(`\n${msg}\n`);
    process.exit(1);
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function freshDir(p) {
    fs.rmSync(p, { recursive: true, force: true });
    fs.mkdirSync(p, { recursive: true });
    return p;
}

function freePort() {
    return new Promise(resolve => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address();
            s.close(() => resolve(port));
        });
    });
}

//  Poll until binkd's listener answers, rather than guessing at a sleep.
async function waitForListener(port, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const up = await new Promise(resolve => {
            const s = net.createConnection(port, '127.0.0.1');
            s.once('connect', () => {
                s.destroy();
                resolve(true);
            });
            s.once('error', () => resolve(false));
        });
        if (up) {
            return true;
        }
        if (Date.now() > deadline) {
            return false;
        }
        await sleep(100);
    }
}

//  Deterministic filler so a truncated or misaligned transfer is obvious.
function makeBody(tag) {
    const buf = Buffer.allocUnsafe(opts.size);
    const prefix = Buffer.from(`${tag}:`);
    prefix.copy(buf);
    for (let i = prefix.length; i < buf.length; ++i) {
        buf[i] = (i * 31) & 0xff;
    }
    return buf;
}

function writeBinkdConfig(dir, lines) {
    const p = path.join(dir, 'binkd.cfg');
    fs.writeFileSync(p, lines.join('\n') + '\n');
    return p;
}

function baseConfig(dir, inbound, temp, outb, logFile) {
    return [
        `log ${logFile}`,
        'loglevel 8',
        'conlog 0',
        `domain testnet ${outb} 1`,
        `address ${BINKD_ADDR}`,
        'sysname "Interop Peer"',
        'location "Interop"',
        'sysop "SysOp"',
        'nodeinfo 115200,TCP,BINKP',
        `inbound ${inbound}`,
        `inbound-nonsecure ${inbound}`,
        `temp-inbound ${temp}`,
        `pid-file ${path.join(dir, 'binkd.pid')}`,
    ];
}

//  GZ is issue #723: we wrap deflate output in the gzip container where
//  FTS-1029 and binkd both use the bare zlib one. Until that is fixed a GZ
//  session dies on "Decompress ... error -3" before anything else can be
//  observed, so allow it to be switched off at the session level.
function applyGzPreference(session) {
    if (opts.gz) {
        return;
    }
    session.on('authenticated', () => {
        session._useGZ = false;
    });
}

function readLog(logFile) {
    return fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
}

function summarizeLog(log) {
    const lines = log.split('\n');
    return {
        nr: lines.filter(l => /offset request|NR mode|Remote requests NR/.test(l)),
        //  binkd's own "done (...)" verdict is reported separately, and the
        //  listener process logs one of its own when it is signalled at the
        //  end of a run — neither is an error worth repeating here.
        errors: lines.filter(
            l => /Decompress|error|interrupted|rejected/i.test(l) && !/done \(/.test(l)
        ),
        done: lines.filter(l => /done \(/.test(l) && !/done \(\?,/.test(l)),
    };
}

function reportBody(name, ok, detail, log) {
    const s = summarizeLog(log);
    console.log(`\n${'═'.repeat(72)}`);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    console.log('═'.repeat(72));
    for (const [k, v] of Object.entries(detail)) {
        console.log(`  ${k}: ${JSON.stringify(v)}`);
    }
    if (s.nr.length) {
        console.log('  -- NR --');
        s.nr.forEach(l => console.log(`     ${l.trim()}`));
    }
    if (s.done.length) {
        console.log('  -- binkd verdict --');
        s.done.forEach(l => console.log(`     ${l.trim()}`));
    }
    if (s.errors.length) {
        console.log('  -- binkd errors --');
        s.errors.forEach(l => console.log(`     ${l.trim()}`));
    }
    if (/Decompress .* error -3/.test(log)) {
        console.log(
            '\n  NOTE: "Decompress ... error -3" is issue #723 (gzip container\n' +
                '        where the spec uses zlib). Re-run with --no-gz to see past it.'
        );
    }
    if (opts.verbose) {
        console.log('\n-- binkd log --\n' + log);
    }
    return ok;
}

// ─── scenario: ENiGMA originates, binkd answers ───────────────────────────────

async function scenarioCall(binkd, root) {
    const dir = freshDir(path.join(root, 'call'));
    const inbound = freshDir(path.join(dir, 'inb'));
    const temp = freshDir(path.join(dir, 'tmp'));
    const outb = freshDir(path.join(dir, 'outb'));
    const logFile = path.join(dir, 'binkd.log');
    const port = await freePort();

    writeBinkdConfig(dir, [
        ...baseConfig(dir, inbound, temp, outb, logFile),
        `iport ${port}`,
        `node ${OUR_ADDR} - ${SESSION_PWD} ${opts.nd ? '-nd' : ''}`.trim(),
    ]);

    const proc = spawn(binkd, ['-s', path.join(dir, 'binkd.cfg')], {
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    proc.stderr.on('data', d => process.stderr.write(`[binkd] ${d}`));

    if (!(await waitForListener(port))) {
        proc.kill('SIGTERM');
        return reportBody(
            'ENiGMA originating → binkd answering',
            false,
            {
                why: 'binkd never started listening',
            },
            readLog(logFile)
        );
    }

    const body = makeBody('CALL');
    const filePath = path.join(dir, '0001beef.pkt');
    await fsp.writeFile(filePath, body);
    const { size } = await fsp.stat(filePath);

    const result = await new Promise(resolve => {
        const socket = net.createConnection(port, '127.0.0.1');
        socket.on('error', e => resolve({ ok: false, why: e.message }));
        socket.once('connect', () => {
            const session = new BinkpSession(socket, {
                role: 'originating',
                addresses: [OUR_ADDR],
                systemName: 'ENiGMA Interop',
                getPassword: () => SESSION_PWD,
                tempDir: temp,
            });
            applyGzPreference(session);

            const timer = setTimeout(
                () => resolve({ ok: false, why: 'session timed out' }),
                opts.timeout * 1000
            );
            const done = r => {
                clearTimeout(timer);
                resolve(r);
            };
            session.on('session-end', () => done({ ok: true }));
            session.on('error', e => done({ ok: false, why: e.message }));
            session.on('disconnect', () => done({ ok: false, why: 'disconnected' }));
            session.queueFile(filePath, '0001beef.pkt', size, nowSecs(), 'keep');
            session.start();
        });
    });

    await sleep(400);
    proc.kill('SIGTERM');
    await sleep(200);

    const landed = fs.readdirSync(inbound).filter(n => !n.startsWith('.'));
    const intact =
        1 === landed.length &&
        fs.readFileSync(path.join(inbound, landed[0])).equals(body);

    return reportBody(
        'ENiGMA originating → binkd answering',
        result.ok && intact,
        { session: result, binkdInbound: landed, bytesIntact: intact },
        readLog(logFile)
    );
}

// ─── scenario: binkd originates, ENiGMA answers ───────────────────────────────

async function scenarioAnswer(binkd, root) {
    const dir = freshDir(path.join(root, 'answer'));
    const inbound = freshDir(path.join(dir, 'inb'));
    const temp = freshDir(path.join(dir, 'tmp'));
    const outb = freshDir(path.join(dir, 'outb'));
    const obox = freshDir(path.join(dir, 'obox'));
    const ourTemp = freshDir(path.join(dir, 'enigma_tmp'));
    const logFile = path.join(dir, 'binkd.log');
    const port = await freePort();

    //  Something for binkd to push at us, and something for us to push back,
    //  so a single run exercises both directions of the answering session.
    const inBody = makeBody('TO-ENIGMA');
    fs.writeFileSync(path.join(obox, '0002cafe.pkt'), inBody);

    const outBody = makeBody('FROM-ENIGMA');
    const outPath = path.join(dir, '0003feed.pkt');
    fs.writeFileSync(outPath, outBody);

    writeBinkdConfig(dir, [
        ...baseConfig(dir, inbound, temp, outb, logFile),
        `node ${OUR_ADDR} ${opts.nd ? '-nd' : ''} 127.0.0.1:${port} ${SESSION_PWD} - ${obox}`
            .replace(/\s+/g, ' ')
            .trim(),
    ]);

    const received = [];
    let sessionResult = null;

    const server = net.createServer(socket => {
        const session = new BinkpSession(socket, {
            role: 'answering',
            addresses: [OUR_ADDR],
            systemName: 'ENiGMA Interop',
            getPassword: () => SESSION_PWD,
            tempDir: ourTemp,
        });
        applyGzPreference(session);

        session.on('file-received', (name, size, ts, tempPath) => {
            received.push({ name, intact: fs.readFileSync(tempPath).equals(inBody) });
        });
        session.on('session-end', () => {
            sessionResult = sessionResult || { ok: true };
        });
        session.on('error', e => {
            sessionResult = sessionResult || { ok: false, why: e.message };
        });
        session.queueFile(outPath, '0003feed.pkt', outBody.length, nowSecs(), 'keep');
        session.start();
    });
    await new Promise(r => server.listen(port, '127.0.0.1', r));

    const proc = spawn(binkd, ['-p', '-P', OUR_ADDR, path.join(dir, 'binkd.cfg')], {
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    proc.stderr.on('data', d => process.stderr.write(`[binkd] ${d}`));

    const exit = await Promise.race([
        new Promise(r => proc.on('exit', code => r(code))),
        sleep(opts.timeout * 1000).then(() => 'timeout'),
    ]);
    try {
        proc.kill('SIGTERM');
    } catch (e) {
        /* already gone */
    }
    await sleep(300);
    server.close();

    const log = readLog(logFile);
    const binkdGot = fs.readdirSync(inbound).filter(n => !n.startsWith('.'));
    const binkdIntact =
        1 === binkdGot.length &&
        fs.readFileSync(path.join(inbound, binkdGot[0])).equals(outBody);
    const weGot = 1 === received.length && received[0].intact;

    //  binkd/1.1 opens another batch after any batch that carried more than
    //  the two M_EOBs and waits for our M_EOB before hanging up. If it does
    //  not exit, that exchange did not complete — look for a "done (..., OK"
    //  line in its log to tell a clean finish from a timeout.
    const stalled = 'timeout' === exit;

    return reportBody(
        'binkd originating → ENiGMA answering',
        weGot && binkdIntact,
        {
            binkdExit: exit,
            session: sessionResult,
            enigmaReceived: received,
            binkdInbound: binkdGot,
            binkdBytesIntact: binkdIntact,
            note: stalled
                ? 'binkd did not exit — it is still waiting on the batch exchange'
                : undefined,
        },
        log
    );
}

function nowSecs() {
    return Math.floor(Date.now() / 1000);
}

// ─── main ─────────────────────────────────────────────────────────────────────

(async () => {
    const binkd = locateBinkd();
    const root = opts.work
        ? freshDir(path.resolve(opts.work))
        : fs.mkdtempSync(path.join(os.tmpdir(), 'enigma_binkp_interop_'));

    console.log(`binkd     : ${binkd}`);
    console.log(`work dir  : ${root}`);
    console.log(`options   : nd=${opts.nd} gz=${opts.gz} size=${opts.size}`);

    const run = [];
    if ('both' === opts.scenario || 'call' === opts.scenario) {
        run.push(scenarioCall);
    }
    if ('both' === opts.scenario || 'answer' === opts.scenario) {
        run.push(scenarioAnswer);
    }
    if (!run.length) {
        fail(`Unknown scenario: ${opts.scenario}`);
    }

    let allOk = true;
    for (const scenario of run) {
        allOk = (await scenario(binkd, root)) && allOk;
    }

    if (opts.keep) {
        console.log(`\nwork dir kept at ${root}`);
    } else {
        fs.rmSync(root, { recursive: true, force: true });
    }

    console.log(`\n${allOk ? 'All scenarios passed.' : 'One or more scenarios failed.'}`);
    process.exit(allOk ? 0 : 1);
})();
