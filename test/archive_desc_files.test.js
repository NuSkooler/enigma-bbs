'use strict';

//
//  scanFile() takes an uploaded archive's description from the FILE_ID.DIZ,
//  README, NFO etc. inside it (fileBase.fileNamePatterns). Archivers disagree
//  on whether an extracted entry keeps its path -- unzip and tar do, 7za e and
//  unrar e do not -- so the file is looked for both ways. A description file
//  that is the archive's only entry is still a description file.
//
//  Names from the archive listing are untrusted: whatever an entry is called,
//  and even if it is a symbolic link, only a file that stays inside the temp
//  directory is ever read.
//
//  Archives are built at test time with the archivers installed here; a case
//  whose archiver is missing is skipped. The ZIP and tar cases with unusual
//  entry names are written by hand below, as the archivers refuse to make them.
//  unzip and tar will not extract a ".." or absolute name where it points, so
//  those names are also put through a stand-in archiver that flattens paths
//  and does extract them: only the lookup then stands between the name and
//  the file it points at.
//

const { strict: assert } = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const paths = require('path');
const zlib = require('zlib');
const Database = require('better-sqlite3');

const configModule = require('../core/config.js');
const configDefault = require('../core/config_default.js');
const dbModule = require('../core/database.js');
const loggerModule = require('../core/logger.js');

const OUTSIDE_TEXT = 'OUTSIDE THE TEMP DIRECTORY';
const FlatArchiver = paths.join(
    __dirname,
    'fixtures',
    'archive_desc_files',
    'flat_archiver.js'
);
const FLAT_MIME = 'application/x-enig-flat-test';

//  file_base_area captures Config, the file DB and the logger when first
//  required, and ArchiveUtil keeps a singleton built from the config of the
//  day: both are loaded afresh here, and the cached copies put back after.
const FRESH = ['../core/file_base_area.js', '../core/archive_util.js'];

const haveCache = {};
function installed(cmd) {
    if (!(cmd in haveCache)) {
        haveCache[cmd] =
            0 ===
            spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status;
    }
    return haveCache[cmd];
}

