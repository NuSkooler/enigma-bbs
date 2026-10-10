'use strict';

const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const paths = require('path');

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

        it('needs the whole signature, not a prefix of it', done => {
            util.detectType(writeFile('short', Buffer.from('xx-l')), err => {
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
});
