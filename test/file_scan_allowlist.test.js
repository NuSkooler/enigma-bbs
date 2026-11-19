'use strict';

//
//  The file scanning allowlist (#291, PR 4): core/file_scan_allowlist.js, and
//  the check core/file_scanner.js makes before any scanner runs.
//
//  The file database is an in-memory one; file_entry.js captures it at load,
//  so it is required fresh here (markEntriesSafe() uses it) and put back
//  afterwards. The scanner is a stub registered under a unique name that
//  calls anything containing "EICAR" infected.
//

const { strict: assert } = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const paths = require('path');
const Database = require('better-sqlite3');

const configModule = require('../core/config.js');
const configDefault = require('../core/config_default.js');
const dbModule = require('../core/database.js');

const FRESH = ['../core/file_entry.js'];

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');

describe('file scanning allowlist (#291)', function () {
    let Allowlist;
    let FileScanner;
    let fileDb;
    let prevFileDb;
    let prevConfig;
    let config;
    let dir;
    let scannerName;
    let scanCalls;
    let nameSeq = 0;
    const savedModules = {};

    before(() => {
        config = configDefault();
        prevConfig = configModule._pushTestConfig(config);

        Allowlist = require('../core/file_scan_allowlist.js');
        FileScanner = require('../core/file_scanner.js');

        prevFileDb = dbModule.dbs.file;
        fileDb = new Database(':memory:');
        fileDb.exec(`
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
            ${Allowlist.AllowlistTableSql}
        `);
        dbModule.dbs.file = fileDb;

        FRESH.forEach(m => {
            const key = require.resolve(m);
            savedModules[key] = require.cache[key];
            delete require.cache[key];
        });
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
            'DELETE FROM file_scan_allowlist; DELETE FROM file_meta; DELETE FROM file;'
        );
        dir = fs.realpathSync(fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-allow-')));
        config.fileBase.areaStoragePrefix = dir;

        scanCalls = [];
        scannerName = `allow_stub_${process.pid}_${++nameSeq}`;
        FileScanner.registerScanner(scannerName, {
            scan(filePath, ctx, cb) {
                scanCalls.push({ filePath, ctx });
                const data = fs.readFileSync(filePath, 'latin1');
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
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const add = entry =>
        new Promise((resolve, reject) =>
            Allowlist.add(entry, (err, res) => (err ? reject(err) : resolve(res)))
        );
    const list = () =>
        new Promise((resolve, reject) =>
            Allowlist.list((err, rows) => (err ? reject(err) : resolve(rows)))
        );
    const remove = (sha, by) =>
        new Promise((resolve, reject) =>
            Allowlist.remove(sha, by, (err, res) => (err ? reject(err) : resolve(res)))
        );
    const addErr = entry =>
        new Promise(resolve => Allowlist.add(entry, err => resolve(err)));

    describe('API', () => {
        const H = 'A'.repeat(64);

        it('accepts exactly 64 hex digits, in either case', () => {
            assert.ok(Allowlist.isValidSha256('ab'.repeat(32)));
            assert.ok(Allowlist.isValidSha256(H));
            assert.equal(Allowlist.normalizeSha256(H), 'a'.repeat(64));
            for (const bad of [
                '',
                'a'.repeat(63),
                'a'.repeat(65),
                'g'.repeat(64),
                ` ${'a'.repeat(63)}`,
                `${'a'.repeat(64)}\n`,
                null,
                undefined,
                64,
                ['a'.repeat(64)],
            ]) {
                assert.ok(!Allowlist.isValidSha256(bad), `"${bad}" is not a SHA-256`);
                assert.equal(Allowlist.normalizeSha256(bad), null);
            }
        });

        it('refuses a bad hash or a missing "added by"', async () => {
            assert.ok(await addErr({ sha256: 'nope', addedBy: 'op' }));
            assert.ok(await addErr({ sha256: H }));
            assert.ok(await addErr({ sha256: H, addedBy: '\u0007 ' }));
            assert.deepEqual(await list(), []);
        });

        it('adds, lists, looks up and removes, keyed by the lowercase hash', async () => {
            const res = await add({
                sha256: H,
                addedBy: 'oputil:bryan',
                note: 'false positive\u001b[2J  in a demo',
                originalName: 'DEMO.EXE',
                signature: 'PUA.Win.Packer',
            });
            assert.equal(res.added, true);
            assert.equal(res.entry.sha256, 'a'.repeat(64));
            assert.equal(res.entry.addedBy, 'oputil:bryan');
            assert.equal(
                res.entry.note,
                'false positive [2J  in a demo',
                'no control bytes'
            );
            assert.ok(!Number.isNaN(Date.parse(res.entry.addedAt)));

            assert.equal(Allowlist.lookup(H.toLowerCase()).originalName, 'DEMO.EXE');
            assert.equal(Allowlist.lookup(H).signature, 'PUA.Win.Packer');
            assert.equal(Allowlist.lookup('b'.repeat(64)), null);
            assert.equal(Allowlist.lookup('not a hash'), null);

            const rows = await list();
            assert.equal(rows.length, 1);

            const removed = await remove(H.toLowerCase(), 'oputil:bryan');
            assert.equal(removed.sha256, 'a'.repeat(64));
            assert.equal(await remove(H, 'oputil:bryan'), null, 'already gone');
            assert.deepEqual(await list(), []);
        });

        it('leaves an existing entry as it was when added again', async () => {
            await add({ sha256: H, addedBy: 'first', note: 'one' });
            const again = await add({
                sha256: H.toLowerCase(),
                addedBy: 'second',
                note: 'two',
            });
            assert.equal(again.added, false);
            assert.equal(again.entry.addedBy, 'first');
            assert.equal(again.entry.note, 'one');
        });

        it('caps what it stores', async () => {
            const res = await add({
                sha256: H,
                addedBy: 'x'.repeat(500),
                note: 'n'.repeat(5000),
                originalName: 'f'.repeat(5000),
                signature: 's'.repeat(5000),
            });
            assert.equal(res.entry.addedBy.length, 64);
            assert.equal(res.entry.note.length, 256);
            assert.equal(res.entry.originalName.length, 255);
            assert.equal(res.entry.signature.length, 128);
        });

        it('lookup throws when the table is not there; get() calls back the error', done => {
            const prev = dbModule.dbs.file;
            dbModule.dbs.file = new Database(':memory:');
            try {
                assert.throws(() => Allowlist.lookup(H));
                Allowlist.get(H, err => {
                    dbModule.dbs.file.close();
                    dbModule.dbs.file = prev;
                    assert.ok(err);
                    done();
                });
            } catch (e) {
                dbModule.dbs.file = prev;
                throw e;
            }
        });

        it('markEntriesSafe() clears infected entries with that hash, and only those', done => {
            const h = 'c'.repeat(64);
            const insert = fileDb.prepare(
                `INSERT INTO file (area_tag, file_sha256, file_name, storage_tag, upload_timestamp)
                VALUES ('uploads', ?, ?, 'uploads_main', '2026-01-01');`
            );
            const meta = fileDb.prepare(
                'INSERT INTO file_meta (file_id, meta_name, meta_value) VALUES (?, ?, ?)'
            );
            const a = insert.run(h, 'A.EXE').lastInsertRowid;
            const b = insert.run(h, 'B.EXE').lastInsertRowid;
            const c = insert.run(h, 'C.EXE').lastInsertRowid;
            const other = insert.run('d'.repeat(64), 'D.EXE').lastInsertRowid;
            [a, b, other].forEach(id => {
                meta.run(id, 'scan_result', 'infected');
                meta.run(id, 'scan_signature', 'Eicar');
                meta.run(id, 'scanner', 'clamav');
            });
            meta.run(c, 'scan_result', 'skipped');

            Allowlist.markEntriesSafe(h.toUpperCase(), (err, changed) => {
                assert.ifError(err);
                assert.deepEqual(changed, [a, b]);

                const metaOf = id =>
                    Object.fromEntries(
                        fileDb
                            .prepare(
                                'SELECT meta_name, meta_value FROM file_meta WHERE file_id = ?'
                            )
                            .all(id)
                            .map(r => [r.meta_name, r.meta_value])
                    );
                assert.deepEqual(metaOf(a), {
                    scan_result: 'clean',
                    scanner: 'allowlist',
                });
                assert.deepEqual(metaOf(b), {
                    scan_result: 'clean',
                    scanner: 'allowlist',
                });
                assert.deepEqual(metaOf(c), { scan_result: 'skipped' }, 'not infected');
                assert.equal(metaOf(other).scan_result, 'infected', 'another hash');
                done();
            });
        });
    });

    // ── the check in file_scanner.scanFile() ─────────────────────────────────

    describe('before any scanner runs', () => {
        const EICAR = 'X5O!P%@AP EICAR test';

        const write = (name, content) => {
            const p = paths.join(dir, name);
            fs.writeFileSync(p, content);
            return p;
        };

        const scan = (filePath, ctx) =>
            new Promise(resolve =>
                FileScanner.scanFile(filePath, ctx, (err, verdict) =>
                    resolve({ err, verdict })
                )
            );

        for (const source of ['upload', 'web', 'tic', 'oputil', 'rescan']) {
            it(`passes an allowlisted file as clean without scanning (${source})`, async () => {
                const p = write('EVIL.EXE', EICAR);
                await add({ sha256: sha256(EICAR), addedBy: 'test' });

                //  as callers do: some hand over the hash, some do not
                const ctx = { source };
                if ('rescan' === source || 'upload' === source) {
                    ctx.sha256 = sha256(EICAR);
                }
                const { err, verdict } = await scan(p, ctx);

                assert.ifError(err);
                assert.equal(verdict.result, 'clean');
                assert.equal(verdict.rejected, false);
                assert.equal(verdict.scanner, 'allowlist');
                assert.equal(verdict.detail, 'allowlisted');
                assert.equal(verdict.allowlisted, true);
                assert.deepEqual(
                    verdict.results.map(r => [r.result, r.scanner, r.detail]),
                    [['clean', 'allowlist', 'allowlisted']]
                );
                assert.equal(scanCalls.length, 0, 'no scanner ran');
            });
        }

        it('scans as usual when the hash is not listed', async () => {
            const p = write('EVIL.EXE', EICAR);
            await add({ sha256: sha256('something else'), addedBy: 'test' });
            const { err, verdict } = await scan(p, { source: 'upload' });
            assert.ok(FileScanner.isFileRejected(err));
            assert.equal(verdict.result, 'infected');
            assert.equal(scanCalls.length, 1);
        });

        it('never takes a caller-given hash on trust', async () => {
            //  the hash of other bytes, which are listed, handed over with
            //  this file: it is hashed again, does not match, and is scanned
            const p = write('EVIL.EXE', EICAR);
            const listed = sha256('the harmless file');
            await add({ sha256: listed, addedBy: 'test' });

            const { err, verdict } = await scan(p, { source: 'tic', sha256: listed });
            assert.ok(FileScanner.isFileRejected(err));
            assert.equal(verdict.result, 'infected');
            assert.equal(scanCalls.length, 1);
            assert.equal(
                scanCalls[0].ctx.sha256,
                sha256(EICAR),
                'scanners get the real hash'
            );
            assert.equal(err.scanContext.sha256, sha256(EICAR), 'and so does a sidecar');
        });

        it('scans as usual when the lookup fails (fails closed)', async () => {
            const p = write('EVIL.EXE', EICAR);
            await add({ sha256: sha256(EICAR), addedBy: 'test' });

            const prev = dbModule.dbs.file;
            dbModule.dbs.file = undefined;
            try {
                const { err, verdict } = await scan(p, { source: 'upload' });
                assert.ok(FileScanner.isFileRejected(err));
                assert.equal(verdict.result, 'infected');
            } finally {
                dbModule.dbs.file = prev;
            }

            fileDb.exec('ALTER TABLE file_scan_allowlist RENAME TO moved_away');
            try {
                const { err } = await scan(p, { source: 'upload' });
                assert.ok(FileScanner.isFileRejected(err));
            } finally {
                fileDb.exec('ALTER TABLE moved_away RENAME TO file_scan_allowlist');
            }
            assert.equal(scanCalls.length, 2);
        });

        it('changes nothing when scanning is disabled or no entry matches', async () => {
            const p = write('EVIL.EXE', EICAR);
            await add({ sha256: sha256(EICAR), addedBy: 'test' });

            config.fileBase.scanning.enabled = false;
            let { verdict } = await scan(p, { source: 'upload' });
            assert.equal(verdict.result, 'not_scanned');

            config.fileBase.scanning.enabled = true;
            config.fileBase.scanning.scanners = [
                { scanner: scannerName, sources: ['tic'] },
            ];
            ({ verdict } = await scan(p, { source: 'upload' }));
            assert.equal(verdict.result, 'not_scanned');
            assert.equal(scanCalls.length, 0);
        });
    });
});
