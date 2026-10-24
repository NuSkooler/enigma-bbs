'use strict';

const { strict: assert } = require('assert');
const os = require('os');
const fs = require('fs');
const paths = require('path');

const {
    isReceivedOk,
    hasControlChar,
    parseDszLog,
    receivedFilesFromEntries,
    confirmReceivedFiles,
    buildProtocolEnv,
} = require('../core/dszlog.js');
const { Errors } = require('../core/enig_error.js');

//
//  file_transfer.js is a MenuModule; its methods are exercised on a bare
//  object. Required lazily: it drags in file_entry.js, which captures dbs.file
//  at load, and this file sorts ahead of file_base_db.test.js, which installs
//  its test DB before requiring file_entry.js. By the time any before() runs,
//  every test file has loaded.
//
let FileTransferModule;
const loadFileTransferModule = () => {
    FileTransferModule = require('../core/file_transfer.js').getModule;
};

//  a line the way sexyz.c receive_files() formats it
function sexyzLine(code, bytes, fileName, serial = -1) {
    const pad = (v, n) => String(v).padStart(n);
    return `${code} ${pad(bytes, 6)} ${pad(115200, 5)} bps ${pad(512, 4)} cps ${pad(0, 3)} errors ${pad(0, 5)} ${pad(1024, 4)} ${fileName} ${serial}\n`;
}

function makeTempDir() {
    return fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-dszlog-test-'));
}

function writeFile(dir, name, size) {
    const p = paths.join(dir, name);
    fs.writeFileSync(p, Buffer.alloc(size, 0x41));
    return p;
}

