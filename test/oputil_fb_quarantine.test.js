'use strict';

//
//  oputil fb quarantine list|release|delete and fb mark-safe (#291, PR 4).
//
//  Driven as a real process against a scratch config, like
//  oputil_fb_virus_scan.test.js. The scanner is the built-in command scanner
//  running a small node script that calls anything containing "EICAR"
//  infected.
//

const { strict: assert } = require('assert');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const REPO_ROOT = path.join(__dirname, '..');

const SCANNER_SCRIPT = `
const fs = require('fs');
const p = process.argv[2];
if (fs.readFileSync(p, 'latin1').includes('EICAR')) {
    console.log(p + ': Eicar-Test-Signature FOUND');
    process.exit(1);
}
process.exit(0);
`;

const EICAR = 'X5O!P%@AP EICAR test';
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');

describe('oputil fb quarantine / mark-safe', function () {
    this.timeout(90000);

    let tmpDir;
    let seq = 0;

    before(async () => {
        tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'enigma_fb_quar_'));
    });

    after(async () => {
        await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    function oputil(root, args) {
        const res = spawnSync(
            process.execPath,
            ['./oputil.js', '-c', `${root}${path.sep}`, ...args],
            { cwd: REPO_ROOT, encoding: 'utf8', killSignal: 'SIGKILL' }
        );
        return {
            code: res.status,
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

    async function makeFixture() {
        const root = path.join(tmpDir, `f${seq++}`);
        const storage = path.join(root, 'filebase', 'uploads');
        for (const d of [
            path.join(root, 'db'),
            path.join(root, 'logs'),
            path.join(root, 'mods'),
            storage,
        ]) {
            await fsp.mkdir(d, { recursive: true });
        }
        const scriptPath = path.join(root, 'fake_av.js');
        await fsp.writeFile(scriptPath, SCANNER_SCRIPT);
        await fsp.writeFile(
            path.join(root, 'config.hjson'),
            JSON.stringify(
                {
                    general: { boardName: 'Quarantine Test' },
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
                        scanning: {
                            enabled: true,
                            notifyUserIds: [],
                            scanners: [
                                {
                                    scanner: 'command',
                                    cmd: process.execPath,
                                    args: [scriptPath, '{filePath}'],
                                    signatureRegex: '^.*: (.+) FOUND$',
                                },
                            ],
                        },
                    },
                },
                null,
                4
            )
        );
        return { root, storage };
    }

    const quarantine = root => {
        try {
            return fs.readdirSync(path.join(root, 'filebase', '.quarantine')).sort();
        } catch {
            return [];
        }
    };

    const meta = (root, name) =>
        withDb(root, 'file', db =>
            db
                .prepare(
                    `SELECT f.file_name, m.meta_value
                    FROM file f JOIN file_meta m ON m.file_id = f.file_id
                    WHERE m.meta_name = ?
                    ORDER BY f.file_name`
                )
                .all(name)
                .map(r => `${r.file_name}=${r.meta_value}`)
        );

    const fileId = (root, name) =>
        withDb(root, 'file', db =>
            db.prepare('SELECT file_id FROM file WHERE file_name = ?').get(name)
        ).file_id;

    const allowlist = root =>
        withDb(root, 'file', db =>
            db.prepare('SELECT * FROM file_scan_allowlist ORDER BY sha256').all()
        );

    it('declares its boolean flags, so they never swallow a positional', () => {
        const { argvOptions } = require('../core/oputil/oputil_common.js');
        for (const flag of ['allow', 'list', 'yes']) {
            assert.ok(argvOptions.boolean.includes(flag), flag);
        }
        const minimist = require('minimist');
        const argv = minimist(
            ['fb', 'quarantine', 'release', '--allow', 'EVIL.EX_', '--note', 'fp'],
            argvOptions
        );
        assert.deepEqual(argv._, ['fb', 'quarantine', 'release', 'EVIL.EX_']);
        assert.equal(argv.allow, true);
        assert.equal(argv.note, 'fp');

        //  --no-scan never takes the name
        const noScan = minimist(
            ['fb', 'quarantine', 'release', '--no-scan', 'EVIL.EX_'],
            argvOptions
        );
        assert.deepEqual(noScan._, ['fb', 'quarantine', 'release', 'EVIL.EX_']);
        assert.equal(noScan.scan, false);
    });

    it('keeps an all-digit SHA-256, note or name as text', () => {
        const { argvOptions } = require('../core/oputil/oputil_common.js');
        const digits = '1'.repeat(64);
        const argv = require('minimist')(
            ['fb', 'mark-safe', '--remove', digits, '--note', '0123', '--name', '007'],
            argvOptions
        );
        assert.equal(argv.remove, digits);
        assert.equal(argv.note, '0123');
        assert.equal(argv.name, '007');
    });

    it('quarantines, lists, releases with --allow, then lets the same bytes through', async () => {
        const { root, storage } = await makeFixture();
        await fsp.writeFile(path.join(storage, 'EVIL.EXE'), EICAR);

        let r = oputil(root, ['fb', 'scan', '--virus-scan', 'uploads']);
        assert.deepEqual(quarantine(root), ['EVIL.EX_', 'EVIL.EX_.json'], r.out);

        r = oputil(root, ['fb', 'quarantine', 'list']);
        assert.equal(r.code, 0, r.out);
        assert.ok(r.out.includes('EVIL.EX_'), r.out);
        assert.ok(r.out.includes('original  EVIL.EXE'), r.out);
        assert.ok(r.out.includes('Eicar-Test-Signature'), r.out);
        assert.ok(r.out.includes('area      uploads'), r.out);
        assert.ok(r.out.includes(sha256(EICAR)), r.out);

        //  flags before the positional
        r = oputil(root, [
            'fb',
            'quarantine',
            'release',
            '--allow',
            '--note',
            'demo false positive',
            'EVIL.EX_',
        ]);
        assert.equal(r.code, 0, r.out);
        assert.ok(r.out.includes('Added'), r.out);
        assert.deepEqual(quarantine(root), []);
        assert.ok(fs.existsSync(path.join(storage, 'EVIL.EXE')));
        assert.deepEqual(meta(root, 'scanner'), ['EVIL.EXE=allowlist']);
        assert.deepEqual(meta(root, 'scan_result'), ['EVIL.EXE=clean']);

        const rows = allowlist(root);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].sha256, sha256(EICAR));
        assert.equal(rows[0].note, 'demo false positive');
        assert.ok(rows[0].added_by.startsWith('oputil'), rows[0].added_by);

        //  a copy of the same bytes now passes the scan (and is then a
        //  dupe of the released entry, so not imported twice)
        await fsp.writeFile(path.join(storage, 'COPY.EXE'), EICAR);
        r = oputil(root, ['fb', 'scan', '--virus-scan', '--verbose', 'uploads']);
        assert.equal(r.code, 0, r.out);
        assert.ok(/virus_scan_finish[\s\S]*Dupe/.test(r.out), r.out);
        assert.deepEqual(quarantine(root), [], 'not quarantined');
        assert.ok(fs.existsSync(path.join(storage, 'COPY.EXE')));

        //  and a rescan agrees
        r = oputil(root, ['fb', 'virus-scan', 'uploads']);
        assert.equal(r.code, 0, r.out);
        assert.ok(r.out.includes('(allowlisted)'), r.out);
    });

    it('mark-safe: --list, --remove, then by file ID and by SHA-256', async () => {
        const { root, storage } = await makeFixture();
        await fsp.writeFile(path.join(storage, 'EVIL.EXE'), EICAR);
        await fsp.writeFile(path.join(storage, 'GOOD.TXT'), 'clean');
        assert.equal(oputil(root, ['fb', 'scan', 'uploads']).code, 0);

        //  a second entry with the same bytes ("fb scan" skips dupes)
        await fsp.writeFile(path.join(storage, 'EVIL2.EXE'), EICAR);
        withDb(root, 'file', db =>
            db
                .prepare(
                    `INSERT INTO file (area_tag, file_sha256, file_name, storage_tag, desc, desc_long, upload_timestamp)
                    SELECT area_tag, file_sha256, 'EVIL2.EXE', storage_tag, desc, desc_long, upload_timestamp
                    FROM file WHERE file_name = 'EVIL.EXE'`
                )
                .run()
        );

        let r = oputil(root, ['fb', 'virus-scan', 'uploads']);
        assert.notEqual(r.code, 0, 'infected found');
        assert.deepEqual(meta(root, 'scan_result'), [
            'EVIL.EXE=infected',
            'EVIL2.EXE=infected',
            'GOOD.TXT=clean',
        ]);

        r = oputil(root, ['fb', 'mark-safe', '--list']);
        assert.equal(r.code, 0, r.out);
        assert.ok(r.out.includes('The allowlist is empty'), r.out);

        //  by file ID, the note before it: every entry with the hash clears
        r = oputil(root, [
            'fb',
            'mark-safe',
            '--note',
            'checked by hand',
            String(fileId(root, 'EVIL.EXE')),
        ]);
        assert.equal(r.code, 0, r.out);
        assert.ok(r.out.includes('Marked clean'), r.out);
        assert.deepEqual(meta(root, 'scan_result'), [
            'EVIL.EXE=clean',
            'EVIL2.EXE=clean',
            'GOOD.TXT=clean',
        ]);
        assert.deepEqual(meta(root, 'scan_signature'), []);
        assert.equal(allowlist(root)[0].original_name, 'EVIL.EXE');
        assert.equal(allowlist(root)[0].signature, 'Eicar-Test-Signature');

        r = oputil(root, ['fb', 'mark-safe', '--list']);
        assert.ok(r.out.includes(sha256(EICAR)), r.out);
        assert.ok(r.out.includes('checked by hand'), r.out);

        r = oputil(root, ['fb', 'mark-safe', '--remove', sha256(EICAR)]);
        assert.equal(r.code, 0, r.out);
        assert.deepEqual(allowlist(root), []);

        r = oputil(root, ['fb', 'virus-scan', 'uploads']);
        assert.notEqual(r.code, 0);
        assert.deepEqual(meta(root, 'scan_result'), [
            'EVIL.EXE=infected',
            'EVIL2.EXE=infected',
            'GOOD.TXT=clean',
        ]);

        //  by SHA-256, in capitals
        r = oputil(root, ['fb', 'mark-safe', sha256(EICAR).toUpperCase()]);
        assert.equal(r.code, 0, r.out);
        assert.deepEqual(meta(root, 'scanner'), [
            'EVIL.EXE=allowlist',
            'EVIL2.EXE=allowlist',
            'GOOD.TXT=command',
        ]);
    });

    it('mark-safe refuses a file changed since import, and bad arguments', async () => {
        const { root, storage } = await makeFixture();
        await fsp.writeFile(path.join(storage, 'EVIL.EXE'), EICAR);
        assert.equal(oputil(root, ['fb', 'scan', 'uploads']).code, 0);
        await fsp.writeFile(path.join(storage, 'EVIL.EXE'), `${EICAR} changed`);

        let r = oputil(root, ['fb', 'mark-safe', String(fileId(root, 'EVIL.EXE'))]);
        assert.notEqual(r.code, 0);
        assert.ok(r.out.includes('has changed since it was imported'), r.out);

        for (const args of [
            ['fb', 'mark-safe'],
            ['fb', 'mark-safe', 'abc'],
            ['fb', 'mark-safe', '--remove'],
            ['fb', 'mark-safe', '--remove', 'abc'],
            ['fb', 'mark-safe', '--list', '1'],
            ['fb', 'mark-safe', '999'],
            ['fb', 'mark-safe', '1', '--note'],
        ]) {
            r = oputil(root, args);
            assert.notEqual(r.code, 0, `${args.join(' ')}: ${r.out}`);
        }
        assert.deepEqual(allowlist(root), []);
    });

    it('release scans first: a flagged file needs --allow; --no-scan skips the scan', async () => {
        const { root, storage } = await makeFixture();
        await fsp.writeFile(path.join(storage, 'EVIL.EXE'), EICAR);
        await fsp.writeFile(path.join(storage, 'OTHER.EXE'), `${EICAR} 2`);
        oputil(root, ['fb', 'scan', '--virus-scan', 'uploads']);
        assert.deepEqual(quarantine(root), [
            'EVIL.EX_',
            'EVIL.EX_.json',
            'OTHER.EX_',
            'OTHER.EX_.json',
        ]);

        let r = oputil(root, ['fb', 'quarantine', 'release', 'EVIL.EX_']);
        assert.notEqual(r.code, 0);
        assert.ok(r.out.includes('rejected it'), r.out);
        assert.ok(r.out.includes('--allow'), r.out);
        assert.ok(quarantine(root).includes('EVIL.EX_'), 'still in quarantine');
        assert.deepEqual(meta(root, 'scan_result'), []);

        r = oputil(root, ['fb', 'quarantine', 'release', '--allow', 'EVIL.EX_']);
        assert.equal(r.code, 0, r.out);
        assert.ok(r.out.includes('Scanned before release: clean (allowlist)'), r.out);
        assert.deepEqual(meta(root, 'scan_result'), ['EVIL.EXE=clean']);

        r = oputil(root, ['fb', 'quarantine', 'release', '--no-scan', 'OTHER.EX_']);
        assert.equal(r.code, 0, r.out);
        assert.ok(r.out.includes('Not scanned before release (--no-scan)'), r.out);
        assert.deepEqual(quarantine(root), []);
    });

    it('mark-safe refuses a FILE_ID whose file is missing, unless --force', async () => {
        const { root, storage } = await makeFixture();
        await fsp.writeFile(path.join(storage, 'GONE.TXT'), 'soon gone');
        assert.equal(oputil(root, ['fb', 'scan', 'uploads']).code, 0);
        await fsp.unlink(path.join(storage, 'GONE.TXT'));
        const id = String(fileId(root, 'GONE.TXT'));

        let r = oputil(root, ['fb', 'mark-safe', id]);
        assert.notEqual(r.code, 0);
        assert.ok(r.out.includes('--force'), r.out);
        assert.deepEqual(allowlist(root), []);

        r = oputil(root, ['fb', 'mark-safe', '--force', id]);
        assert.equal(r.code, 0, r.out);
        assert.equal(allowlist(root)[0].sha256, sha256('soon gone'));
    });

    it('quarantine list shows no invisible characters, and cuts long fields', async () => {
        const { root } = await makeFixture();
        const q = path.join(root, 'filebase', '.quarantine');
        await fsp.mkdir(q, { recursive: true });
        await fsp.writeFile(path.join(q, 'x.zip'), 'x');
        await fsp.writeFile(
            path.join(q, 'x.zip.json'),
            JSON.stringify({
                quarantineName: 'x.zip',
                originalName: 'evil\u202etxt.exe',
                source: 'web',
                areaTag: 'A'.repeat(500),
                sha256: sha256('x'),
            })
        );
        const r = oputil(root, ['fb', 'quarantine', 'list']);
        assert.equal(r.code, 0, r.out);
        assert.ok(!/[\u202e\u200b\u2028\u2029]/.test(r.out), 'no format characters');
        assert.ok(r.out.includes('evil?txt.exe'), r.out);
        assert.ok(!r.out.includes('A'.repeat(129)), 'capped');
        assert.ok(r.out.includes(`${'A'.repeat(128)}...`), r.out);
    });

    it('release refuses a tampered file; delete asks unless told not to', async () => {
        const { root, storage } = await makeFixture();
        await fsp.writeFile(path.join(storage, 'EVIL.EXE'), EICAR);
        oputil(root, ['fb', 'scan', '--virus-scan', 'uploads']);
        await fsp.appendFile(path.join(root, 'filebase', '.quarantine', 'EVIL.EX_'), 'x');

        let r = oputil(root, ['fb', 'quarantine', 'release', 'EVIL.EX_']);
        assert.notEqual(r.code, 0);
        assert.ok(r.out.includes('not the file that was quarantined'), r.out);
        assert.deepEqual(quarantine(root), ['EVIL.EX_', 'EVIL.EX_.json']);

        for (const args of [
            ['fb', 'quarantine'],
            ['fb', 'quarantine', 'release'],
            ['fb', 'quarantine', 'release', 'EVIL.EX_', '--area'],
            ['fb', 'quarantine', 'release', 'EVIL.EX_', '--note', 'no allow'],
            ['fb', 'quarantine', 'delete', 'NOPE'],
        ]) {
            r = oputil(root, args);
            assert.notEqual(r.code, 0, `${args.join(' ')}: ${r.out}`);
        }

        r = oputil(root, ['fb', 'quarantine', 'delete', '--yes', 'EVIL.EX_']);
        assert.equal(r.code, 0, r.out);
        assert.deepEqual(quarantine(root), []);
    });
});
