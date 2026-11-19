'use strict';

//
//  file_util's collision-handled move and copy never replace an existing
//  file, even when many callers race for the same name (#291 security
//  review: quarantining ten "same.zip" at once left two files).
//

const { strict: assert } = require('assert');
const fs = require('fs');
const os = require('os');
const paths = require('path');

describe('file_util collision handling', function () {
    let dir;
    let FileUtil;
    let gfs;
    let realLink;

    before(() => {
        FileUtil = require('../core/file_util.js');
        gfs = require('graceful-fs');
        realLink = gfs.link;
    });

    beforeEach(() => {
        dir = fs.realpathSync(fs.mkdtempSync(paths.join(os.tmpdir(), 'enig-fu-')));
        fs.mkdirSync(paths.join(dir, 'dst'));
    });

    afterEach(() => {
        gfs.link = realLink; //  a failed test must not leave link() stubbed
        fs.rmSync(dir, { recursive: true, force: true });
    });

    //  N files called same.zip, each with its own content, in N directories
    const sources = n =>
        Array.from({ length: n }, (_, i) => {
            const d = fs.mkdtempSync(paths.join(dir, 'src-'));
            const p = paths.join(d, 'same.zip');
            fs.writeFileSync(p, `payload-${i}`);
            return p;
        });

    const race = (op, srcs, cb) => {
        const finals = [];
        srcs.forEach(src => {
            op(src, paths.join(dir, 'dst', 'same.zip'), (err, finalPath) => {
                assert.ifError(err);
                finals.push(finalPath);
                if (finals.length === srcs.length) {
                    return cb(finals);
                }
            });
        });
    };

    const assertAllKept = (finals, n) => {
        const names = fs.readdirSync(paths.join(dir, 'dst'));
        assert.equal(new Set(finals).size, n, 'each caller got its own name');
        assert.equal(names.length, n, 'no file replaced another');
        const contents = names.map(f =>
            fs.readFileSync(paths.join(dir, 'dst', f), 'utf8')
        );
        assert.equal(new Set(contents).size, n);
        assert.ok(names.includes('same.zip'));
        assert.ok(names.includes('same(1).zip'));
    };

    it('moves ten files of the same name at once without losing one', done => {
        const srcs = sources(10);
        race(FileUtil.moveFileWithCollisionHandling, srcs, finals => {
            assertAllKept(finals, 10);
            srcs.forEach(src => assert.equal(fs.existsSync(src), false));
            done();
        });
    });

    it('copies ten files of the same name at once without losing one', done => {
        const srcs = sources(10);
        race(FileUtil.copyFileWithCollisionHandling, srcs, finals => {
            assertAllKept(finals, 10);
            srcs.forEach(src => assert.equal(fs.existsSync(src), true));
            done();
        });
    });

    it('falls back to an exclusive copy where hard links are not available', done => {
        const link = gfs.link;
        gfs.link = (src, dst, cb) => {
            const err = new Error('cross-device link not permitted');
            err.code = 'EXDEV';
            process.nextTick(cb, err);
        };

        const srcs = sources(5);
        race(FileUtil.moveFileWithCollisionHandling, srcs, finals => {
            gfs.link = link;
            assertAllKept(finals, 5);
            srcs.forEach(src => assert.equal(fs.existsSync(src), false));
            done();
        });
    });

    //  Windows reports a failed CreateHardLink (FAT, exFAT, some SMB shares)
    //  with codes such as EISDIR or EINVAL: anything but EEXIST/ENOENT must
    //  fall back to the copy, or the move hard-fails where fs-extra moved.
    ['EINVAL', 'EISDIR'].forEach(code => {
        it(`falls back to the exclusive copy when link() fails with ${code}`, done => {
            gfs.link = (src, dst, cb) => {
                const err = new Error(`link failed: ${code}`);
                err.code = code;
                process.nextTick(cb, err);
            };

            const srcs = sources(3);
            race(FileUtil.moveFileWithCollisionHandling, srcs, finals => {
                const names = fs.readdirSync(paths.join(dir, 'dst'));
                assert.equal(new Set(finals).size, 3);
                assert.equal(names.length, 3);
                srcs.forEach(src => assert.equal(fs.existsSync(src), false));
                done();
            });
        });
    });

    it('refuses to move or copy a file onto itself', done => {
        const src = paths.join(dir, 'dst', 'a.txt');
        fs.writeFileSync(src, 'mine');
        //  the same file under a non-normalized path is still the same file
        const alias = paths.join(dir, 'dst', '..', 'dst', 'a.txt');
        FileUtil.moveFileWithCollisionHandling(src, alias, (err, finalPath) => {
            assert.ok(err, 'a same-path move is an error');
            assert.equal(finalPath, undefined);
            FileUtil.copyFileWithCollisionHandling(src, src, err => {
                assert.ok(err, 'a same-path copy is an error');
                assert.deepEqual(fs.readdirSync(paths.join(dir, 'dst')), ['a.txt']);
                assert.equal(fs.readFileSync(src, 'utf8'), 'mine');
                done();
            });
        });
    });

    it('refuses a destination that is a hard link to the source', done => {
        const src = paths.join(dir, 'a.txt');
        fs.writeFileSync(src, 'mine');
        const dst = paths.join(dir, 'dst', 'a.txt');
        fs.linkSync(src, dst);
        FileUtil.moveFileWithCollisionHandling(src, dst, err => {
            assert.ok(err);
            assert.equal(fs.existsSync(src), true);
            assert.deepEqual(fs.readdirSync(paths.join(dir, 'dst')), ['a.txt']);
            done();
        });
    });

    it('returns the path it moved to, and keeps an existing file', done => {
        fs.writeFileSync(paths.join(dir, 'dst', 'a.txt'), 'old');
        const src = paths.join(dir, 'a.txt');
        fs.writeFileSync(src, 'new');
        FileUtil.moveFileWithCollisionHandling(
            src,
            paths.join(dir, 'dst', 'a.txt'),
            (err, finalPath) => {
                assert.ifError(err);
                assert.equal(finalPath, paths.join(dir, 'dst', 'a(1).txt'));
                assert.equal(
                    fs.readFileSync(paths.join(dir, 'dst', 'a.txt'), 'utf8'),
                    'old'
                );
                assert.equal(fs.readFileSync(finalPath, 'utf8'), 'new');
                done();
            }
        );
    });

    it('creates the destination directory, as fs-extra did', done => {
        const src = paths.join(dir, 'a.txt');
        fs.writeFileSync(src, 'x');
        const dst = paths.join(dir, 'new', 'deeper', 'a.txt');
        FileUtil.moveFileWithCollisionHandling(src, dst, (err, finalPath) => {
            assert.ifError(err);
            assert.equal(finalPath, dst);
            const copySrc = paths.join(dir, 'b.txt');
            fs.writeFileSync(copySrc, 'y');
            const copyDst = paths.join(dir, 'other', 'b.txt');
            FileUtil.copyFileWithCollisionHandling(copySrc, copyDst, err => {
                assert.ifError(err);
                assert.equal(fs.readFileSync(copyDst, 'utf8'), 'y');
                done();
            });
        });
    });

    it('is an error, not a loop, when the source is missing', done => {
        FileUtil.moveFileWithCollisionHandling(
            paths.join(dir, 'nope.txt'),
            paths.join(dir, 'dst', 'nope.txt'),
            err => {
                assert.equal(err && err.code, 'ENOENT');
                done();
            }
        );
    });

    it('creates nothing when the source is missing', done => {
        const newDir = paths.join(dir, 'new');
        FileUtil.moveFileWithCollisionHandling(
            paths.join(dir, 'nope.txt'),
            paths.join(newDir, 'deeper', 'nope.txt'),
            err => {
                assert.equal(err && err.code, 'ENOENT');
                FileUtil.copyFileWithCollisionHandling(
                    paths.join(dir, 'nope.txt'),
                    paths.join(newDir, 'nope.txt'),
                    err => {
                        assert.equal(err && err.code, 'ENOENT');
                        assert.equal(fs.existsSync(newDir), false);
                        done();
                    }
                );
            }
        );
    });

    it('names Windows device names', () => {
        const is = FileUtil.isWindowsDeviceName;
        ['CON', 'con.txt', 'NUL.ZIP', 'aux .txt', 'COM1', 'lpt9.tar.gz', 'PRN.'].forEach(
            n => assert.equal(is(n), true, n)
        );
        ['CONSOLE', 'COM10', 'x.con', 'nul_file', ''].forEach(n =>
            assert.equal(is(n), false, n)
        );
    });
});