describe('DSZLOG parsing', () => {
    it('parses a sexyz receive line', () => {
        //  written by a real sexyz -telnet ry, receiving from a VTX-style sender
        const { entries, malformed } = parseDszLog(
            'R  20123 115200 bps 20123 cps   0 errors     0 1024 /tmp/enigul-live-ptKHYR/test_upload.bin 0\n'
        );
        assert.deepEqual(malformed, []);
        assert.equal(entries.length, 1);
        assert.deepEqual(entries[0], {
            code: 'R',
            ok: true,
            bytes: 20123,
            cps: 20123,
            errors: 0,
            blockSize: 1024,
            fileName: '/tmp/enigul-live-ptKHYR/test_upload.bin',
            serial: 0,
        });
    });

    it('parses a Debian lrzsz rz line, CRLF and all', () => {
        //  written by a real rz from Ubuntu's lrzsz 0.12.21-11build1
        const { entries, malformed } = parseDszLog(
            'z  50000 467853200 bps 58481650 cps   0 errors     0    0 test file.bin -1\r\n'
        );
        assert.deepEqual(malformed, []);
        assert.equal(entries.length, 1);
        assert.equal(entries[0].code, 'z');
        assert.equal(entries[0].ok, true);
        assert.equal(entries[0].bytes, 50000);
        assert.equal(entries[0].fileName, 'test file.bin');
    });

    it('keeps spaces in names, and takes the serial from the end', () => {
        const { entries } = parseDszLog(sexyzLine('Z', 10, '/up/my file 123.zip', 4242));
        assert.equal(entries[0].fileName, '/up/my file 123.zip');
        assert.equal(entries[0].serial, 4242);
    });

    it('keeps spaces at either end of a name', () => {
        const { entries } = parseDszLog(
            sexyzLine('R', 10, ' lead.zip') + sexyzLine('R', 10, 'trail.zip  ')
        );
        assert.deepEqual(
            entries.map(e => e.fileName),
            [' lead.zip', 'trail.zip  ']
        );
    });

    it('strips the quotes sexyz -quotes adds', () => {
        const { entries } = parseDszLog(sexyzLine('R', 10, '"/up/a b.zip"'));
        assert.equal(entries[0].fileName, '/up/a b.zip');
    });

    it('marks only receive successes as ok', () => {
        assert.ok(isReceivedOk('R'));
        assert.ok(isReceivedOk('Z'));
        assert.ok(isReceivedOk('z'));
        ['E', 'e', 'L', 'S', 's', 'X', '?'].forEach(code => {
            assert.equal(isReceivedOk(code), false, code);
        });

        const { entries } = parseDszLog(sexyzLine('E', 10, '/up/bad.zip'));
        assert.equal(entries[0].ok, false);
    });

    it('returns nothing for an empty or missing log', () => {
        const none = { entries: [], malformed: [] };
        assert.deepEqual(parseDszLog(''), none);
        assert.deepEqual(parseDszLog(null), none);
        assert.deepEqual(parseDszLog(undefined), none);
        assert.deepEqual(parseDszLog('\n\r\n'), none);
    });

    it('reports every line that does not match the format', () => {
        const bad = [
            'garbage',
            'R 12 bytes /up/x.zip',
            'R abc 115200 bps 1 cps 0 errors 0 1024 /up/x.zip -1',
            'R 12 115200 bps 1 cps 0 errors 0 1024 -1', //  no filename
            'R 12 115200 bps 1 cps 0 errors 0 1024 /up/x.zip', //  no serial
            '   ', //  not blank: whitespace
        ];
        const text = bad.concat(sexyzLine('R', 12, '/up/good.zip')).join('\n');
        const { entries, malformed } = parseDszLog(text);
        assert.deepEqual(
            malformed,
            bad.map((text, i) => ({ line: i + 1, text }))
        );
        assert.equal(entries.length, 1);
    });

    it('reports the remains of a line a forged name broke in two', () => {
        //  a sender named its file "X\nR ... B.ZIP -1"; sexyz wrote it as is
        const { malformed } = parseDszLog(
            'E      50 115200 bps    1 cps   0 errors     0 1024 /tmp/enigul-abc/X\n' +
                'R     100 115200 bps    1 cps   0 errors     0 1024 B.ZIP -1\n'
        );
        assert.deepEqual(malformed, [
            {
                line: 1,
                text: 'E      50 115200 bps    1 cps   0 errors     0 1024 /tmp/enigul-abc/X',
            },
        ]);
    });

    it('accepts CRLF endings, blank lines, and a last line with no newline', () => {
        const text =
            sexyzLine('R', 1, 'one.zip').replace('\n', '\r\n') +
            '\r\n' +
            sexyzLine('R', 2, 'two.zip').trim() +
            '\r';
        const { entries, malformed } = parseDszLog(text);
        assert.deepEqual(malformed, []);
        assert.deepEqual(
            entries.map(e => e.fileName),
            ['one.zip', 'two.zip']
        );
    });

    it('parses several files in order', () => {
        const text =
            sexyzLine('R', 1, '/up/one.zip') +
            sexyzLine('E', 2, '/up/two.zip') +
            sexyzLine('R', 3, '/up/three.zip');
        const { entries } = parseDszLog(text);
        assert.deepEqual(
            entries.map(e => [e.code, e.fileName]),
            [
                ['R', '/up/one.zip'],
                ['E', '/up/two.zip'],
                ['R', '/up/three.zip'],
            ]
        );
    });

    it('spots control characters in names', () => {
        ['a\nb', 'a\rb', 'a\tb', 'a\0b', '\x1b[2Jx.zip', 'x\x7f'].forEach(name =>
            assert.ok(hasControlChar(name), JSON.stringify(name))
        );
        ['plain.zip', 'with space.zip', 'caf\u00e9.zip', '~!@#$%^&().zip'].forEach(name =>
            assert.equal(hasControlChar(name), false, name)
        );
    });
});

