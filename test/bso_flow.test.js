'use strict';

const { strict: assert } = require('assert');
const fsp = require('fs/promises');
const os = require('os');
const paths = require('path');

const {
    MAX_LINE_BYTES,
    parseFlowLine,
    parseFlowBuffer,
    serializeFlowLines,
    markedLine,
    flowHasLive,
    readFlowFile,
    rewriteFlowFile,
    withFlowFileWrite,
    isFlowTempFileName,
    printablePath,
    _hooks,
} = require('../core/bso_flow.js');

const latin1 = s => Buffer.from(s, 'latin1');

describe('bso_flow — parseFlowLine', () => {
    //  FTS-5005.003 sec. 3.1, and how binkd, Synchronet and Husky read them.
    const DIRECTIVES = [
        { d: '^', kind: 'send', disposition: 'delete' },
        { d: '-', kind: 'send', disposition: 'delete' },
        { d: '#', kind: 'send', disposition: 'truncate' },
        { d: '@', kind: 'send', disposition: 'keep' },
        { d: '', kind: 'send', disposition: 'keep' },
        { d: '~', kind: 'skip', disposition: null },
        { d: '!', kind: 'skip', disposition: null },
    ];

    for (const { d, kind, disposition } of DIRECTIVES) {
        const label = d || '(none)';

        it(`${label} + absolute path`, () => {
            const l = parseFlowLine(`${d}/ob/outbound/0000fc9c.pkt`);
            assert.equal(l.kind, kind);
            assert.equal(l.directive, d);
            assert.equal(l.disposition, disposition);
            assert.equal(l.path, '/ob/outbound/0000fc9c.pkt');
            assert.equal(l.relative, false);
            assert.equal(l.dos, false);
        });

        it(`${label} + DOS path`, () => {
            const l = parseFlowLine(`${d}C:\\FIDO\\OUTBOUND\\0000FC9C.MO1`);
            assert.equal(l.kind, kind);
            assert.equal(l.path, 'C:\\FIDO\\OUTBOUND\\0000FC9C.MO1');
            if ('send' === kind) {
                assert.equal(l.dos, true);
            }
            const unc = parseFlowLine(`${d}\\\\server\\share\\x.pkt`);
            assert.equal(unc.kind, kind);
            if ('send' === kind) {
                assert.equal(unc.dos, true);
            }
        });

        it(`${label} + bare relative name`, () => {
            const l = parseFlowLine(`${d}0000fc9c.mo1`);
            assert.equal(l.kind, kind);
            assert.equal(l.path, '0000fc9c.mo1');
            if ('send' === kind) {
                assert.equal(l.relative, true);
                assert.equal(l.disposition, disposition);
            }
        });

        it(`${label} + a relative path climbing out with ..`, () => {
            const l = parseFlowLine(`${d}../config/config.hjson`);
            assert.equal(l.kind, kind);
            if ('send' === kind) {
                assert.equal(l.relative, true, 'resolved against the flow file dir');
            }
        });

        it(`${label} + nothing after it`, () => {
            const l = parseFlowLine(d);
            if ('' === d) {
                assert.equal(l.kind, 'blank');
            } else if ('skip' === kind) {
                assert.equal(l.kind, 'skip');
                assert.equal(l.path, null);
            } else {
                assert.equal(l.kind, 'invalid');
                assert.equal(l.reason, 'no path');
            }
        });

        it(`${label} + NUL or another C0 control is invalid`, () => {
            for (const c of ['\x00', '\x01', '\x1b', '\t', '\r']) {
                const l = parseFlowLine(`${d}/ob/a${c}b.pkt`);
                assert.equal(l.kind, 'invalid', JSON.stringify(c));
                assert.equal(l.reason, 'control character');
            }
        });

        it(`${label} + a line longer than ${MAX_LINE_BYTES} bytes is invalid`, () => {
            const body = `/${'a'.repeat(MAX_LINE_BYTES)}`;
            const l = parseFlowLine(`${d}${body}`);
            assert.equal(l.kind, 'invalid');
            assert.match(l.reason, /longer than/);

            const fits = `/${'a'.repeat(MAX_LINE_BYTES - 1 - d.length)}`;
            assert.equal(parseFlowLine(`${d}${fits}`).kind, kind);
        });

        it(`${label} + leading and trailing whitespace`, () => {
            const l = parseFlowLine(`  \t${d}/ob/x.pkt \t `);
            assert.equal(l.kind, kind);
            assert.equal(l.path, '/ob/x.pkt');
            assert.equal(l.text, `${d}/ob/x.pkt`);
            assert.equal(l.lead, 3);
        });

        it(`${label} + CRLF`, () => {
            const l = parseFlowLine(`${d}/ob/x.pkt\r`, '\n');
            assert.equal(l.kind, kind);
            assert.equal(l.path, '/ob/x.pkt');
            assert.equal(l.raw, `${d}/ob/x.pkt`);
            assert.equal(l.eol, '\r\n');
        });

        it(`${label} + a latin1 byte keeps the raw bytes as the path`, () => {
            const l = parseFlowLine(`${d}/ob/caf\xe9.zip`);
            assert.equal(l.kind, kind);
            assert.ok(Buffer.isBuffer(l.path), 'not valid UTF-8, so bytes');
            assert.deepEqual(l.path, latin1('/ob/caf\xe9.zip'));
        });

        it(`${label} + a UTF-8 multibyte name decodes to the name`, () => {
            const utf8AsLatin1 = Buffer.from('/ob/café.zip', 'utf8').toString('latin1');
            const l = parseFlowLine(`${d}${utf8AsLatin1}`);
            assert.equal(l.kind, kind);
            assert.equal(l.path, '/ob/café.zip');
        });
    }

    it('a leading-space no-directive line is the BinkleyTerm form of send and keep', () => {
        const l = parseFlowLine(' c:\\pascal\\notes.doc');
        assert.equal(l.kind, 'send');
        assert.equal(l.disposition, 'keep');
        assert.equal(l.dos, true);
    });

    it('leading punctuation that is no directive is unknown, as is the same after one', () => {
        for (const raw of ['$/ob/x', '%x', '&x', '*x', '^$foo', '#~/x', '^ /x', '@!x']) {
            const l = parseFlowLine(raw);
            assert.equal(l.kind, 'unknown', raw);
            assert.equal(l.disposition, null, raw);
            assert.equal(l.path, null, raw);
        }
    });

    it('a binkd-marked line that lost its slash is still a skip', () => {
        const l = parseFlowLine('~ob/outbound/0000fc9c.pkt');
        assert.equal(l.kind, 'skip');
        assert.equal(l.path, 'ob/outbound/0000fc9c.pkt');
    });

    it('a blank or whitespace-only line is blank', () => {
        for (const raw of ['', '   ', '\t', '\r']) {
            assert.equal(parseFlowLine(raw).kind, 'blank', JSON.stringify(raw));
        }
    });

    it('a lone CR at the end of the last line is its terminator', () => {
        const l = parseFlowLine('^/ob/x.pkt\r', '');
        assert.equal(l.kind, 'send');
        assert.equal(l.eol, '\r');
    });
});

