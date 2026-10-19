'use strict';

const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const paths = require('path');
const pty = require('node-pty');
const zlib = require('zlib');

const configModule = require('../core/config.js');
const configDefault = require('../core/config_default.js');

const FakeUnarc = paths.join(__dirname, 'fixtures', 'archive_util', 'fake_unarc.js');

describe('ArchiveUtil', () => {
    let ArchiveUtil;
    let previousConfig;
    let util;
    let dir;

    before(done => {
        const { fileTypes, archives } = configDefault();
        archives.archivers.FakeUnarc = {
            list: {
                cmd: process.execPath,
                args: [FakeUnarc, '{archivePath}'],
                outputFormat: 'json',
            },
        };
        fileTypes['application/x-fake'] = { desc: 'Fake', archiveHandler: 'FakeUnarc' };
        previousConfig = configModule._pushTestConfig({ fileTypes, archives });

        ArchiveUtil = require('../core/archive_util.js');
        util = new ArchiveUtil();
        util.init(false);

        //  getArchiver() resolves MIME types through mime_util's registrations
        require('../core/mime_util.js').startup(err => {
            require('mime-types').extensions['application/x-fake'] = ['fake'];
            return done(err);
        });
    });

    after(() => configModule._popTestConfig(previousConfig));

    beforeEach(() => {
        dir = fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-archive-util-'));
    });

    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const writeFile = (name, bytes) => {
        const path = paths.join(dir, name);
        fs.writeFileSync(path, bytes);
        return path;
    };

    describe('detectType()', () => {
        const header = (offset, magic, length = 512) => {
            const buf = Buffer.alloc(length);
            Buffer.from(magic, 'binary').copy(buf, offset);
            return buf;
        };

        [
            ['an LHA -lh5- archive', header(2, '-lh5-'), 'application/x-lzh-compressed'],
            ['an LArc -lz5- archive', header(2, '-lz5-'), 'application/x-lzh-compressed'],
            ['a tar archive', header(257, 'ustar\x0000'), 'application/x-tar'],
            ['an ARC archive', header(0, '\x1a\x08HELLO.TXT'), 'application/x-arc'],
            ['a PAK archive', header(0, '\x1a\x0bHELLO.TXT'), 'application/x-arc'],
            ['an encrypted UC2 archive', header(0, 'UE2'), 'application/x-uc2'],
            ['an ACE archive', header(7, '**ACE**'), 'application/x-ace-compressed'],
            ['an xz stream', header(0, '\xfd7zXZ\x00'), 'application/x-xz'],
            ['a Zstandard stream', header(0, '\x28\xb5\x2f\xfd'), 'application/zstd'],
            ['a cabinet', header(0, 'MSCF'), 'application/vnd.ms-cab-compressed'],
            ['a C64S T64 image', header(0, 'C64S tape file'), 'application/x-t64'],
            ['a C64 T64 image', header(0, 'C64 tape image file'), 'application/x-t64'],
        ].forEach(([what, bytes, expected]) => {
            it(`detects ${what}`, done => {
                util.detectType(writeFile('archive', bytes), (err, type) => {
                    assert.ifError(err);
                    assert.equal(type, expected);
                    done();
                });
            });
        });

        it('does not take 0x1a without an ARC method for ARC', done => {
            util.detectType(writeFile('text', header(0, '\x1a\x00')), err => {
                assert.ok(err);
                done();
            });
        });

        describe('without a signature to match', () => {
            [
                ['GAME.LNX', 'application/x-lnx'],
                ['disk.d64', 'application/x-d64'],
            ].forEach(([name, expected]) => {
                it(`takes ${name} from its extension`, done => {
                    util.detectType(
                        writeFile(name, header(0, 'no magic here')),
                        (err, type) => {
                            assert.ifError(err);
                            assert.equal(type, expected);
                            done();
                        }
                    );
                });
            });

            //  a ZIP named .d64 is still a ZIP
            it('prefers a signature to the extension', done => {
                util.detectType(
                    writeFile('misnamed.d64', header(0, 'PK\x03\x04')),
                    (err, type) => {
                        assert.ifError(err);
                        assert.equal(type, 'application/zip');
                        done();
                    }
                );
            });

            //  .dms and .atr have signatures; their extension alone is not enough
            it('does not use the extension of a type that has a signature', done => {
                util.detectType(
                    writeFile('game.atr', header(0, 'no magic here')),
                    err => {
                        assert.ok(err);
                        done();
                    }
                );
            });
        });

        it('needs the whole signature, not a prefix of it', done => {
            util.detectType(writeFile('short', Buffer.from('xx-l')), err => {
                assert.ok(err);
                done();
            });
        });
    });

    describe('getArchiver()', () => {
        //  types that share application/octet-stream are told apart by extension
        [
            ['application/octet-stream', '.DMS', 'unarc'],
            ['application/x-d64', '.d64', 'unarc'],
            //  unarc is not shipped: these keep the tools they had
            ['application/octet-stream', '.atr', 'atr'],
            ['application/x-lzx', '.lzx', 'unlzx'],
        ].forEach(([type, ext, cmd]) => {
            it(`hands ${ext} to ${cmd}`, () => {
                const archiver = util.getArchiver(type, ext);
                assert.ok(archiver, `no archiver for ${type} ${ext}`);
                assert.equal(archiver.list.cmd, cmd);
            });
        });
    });

    describe('findExtractedFile()', () => {
        let outside;

        beforeEach(() => {
            //  a file next to the extraction directory, which must never be returned
            fs.mkdirSync(paths.join(dir, 'x'));
            outside = writeFile('secret.pdf', 'private');
        });

        const find = (entryName, cb) =>
            ArchiveUtil.findExtractedFile(paths.join(dir, 'x'), entryName, cb);
        const realX = () => fs.realpathSync(paths.join(dir, 'x'));

        it('finds an entry extracted with its path', done => {
            fs.mkdirSync(paths.join(dir, 'x', 'sub'));
            fs.writeFileSync(paths.join(dir, 'x', 'sub', 'FILE_ID.DIZ'), 'diz');
            find('sub/FILE_ID.DIZ', (err, path) => {
                assert.ifError(err);
                assert.equal(path, paths.join(realX(), 'sub', 'FILE_ID.DIZ'));
                done();
            });
        });

        //  7za e, unrar e and arj e drop the path
        it('finds an entry extracted without its path', done => {
            fs.writeFileSync(paths.join(dir, 'x', 'FILE_ID.DIZ'), 'diz');
            find('sub/FILE_ID.DIZ', (err, path) => {
                assert.ifError(err);
                assert.equal(path, paths.join(realX(), 'FILE_ID.DIZ'));
                done();
            });
        });

        it('never climbs out of the directory', done => {
            find('../secret.pdf', err => {
                assert.ok(err);
                done();
            });
        });

        //  the flattened copy is the archive's own file; the outside one is not read
        it('reads a flattened copy rather than the file a ".." name points at', done => {
            fs.writeFileSync(paths.join(dir, 'x', 'secret.pdf'), 'from the archive');
            find('../secret.pdf', (err, path) => {
                assert.ifError(err);
                assert.equal(path, paths.join(realX(), 'secret.pdf'));
                assert.notEqual(path, fs.realpathSync(outside));
                done();
            });
        });

        it('treats an absolute name as relative to the directory', done => {
            find(outside, err => {
                assert.ok(err);
                done();
            });
        });

        it('does not follow a symbolic link out of the directory', done => {
            fs.symlinkSync(outside, paths.join(dir, 'x', 'linked.pdf'));
            find('linked.pdf', err => {
                assert.ok(err);
                done();
            });
        });
    });

    describe('listEntries() with a JSON listing', () => {
        const listing = entries => JSON.stringify({ format: 'FAKE', entries }, null, 2);

        it('lists files and leaves out directories', done => {
            const archive = writeFile(
                'release.fake',
                listing([
                    { name: 'RELEASE/', kind: 'directory', size: 0 },
                    { name: 'RELEASE/FILE_ID.DIZ', kind: 'file', size: 412 },
                    { name: 'RELEASE/A "B" C.TXT', kind: 'file', size: 9 },
                ])
            );
            util.listEntries(archive, 'application/x-fake', (err, entries) => {
                assert.ifError(err);
                assert.deepEqual(entries, [
                    { byteSize: 412, fileName: 'RELEASE/FILE_ID.DIZ' },
                    { byteSize: 9, fileName: 'RELEASE/A "B" C.TXT' },
                ]);
                done();
            });
        });

        it('fails when the archiver does', done => {
            const archive = writeFile('broken.fail', listing([]));
            util.listEntries(archive, 'application/x-fake', err => {
                assert.ok(err);
                assert.match(err.message, /List failed/);
                done();
            });
        });

        it('fails on output that is not a listing', done => {
            const archive = writeFile('garbage.fake', 'Archive: garbage (FAKE)\n');
            util.listEntries(archive, 'application/x-fake', err => {
                assert.ok(err);
                assert.match(err.message, /not JSON/);
                done();
            });
        });
    });

    describe('bare gzip files', () => {
        const listWithOutput = (archive, output, cb) => {
            const originalSpawn = pty.spawn;
            pty.spawn = () => ({
                onData: handler => process.nextTick(() => handler(output)),
                onExit: handler => process.nextTick(() => handler({ exitCode: 0 })),
            });
            util.listEntries(archive, 'application/gzip', (err, entries) => {
                pty.spawn = originalSpawn;
                cb(err, entries);
            });
        };

        it('lists and extracts a gzip member as one file', done => {
            const content = Buffer.from('notes from the archive\n');
            const archive = writeFile('notes.txt.gz', zlib.gzipSync(content));
            const extractPath = paths.join(dir, 'extract');
            fs.mkdirSync(extractPath);

            listWithOutput(archive, '', (err, entries) => {
                assert.ifError(err);
                assert.deepEqual(entries, [
                    { byteSize: content.length, fileName: 'notes.txt' },
                ]);

                util.extractTo(
                    archive,
                    extractPath,
                    'application/gzip',
                    ['notes.txt'],
                    err => {
                        assert.ifError(err);
                        ArchiveUtil.findExtractedFile(
                            extractPath,
                            'notes.txt',
                            (err, extractedPath) => {
                                assert.ifError(err);
                                assert.deepEqual(fs.readFileSync(extractedPath), content);
                                done();
                            }
                        );
                    }
                );
            });
        });

        it('does not treat an empty tarball as a gzip member', done => {
            const archive = writeFile('empty.tar.gz', zlib.gzipSync(Buffer.alloc(1024)));
            listWithOutput(archive, '', (err, entries) => {
                assert.ifError(err);
                assert.deepEqual(entries, []);
                done();
            });
        });

        it('keeps a gzip-compressed tar archive on the tar path', done => {
            const header = Buffer.alloc(512);
            header.write('inside.txt', 0);
            header.write('0000644\0', 100);
            header.write('0000000\0', 108);
            header.write('0000000\0', 116);
            header.write('00000000003\0', 124);
            header.write('00000000000\0', 136);
            header.fill(32, 148, 156);
            header.write('ustar\0', 257);
            header.write('00', 263);
            const checksum = header.reduce((sum, byte) => sum + byte, 0);
            header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
            const tar = Buffer.concat([
                header,
                Buffer.from('abc'),
                Buffer.alloc(509),
                Buffer.alloc(1024),
            ]);
            const archive = writeFile('bundle.tar.gz', zlib.gzipSync(tar));

            listWithOutput(
                archive,
                '-rw-r--r-- 1/1 3 2026-01-01 00:00 inside.txt',
                (err, entries) => {
                    assert.ifError(err);
                    assert.deepEqual(entries, [{ byteSize: 3, fileName: 'inside.txt' }]);
                    done();
                }
            );
        });

        it('does not mistake a single zero-filled block for an empty tar', done => {
            const content = Buffer.alloc(600);
            content[512] = 1;
            const archive = writeFile('zeroes.bin.gz', zlib.gzipSync(content));
            listWithOutput(archive, '', (err, entries) => {
                assert.ifError(err);
                assert.deepEqual(entries, [
                    { byteSize: content.length, fileName: 'zeroes.bin' },
                ]);
                done();
            });
        });

        it('keeps an unusual archive basename inside the extraction directory', done => {
            const content = Buffer.from('safe');
            const archive = writeFile('...gz', zlib.gzipSync(content));
            const extractPath = paths.join(dir, 'unusual-name');
            fs.mkdirSync(extractPath);

            listWithOutput(archive, '', (err, entries) => {
                assert.ifError(err);
                assert.equal(entries[0].fileName, '...gz.contents');
                util.extractTo(
                    archive,
                    extractPath,
                    'application/gzip',
                    [entries[0].fileName],
                    err => {
                        assert.ifError(err);
                        const extractedPath = paths.join(
                            extractPath,
                            entries[0].fileName
                        );
                        assert.deepEqual(fs.readFileSync(extractedPath), content);
                        done();
                    }
                );
            });
        });

        it('preserves an existing file when the extraction path is already taken', done => {
            const archive = writeFile('notes.txt.gz', zlib.gzipSync(Buffer.from('new')));
            const extractPath = paths.join(dir, 'existing-file');
            fs.mkdirSync(extractPath);
            const existingPath = paths.join(extractPath, 'notes.txt');
            const existingContent = Buffer.from('keep this file');
            fs.writeFileSync(existingPath, existingContent);

            util.extractTo(
                archive,
                extractPath,
                'application/gzip',
                ['notes.txt'],
                err => {
                    assert.ok(err);
                    assert.deepEqual(fs.readFileSync(existingPath), existingContent);
                    done();
                }
            );
        });
    });
});