describe('DSZLOG received files', () => {
    const recvDir = '/tmp/enigul-xyz/';
    const select = text => receivedFilesFromEntries(parseDszLog(text).entries, recvDir);

    it('accepts full paths and bare names inside the receive directory', () => {
        const { received, rejected } = select(
            sexyzLine('R', 5, '/tmp/enigul-xyz/a.zip') + sexyzLine('Z', 6, 'b c.zip')
        );
        assert.deepEqual(received, [
            { path: '/tmp/enigul-xyz/a.zip', bytes: 5 },
            { path: '/tmp/enigul-xyz/b c.zip', bytes: 6 },
        ]);
        assert.deepEqual(rejected, []);
    });

    it('leaves out failed files', () => {
        const { received, rejected } = select(
            sexyzLine('R', 5, '/tmp/enigul-xyz/a.zip') +
                sexyzLine('E', 6, '/tmp/enigul-xyz/b.zip')
        );
        assert.deepEqual(
            received.map(r => r.path),
            ['/tmp/enigul-xyz/a.zip']
        );
        assert.equal(rejected.length, 1);
        assert.match(rejected[0].reason, /status E/);
    });

    it('judges a repeated file by its last entry', () => {
        const goodThenBad = select(
            sexyzLine('R', 5, '/tmp/enigul-xyz/a.zip') + sexyzLine('E', 2, 'a.zip')
        );
        assert.deepEqual(goodThenBad.received, []);

        const badThenGood = select(
            sexyzLine('E', 2, '/tmp/enigul-xyz/a.zip') + sexyzLine('R', 5, 'a.zip')
        );
        assert.deepEqual(badThenGood.received, [
            { path: '/tmp/enigul-xyz/a.zip', bytes: 5 },
        ]);
    });

    it('rejects anything that resolves outside the receive directory', () => {
        const names = [
            '../evil.zip',
            '/tmp/enigul-xyz/../evil.zip',
            '/tmp/enigul-xyz-sibling/evil.zip',
            '/tmp/enigul-xyzevil.zip', //  sexyz joins dir and name with no separator
            '/etc/passwd',
            'sub/dir.zip',
            '/tmp/enigul-xyz/sub/dir.zip',
            '.',
            '..',
            '/tmp/enigul-xyz',
        ];
        const { received, rejected } = select(
            names.map(n => sexyzLine('R', 1, n)).join('')
        );
        assert.deepEqual(received, []);
        assert.equal(rejected.length, names.length);
        rejected.forEach(r => assert.equal(r.reason, 'outside receive directory'));
    });

    it('rejects names carrying a control character', () => {
        const names = ['a\0.zip', 'a\n.zip', 'a\r.zip', 'a\t.zip', '\x1b.zip'];
        const { received, rejected } = receivedFilesFromEntries(
            names.map(fileName => ({ code: 'R', ok: true, bytes: 1, fileName })),
            recvDir
        );
        assert.deepEqual(received, []);
        assert.equal(rejected.length, names.length);
        rejected.forEach(r => assert.equal(r.reason, 'invalid name'));
    });

    it('confirms candidates against the disk', done => {
        const dir = makeTempDir();
        const good = writeFile(dir, 'good.zip', 100);
        const short = writeFile(dir, 'short.zip', 40);
        fs.mkdirSync(paths.join(dir, 'adir'));
        fs.symlinkSync(good, paths.join(dir, 'link.zip'));

        const candidates = [
            { path: good, bytes: 100 },
            { path: short, bytes: 100 },
            { path: paths.join(dir, 'adir'), bytes: 0 },
            { path: paths.join(dir, 'link.zip'), bytes: 100 },
            { path: paths.join(dir, 'missing.zip'), bytes: 1 },
        ];

        confirmReceivedFiles(candidates, (err, result) => {
            fs.rmSync(dir, { recursive: true, force: true });
            assert.equal(err, null);
            assert.deepEqual(result.confirmed, [good]);
            assert.equal(result.rejected.length, 4);
            return done();
        });
    });

    it('never confirms a symlink, even to a file of the logged size', done => {
        const dir = makeTempDir();
        const target = writeFile(dir, 'target.zip', 100);
        const link = paths.join(dir, 'link.zip');
        fs.symlinkSync(target, link);

        confirmReceivedFiles([{ path: link, bytes: 100 }], (err, result) => {
            fs.rmSync(dir, { recursive: true, force: true });
            assert.deepEqual(result.confirmed, []);
            assert.deepEqual(result.rejected, [
                { fileName: link, reason: 'not a regular file' },
            ]);
            return done();
        });
    });
});

describe('DSZLOG protocol environment', () => {
    it('adds DSZLOG and strips what node-pty would', () => {
        const base = { PATH: '/bin', TMUX: 'x', COLUMNS: '80', LINES: '25', HOME: '/h' };
        const env = buildProtocolEnv(base, '/tmp/x.dszlog');
        assert.deepEqual(env, { PATH: '/bin', HOME: '/h', DSZLOG: '/tmp/x.dszlog' });
        assert.equal(base.TMUX, 'x', 'base is not modified');
    });
});