describe('bso_flow — buffers, marking and the anything-left rule', () => {
    it('round-trips any bytes exactly: LF, CRLF, latin1, blank lines, no final LF', () => {
        const buf = Buffer.concat([
            latin1('^/ob/a.pkt\r\n'),
            latin1('/fb/caf\xe9.zip\n'),
            latin1('\n'),
            latin1('  @/fb/x.zip  \r\n'),
            latin1('$weird\x00line\n'),
            Buffer.from('/fb/naïve.zip\n', 'utf8'),
            latin1('~/ob/done.pkt'),
        ]);
        const lines = parseFlowBuffer(buf);
        assert.equal(lines.length, 7);
        assert.ok(serializeFlowLines(lines).equals(buf));
        assert.deepEqual(
            lines.map(l => l.kind),
            ['send', 'send', 'blank', 'send', 'invalid', 'send', 'skip']
        );
        assert.equal(lines[5].path, '/fb/naïve.zip');
        assert.equal(lines[1].offset, '^/ob/a.pkt\r\n'.length);
    });

    it('an empty buffer has no lines', () => {
        assert.deepEqual(parseFlowBuffer(Buffer.alloc(0)), []);
    });

    it('marks with ~ and the path, dropping the directive, keeping the terminator', () => {
        const cases = [
            ['^/ob/a.pkt', '~/ob/a.pkt'],
            ['-/ob/a.pkt', '~/ob/a.pkt'],
            ['#/ob/a.su0', '~/ob/a.su0'],
            ['@/fb/a.zip', '~/fb/a.zip'],
            ['/fb/a.zip', '~/fb/a.zip'],
            ['  ^/ob/a.pkt  ', '~/ob/a.pkt'],
        ];
        for (const [raw, want] of cases) {
            const m = markedLine(parseFlowLine(`${raw}\r`, '\n'));
            assert.equal(m.raw, want, raw);
            assert.equal(m.eol, '\r\n', raw);
            assert.equal(m.kind, 'skip');
        }
    });

    it('marking leaves a line that is not a send line alone', () => {
        for (const raw of ['~/a', '!/a', '$a', '', '/a\x01']) {
            const l = parseFlowLine(raw);
            assert.equal(markedLine(l), l, raw);
        }
    });

    it('send, unknown and invalid lines are live; blank and skip lines are not', () => {
        const live = raw => flowHasLive(parseFlowBuffer(latin1(raw)));
        assert.equal(live(''), false);
        assert.equal(live('\n\n'), false);
        assert.equal(live('~/a\n!/b\n\n'), false);
        assert.equal(live('~/a\n/b\n'), true);
        assert.equal(live('~/a\n$b\n'), true, 'unknown content is never thrown away');
        assert.equal(live('~/a\n/b\x00c\n'), true, 'nor is invalid content');
    });

    it('names its temporary files so no BSO scanner mistakes them', () => {
        assert.ok(isFlowTempFileName('.enigma-flow-00680001.flo.123.abcd1234.tmp'));
        assert.ok(!isFlowTempFileName('00680001.flo'));
        assert.ok(!isFlowTempFileName('00680001.bsy'));
    });

    it('shows control characters in a path as escapes', () => {
        assert.equal(printablePath('/a\x1b[2Jb\x00'), '/a\\x1b[2Jb\\x00');
        assert.equal(printablePath(latin1('/caf\xe9')), '/caf\xe9');
    });
});

