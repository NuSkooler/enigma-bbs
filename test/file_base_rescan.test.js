'use strict';

//
//  core/file_base_rescan.js (#291 phase 3): rescanning the existing file base.
//
//  Scanners are stubs registered under unique names that decide by the
//  file's content: "EICAR" is infected, "FAIL" makes the scanner fail (so the
//  file is held), anything else is clean. The operator notice writer is
//  replaced, so no message or user database is needed. The file database is
//  an in-memory one; the modules that capture it at load are required fresh
//  here and put back afterwards.
//

const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const paths = require('path');
const Database = require('better-sqlite3');

const configModule = require('../core/config.js');
const configDefault = require('../core/config_default.js');
const dbModule = require('../core/database.js');

const FRESH = [
    '../core/file_entry.js',
    '../core/file_base_area.js',
    '../core/file_base_rescan.js',
];

const FILE_DB_SCHEMA = `
    CREATE TABLE file (
        file_id                 INTEGER PRIMARY KEY,
        area_tag                VARCHAR NOT NULL,
        file_sha256             VARCHAR NOT NULL,
        file_name,
        storage_tag             VARCHAR NOT NULL,
        storage_tag_rel_path    VARCHAR DEFAULT NULL,
        desc,
        desc_long,
        upload_timestamp        DATETIME NOT NULL
    );
    CREATE TABLE file_meta (
        file_id     INTEGER NOT NULL,
        meta_name   VARCHAR NOT NULL,
        meta_value  VARCHAR NOT NULL,
        UNIQUE(file_id, meta_name, meta_value),
        FOREIGN KEY(file_id) REFERENCES file(file_id) ON DELETE CASCADE
    );
`;

const sha256 = data => require('crypto').createHash('sha256').update(data).digest('hex');

