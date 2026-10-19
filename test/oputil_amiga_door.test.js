/* jslint node: true */
'use strict';

//  oputil amiga-door: building, changing and reading door images with
//  core/amiga_door/amiga_fs.js. The command-line tests run oputil.js itself.

const { strict: assert } = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    parseSize,
    buildDoorImage,
    addToVolume,
    extractFromVolume,
    WORKBENCH_FILES,
    BASE_FILES,
    doorNameProblem,
    checkDoorNames,
} = require('../core/oputil/oputil_amiga_door.js');
const { AmigaVolume } = require('../core/amiga_door/amiga_fs.js');
const protocol = require('../core/amiga_door/protocol.js');
const {
    buildConsoleSession,
    formatExit,
    formatDisk,
} = require('../core/oputil/oputil_amiga_console.js');

const ROOT = path.join(__dirname, '..');
const AMIGA_DIR = path.join(ROOT, 'misc/amiga_door');
const OPUTIL = path.join(ROOT, 'oputil.js');

function oputil(...args) {
    return spawnSync(process.execPath, [OPUTIL, 'amiga-door', ...args], {
        encoding: 'utf8',
        cwd: ROOT,
    });
}

describe('oputil amiga-door', function () {
    let dir;
    let door;
    const mtime = new Date(2024, 1, 29, 13, 14, 16);

    before(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oputil-amiga-'));
        //  a door with a nested layout, an empty data file and an empty directory
        door = path.join(dir, 'My Door');
        fs.mkdirSync(path.join(door, 'data', 'scores'), { recursive: true });
        fs.mkdirSync(path.join(door, 'Fighters'));
        fs.writeFileSync(path.join(door, 'door.xim'), Buffer.from([0, 0, 3, 0xf3, 1, 2]));
        fs.writeFileSync(path.join(door, 'data', 'empty.dat'), '');
        fs.writeFileSync(path.join(door, 'data', 'scores', 'hi.txt'), 'HIGH SCORES\n');
        fs.utimesSync(path.join(door, 'door.xim'), mtime, mtime);
    });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    describe('parseSize', () => {
        it('takes bytes and K/M/G, rounded up to whole 8K', () => {
            assert.equal(parseSize('4M'), 4 * 1024 * 1024);
            assert.equal(parseSize('8m'), 8 * 1024 * 1024);
            assert.equal(parseSize('880K'), 901120);
            assert.equal(parseSize('1G'), 1024 * 1024 * 1024);
            assert.equal(parseSize('4MiB'), 4 * 1024 * 1024);
            assert.equal(parseSize(4194304), 4194304);
            assert.equal(parseSize('1000'), 8192);
            assert.equal(parseSize('4.5M') % 8192, 0);
        });

        it('refuses nonsense and sizes of 2G or more', () => {
            assert.throws(() => parseSize('big'), /bad size/);
            assert.throws(() => parseSize('0'), /bad size/);
            assert.throws(() => parseSize('3G'), /too large/);
            //  Node's Buffer cannot hold an image of 2^31 bytes
            assert.throws(() => parseSize('2G'), /too large: 2G \(at most 2097144K/);
            assert.equal(parseSize('2097144K'), 2 * 1024 * 1024 * 1024 - 8192);
        });
    });

    describe('buildDoorImage', () => {
        it('puts the shim, library, startup sequence and each door on the image', () => {
            const vol = buildDoorImage({ size: '2M', doors: [door] });
            assert.equal(vol.name, 'BBS');
            assert.equal(vol.size, 2 * 1024 * 1024);
            for (const [src, dst] of BASE_FILES) {
                assert.ok(
                    vol.readFile(dst).equals(fs.readFileSync(path.join(AMIGA_DIR, src))),
                    dst
                );
            }
            assert.deepEqual(
                vol
                    .list('Doors', { recursive: true })
                    .map(e => `${e.type} ${e.path} ${e.size}`),
                [
                    'dir Doors/My Door 0',
                    'dir Doors/My Door/data 0',
                    'file Doors/My Door/data/empty.dat 0',
                    'dir Doors/My Door/data/scores 0',
                    'file Doors/My Door/data/scores/hi.txt 12',
                    'file Doors/My Door/door.xim 6',
                    'dir Doors/My Door/Fighters 0',
                ]
            );
            //  the door file keeps its modification time and gets rwed
            const xim = vol.stat('BBS:Doors/My Door/door.xim');
            assert.equal(xim.date.getTime(), mtime.getTime());
            assert.equal(xim.protectionString, '----rwed');
            assert.deepEqual(vol.check(), []);
        });

        it('takes a volume name and several doors', () => {
            const other = path.join(dir, 'other');
            fs.mkdirSync(other, { recursive: true });
            fs.writeFileSync(path.join(other, 'x'), 'x');
            const vol = buildDoorImage({
                size: '1M',
                name: 'Doors2',
                doors: [door, other + '/'],
            });
            assert.equal(vol.name, 'Doors2');
            assert.deepEqual(
                vol.list('Doors').map(e => e.name),
                ['My Door', 'other']
            );
        });

        it('says what does not fit, is not a directory, or is no Amiga name', () => {
            const big = path.join(dir, 'big');
            fs.mkdirSync(big, { recursive: true });
            fs.writeFileSync(path.join(big, 'huge.bin'), Buffer.alloc(3 * 1024 * 1024));
            assert.throws(
                () => buildDoorImage({ size: '1M', doors: [big] }),
                /^Error: the doors do not fit in 1,024 KB: give a larger --size/
            );
            //  the shim alone is bigger than 32K
            assert.throws(
                () => buildDoorImage({ size: '32K', doors: [door] }),
                /the shim, AEDoor.library and S\/Startup-Sequence do not fit in 32 KB/
            );
            assert.throws(
                () => buildDoorImage({ size: '1M', doors: [path.join(dir, 'nope')] }),
                /not a directory/
            );

            const long = path.join(dir, 'long');
            fs.mkdirSync(long, { recursive: true });
            fs.writeFileSync(path.join(long, 'a-file-name-longer-than-thirty.txt'), '');
            assert.throws(
                () => buildDoorImage({ size: '1M', doors: [long] }),
                /longer than 30/
            );
        });

        it('refuses two local names that are one name to AmigaDOS', function () {
            const clash = path.join(dir, 'clash');
            fs.mkdirSync(clash, { recursive: true });
            fs.writeFileSync(path.join(clash, 'README'), '1');
            fs.writeFileSync(path.join(clash, 'readme'), '2');
            if (fs.readdirSync(clash).length < 2) return this.skip(); // case-insensitive host
            assert.throws(
                () => buildDoorImage({ size: '1M', doors: [clash] }),
                /ignores case/
            );
        });

        describe('--workbench', () => {
            //  a stand-in for the Workbench 3.1 disk with every file the image takes
            function fakeWorkbench(file, skip) {
                const wb = AmigaVolume.create(901120, { name: 'Workbench3.1' });
                for (const p of WORKBENCH_FILES) {
                    if (p !== skip) {
                        wb.writeFile(p, `contents of ${p}`, {
                            date: new Date(1994, 6, 6, 12, 39),
                            protection: p === 'Rexxc/RX' ? 'prwed' : 'rwed',
                        });
                    }
                }
                wb.writeFile('C/NotWanted', 'x');
                wb.save(file);
                return file;
            }

            it('copies ARexx, its libraries and the C: commands, as on the disk', () => {
                const adf = fakeWorkbench(path.join(dir, 'wb.adf'));
                const vol = buildDoorImage({ size: '2M', workbench: adf, doors: [door] });
                for (const p of WORKBENCH_FILES) {
                    assert.equal(vol.readFile(p).toString(), `contents of ${p}`, p);
                }
                assert.equal(vol.exists('C/NotWanted'), false);
                assert.equal(vol.stat('Rexxc/RX').protectionString, '--p-rwed');
                assert.equal(vol.stat('System/RexxMast').date.getFullYear(), 1994);
                //  the template starts RexxMast when the image has it
                assert.match(
                    vol.readFile('S/Startup-Sequence').toString(),
                    /SYS:System\/RexxMast/
                );
            });

            it('names what the disk lacks', () => {
                const adf = fakeWorkbench(
                    path.join(dir, 'wb-missing.adf'),
                    'Libs/rexxsyslib.library'
                );
                assert.throws(
                    () => buildDoorImage({ size: '2M', workbench: adf }),
                    /Workbench 3.1 disk\?\): Libs\/rexxsyslib.library/
                );
                assert.throws(
                    () =>
                        buildDoorImage({
                            size: '2M',
                            workbench: path.join(dir, 'none.adf'),
                        }),
                    /no such Workbench/
                );
                const notAdf = path.join(dir, 'not.adf');
                fs.writeFileSync(notAdf, Buffer.alloc(901120));
                assert.throws(
                    () => buildDoorImage({ size: '2M', workbench: notAdf }),
                    /not.adf/
                );
            });
        });
    });

    describe('add and extract', () => {
        it('round-trips a tree, empty files, directories and times', () => {
            const vol = AmigaVolume.create(1024 * 1024);
            assert.equal(addToVolume(vol, door, 'Doors/Copy'), 3);
            const out = path.join(dir, 'extracted');
            assert.equal(extractFromVolume(vol, 'Doors/Copy', out), 3);
            for (const rel of ['door.xim', 'data/empty.dat', 'data/scores/hi.txt']) {
                assert.ok(
                    fs
                        .readFileSync(path.join(out, rel))
                        .equals(fs.readFileSync(path.join(door, rel))),
                    rel
                );
            }
            assert.ok(fs.statSync(path.join(out, 'Fighters')).isDirectory());
            assert.equal(
                fs.statSync(path.join(out, 'door.xim')).mtime.getTime(),
                mtime.getTime()
            );

            //  a file into an existing local directory keeps its name
            const one = path.join(dir, 'one');
            fs.mkdirSync(one, { recursive: true });
            extractFromVolume(vol, 'Doors/Copy/data/scores/hi.txt', one);
            assert.equal(
                fs.readFileSync(path.join(one, 'hi.txt'), 'utf8'),
                'HIGH SCORES\n'
            );
        });

        it('will not extract names a local file system would take as paths', () => {
            const vol = AmigaVolume.create(1024 * 1024);
            vol.writeFile('evil/../x', 'x'); // ".." is just a name to AmigaDOS
            assert.equal(vol.list('evil')[0].name, '..');
            assert.throws(
                () => extractFromVolume(vol, 'evil', path.join(dir, 'evil')),
                /refusing/
            );
            assert.equal(fs.existsSync(path.join(dir, 'x')), false);
        });
    });

    describe('door names the module refuses', () => {
        it('names the character a door path may not carry', () => {
            for (const c of ['"', '*', '`', '$', ';', '<', '>', '|']) {
                assert.match(doorNameProblem(`a${c}b`), /the character/, c);
            }
            assert.match(doorNameProblem('a\x07b'), /control character/);
            assert.match(doorNameProblem('a\x85b'), /control character/); // C1
            assert.match(doorNameProblem('a\u20acb'), /outside Latin-1/);
            assert.equal(doorNameProblem('My Door'), null);
            assert.equal(doorNameProblem('caf\xe9 (v1.0)-x_y'), null); // Latin-1 is fine
        });

        it('warns for a door directory and the files in it, and nothing else', () => {
            assert.deepEqual(checkDoorNames(door), []);
            const bad = path.join(dir, 'Fun;Door');
            fs.mkdirSync(path.join(bad, 'data'), { recursive: true });
            fs.writeFileSync(path.join(bad, 'ok.xim'), 'x');
            fs.writeFileSync(path.join(bad, 'data', 'sc$ores.dat'), 'x');
            fs.writeFileSync(path.join(bad, 'data', 'eur\u20ac.txt'), 'x');
            const w = checkDoorNames(bad);
            assert.equal(w.length, 3, w.join('\n'));
            assert.match(w[0], /^Doors\/Fun;Door has the character ; in its name/);
            assert.match(
                w[1],
                /^Doors\/Fun;Door\/data\/eur\u20ac\.txt has a character outside Latin-1/
            );
            assert.match(
                w[2],
                /^Doors\/Fun;Door\/data\/sc\$ores\.dat has the character \$/
            );
            assert.match(w[0], /will refuse a `door:` path through it/);
        });

        it('create warns on stderr and still builds the image', function () {
            this.timeout(30000);
            const bad = path.join(dir, 'Odd|Door');
            fs.mkdirSync(bad);
            fs.writeFileSync(path.join(bad, 'game'), 'x');
            const img = path.join(dir, 'warn.hdf');
            const r = oputil('create', img, '--size', '1M', bad);
            assert.equal(r.status, 0, r.stderr);
            assert.match(
                r.stderr,
                /amiga-door: warning: Doors\/Odd\|Door has the character \|/
            );
            assert.ok(fs.existsSync(img));
            const clean = oputil('create', img, '--force', '--size', '1M', door);
            assert.equal(clean.status, 0, clean.stderr);
            assert.doesNotMatch(clean.stderr, /warning/);
        });
    });

    describe('console', () => {
        it('builds the s frame keys for a test caller', () => {
            const now = Date.UTC(2026, 9, 17, 12, 0, 0);
            const k = buildConsoleSession({ door: 'BBS:Doors/X/x.xim' }, now);
            assert.equal(k.version, protocol.PROTOCOL_VERSION);
            assert.equal(k.type, 'xim');
            assert.equal(k.door, 'BBS:Doors/X/x.xim');
            assert.equal(k.name, 'Test Caller');
            assert.equal(k.now, Math.floor(now / 1000));
            assert.equal(k.rows, 24);
            assert.equal(k.cols, 80);
            assert.equal(k.timeleft, 60);
            assert.equal(k.console, undefined); // CLI doors only
            assert.equal('args' in k, false);
            //  every key survives the wire format
            const [e] = new protocol.Decoder().push(protocol.encode('s', k));
            assert.equal(e.frame.type, 's');
            assert.equal(e.frame.keys.door, 'BBS:Doors/X/x.xim');
            assert.equal(e.frame.keys.now, String(Math.floor(now / 1000)));
        });

        it('takes a CLI door with arguments, console mode and caller details', () => {
            const k = buildConsoleSession({
                door: 'BBS:Doors/spac/space',
                type: 'cli',
                args: '"{name}" DOORS:spac/',
                consoleMode: 'raw',
                user: 'Hero',
                level: '50',
                timeleft: 5,
                rows: 30,
                cols: 100,
            });
            assert.equal(k.type, 'cli');
            assert.equal(k.console, 'raw');
            assert.equal(k.args, '"{name}" DOORS:spac/');
            assert.equal(k.name, 'Hero');
            assert.equal(k.level, 50);
            assert.equal(k.timeleft, 5);
            assert.equal(k.timelimit, 5);
            assert.equal(k.rows, 30);
            assert.equal(k.cols, 100);
        });

        it('refuses a missing door, a bad type or console mode and bad numbers', () => {
            assert.throws(() => buildConsoleSession({}), /needs --door/);
            assert.throws(() => buildConsoleSession({ door: true }), /needs --door/);
            assert.throws(
                () => buildConsoleSession({ door: 'a:b', type: 'z m' }),
                /--type/
            );
            assert.throws(
                () => buildConsoleSession({ door: 'a:b', type: true }),
                /--type/
            );
            assert.throws(
                () => buildConsoleSession({ door: 'a:b', consoleMode: 'x' }),
                /--console-mode/
            );
            assert.throws(
                () => buildConsoleSession({ door: 'a:b', level: 'x' }),
                /--level/
            );
            assert.throws(() => buildConsoleSession({ door: 'a:b', rows: 0 }), /--rows/);
            assert.throws(
                () => buildConsoleSession({ door: 'a:b', user: true }),
                /--user needs/
            );
        });

        it('passes on a type the shim may know (tim, cnetrexx)', () => {
            for (const type of ['tim', 'cnetrexx']) {
                assert.equal(buildConsoleSession({ door: 'a:b', type }).type, type);
            }
        });

        it('prints the exit summary one key per line', () => {
            assert.deepEqual(
                formatExit('ok', { status: 'ok', wrote: '1', rc: '0', changed: '' }),
                ['status: ok', 'rc: 0', 'wrote: 1']
            );
        });

        it('says what became of the image', () => {
            assert.equal(formatDisk('d.hdf', null), 'd.hdf not changed (--no-persist)');
            assert.equal(
                formatDisk('d.hdf', { writes: 0, bytes: 0 }),
                'd.hdf not changed (the door wrote nothing to its disk)'
            );
            assert.equal(
                formatDisk('d.hdf', { writes: 3, bytes: 12288 }),
                'd.hdf written as the door went: 3 writes, 12 KB, synced'
            );
            assert.match(
                formatDisk('d.hdf', { writes: 1, bytes: 4096, error: 'EIO' }),
                /^d\.hdf: the final sync FAILED \(EIO\); it holds what reached it before \(1 writes, 4 KB\)$/
            );
        });

        it('the command line says what is missing without booting anything', function () {
            this.timeout(30000);
            let r = oputil('console', path.join(dir, 'nope.hdf'), '--door', 'BBS:x');
            assert.notEqual(r.status, 0);
            assert.match(r.stderr, /no such image/);

            const img = path.join(dir, 'console.hdf');
            assert.equal(oputil('create', img, '--size', '1M').status, 0);
            r = oputil('console', img);
            assert.notEqual(r.status, 0);
            assert.match(r.stderr, /needs --door/);
            r = oputil('console', img, '--door', 'BBS:x', '--type', 'Z!M');
            assert.notEqual(r.status, 0);
            assert.match(
                r.stderr,
                /--type must be a door type: xim, cli, aim or another/
            );
            assert.equal(fs.statSync(img).size, 1024 * 1024);
        });
    });

    describe('command line', function () {
        this.timeout(30000);

        it('create refuses a size over 2032K unless --allow-large', () => {
            const img = path.join(dir, 'large.hdf');
            let r = oputil('create', img, '--size', '2040K', door);
            assert.notEqual(r.status, 0);
            assert.match(
                r.stderr,
                /more than 2032K.*AROS ROM built before AROS#1720 was merged \(2026-10-19\).*4066 blocks \(2033K\).*--allow-large/s
            );
            assert.equal(fs.existsSync(img), false);

            r = oputil('create', img, '--size', '2032K', door);
            assert.equal(r.status, 0, r.stderr);
            assert.equal(fs.statSync(img).size, 2032 * 1024);

            r = oputil('create', img, '--force', '--size', '4M', '--allow-large', door);
            assert.equal(r.status, 0, r.stderr);
            assert.equal(fs.statSync(img).size, 4 * 1024 * 1024);
        });

        it('create, refuse to overwrite, --force, ls, info', () => {
            const img = path.join(dir, 'cli.hdf');
            let r = oputil('create', img, '--size', '2000K', '--doors', door);
            assert.equal(r.status, 0, r.stderr);
            assert.match(r.stdout, /Doors\/My Door\/data\/empty.dat/);
            assert.equal(fs.statSync(img).size, 2000 * 1024);

            r = oputil('create', img, door);
            assert.notEqual(r.status, 0);
            assert.match(r.stderr, /exists \(use --force/);

            r = oputil('create', img, '--force', '--name', 'Games', door);
            assert.equal(r.status, 0, r.stderr);
            assert.equal(fs.statSync(img).size, 2000 * 1024); // the default

            r = oputil('ls', img, 'Doors/My Door/data');
            assert.equal(r.status, 0, r.stderr);
            assert.match(
                r.stdout,
                /----rwed +12 +\d{4}-\d\d-\d\d \d\d:\d\d:\d\d +Doors\/My Door\/data\/scores\/hi.txt/
            );
            assert.doesNotMatch(r.stdout, /axshim/);

            r = oputil('info', img);
            assert.equal(r.status, 0, r.stderr);
            assert.match(r.stdout, /Volume: +Games/);
            assert.match(r.stdout, /FFS \(DOS1\)/);
            assert.doesNotMatch(r.stdout, /Problems/);
        });

        it('add a file into a directory, a tree under a new name; extract to stdout', () => {
            const img = path.join(dir, 'cli-add.hdf');
            assert.equal(oputil('create', img, '--size', '1M').status, 0);
            const lib = path.join(dir, 'mathieeedoubbas.library');
            fs.writeFileSync(lib, 'LIB');

            let r = oputil('add', img, lib, 'Libs');
            assert.equal(r.status, 0, r.stderr);
            r = oputil('add', img, door, 'BBS:Doors/Renamed');
            assert.equal(r.status, 0, r.stderr);
            r = oputil('add', img, lib);
            assert.equal(r.status, 0, r.stderr);

            const vol = AmigaVolume.openFile(img);
            assert.equal(vol.readFile('Libs/mathieeedoubbas.library').toString(), 'LIB');
            assert.equal(vol.readFile('mathieeedoubbas.library').toString(), 'LIB');
            assert.equal(
                vol.readFile('Doors/Renamed/data/scores/hi.txt').toString(),
                'HIGH SCORES\n'
            );
            assert.deepEqual(vol.check(), []);

            r = oputil('extract', img, 'S/Startup-Sequence', '-');
            assert.equal(r.status, 0, r.stderr);
            assert.equal(
                r.stdout,
                fs.readFileSync(path.join(AMIGA_DIR, 'image/Startup-Sequence'), 'utf8')
            );
        });

        it('keeps a numeric door directory name as typed', () => {
            const cwd = fs.mkdtempSync(path.join(dir, 'num-'));
            fs.mkdirSync(path.join(cwd, '007'));
            fs.writeFileSync(path.join(cwd, '007', 'bond'), 'B');
            fs.mkdirSync(path.join(cwd, '010'));
            const r = spawnSync(
                process.execPath,
                [OPUTIL, 'amiga-door', 'create', 'n.hdf', '--doors', '010', '007'],
                { encoding: 'utf8', cwd }
            );
            assert.equal(r.status, 0, r.stderr);
            const vol = AmigaVolume.openFile(path.join(cwd, 'n.hdf'));
            assert.deepEqual(
                vol.list('Doors').map(e => e.name),
                ['007', '010']
            );
            assert.equal(vol.readFile('Doors/007/bond').toString(), 'B');
        });

        it('changes an image through a symbolic link and keeps its mode', function () {
            if (process.platform === 'win32') return this.skip();
            const img = path.join(dir, 'moded.hdf');
            const link = path.join(dir, 'moded-link.hdf');
            assert.equal(oputil('create', img, '--size', '1M').status, 0);
            fs.chmodSync(img, 0o640);
            fs.symlinkSync(img, link);
            const f = path.join(dir, 'via-link.txt');
            fs.writeFileSync(f, 'L');

            const r = oputil('add', link, f);
            assert.equal(r.status, 0, r.stderr);
            assert.ok(fs.lstatSync(link).isSymbolicLink());
            assert.equal(fs.statSync(img).mode & 0o777, 0o640);
            assert.equal(
                AmigaVolume.openFile(img).readFile('via-link.txt').toString(),
                'L'
            );
        });

        it('reports a file system error in one line', function () {
            if (process.platform === 'win32' || process.getuid() === 0)
                return this.skip();
            const ro = fs.mkdtempSync(path.join(dir, 'ro-'));
            const img = path.join(ro, 'ro.hdf');
            assert.equal(oputil('create', img, '--size', '1M').status, 0);
            fs.chmodSync(ro, 0o555);
            try {
                const r = oputil('add', img, path.join(dir, 'via-link.txt'));
                assert.notEqual(r.status, 0);
                assert.match(r.stderr, /^amiga-door: EACCES: permission denied/);
                assert.equal(r.stderr.trim().split('\n').length, 1, r.stderr);
            } finally {
                fs.chmodSync(ro, 0o755);
            }

            const r = oputil(
                'create',
                path.join(dir, 'g2.hdf'),
                '--size',
                '2G',
                '--allow-large'
            );
            assert.notEqual(r.status, 0);
            assert.equal(
                r.stderr.trim(),
                'amiga-door: size too large: 2G (at most 2097144K, 8K short of 2G)'
            );
        });

        it('says what is wrong rather than throwing', () => {
            let r = oputil('ls', path.join(dir, 'missing.hdf'));
            assert.notEqual(r.status, 0);
            assert.match(r.stderr, /amiga-door: no such image/);

            const notAmiga = path.join(dir, 'zeros.hdf');
            fs.writeFileSync(notAmiga, Buffer.alloc(65536));
            r = oputil('info', notAmiga);
            assert.match(r.stderr, /amiga-door: not an AmigaDOS/);

            r = oputil(
                'extract',
                path.join(dir, 'cli-add.hdf'),
                'nope',
                path.join(dir, 'n')
            );
            assert.match(r.stderr, /amiga-door: no such file or directory: nope/);

            r = oputil('frobnicate', 'x.hdf');
            assert.notEqual(r.status, 0);
            assert.match(r.stderr, /usage: oputil.js amiga-door/);
        });
    });
});
