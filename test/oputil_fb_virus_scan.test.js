'use strict';

//
//  oputil fb virus-scan (#291 phase 3): rescanning entries already in the
//  file base.
//
//  Driven as a real process against a scratch config, like
//  oputil_fb_scan.test.js. The scanner is the built-in command scanner
//  running a small node script that calls anything containing "EICAR"
//  infected. The files are imported first with a plain "fb scan", which does
//  not virus scan.
//

const { strict: assert } = require('assert');
const { spawnSync } = require('child_process');
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

describe('oputil fb virus-scan', function () {
    this.timeout(60000);

    let tmpDir;
    let seq = 0;

    before(async () => {
        tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'enigma_fb_rescan_'));
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

    function writeConfig(root, scanning) {
        const scriptPath = path.join(root, 'fake_av.js');
        fs.writeFileSync(
            path.join(root, 'config.hjson'),
            JSON.stringify(
                {
                    general: { boardName: 'Rescan Test' },
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
                                enabled: true,
                                notifyUserIds: [1],
                                scanners: [
                                    {
                                        scanner: 'command',
                                        cmd: process.execPath,
                                        args: [scriptPath, '{filePath}'],
                                        signatureRegex: '^.*: (.+) FOUND$',
                                    },
                                ],
                            },
                            scanning
                        ),
                    },
                },
                null,
                4
            )
        );
    }

    //  EVIL.EXE and GOOD.TXT imported, unscanned; user 1 exists for the notice
    async function makeFixture(scanning = {}) {
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
        await fsp.writeFile(path.join(root, 'fake_av.js'), SCANNER_SCRIPT);
        writeConfig(root, scanning);

        await fsp.writeFile(path.join(storage, 'EVIL.EXE'), 'X5O!P%@AP EICAR test');
        await fsp.writeFile(path.join(storage, 'GOOD.TXT'), 'a perfectly clean file');

        const imported = oputil(root, ['fb', 'scan', 'uploads']);
        assert.equal(imported.code, 0, imported.out);
        withDb(root, 'user', db =>
            db.prepare('INSERT INTO user (id, user_name) VALUES (1, ?)').run('sysop')
        );
        return { root, storage };
    }

    const entries = root =>
        withDb(root, 'file', db =>
            db
                .prepare('SELECT file_name FROM file ORDER BY file_name')
                .all()
                .map(r => r.file_name)
        );

    const scanMeta = root =>
        withDb(root, 'file', db =>
            db
                .prepare(
                    `SELECT f.file_name, m.meta_value
                    FROM file f JOIN file_meta m ON m.file_id = f.file_id
                    WHERE m.meta_name = 'scan_result'
                    ORDER BY f.file_name`
                )
                .all()
                .map(r => `${r.file_name}=${r.meta_value}`)
        );

    const notices = root =>
        withDb(root, 'message', db =>
            db
                .prepare(
                    `SELECT subject, message FROM message WHERE area_tag = 'private_mail'`
                )
                .all()
        );

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

    it('--dry-run (before the criteria) reports and records nothing', async () => {
        const { root, storage } = await makeFixture();

        const { code, out } = oputil(root, ['fb', 'virus-scan', '--dry-run', 'uploads']);
        assert.notEqual(code, 0, 'an infected file was found');
        assert.match(out, /dry run/);
        assert.match(out, /INFECTED\s+#\d+\s+uploads {2}EVIL\.EXE: Eicar-Test-Signature/);
        assert.match(out, /clean\s+#\d+\s+uploads {2}GOOD\.TXT/);
        assert.match(out, /DRY RUN, nothing recorded\. Checked 2 of 2/);

        assert.deepEqual(entries(root), ['EVIL.EXE', 'GOOD.TXT']);
        assert.deepEqual(fs.readdirSync(storage).sort(), ['EVIL.EXE', 'GOOD.TXT']);
        assert.deepEqual(scanMeta(root), []);
        assert.deepEqual(meta(root, 'rescan_attempted_at'), []);
        assert.equal(notices(root).length, 0);
    });

    it('reports an infected file with the command to remove it, and moves nothing', async () => {
        const { root, storage } = await makeFixture();
        const evilId = fileId(root, 'EVIL.EXE');

        const { code, out } = oputil(root, ['fb', 'virus-scan', 'uploads']);
        assert.notEqual(code, 0, 'non-zero: something was found');
        assert.match(out, /report only/);
        assert.match(out, new RegExp(`INFECTED\\s+#${evilId}\\s+uploads {2}EVIL\\.EXE`));
        assert.match(
            out,
            new RegExp(`remove with: \\./oputil\\.js fb rm ${evilId} --phys-file`)
        );

        assert.deepEqual(entries(root), ['EVIL.EXE', 'GOOD.TXT']);
        assert.deepEqual(fs.readdirSync(storage).sort(), ['EVIL.EXE', 'GOOD.TXT']);
        assert.deepEqual(quarantine(root), []);
        assert.deepEqual(scanMeta(root), ['EVIL.EXE=infected', 'GOOD.TXT=clean']);
        assert.deepEqual(meta(root, 'scan_signature'), ['EVIL.EXE=Eicar-Test-Signature']);

        const sent = notices(root);
        assert.equal(sent.length, 1);
        assert.match(sent[0].subject, /File base rescan: 1 file to check, 1 infected/);
        assert.match(sent[0].message, /oputil fb virus-scan/);
        assert.match(
            sent[0].message,
            new RegExp(`Remove:\\s+\\./oputil\\.js fb rm ${evilId} --phys-file`)
        );

        //  ...and that command does what the notice says
        const rm = oputil(root, ['fb', 'rm', String(evilId), '--phys-file']);
        assert.equal(rm.code, 0, rm.out);
        assert.deepEqual(entries(root), ['GOOD.TXT']);
        assert.deepEqual(fs.readdirSync(storage), ['GOOD.TXT']);
    });

    it('fb rm takes --phys-file before the file ID too', async () => {
        const { root, storage } = await makeFixture();
        const evilId = fileId(root, 'EVIL.EXE');
        const rm = oputil(root, ['fb', 'rm', '--phys-file', String(evilId)]);
        assert.equal(rm.code, 0, rm.out);
        assert.deepEqual(entries(root), ['GOOD.TXT']);
        assert.deepEqual(fs.readdirSync(storage), ['GOOD.TXT']);
    });

    it('takes a file name and --older-than / --max before the criteria', async () => {
        const { root } = await makeFixture();

        let res = oputil(root, ['fb', 'virus-scan', '--older-than', '30', 'GOOD.TXT']);
        assert.equal(res.code, 0, res.out);
        assert.match(res.out, /Checked 1 of 1 matching file:/);
        assert.deepEqual(scanMeta(root), ['GOOD.TXT=clean']);

        //  just scanned, so not older than 30 days; EVIL.EXE never was
        res = oputil(root, [
            'fb',
            'virus-scan',
            '--older-than',
            '30',
            '--max',
            '5',
            'uploads',
        ]);
        assert.match(
            res.out,
            /Checked 1 of 1 matching file: 0 clean, 0 skipped, 1 infected/
        );
    });

    it('an AREA@STORAGE that selects nothing scans nothing, rather than every area', async () => {
        const { root } = await makeFixture();
        const res = oputil(root, ['fb', 'virus-scan', 'uploads@no_such_storage']);
        assert.notEqual(res.code, 0);
        assert.match(res.out, /Nothing matched the criteria/);
        assert.deepEqual(scanMeta(root), []);
    });

    it('rejects a bad --max', async () => {
        const { root } = await makeFixture();
        let res = oputil(root, ['fb', 'virus-scan', '--max', 'many', 'uploads']);
        assert.notEqual(res.code, 0);
        assert.match(res.out, /--max needs a whole number/);

        //  "--max uploads" takes the area as its value: usage, no scan
        res = oputil(root, ['fb', 'virus-scan', '--max', 'uploads']);
        assert.notEqual(res.code, 0);
        assert.match(res.out, /usage: oputil\.js fb/);
        assert.deepEqual(scanMeta(root), []);
    });

    it('records nothing but the attempt and exits non-zero when the scanner fails', async () => {
        const { root, storage } = await makeFixture();
        writeConfig(root, {
            scanners: [{ scanner: 'command', cmd: path.join(tmpDir, 'no-such-scanner') }],
        });

        const { code, out } = oputil(root, ['fb', 'virus-scan', 'uploads']);
        assert.notEqual(code, 0, out);
        assert.match(out, /could not be checked/);
        assert.deepEqual(fs.readdirSync(storage).sort(), ['EVIL.EXE', 'GOOD.TXT']);
        assert.deepEqual(scanMeta(root), []);
        assert.equal(meta(root, 'rescan_attempted_at').length, 2);
        assert.match(notices(root)[0].message, /COULD NOT BE CHECKED/);
    });

    it('refuses to run with scanning disabled, or for criteria that match nothing', async () => {
        const { root } = await makeFixture();

        let res = oputil(root, ['fb', 'virus-scan', 'nothing-here']);
        assert.notEqual(res.code, 0);
        assert.match(res.out, /No area or file matches "nothing-here"/);

        writeConfig(root, { enabled: false });
        res = oputil(root, ['fb', 'virus-scan', 'uploads']);
        assert.notEqual(res.code, 0);
        assert.match(res.out, /needs file scanning enabled/);
    });
});