describe('file base rescan (#291)', function () {
    let FileScanner;
    let Rescan;
    let fileDb;
    let prevFileDb;
    let prevConfig;
    let config;
    let dir;
    let notices;
    let prevWriter;
    let scannerName;
    let scanState;
    let nameSeq = 0;
    const savedModules = {};

    const prefix = () => paths.join(dir, 'filebase');
    const storageDir = () => paths.join(prefix(), 'uploads');
    const quarantineDir = () => paths.join(prefix(), '.quarantine');
    const ls = d => {
        try {
            return fs.readdirSync(d).sort();
        } catch {
            return [];
        }
    };

    before(() => {
        config = configDefault();
        prevConfig = configModule._pushTestConfig(config);

        prevFileDb = dbModule.dbs.file;
        fileDb = new Database(':memory:');
        fileDb.pragma('foreign_keys = ON');
        fileDb.exec(FILE_DB_SCHEMA);
        dbModule.dbs.file = fileDb;

        FRESH.forEach(m => {
            const key = require.resolve(m);
            savedModules[key] = require.cache[key];
            delete require.cache[key];
        });

        FileScanner = require('../core/file_scanner.js');
        Rescan = require('../core/file_base_rescan.js');
    });

    after(() => {
        Object.entries(savedModules).forEach(([key, mod]) => {
            if (mod) {
                require.cache[key] = mod;
            } else {
                delete require.cache[key];
            }
        });
        dbModule.dbs.file = prevFileDb;
        fileDb.close();
        configModule._popTestConfig(prevConfig);
    });

    beforeEach(() => {
        fileDb.exec('DELETE FROM file_meta; DELETE FROM file;');
        dir = fs.realpathSync(fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-rescan-')));
        fs.mkdirSync(storageDir(), { recursive: true });

        config.fileBase.areaStoragePrefix = prefix();
        config.fileBase.storageTags = {
            uploads_main: 'uploads',
            tree: 'tree/*',
        };
        config.fileBase.areas = {
            uploads: { name: 'Uploads', storageTags: ['uploads_main'] },
            retro_dos: { name: 'Retro DOS', storageTags: ['uploads_main'] },
            tree: { name: 'Tree', storageTags: ['tree'] },
        };

        scanState = { active: 0, maxActive: 0, calls: [], delayMs: 0 };
        scannerName = `rescan_stub_${process.pid}_${++nameSeq}`;
        FileScanner.registerScanner(scannerName, {
            scan(filePath, ctx, cb) {
                scanState.active += 1;
                scanState.maxActive = Math.max(scanState.maxActive, scanState.active);
                scanState.calls.push({ filePath, ctx });
                const content = fs.readFileSync(filePath, 'latin1');
                setTimeout(() => {
                    scanState.active -= 1;
                    if (content.includes('EICAR')) {
                        return cb(null, {
                            result: 'infected',
                            signature: 'Stub-Found-It',
                        });
                    }
                    if (content.includes('FAIL')) {
                        return cb(new Error('scanner unreachable'));
                    }
                    if (content.includes('SKIP')) {
                        return cb(null, { result: 'skipped' });
                    }
                    return cb(null, { result: 'clean' });
                }, scanState.delayMs);
            },
        });

        config.fileBase.scanning = {
            enabled: true,
            failAction: 'quarantine',
            notifyUserIds: [1],
            maxConcurrent: 4,
            scanners: [{ scanner: scannerName }],
        };
        FileScanner.markModRegistrationComplete();

        notices = [];
        prevWriter = FileScanner._setNoticeWriter((userId, subject, body, cb) => {
            notices.push({ userId, subject, body });
            return cb(null);
        });
    });

    afterEach(() => {
        FileScanner._setNoticeWriter(prevWriter);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    //  a file on disk and its entry; returns the file ID
    function addFile(fileName, content, opts = {}) {
        const storageTag = opts.storageTag || 'uploads_main';
        const base = 'tree' === storageTag ? paths.join(prefix(), 'tree') : storageDir();
        const dirPath = paths.join(base, opts.relPath || '');
        fs.mkdirSync(dirPath, { recursive: true });
        if (null !== content) {
            fs.writeFileSync(paths.join(dirPath, fileName), content);
        }
        const info = fileDb
            .prepare(
                `INSERT INTO file (area_tag, file_sha256, file_name, storage_tag, storage_tag_rel_path, desc, desc_long, upload_timestamp)
                VALUES (?, ?, ?, ?, ?, '', '', '2026-01-01T00:00:00Z')`
            )
            .run(
                opts.areaTag || 'uploads',
                opts.sha256 || sha256(content || ''),
                fileName,
                storageTag,
                opts.relPath || null
            );
        const fileId = Number(info.lastInsertRowid);
        Object.entries(opts.meta || {}).forEach(([name, value]) => {
            fileDb
                .prepare(
                    'INSERT INTO file_meta (file_id, meta_name, meta_value) VALUES (?, ?, ?)'
                )
                .run(fileId, name, value);
        });
        return fileId;
    }

    const meta = (fileId, name) =>
        fileDb
            .prepare(
                'SELECT meta_value FROM file_meta WHERE file_id = ? AND meta_name = ?'
            )
            .all(fileId, name)
            .map(r => r.meta_value);

    const entryExists = fileId =>
        !!fileDb.prepare('SELECT 1 FROM file WHERE file_id = ?').get(fileId);

    const run = (options = {}) =>
        new Promise((resolve, reject) => {
            Rescan.rescanFileBase(options, (err, summary) =>
                err ? reject(err) : resolve(summary)
            );
        });

    const daysAgo = n => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

    describe('results', () => {
        it('updates scan meta for clean and skipped files, replacing the old value', async () => {
            const clean = addFile('GOOD.ZIP', 'clean bytes', {
                meta: { scan_result: 'clean', scanned_at: daysAgo(40), scanner: 'old' },
            });
            const skipped = addFile('SKIP.ZIP', 'SKIP me');

            const summary = await run();
            assert.equal(summary.counts.clean, 1);
            assert.equal(summary.counts.skipped, 1);
            assert.equal(summary.errors, 0);

            assert.deepEqual(meta(clean, 'scan_result'), ['clean']);
            assert.deepEqual(meta(clean, 'scanner'), [scannerName]);
            const [at] = meta(clean, 'scanned_at');
            assert.equal(meta(clean, 'scanned_at').length, 1, 'one scanned_at row');
            assert.ok(Date.now() - Date.parse(at) < 60000);
            assert.deepEqual(meta(skipped, 'scan_result'), ['skipped']);

            assert.deepEqual(ls(storageDir()), ['GOOD.ZIP', 'SKIP.ZIP']);
            assert.equal(notices.length, 0, 'nothing to tell the operators');
        });

        it('passes the source, real name, area and a freshly computed hash to scanners', async () => {
            addFile('GOOD.ZIP', 'clean bytes', { sha256: 'f'.repeat(64) });
            const summary = await run();
            const [{ ctx }] = scanState.calls;
            assert.equal(ctx.source, 'rescan');
            assert.equal(ctx.fileName, 'GOOD.ZIP');
            assert.equal(ctx.areaTag, 'uploads');
            assert.equal(ctx.sha256, sha256('clean bytes'), 'not the stale stored hash');
            assert.equal(ctx.byteSize, 11);
            assert.equal(summary.hashChanged, 1);
            assert.equal(summary.files[0].hashChanged, true);
        });

        it('quarantines an infected file and removes its entry', async () => {
            const bad = addFile('EVIL.EXE', 'X5O EICAR test', {
                meta: { dl_count: '3' },
            });
            const good = addFile('GOOD.ZIP', 'clean');

            const summary = await run();
            assert.equal(summary.counts.infected, 1);
            assert.equal(summary.removed, 1);
            assert.equal(summary.errors, 0);

            assert.equal(entryExists(bad), false);
            assert.deepEqual(meta(bad, 'dl_count'), [], 'meta goes with the entry');
            assert.equal(entryExists(good), true);
            assert.deepEqual(ls(storageDir()), ['GOOD.ZIP']);
            assert.deepEqual(ls(quarantineDir()), ['EVIL.EX_', 'EVIL.EX_.json']);

            const sidecar = JSON.parse(
                fs.readFileSync(paths.join(quarantineDir(), 'EVIL.EX_.json'), 'utf8')
            );
            assert.equal(sidecar.source, 'rescan');
            assert.equal(sidecar.areaTag, 'uploads');
            assert.equal(sidecar.signature, 'Stub-Found-It');

            assert.equal(notices.length, 1);
            assert.match(notices[0].subject, /1 infected/);
            assert.match(notices[0].body, /EVIL\.EXE/);
            assert.match(notices[0].body, /quarantined/);
            assert.match(notices[0].body, /removed from the file base/);
        });

        it('deletes an infected file with failAction: delete, and removes its entry', async () => {
            config.fileBase.scanning.failAction = 'delete';
            const bad = addFile('EVIL.EXE', 'EICAR');
            const summary = await run();
            assert.equal(summary.removed, 1);
            assert.equal(entryExists(bad), false);
            assert.deepEqual(ls(storageDir()), []);
            assert.deepEqual(ls(quarantineDir()), []);
            assert.match(notices[0].body, /Action:\s+deleted/);
        });

        it('keeps the entry, loudly, when the fail action fails', async function () {
            if (0 === process.getuid()) {
                this.skip(); //  root ignores the directory mode
            }
            config.fileBase.scanning.failAction = 'delete';
            const bad = addFile('EVIL.EXE', 'EICAR');
            fs.chmodSync(storageDir(), 0o500); //  the file cannot be unlinked
            let summary;
            try {
                summary = await run();
            } finally {
                fs.chmodSync(storageDir(), 0o700);
            }

            assert.equal(summary.counts.infected, 1);
            assert.equal(summary.removed, 0);
            assert.equal(summary.errors, 1);
            assert.equal(
                entryExists(bad),
                true,
                'no entry removed for a file still there'
            );
            assert.deepEqual(ls(storageDir()), ['EVIL.EXE']);
            assert.match(summary.files[0].error, /Could not quarantine or delete it/);
            assert.equal(notices.length, 1);
            assert.match(notices[0].body, /NOT moved/);
            assert.match(notices[0].body, /Still at:.*EVIL\.EXE/);
        });

        it('leaves a held file and its entry exactly as they are', async () => {
            const at = daysAgo(40);
            const held = addFile('MAYBE.ZIP', 'FAIL', {
                meta: { scan_result: 'clean', scanned_at: at, scanner: 'old' },
            });

            const summary = await run();
            assert.equal(summary.counts.held, 1);
            assert.equal(summary.errors, 0);
            assert.equal(entryExists(held), true);
            assert.deepEqual(ls(storageDir()), ['MAYBE.ZIP']);
            assert.deepEqual(ls(quarantineDir()), [], 'not quarantined');
            assert.deepEqual(meta(held, 'scanned_at'), [at], 'scanned_at not touched');
            assert.deepEqual(meta(held, 'scan_result'), ['clean']);

            assert.equal(notices.length, 1);
            assert.match(notices[0].body, /COULD NOT BE CHECKED/);
            assert.match(notices[0].body, /scanner unreachable/);
        });

        it('reports a missing physical file and keeps its entry', async () => {
            const gone = addFile('GONE.ZIP', null);
            const summary = await run();
            assert.equal(summary.counts.missing, 1);
            assert.equal(scanState.calls.length, 0);
            assert.equal(entryExists(gone), true);
            assert.deepEqual(meta(gone, 'scanned_at'), []);
            assert.equal(notices.length, 1);
            assert.match(notices[0].body, /MISSING/);
            assert.match(notices[0].body, /GONE\.ZIP/);
        });

        it('does not scan an entry whose storage tag is no longer configured', async () => {
            fs.writeFileSync(paths.join(prefix(), 'ORPHAN.ZIP'), 'EICAR');
            const orphan = addFile('ORPHAN.ZIP', null, { storageTag: 'gone_tag' });
            const summary = await run();
            assert.equal(summary.counts.error, 1);
            assert.match(summary.files[0].error, /Unknown storage tag/);
            assert.equal(scanState.calls.length, 0);
            assert.equal(entryExists(orphan), true);
            assert.ok(fs.existsSync(paths.join(prefix(), 'ORPHAN.ZIP')));
        });

        it('never moves an infected symbolic link or the file it points at', async () => {
            const outside = paths.join(dir, 'outside.exe');
            fs.writeFileSync(outside, 'EICAR');
            fs.symlinkSync(outside, paths.join(storageDir(), 'LINK.EXE'));
            const link = addFile('LINK.EXE', null);

            const summary = await run();
            assert.equal(summary.counts.infected, 1);
            assert.equal(summary.errors, 1);
            assert.equal(entryExists(link), true);
            assert.ok(fs.existsSync(outside));
            assert.ok(
                fs.lstatSync(paths.join(storageDir(), 'LINK.EXE')).isSymbolicLink()
            );
            assert.match(summary.files[0].error, /symbolic link/);
        });

        it('does not scan something that is not a regular file', async () => {
            fs.mkdirSync(paths.join(storageDir(), 'ADIR.ZIP'));
            addFile('ADIR.ZIP', null);
            const summary = await run();
            assert.equal(summary.counts.error, 1);
            assert.equal(scanState.calls.length, 0);
        });

        it('finds files in a recursive storage tag by their relative path', async () => {
            const bad = addFile('EVIL.COM', 'EICAR', {
                storageTag: 'tree',
                areaTag: 'tree',
                relPath: 'games/dos',
            });
            const good = addFile('GOOD.ZIP', 'clean', {
                storageTag: 'tree',
                areaTag: 'tree',
                relPath: 'games',
            });

            const summary = await run({ areaTags: ['tree'] });
            assert.equal(summary.counts.infected, 1);
            assert.equal(summary.counts.clean, 1);
            assert.equal(
                scanState.calls[0].filePath,
                paths.join(prefix(), 'tree', 'games', 'dos', 'EVIL.COM')
            );
            assert.equal(entryExists(bad), false);
            assert.equal(entryExists(good), true);
            assert.deepEqual(ls(paths.join(prefix(), 'tree', 'games', 'dos')), []);
            assert.deepEqual(ls(quarantineDir()), ['EVIL.CO_', 'EVIL.CO_.json']);
        });

        it('sends ONE notice for a run with several problems', async () => {
            addFile('A.EXE', 'EICAR');
            addFile('B.EXE', 'EICAR');
            addFile('C.ZIP', 'FAIL');
            addFile('D.ZIP', null);
            addFile('E.ZIP', 'clean');

            const summary = await run();
            assert.equal(notices.length, 1);
            assert.equal(summary.counts.infected, 2);
            assert.equal(summary.counts.held, 1);
            assert.equal(summary.counts.missing, 1);
            assert.match(notices[0].subject, /4 problems, 2 infected/);
            ['A.EXE', 'B.EXE', 'C.ZIP', 'D.ZIP'].forEach(n =>
                assert.ok(notices[0].body.includes(n), n)
            );
            notices[0].body
                .split('\r\n')
                .forEach(line => assert.ok(line.length <= 79, line));
        });

        it('strips pipe codes from names in the notice', async () => {
            addFile('EVIL|00|10FAKE.EXE', 'EICAR');
            await run();
            assert.equal(notices.length, 1);
            assert.doesNotMatch(notices[0].body, /\|\d\d/);
        });
    });

    describe('dry run', () => {
        it('scans and reports but changes nothing and sends no notice', async () => {
            const at = daysAgo(40);
            const bad = addFile('EVIL.EXE', 'EICAR');
            const good = addFile('GOOD.ZIP', 'clean', {
                meta: { scan_result: 'clean', scanned_at: at },
            });
            addFile('MAYBE.ZIP', 'FAIL');

            const summary = await run({ dryRun: true });
            assert.equal(summary.dryRun, true);
            assert.equal(summary.counts.infected, 1);
            assert.equal(summary.counts.clean, 1);
            assert.equal(summary.counts.held, 1);
            assert.equal(summary.removed, 0);

            assert.equal(entryExists(bad), true);
            assert.deepEqual(ls(storageDir()), ['EVIL.EXE', 'GOOD.ZIP', 'MAYBE.ZIP']);
            assert.deepEqual(ls(quarantineDir()), []);
            assert.deepEqual(meta(good, 'scanned_at'), [at]);
            assert.deepEqual(meta(bad, 'scan_result'), []);
            assert.equal(notices.length, 0);
            assert.match(Rescan.formatSummary(summary), /^DRY RUN, nothing changed\./);
        });
    });

    describe('filters', () => {
        it('olderThanDays: only never-scanned entries and those scanned too long ago', async () => {
            const never = addFile('NEVER.ZIP', 'a');
            const old = addFile('OLD.ZIP', 'b', { meta: { scanned_at: daysAgo(31) } });
            addFile('RECENT.ZIP', 'c', { meta: { scanned_at: daysAgo(2) } });

            const summary = await run({ olderThanDays: 30 });
            assert.equal(summary.matched, 2);
            assert.deepEqual(
                summary.files.map(f => f.fileId),
                [never, old]
            );
        });

        it('maxFiles: never scanned first, then oldest scan; the rest are left over', async () => {
            const mid = addFile('MID.ZIP', 'a', { meta: { scanned_at: daysAgo(10) } });
            const oldest = addFile('OLDEST.ZIP', 'b', {
                meta: { scanned_at: daysAgo(50) },
            });
            const never = addFile('NEVER.ZIP', 'c');
            addFile('NEWEST.ZIP', 'd', { meta: { scanned_at: daysAgo(1) } });

            const summary = await run({ maxFiles: 3 });
            assert.equal(summary.matched, 4);
            assert.equal(summary.checked, 3);
            assert.equal(summary.remaining, 1);
            assert.deepEqual(
                summary.files.map(f => f.fileId),
                [never, oldest, mid]
            );
            assert.match(Rescan.formatSummary(summary), /1 left for a later run/);
        });

        it('areaTags: wildcards, and never the internal areas', async () => {
            addFile('A.ZIP', 'a', { areaTag: 'retro_dos' });
            addFile('B.ZIP', 'b', { areaTag: 'uploads' });
            config.fileBase.areas.system_temporary_download = {
                name: 'Temp',
                storageTags: ['uploads_main'],
            };
            const t = addFile('T.ZIP', 'EICAR', { areaTag: 'system_temporary_download' });

            let summary = await run({ areaTags: ['retro_*'] });
            assert.deepEqual(
                summary.files.map(f => f.fileName),
                ['A.ZIP']
            );

            summary = await run();
            assert.deepEqual(summary.files.map(f => f.fileName).sort(), [
                'A.ZIP',
                'B.ZIP',
            ]);

            //  not even by ID
            summary = await run({ fileIds: [t] });
            assert.equal(summary.matched, 0);
            await assert.rejects(
                run({ areaTags: ['system_temporary_download'] }),
                /No file base area matches/
            );
        });

        it('refuses an area tag that names nothing', async () => {
            await assert.rejects(
                run({ areaTags: ['nope*'] }),
                /No file base area matches "nope\*"/
            );
        });

        it('fileIds: just those entries', async () => {
            addFile('A.ZIP', 'a');
            const b = addFile('B.ZIP', 'b');
            const summary = await run({ fileIds: [b] });
            assert.deepEqual(
                summary.files.map(f => f.fileId),
                [b]
            );
        });
    });

    describe('serial', () => {
        it('never runs more than one scan at a time, whatever maxConcurrent allows', async () => {
            scanState.delayMs = 15;
            for (let i = 0; i < 6; ++i) {
                addFile(`F${i}.ZIP`, `clean ${i}`);
            }
            const summary = await run();
            assert.equal(summary.counts.clean, 6);
            assert.equal(scanState.maxActive, 1);
        });
    });

    describe('refusing to run', () => {
        it('when scanning is disabled', async () => {
            config.fileBase.scanning.enabled = false;
            await assert.rejects(run(), /File scanning is disabled/);
        });

        it('when no entry scans the rescan source', async () => {
            config.fileBase.scanning.scanners = [
                { scanner: scannerName, sources: ['upload', 'tic'] },
            ];
            await assert.rejects(run(), /"rescan" source/);
        });

        it('runs when an entry lists no sources, or lists rescan', async () => {
            addFile('A.ZIP', 'a');
            config.fileBase.scanning.scanners = [
                { scanner: scannerName, sources: ['rescan'] },
            ];
            assert.equal((await run()).counts.clean, 1);
        });

        it('when a scanner it would use is not registered', async () => {
            config.fileBase.scanning.scanners = [{ scanner: 'no_such_scanner_here' }];
            await assert.rejects(run(), /not registered: no_such_scanner_here/);
        });

        it('while another rescan is running', async () => {
            scanState.delayMs = 50;
            addFile('A.ZIP', 'a');
            const first = run();
            await assert.rejects(run(), /already running/);
            await first;
            assert.equal(Rescan.isRunning(), false);
        });
    });

    describe('scheduler task', () => {
        const task = args =>
            new Promise(resolve => {
                Rescan.rescanFileBaseScheduledEvent(args, (err, output) =>
                    resolve({ err, output })
                );
            });

        it('parses its args and rejects unknown keys', () => {
            assert.deepEqual(Rescan.parseTaskArgs([]).options, {});
            assert.deepEqual(
                Rescan.parseTaskArgs([
                    { areas: 'retro_*', olderThanDays: 30, maxFiles: 100, dryRun: true },
                ]).options,
                { areaTags: ['retro_*'], olderThanDays: 30, maxFiles: 100, dryRun: true }
            );
            assert.match(
                Rescan.parseTaskArgs([{ olderThan: 30 }]).error.message,
                /Unknown argument\(s\) olderThan/
            );
            assert.ok(Rescan.parseTaskArgs(['retro_*']).error);
            assert.ok(Rescan.parseTaskArgs([{ maxFiles: 1.5 }]).error);
            assert.ok(Rescan.parseTaskArgs([{ olderThanDays: -1 }]).error);
            assert.ok(Rescan.parseTaskArgs([{ areas: [] }]).error);
        });

        it('succeeds with the summary as its output', async () => {
            addFile('A.ZIP', 'a');
            addFile('EVIL.EXE', 'EICAR');
            const { err, output } = await task([{ areas: ['uploads'] }]);
            assert.equal(err, null);
            assert.match(
                output,
                /Checked 2 of 2 matching files: 1 clean, .*1 infected \(1 removed\)/
            );
            assert.equal(notices.length, 1);
            assert.match(notices[0].body, /scheduled task/);
        });

        it('fails when a file could not be checked, still with the summary', async () => {
            addFile('MAYBE.ZIP', 'FAIL');
            const { err, output } = await task([]);
            assert.ok(err);
            assert.match(output, /1 could not be checked/);
            assert.equal(err.message, '1 file could not be checked');
        });

        it('fails without running on bad args or when not ready', async () => {
            addFile('A.ZIP', 'a');
            let res = await task([{ nope: 1 }]);
            assert.match(res.err.message, /Unknown argument/);
            config.fileBase.scanning.enabled = false;
            res = await task([]);
            assert.match(res.err.message, /disabled/);
            assert.equal(scanState.calls.length, 0);
        });
    });
});
