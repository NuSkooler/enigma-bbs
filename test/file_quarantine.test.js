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
const _ = require('lodash');

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
        //  the real schema: foreign keys, cascades and triggers included
        fileDb = dbModule.createFileDatabase();

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
            DELETE FROM file_meta; DELETE FROM file_hash_tag; DELETE FROM hash_tag;
            DELETE FROM file; DELETE FROM file_scan_allowlist;
        `);
        scannerMode = 'normal';
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
            scanners: [{ scanner: STUB_SCANNER }],
        });
    });

    //
    //  The scanner a release scans with: anything containing "VIRUS" is
    //  infected, the rest clean -- or, in 'down' mode, it fails (held).
    //
    const STUB_SCANNER = `quarantine_stub_${process.pid}`;
    let scannerMode = 'normal';
    let scanned = [];
    before(() => {
        FileScanner.registerScanner(STUB_SCANNER, {
            scan(filePath, ctx, cb) {
                scanned.push({ filePath, ctx });
                if ('down' === scannerMode) {
                    return cb(null, { result: 'error', detail: 'clamd is not running' });
                }
                return cb(
                    null,
                    fs.readFileSync(filePath, 'latin1').includes('VIRUS')
                        ? { result: 'infected', signature: 'Test-Virus' }
                        : { result: 'clean' }
                );
            },
        });
    });
    beforeEach(() => {
        scanned = [];
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

        it('never gives a quarantined file a sidecar name', async () => {
            //  the uploader sends "evil.json" first, forging a sidecar for
            //  the "evil" they send next
            const forged = JSON.stringify({
                quarantineName: 'evil',
                originalName: 'nice.txt',
                areaTag: 'other',
                sha256: sha256('EICAR evil'),
            });
            assert.equal(await quarantine('evil.json', forged), 'evil.jso_');
            assert.equal(await quarantine('EVIL.JSON', forged), 'EVIL.JSO_');
            await quarantine('evil', 'EICAR evil');

            assert.deepEqual(ls(quarantineDir()), [
                'EVIL.JSO_',
                'EVIL.JSO_.json',
                'evil',
                'evil.jso_',
                'evil.jso_.json',
                'evil.json',
            ]);

            const items = await list();
            const evil = items.find(i => 'evil' === i.quarantineName);
            assert.equal(evil.sidecar.originalName, 'evil', 'the real sidecar');
            assert.ok(evil.sidecarPath.endsWith('evil.json'));
            const json = items.find(i => 'evil.jso_' === i.quarantineName);
            assert.equal(json.sidecar.originalName, 'evil.json');
        });

        //  quarantine directories from before .json was defanged
        it("never takes an old quarantined .json file for another file's sidecar", async () => {
            const q = quarantineDir();
            fs.mkdirSync(q, { recursive: true });
            const write = (name, data) =>
                fs.writeFileSync(
                    paths.join(q, name),
                    _.isString(data) ? data : JSON.stringify(data)
                );
            write('evil.json', {
                quarantineName: 'evil',
                originalName: 'nice.txt',
                sha256: sha256('EICAR evil'),
            });
            write('evil.json.json', {
                quarantineName: 'evil.json',
                originalName: 'evil.json',
            });
            write('evil', 'EICAR evil');
            write('evil.1.json', { quarantineName: 'evil', originalName: 'evil' });

            const items = await list();
            const evil = items.find(i => 'evil' === i.quarantineName);
            assert.equal(evil.sidecar.originalName, 'evil');
            assert.ok(evil.sidecarPath.endsWith('evil.1.json'));
            assert.equal(
                items.find(i => 'evil.json' === i.quarantineName).sidecar.originalName,
                'evil.json'
            );
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
            if ('win32' !== process.platform) {
                const mode =
                    fs.statSync(paths.join(storageDir(), 'cool.exe')).mode & 0o777;
                assert.equal(mode, 0o666 & ~process.umask(), 'no longer 0600');
            }
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
            assert.equal(meta.scan_result, 'clean', 'scanned before release');
            assert.equal(meta.scanner, STUB_SCANNER);
            assert.equal(res.verdict.result, 'clean');
            assert.equal(scanned.length, 1);
            assert.equal(
                scanned[0].filePath,
                paths.join(quarantineDir(), 'cool.ex_'),
                'scanned where it lay in quarantine'
            );
            assert.equal(scanned[0].ctx.source, 'oputil');
            assert.equal(scanned[0].ctx.fileName, 'cool.exe');

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

        it('a file the scan still flags stays in quarantine; --allow releases it', async () => {
            await quarantine('real.exe', 'a VIRUS');
            let { err } = await release('real.ex_');
            assert.ok(err && /rejected it/.test(err.message), err && err.message);
            assert.ok(/--allow/.test(err.message));
            assert.deepEqual(ls(quarantineDir()), ['real.ex_', 'real.ex_.json']);
            assert.deepEqual(ls(storageDir()), []);
            assert.equal(entries().length, 0);

            //  the operator says it is a false positive
            let res;
            ({ err, res } = await release('real.ex_', { allow: true }));
            assert.ifError(err);
            assert.equal(res.verdict.result, 'clean');
            assert.equal(res.verdict.scanner, 'allowlist', 'passed by the allowlist');
            const meta = metaOf(entries()[0].file_id);
            assert.equal(meta.scan_result, 'clean');
            assert.equal(meta.scanner, 'allowlist');
        });

        it('a held file stays in quarantine while the scanner is down', async () => {
            await quarantine('held.zip', 'maybe fine');
            scannerMode = 'down';
            let { err } = await release('held.zip');
            assert.ok(err && /could not check it/.test(err.message), err && err.message);
            assert.deepEqual(ls(quarantineDir()), ['held.zip', 'held.zip.json']);
            assert.equal(entries().length, 0);

            scannerMode = 'normal';
            ({ err } = await release('held.zip'));
            assert.ifError(err);
            assert.equal(metaOf(entries()[0].file_id).scan_result, 'clean');
        });

        it('with nothing to scan it, a release is refused unless --no-scan', async () => {
            config.fileBase.scanning.enabled = false;
            await quarantine('a.zip', 'a VIRUS');
            let { err, res } = await release('a.zip');
            assert.ok(err && /--no-scan/.test(err.message), err && err.message);
            assert.equal(entries().length, 0);

            ({ err, res } = await release('a.zip', { noScan: true }));
            assert.ifError(err);
            assert.equal(res.verdict, null);
            assert.equal(scanned.length, 0);
            assert.equal(metaOf(entries()[0].file_id).scan_result, undefined);
        });

        it('--no-scan releases without scanning even a flagged file', async () => {
            await quarantine('a.zip', 'a VIRUS');
            const { err } = await release('a.zip', { noScan: true });
            assert.ifError(err);
            assert.equal(scanned.length, 0);
            assert.equal(entries().length, 1);
        });

        it('--allow on a release that fails takes the hash off the allowlist again', async () => {
            await quarantine('a.zip', 'fine bytes');
            //  the import fails: the area's storage directory is a file
            fs.rmSync(storageDir(), { recursive: true, force: true });
            fs.writeFileSync(storageDir(), 'not a directory');

            const { err } = await release('a.zip', { allow: true });
            assert.ok(err);
            assert.equal(err.allowlistRolledBack, true);
            assert.equal(Allowlist.lookup(sha256('fine bytes')), null);
            assert.deepEqual(ls(quarantineDir()), ['a.zip', 'a.zip.json']);
        });

        it('--allow leaves a hash that was already allowlisted there', async () => {
            await new Promise(r =>
                Allowlist.add({ sha256: sha256('fine bytes'), addedBy: 'earlier' }, r)
            );
            await quarantine('a.zip', 'fine bytes');
            fs.rmSync(storageDir(), { recursive: true, force: true });
            fs.writeFileSync(storageDir(), 'not a directory');

            const { err } = await release('a.zip', { allow: true });
            assert.ok(err);
            assert.equal(err.allowlistRolledBack, undefined);
            assert.equal(Allowlist.lookup(sha256('fine bytes')).addedBy, 'earlier');
        });

        it('a release that fails after the move puts the file back as it was', async () => {
            await quarantine('a.zip', 'fine bytes');
            //  swapped after the scan: the import's own hash will not match
            const FileArea = require('../core/file_base_area.js');
            const realScanFile = FileArea.scanFile;
            FileArea.scanFile = (filePath, options, cb) => {
                fs.writeFileSync(filePath, 'swapped');
                return realScanFile(filePath, options, cb);
            };
            let result;
            try {
                result = await release('a.zip');
            } finally {
                FileArea.scanFile = realScanFile;
            }
            assert.ok(result.err && /changed/.test(result.err.message));
            assert.deepEqual(ls(quarantineDir()), ['a.zip', 'a.zip.json']);
            assert.deepEqual(ls(storageDir()), []);
            if ('win32' !== process.platform) {
                assert.equal(
                    fs.statSync(paths.join(quarantineDir(), 'a.zip')).mode & 0o777,
                    0o600,
                    '0600 again'
                );
            }
        });

        it('a file put back under another name takes its sidecar with it', async () => {
            await quarantine('a.zip', 'fine bytes');
            const FileArea = require('../core/file_base_area.js');
            const realScanFile = FileArea.scanFile;
            FileArea.scanFile = (filePath, options, cb) => {
                //  something takes its quarantine name meanwhile, and the
                //  import fails
                fs.writeFileSync(paths.join(quarantineDir(), 'a.zip'), 'interloper');
                return cb(new Error('import failed'));
            };
            let result;
            try {
                result = await release('a.zip');
            } finally {
                FileArea.scanFile = realScanFile;
            }
            assert.ok(result.err);
            assert.equal(paths.basename(result.err.movedBackTo), 'a(1).zip');
            const items = await list();
            const back = items.find(i => 'a(1).zip' === i.quarantineName);
            assert.ok(back.sidecar, 'its sidecar follows it');
            assert.equal(back.sidecar.quarantineName, 'a(1).zip');
            assert.equal(back.sidecar.sha256, sha256('fine bytes'));
            assert.ok(!ls(quarantineDir()).includes('a.zip.json'), 'the old one is gone');
        });

        it('no invisible format characters from a sidecar reach the entry', async () => {
            const RLO = '\u202e';
            const ZWSP = '\u200b';
            const LSEP = '\u2028';
            const name = await quarantine('x.zip', 'fine bytes', {
                source: 'tic',
                user: { userId: 5, username: `bob${RLO}` },
                entryMeta: { upload_by_username: `bob${ZWSP}` },
            });
            //  edited, as though by hand: what release reads is the sidecar
            const scPath = paths.join(quarantineDir(), `${name}.json`);
            const sc = JSON.parse(fs.readFileSync(scPath, 'utf8'));
            sc.desc = `nice${RLO}exe.txt${LSEP}second line`;
            sc.hashTags = [`demo${ZWSP}`, `${RLO}dos`];
            sc.meta = Object.assign({}, sc.meta, {
                upload_by_username: `bob${RLO}by`,
                tic_desc: `tic${ZWSP}desc`,
                tic_ldesc: `long${LSEP}desc${RLO}`,
                tic_origin: `21:1/1${RLO}00`,
            });
            fs.writeFileSync(scPath, JSON.stringify(sc));

            const { err, res } = await release(name);
            assert.ifError(err);

            const row = entries()[0];
            const meta = metaOf(row.file_id);
            const tags = fileDb
                .prepare(
                    'SELECT hash_tag FROM hash_tag JOIN file_hash_tag USING (hash_tag_id)'
                )
                .all()
                .map(r => r.hash_tag);
            const all = JSON.stringify({ desc: row.desc, meta, tags });
            assert.ok(!/[\u202e\u200b\u2028\u2029]/.test(all), all);
            assert.equal(row.desc, 'nice exe.txt second line');
            assert.equal(meta.upload_by_username, 'bob by');
            assert.equal(meta.tic_ldesc, 'long desc');
            assert.deepEqual(tags.sort(), ['demo', 'dos']);
            assert.ok(res.fileEntry);
        });

        it('refuses invisible format characters in a released name', async () => {
            for (const bad of [
                'evil\u202etxt.exe',
                'zero\u200bwidth.zip',
                'line\u2028sep.zip',
            ]) {
                assert.ok(Quarantine.releaseNameProblem(JSON.parse(`"${bad}"`)), bad);
            }
            assert.equal(Quarantine.releaseNameProblem('plain.zip'), null);
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

        it('an ambiguous file goes with every sidecar that claims it', async () => {
            await quarantine('a.zip', 'EICAR a');
            fs.copyFileSync(
                paths.join(quarantineDir(), 'a.zip.json'),
                paths.join(quarantineDir(), 'a.zip.1.json')
            );
            const { err, res } = await del('a.zip');
            assert.ifError(err);
            assert.equal(res.removed.length, 3);
            assert.deepEqual(ls(quarantineDir()), []);
        });

        it('reports what was already gone rather than deleting it', async () => {
            await quarantine('a.zip', 'EICAR a');
            const gfs = require('graceful-fs');
            const realUnlink = gfs.unlink;
            const target = paths.join(quarantineDir(), 'a.zip');
            //  gone between the listing and the delete
            gfs.unlink = (p, cb) => {
                if (p === target) {
                    fs.unlinkSync(p);
                }
                return realUnlink(p, cb);
            };
            let result;
            try {
                result = await del('a.zip');
            } finally {
                gfs.unlink = realUnlink;
            }
            assert.ifError(result.err);
            assert.deepEqual(result.res.missing, [target]);
            assert.deepEqual(
                result.res.removed.map(p => paths.basename(p)),
                ['a.zip.json']
            );
        });

        it('refuses a name that is not in quarantine', async () => {
            await quarantine('a.exe', 'EICAR a');
            assert.ok((await del('nope')).err);
            assert.ok((await del('../a.ex_')).err);
            assert.deepEqual(ls(quarantineDir()), ['a.ex_', 'a.ex_.json']);
        });
    });
});
