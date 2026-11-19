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

        scanState = { active: 0, maxActive: 0, calls: [], delayMs: 0, onScan: null };
        scannerName = `rescan_stub_${process.pid}_${++nameSeq}`;
        FileScanner.registerScanner(scannerName, {
            scan(filePath, ctx, cb) {
                scanState.active += 1;
                scanState.maxActive = Math.max(scanState.maxActive, scanState.active);
                scanState.calls.push({ filePath, ctx });
                if (scanState.onScan) {
                    scanState.onScan(filePath, ctx);
                }
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

    const outside = () => paths.join(dir, 'OUTSIDE');

    //  an entry with any name / rel path, no file written
    const insertRaw = (fileName, relPath) =>
        Number(
            fileDb
                .prepare(
                    `INSERT INTO file (area_tag, file_sha256, file_name, storage_tag, storage_tag_rel_path, desc, desc_long, upload_timestamp)
                    VALUES ('uploads', 'x', ?, 'uploads_main', ?, '', '', '2026-01-01')`
                )
                .run(fileName, relPath).lastInsertRowid
        );

    describe('results (report only)', () => {
        it('records clean and skipped, replacing the old values', async () => {
            const clean = addFile('GOOD.ZIP', 'clean bytes', {
                meta: {
                    scan_result: 'infected',
                    scan_signature: 'Old-Sig',
                    scanned_at: daysAgo(40),
                    scanner: 'old',
                },
            });
            const skipped = addFile('SKIP.ZIP', 'SKIP me');

            const summary = await run();
            assert.equal(summary.counts.clean, 1);
            assert.equal(summary.counts.skipped, 1);
            assert.equal(summary.errors, 0);

            assert.deepEqual(meta(clean, 'scan_result'), ['clean']);
            assert.deepEqual(meta(clean, 'scan_signature'), [], 'old signature dropped');
            assert.deepEqual(meta(clean, 'scanner'), [scannerName]);
            assert.equal(meta(clean, 'scanned_at').length, 1, 'one scanned_at row');
            assert.ok(Date.now() - Date.parse(meta(clean, 'scanned_at')[0]) < 60000);
            assert.equal(meta(clean, 'rescan_attempted_at').length, 1);
            assert.deepEqual(meta(skipped, 'scan_result'), ['skipped']);
            assert.equal(notices.length, 0, 'nothing to tell the operators');
        });

        it('does not let skipped overturn an earlier clean', async () => {
            const at = daysAgo(40);
            const id = addFile('SKIP.ZIP', 'SKIP me', {
                meta: { scan_result: 'clean', scanned_at: at, scanner: 'upload_av' },
            });
            const summary = await run();
            assert.equal(summary.counts.skipped, 1);
            assert.equal(summary.files[0].keptResult, 'clean');
            assert.deepEqual(meta(id, 'scan_result'), ['clean']);
            assert.deepEqual(meta(id, 'scanned_at'), [at]);
            assert.deepEqual(meta(id, 'scanner'), [scannerName]);
            assert.equal(meta(id, 'rescan_attempted_at').length, 1);
        });

        it('keeps reporting an infected entry that the scanners now skip', async () => {
            const id = addFile('SKIP.EXE', 'SKIP me', {
                meta: { scan_result: 'infected', scan_signature: 'Old-Sig' },
            });
            const summary = await run();
            assert.equal(summary.stillInfected, 1);
            assert.deepEqual(meta(id, 'scan_result'), ['infected']);
            assert.deepEqual(meta(id, 'scan_signature'), ['Old-Sig']);
            assert.equal(notices.length, 1);
            assert.match(notices[0].body, /still marked infected: Old-Sig/);
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
        });

        it('reports an infected file, records it, and moves or removes nothing', async () => {
            const bad = addFile('EVIL.EXE', 'X5O EICAR test', {
                meta: { dl_count: '3' },
            });
            const good = addFile('GOOD.ZIP', 'clean');

            const summary = await run();
            assert.equal(summary.counts.infected, 1);
            assert.equal(summary.errors, 0);

            assert.equal(entryExists(bad), true);
            assert.equal(entryExists(good), true);
            assert.deepEqual(ls(storageDir()), ['EVIL.EXE', 'GOOD.ZIP']);
            assert.deepEqual(ls(quarantineDir()), [], 'nothing quarantined');
            assert.deepEqual(meta(bad, 'scan_result'), ['infected']);
            assert.deepEqual(meta(bad, 'scan_signature'), ['Stub-Found-It']);
            assert.deepEqual(meta(bad, 'scanner'), [scannerName]);
            assert.deepEqual(meta(bad, 'dl_count'), ['3']);

            assert.equal(notices.length, 1);
            assert.match(notices[0].subject, /1 file to check, 1 infected/);
            const body = notices[0].body;
            assert.match(body, /File:\s+EVIL\.EXE/);
            assert.match(body, new RegExp(`File ID:\\s+${bad}\\r\\n`));
            assert.match(body, /Area:\s+uploads/);
            assert.match(body, /Result:\s+infected: Stub-Found-It/);
            assert.match(
                body,
                new RegExp(`Remove:\\s+\\./oputil\\.js fb rm ${bad} --phys-file`)
            );
            assert.match(body, /nothing was moved or removed/);
        });

        it('reports an infected file again on the next run', async () => {
            addFile('EVIL.EXE', 'EICAR');
            await run();
            await run();
            assert.equal(notices.length, 2);
            notices.forEach(n => assert.match(n.body, /EVIL\.EXE/));
        });

        it('leaves a held file alone apart from the attempt time', async () => {
            const at = daysAgo(40);
            const held = addFile('MAYBE.ZIP', 'FAIL', {
                meta: { scan_result: 'clean', scanned_at: at, scanner: 'old' },
            });

            const summary = await run();
            assert.equal(summary.counts.held, 1);
            assert.deepEqual(meta(held, 'scanned_at'), [at], 'scanned_at not touched');
            assert.deepEqual(meta(held, 'scan_result'), ['clean']);
            assert.deepEqual(meta(held, 'scanner'), ['old']);
            assert.equal(meta(held, 'rescan_attempted_at').length, 1);
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
            assert.match(notices[0].body, /MISSING/);
        });

        it('does not scan an entry whose storage tag is no longer configured', async () => {
            fs.writeFileSync(paths.join(prefix(), 'ORPHAN.ZIP'), 'EICAR');
            addFile('ORPHAN.ZIP', null, { storageTag: 'gone_tag' });
            const summary = await run();
            assert.equal(summary.counts.error, 1);
            assert.match(summary.files[0].error, /Unknown storage tag/);
            assert.equal(scanState.calls.length, 0);
        });

        it('does not scan something that is not a regular file', async () => {
            fs.mkdirSync(paths.join(storageDir(), 'ADIR.ZIP'));
            addFile('ADIR.ZIP', null);
            const summary = await run();
            assert.equal(summary.counts.error, 1);
            assert.match(summary.files[0].error, /Not a regular file/);
            assert.equal(scanState.calls.length, 0);
        });

        it('does not hang on a FIFO', async function () {
            if ('win32' === process.platform) {
                this.skip();
            }
            const fifo = paths.join(storageDir(), 'PIPE.ZIP');
            require('child_process').execFileSync('mkfifo', [fifo]);
            addFile('PIPE.ZIP', null);
            const summary = await run();
            assert.equal(summary.counts.error, 1);
            assert.equal(scanState.calls.length, 0);
        });

        it('finds files in a recursive storage tag by their relative path', async () => {
            addFile('EVIL.COM', 'EICAR', {
                storageTag: 'tree',
                areaTag: 'tree',
                relPath: 'games/dos',
            });
            const summary = await run({ areaTags: ['tree'] });
            assert.equal(summary.counts.infected, 1);
            assert.equal(
                scanState.calls[0].filePath,
                paths.join(prefix(), 'tree', 'games', 'dos', 'EVIL.COM')
            );
        });

        it('sends ONE notice for a run, counting each file once', async () => {
            addFile('A.EXE', 'EICAR');
            addFile('B.EXE', 'EICAR');
            addFile('C.ZIP', 'FAIL');
            addFile('D.ZIP', null);
            addFile('E.ZIP', 'clean');

            //  infected AND an error recording it: still one file
            const FileEntry = require('../core/file_entry.js');
            const prev = FileEntry.replaceMetaValues;
            FileEntry.replaceMetaValues = (id, values, cb) =>
                'infected' === values.scan_result
                    ? cb(new Error('db locked'))
                    : prev(id, values, cb);
            let summary;
            try {
                summary = await run();
            } finally {
                FileEntry.replaceMetaValues = prev;
            }
            assert.equal(notices.length, 1);
            assert.equal(summary.counts.infected, 2);
            assert.equal(summary.errors, 2);
            assert.match(notices[0].subject, /4 files to check, 2 infected/);
            notices[0].body
                .split('\r\n')
                .forEach(line => assert.ok(line.length <= 79, line));
        });
    });

    describe('paths (security review)', () => {
        it('PoC A: never reads a file through a symlinked subdirectory', async () => {
            fs.mkdirSync(outside());
            fs.writeFileSync(
                paths.join(outside(), 'precious.exe'),
                'EICAR operator file'
            );
            fs.symlinkSync(outside(), paths.join(storageDir(), 'sub'));
            const id = insertRaw('precious.exe', 'sub');

            const summary = await run();
            assert.equal(summary.counts.error, 1);
            assert.match(summary.files[0].error, /symbolic link/);
            assert.equal(scanState.calls.length, 0, 'not scanned');
            assert.deepEqual(ls(outside()), ['precious.exe']);
            assert.equal(entryExists(id), true);
        });

        it('never reads a file that is itself a symbolic link', async () => {
            fs.mkdirSync(outside());
            fs.writeFileSync(paths.join(outside(), 'x.exe'), 'EICAR');
            fs.symlinkSync(
                paths.join(outside(), 'x.exe'),
                paths.join(storageDir(), 'LINK.EXE')
            );
            addFile('LINK.EXE', null);
            const summary = await run();
            assert.equal(summary.counts.error, 1);
            assert.match(summary.files[0].error, /symbolic link/);
            assert.equal(scanState.calls.length, 0);
        });

        it('allows a storage directory that is itself a link', async () => {
            const real = paths.join(dir, 'realstore');
            fs.mkdirSync(real);
            fs.writeFileSync(paths.join(real, 'OK.ZIP'), 'clean');
            fs.symlinkSync(real, paths.join(prefix(), 'linked'));
            config.fileBase.storageTags.linked = 'linked';
            addFile('OK.ZIP', null, { storageTag: 'linked' });
            const summary = await run();
            assert.equal(summary.counts.clean, 1);
        });

        it('PoC A3: crafted names and rel paths are errors, never scanned', async () => {
            [
                ['../../x', null],
                ['x', '../..'],
                ['x', '/etc'],
                ['/etc/passwd', null],
                ['', null],
                ['..', 'a'],
                ['.', null],
            ].forEach(([fn, rp]) => insertRaw(fn, rp));
            const summary = await run({ dryRun: true });
            assert.equal(scanState.calls.length, 0);
            summary.files.forEach(f =>
                assert.ok(['error', 'missing'].includes(f.result), JSON.stringify(f))
            );
        });

        it('PoC B: a directory swapped for a link during the scan records nothing', async () => {
            fs.mkdirSync(outside());
            fs.writeFileSync(paths.join(outside(), 'X.EXE'), 'clean outside');
            const id = addFile('X.EXE', 'EICAR', { relPath: 'sub' });
            scanState.onScan = () => {
                fs.renameSync(
                    paths.join(storageDir(), 'sub'),
                    paths.join(dir, 'moved_away')
                );
                fs.symlinkSync(outside(), paths.join(storageDir(), 'sub'));
            };
            const summary = await run();
            assert.equal(summary.counts.error, 1);
            assert.match(
                summary.files[0].error,
                /changed or moved while it was being scanned/
            );
            assert.deepEqual(meta(id, 'scan_result'), []);
        });

        it('PoC B2: the file swapped for a link during the scan records nothing', async () => {
            fs.mkdirSync(outside());
            fs.writeFileSync(paths.join(outside(), 'target.txt'), 'outside clean data');
            const id = addFile('Y.EXE', 'clean inside');
            scanState.onScan = () => {
                fs.unlinkSync(paths.join(storageDir(), 'Y.EXE'));
                fs.symlinkSync(
                    paths.join(outside(), 'target.txt'),
                    paths.join(storageDir(), 'Y.EXE')
                );
            };
            const summary = await run();
            assert.equal(summary.counts.error, 1);
            assert.deepEqual(meta(id, 'scan_result'), []);
        });
    });

    describe('notice text (security review)', () => {
        it('keeps hostile names, areas and signatures on their own line, without codes', () => {
            const names = [
                'EVIL.ZIP\r\nResult:  clean\r\nAction:  none',
                'A|00|08HIDDEN',
                'X\x1b[2J\x1b[8mHIDE',
                'Y Result: clean\u0085Z',
                '@X0FPCB@',
                `${'N'.repeat(60)} Remove:   nothing`,
                '\t\t\tFile:    FAKE.ZIP',
            ];
            const files = names.map((n, i) => ({
                fileId: i + 1,
                fileName: n,
                areaTag: 'a|04b',
                result: 'infected',
                sha256: 'ab',
                verdict: {
                    scanner: 'clam|00',
                    signature: `Sig\r\nRemove: rm -rf / ${'x'.repeat(100)}`,
                },
            }));
            const summary = {
                dryRun: false,
                checked: 7,
                matched: 7,
                unmatched: 0,
                remaining: 0,
                counts: {
                    clean: 0,
                    skipped: 0,
                    not_scanned: 0,
                    infected: 7,
                    held: 0,
                    missing: 0,
                    error: 0,
                },
                stillInfected: 0,
                errors: 0,
                hashChanged: 0,
                files,
            };
            const { subject, body } = Rescan.buildRescanNotice(summary, {
                ranBy: 'x\r\ny|00',
            });
            assert.match(subject, /7 files to check, 7 infected/);
            const lines = body.split('\r\n');
            lines.forEach(line => {
                assert.ok(line.length <= 79, line);
                assert.doesNotMatch(line, /\|\d\d/, line);
                // eslint-disable-next-line no-control-regex
                assert.doesNotMatch(line, /[\x00-\x1f\x7f-\x9f]/, JSON.stringify(line));
            });
            //  the only Remove: lines are ours, one per file
            const removes = lines.filter(l => /^Remove:/.test(l));
            assert.equal(removes.length, 7);
            removes.forEach(l =>
                assert.match(l, /^Remove:\s+\.\/oputil\.js fb rm \d+ --phys-file$/)
            );
            assert.equal(lines.filter(l => /^File:/.test(l)).length, 7);
        });
    });

    describe('dry run', () => {
        it('scans and reports but records nothing and sends no notice', async () => {
            const at = daysAgo(40);
            const bad = addFile('EVIL.EXE', 'EICAR');
            const good = addFile('GOOD.ZIP', 'clean', {
                meta: { scan_result: 'clean', scanned_at: at },
            });
            addFile('MAYBE.ZIP', 'FAIL');

            const summary = await run({ dryRun: true });
            assert.equal(summary.counts.infected, 1);
            assert.equal(summary.counts.clean, 1);
            assert.equal(summary.counts.held, 1);
            assert.deepEqual(meta(good, 'scanned_at'), [at]);
            assert.deepEqual(meta(bad, 'scan_result'), []);
            assert.deepEqual(meta(bad, 'rescan_attempted_at'), []);
            assert.equal(notices.length, 0);
            assert.match(Rescan.formatSummary(summary), /^DRY RUN, nothing recorded\./);
        });
    });

    describe('selection and order', () => {
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

        it('maxFiles: never attempted first, then the oldest attempt', async () => {
            const mid = addFile('MID.ZIP', 'a', { meta: { scanned_at: daysAgo(10) } });
            const oldest = addFile('OLDEST.ZIP', 'b', {
                meta: { scanned_at: daysAgo(50), rescan_attempted_at: daysAgo(3) },
            });
            const never = addFile('NEVER.ZIP', 'c');
            addFile('NEWEST.ZIP', 'd', { meta: { scanned_at: daysAgo(1) } });

            const summary = await run({ maxFiles: 3 });
            assert.equal(summary.matched, 4);
            assert.equal(summary.remaining, 1);
            assert.deepEqual(
                summary.files.map(f => f.fileId),
                [never, mid, oldest]
            );
        });

        it('PoC C2: missing and held entries do not pin a capped run', async () => {
            addFile('GONE0.ZIP', null);
            addFile('GONE1.ZIP', null);
            addFile('FAIL.ZIP', 'FAIL');
            const evil = addFile('EVIL.ZIP', 'EICAR');
            const good = addFile('GOOD.ZIP', 'clean');

            const seen = new Set();
            for (let r = 0; r < 3; ++r) {
                const s = await run({ maxFiles: 2 });
                s.files.forEach(f => seen.add(f.fileId));
            }
            assert.ok(seen.has(evil), 'the infected file was reached');
            assert.ok(seen.has(good));
            assert.deepEqual(meta(evil, 'scan_result'), ['infected']);
        });

        it('PoC C: files no scanner covers are left out before the cap, and counted', async () => {
            config.fileBase.scanning.scanners = [
                { scanner: scannerName, fileTypes: ['zip'] },
            ];
            for (let i = 0; i < 3; ++i) {
                addFile(`README${i}.TXT`, 'text');
            }
            const z1 = addFile('LATER1.ZIP', 'EICAR inside');
            const z2 = addFile('LATER2.ZIP', 'clean');

            const summary = await run({ maxFiles: 3 });
            assert.equal(summary.unmatched, 3);
            assert.equal(summary.matched, 2);
            assert.deepEqual(summary.files.map(f => f.fileId).sort(), [z1, z2].sort());
            assert.match(
                Rescan.formatSummary(summary),
                /3 left out: no scanner entry scans their type/
            );
        });

        it('warns when nothing was actually scanned', async () => {
            addFile('GONE.ZIP', null);
            const summary = await run();
            assert.equal(summary.warning, 'No file was actually scanned this run');
            assert.match(
                Rescan.formatSummary(summary),
                /Warning: No file was actually scanned/
            );
        });

        it('areaTags: wildcards, and never the internal areas', async () => {
            config.fileBase.areas.system_temporary_download = {
                name: 'Temp',
                storageTags: ['uploads_main'],
            };
            addFile('A.ZIP', 'a', { areaTag: 'retro_dos' });
            addFile('B.ZIP', 'b', { areaTag: 'uploads' });
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

        it('an explicitly empty selection is nothing, never every area', async () => {
            addFile('A.ZIP', 'a');
            for (const sel of [
                { fileIds: [] },
                { areaTags: [] },
                { areaTags: [], fileIds: [] },
            ]) {
                const summary = await run(sel);
                assert.equal(summary.checked, 0, JSON.stringify(sel));
                assert.equal(summary.warning, 'Nothing was selected');
            }
            assert.equal(scanState.calls.length, 0);
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

    describe('robustness', () => {
        it('never runs more than one scan at a time', async () => {
            scanState.delayMs = 15;
            for (let i = 0; i < 6; ++i) {
                addFile(`F${i}.ZIP`, `clean ${i}`);
            }
            const summary = await run();
            assert.equal(summary.counts.clean, 6);
            assert.equal(scanState.maxActive, 1);
        });

        it('stops after several files in a row could not be checked', async () => {
            for (let i = 0; i < 8; ++i) {
                addFile(`F${i}.ZIP`, 'FAIL');
            }
            const summary = await run({ stopAfterHeld: 3 });
            assert.equal(summary.checked, 3);
            assert.equal(summary.remaining, 5);
            assert.match(
                summary.stoppedEarly,
                /scanner appears to be down: 3 files in a row/
            );
            assert.match(notices[0].body, /run stopped after 3 files/);
        });

        it('reports an entry it cannot load as an error, and frees the run', async () => {
            addFile('A.ZIP', 'a');
            const FileEntry = require('../core/file_entry.js');
            const prev = FileEntry.loadBasicEntry;
            FileEntry.loadBasicEntry = (id, dest, cb) => cb(new Error('disk I/O error'));
            let summary;
            try {
                summary = await run();
            } finally {
                FileEntry.loadBasicEntry = prev;
            }
            assert.equal(summary.counts.error, 1);
            assert.match(summary.files[0].error, /disk I\/O error/);
            assert.equal(Rescan.isRunning(), false);
        });

        it('frees the run if the progress callback or a step throws', async () => {
            addFile('A.ZIP', 'a');
            const FileEntry = require('../core/file_entry.js');
            const prev = FileEntry.replaceMetaValues;
            FileEntry.replaceMetaValues = () => {
                throw new Error('boom');
            };
            let summary;
            try {
                summary = await run({
                    onFileResult: () => {
                        throw new Error('callback boom');
                    },
                });
            } finally {
                FileEntry.replaceMetaValues = prev;
            }
            assert.equal(summary.counts.error, 1);
            assert.match(summary.files[0].error, /boom/);
            assert.equal(Rescan.isRunning(), false);
            assert.equal((await run()).counts.clean, 1);
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

        it('runs when an entry lists rescan', async () => {
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

        it('is a built-in, manual-only event', () => {
            const ev = configDefault().eventScheduler.events.rescanFileBase;
            assert.equal(
                ev.action,
                '@method:core/file_base_rescan.js:rescanFileBaseScheduledEvent'
            );
            assert.equal(ev.schedule, undefined);
            assert.ok(ev.desc);
        });

        it('parses its args and rejects unknown keys', () => {
            assert.deepEqual(Rescan.parseTaskArgs([]).options, {});
            assert.deepEqual(Rescan.parseTaskArgs(undefined).options, {});
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

        it('succeeds with the summary as its output when all is clean', async () => {
            addFile('A.ZIP', 'a');
            const { err, output } = await task([{ areas: ['uploads'] }]);
            assert.equal(err, null);
            assert.match(output, /Checked 1 of 1 matching file: 1 clean/);
        });

        it('fails, so the WFC flags it, when an infected file is in the base', async () => {
            addFile('EVIL.EXE', 'EICAR');
            const { err, output } = await task([]);
            assert.equal(err.message, '1 infected file in the file base');
            assert.match(output, /1 infected/);
            assert.match(notices[0].body, /scheduled task/);
        });

        it('fails when a file could not be checked, still with the summary', async () => {
            addFile('MAYBE.ZIP', 'FAIL');
            const { err, output } = await task([]);
            assert.equal(err.message, '1 file could not be checked');
            assert.match(output, /1 could not be checked/);
        });

        it('fails cleanly without running on bad args or when scanning is not set up', async () => {
            addFile('A.ZIP', 'a');
            let res = await task([{ nope: 1 }]);
            assert.match(res.err.message, /Unknown argument/);
            config.fileBase.scanning.enabled = false;
            res = await task([]);
            assert.match(res.err.message, /disabled/);
            delete config.fileBase.scanning;
            res = await task(undefined);
            assert.match(res.err.message, /disabled/);
            assert.equal(scanState.calls.length, 0);
        });
    });
});
