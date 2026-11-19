'use strict';

//
//  The file scanning quarantine (#291, PR 4): what a sidecar keeps, and
//  core/file_quarantine.js listing, releasing and deleting quarantined files.
//
//  Files are put in quarantine the real way, by file_scanner's
//  applyFailAction(). The file database is an in-memory one; the modules
//  that capture it at load are required fresh here and put back afterwards.
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

const FRESH = [
    '../core/file_entry.js',
    '../core/file_base_area.js',
    '../core/archive_util.js',
    '../core/file_quarantine.js',
];

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');

describe('file scanning quarantine (#291)', function () {
    let FileScanner;
    let Allowlist;
    let Quarantine;
    let fileDb;
    let prevFileDb;
    let prevConfig;
    let config;
    let dir;
    const savedModules = {};

    const prefix = () => paths.join(dir, 'filebase');
    const storageDir = () => paths.join(prefix(), 'uploads');
    const otherDir = () => paths.join(prefix(), 'other');
    const quarantineDir = () => paths.join(prefix(), '.quarantine');
    const ls = d => {
        try {
            return fs.readdirSync(d).sort();
        } catch {
            return [];
        }
    };
    const readSidecar = name =>
        JSON.parse(fs.readFileSync(paths.join(quarantineDir(), name), 'utf8'));

    before(done => {
        config = configDefault();
        prevConfig = configModule._pushTestConfig(config);

        FileScanner = require('../core/file_scanner.js');
        Allowlist = require('../core/file_scan_allowlist.js');

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
            ${Allowlist.AllowlistTableSql}
        `);
        dbModule.dbs.file = fileDb;

        FRESH.forEach(m => {
            const key = require.resolve(m);
            savedModules[key] = require.cache[key];
            delete require.cache[key];
        });

        Quarantine = require('../core/file_quarantine.js');
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
        fileDb.exec(`
            DELETE FROM file; DELETE FROM file_meta; DELETE FROM file_hash_tag;
            DELETE FROM hash_tag; DELETE FROM file_scan_allowlist;
        `);
        dir = fs.realpathSync(fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-quar-')));
        fs.mkdirSync(storageDir(), { recursive: true });

        config.fileBase.areaStoragePrefix = prefix();
        config.fileBase.storageTags = {
            uploads_main: 'uploads',
            other_main: 'other',
            temp_dl: 'temp',
        };
        config.fileBase.areas = {
            uploads: { name: 'Uploads', storageTags: ['uploads_main'] },
            other: { name: 'Other', storageTags: ['uploads_main', 'other_main'] },
            nostorage: { name: 'No storage', storageTags: ['missing_tag'] },
            system_temporary_download: { name: 'Temp', storageTags: ['temp_dl'] },
        };
        config.fileBase.scanning = Object.assign({}, configDefault().fileBase.scanning, {
            enabled: true,
            scanners: [],
        });
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const infected = {
        result: 'infected',
        rejected: true,
        scanner: 'clamav',
        signature: 'Eicar-Test-Signature',
        results: [{ result: 'infected', scanner: 'clamav' }],
    };

    //  a file rejected the way callers reject them; resolves to its quarantine name
    function quarantine(fileName, content, ctx = {}) {
        const recv = fs.mkdtempSync(paths.join(dir, 'recv-'));
        const filePath = paths.join(recv, 'temp-name');
        fs.writeFileSync(filePath, content);
        return new Promise((resolve, reject) =>
            FileScanner.applyFailAction(
                filePath,
                infected,
                Object.assign({ source: 'web', fileName, areaTag: 'uploads' }, ctx),
                (err, disposition) =>
                    err ? reject(err) : resolve(paths.basename(disposition.path))
            )
        );
    }

    const release = (name, options) =>
        new Promise(resolve =>
            Quarantine.releaseQuarantined(
                name,
                Object.assign({ operator: 'oputil:test' }, options),
                (err, res) => resolve({ err, res })
            )
        );
    const list = () =>
        new Promise((resolve, reject) =>
            Quarantine.listQuarantine((err, items) =>
                err ? reject(err) : resolve(items)
            )
        );
    const entries = () => fileDb.prepare('SELECT * FROM file ORDER BY file_id').all();
    const metaOf = id =>
        Object.fromEntries(
            fileDb
                .prepare('SELECT meta_name, meta_value FROM file_meta WHERE file_id = ?')
                .all(id)
                .map(r => [r.meta_name, r.meta_value])
        );

    // ── sidecars ─────────────────────────────────────────────────────────────

    describe('sidecar', () => {
        it('keeps upload-time details, bounded and without control characters', async () => {
            const name = await quarantine('cool.exe', 'EICAR', {
                user: { userId: 7, username: 'webby' },
                desc: 'My cool app\u001b[2J\r\nline two',
                hashTags: new Set(['demo', 'x'.repeat(500), 'demo']),
                storageTag: 'uploads_main',
                entryMeta: {
                    upload_by_username: 'webby',
                    upload_by_user_id: 7,
                    byte_size: 5, //  not one it keeps
                    tic_ldesc: 'l'.repeat(20000),
                },
            });
            assert.equal(name, 'cool.ex_');
            const sc = readSidecar('cool.ex_.json');

            assert.equal(sc.desc, 'My cool app [2J\nline two');
            assert.deepEqual(sc.hashTags, ['demo', 'x'.repeat(128)]);
            assert.equal(sc.storageTag, 'uploads_main');
            assert.deepEqual(Object.keys(sc.meta).sort(), [
                'tic_ldesc',
                'upload_by_user_id',
                'upload_by_username',
            ]);
            assert.equal(sc.meta.upload_by_user_id, '7');
            assert.equal(sc.meta.tic_ldesc.length, 8192);
            //  what was there before
            assert.equal(sc.originalName, 'cool.exe');
            assert.equal(sc.sha256, sha256('EICAR'));
            assert.deepEqual(sc.user, { id: 7, name: 'webby' });
        });

        it("keeps a TIC payload's Desc, Ldesc and File", async () => {
            await quarantine('COOLAPP.ZIP', 'EICAR', {
                source: 'tic',
                areaTag: undefined,
                ticInfo: {
                    area: 'FSX_GEN',
                    origin: '21:1/100',
                    from: '21:1/100',
                    ticFileName: 'abc.tic',
                    passthrough: true,
                    shortFileName: 'COOLAPP.ZIP',
                    desc: 'a cool app',
                    ldesc: 'line one\nline two',
                    extra: 'dropped',
                },
            });
            const sc = readSidecar('COOLAPP.ZIP.json');
            assert.deepEqual(sc.ticInfo, {
                passthrough: true,
                area: 'FSX_GEN',
                origin: '21:1/100',
                from: '21:1/100',
                ticFileName: 'abc.tic',
                shortFileName: 'COOLAPP.ZIP',
                desc: 'a cool app',
                ldesc: 'line one\nline two',
            });
        });
    });

    // ── list ─────────────────────────────────────────────────────────────────

    describe('list', () => {
        it('is empty with no quarantine directory', async () => {
            assert.deepEqual(await list(), []);
        });

        it('pairs files with sidecars and tolerates missing, corrupt and orphaned ones', async () => {
            await quarantine('a.exe', 'EICAR a');
            fs.writeFileSync(paths.join(quarantineDir(), 'bare.zip'), 'no sidecar');
            fs.writeFileSync(paths.join(quarantineDir(), 'bad.zip'), 'bad sidecar');
            fs.writeFileSync(paths.join(quarantineDir(), 'bad.zip.json'), '{ not json');
            await quarantine('gone.zip', 'EICAR gone');
            fs.unlinkSync(paths.join(quarantineDir(), 'gone.zip'));

            const items = await list();
            const byName = Object.fromEntries(items.map(i => [i.quarantineName, i]));

            assert.deepEqual(Object.keys(byName).sort(), [
                'a.ex_',
                'bad.zip',
                'bad.zip.json',
                'bare.zip',
                'gone.zip',
            ]);
            assert.equal(byName['a.ex_'].sidecar.originalName, 'a.exe');
            assert.equal(byName['a.ex_'].exists, true);
            assert.equal(byName['a.ex_'].byteSize, 7);
            assert.equal(byName['bare.zip'].sidecar, null);
            assert.equal(byName['bare.zip'].sidecarProblem, 'missing');
            assert.equal(byName['bad.zip'].sidecarProblem, 'missing');
            assert.equal(byName['gone.zip'].exists, false);
            assert.ok(byName['gone.zip'].sidecar);
        });

        it("never takes a quarantined .json file for another file's sidecar", async () => {
            //  the uploader sends "evil.json" first, forging a sidecar for
            //  the "evil" they send next
            const forged = JSON.stringify({
                quarantineName: 'evil',
                originalName: 'nice.txt',
                areaTag: 'other',
                sha256: sha256('EICAR evil'),
            });
            await quarantine('evil.json', forged);
            await quarantine('evil', 'EICAR evil');

            assert.deepEqual(ls(quarantineDir()), [
                'evil',
                'evil.1.json',
                'evil.json',
                'evil.json.json',
            ]);

            const items = await list();
            const evil = items.find(i => 'evil' === i.quarantineName);
            assert.equal(evil.sidecar.originalName, 'evil', 'the real sidecar');
            assert.ok(evil.sidecarPath.endsWith('evil.1.json'));
            const json = items.find(i => 'evil.json' === i.quarantineName);
            assert.ok(json, 'evil.json is listed as a quarantined file');
            assert.equal(json.sidecar.originalName, 'evil.json');
        });
    });

    // ── release ──────────────────────────────────────────────────────────────

    describe('release', () => {
        it("restores the name, imports with the sidecar's details, removes the sidecar", async () => {
            await quarantine('cool.exe', 'EICAR but fine', {
                user: { userId: 7, username: 'webby' },
                desc: 'My cool app',
                hashTags: ['demo'],
                entryMeta: { upload_by_username: 'webby', upload_by_user_id: 7 },
            });

            const { err, res } = await release('cool.ex_');
            assert.ifError(err);

            assert.deepEqual(ls(storageDir()), ['cool.exe']);
            assert.deepEqual(ls(quarantineDir()), [], 'file and sidecar gone');
            assert.equal(res.allowlisted, false);

            const rows = entries();
            assert.equal(rows.length, 1);
            assert.equal(rows[0].file_name, 'cool.exe');
            assert.equal(rows[0].area_tag, 'uploads');
            assert.equal(rows[0].storage_tag, 'uploads_main');
            assert.equal(rows[0].desc, 'My cool app');
            assert.equal(rows[0].file_sha256, sha256('EICAR but fine'));

            const meta = metaOf(rows[0].file_id);
            assert.equal(meta.upload_by_username, 'webby');
            assert.equal(meta.upload_by_user_id, '7');
            assert.equal(meta.quarantine_released_by, 'oputil:test');
            assert.ok(meta.quarantine_released_at);
            assert.equal(meta.scan_result, undefined, 'not scanned, not marked clean');

            const tags = fileDb
                .prepare(
                    'SELECT hash_tag FROM hash_tag JOIN file_hash_tag USING (hash_tag_id)'
                )
                .all()
                .map(r => r.hash_tag);
            assert.deepEqual(tags, ['demo']);
            assert.deepEqual(await new Promise(r => Allowlist.list((e, l) => r(l))), []);
        });

        it('with allow, also allowlists the hash and marks the entry clean', async () => {
            await quarantine('cool.exe', 'EICAR fp');
            const { err, res } = await release('cool.ex_', { allow: true, note: 'fp' });
            assert.ifError(err);
            assert.equal(res.allowlisted, true);
            assert.equal(res.allowlistAdded, true);

            const row = Allowlist.lookup(sha256('EICAR fp'));
            assert.equal(row.addedBy, 'oputil:test');
            assert.equal(row.note, 'fp');
            assert.equal(row.originalName, 'cool.exe');
            assert.equal(row.signature, 'Eicar-Test-Signature');

            const meta = metaOf(entries()[0].file_id);
            assert.equal(meta.scan_result, 'clean');
            assert.equal(meta.scanner, 'allowlist');
        });

        it('releases from a sidecar written before details were kept', async () => {
            await quarantine('old.zip', 'EICAR old', {
                user: { userId: 3, username: 'caller' },
            });
            const sc = readSidecar('old.zip.json');
            ['desc', 'hashTags', 'meta', 'storageTag'].forEach(k => delete sc[k]);
            fs.writeFileSync(
                paths.join(quarantineDir(), 'old.zip.json'),
                JSON.stringify(sc)
            );

            const { err } = await release('old.zip');
            assert.ifError(err);
            const meta = metaOf(entries()[0].file_id);
            assert.equal(meta.upload_by_username, 'caller', 'from the old "user" field');
            assert.equal(meta.upload_by_user_id, '3');
        });

        it('needs an area for a passthrough TIC, and keeps its TIC details', async () => {
            await quarantine('COOLAPP.ZIP', 'EICAR tic', {
                source: 'tic',
                areaTag: undefined,
                ticInfo: {
                    area: 'FSX_GEN',
                    origin: '21:1/100',
                    passthrough: true,
                    shortFileName: 'coolapp.zip',
                    desc: 'a cool app',
                    ldesc: 'the long\ndescription',
                },
            });

            let { err } = await release('COOLAPP.ZIP');
            assert.ok(err && /--area/.test(err.message), err && err.message);

            ({ err } = await release('COOLAPP.ZIP', { areaTag: 'other' }));
            assert.ifError(err);
            const row = entries()[0];
            assert.equal(row.area_tag, 'other');
            assert.equal(row.desc, 'the long\ndescription');
            const meta = metaOf(row.file_id);
            assert.equal(meta.tic_origin, '21:1/100');
            assert.equal(meta.tic_desc, 'a cool app');
            assert.equal(meta.short_file_name, 'COOLAPP.ZIP');
        });

        it("uses the sidecar's storage tag only if the area has it", async () => {
            await quarantine('a.zip', 'EICAR a', {
                storageTag: 'other_main',
                areaTag: 'other',
            });
            let { err } = await release('a.zip');
            assert.ifError(err);
            assert.equal(entries()[0].storage_tag, 'other_main');
            assert.deepEqual(ls(otherDir()), ['a.zip']);

            await quarantine('b.zip', 'EICAR b', { storageTag: 'other_main' });
            ({ err } = await release('b.zip'));
            assert.ifError(err);
            assert.equal(
                entries()[1].storage_tag,
                'uploads_main',
                'uploads has no other_main'
            );
        });

        it('refuses a file whose bytes are not the ones quarantined', async () => {
            await quarantine('a.zip', 'EICAR a');
            fs.writeFileSync(paths.join(quarantineDir(), 'a.zip'), 'swapped');

            const { err } = await release('a.zip');
            assert.ok(err && /not the file that was quarantined/.test(err.message));
            assert.deepEqual(ls(quarantineDir()), ['a.zip', 'a.zip.json'], 'untouched');
            assert.deepEqual(ls(storageDir()), []);
            assert.equal(entries().length, 0);
        });

        it('refuses a sidecar without a valid hash, or no sidecar at all', async () => {
            await quarantine('a.zip', 'EICAR a');
            const sc = readSidecar('a.zip.json');
            sc.sha256 = 'abc';
            fs.writeFileSync(
                paths.join(quarantineDir(), 'a.zip.json'),
                JSON.stringify(sc)
            );
            let { err } = await release('a.zip');
            assert.ok(err && /no valid SHA-256/.test(err.message));

            fs.writeFileSync(paths.join(quarantineDir(), 'bare.zip'), 'x');
            ({ err } = await release('bare.zip'));
            assert.ok(err && /no sidecar/.test(err.message));

            ({ err } = await release('nothing.zip'));
            assert.ok(err && /No quarantined file/.test(err.message));

            ({ err } = await release('../a.zip'));
            assert.ok(err);
        });

        for (const [hostile, quarantined] of [
            ['../x', 'x'],
            ['CON', '_CON'],
            ['nul.txt', '_nul.txt'],
            ['a:b', 'a_b'],
            ['/etc/passwd', 'passwd'],
            ['C:\\evil\\x.zip', 'x.zip'],
            ['trailing.zip.', 'trailing.zip'],
            ['.hidden', '.hidden'],
        ]) {
            it(`refuses the original name ${JSON.stringify(hostile)} unless given --name`, async () => {
                assert.equal(await quarantine(hostile, `EICAR ${hostile}`), quarantined);

                let { err } = await release(quarantined);
                assert.ok(err && /--name/.test(err.message), err && err.message);
                assert.deepEqual(ls(storageDir()), []);
                assert.ok(
                    ls(quarantineDir()).includes(quarantined),
                    'still in quarantine'
                );

                ({ err } = await release(quarantined, { fileName: 'safe.zip' }));
                assert.ifError(err);
                assert.deepEqual(ls(storageDir()), ['safe.zip']);
            });
        }

        it('refuses a bad --name', async () => {
            await quarantine('a.zip', 'EICAR a');
            for (const bad of ['../b.zip', 'sub/b.zip', 'COM1', 'b?.zip', '']) {
                const { err } = await release('a.zip', { fileName: bad });
                assert.ok(err && /--name/.test(err.message), bad);
            }
            assert.equal(entries().length, 0);
        });

        it('refuses an unknown, internal, storage-less or prototype area', async () => {
            for (const areaTag of [
                'nope',
                'system_temporary_download',
                'nostorage',
                '__proto__',
                'constructor',
                'toString',
            ]) {
                await quarantine('a.zip', 'EICAR a', { areaTag });
                const { err } = await release('a.zip');
                assert.ok(err, areaTag);
                fs.rmSync(quarantineDir(), { recursive: true, force: true });
            }
            assert.equal({}.areaTag, undefined, 'nothing written onto Object.prototype');
            assert.equal(entries().length, 0);
        });

        it('never replaces a file already in the storage directory', async () => {
            fs.writeFileSync(paths.join(storageDir(), 'cool.exe'), 'the original');
            await quarantine('cool.exe', 'EICAR cool');

            const { err, res } = await release('cool.ex_');
            assert.ifError(err);
            assert.equal(paths.basename(res.path), 'cool(1).exe');
            assert.equal(
                fs.readFileSync(paths.join(storageDir(), 'cool.exe'), 'utf8'),
                'the original'
            );
            assert.equal(entries()[0].file_name, 'cool(1).exe');
        });

        it('refuses a file the file base already has', async () => {
            fs.writeFileSync(paths.join(storageDir(), 'have.zip'), 'EICAR dupe');
            fileDb
                .prepare(
                    `INSERT INTO file (area_tag, file_sha256, file_name, storage_tag, upload_timestamp)
                    VALUES ('uploads', ?, 'have.zip', 'uploads_main', '2026-01-01')`
                )
                .run(sha256('EICAR dupe'));
            await quarantine('again.zip', 'EICAR dupe');

            const { err } = await release('again.zip', { allow: true });
            assert.ok(err && /already has this file/.test(err.message));
            assert.equal(
                Allowlist.lookup(sha256('EICAR dupe')),
                null,
                'nothing allowlisted'
            );
            assert.deepEqual(ls(quarantineDir()), ['again.zip', 'again.zip.json']);
        });
    });

    // ── delete ───────────────────────────────────────────────────────────────

    describe('delete', () => {
        const del = name =>
            new Promise(resolve =>
                Quarantine.deleteQuarantined(name, 'oputil:test', (err, res) =>
                    resolve({ err, res })
                )
            );

        it('removes the file and its sidecar', async () => {
            await quarantine('a.exe', 'EICAR a');
            await quarantine('b.exe', 'EICAR b');
            const { err, res } = await del('a.ex_');
            assert.ifError(err);
            assert.equal(res.removed.length, 2);
            assert.deepEqual(ls(quarantineDir()), ['b.ex_', 'b.ex_.json']);
        });

        it('removes a sidecar whose file is gone, or a file with no sidecar', async () => {
            await quarantine('a.exe', 'EICAR a');
            fs.unlinkSync(paths.join(quarantineDir(), 'a.ex_'));
            fs.writeFileSync(paths.join(quarantineDir(), 'bare.zip'), 'x');

            assert.ifError((await del('a.ex_')).err);
            assert.ifError((await del('bare.zip')).err);
            assert.deepEqual(ls(quarantineDir()), []);
        });

        it('refuses a name that is not in quarantine', async () => {
            await quarantine('a.exe', 'EICAR a');
            assert.ok((await del('nope')).err);
            assert.ok((await del('../a.ex_')).err);
            assert.deepEqual(ls(quarantineDir()), ['a.ex_', 'a.ex_.json']);
        });
    });
});