//
//  recvFiles() with the protocol program stubbed out: what an upload yields
//  for each combination of exit status and DSZLOG.
//
describe('Upload salvage from DSZLOG', () => {
    before(loadFileTransferModule);

    let recvDir;

    beforeEach(() => {
        recvDir = makeTempDir() + paths.sep;
    });

    afterEach(() => {
        fs.rmSync(recvDir, { recursive: true, force: true });
    });

    function makeReceiver({ exitCode, dszLogText, recvFileName, external }) {
        const warnings = [];
        const proto = FileTransferModule.prototype;
        const transfer = {
            client: {
                log: {
                    warn: (obj, msg) => warnings.push({ obj, msg }),
                    debug() {},
                    info() {},
                    trace() {},
                    error() {},
                },
            },
            recvDirectory: recvDir,
            recvFileName,
            protocolConfig: { external: external || { dszLog: true } },
            dszLogText,
            warnings,
            recvFiles: proto.recvFiles,
            salvageReceivedFiles: proto.salvageReceivedFiles,
            executeExternalProtocolHandlerForRecv(cb) {
                const exitInfo = { cmd: 'sexyz', exitCode, signal: 0 };
                const err = exitCode
                    ? Errors.ExternalProcess(
                          `Process exited with exit code ${exitCode}`,
                          'EBADEXIT'
                      )
                    : null;
                return cb(err, exitInfo, dszLogText);
            },
        };
        return transfer;
    }

    const recv = transfer =>
        new Promise(resolve => transfer.recvFiles(err => resolve(err)));

    it('keeps a complete file when sexyz fails after receiving it (#914)', async () => {
        const file = writeFile(recvDir, 'upload.zip', 2048);
        const transfer = makeReceiver({
            exitCode: 1,
            dszLogText: sexyzLine('R', 2048, file),
        });

        const err = await recv(transfer);
        assert.equal(err, null);
        assert.deepEqual(transfer.recvFilePaths, [file]);
        assert.equal(transfer.warnings.length, 1);
        assert.match(transfer.warnings[0].msg, /exit(ed)? with code 1/);
        assert.deepEqual(transfer.warnings[0].obj.files, [file]);
    });

    it('returns only the confirmed files, not partials beside them', async () => {
        const good = writeFile(recvDir, 'good.zip', 1024);
        writeFile(recvDir, 'partial.zip', 300); //  failed mid-file
        writeFile(recvDir, 'unlogged.zip', 10); //  never in the log
        const transfer = makeReceiver({
            exitCode: 1,
            dszLogText:
                sexyzLine('R', 1024, good) +
                sexyzLine('E', 300, paths.join(recvDir, 'partial.zip')),
        });

        assert.equal(await recv(transfer), null);
        assert.deepEqual(transfer.recvFilePaths, [good]);
        assert.equal(transfer.warnings[0].obj.notConfirmed.length, 1);
    });

    it('fails as before when the log confirms nothing', async () => {
        writeFile(recvDir, 'partial.zip', 300);
        const transfer = makeReceiver({
            exitCode: 1,
            dszLogText: sexyzLine('E', 300, paths.join(recvDir, 'partial.zip')),
        });

        const err = await recv(transfer);
        assert.ok(err);
        assert.equal(err.reasonCode, 'EBADEXIT');
        assert.equal(transfer.recvFilePaths, undefined);
    });

    it('fails as before when the logged size does not match the file', async () => {
        const file = writeFile(recvDir, 'upload.zip', 100);
        const transfer = makeReceiver({
            exitCode: 1,
            dszLogText: sexyzLine('R', 2048, file),
        });

        assert.ok(await recv(transfer));
    });

    it('fails as before when there is no log', async () => {
        writeFile(recvDir, 'upload.zip', 100);
        for (const dszLogText of [null, '']) {
            const transfer = makeReceiver({ exitCode: 1, dszLogText });
            const err = await recv(transfer);
            assert.ok(err);
            assert.equal(transfer.recvFilePaths, undefined);
        }
    });

    it('never salvages a logged path outside the receive directory', async () => {
        const outside = makeTempDir();
        const evil = writeFile(outside, 'evil.zip', 10);
        try {
            const transfer = makeReceiver({
                exitCode: 1,
                dszLogText: sexyzLine('R', 10, evil) + sexyzLine('R', 10, '../evil.zip'),
            });
            assert.ok(await recv(transfer));
            assert.equal(transfer.recvFilePaths, undefined);
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });

    it('salvages nothing from a log with a line a forged name broke', async () => {
        //  the sender named its file "X\nR ... B.ZIP -1": the real E line for
        //  it loses its serial, and what follows reads as B.ZIP received
        const forged = writeFile(recvDir, 'B.ZIP', 100);
        const transfer = makeReceiver({
            exitCode: 1,
            dszLogText:
                `E      50 115200 bps    1 cps   0 errors     0 1024 ${recvDir}X\n` +
                'R     100 115200 bps    1 cps   0 errors     0 1024 B.ZIP -1\n',
        });

        //  on its own, the forged line would be believed
        assert.deepEqual(
            receivedFilesFromEntries(parseDszLog(transfer.dszLogText).entries, recvDir)
                .received,
            [{ path: forged, bytes: 100 }]
        );

        const err = await recv(transfer);
        assert.equal(err.reasonCode, 'EBADEXIT');
        assert.equal(transfer.recvFilePaths, undefined);
        assert.equal(transfer.warnings.length, 1);
        assert.match(transfer.warnings[0].msg, /do not parse/);
        assert.equal(transfer.warnings[0].obj.malformed[0].line, 1);
    });

    it('salvages nothing when a received name has a control character', async () => {
        //  a forgery that parses: the sender gave the real line a serial too
        const forgedName =
            'X 0\nR    100 115200 bps    1 cps   0 errors     0 1024 B.ZIP';
        writeFile(recvDir, forgedName, 50);
        writeFile(recvDir, 'B.ZIP', 100);
        const transfer = makeReceiver({
            exitCode: 1,
            dszLogText: sexyzLine('E', 50, recvDir + forgedName),
        });
        assert.deepEqual(parseDszLog(transfer.dszLogText).malformed, []);

        const err = await recv(transfer);
        assert.equal(err.reasonCode, 'EBADEXIT');
        assert.equal(transfer.recvFilePaths, undefined);
        assert.equal(transfer.warnings.length, 1);
        assert.match(transfer.warnings[0].msg, /control characters/);
        assert.deepEqual(transfer.warnings[0].obj.suspectNames, [forgedName]);
    });

    it('salvages from a CRLF log with a trailing blank line', async () => {
        const file = writeFile(recvDir, 'test file.bin', 50000);
        const transfer = makeReceiver({
            exitCode: 1,
            //  Debian rz: name relative to its working directory, CRLF
            dszLogText:
                'z  50000 467853200 bps 58481650 cps   0 errors     0    0 test file.bin -1\r\n\r\n',
        });

        assert.equal(await recv(transfer), null);
        assert.deepEqual(transfer.recvFilePaths, [file]);
    });

    it('salvages only the named file on a non-batch upload', async () => {
        const named = writeFile(recvDir, 'named.zip', 64);
        const other = writeFile(recvDir, 'other.zip', 64);
        const transfer = makeReceiver({
            exitCode: 1,
            recvFileName: 'named.zip',
            dszLogText: sexyzLine('R', 64, other) + sexyzLine('R', 64, 'named.zip'),
        });

        assert.equal(await recv(transfer), null);
        assert.deepEqual(transfer.recvFilePaths, [named]);
    });

    it('fails a non-batch upload whose named file the log does not confirm', async () => {
        const other = writeFile(recvDir, 'other.zip', 64);
        writeFile(recvDir, 'named.zip', 64);
        const transfer = makeReceiver({
            exitCode: 1,
            recvFileName: 'named.zip',
            dszLogText: sexyzLine('R', 64, other),
        });

        assert.ok(await recv(transfer));
    });

    it('leaves a clean exit exactly as it was', async () => {
        const a = writeFile(recvDir, 'a.zip', 10);
        const b = writeFile(recvDir, 'b.zip', 10);
        const transfer = makeReceiver({
            exitCode: 0,
            //  even a log that disagrees changes nothing on a clean exit
            dszLogText: sexyzLine('E', 10, a),
        });

        assert.equal(await recv(transfer), null);
        assert.deepEqual(transfer.recvFilePaths.slice().sort(), [a, b].sort());
        assert.equal(transfer.warnings.length, 0);
    });

    it('does not salvage a failure that is not a bad exit', async () => {
        const file = writeFile(recvDir, 'upload.zip', 10);
        const transfer = makeReceiver({
            exitCode: 0,
            dszLogText: sexyzLine('R', 10, file),
        });
        transfer.executeExternalProtocolHandlerForRecv = cb =>
            cb(new Error('Invalid client object'), undefined, sexyzLine('R', 10, file));

        assert.ok(await recv(transfer));
        assert.equal(transfer.recvFilePaths, undefined);
    });
});

//
//  The DSZLOG plumbing around the spawn: a log is made for protocols that
//  declare dszLog, handed to the program as DSZLOG, read back, and removed.
//
describe('DSZLOG plumbing', () => {
    before(loadFileTransferModule);

    function makeRunner(external, writeLog) {
        const proto = FileTransferModule.prototype;
        const seen = {};
        const transfer = {
            client: { log: { warn() {}, debug() {}, info() {}, trace() {}, error() {} } },
            recvDirectory: '/tmp/enigul-plumbing/',
            protocolConfig: { external },
            seen,
            createDszLog: proto.createDszLog,
            consumeDszLog: proto.consumeDszLog,
            executeExternalProtocolHandlerForRecv:
                proto.executeExternalProtocolHandlerForRecv,
            prepAndBuildRecvArgs: cb => cb(null, ['ry', '/tmp/enigul-plumbing/']),
            executeExternalProtocolHandler(args, options, cb) {
                seen.options = options;
                const dszLogPath = options.env && options.env.DSZLOG;
                if (dszLogPath) {
                    seen.dszLogPath = dszLogPath;
                    seen.existedBefore = fs.existsSync(dszLogPath);
                    if (writeLog) {
                        fs.writeFileSync(dszLogPath, writeLog);
                    }
                }
                return cb(Errors.ExternalProcess('x', 'EBADEXIT'), {
                    cmd: 'sexyz',
                    exitCode: 1,
                });
            },
        };
        return transfer;
    }

    it('passes DSZLOG, reads the log back and removes it', done => {
        const line = sexyzLine('R', 1, '/tmp/enigul-plumbing/a.zip');
        const transfer = makeRunner({ dszLog: true }, line);

        transfer.executeExternalProtocolHandlerForRecv((err, exitInfo, dszLogText) => {
            assert.equal(err.reasonCode, 'EBADEXIT');
            assert.equal(exitInfo.exitCode, 1);
            assert.equal(dszLogText, line);
            assert.ok(transfer.seen.existedBefore);
            assert.notEqual(
                paths.dirname(transfer.seen.dszLogPath) + paths.sep,
                transfer.recvDirectory,
                'never inside the receive directory'
            );
            assert.equal(transfer.seen.options.env.PATH, process.env.PATH);

            //  temptmp's cleanup is asynchronous
            setTimeout(() => {
                assert.equal(fs.existsSync(transfer.seen.dszLogPath), false);
                done();
            }, 100);
        });
    });

    it('removes the log when the protocol program cannot be spawned', done => {
        const transfer = makeRunner({ dszLog: true }, null);
        transfer.executeExternalProtocolHandler = (args, options) => {
            transfer.seen.dszLogPath = options.env.DSZLOG;
            throw new Error('File not found: sexyz'); //  as node-pty does
        };

        //  the throw comes back as an ordinary error, not out of the event loop
        transfer.executeExternalProtocolHandlerForRecv(err => {
            assert.ok(err);
            assert.match(err.message, /File not found/);
            assert.ok(transfer.seen.dszLogPath);

            //  temptmp's cleanup is asynchronous
            setTimeout(() => {
                assert.equal(fs.existsSync(transfer.seen.dszLogPath), false);
                done();
            }, 100);
        });
    });

    it('leaves the environment alone for protocols without dszLog', done => {
        const transfer = makeRunner({}, null);
        transfer.executeExternalProtocolHandlerForRecv((err, exitInfo, dszLogText) => {
            assert.equal(dszLogText, null);
            assert.deepEqual(transfer.seen.options, {});
            done();
        });
    });
});
