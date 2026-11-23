'use strict';

//
//  An upload keeps the modification time its sender gave it, unless that time
//  cannot be real: ZModem uploads arrived dated 10 May 2446, 0x37FFFFFFF
//  seconds (#1129). Before 1980, or more than a day ahead, becomes the time
//  the file was received; anything plausible is left alone.
//

const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const paths = require('path');

const FileUtil = require('../core/file_util.js');
const { isPlausibleFileTime, clampImplausibleFileTime } = FileUtil;

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date(Date.UTC(2026, 10, 23, 12, 0, 0));
const FAR_FUTURE_SECS = 0x37fffffff; //  2446-05-10 22:38:55 UTC
const PLAUSIBLE_PAST = new Date(Date.UTC(2001, 8, 9, 1, 46, 40));

function makeLog() {
    const entries = { trace: [], debug: [], info: [], warn: [], error: [], fatal: [] };
    const log = {};
    Object.keys(entries).forEach(level => {
        log[level] = (obj, msg) => entries[level].push({ obj, msg });
    });
    log.child = () => log;
    log.entries = entries;
    return log;
}

function makeTempDir() {
    return fs.realpathSync(fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-mtime-')));
}

//  a file dated |mtime| (and |atime|, if given), in seconds or a Date
function writeDated(dir, name, mtime, atime = mtime) {
    const p = paths.join(dir, name);
    fs.writeFileSync(p, Buffer.alloc(16));
    fs.utimesSync(p, atime, mtime);
    return p;
}

const mtimeMs = p => fs.statSync(p).mtimeMs;
const atimeMs = p => fs.statSync(p).atimeMs;

describe('isPlausibleFileTime', () => {
    it('accepts now, and a little ahead of now', () => {
        assert.equal(isPlausibleFileTime(NOW, NOW), true);
        assert.equal(isPlausibleFileTime(NOW.getTime() + 23 * 60 * 60 * 1000, NOW), true);
        assert.equal(isPlausibleFileTime(NOW.getTime() + DAY_MS, NOW), true);
    });

    it('rejects more than a day ahead', () => {
        assert.equal(isPlausibleFileTime(NOW.getTime() + DAY_MS + 1000, NOW), false);
        assert.equal(isPlausibleFileTime(NOW.getTime() + 30 * DAY_MS, NOW), false);
    });

    it('rejects 0x37FFFFFFF seconds, the 2446 date ZModem uploads had', () => {
        assert.equal(isPlausibleFileTime(FAR_FUTURE_SECS * 1000, NOW), false);
        assert.equal(isPlausibleFileTime(new Date(FAR_FUTURE_SECS * 1000), NOW), false);
    });

    it('rejects anything before 1980', () => {
        assert.equal(isPlausibleFileTime(Date.UTC(1979, 11, 31, 23, 59, 59), NOW), false);
        assert.equal(isPlausibleFileTime(0, NOW), false);
        assert.equal(isPlausibleFileTime(-1000, NOW), false);
        assert.equal(isPlausibleFileTime(Date.UTC(1980, 0, 1), NOW), true);
    });

    it('accepts a real date in the past', () => {
        assert.equal(isPlausibleFileTime(PLAUSIBLE_PAST, NOW), true);
        assert.equal(isPlausibleFileTime(Date.UTC(1993, 4, 1), NOW), true);
    });

    it('rejects a time that is not a number', () => {
        assert.equal(isPlausibleFileTime(NaN, NOW), false);
        assert.equal(isPlausibleFileTime(new Date('nope'), NOW), false);
        assert.equal(isPlausibleFileTime(undefined, NOW), false);
    });

    it('measures from the current time by default', () => {
        assert.equal(isPlausibleFileTime(Date.now()), true);
        assert.equal(isPlausibleFileTime(Date.now() + 2 * DAY_MS), false);
    });
});

describe('clampImplausibleFileTime', () => {
    let dir;
    let gfs;
    let realUtimes;

    before(() => {
        gfs = require('graceful-fs');
        realUtimes = gfs.utimes;
    });

    beforeEach(() => {
        dir = makeTempDir();
    });

    afterEach(() => {
        gfs.utimes = realUtimes;
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const clamp = (p, options) =>
        new Promise((resolve, reject) =>
            clampImplausibleFileTime(p, options, (err, result) =>
                err ? reject(err) : resolve(result)
            )
        );

    it('resets a 2446 mtime to the time received, and logs it once', async () => {
        const p = writeDated(dir, 'upload.zip', FAR_FUTURE_SECS);
        const log = makeLog();

        const result = await clamp(p, { now: NOW, log });

        assert.equal(result.clamped, true);
        assert.equal(mtimeMs(p), NOW.getTime());
        assert.equal(atimeMs(p), NOW.getTime(), 'a 2446 atime is reset too');
        assert.equal(log.entries.info.length, 1);
        const { obj } = log.entries.info[0];
        assert.equal(obj.fileName, 'upload.zip');
        assert.equal(obj.originalMtime.getTime(), FAR_FUTURE_SECS * 1000);
        assert.equal(obj.newMtime.getTime(), NOW.getTime());
        assert.equal(log.entries.warn.length, 0);
    });

    it('resets a pre-1980 mtime, keeping a plausible atime', async () => {
        const atime = new Date(Date.UTC(2026, 10, 22));
        const p = writeDated(dir, 'old.txt', 0, atime);
        const log = makeLog();

        const result = await clamp(p, { now: NOW, log });

        assert.equal(result.clamped, true);
        assert.equal(mtimeMs(p), NOW.getTime());
        assert.equal(atimeMs(p), atime.getTime());
    });

    it('leaves a plausible date alone, without logging', async () => {
        const p = writeDated(dir, 'keep.txt', PLAUSIBLE_PAST);
        const log = makeLog();

        const result = await clamp(p, { now: NOW, log });

        assert.equal(result.clamped, false);
        assert.equal(mtimeMs(p), PLAUSIBLE_PAST.getTime());
        Object.values(log.entries).forEach(e => assert.equal(e.length, 0));
    });

    it('leaves a time just ahead of now alone', async () => {
        const soon = new Date(NOW.getTime() + 12 * 60 * 60 * 1000);
        const p = writeDated(dir, 'skewed.txt', soon);

        const result = await clamp(p, { now: NOW, log: makeLog() });

        assert.equal(result.clamped, false);
        assert.equal(mtimeMs(p), soon.getTime());
    });

    it('warns and carries on when the file cannot be stat()ed', async () => {
        const log = makeLog();

        const result = await clamp(paths.join(dir, 'gone.zip'), { now: NOW, log });

        assert.equal(result.clamped, false);
        assert.equal(log.entries.warn.length, 1);
    });

    it('warns and carries on when utimes() fails', async () => {
        const p = writeDated(dir, 'upload.zip', FAR_FUTURE_SECS);
        const log = makeLog();
        gfs.utimes = (path, atime, mtime, cb) =>
            process.nextTick(() =>
                cb(Object.assign(new Error('EPERM'), { code: 'EPERM' }))
            );

        const result = await clamp(p, { now: NOW, log });

        assert.equal(result.clamped, false);
        assert.equal(log.entries.warn.length, 1);
        assert.equal(
            log.entries.warn[0].obj.originalMtime.getTime(),
            FAR_FUTURE_SECS * 1000
        );
        assert.equal(log.entries.info.length, 0);
    });

    it('does not follow a link to touch what it points to', async () => {
        const outside = makeTempDir();
        try {
            const target = writeDated(outside, 'target.txt', FAR_FUTURE_SECS);
            const link = paths.join(dir, 'link.txt');
            fs.symlinkSync(target, link);

            const result = await clamp(link, { now: NOW, log: makeLog() });

            assert.equal(result.clamped, false);
            assert.equal(mtimeMs(target), FAR_FUTURE_SECS * 1000);
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });
});

//
//  The upload path itself: recvFiles() with a real protocol program (node,
//  standing in for rz/sexyz) that writes files dated as a sender asked.
//
describe('File transfer: received files with implausible times (#1129)', function () {
    this.timeout(10000);

    let FileTransferModule;
    let recvDir;

    before(() => {
        FileTransferModule = require('../core/file_transfer.js').getModule;
    });

    beforeEach(() => {
        recvDir = makeTempDir();
    });

    afterEach(() => {
        fs.rmSync(recvDir, { recursive: true, force: true });
    });

    function makeClient(log) {
        const noop = () => {};
        return {
            session: { uniqueId: 'mtime-session' },
            user: { username: 'tester' },
            term: { termWidth: 80, termHeight: 25, passThroughWrite: noop },
            setTemporaryDirectDataHandler: noop,
            restoreDataHandler: noop,
            explicitActivityTimeUpdate: noop,
            beginFreeTime: noop,
            endFreeTime: noop,
            log,
        };
    }

    //  the module without its MenuModule constructor
    function makeReceiver(script, extra = {}) {
        const log = makeLog();
        const transfer = Object.create(FileTransferModule.prototype);
        return Object.assign(transfer, {
            client: makeClient(log),
            direction: 'recv',
            recvDirectory: recvDir,
            protocolConfig: {
                external: {
                    recvCmd: process.execPath,
                    recvArgs: ['-e', script],
                    recvArgsNonBatch: ['-e', script],
                    dszLog: true,
                },
            },
            testLog: log,
            ...extra,
        });
    }

    //  a protocol program that writes |files| ({ name, mtime } in seconds)
    //  into its working directory, logs them, and exits with |exitCode|
    function protocolScript(files, exitCode = 0) {
        return [
            "const fs = require('fs');",
            `for (const f of ${JSON.stringify(files)}) {`,
            '    fs.writeFileSync(f.name, Buffer.alloc(16));',
            '    fs.utimesSync(f.name, f.mtime, f.mtime);',
            '    fs.appendFileSync(process.env.DSZLOG,',
            '        `R      16 115200 bps   16 cps   0 errors     0 1024 ${f.name} 0\\n`);',
            '}',
            `process.exit(${exitCode});`,
        ].join('\n');
    }

    const recv = transfer =>
        new Promise(resolve => transfer.recvFilesFreeOfCharge(err => resolve(err)));

    const plausibleSecs = PLAUSIBLE_PAST.getTime() / 1000;

    it('resets a 2446 date on a batch upload and keeps a real one', async () => {
        const transfer = makeReceiver(
            protocolScript([
                { name: 'bogus.zip', mtime: FAR_FUTURE_SECS },
                { name: 'real.txt', mtime: plausibleSecs },
            ])
        );

        const before = Date.now();
        const err = await recv(transfer);
        const after = Date.now();

        assert.equal(err, null);
        assert.equal(transfer.recvFilePaths.length, 2);

        const bogus = mtimeMs(paths.join(recvDir, 'bogus.zip'));
        assert.ok(
            bogus >= before - 1000 && bogus <= after + 1000,
            `bogus.zip is dated ${new Date(bogus).toISOString()}`
        );
        assert.equal(mtimeMs(paths.join(recvDir, 'real.txt')), PLAUSIBLE_PAST.getTime());

        assert.equal(transfer.testLog.entries.info.length, 1);
        assert.equal(transfer.testLog.entries.info[0].obj.fileName, 'bogus.zip');
    });

    it('resets it on a non-batch upload', async () => {
        const transfer = makeReceiver(
            protocolScript([{ name: 'named.zip', mtime: FAR_FUTURE_SECS }]),
            { recvFileName: 'named.zip' }
        );

        assert.equal(await recv(transfer), null);
        assert.ok(mtimeMs(paths.join(recvDir, 'named.zip')) <= Date.now() + 1000);
    });

    it('resets it on files a failed transfer keeps from its DSZLOG', async () => {
        const transfer = makeReceiver(
            protocolScript([{ name: 'salvaged.zip', mtime: FAR_FUTURE_SECS }], 1)
        );

        assert.equal(await recv(transfer), null);
        assert.deepEqual(transfer.recvFilePaths, [paths.join(recvDir, 'salvaged.zip')]);
        assert.ok(mtimeMs(paths.join(recvDir, 'salvaged.zip')) <= Date.now() + 1000);
    });
});
