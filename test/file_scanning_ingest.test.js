'use strict';

//
//  File scanning (#291) at the ways a user's file comes in: the telnet/SSH
//  upload module and the REST upload route. TIC import is covered in
//  tic_passthrough.test.js, oputil in oputil_fb_scan.test.js.
//
//  The scanner is a stub registered under a unique name; the operator notice
//  writer is replaced, so no message or user database is needed. The file
//  database is an in-memory one with the tables an entry persists into, and
//  the modules that capture it at load are required fresh here and put back
//  afterwards.
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
    '../core/archive_util.js',
    '../core/rest/routes/files.js',
    '../core/upload.js',
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
        UNIQUE(file_id, meta_name, meta_value)
    );
    CREATE TABLE hash_tag (
        hash_tag_id INTEGER PRIMARY KEY,
        hash_tag    VARCHAR NOT NULL,
        UNIQUE(hash_tag)
    );
    CREATE TABLE file_hash_tag (
        hash_tag_id INTEGER NOT NULL,
        file_id     INTEGER NOT NULL,
        UNIQUE(hash_tag_id, file_id)
    );
`;

const silentLog = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
};

describe('file scanning at upload (#291)', function () {
    let FileScanner;
    let Files;
    let UploadModule;
    let fileDb;
    let prevFileDb;
    let prevConfig;
    let config;
    let dir;
    let notices;
    let prevWriter;
    let scannerName;
    let scanCalls;
    let nameSeq = 0;
    const savedModules = {};

    const storageDir = () => paths.join(dir, 'filebase', 'uploads');
    const quarantineDir = () => paths.join(dir, 'filebase', '.quarantine');
    const ls = d => {
        try {
            return fs.readdirSync(d).sort();
        } catch {
            return [];
        }
    };

    before(done => {
        config = configDefault();
        prevConfig = configModule._pushTestConfig(config);

        prevFileDb = dbModule.dbs.file;
        fileDb = new Database(':memory:');
        fileDb.exec(FILE_DB_SCHEMA);
        fileDb.exec(require('../core/file_scan_allowlist.js').AllowlistTableSql);
        dbModule.dbs.file = fileDb;

        FRESH.forEach(m => {
            const key = require.resolve(m);
            savedModules[key] = require.cache[key];
            delete require.cache[key];
        });

        FileScanner = require('../core/file_scanner.js');
        Files = require('../core/rest/routes/files.js');
        UploadModule = require('../core/upload.js').getModule;

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
        dbModule.dbs.file = prevFileDb;
        fileDb.close();
        configModule._popTestConfig(prevConfig);
    });

    beforeEach(() => {
        fileDb.exec(
            'DELETE FROM file; DELETE FROM file_meta; DELETE FROM file_hash_tag; DELETE FROM file_scan_allowlist;'
        );
        dir = fs.realpathSync(fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-ingest-')));
        fs.mkdirSync(storageDir(), { recursive: true });

        config.fileBase.areaStoragePrefix = paths.join(dir, 'filebase');
        config.fileBase.storageTags = { uploads_main: 'uploads' };
        config.fileBase.areas = {
            uploads: { name: 'Uploads', storageTags: ['uploads_main'] },
        };

        //  "EICAR" anywhere is infected; "BROKEN" makes the scanner fail
        scanCalls = [];
        scannerName = `ingest_stub_${process.pid}_${++nameSeq}`;
        FileScanner.registerScanner(scannerName, {
            scan(filePath, ctx, cb) {
                scanCalls.push({ filePath, ctx });
                const data = fs.readFileSync(filePath, 'utf8');
                if (data.includes('BROKEN')) {
                    return cb(new Error('scanner exploded'));
                }
                return cb(
                    null,
                    data.includes('EICAR')
                        ? { result: 'infected', signature: 'Eicar-Test-Signature' }
                        : { result: 'clean' }
                );
            },
        });
        config.fileBase.scanning = Object.assign({}, configDefault().fileBase.scanning, {
            enabled: true,
            scanners: [{ scanner: scannerName }],
        });

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

    const addToAllowlist = content =>
        new Promise((resolve, reject) =>
            require('../core/file_scan_allowlist.js').add(
                {
                    sha256: require('crypto')
                        .createHash('sha256')
                        .update(content)
                        .digest('hex'),
                    addedBy: 'test',
                },
                err => (err ? reject(err) : resolve())
            )
        );

    // ── REST ─────────────────────────────────────────────────────────────────

    describe('REST upload', () => {
        const user = { userId: 7, username: 'webby' };

        //  what _parseMultipartUpload() leaves: the file under its own name in
        //  a temp directory of its own
        function tempUpload(fileName, content) {
            const tempDir = fs.mkdtempSync(paths.join(dir, 'enig_upload_'));
            const tempPath = paths.join(tempDir, fileName);
            fs.writeFileSync(tempPath, content);
            return { tempDir, tempPath, fileName, size: Buffer.byteLength(content) };
        }

        function store(uploadInfo) {
            const area = require('../core/file_base_area.js').getFileAreaByTag('uploads');
            return new Promise(resolve => {
                Files._storeUpload({ user, area, uploadInfo, log: silentLog }, (err, r) =>
                    resolve(r)
                );
            });
        }

        //  the temp directory is removed in the background
        const waitGone = async p => {
            for (let i = 0; i < 50 && fs.existsSync(p); ++i) {
                await new Promise(r => setTimeout(r, 10));
            }
            return !fs.existsSync(p);
        };

        it('scans the temp file under its real name, then stores it', async () => {
            const up = tempUpload('cool_app.zip', 'a clean file');
            const result = await store(up);

            assert.ok(
                result.fileEntry,
                `expected an entry, got ${JSON.stringify(result)}`
            );
            assert.equal(result.fileEntry.fileName, 'cool_app.zip');
            assert.equal(result.fileEntry.meta.scan_result, 'clean');
            assert.deepEqual(ls(storageDir()), ['cool_app.zip']);

            assert.equal(scanCalls.length, 1);
            assert.equal(scanCalls[0].ctx.source, 'web');
            assert.equal(scanCalls[0].ctx.fileName, 'cool_app.zip');
            assert.equal(scanCalls[0].ctx.user.userId, 7);
            assert.equal(
                scanCalls[0].filePath,
                up.tempPath,
                'scanned where it was received, before storage'
            );

            const row = fileDb.prepare('SELECT file_name FROM file').get();
            assert.equal(row.file_name, 'cool_app.zip');
            assert.ok(await waitGone(up.tempDir));
        });

        it('refuses an infected upload with a 422 and never stores it', async () => {
            const up = tempUpload('evil.exe', 'EICAR');
            const result = await store(up);

            assert.equal(result.status, 422);
            assert.equal(result.detail, 'The file failed the upload check');
            assert.ok(!/eicar/i.test(JSON.stringify(result)), 'no signature to the user');

            assert.deepEqual(ls(storageDir()), [], 'nothing reached storage');
            assert.equal(fileDb.prepare('SELECT COUNT(*) AS n FROM file').get().n, 0);
            assert.deepEqual(ls(quarantineDir()), ['evil.ex_', 'evil.ex_.json']);

            const sidecar = JSON.parse(
                fs.readFileSync(paths.join(quarantineDir(), 'evil.ex_.json'), 'utf8')
            );
            assert.equal(sidecar.source, 'web');
            assert.equal(sidecar.originalName, 'evil.exe');
            assert.deepEqual(sidecar.user, { id: 7, name: 'webby' });

            assert.equal(notices.length, 1);
            assert.ok(notices[0].body.includes('evil.exe'));
            assert.ok(await waitGone(up.tempDir));
        });

        it('keeps the description the uploader typed in the sidecar', async () => {
            const up = tempUpload('evil.zip', 'EICAR');
            up.desc = 'My demo, honest';
            await store(up);
            const sidecar = JSON.parse(
                fs.readFileSync(paths.join(quarantineDir(), 'evil.zip.json'), 'utf8')
            );
            assert.equal(sidecar.desc, 'My demo, honest');
            assert.equal(sidecar.meta.upload_by_username, 'webby');
            assert.equal(sidecar.meta.upload_by_user_id, '7');
            assert.equal(sidecar.storageTag, 'uploads_main');
        });

        it('stores an allowlisted file without running a scanner', async () => {
            const content = 'EICAR, but a known false positive';
            await addToAllowlist(content);
            const result = await store(tempUpload('fp.zip', content));

            assert.ok(result.fileEntry, JSON.stringify(result));
            assert.equal(result.fileEntry.meta.scan_result, 'clean');
            assert.equal(result.fileEntry.meta.scanner, 'allowlist');
            assert.equal(scanCalls.length, 0);
            assert.deepEqual(ls(storageDir()), ['fp.zip']);
        });

        it('says "could not be checked" for a held file', async () => {
            const up = tempUpload('maybe.zip', 'BROKEN');
            const result = await store(up);

            assert.equal(result.status, 422);
            assert.equal(result.detail, 'The file could not be checked');
            assert.deepEqual(ls(quarantineDir()), ['maybe.zip', 'maybe.zip.json']);
            assert.deepEqual(ls(storageDir()), []);
        });

        it('keeps the traversal guard, before anything is scanned', async () => {
            const up = tempUpload('x', 'EICAR');
            up.fileName = '..';
            const result = await store(up);

            assert.equal(result.status, 400);
            assert.equal(scanCalls.length, 0);
            assert.ok(await waitGone(up.tempDir));
        });

        it('renames around a file already in storage rather than replacing it', async () => {
            fs.writeFileSync(paths.join(storageDir(), 'same.txt'), 'older');
            const result = await store(tempUpload('same.txt', 'newer'));

            assert.equal(result.fileEntry.fileName, 'same(1).txt');
            assert.equal(
                fs.readFileSync(paths.join(storageDir(), 'same.txt'), 'utf8'),
                'older'
            );
        });
    });

    // ── telnet / SSH upload module ───────────────────────────────────────────

    describe('upload module', () => {
        let recvDir;
        let steps;
        let out;

        beforeEach(() => {
            recvDir = fs.mkdtempSync(paths.join(dir, 'recv-'));
            steps = [];
            out = '';
        });

        //  just enough of an UploadModule for the scan half
        function fakeUpload(fileNames, menuConfig = {}) {
            const recvFilePaths = fileNames.map(([name, content]) => {
                const p = paths.join(recvDir, name);
                fs.writeFileSync(p, content);
                return p;
            });

            const fake = Object.create(UploadModule.prototype);
            Object.assign(fake, {
                recvFilePaths,
                tempRecvDirectory: recvDir,
                areaInfo: require('../core/file_base_area.js').getFileAreaByTag(
                    'uploads'
                ),
                menuConfig: { config: menuConfig },
                hasProcessingArt: false,
                client: {
                    log: silentLog,
                    user: { userId: 3, username: 'caller' },
                    term: {
                        pipeWrite: s => (out += s),
                        termHeight: 25,
                    },
                },
                prepViewControllerWithArt: (name, formId, opts, cb) =>
                    cb(new Error('no art')),
                pausePrompt: (opts, cb) => cb(null),
            });
            return fake;
        }

        const scanFiles = fake =>
            new Promise((resolve, reject) => {
                const orig = fake.updateScanStepInfoViews.bind(fake);
                fake.updateScanStepInfoViews = stepInfo => {
                    steps.push(stepInfo.step);
                    return orig(stepInfo);
                };
                fake.scanFiles((err, results) => (err ? reject(err) : resolve(results)));
            });

        it('puts a rejected file in its own bucket and carries on with the batch', async () => {
            const fake = fakeUpload([
                ['evil.com', 'EICAR'],
                ['good.txt', 'perfectly fine'],
            ]);
            const results = await scanFiles(fake);

            assert.deepEqual(
                results.newEntries.map(e => e.fileName),
                ['good.txt'],
                'the clean file after the rejected one still goes through'
            );
            assert.equal(results.dupes.length, 0);
            assert.equal(results.rejected.length, 1);
            assert.equal(results.rejected[0].fileName, 'evil.com');
            assert.equal(results.rejected[0].verdict.result, 'infected');
            assert.equal(results.rejected[0].disposition.action, 'quarantine');

            //  out of the receive directory and defanged; the clean one stays
            //  for moveAndPersistUploadsToDatabase()
            assert.deepEqual(ls(recvDir), ['good.txt']);
            assert.deepEqual(ls(quarantineDir()), ['evil.co_', 'evil.co_.json']);

            assert.equal(scanCalls[0].ctx.source, 'upload');
            assert.equal(scanCalls[0].ctx.user.userId, 3);

            assert.equal(notices.length, 1, 'one notice for the session');
            assert.ok(notices[0].body.includes('evil.com'));
            assert.ok(notices[0].body.includes('user caller #3'));

            assert.ok(steps.includes('virus_scan_start'));
            assert.ok(steps.includes('virus_scan_finish'));
            assert.ok(out.includes('Scanning for viruses'));
            assert.ok(out.includes('evil.com failed the upload check'));
        });

        it('lets an allowlisted file through without running a scanner', async () => {
            const content = 'EICAR, allowlisted';
            await addToAllowlist(content);
            const fake = fakeUpload([
                ['fp.com', content],
                ['evil.com', 'EICAR'],
            ]);
            const results = await scanFiles(fake);

            assert.deepEqual(
                results.newEntries.map(e => [
                    e.fileName,
                    e.meta.scan_result,
                    e.meta.scanner,
                ]),
                [['fp.com', 'clean', 'allowlist']]
            );
            assert.equal(results.rejected.length, 1);
            assert.deepEqual(
                scanCalls.map(c => c.ctx.fileName),
                ['evil.com'],
                'only the other file was scanned'
            );
        });

        it('sends one notice for several rejected files', async () => {
            const fake = fakeUpload([
                ['a.zip', 'EICAR'],
                ['b.zip', 'BROKEN'],
            ]);
            const results = await scanFiles(fake);

            assert.equal(results.newEntries.length, 0);
            assert.equal(results.rejected.length, 2);
            assert.equal(notices.length, 1);
            assert.ok(notices[0].subject.includes('2 files'));
            assert.deepEqual(ls(recvDir), []);
        });

        it('deletes a rejected file when failAction is delete', async () => {
            config.fileBase.scanning.failAction = 'delete';
            const fake = fakeUpload([['evil.exe', 'EICAR']]);
            const results = await scanFiles(fake);

            assert.equal(results.rejected[0].disposition.action, 'delete');
            assert.deepEqual(ls(recvDir), []);
            assert.deepEqual(ls(quarantineDir()), []);
        });

        it('shows the uploader a generic reason, not the signature', done => {
            const fake = fakeUpload([]);
            fake.displayRejectedPage(
                [
                    {
                        fileName: 'evil.exe',
                        verdict: {
                            result: 'infected',
                            signature: 'Eicar-Test-Signature',
                        },
                    },
                    { fileName: 'maybe.zip', verdict: { result: 'held' } },
                ],
                err => {
                    assert.ifError(err);
                    assert.ok(out.includes('Upload(s) rejected'));
                    assert.ok(out.includes('evil.exe: failed the upload check'));
                    assert.ok(out.includes('maybe.zip: could not be checked'));
                    assert.ok(!out.includes('Eicar'));
                    done();
                }
            );
        });

        it('lets the theme reword the reason or show the signature', done => {
            const fake = fakeUpload([], {
                rejectedInfoFormat: '{fileName} [{scanResult}] {reason} ({signature})',
                rejectedInfectedReason: 'nope',
            });
            fake.displayRejectedPage(
                [
                    {
                        fileName: 'evil.exe',
                        verdict: {
                            result: 'infected',
                            signature: 'Eicar-Test-Signature',
                        },
                    },
                ],
                () => {
                    assert.ok(
                        out.includes('evil.exe [infected] nope (Eicar-Test-Signature)')
                    );
                    done();
                }
            );
        });

        it('shows no scan steps when scanning is disabled', async () => {
            config.fileBase.scanning.enabled = false;
            const fake = fakeUpload([['evil.exe', 'EICAR']]);
            const results = await scanFiles(fake);

            assert.equal(results.newEntries.length, 1);
            assert.equal(results.rejected.length, 0);
            assert.ok(!steps.some(s => /virus_scan/.test(s)));
            assert.equal(notices.length, 0);
        });
    });
});
