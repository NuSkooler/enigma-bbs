'use strict';

//
//  File scanning (#291): the scanner registry, the chain and its policy, the
//  built-in command scanner, quarantine/delete, the operator notice, and the
//  hook in file_base_area.scanFile().
//
//  No ClamAV here: the command scanner is driven with process.execPath and a
//  small inline script, so it runs the same on every OS. Message and user
//  databases are not needed either: the notice writer is replaced.
//

const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const paths = require('path');
const Database = require('better-sqlite3');

const configModule = require('../core/config.js');
const configDefault = require('../core/config_default.js');
const dbModule = require('../core/database.js');

const NODE = process.execPath;

//  An inline node script as command scanner args. The file path is argv[1].
const nodeArgs = script => ['-e', script, '{filePath}'];

let FileScanner;
let ErrorCodes;
let nameSeq = 0;

//  a unique name per stub: the registry is process wide
const uniqueName = base => `${base}_${process.pid}_${++nameSeq}`;

//  { result, signature, detail } after |delayMs|, recording each call
function stubScanner(answer, calls, delayMs = 0) {
    return {
        scan(filePath, ctx, cb) {
            calls.push({ filePath, ctx });
            setTimeout(() => cb(null, answer), delayMs);
        },
    };
}

describe('file_scanner', function () {
    let dir;
    let prevConfig;
    let config;

    const setScanning = scanning => {
        config.fileBase.scanning = Object.assign(
            {},
            configDefault().fileBase.scanning,
            scanning
        );
    };

    before(() => {
        FileScanner = require('../core/file_scanner.js');
        ErrorCodes = require('../core/enig_error.js').ErrorCodes;
    });

    beforeEach(() => {
        dir = fs.realpathSync(fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-scan-')));
        config = configDefault();
        config.fileBase.areaStoragePrefix = dir;
        prevConfig = configModule._pushTestConfig(config);
    });

    afterEach(() => {
        configModule._popTestConfig(prevConfig);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const writeFile = (name, data = 'some bytes') => {
        const p = paths.join(dir, name);
        fs.writeFileSync(p, data);
        return p;
    };

    describe('registry', () => {
        it('registers and looks up scanners; command is built in', () => {
            assert.ok(FileScanner.getScanner('command'));
            const name = uniqueName('reg');
            const impl = stubScanner({ result: 'clean' }, []);
            FileScanner.registerScanner(name, impl);
            assert.equal(FileScanner.getScanner(name), impl);
        });

        it('a second registration replaces the first', () => {
            const name = uniqueName('dupe');
            const a = stubScanner({ result: 'clean' }, []);
            const b = stubScanner({ result: 'clean' }, []);
            FileScanner.registerScanner(name, a);
            FileScanner.registerScanner(name, b);
            assert.equal(FileScanner.getScanner(name), b);
        });

        it('refuses a scanner with no scan()', done => {
            const name = uniqueName('bad');
            FileScanner.registerScanner(name, {}, err => {
                assert.ok(err);
                assert.equal(FileScanner.getScanner(name), undefined);
                done();
            });
        });

        it('calls init() with its entries only when scanning is enabled', done => {
            const name = uniqueName('init');
            const inits = [];
            const impl = {
                scan: () => {},
                init: (entries, cb) => {
                    inits.push(entries);
                    cb(null);
                },
            };

            setScanning({ enabled: false, scanners: [{ scanner: name }] });
            FileScanner.registerScanner(name, impl, () => {
                assert.equal(inits.length, 0);

                setScanning({
                    enabled: true,
                    scanners: [{ scanner: name, host: 'x' }, { scanner: 'other' }],
                });
                FileScanner.registerScanner(name, impl, err => {
                    assert.ifError(err);
                    assert.deepEqual(inits, [[{ scanner: name, host: 'x' }]]);
                    done();
                });
            });
        });
    });

    describe('scanFile() chain', () => {
        it('is "not scanned" when disabled, without running anything', done => {
            const calls = [];
            const name = uniqueName('off');
            FileScanner.registerScanner(name, stubScanner({ result: 'infected' }, calls));
            setScanning({ enabled: false, scanners: [{ scanner: name }] });

            FileScanner.scanFile(writeFile('a.zip'), { source: 'upload' }, (err, v) => {
                assert.ifError(err);
                assert.equal(v.result, 'not_scanned');
                assert.equal(v.rejected, false);
                assert.equal(calls.length, 0);
                done();
            });
        });

        it('requires a valid source', done => {
            setScanning({ enabled: true });
            FileScanner.scanFile(writeFile('a.zip'), { source: 'nope' }, err => {
                assert.equal(err.code, ErrorCodes.MissingParam);
                done();
            });
        });

        it('runs entries in order and reports clean', done => {
            const order = [];
            const a = uniqueName('a');
            const b = uniqueName('b');
            FileScanner.registerScanner(a, {
                scan: (p, ctx, cb) => {
                    order.push(a);
                    cb(null, { result: 'skipped' });
                },
            });
            FileScanner.registerScanner(b, {
                scan: (p, ctx, cb) => {
                    order.push(b);
                    cb(null, { result: 'clean' });
                },
            });
            setScanning({ enabled: true, scanners: [{ scanner: a }, { scanner: b }] });

            FileScanner.scanFile(writeFile('a.zip'), { source: 'upload' }, (err, v) => {
                assert.ifError(err);
                assert.deepEqual(order, [a, b]);
                assert.equal(v.result, 'clean');
                assert.equal(v.scanner, b);
                assert.deepEqual(
                    v.results.map(r => r.result),
                    ['skipped', 'clean']
                );
                done();
            });
        });

        it('is "skipped" when nothing said clean', done => {
            const name = uniqueName('skip');
            FileScanner.registerScanner(name, stubScanner({ result: 'skipped' }, []));
            setScanning({ enabled: true, scanners: [{ scanner: name }] });
            FileScanner.scanFile(writeFile('a.zip'), { source: 'tic' }, (err, v) => {
                assert.ifError(err);
                assert.equal(v.result, 'skipped');
                done();
            });
        });

        it('filters by source and by file type, using ctx.fileName', done => {
            const upCalls = [];
            const zipCalls = [];
            const up = uniqueName('up');
            const zip = uniqueName('zip');
            FileScanner.registerScanner(up, stubScanner({ result: 'clean' }, upCalls));
            FileScanner.registerScanner(zip, stubScanner({ result: 'clean' }, zipCalls));
            setScanning({
                enabled: true,
                scanners: [
                    { scanner: up, sources: ['upload'] },
                    { scanner: zip, fileTypes: ['.ZIP', 'lha'] },
                ],
            });

            //  temp name has no extension; the real name decides
            const p = writeFile('tmp12345');
            FileScanner.scanFile(p, { source: 'tic', fileName: 'FOO.Zip' }, err => {
                assert.ifError(err);
                assert.equal(upCalls.length, 0);
                assert.equal(zipCalls.length, 1);

                FileScanner.scanFile(
                    p,
                    { source: 'upload', fileName: 'foo.txt' },
                    (err, v) => {
                        assert.ifError(err);
                        assert.equal(upCalls.length, 1);
                        assert.equal(zipCalls.length, 1);
                        assert.equal(v.result, 'clean');

                        FileScanner.scanFile(
                            p,
                            { source: 'web', fileName: 'foo.txt' },
                            (err, v) => {
                                assert.ifError(err);
                                assert.equal(v.result, 'not_scanned');
                                done();
                            }
                        );
                    }
                );
            });
        });

        //  Windows drops trailing dots and spaces: these run as .exe there
        it('matches fileTypes past trailing dots and spaces', done => {
            const calls = [];
            const name = uniqueName('trail');
            FileScanner.registerScanner(name, stubScanner({ result: 'clean' }, calls));
            setScanning({
                enabled: true,
                scanners: [{ scanner: name, fileTypes: ['exe'] }],
            });

            const p = writeFile('tmp-trail');
            FileScanner.scanFile(p, { source: 'upload', fileName: 'foo.exe.' }, err => {
                assert.ifError(err);
                FileScanner.scanFile(p, { source: 'upload', fileName: 'x.EXE ' }, err => {
                    assert.ifError(err);
                    FileScanner.scanFile(
                        p,
                        { source: 'upload', fileName: 'y.exe . .' },
                        err => {
                            assert.ifError(err);
                            assert.equal(calls.length, 3);
                            done();
                        }
                    );
                });
            });
        });

        //  A throw in the caller's own callback used to be caught as a scanner
        //  failure and handed to a callback that had already run: the chain
        //  then never finished, and the caller's bug vanished.
        //  (A rejection ends the chain at once, from inside the scanner's
        //  callback: that is where the caller's code used to run in the try.)
        it('lets a throw from the caller callback surface, calling back once', () => {
            const name = uniqueName('sync');
            FileScanner.registerScanner(name, {
                scan: (p, ctx, cb) => cb(null, { result: 'infected', signature: 'X' }),
            });
            setScanning({ enabled: true, scanners: [{ scanner: name }] });

            //  hash and size known, and the scanner answers at once: the whole
            //  chain runs synchronously, so the throw comes back out here
            let calls = 0;
            assert.throws(
                () =>
                    FileScanner.scanFile(
                        writeFile('sync.zip'),
                        { source: 'upload', sha256: 'ab'.repeat(32), byteSize: 10 },
                        () => {
                            ++calls;
                            throw new Error('caller bug');
                        }
                    ),
                /caller bug/
            );
            assert.equal(calls, 1);
        });

        it('passes the entry as ctx.options and fills in sha256 / byteSize', done => {
            const calls = [];
            const name = uniqueName('ctx');
            FileScanner.registerScanner(name, stubScanner({ result: 'clean' }, calls));
            setScanning({ enabled: true, scanners: [{ scanner: name, apiKey: 'k' }] });

            const p = writeFile('a.bin', 'abc');
            FileScanner.scanFile(p, { source: 'upload', areaTag: 'uploads' }, err => {
                assert.ifError(err);
                const ctx = calls[0].ctx;
                assert.equal(ctx.options.apiKey, 'k');
                assert.equal(ctx.fileName, 'a.bin');
                assert.equal(ctx.areaTag, 'uploads');
                assert.equal(ctx.byteSize, 3);
                assert.equal(
                    ctx.sha256,
                    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
                );
                assert.equal(ctx.timeout, FileScanner.DefaultTimeoutMs);
                assert.ok(ctx.abortSignal);
                done();
            });
        });

        it('stops at the first infected and rejects with a typed error', done => {
            const later = [];
            const bad = uniqueName('bad');
            const after = uniqueName('after');
            FileScanner.registerScanner(
                bad,
                stubScanner({ result: 'infected', signature: 'Eicar-Test' }, [])
            );
            FileScanner.registerScanner(after, stubScanner({ result: 'clean' }, later));
            setScanning({
                enabled: true,
                scanners: [{ scanner: bad }, { scanner: after }],
            });

            FileScanner.scanFile(writeFile('e.com'), { source: 'upload' }, (err, v) => {
                assert.equal(err.code, ErrorCodes.FileRejected);
                assert.ok(FileScanner.isFileRejected(err));
                assert.equal(err.reasonCode, 'INFECTED');
                assert.equal(err.verdict, v);
                assert.equal(err.scanContext.fileName, 'e.com');
                assert.equal(v.result, 'infected');
                assert.equal(v.rejected, true);
                assert.equal(v.scanner, bad);
                assert.equal(v.signature, 'Eicar-Test');
                assert.equal(later.length, 0);
                done();
            });
        });

        it('holds on error by default', done => {
            const later = [];
            const broken = uniqueName('broken');
            const after = uniqueName('after');
            FileScanner.registerScanner(broken, {
                scan: (p, ctx, cb) => cb(new Error('clamd is down')),
            });
            FileScanner.registerScanner(after, stubScanner({ result: 'clean' }, later));
            setScanning({
                enabled: true,
                scanners: [{ scanner: broken }, { scanner: after }],
            });

            FileScanner.scanFile(writeFile('a.zip'), { source: 'upload' }, (err, v) => {
                assert.ok(FileScanner.isFileRejected(err));
                assert.equal(err.reasonCode, 'HELD');
                assert.equal(v.result, 'held');
                assert.equal(v.detail, 'clamd is down');
                assert.equal(later.length, 0);
                done();
            });
        });

        it('carries on past an error when the entry says accept', done => {
            const broken = uniqueName('broken');
            const after = uniqueName('after');
            FileScanner.registerScanner(broken, {
                scan: () => {
                    throw new Error('boom');
                },
            });
            FileScanner.registerScanner(after, stubScanner({ result: 'clean' }, []));
            setScanning({
                enabled: true,
                scanners: [{ scanner: broken, onError: 'accept' }, { scanner: after }],
            });

            FileScanner.scanFile(writeFile('a.zip'), { source: 'upload' }, (err, v) => {
                assert.ifError(err);
                assert.equal(v.result, 'clean');
                assert.deepEqual(
                    v.results.map(r => [r.result, r.detail]),
                    [
                        ['error', 'boom'],
                        ['clean', undefined],
                    ]
                );
                done();
            });
        });

        it('treats an unrecognised result as an error', done => {
            const name = uniqueName('weird');
            FileScanner.registerScanner(name, stubScanner({ result: 'maybe' }, []));
            setScanning({ enabled: true, scanners: [{ scanner: name }] });
            FileScanner.scanFile(writeFile('a.zip'), { source: 'upload' }, (err, v) => {
                assert.ok(FileScanner.isFileRejected(err));
                assert.equal(v.result, 'held');
                done();
            });
        });

        it('times a scanner out, aborts it, and holds the file', done => {
            const name = uniqueName('slow');
            let signal;
            FileScanner.registerScanner(name, {
                scan: (p, ctx) => {
                    signal = ctx.abortSignal; //  never calls back
                },
            });
            setScanning({ enabled: true, scanners: [{ scanner: name, timeout: 50 }] });

            FileScanner.scanFile(writeFile('a.zip'), { source: 'upload' }, (err, v) => {
                assert.ok(FileScanner.isFileRejected(err));
                assert.equal(v.result, 'held');
                assert.match(v.detail, /Timed out after 50ms/);
                assert.equal(signal.aborted, true);
                done();
            });
        });

        it('a late answer after a timeout is ignored', done => {
            const name = uniqueName('late');
            FileScanner.registerScanner(name, stubScanner({ result: 'clean' }, [], 100));
            setScanning({
                enabled: true,
                scanners: [{ scanner: name, timeout: 20, onError: 'accept' }],
            });
            let calls = 0;
            FileScanner.scanFile(writeFile('a.zip'), { source: 'upload' }, (err, v) => {
                ++calls;
                assert.ifError(err);
                assert.equal(v.result, 'skipped');
                setTimeout(() => {
                    assert.equal(calls, 1);
                    done();
                }, 150);
            });
        });

        it('holds when the named scanner is not registered', done => {
            setScanning({
                enabled: true,
                scanners: [{ scanner: uniqueName('missing_mod') }],
            });
            FileScanner.scanFile(writeFile('a.zip'), { source: 'upload' }, (err, v) => {
                assert.ok(FileScanner.isFileRejected(err));
                assert.equal(v.result, 'held');
                assert.match(v.detail, /is registered/);
                done();
            });
        });

        it('cleans scanner output of control characters', done => {
            const name = uniqueName('ctl');
            FileScanner.registerScanner(
                name,
                stubScanner({ result: 'infected', signature: 'Evil\x1b[2J\r\nName' }, [])
            );
            setScanning({ enabled: true, scanners: [{ scanner: name }] });
            FileScanner.scanFile(writeFile('a.zip'), { source: 'upload' }, (err, v) => {
                assert.ok(err);
                assert.equal(v.signature, 'Evil [2J Name');
                done();
            });
        });
    });

    describe('command scanner', () => {
        const runCommand = (entry, fileName, cb) => {
            setScanning({
                enabled: true,
                scanners: [Object.assign({ scanner: 'command', cmd: NODE }, entry)],
            });
            FileScanner.scanFile(writeFile(fileName), { source: 'upload' }, cb);
        };

        it('exit 0 is clean', done => {
            runCommand({ args: nodeArgs('process.exit(0)') }, 'a.zip', (err, v) => {
                assert.ifError(err);
                assert.equal(v.result, 'clean');
                assert.equal(v.scanner, 'command');
                done();
            });
        });

        it('exit 1 is infected, with the signature from signatureRegex', done => {
            runCommand(
                {
                    args: nodeArgs(
                        'console.log(process.argv[1] + ": Eicar-Test-Signature FOUND"); process.exit(1)'
                    ),
                    signatureRegex: '^.*: (.+) FOUND$',
                },
                'a.zip',
                (err, v) => {
                    assert.ok(FileScanner.isFileRejected(err));
                    assert.equal(v.result, 'infected');
                    assert.equal(v.signature, 'Eicar-Test-Signature');
                    done();
                }
            );
        });

        it('any other exit code is an error', done => {
            runCommand(
                { args: nodeArgs('console.error("db missing"); process.exit(2)') },
                'a.zip',
                (err, v) => {
                    assert.ok(FileScanner.isFileRejected(err));
                    assert.equal(v.result, 'held');
                    assert.match(v.detail, /exited with code 2: db missing/);
                    done();
                }
            );
        });

        it('honours configured exit codes', done => {
            runCommand(
                {
                    args: nodeArgs('process.exit(3)'),
                    exitCodes: { clean: [0, 3], infected: [9] },
                },
                'a.zip',
                (err, v) => {
                    assert.ifError(err);
                    assert.equal(v.result, 'clean');
                    done();
                }
            );
        });

        it('infectedRegex decides when the exit code is ambiguous', done => {
            //  MpCmdRun style: exit 2 for both "found" and "failed"
            const script = found =>
                nodeArgs(
                    `console.log(${
                        found
                            ? '"Threat                  : Virus:DOS/EICAR_Test_File"'
                            : '"failed"'
                    }); process.exit(2)`
                );
            const entry = found => ({
                args: script(found),
                exitCodes: { clean: [0], infected: [] },
                infectedRegex: '^Threat\\s+:\\s+(.+)$',
            });

            runCommand(entry(true), 'a.exe', (err, v) => {
                assert.ok(FileScanner.isFileRejected(err));
                assert.equal(v.result, 'infected');
                assert.equal(v.signature, 'Virus:DOS/EICAR_Test_File');

                runCommand(entry(false), 'b.exe', (err, v) => {
                    assert.ok(FileScanner.isFileRejected(err));
                    assert.equal(v.result, 'held');
                    done();
                });
            });
        });

        it('substitutes {fileName} and {filePath}', done => {
            runCommand(
                {
                    args: [
                        '-e',
                        'process.exit(process.argv[1] === "real.zip" && require("path").isAbsolute(process.argv[2]) ? 0 : 5)',
                        '{fileName}',
                        '{filePath}',
                    ],
                },
                'a.zip',
                (err, v) => {
                    //  ctx.fileName defaulted from the path, here a.zip
                    assert.ok(FileScanner.isFileRejected(err));
                    assert.equal(v.result, 'held');

                    setScanning({
                        enabled: true,
                        scanners: [
                            {
                                scanner: 'command',
                                cmd: NODE,
                                args: [
                                    '-e',
                                    'process.exit(process.argv[1] === "real.zip" ? 0 : 5)',
                                    '{fileName}',
                                ],
                            },
                        ],
                    });
                    FileScanner.scanFile(
                        writeFile('tmp1'),
                        { source: 'upload', fileName: 'real.zip' },
                        (err, v) => {
                            assert.ifError(err);
                            assert.equal(v.result, 'clean');
                            done();
                        }
                    );
                }
            );
        });

        it('kills a command that runs past its timeout', function (done) {
            this.timeout(10000);
            const started = Date.now();
            runCommand(
                { args: nodeArgs('setTimeout(() => {}, 30000)'), timeout: 300 },
                'a.zip',
                (err, v) => {
                    assert.ok(FileScanner.isFileRejected(err));
                    assert.equal(v.result, 'held');
                    assert.ok(Date.now() - started < 5000);
                    done();
                }
            );
        });

        it('a command that cannot start is an error', done => {
            runCommand({ cmd: paths.join(dir, 'no-such-scanner') }, 'a.zip', (err, v) => {
                assert.ok(FileScanner.isFileRejected(err));
                assert.equal(v.result, 'held');
                done();
            });
        });

        it('an entry with no cmd is an error', done => {
            runCommand({ cmd: undefined }, 'a.zip', (err, v) => {
                assert.ok(FileScanner.isFileRejected(err));
                assert.match(v.detail, /no "cmd"/);
                done();
            });
        });
    });

    describe('applyFailAction()', () => {
        const infected = {
            result: 'infected',
            rejected: true,
            scanner: 'stub',
            signature: 'Eicar-Test',
            results: [{ result: 'infected', scanner: 'stub', signature: 'Eicar-Test' }],
        };
        const held = {
            result: 'held',
            rejected: true,
            scanner: 'stub',
            detail: 'timed out',
            results: [{ result: 'error', scanner: 'stub', detail: 'timed out' }],
        };

        it('defangs names DOS style', () => {
            assert.equal(FileScanner.defangFileName('GAME.EXE'), 'GAME.EX_');
            assert.equal(FileScanner.defangFileName('run.sh'), 'run.s_');
            assert.equal(FileScanner.defangFileName('a.ps1'), 'a.ps_');
            assert.equal(FileScanner.defangFileName('a.zip'), 'a.zip');
            assert.equal(FileScanner.defangFileName('noext'), 'noext');
            assert.equal(FileScanner.defangFileName('a.zip', ['.ZIP']), 'a.zi_');
        });

        it('quarantines: moves, defangs, strips exec bits, writes a sidecar', done => {
            setScanning({ enabled: true });
            const src = writeFile('tmp-upload-1', 'MZ evil');
            fs.chmodSync(src, 0o755);

            const ctx = {
                source: 'upload',
                fileName: 'GAME.EXE',
                areaTag: 'uploads',
                user: { userId: 7, username: 'lamer' },
            };
            FileScanner.applyFailAction(src, infected, ctx, (err, disp) => {
                assert.ifError(err);
                assert.equal(disp.action, 'quarantine');
                assert.equal(disp.path, paths.join(dir, '.quarantine', 'GAME.EX_'));
                assert.equal(fs.existsSync(src), false);
                assert.equal(fs.readFileSync(disp.path, 'utf8'), 'MZ evil');
                if ('win32' !== process.platform) {
                    assert.equal(fs.statSync(disp.path).mode & 0o111, 0);
                }

                assert.equal(disp.sidecarPath, `${disp.path}.json`);
                const record = JSON.parse(fs.readFileSync(disp.sidecarPath, 'utf8'));
                assert.equal(record.originalName, 'GAME.EXE');
                assert.equal(record.quarantineName, 'GAME.EX_');
                assert.equal(record.source, 'upload');
                assert.equal(record.areaTag, 'uploads');
                assert.deepEqual(record.user, { id: 7, name: 'lamer' });
                assert.equal(record.byteSize, 7);
                assert.match(record.sha256, /^[0-9a-f]{64}$/);
                assert.equal(record.verdict, 'infected');
                assert.equal(record.scanner, 'stub');
                assert.equal(record.signature, 'Eicar-Test');
                assert.equal(record.action, 'quarantine');
                assert.ok(!isNaN(Date.parse(record.quarantinedAt)));

                //  same name again: neither file nor sidecar is replaced
                const src2 = writeFile('tmp-upload-2', 'MZ evil 2');
                FileScanner.applyFailAction(src2, infected, ctx, (err, disp2) => {
                    assert.ifError(err);
                    assert.equal(
                        disp2.path,
                        paths.join(dir, '.quarantine', 'GAME(1).EX_')
                    );
                    assert.equal(fs.readFileSync(disp.path, 'utf8'), 'MZ evil');
                    assert.ok(fs.existsSync(disp2.sidecarPath));
                    done();
                });
            });
        });

        it('honours an absolute quarantinePath and keeps names out of other dirs', done => {
            const q = paths.join(dir, 'q');
            setScanning({ enabled: true, quarantinePath: q });
            const src = writeFile('t1');
            FileScanner.applyFailAction(
                src,
                infected,
                { source: 'tic', fileName: '../../etc/x.bat' },
                (err, disp) => {
                    assert.ifError(err);
                    assert.equal(disp.path, paths.join(q, 'x.ba_'));
                    done();
                }
            );
        });

        it('deletes when failAction is delete', done => {
            setScanning({ enabled: true, failAction: 'delete' });
            const src = writeFile('t1');
            FileScanner.applyFailAction(src, infected, { source: 'upload' }, (err, d) => {
                assert.ifError(err);
                assert.deepEqual(d, { action: 'delete' });
                assert.equal(fs.existsSync(src), false);
                assert.equal(fs.existsSync(paths.join(dir, '.quarantine')), false);
                done();
            });
        });

        it('never deletes a held file', done => {
            setScanning({ enabled: true, failAction: 'delete' });
            const src = writeFile('t1');
            FileScanner.applyFailAction(
                src,
                held,
                { source: 'upload', fileName: 'maybe.zip' },
                (err, d) => {
                    assert.ifError(err);
                    assert.equal(d.action, 'quarantine');
                    assert.ok(fs.existsSync(d.path));
                    done();
                }
            );
        });

        it('defangs past trailing dots and spaces, which Windows drops', () => {
            assert.equal(FileScanner.defangFileName('foo.exe.'), 'foo.ex_');
            assert.equal(FileScanner.defangFileName('x.EXE '), 'x.EX_');
            assert.equal(FileScanner.defangFileName('y.bat . .'), 'y.ba_');
            assert.equal(FileScanner.defangFileName('a.zip. '), 'a.zip');
        });

        //  "..", "." and friends made the move fail, leaving the file in place
        it('quarantines a file whose name has nothing usable left', done => {
            setScanning({ enabled: true });
            //  (an empty fileName is not one: the file's own base name is used)
            const names = ['..', '.', '...', '. .', 'x/..', 'x\\..'];
            const results = [];

            const next = () => {
                if (results.length === names.length) {
                    const q = fs.readdirSync(paths.join(dir, '.quarantine'));
                    assert.equal(
                        q.filter(n => !n.endsWith('.json')).length,
                        names.length
                    );
                    results.forEach(({ name, disp }) => {
                        assert.match(
                            paths.basename(disp.path),
                            /^unnamed-[0-9a-f]{16}(\(\d+\))?$/
                        );
                        const record = JSON.parse(
                            fs.readFileSync(disp.sidecarPath, 'utf8')
                        );
                        assert.equal(record.originalName, name, 'kept in the sidecar');
                    });
                    return done();
                }

                const name = names[results.length];
                const src = writeFile('tmp-hostile', `payload ${results.length}`);
                FileScanner.applyFailAction(
                    src,
                    infected,
                    { source: 'tic', fileName: name },
                    (err, disp) => {
                        assert.ifError(err);
                        assert.equal(fs.existsSync(src), false);
                        results.push({ name, disp });
                        return next();
                    }
                );
            };

            next();
        });

        it('quarantines a name too long for the file system under a generated one', done => {
            setScanning({ enabled: true });
            const src = writeFile('tmp-long');
            FileScanner.applyFailAction(
                src,
                infected,
                { source: 'upload', fileName: `${'A'.repeat(300)}.exe` },
                (err, disp) => {
                    assert.ifError(err);
                    assert.match(
                        paths.basename(disp.path),
                        /^unnamed-[0-9a-f]{16}\.ex_$/
                    );
                    done();
                }
            );
        });

        it('quarantines "FOO.EXE." defanged and without the trailing dot', done => {
            setScanning({ enabled: true });
            const src = writeFile('tmp-dot');
            FileScanner.applyFailAction(
                src,
                infected,
                { source: 'upload', fileName: 'FOO.EXE. ' },
                (err, disp) => {
                    assert.ifError(err);
                    assert.equal(paths.basename(disp.path), 'FOO.EX_');
                    done();
                }
            );
        });

        //  a quarantine directory that cannot be made: a file is in the way
        const blockQuarantine = () => {
            writeFile('blocker', 'not a directory');
            setScanning({ enabled: true, quarantinePath: 'blocker' });
        };

        it('deletes an infected file that cannot be quarantined, and says so', done => {
            blockQuarantine();
            const src = writeFile('tmp-noq', 'EICAR');
            FileScanner.applyFailAction(
                src,
                infected,
                { source: 'oputil', fileName: 'BAD.EXE' },
                (err, disp) => {
                    assert.ifError(err);
                    assert.equal(disp.action, 'delete');
                    assert.ok(disp.quarantineError);
                    assert.equal(fs.existsSync(src), false, 'never left in place');

                    const { body } = FileScanner.buildOperatorNotice([
                        {
                            ctx: { fileName: 'BAD.EXE' },
                            verdict: infected,
                            disposition: disp,
                        },
                    ]);
                    assert.match(body, /Action: {2}DELETED, could not be quarantined: /);
                    done();
                }
            );
        });

        it('leaves a held file that cannot be quarantined where it is, with an error', done => {
            blockQuarantine();
            const src = writeFile('tmp-noq', 'maybe fine');
            FileScanner.applyFailAction(
                src,
                held,
                { source: 'oputil', fileName: 'maybe.zip' },
                (err, disp) => {
                    assert.ok(err);
                    assert.equal(disp, undefined);
                    assert.ok(fs.existsSync(src), 'a held file may be clean: kept');
                    done();
                }
            );
        });

        it('is an error when an infected file can be neither quarantined nor deleted', function (done) {
            if ('win32' === process.platform || 0 === process.getuid()) {
                return this.skip(); //  permissions do not stop root
            }
            blockQuarantine();
            const sub = paths.join(dir, 'ro');
            fs.mkdirSync(sub);
            const src = paths.join(sub, 'tmp-stuck');
            fs.writeFileSync(src, 'EICAR');
            fs.chmodSync(sub, 0o555);

            FileScanner.applyFailAction(
                src,
                infected,
                { source: 'oputil', fileName: 'STUCK.EXE' },
                (err, disp) => {
                    fs.chmodSync(sub, 0o755);
                    assert.ok(err);
                    assert.match(err.message, /quarantine .* or delete/);
                    assert.equal(disp, undefined);
                    done();
                }
            );
        });

        it('refuses a verdict that is not a rejection', done => {
            const src = writeFile('t1');
            FileScanner.applyFailAction(
                src,
                { result: 'clean', rejected: false },
                { source: 'upload' },
                err => {
                    assert.equal(err.code, ErrorCodes.Invalid);
                    assert.ok(fs.existsSync(src));
                    done();
                }
            );
        });
    });

    describe('notifyOperators()', () => {
        let sent;
        let prevWriter;

        beforeEach(() => {
            sent = [];
            prevWriter = FileScanner._setNoticeWriter((userId, subject, body, cb) => {
                sent.push({ userId, subject, body });
                cb(2 === userId ? new Error('no such user') : null);
            });
        });

        afterEach(() => FileScanner._setNoticeWriter(prevWriter));

        const rejections = () => [
            {
                ctx: { fileName: 'GAME.EXE\x1b[31m\u00e9', areaTag: 'uploads' },
                verdict: { result: 'infected', scanner: 'clamav', signature: 'Eicar' },
                disposition: { action: 'quarantine', path: '/q/GAME.EX_' },
            },
            {
                ctx: { fileName: 'b.zip', areaTag: 'uploads' },
                verdict: { result: 'held', scanner: 'clamav', detail: 'timed out' },
                disposition: { action: 'quarantine', path: '/q/b.zip' },
            },
        ];

        it('sends one ASCII, CRLF message per recipient listing every file', done => {
            setScanning({ enabled: true, notifyUserIds: [1, 2, 1] });
            FileScanner.notifyOperators(
                rejections(),
                { source: 'upload', user: { userId: 9, username: 'bob' } },
                err => {
                    assert.ifError(err); //  user 2 failing does not fail the caller
                    assert.deepEqual(
                        sent.map(s => s.userId),
                        [1, 2]
                    );
                    const { subject, body } = sent[0];
                    assert.equal(subject, 'File scan: 2 files rejected');
                    assert.match(body, /^[\x20-\x7e\r\n]*$/);
                    assert.ok(!/[^\r]\n/.test(body));
                    assert.match(body, /File: {4}GAME\.EXE \[31m\r\n/);
                    assert.match(body, /From: {4}upload \(user bob #9\)/);
                    assert.match(body, /Result: {2}infected: Eicar/);
                    assert.match(body, /Action: {2}quarantined to \/q\/GAME\.EX_/);
                    assert.match(body, /Result: {2}held, scanner failed: timed out/);
                    assert.match(body, /It may be clean/);
                    done();
                }
            );
        });

        it('sends nothing for no rejections', done => {
            setScanning({ enabled: true });
            FileScanner.notifyOperators([], { source: 'upload' }, err => {
                assert.ifError(err);
                assert.equal(sent.length, 0);
                done();
            });
        });

        it('says when a file was deleted', () => {
            const { body } = FileScanner.buildOperatorNotice(
                [
                    {
                        ctx: { fileName: 'x.exe' },
                        verdict: { result: 'infected', scanner: 's' },
                        disposition: { action: 'delete' },
                    },
                ],
                { source: 'tic', ticInfo: { origin: '21:1/100' } }
            );
            assert.match(body, /Action: {2}deleted/);
            assert.match(body, /From: {4}tic \(TIC origin 21:1\/100\)/);
            assert.ok(!/It may be clean/.test(body));
        });
    });

    //
    //  file_base_area.scanFile(): the hook sits after hashing and before
    //  anything looks inside the file.
    //
    describe('file_base_area.scanFile() hook', () => {
        const FRESH = ['../core/file_base_area.js', '../core/archive_util.js'];
        const savedModules = {};
        let FileArea;
        let prevFileDb;
        let detectCalls;
        let hookConfig;
        let hookPrevConfig;

        before(done => {
            hookConfig = configDefault();
            hookPrevConfig = configModule._pushTestConfig(hookConfig);

            prevFileDb = dbModule.dbs.file;
            const db = new Database(':memory:');
            db.exec(
                'CREATE TABLE file (file_id INTEGER PRIMARY KEY, area_tag, file_sha256);'
            );
            dbModule.dbs.file = db;

            FRESH.forEach(m => {
                const key = require.resolve(m);
                savedModules[key] = require.cache[key];
                delete require.cache[key];
            });
            FileArea = require('../core/file_base_area.js');

            //  spy on archive detection, the first thing that looks inside
            const archiveUtil = require('../core/archive_util.js').getInstance(false);
            const origDetect = archiveUtil.detectType.bind(archiveUtil);
            archiveUtil.detectType = (p, cb) => {
                detectCalls.push(p);
                return origDetect(p, cb);
            };

            require('../core/mime_util.js').startup(done);
        });

        after(() => {
            Object.entries(savedModules).forEach(([key, mod]) => {
                if (mod) {
                    require.cache[key] = mod;
                } else {
                    delete require.cache[key];
                }
            });
            dbModule.dbs.file.close();
            dbModule.dbs.file = prevFileDb;
            configModule._popTestConfig(hookPrevConfig);
        });

        //  the outer beforeEach pushed its own config; use ours for these
        beforeEach(() => {
            detectCalls = [];
            hookConfig.fileBase.areaStoragePrefix = dir;
            configModule._pushTestConfig(hookConfig);
            config = hookConfig;
        });

        const scanWithSteps = (filePath, options, cb) => {
            const steps = [];
            FileArea.scanFile(
                filePath,
                options,
                (stepInfo, next) => {
                    steps.push({
                        step: stepInfo.step,
                        scanResult: stepInfo.scanResult,
                        detects: detectCalls.length,
                    });
                    return next(null);
                },
                (err, fileEntry) => cb(err, fileEntry, steps)
            );
        };

        it('runs the scanner after hashing and before archive detection', done => {
            const calls = [];
            const name = uniqueName('hook');
            FileScanner.registerScanner(name, {
                scan: (p, ctx, cb) => {
                    calls.push({ ctx, detectsSoFar: detectCalls.length });
                    cb(null, { result: 'clean' });
                },
            });
            setScanning({ enabled: true, scanners: [{ scanner: name }] });

            const p = writeFile('tmp-up', 'hello');
            scanWithSteps(
                p,
                {
                    areaTag: 'uploads',
                    scanSource: 'upload',
                    scanContext: { fileName: 'hello.txt', user: { userId: 3 } },
                },
                (err, fileEntry, steps) => {
                    assert.ifError(err);
                    assert.equal(calls.length, 1);
                    assert.equal(calls[0].detectsSoFar, 0);
                    assert.equal(detectCalls.length, 1);

                    const ctx = calls[0].ctx;
                    assert.equal(ctx.source, 'upload');
                    assert.equal(ctx.fileName, 'hello.txt');
                    assert.equal(ctx.areaTag, 'uploads');
                    assert.equal(ctx.user.userId, 3);
                    assert.equal(ctx.byteSize, 5);
                    assert.equal(ctx.sha256, fileEntry.fileSha256);

                    const names = steps.map(s => s.step);
                    const hashAt = names.indexOf('hash_finish');
                    const startAt = names.indexOf('virus_scan_start');
                    const finishAt = names.indexOf('virus_scan_finish');
                    assert.ok(hashAt >= 0 && hashAt < startAt && startAt < finishAt);
                    assert.equal(steps[finishAt].scanResult, 'clean');
                    assert.equal(steps[finishAt].detects, 0);

                    assert.equal(fileEntry.meta.scan_result, 'clean');
                    assert.equal(fileEntry.meta.scanner, name);
                    assert.ok(!isNaN(Date.parse(fileEntry.meta.scanned_at)));
                    done();
                }
            );
        });

        it('does nothing without a scanSource', done => {
            const calls = [];
            const name = uniqueName('hook_none');
            FileScanner.registerScanner(name, stubScanner({ result: 'infected' }, calls));
            setScanning({ enabled: true, scanners: [{ scanner: name }] });

            scanWithSteps(
                writeFile('a.txt'),
                { areaTag: 'x' },
                (err, fileEntry, steps) => {
                    assert.ifError(err);
                    assert.equal(calls.length, 0);
                    assert.ok(!steps.some(s => /virus_scan/.test(s.step)));
                    assert.equal(fileEntry.meta.scan_result, undefined);
                    done();
                }
            );
        });

        it('emits no scan steps and records nothing when scanning is disabled', done => {
            setScanning({ enabled: false });
            scanWithSteps(
                writeFile('a.txt'),
                { scanSource: 'upload' },
                (err, fileEntry, steps) => {
                    assert.ifError(err);
                    assert.ok(!steps.some(s => /virus_scan/.test(s.step)));
                    assert.equal(fileEntry.meta.scan_result, undefined);
                    done();
                }
            );
        });

        it('a rejection stops before the file is looked inside', done => {
            const name = uniqueName('hook_bad');
            FileScanner.registerScanner(
                name,
                stubScanner({ result: 'infected', signature: 'Eicar' }, [])
            );
            setScanning({ enabled: true, scanners: [{ scanner: name }] });

            scanWithSteps(
                writeFile('evil.zip', 'PK\x03\x04 not really'),
                { scanSource: 'web' },
                (err, fileEntry, steps) => {
                    assert.ok(FileScanner.isFileRejected(err));
                    assert.equal(err.verdict.signature, 'Eicar');
                    assert.equal(err.scanContext.source, 'web');
                    assert.equal(fileEntry, undefined);
                    assert.equal(detectCalls.length, 0);
                    const names = steps.map(s => s.step);
                    assert.equal(_last(names), 'virus_scan_finish');
                    assert.equal(_last(steps).scanResult, 'infected');
                    done();
                }
            );
        });
    });
});

function _last(a) {
    return a[a.length - 1];
}