function run(cmd, args, cwd) {
    const res = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
    if (0 !== res.status) {
        throw new Error(`${cmd} ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
    }
}

//  A stored (uncompressed) ZIP. |mode| sets the Unix mode, so an entry can be
//  a symbolic link whose data is its target.
function makeZip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    entries.forEach(({ name, data, mode = 0o100644 }) => {
        const nameBuf = Buffer.from(name, 'latin1');
        const dataBuf = Buffer.from(data);
        const crc = zlib.crc32(dataBuf);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 10); //  time
        local.writeUInt16LE(0x21, 12); //  date: 1980-01-01
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(dataBuf.length, 18);
        local.writeUInt32LE(dataBuf.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        locals.push(local, nameBuf, dataBuf);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE((3 << 8) | 20, 4); //  made by Unix
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0, 12);
        central.writeUInt16LE(0x21, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(dataBuf.length, 20);
        central.writeUInt32LE(dataBuf.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt32LE(mode * 0x10000, 38);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, nameBuf);

        offset += local.length + nameBuf.length + dataBuf.length;
    });

    const cd = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, end]);
}

//  A gzipped ustar archive. |link| makes the entry a symbolic link.
function makeTarGz(entries) {
    const blocks = [];
    entries.forEach(({ name, data = '', link }) => {
        const dataBuf = Buffer.from(link ? '' : data);
        const header = Buffer.alloc(512);
        header.write(name, 0, 100, 'latin1');
        header.write(link ? '0000777\0' : '0000644\0', 100);
        header.write('0000000\0', 108);
        header.write('0000000\0', 116);
        header.write(`${dataBuf.length.toString(8).padStart(11, '0')}\0`, 124);
        header.write('14524716400\0', 136); //  2023-11-14
        header.fill(32, 148, 156);
        header.write(link ? '2' : '0', 156);
        if (link) {
            header.write(link, 157, 100, 'latin1');
        }
        header.write('ustar\0', 257);
        header.write('00', 263);
        header.write('enigma', 265);
        header.write('enigma', 297);
        const checksum = header.reduce((sum, byte) => sum + byte, 0);
        header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);

        const padded = Buffer.alloc(Math.ceil(dataBuf.length / 512) * 512);
        dataBuf.copy(padded);
        blocks.push(header, padded);
    });
    blocks.push(Buffer.alloc(1024));
    return zlib.gzipSync(Buffer.concat(blocks));
}

describe('Description files in uploaded archives', function () {
    this.timeout(20000);

    let FileArea;
    let previousConfig;
    let previousLog;
    let previousFileDb;
    const savedModules = {};
    const debugLogged = [];
    let dir;
    let outsideFile;
    let outsidePdf;

    before(done => {
        const config = configDefault();

        //  a stand-in for exiftool: the "description" of a PDF is its contents
        config.infoExtractUtils.TestCat = {
            cmd: process.execPath,
            args: [
                '-e',
                'process.stdout.write(require("fs").readFileSync(process.argv[1]))',
                '{filePath}',
            ],
        };
        config.fileTypes['application/pdf'] = {
            desc: 'Adobe PDF',
            shortDescUtil: 'TestCat',
        };

        config.archives.archivers.FlatTest = {
            list: {
                cmd: process.execPath,
                args: [FlatArchiver, 'list', '{archivePath}'],
                outputFormat: 'json',
            },
            extract: {
                cmd: process.execPath,
                args: [
                    FlatArchiver,
                    'extract',
                    '{archivePath}',
                    '{extractPath}',
                    '{fileList}',
                ],
            },
        };
        config.fileTypes[FLAT_MIME] = {
            desc: 'Flat test archive',
            ext: '.flat',
            archiveHandler: 'FlatTest',
        };
        previousConfig = configModule._pushTestConfig(config);

        previousFileDb = dbModule.dbs.file;
        const db = new Database(':memory:');
        db.exec(
            'CREATE TABLE file (file_id INTEGER PRIMARY KEY, area_tag, file_sha256);'
        );
        dbModule.dbs.file = db;

        previousLog = loggerModule.log;
        const noop = () => {};
        const log = {
            warn: noop,
            info: noop,
            trace: noop,
            error: noop,
            debug: (obj, msg) => debugLogged.push({ obj, msg }),
            child: () => log,
        };
        loggerModule.log = log;

        FRESH.forEach(m => {
            const key = require.resolve(m);
            savedModules[key] = require.cache[key];
            delete require.cache[key];
        });
        FileArea = require('../core/file_base_area.js');
        require('../core/archive_util.js').getInstance(false);

        require('../core/mime_util.js').startup(err => {
            require('mime-types').extensions[FLAT_MIME] = ['flat'];
            return done(err);
        });
    });

    after(() => {
        delete require('mime-types').extensions[FLAT_MIME];
        Object.entries(savedModules).forEach(([key, mod]) => {
            if (mod) {
                require.cache[key] = mod;
            } else {
                delete require.cache[key];
            }
        });
        loggerModule.log = previousLog;
        dbModule.dbs.file.close();
        dbModule.dbs.file = previousFileDb;
        configModule._popTestConfig(previousConfig);
    });

    beforeEach(() => {
        dir = fs.realpathSync(fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-desc-')));
        fs.mkdirSync(paths.join(dir, 'src'));
        fs.mkdirSync(paths.join(dir, 'outside'));
        outsideFile = paths.join(dir, 'outside', 'FILE_ID.DIZ');
        fs.writeFileSync(outsideFile, OUTSIDE_TEXT);
        outsidePdf = paths.join(dir, 'outside', 'secret.pdf');
        fs.writeFileSync(outsidePdf, OUTSIDE_TEXT);
        debugLogged.length = 0;
    });

    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    //  writes |files| ({ 'sub/FILE_ID.DIZ': 'text' }) under src/
    const writeSource = files => {
        Object.entries(files).forEach(([name, data]) => {
            const path = paths.join(dir, 'src', name);
            fs.mkdirSync(paths.dirname(path), { recursive: true });
            fs.writeFileSync(path, data);
        });
        return Object.keys(files);
    };

    //  scans |archivePath|, then runs |check| on the entry and ends the test
    const scan = (archivePath, done, check) =>
        FileArea.scanFile(archivePath, { areaTag: 'test' }, (err, fileEntry) => {
            try {
                assert.ifError(err);
                check(fileEntry);
            } catch (e) {
                return done(e);
            }
            return done();
        });

    //  How each archiver makes an archive of src/'s |names|, keeping their paths
    const builders = {
        zip: {
            needs: ['zip', 'unzip'],
            make: (archive, names) => run('zip', ['-q', archive, ...names], srcDir()),
        },
        'tar.gz': {
            needs: ['tar'],
            make: (archive, names) => run('tar', ['-czf', archive, ...names], srcDir()),
        },
        '7z': {
            needs: ['7za'],
            make: (archive, names) =>
                run('7za', ['a', '-bd', archive, ...names], srcDir()),
        },
        rar: {
            needs: ['rar', 'unrar'],
            make: (archive, names) =>
                run('rar', ['a', '-idq', archive, ...names], srcDir()),
        },
    };
    const srcDir = () => paths.join(dir, 'src');

    //  an archive for the stand-in archiver that flattens paths
    const writeFlat = entries => {
        const archive = paths.join(dir, 'upload.flat');
        fs.writeFileSync(archive, JSON.stringify({ entries }));
        return archive;
    };

    const build = (test, ext, files) => {
        const builder = builders[ext];
        if (!builder.needs.every(installed)) {
            return test.skip();
        }
        const archive = paths.join(dir, `upload.${ext}`);
        builder.make(archive, writeSource(files));
        return archive;
    };

    describe('in a subdirectory', () => {
        Object.keys(builders).forEach(ext => {
            it(`reads sub/FILE_ID.DIZ and sub/README from a ${ext}`, function (done) {
                const archive = build(this, ext, {
                    'sub/FILE_ID.DIZ': 'Short from the DIZ',
                    'sub/README': 'Long from the README',
                    'sub/a.txt': 'payload',
                });
                scan(archive, done, fileEntry => {
                    assert.equal(fileEntry.desc, 'Short from the DIZ');
                    assert.equal(fileEntry.descSrc, 'descFile');
                    assert.equal(fileEntry.descLong, 'Long from the README');
                });
            });
        });
    });

    describe('as the only entry', () => {
        ['zip', '7z', 'rar'].forEach(ext => {
            it(`reads a lone FILE_ID.DIZ from a ${ext}`, function (done) {
                const archive = build(this, ext, { 'FILE_ID.DIZ': 'Only the DIZ' });
                scan(archive, done, fileEntry => {
                    assert.equal(fileEntry.desc, 'Only the DIZ');
                    assert.equal(fileEntry.descSrc, 'descFile');
                });
            });
        });

        ['tar.gz', 'zip'].forEach(ext => {
            it(`reads a lone README from a ${ext}`, function (done) {
                const archive = build(this, ext, { README: 'Only the README' });
                scan(archive, done, fileEntry => {
                    assert.equal(fileEntry.descLong, 'Only the README');
                    assert.equal(fileEntry.descLongSrc, 'descFile');
                });
            });
        });

        //  flattened by 7za e, so found by its base name
        it('reads a lone docs/FILE_ID.DIZ from a 7z', function (done) {
            const archive = build(this, '7z', { 'docs/FILE_ID.DIZ': 'Deep DIZ' });
            scan(archive, done, fileEntry => {
                assert.equal(fileEntry.desc, 'Deep DIZ');
            });
        });

        it('reads a lone docs/FILE_ID.DIZ from an archiver that flattens paths', done => {
            const archive = writeFlat([{ name: 'docs/FILE_ID.DIZ', data: 'Deep DIZ' }]);
            scan(archive, done, fileEntry => {
                assert.equal(fileEntry.desc, 'Deep DIZ');
            });
        });

        it('finds a lone docs/manual.pdf from an archiver that flattens paths', done => {
            const archive = writeFlat([{ name: 'docs/manual.pdf', data: 'Manual text' }]);
            scan(archive, done, fileEntry => {
                assert.equal(fileEntry.desc, 'Manual text');
            });
        });

        //  any other lone entry still goes to its file type's info extractor
        ['7z', 'rar', 'zip', 'tar.gz'].forEach(ext => {
            it(`finds a lone docs/manual.pdf in a ${ext}`, function (done) {
                const archive = build(this, ext, { 'docs/manual.pdf': 'Manual text' });
                scan(archive, done, fileEntry => {
                    assert.equal(fileEntry.desc, 'Manual text');
                });
            });
        });
    });

    describe('reads nothing outside the temp directory', () => {
        //  however the scan ends, the outside file's text is never taken
        const assertNotRead = fileEntry => {
            [fileEntry.desc, fileEntry.descLong].forEach(text => {
                assert.ok(!String(text || '').includes(OUTSIDE_TEXT), text);
            });
        };

        const climbing = () => `${'../'.repeat(24)}${outsideFile.slice(1)}`;

        const writeArchive = (name, bytes) => {
            const archive = paths.join(dir, name);
            fs.writeFileSync(archive, bytes);
            return archive;
        };

        const zipCase = (what, entries) => {
            it(`from a zip ${what}`, function (done) {
                if (!installed('unzip')) {
                    return this.skip();
                }
                const archive = writeArchive('upload.zip', makeZip(entries()));
                scan(archive, done, fileEntry => {
                    assertNotRead(fileEntry);
                });
            });
        };

        const tarCase = (what, entries) => {
            it(`from a tar.gz ${what}`, function (done) {
                if (!installed('tar')) {
                    return this.skip();
                }
                const archive = writeArchive('upload.tar.gz', makeTarGz(entries()));
                scan(archive, done, fileEntry => {
                    assertNotRead(fileEntry);
                });
            });
        };

        const payload = { name: 'a.txt', data: 'payload' };

        //  the stand-in extracts every name, flattened: the archive's own copy
        //  is what gets read, never the file the name points at
        const flatCase = (what, entries, field = 'desc') => {
            it(`from an archiver that flattens paths, ${what}`, done => {
                scan(writeFlat(entries()), done, fileEntry => {
                    assertNotRead(fileEntry);
                    assert.equal(fileEntry[field], 'archive copy');
                });
            });
        };

        flatCase('entry named with ".." segments', () => [
            { name: climbing(), data: 'archive copy' },
            payload,
        ]);
        flatCase('lone entry named with ".." segments', () => [
            { name: climbing(), data: 'archive copy' },
        ]);
        flatCase('entry with an absolute name', () => [
            { name: outsideFile, data: 'archive copy' },
            payload,
        ]);
        flatCase('lone non-description entry named with ".." segments', () => [
            { name: `${'../'.repeat(24)}${outsidePdf.slice(1)}`, data: 'archive copy' },
        ]);
        flatCase('lone non-description entry with an absolute name', () => [
            { name: outsidePdf, data: 'archive copy' },
        ]);

        zipCase('entry named with ".." segments', () => [
            { name: climbing(), data: 'archive copy' },
            payload,
        ]);
        zipCase('lone entry named with ".." segments', () => [
            { name: climbing(), data: 'archive copy' },
        ]);
        zipCase('entry with an absolute name', () => [
            { name: outsideFile, data: 'archive copy' },
            payload,
        ]);
        zipCase('lone entry with an absolute name', () => [
            { name: outsideFile, data: 'archive copy' },
        ]);
        zipCase('symbolic link entry', () => [
            { name: 'FILE_ID.DIZ', data: outsideFile, mode: 0o120777 },
            payload,
        ]);
        zipCase('lone symbolic link entry', () => [
            { name: 'FILE_ID.DIZ', data: outsideFile, mode: 0o120777 },
        ]);
        zipCase('symbolic link entry in a subdirectory', () => [
            { name: 'sub/FILE_ID.DIZ', data: outsideFile, mode: 0o120777 },
            payload,
        ]);

        tarCase('entry named with ".." segments', () => [
            { name: climbing(), data: 'archive copy' },
            payload,
        ]);
        tarCase('entry with an absolute name', () => [
            { name: outsideFile, data: 'archive copy' },
            payload,
        ]);
        tarCase('symbolic link entry', () => [
            { name: 'FILE_ID.DIZ', link: outsideFile },
            payload,
        ]);
        tarCase('lone symbolic link entry', () => [
            { name: 'sub/FILE_ID.DIZ', link: outsideFile },
        ]);

        it('logs a description file it would not read', function (done) {
            if (!installed('unzip')) {
                return this.skip();
            }
            const archive = writeArchive(
                'upload.zip',
                makeZip([
                    { name: 'FILE_ID.DIZ', data: outsideFile, mode: 0o120777 },
                    payload,
                ])
            );
            scan(archive, done, fileEntry => {
                assertNotRead(fileEntry);
                assert.ok(
                    debugLogged.some(
                        l =>
                            /not found after extraction/.test(l.msg) &&
                            'FILE_ID.DIZ' === l.obj.entry
                    ),
                    JSON.stringify(debugLogged)
                );
            });
        });
    });
});
