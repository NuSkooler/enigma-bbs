'use strict';

//
//  oputil fb scan --virus-scan (#291): file scanning is opt in for oputil.
//
//  Driven as a real process against a scratch config, like
//  oputil_fb_hatch.test.js. The scanner is the built-in command scanner
//  running a small node script that calls anything containing "EICAR"
//  infected, so no ClamAV is needed.
//

const { strict: assert } = require('assert');
const { spawnSync } = require('child_process');
const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const REPO_ROOT = path.join(__dirname, '..');

//  exit 1 + a clamscan-style FOUND line for an EICAR file, else 0
const SCANNER_SCRIPT = `
const fs = require('fs');
const p = process.argv[2];
if (fs.readFileSync(p, 'latin1').includes('EICAR')) {
    console.log(p + ': Eicar-Test-Signature FOUND');
    process.exit(1);
}
process.exit(0);
`;

describe('oputil fb scan --virus-scan', function () {
    //  Each case spawns node and opens the databases.
    this.timeout(60000);

    let tmpDir;
    let seq = 0;

    before(async () => {
        tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'enigma_fb_vscan_'));
    });

    after(async () => {
        await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    async function makeFixture({
        scanningEnabled = true,
        scanner,
        scanning = {},
        mods,
    } = {}) {
        const root = path.join(tmpDir, `f${seq++}`);
        const storage = path.join(root, 'filebase', 'uploads');
        for (const d of [path.join(root, 'db'), path.join(root, 'logs'), storage]) {
            await fsp.mkdir(d, { recursive: true });
        }

        const scriptPath = path.join(root, 'fake_av.js');
        await fsp.writeFile(scriptPath, SCANNER_SCRIPT);

        const scannerEntry = scanner || {
            scanner: 'command',
            cmd: process.execPath,
            args: [scriptPath, '{filePath}'],
            signatureRegex: '^.*: (.+) FOUND$',
        };

        await fsp.writeFile(
            path.join(root, 'config.hjson'),
            JSON.stringify(
                {
                    general: { boardName: 'Scan Test' },
                    paths: {
                        db: path.join(root, 'db'),
                        logs: path.join(root, 'logs'),
                        mods: path.join(root, 'mods'),
                    },
                    loginServers: {
                        telnet: { enabled: false },
                        ssh: { enabled: false },
                    },
                    fileBase: {
                        areaStoragePrefix: `${path.join(root, 'filebase')}/`,
                        storageTags: { uploads_main: 'uploads' },
                        areas: {
                            uploads: {
                                name: 'Uploads',
                                desc: 'Uploads',
                                storageTags: ['uploads_main'],
                            },
                        },
                        scanning: Object.assign(
                            {
                                enabled: scanningEnabled,
                                notifyUserIds: [1],
                                scanners: [scannerEntry],
                            },
                            scanning
                        ),
                    },
                },
                null,
                4
            )
        );

        await fsp.mkdir(path.join(root, 'mods'));
        for (const [rel, source] of Object.entries(mods || {})) {
            await fsp.mkdir(path.dirname(path.join(root, 'mods', rel)), {
                recursive: true,
            });
            await fsp.writeFile(path.join(root, 'mods', rel), source);
        }

        await fsp.writeFile(path.join(storage, 'EVIL.EXE'), 'X5O!P%@AP EICAR test');
        await fsp.writeFile(path.join(storage, 'GOOD.TXT'), 'a perfectly clean file');

        return { root, storage };
    }

    //  oputil's getConfigPath() concatenates rather than joins.
    //  stdout and stderr both: warnings and quarantine failures go to stderr
    function oputil(root, args, { timeout } = {}) {
        const res = spawnSync(
            process.execPath,
            ['./oputil.js', '-c', `${root}${path.sep}`, ...args],
            { cwd: REPO_ROOT, encoding: 'utf8', timeout, killSignal: 'SIGKILL' }
        );
        return {
            code: res.status,
            signal: res.signal,
            out: `${res.stdout || ''}${res.stderr || ''}`,
        };
    }

    function withDb(root, name, fn) {
        const db = new Database(path.join(root, 'db', `${name}.sqlite3`));
        try {
            return fn(db);
        } finally {
            db.close();
        }
    }

    const importedNames = root =>
        withDb(root, 'file', db =>
            db
                .prepare('SELECT file_name FROM file ORDER BY file_name')
                .all()
                .map(r => r.file_name)
        );

    //  the notice goes to user 1, who must exist; the first run made the db
    function addSysop(root) {
        withDb(root, 'user', db =>
            db.prepare('INSERT INTO user (id, user_name) VALUES (1, ?)').run('sysop')
        );
    }

    const quarantine = root => {
        try {
            return fs.readdirSync(path.join(root, 'filebase', '.quarantine')).sort();
        } catch {
            return [];
        }
    };

    it('does not virus scan without the flag', async () => {
        const { root } = await makeFixture();
        const { code, out } = oputil(root, ['fb', 'scan', 'uploads']);

        assert.equal(code, 0, out);
        assert.deepEqual(importedNames(root), ['EVIL.EXE', 'GOOD.TXT']);
        assert.deepEqual(quarantine(root), []);
    });

    it('reports, skips and quarantines an infected file, and imports the clean one', async () => {
        const { root, storage } = await makeFixture();

        //  creates the databases; nothing to import yet
        await fsp.rename(path.join(storage, 'EVIL.EXE'), path.join(root, 'EVIL.EXE'));
        await fsp.rename(path.join(storage, 'GOOD.TXT'), path.join(root, 'GOOD.TXT'));
        assert.equal(oputil(root, ['fb', 'scan', 'uploads']).code, 0);
        addSysop(root);
        await fsp.rename(path.join(root, 'EVIL.EXE'), path.join(storage, 'EVIL.EXE'));
        await fsp.rename(path.join(root, 'GOOD.TXT'), path.join(storage, 'GOOD.TXT'));

        const { code, out } = oputil(root, ['fb', 'scan', 'uploads', '--virus-scan']);
        assert.equal(code, 0, out);
        assert.match(out, /Rejected \(command infected: Eicar-Test-Signature\)/);
        assert.match(out, /1 file rejected by file scanning/);

        assert.deepEqual(importedNames(root), ['GOOD.TXT']);
        assert.deepEqual(fs.readdirSync(storage), ['GOOD.TXT']);
        assert.deepEqual(quarantine(root), ['EVIL.EX_', 'EVIL.EX_.json']);

        const sidecar = JSON.parse(
            fs.readFileSync(
                path.join(root, 'filebase', '.quarantine', 'EVIL.EX_.json'),
                'utf8'
            )
        );
        assert.equal(sidecar.source, 'oputil');
        assert.equal(sidecar.areaTag, 'uploads');
        assert.equal(sidecar.signature, 'Eicar-Test-Signature');

        const notices = withDb(root, 'message', db =>
            db
                .prepare(
                    `SELECT m.subject, m.message, mm.meta_value AS toUserId
                    FROM message m
                    JOIN message_meta mm ON mm.message_id = m.message_id
                    WHERE m.area_tag = 'private_mail' AND mm.meta_name = 'local_to_user_id'`
                )
                .all()
        );
        assert.equal(notices.length, 1, 'one inbox notice for the run');
        assert.equal(notices[0].toUserId, '1');
        assert.match(notices[0].subject, /1 file rejected/);
        assert.match(notices[0].message, /EVIL\.EXE/);

        const scanMeta = withDb(root, 'file', db =>
            db
                .prepare(
                    `SELECT meta_value FROM file_meta WHERE meta_name = 'scan_result'`
                )
                .all()
        );
        assert.deepEqual(scanMeta, [{ meta_value: 'clean' }]);
    });

    //  minimist binds the next positional to a flag it does not know is
    //  boolean: "--virus-scan uploads" once made the area the flag's value,
    //  and the run imported everything unscanned
    it('scans with the flag before the area', async () => {
        const { root, storage } = await makeFixture();

        await fsp.rename(path.join(storage, 'EVIL.EXE'), path.join(root, 'EVIL.EXE'));
        assert.equal(oputil(root, ['fb', 'scan', 'uploads']).code, 0);
        addSysop(root);
        await fsp.rename(path.join(root, 'EVIL.EXE'), path.join(storage, 'EVIL.EXE'));

        const { code, out } = oputil(root, ['fb', 'scan', '--virus-scan', 'uploads']);
        assert.equal(code, 0, out);
        assert.match(out, /Rejected \(command infected: Eicar-Test-Signature\)/);
        assert.deepEqual(importedNames(root), ['GOOD.TXT']);
        assert.deepEqual(quarantine(root), ['EVIL.EX_', 'EVIL.EX_.json']);
    });

    //  first run makes the databases with nothing to import; then the files
    async function primed(fixtureOpts) {
        const fx = await makeFixture(fixtureOpts);
        const held = path.join(fx.root, 'held');
        await fsp.rename(fx.storage, held);
        await fsp.mkdir(fx.storage);
        assert.equal(oputil(fx.root, ['fb', 'scan', 'uploads']).code, 0);
        addSysop(fx.root);
        await fsp.rm(fx.storage, { recursive: true });
        await fsp.rename(held, fx.storage);
        return fx;
    }

    //  quarantine fails: a file sits where the quarantine directory would go
    async function blockQuarantine(root) {
        await fsp.writeFile(path.join(root, 'filebase', '.quarantine'), 'in the way');
    }

    it('deletes an infected file it cannot quarantine, rather than leave it importable', async () => {
        const { root, storage } = await primed();
        await blockQuarantine(root);

        const { code, out } = oputil(root, ['fb', 'scan', '--virus-scan', 'uploads']);
        assert.equal(code, 0, out);
        assert.match(out, /Could not quarantine it \(.+\); DELETED it instead/);
        assert.deepEqual(fs.readdirSync(storage), ['GOOD.TXT']);
        assert.deepEqual(importedNames(root), ['GOOD.TXT']);

        const notice = withDb(root, 'message', db =>
            db
                .prepare(`SELECT message FROM message WHERE area_tag = 'private_mail'`)
                .get()
        );
        assert.match(notice.message, /DELETED, could not be quarantined/);
    });

    it('says a held file it cannot quarantine is still in the tree, unscanned', async () => {
        //  a scanner that cannot start: every file is held
        const { root, storage } = await primed({
            scanner: { scanner: 'command', cmd: path.join(tmpDir, 'no-such-scanner') },
        });
        await blockQuarantine(root);

        const { code, out } = oputil(root, ['fb', 'scan', '--virus-scan', 'uploads']);
        assert.equal(code, 0, out);
        assert.match(
            out,
            /Could not quarantine it: .+ It is still at .*EVIL\.EXE, NOT scanned/
        );
        assert.deepEqual(fs.readdirSync(storage).sort(), ['EVIL.EXE', 'GOOD.TXT']);
        assert.deepEqual(importedNames(root), []);

        const notice = withDb(root, 'message', db =>
            db
                .prepare(`SELECT message FROM message WHERE area_tag = 'private_mail'`)
                .get()
        );
        assert.match(notice.message, /NOT moved: .*\r\nStill at: .*EVIL\.EXE/);
    });

    it('uses a scanner a mod registers with registerFileScanners, never moduleInitialize', async () => {
        const marker = path.join(tmpDir, `init-ran-${seq}`);
        const { root, storage } = await primed({
            scanner: { scanner: 'mod_av' },
            mods: {
                'mod_av/mod_av.js': `
                    exports.moduleInitialize = (i, cb) => {
                        require('fs').writeFileSync(${JSON.stringify(marker)}, 'x');
                        cb(null);
                    };
                    exports.registerFileScanners = (registry, cb) => {
                        registry.registerScanner('mod_av', {
                            scan(filePath, ctx, done) {
                                const bad = require('fs').readFileSync(filePath, 'latin1').includes('EICAR');
                                return done(null, bad ? { result: 'infected', signature: 'Mod-Found-It' } : { result: 'clean' });
                            },
                        });
                        return cb(null);
                    };`,
                'broken.js': `throw new Error('a broken mod is skipped');`,
            },
        });

        const { code, out } = oputil(root, ['fb', 'scan', '--virus-scan', 'uploads']);
        assert.equal(code, 0, out);
        assert.match(out, /Rejected \(mod_av infected: Mod-Found-It\)/);
        assert.deepEqual(importedNames(root), ['GOOD.TXT']);
        assert.deepEqual(fs.readdirSync(storage), ['GOOD.TXT']);
        assert.equal(
            fs.existsSync(marker),
            false,
            'moduleInitialize must not run in oputil'
        );
    });

    it('exits when done even though a mod it loaded keeps the event loop busy', async function () {
        this.timeout(30000);
        const { root } = await primed({
            scanner: { scanner: 'busy_av' },
            mods: {
                'busy.js': `
                    //  a server or timer started just by loading the mod
                    setInterval(() => {}, 1000);
                    exports.registerFileScanners = registry => {
                        registry.registerScanner('busy_av', {
                            scan(filePath, ctx, done) {
                                const bad = require('fs').readFileSync(filePath, 'latin1').includes('EICAR');
                                return done(null, { result: bad ? 'infected' : 'clean' });
                            },
                        });
                    };`,
            },
        });

        const { code, signal, out } = oputil(
            root,
            ['fb', 'scan', '--virus-scan', 'uploads'],
            { timeout: 20000 }
        );
        assert.equal(signal, null, `oputil did not exit by itself: ${out}`);
        assert.equal(code, 0, out);
        assert.match(out, /1 file rejected by file scanning/);
        assert.deepEqual(importedNames(root), ['GOOD.TXT']);
    });

    it('warns when scanning is enabled with nothing that can run', async () => {
        const { root } = await primed({ scanning: { scanners: [] } });
        const { code, out } = oputil(root, ['fb', 'scan', '--virus-scan', 'uploads']);
        assert.equal(code, 0, out);
        assert.match(out, /Warning: .*scanners is empty.*every file is accepted/);
    });

    it('refuses to run when file scanning is not enabled', async () => {
        const { root } = await makeFixture({ scanningEnabled: false });
        const { code, out } = oputil(root, ['fb', 'scan', 'uploads', '--virus-scan']);

        assert.notEqual(code, 0);
        assert.match(out, /fileBase\.scanning\.enabled/);
        assert.deepEqual(importedNames(root), []);
    });

    it('refuses to run when a scanner comes from a mod oputil does not load', async () => {
        const { root } = await makeFixture({ scanner: { scanner: 'clamav' } });
        const { code, out } = oputil(root, ['fb', 'scan', 'uploads', '--virus-scan']);

        assert.notEqual(code, 0);
        assert.match(out, /not registered by any mod in .*: clamav/);
        assert.deepEqual(importedNames(root), []);
    });
});