describe('bso_flow — readFlowFile', () => {
    let tmpDir;

    beforeEach(async () => {
        tmpDir = await fsp.mkdtemp(paths.join(os.tmpdir(), 'enigma_bso_flow_'));
    });

    afterEach(async () => {
        await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    it('reads and parses a flow file', async () => {
        const p = paths.join(tmpDir, '00680001.flo');
        await fsp.writeFile(p, latin1('^/ob/a.pkt\n/fb/\xe9.zip\n'));
        const { lines, st } = await readFlowFile(p);
        assert.equal(lines.length, 2);
        assert.equal(st.size, 21);
    });

    it('a zero-length flow file is an empty flow file', async () => {
        const p = paths.join(tmpDir, '00680001.dlo');
        await fsp.writeFile(p, '');
        const { lines } = await readFlowFile(p);
        assert.deepEqual(lines, []);
    });

    it('a zero-length read of a file whose size is not zero is unreadable', async () => {
        const p = paths.join(tmpDir, '00680001.flo');
        await fsp.writeFile(p, '^/ob/a.pkt\n');

        //  What a read racing an in-place truncate-and-write sees.
        const realOpen = fsp.open;
        fsp.open = async (...args) => {
            const fh = await realOpen(...args);
            if (args[0] === p) {
                fh.readFile = async () => Buffer.alloc(0);
            }
            return fh;
        };
        try {
            await assert.rejects(readFlowFile(p), { code: 'EFLOWUNREADABLE' });
        } finally {
            fsp.open = realOpen;
        }
    });

    it('no flow file is ENOENT', async () => {
        await assert.rejects(readFlowFile(paths.join(tmpDir, 'nope.flo')), {
            code: 'ENOENT',
        });
    });
});

describe('bso_flow — rewriteFlowFile', () => {
    let tmpDir;
    let flowPath;

    const markText = text => lines => {
        const mark = [];
        lines.forEach((l, i) => {
            if ('send' === l.kind && l.text === text) mark.push(i);
        });
        return mark.length ? { mark } : null;
    };

    const removeText = text => lines => {
        const remove = [];
        lines.forEach((l, i) => {
            if (l.text === text) remove.push(i);
        });
        return remove.length ? { remove } : null;
    };

    const tempFiles = async () =>
        (await fsp.readdir(tmpDir)).filter(n => isFlowTempFileName(n));

    beforeEach(async () => {
        tmpDir = await fsp.mkdtemp(paths.join(os.tmpdir(), 'enigma_bso_flow_'));
        flowPath = paths.join(tmpDir, '00680001.flo');
    });

    afterEach(async () => {
        _hooks.getuid = () =>
            'function' === typeof process.getuid ? process.getuid() : undefined;
        await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    it('marks a line and writes every other line back byte for byte', async () => {
        const before = Buffer.concat([
            latin1('/fb/caf\xe9.zip\r\n'),
            latin1('^/ob/a.pkt\n'),
            latin1('  #/ob/b.su0  \r\n'),
            latin1('$something\x01odd\n'),
            Buffer.from('/fb/naïve.zip', 'utf8'),
        ]);
        await fsp.writeFile(flowPath, before);

        const result = await rewriteFlowFile(flowPath, markText('^/ob/a.pkt'));
        assert.equal(result.changed, true);
        assert.equal(result.deleted, false);
        assert.equal(result.how, 'replaced');

        const after = await fsp.readFile(flowPath);
        assert.ok(
            after.equals(
                Buffer.concat([
                    latin1('/fb/caf\xe9.zip\r\n'),
                    latin1('~/ob/a.pkt\n'),
                    latin1('  #/ob/b.su0  \r\n'),
                    latin1('$something\x01odd\n'),
                    Buffer.from('/fb/naïve.zip', 'utf8'),
                ])
            ),
            after.toString('latin1')
        );
    });

    it('keeps a CRLF line CRLF when it is marked', async () => {
        await fsp.writeFile(flowPath, '^/ob/a.pkt\r\n^/ob/b.pkt\r\n');
        await rewriteFlowFile(flowPath, markText('^/ob/a.pkt'));
        assert.equal(
            await fsp.readFile(flowPath, 'latin1'),
            '~/ob/a.pkt\r\n^/ob/b.pkt\r\n'
        );
    });

    it('marks every copy of a duplicated line', async () => {
        await fsp.writeFile(flowPath, '^/ob/a.pkt\n/fb/x.zip\n^/ob/a.pkt\n');
        const result = await rewriteFlowFile(flowPath, markText('^/ob/a.pkt'));
        assert.deepEqual(result.marked, [0, 2]);
        assert.equal(
            await fsp.readFile(flowPath, 'latin1'),
            '~/ob/a.pkt\n/fb/x.zip\n~/ob/a.pkt\n'
        );
    });

    it('removes lines, keeping an unterminated last line as it was', async () => {
        await fsp.writeFile(flowPath, '/fb/gone.zip\n/fb/a.zip\n/fb/b.zip');
        await rewriteFlowFile(flowPath, removeText('/fb/gone.zip'));
        assert.equal(await fsp.readFile(flowPath, 'latin1'), '/fb/a.zip\n/fb/b.zip');

        await rewriteFlowFile(flowPath, removeText('/fb/b.zip'));
        assert.equal(await fsp.readFile(flowPath, 'latin1'), '/fb/a.zip\n');
    });

    it('an edit that changes nothing writes nothing', async () => {
        await fsp.writeFile(flowPath, '/fb/a.zip\n/fb/b.zip');
        const before = await fsp.stat(flowPath);
        const result = await rewriteFlowFile(flowPath, () => ({ remove: [] }));
        assert.equal(result.changed, false);
        assert.equal((await fsp.stat(flowPath)).ino, before.ino);
    });

    it('removes the flow file when marking leaves nothing waiting', async () => {
        await fsp.writeFile(flowPath, '~/ob/old.pkt\n\n!/ob/skip.pkt\n^/ob/a.pkt\n');
        const result = await rewriteFlowFile(flowPath, markText('^/ob/a.pkt'));
        assert.equal(result.deleted, true);
        await assert.rejects(fsp.access(flowPath), { code: 'ENOENT' });
    });

    it('removes the flow file when removing leaves only ~ lines', async () => {
        await fsp.writeFile(flowPath, '~/ob/old.pkt\n/fb/a.zip\n');
        const result = await rewriteFlowFile(flowPath, removeText('/fb/a.zip'));
        assert.equal(result.deleted, true);
        await assert.rejects(fsp.access(flowPath), { code: 'ENOENT' });
    });

    it('keeps the flow file while a line it does not understand remains', async () => {
        await fsp.writeFile(flowPath, '$mystery\n^/ob/a.pkt\n/ob/nul\x00here\n');
        const result = await rewriteFlowFile(flowPath, markText('^/ob/a.pkt'));
        assert.equal(result.deleted, false);
        assert.equal(
            await fsp.readFile(flowPath, 'latin1'),
            '$mystery\n~/ob/a.pkt\n/ob/nul\x00here\n'
        );
    });

    it('never removes a pre-existing zero-length flow file (a poll request)', async () => {
        await fsp.writeFile(flowPath, '');
        for (const edit of [() => null, () => ({ mark: [0] }), () => ({ remove: [0] })]) {
            const result = await rewriteFlowFile(flowPath, edit);
            assert.equal(result.changed, false);
            assert.equal((await fsp.stat(flowPath)).size, 0);
        }
    });

    it('never removes a flow file it did not change, even one with nothing waiting', async () => {
        await fsp.writeFile(flowPath, '~/ob/a.pkt\n');
        const result = await rewriteFlowFile(flowPath, markText('/fb/not-here.zip'));
        assert.equal(result.changed, false);
        assert.equal(await fsp.readFile(flowPath, 'latin1'), '~/ob/a.pkt\n');
    });

    it('only marks send lines, whatever the edit asks for', async () => {
        await fsp.writeFile(flowPath, '$x\n~/a\n/fb/a.zip\n');
        const result = await rewriteFlowFile(flowPath, () => ({ mark: [0, 1, 9] }));
        assert.equal(result.changed, false);
        assert.equal(await fsp.readFile(flowPath, 'latin1'), '$x\n~/a\n/fb/a.zip\n');
    });

    it('reports no flow file as missing, not as an error', async () => {
        const result = await rewriteFlowFile(flowPath, () => ({ mark: [0] }));
        assert.equal(result.missing, true);
        assert.equal(result.changed, false);
    });

    it('replaces the file: a new inode, the same permissions, no temporary left', async () => {
        await fsp.writeFile(flowPath, '^/ob/a.pkt\n^/ob/b.pkt\n');
        await fsp.chmod(flowPath, 0o664);
        const before = await fsp.stat(flowPath);

        await rewriteFlowFile(flowPath, markText('^/ob/a.pkt'));

        const after = await fsp.stat(flowPath);
        assert.notEqual(after.ino, before.ino);
        assert.equal(after.mode & 0o7777, 0o664);
        assert.equal(after.gid, before.gid);
        assert.deepEqual(await tempFiles(), []);
    });

    it('a reader during the rewrite sees the old file or the new one, never less', async () => {
        const content = '^/ob/a.pkt\n/fb/payload.zip\n^/ob/b.pkt\n';
        await fsp.writeFile(flowPath, content);

        //  Hold the rewrite between writing the new copy and putting it in
        //  place, and read the flow file then.
        const realRename = fsp.rename;
        let seen;
        fsp.rename = async (from, to) => {
            if (to === flowPath) {
                seen = await readFlowFile(flowPath);
            }
            return realRename(from, to);
        };
        try {
            await rewriteFlowFile(flowPath, markText('^/ob/a.pkt'));
        } finally {
            fsp.rename = realRename;
        }

        assert.equal(seen.buf.toString('latin1'), content);
        assert.ok(seen.lines.some(l => '/fb/payload.zip' === l.path));
    });

    it('cleans up and leaves the file alone when the rewrite fails', async () => {
        const content = '^/ob/a.pkt\n^/ob/b.pkt\n';
        await fsp.writeFile(flowPath, content);

        const realRename = fsp.rename;
        fsp.rename = async () => {
            const err = new Error('EIO');
            err.code = 'EIO';
            throw err;
        };
        try {
            await assert.rejects(rewriteFlowFile(flowPath, markText('^/ob/a.pkt')), {
                code: 'EIO',
            });
        } finally {
            fsp.rename = realRename;
        }
        assert.equal(await fsp.readFile(flowPath, 'latin1'), content);
        assert.deepEqual(await tempFiles(), []);
    });

    describe('a flow file belonging to another user', () => {
        //  Renaming over it would make it ours, and binkd running as its own
        //  user could no longer open it to mark lines. Simulated: we cannot
        //  chown to someone else without root.
        beforeEach(function () {
            if ('function' !== typeof process.getuid) {
                return this.skip();
            }
            const me = process.getuid();
            _hooks.getuid = () => (0 === me ? 4242 : me + 1);
        });

        it('marks a directive line with a single byte, in place', async () => {
            const content = latin1('/fb/caf\xe9.zip\r\n  ^/ob/a.pkt  \r\n#/ob/b.su0\n');
            await fsp.writeFile(flowPath, content);
            const before = await fsp.stat(flowPath);

            const result = await rewriteFlowFile(flowPath, markText('^/ob/a.pkt'));
            assert.equal(result.how, 'marked-in-place');

            const after = await fsp.readFile(flowPath);
            assert.ok(
                after.equals(latin1('/fb/caf\xe9.zip\r\n  ~/ob/a.pkt  \r\n#/ob/b.su0\n')),
                after.toString('latin1')
            );
            assert.equal((await fsp.stat(flowPath)).ino, before.ino);
            assert.deepEqual(await tempFiles(), []);
        });

        it('marks every duplicate in place', async () => {
            await fsp.writeFile(flowPath, '-/ob/a.pkt\n@/fb/x.zip\n-/ob/a.pkt\n');
            await rewriteFlowFile(flowPath, markText('-/ob/a.pkt'));
            assert.equal(
                await fsp.readFile(flowPath, 'latin1'),
                '~/ob/a.pkt\n@/fb/x.zip\n~/ob/a.pkt\n'
            );
        });

        it('rewrites in place to mark a line with no directive, keeping its slash', async () => {
            await fsp.writeFile(flowPath, '/fb/a.zip\n^/ob/b.pkt\n');
            const before = await fsp.stat(flowPath);

            const result = await rewriteFlowFile(flowPath, markText('/fb/a.zip'));
            assert.equal(result.how, 'rewritten-in-place');
            assert.equal(
                await fsp.readFile(flowPath, 'latin1'),
                '~/fb/a.zip\n^/ob/b.pkt\n'
            );
            assert.equal((await fsp.stat(flowPath)).ino, before.ino);
        });

        it('rewrites in place to remove lines', async () => {
            await fsp.writeFile(flowPath, latin1('/fb/gone.zip\n/fb/caf\xe9.zip\n'));
            const before = await fsp.stat(flowPath);

            const result = await rewriteFlowFile(flowPath, removeText('/fb/gone.zip'));
            assert.equal(result.how, 'rewritten-in-place');
            assert.ok((await fsp.readFile(flowPath)).equals(latin1('/fb/caf\xe9.zip\n')));
            assert.equal((await fsp.stat(flowPath)).ino, before.ino);
        });

        it('still removes it when nothing is left waiting', async () => {
            await fsp.writeFile(flowPath, '^/ob/a.pkt\n');
            const result = await rewriteFlowFile(flowPath, markText('^/ob/a.pkt'));
            assert.equal(result.deleted, true);
            await assert.rejects(fsp.access(flowPath), { code: 'ENOENT' });
        });
    });

    it('falls back to in place when the new copy cannot be renamed into place', async () => {
        //  Windows, with the flow file open in another program.
        await fsp.writeFile(flowPath, '^/ob/a.pkt\n/fb/b.zip\n');
        const realRename = fsp.rename;
        fsp.rename = async () => {
            const err = new Error('EBUSY');
            err.code = 'EBUSY';
            throw err;
        };
        let result;
        try {
            result = await rewriteFlowFile(flowPath, markText('^/ob/a.pkt'));
        } finally {
            fsp.rename = realRename;
        }
        assert.equal(result.how, 'marked-in-place');
        assert.equal(await fsp.readFile(flowPath, 'latin1'), '~/ob/a.pkt\n/fb/b.zip\n');
        assert.deepEqual(await tempFiles(), []);
    });

    it('serializes rewrites of one file within the process', async () => {
        await fsp.writeFile(flowPath, '^/ob/a.pkt\n^/ob/b.pkt\n^/ob/c.pkt\n');
        await Promise.all([
            rewriteFlowFile(flowPath, markText('^/ob/a.pkt')),
            rewriteFlowFile(flowPath, markText('^/ob/b.pkt')),
        ]);
        assert.equal(
            await fsp.readFile(flowPath, 'latin1'),
            '~/ob/a.pkt\n~/ob/b.pkt\n^/ob/c.pkt\n'
        );
    });

    it('withFlowFileWrite runs work in order and survives a failure', async () => {
        const order = [];
        const a = withFlowFileWrite('k', async () => {
            await new Promise(r => setTimeout(r, 10));
            order.push('a');
            throw new Error('a failed');
        });
        const b = withFlowFileWrite('k', async () => order.push('b'));
        await assert.rejects(a);
        await b;
        assert.deepEqual(order, ['a', 'b']);
    });
});
