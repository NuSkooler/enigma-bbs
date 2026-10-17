/* jslint node: true */
'use strict';

//  core/amiga_door/amiga_fs.js: AmigaDOS OFS/FFS images in pure JavaScript.
//  The oracle cross-check at the end needs amitools' xdftool (XDFTOOL, the
//  proof of concept's venv, or xdftool on PATH) and skips without it.

const { strict: assert } = require('assert');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    AmigaVolume,
    hashName,
    rootBlockFor,
    protectionToString,
    parseProtection,
    dateToAmiga,
    amigaToDate,
    bootChecksum,
} = require('../core/amiga_door/amiga_fs.js');

const MB = 1024 * 1024;
const FLOPPY = 901120;

function bytes(n, seed = n) {
    //  deterministic, incompressible-looking content
    const out = Buffer.alloc(n);
    let x = (seed * 2654435761) >>> 0 || 1;
    for (let i = 0; i < n; i++) {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        out[i] = x & 0xff;
    }
    return out;
}

function reopen(vol) {
    return AmigaVolume.open(Buffer.from(vol.toBuffer()));
}

function assertClean(vol) {
    assert.deepEqual(vol.check(), []);
}

describe('amiga_fs', function () {
    describe('format', () => {
        it('makes an FFS hard-disk volume like xdftool: DOS\\1, root pointer, no boot code', () => {
            const vol = AmigaVolume.create(4 * MB, { name: 'BBS' });
            const buf = vol.toBuffer();
            assert.equal(buf.toString('latin1', 0, 3), 'DOS');
            assert.equal(buf[3], 1);
            assert.equal(buf.readUInt32BE(4), 0); // no checksum: not a boot floppy
            assert.equal(buf.readUInt32BE(8), 4096);
            assert.equal(vol.rootBlock, rootBlockFor(8192));
            const info = vol.info();
            assert.equal(info.name, 'BBS');
            assert.equal(info.dosType, 'DOS1');
            assert.equal(info.fileSystem, 'FFS');
            assert.equal(info.blocks, 8192);
            //  bootblock, root and three bitmap blocks are all that is used
            assert.equal(info.usedBlocks, 2 + 1 + 3);
            assert.deepEqual(vol.list(), []);
            assertClean(vol);
            assertClean(reopen(vol));
        });

        it('makes an OFS floppy (DOS\\0) with its root at block 880', () => {
            const vol = AmigaVolume.create(FLOPPY, { name: 'Empty', ffs: false });
            assert.equal(vol.toBuffer()[3], 0);
            assert.equal(vol.rootBlock, 880);
            assert.equal(vol.info().fileSystem, 'OFS');
            assert.equal(reopen(vol).name, 'Empty');
        });

        it('installs boot code with a valid bootblock checksum when given some', () => {
            const vol = AmigaVolume.create(FLOPPY, {
                bootCode: Buffer.from([0x4e, 0x75]),
            });
            const buf = vol.toBuffer();
            assert.equal(buf.readUInt32BE(4), bootChecksum(buf));
            assert.equal(vol.info().bootBlockChecksum, true);
        });

        it('refuses a 1 KB image and sizes that are not whole blocks', () => {
            assert.throws(() => AmigaVolume.create(1024), {
                code: 'EINVAL',
                message: /too small/,
            });
            assert.throws(() => AmigaVolume.create(4 * MB + 100), { code: 'EINVAL' });
            //  the smallest volume there can be still works
            const tiny = AmigaVolume.create(8 * 512);
            tiny.writeFile('a', 'x');
            assertClean(tiny);
        });

        it('refuses bad volume names', () => {
            assert.throws(() => AmigaVolume.create(FLOPPY, { name: 'A:B' }), {
                code: 'EINVAL',
            });
            assert.throws(() => AmigaVolume.create(FLOPPY, { name: 'x'.repeat(31) }), {
                code: 'EINVAL',
            });
        });

        it('a 100 MB image needs a bitmap extension block and uses it', function () {
            this.timeout(60000);
            const vol = AmigaVolume.create(100 * MB, { name: 'Big' });
            //  204,800 blocks: 51 bitmap blocks, 25 in the root, 26 in an extension block
            assert.equal(vol.bitmapBlocks.length, 51);
            assert.equal(vol.bitmapExtBlocks.length, 1);
            //  70 MB of file reaches blocks that only the extension's bitmap blocks cover
            const big = bytes(70 * MB, 7);
            vol.writeFile('Data/big.bin', big);
            vol.writeFile('small', 'small');
            const again = reopen(vol);
            assert.equal(again.bitmapRebuilt, false);
            assert.ok(again.readFile('Data/big.bin').equals(big));
            assert.equal(again.freeBlocks(), vol.freeBlocks());
            assertClean(again);
            again.delete('Data/big.bin');
            assert.equal(again.info().usedBlocks, 2 + 1 + 51 + 1 + 1 + 2);
            assertClean(again);
        });
    });

    describe('files', () => {
        //  sizes around every OFS and FFS boundary: block payload, header table, extension blocks
        const SIZES = [
            0,
            1,
            487,
            488,
            489,
            511,
            512,
            513,
            72 * 488,
            72 * 512,
            72 * 512 + 1,
            200000,
        ];

        for (const ffs of [true, false]) {
            it(`round-trips files of every awkward size (${ffs ? 'FFS' : 'OFS'})`, () => {
                const vol = AmigaVolume.create(FLOPPY, { ffs });
                for (const n of SIZES) vol.writeFile(`d/f${n}`, bytes(n));
                assertClean(vol);
                const again = reopen(vol);
                for (const n of SIZES) {
                    assert.ok(again.readFile(`d/f${n}`).equals(bytes(n)), `size ${n}`);
                    assert.equal(again.stat(`d/f${n}`).size, n);
                }
                assertClean(again);
            });
        }

        it('replaces a file, and frees what the old one used', () => {
            const vol = AmigaVolume.create(FLOPPY);
            const before = vol.freeBlocks();
            vol.writeFile('a', bytes(100000));
            vol.writeFile('A', bytes(10)); // names are case-insensitive
            assert.equal(vol.list().length, 1);
            assert.equal(vol.list()[0].name, 'A');
            assert.ok(vol.readFile('a').equals(bytes(10)));
            assert.equal(vol.freeBlocks(), before - 2);
            assert.throws(() => vol.writeFile('a', 'x', { overwrite: false }), {
                code: 'EEXIST',
            });
            assertClean(vol);
        });

        it('mkdir -p, and files under paths with a volume prefix', () => {
            const vol = AmigaVolume.create(FLOPPY);
            vol.mkdir('Doors/One/Two');
            vol.mkdir('Doors/One'); // exists: fine
            vol.writeFile('BBS:Doors/One/Two/x', 'x');
            vol.writeFile('/Doors/Three/y', 'y');
            assert.deepEqual(
                vol.list('', { recursive: true }).map(e => `${e.type} ${e.path}`),
                [
                    'dir Doors',
                    'dir Doors/One',
                    'dir Doors/One/Two',
                    'file Doors/One/Two/x',
                    'dir Doors/Three',
                    'file Doors/Three/y',
                ]
            );
            assert.throws(() => vol.mkdir('Doors/Three/y/z'), { code: 'ENOTDIR' });
            assert.throws(() => vol.writeFile('Doors', 'x'), { code: 'EISDIR' });
            assert.throws(() => vol.readFile('Doors'), { code: 'EISDIR' });
            assert.throws(() => vol.readFile('nope'), { code: 'ENOENT' });
            assert.equal(vol.exists('doors/one/TWO/X'), true);
            assert.equal(vol.exists('Doors/x'), false);
            assertClean(vol);
        });

        it('keeps hash collisions apart and the chain sorted by block', () => {
            //  the ADF FAQ's example: these three share a hash slot
            const names = ['file_1a', 'file_24', 'file_5u'];
            assert.equal(new Set(names.map(n => hashName(n))).size, 1);
            const vol = AmigaVolume.create(FLOPPY);
            for (const n of names) vol.writeFile(`dir/${n}`, n);
            const slot = hashName('file_1a');
            const dir = vol.stat('dir').block;
            const chain = [];
            for (let b = vol._u32(dir, 24 + 4 * slot); b; b = vol._u32(b, 512 - 16))
                chain.push(b);
            assert.equal(chain.length, 3);
            assert.deepEqual(
                chain,
                [...chain].sort((a, b) => a - b)
            );
            for (const n of names) assert.equal(vol.readFile(`dir/${n}`).toString(), n);

            //  delete from the middle and the head of the chain
            vol.delete('dir/file_24');
            assert.equal(vol.readFile('dir/file_1a').toString(), 'file_1a');
            assert.equal(vol.readFile('dir/file_5u').toString(), 'file_5u');
            vol.delete('dir/file_1a');
            assert.equal(vol.readFile('dir/file_5u').toString(), 'file_5u');
            assert.deepEqual(
                vol.list('dir').map(e => e.name),
                ['file_5u']
            );
            assertClean(vol);
        });

        it('handles a directory of 1,500 entries (long hash chains)', function () {
            this.timeout(30000);
            const vol = AmigaVolume.create(8 * MB);
            for (let i = 0; i < 1500; i++) vol.writeFile(`Many/entry${i}`, `#${i}`);
            assert.equal(vol.list('Many').length, 1500);
            for (let i = 0; i < 1500; i += 2) vol.delete(`Many/entry${i}`);
            const again = reopen(vol);
            const names = again.list('Many').map(e => e.name);
            assert.equal(names.length, 750);
            for (let i = 1; i < 1500; i += 2) {
                assert.equal(again.readFile(`Many/entry${i}`).toString(), `#${i}`);
            }
            assertClean(again);
        });

        it('international mode folds accented letters; plain FFS does not', () => {
            const intl = AmigaVolume.create(FLOPPY, { intl: true });
            intl.writeFile('grüße', '1');
            assert.equal(intl.readFile('GRÜßE').toString(), '1');
            assert.equal(intl.dosType, 'DOS3');

            const plain = AmigaVolume.create(FLOPPY);
            plain.writeFile('grüße', '1');
            plain.writeFile('GRÜßE', '2');
            assert.equal(plain.list().length, 2);
            assertClean(plain);
        });

        it('refuses names AmigaDOS cannot hold', () => {
            const vol = AmigaVolume.create(FLOPPY);
            assert.throws(() => vol.writeFile('x'.repeat(31), ''), { code: 'EINVAL' });
            assert.throws(() => vol.writeFile('a\u0100', ''), { code: 'EINVAL' });
            assert.throws(() => vol.writeFile('tab\there', ''), { code: 'EINVAL' });
            assert.throws(() => vol.writeFile('x', '', { comment: 'c'.repeat(80) }), {
                code: 'EINVAL',
            });
            vol.writeFile('x'.repeat(30), '');
            assertClean(vol);
        });

        it('changes nothing when the volume is full', () => {
            const vol = AmigaVolume.create(64 * 512);
            vol.writeFile('a', 'a');
            const before = Buffer.from(vol.toBuffer());
            assert.throws(() => vol.writeFile('Deep/Dir/big', bytes(100000)), {
                code: 'ENOSPC',
            });
            assert.ok(vol.toBuffer().equals(before));
        });
    });

    describe('delete', () => {
        it('frees every block, refuses a non-empty directory unless recursive', () => {
            const vol = AmigaVolume.create(FLOPPY, { ffs: false });
            const free = vol.freeBlocks();
            vol.writeFile('D/E/f', bytes(60000));
            vol.writeFile('D/g', 'g');
            assert.throws(() => vol.delete('D'), { code: 'ENOTEMPTY' });
            assert.throws(() => vol.delete('nope'), { code: 'ENOENT' });
            vol.delete('D', { recursive: true });
            assert.equal(vol.freeBlocks(), free);
            assert.deepEqual(vol.list(), []);
            assertClean(reopen(vol));
        });
    });

    describe('metadata', () => {
        it('protection bits: strings and numbers', () => {
            assert.equal(protectionToString(0), '----rwed');
            assert.equal(protectionToString(0x0f), '--------');
            assert.equal(protectionToString(0x40), '-s--rwed');
            assert.equal(parseProtection('rwed'), 0);
            assert.equal(parseProtection('----rwed'), 0);
            assert.equal(parseProtection('r'), 0x07);
            assert.equal(parseProtection('hsparwed'), 0xf0);
            assert.equal(parseProtection(0x12), 0x12);
            assert.throws(() => parseProtection('rwx'), { code: 'EINVAL' });

            const vol = AmigaVolume.create(FLOPPY);
            vol.writeFile('s', 'x', { protection: 'srwed' });
            assert.equal(vol.stat('s').protectionString, '-s--rwed');
            vol.setProtection('s', 'r');
            assert.equal(reopen(vol).stat('s').protection, 0x07);
        });

        it('dates: days since 1978, minutes, 1/50 s ticks', () => {
            const d = new Date(Date.UTC(2026, 9, 17, 12, 34, 56, 780));
            assert.deepEqual(dateToAmiga(d, true), {
                days: 17821,
                mins: 754,
                ticks: 2839,
            });
            assert.equal(
                amigaToDate({ days: 17821, mins: 754, ticks: 2839 }, true).getTime(),
                d.getTime()
            );
            //  local wall-clock time round-trips to the same instant
            assert.equal(amigaToDate(dateToAmiga(d)).getTime(), d.getTime());
            //  before 1978 there is nothing earlier than the epoch
            assert.deepEqual(dateToAmiga(new Date(0), true), {
                days: 0,
                mins: 0,
                ticks: 0,
            });

            const vol = AmigaVolume.create(FLOPPY, { utc: true, date: d });
            vol.writeFile('f', 'x', { date: d, comment: 'a comment' });
            vol.mkdir('dir', { date: d });
            const again = AmigaVolume.open(Buffer.from(vol.toBuffer()), { utc: true });
            assert.equal(again.stat('f').date.getTime(), d.getTime());
            assert.deepEqual(again.stat('dir').amigaDate, {
                days: 17821,
                mins: 754,
                ticks: 2839,
            });
            assert.equal(again.info().created.getTime(), d.getTime());
            assert.equal(again.stat('f').comment, 'a comment');
            const later = new Date(Date.UTC(2030, 0, 1));
            again.setDate('f', later);
            again.setComment('f', '');
            assert.equal(again.stat('f').date.getTime(), later.getTime());
            assert.equal(again.stat('f').comment, '');
        });

        it('a directory gains a new date when its contents change', () => {
            let now = new Date(Date.UTC(2020, 0, 1));
            const vol = AmigaVolume.create(FLOPPY, { utc: true, now: () => now });
            vol.mkdir('d');
            now = new Date(Date.UTC(2021, 0, 1));
            vol.writeFile('d/f', 'x');
            assert.equal(vol.stat('d').date.getTime(), now.getTime());
            assert.equal(vol.info().modified.getTime(), now.getTime());
            assert.equal(vol.stat('d/f').date.getTime(), now.getTime());
        });

        it('relabels the volume', () => {
            const vol = AmigaVolume.create(FLOPPY, { name: 'Old' });
            vol.setVolumeName('New Name');
            assert.equal(reopen(vol).name, 'New Name');
        });
    });

    describe('opening images', () => {
        it('rebuilds a bitmap AmigaDOS left marked invalid', () => {
            const vol = AmigaVolume.create(FLOPPY);
            vol.writeFile('a/b', bytes(5000));
            const buf = Buffer.from(vol.toBuffer());
            //  bm_flag = 0, as a volume with writes in flight has it; fix the root checksum
            const r = vol.rootBlock * 512;
            buf.writeUInt32BE(0, r + 312);
            buf.writeUInt32BE(0, r + 20);
            let sum = 0;
            for (let i = 0; i < 512; i += 4) sum = (sum + buf.readUInt32BE(r + i)) >>> 0;
            buf.writeUInt32BE((0x100000000 - sum) >>> 0, r + 20);

            const again = AmigaVolume.open(buf);
            assert.equal(again.bitmapRebuilt, true);
            assert.equal(again.freeBlocks(), vol.freeBlocks());
            again.writeFile('c', 'c');
            assert.equal(AmigaVolume.open(Buffer.from(buf)).bitmapRebuilt, false);
            assertClean(again);
        });

        it('refuses RDB images, other file systems and long-name volumes', () => {
            const rdb = Buffer.alloc(FLOPPY);
            rdb.write('RDSK', 0, 'latin1');
            assert.throws(() => AmigaVolume.open(rdb), {
                code: 'EUNSUPPORTED',
                message: /Rigid/,
            });
            const pfs = Buffer.alloc(FLOPPY);
            pfs.write('PFS\x01', 0, 'latin1');
            assert.throws(() => AmigaVolume.open(pfs), { code: 'EUNSUPPORTED' });
            const ln = Buffer.from(AmigaVolume.create(FLOPPY).toBuffer());
            ln[3] = 7;
            assert.throws(() => AmigaVolume.open(ln), {
                code: 'EUNSUPPORTED',
                message: /long file names/,
            });
            assert.throws(() => AmigaVolume.open(Buffer.alloc(FLOPPY)), {
                code: 'EUNSUPPORTED',
            });
        });

        it('finds the root of a floppy-sized volume at the end of a longer file', () => {
            //  AmigaDOS writes 880 as the bootblock's root pointer; a padded file still opens
            const vol = AmigaVolume.create(FLOPPY);
            vol.writeFile('x', 'x');
            const padded = Buffer.concat([vol.toBuffer(), Buffer.alloc(512 * 32)]);
            const again = AmigaVolume.open(padded);
            assert.equal(again.rootBlock, 880);
            assert.equal(again.readFile('x').toString(), 'x');
        });

        it('reads hard and soft links, and deletes a hard link', () => {
            //  the writer makes no links; build them as AmigaDOS lays them out
            const vol = AmigaVolume.create(FLOPPY);
            vol.writeFile('real', 'contents');
            const real = vol.stat('real').block;
            const nameBuf = Buffer.from('hard');
            const [hard, soft] = vol._alloc(2);
            vol._newHeader(hard, vol.rootBlock, nameBuf, -4, {});
            vol._u32(hard, 512 - 44, real); // real_entry
            vol._u32(real, 512 - 40, hard); // next_link
            vol._checksum(real);
            vol._linkIntoDir(vol.rootBlock, hard, nameBuf);
            vol._newHeader(soft, vol.rootBlock, Buffer.from('soft'), 3, {});
            vol.toBuffer().write('BBS:real\0', soft * 512 + 24, 'latin1');
            vol._linkIntoDir(vol.rootBlock, soft, Buffer.from('soft'));
            vol._commit();

            const again = reopen(vol);
            assertClean(again);
            const byName = Object.fromEntries(again.list().map(e => [e.name, e]));
            assert.equal(byName.hard.hardLink, true);
            assert.equal(byName.hard.size, 8);
            assert.equal(byName.soft.type, 'softlink');
            assert.equal(byName.soft.target, 'BBS:real');
            assert.equal(again.readFile('hard').toString(), 'contents');
            assert.throws(() => again.delete('real'), { code: 'EUNSUPPORTED' });

            //  a tree holding a file with links is refused as a whole, untouched
            again.writeFile('tree/a', 'a');
            again.writeFile('tree/sub/b', 'b');
            const linked = again.stat('tree/sub/b').block;
            const [link2] = again._alloc(1);
            again._newHeader(link2, again.rootBlock, Buffer.from('hard2'), -4, {});
            again._u32(link2, 512 - 44, linked);
            again._u32(linked, 512 - 40, link2);
            again._checksum(linked);
            again._linkIntoDir(again.rootBlock, link2, Buffer.from('hard2'));
            again._commit();
            const before = Buffer.from(again.toBuffer());
            assert.throws(() => again.delete('tree', { recursive: true }), {
                code: 'EUNSUPPORTED',
            });
            assert.ok(again.toBuffer().equals(before));
            again.delete('hard2');
            again.delete('tree', { recursive: true });
            again.delete('hard');
            again.delete('soft');
            again.delete('real');
            assert.deepEqual(again.list(), []);
            assertClean(again);
        });
    });

    //  ── oracle: amitools reads what we write, we read what it writes ──

    describe('cross-check with amitools (xdftool)', function () {
        this.timeout(120000);

        //  XDFTOOL, when set, is the only one tried (XDFTOOL=none skips these)
        function findXdftool() {
            if (process.env.XDFTOOL) {
                return fs.existsSync(process.env.XDFTOOL) ? process.env.XDFTOOL : null;
            }
            const poc = path.join(
                os.homedir(),
                'dev/enigma-amiga-poc/tools/venv/bin/xdftool'
            );
            if (fs.existsSync(poc)) return poc;
            const which = spawnSync('sh', ['-c', 'command -v xdftool'], {
                encoding: 'utf8',
            });
            return which.status === 0 ? which.stdout.trim() : null;
        }
        const xdftool = findXdftool();
        //  amitools' own Python, next to xdftool in its venv
        const python = xdftool && path.join(path.dirname(xdftool), 'python');
        const usable =
            xdftool &&
            fs.existsSync(python) &&
            spawnSync(python, ['-I', '-c', 'import amitools.fs'], { encoding: 'utf8' })
                .status === 0;

        let dir;
        before(function () {
            if (!usable) return this.skip();
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amiga-fs-'));
        });
        after(() => dir && fs.rmSync(dir, { recursive: true, force: true }));

        //  every entry: path, dir?, protection, raw date, comment, size, sha1
        const ORACLE = `
import hashlib, json, sys
from amitools.fs.blkdev.BlkDevFactory import BlkDevFactory
from amitools.fs.ADFSVolume import ADFSVolume
vol = ADFSVolume(BlkDevFactory().open(sys.argv[1], read_only=True))
vol.open()
out = []
def walk(d, prefix):
    for e in d.get_entries_sorted_by_name():
        b = e.block
        p = prefix + e.name.get_unicode_name()
        ts = b.mod_ts
        ent = [p, e.is_dir(), b.protect, [ts.days, ts.mins, ts.ticks], str(b.comment) if b.comment else ""]
        if not e.is_dir():
            ent += [b.byte_size, hashlib.sha1(e.get_file_data()).hexdigest()]
        out.append(ent)
        if e.is_dir():
            walk(e, p + "/")
walk(vol.get_root_dir(), "")
print(json.dumps({"name": str(vol.get_volume_name()), "free": vol.get_free_blocks(), "entries": out}, ensure_ascii=False))
`;

        function oracle(image) {
            const r = spawnSync(python, ['-I', '-c', ORACLE, image], {
                encoding: 'utf8',
            });
            assert.equal(r.status, 0, r.stderr);
            return JSON.parse(r.stdout);
        }

        function ours(image) {
            const vol = AmigaVolume.openFile(image, { readOnly: true });
            assertClean(vol);
            return {
                name: vol.name,
                free: vol.freeBlocks(),
                entries: vol.list('', { recursive: true }).map(e => {
                    const d = e.amigaDate;
                    const ent = [
                        e.path,
                        e.type === 'dir',
                        e.protection,
                        [d.days, d.mins, d.ticks],
                        e.comment,
                    ];
                    if (e.type !== 'dir') {
                        ent.push(
                            e.size,
                            crypto
                                .createHash('sha1')
                                .update(vol.readFile(e.path))
                                .digest('hex')
                        );
                    }
                    return ent;
                }),
            };
        }

        //  xdftool's "list": an indented tree of name, size or DIR, protection
        function xdftoolList(image) {
            const r = spawnSync(xdftool, [image, 'list'], { encoding: 'utf8' });
            assert.equal(r.status, 0, r.stderr);
            const stack = [];
            return r.stdout
                .split('\n')
                .slice(1)
                .filter(
                    l => /\S/.test(l) && !/^\s*(sum|data|fs|total|used|free):/.test(l)
                )
                .map(l => {
                    const m = l.match(/^( *)(.+?)\s+(DIR|\d+)\s+([-hsparwed]{8})\s/);
                    assert.ok(m, `unparsed xdftool line: ${l}`);
                    const depth = (m[1].length - 2) / 2;
                    stack.length = depth;
                    stack.push(m[2]);
                    return `${stack.join('/')} ${m[3] === 'DIR' ? 'DIR' : m[3]} ${m[4]}`;
                });
        }

        function ourList(image) {
            const vol = AmigaVolume.openFile(image, { readOnly: true });
            return vol
                .list('', { recursive: true })
                .map(
                    e =>
                        `${e.path} ${e.type === 'dir' ? 'DIR' : e.size} ${e.protectionString}`
                );
        }

        function populate(vol) {
            vol.mkdir('C');
            vol.writeFile(
                'C/axshim',
                fs.readFileSync(path.join(__dirname, '../misc/amiga_door/bin/axshim'))
            );
            vol.writeFile('S/Startup-Sequence', 'C:axshim 115200\n', {
                protection: 'srwed',
            });
            vol.writeFile('Doors/Empty.dat', '');
            vol.writeFile('Doors/Big.bin', bytes(150000), { comment: 'big one' });
            vol.writeFile('Doors/Exact', bytes(72 * 512));
            for (const n of ['file_1a', 'file_24', 'file_5u'])
                vol.writeFile(`Doors/${n}`, n);
            for (let i = 0; i < 300; i++) vol.writeFile(`Doors/Many/m${i}`, `${i}`);
            for (let i = 0; i < 300; i += 4) vol.delete(`Doors/Many/m${i}`);
            vol.writeFile('Doors/Grüße', 'latin-1 name');
            vol.setProtection('Doors/Exact', 'r');
        }

        for (const [label, size, opts] of [
            ['FFS hard disk', 4 * MB, {}],
            ['OFS floppy', FLOPPY, { ffs: false }],
            ['FFS international floppy', FLOPPY, { intl: true }],
            ['FFS 100 MB hard disk', 100 * MB, {}],
        ]) {
            it(`amitools reads our ${label} exactly as we do`, () => {
                const image = path.join(dir, `ours-${size}-${opts.ffs}-${opts.intl}.hdf`);
                const vol = AmigaVolume.create(
                    size,
                    Object.assign({ name: 'Ours' }, opts)
                );
                populate(vol);
                vol.save(image);
                assert.deepEqual(oracle(image), ours(image));
                assert.deepEqual(xdftoolList(image), ourList(image));
                //  and its validator finds nothing wrong
                const scan = spawnSync(
                    path.join(path.dirname(xdftool), 'xdfscan'),
                    ['-l', '2', image],
                    {
                        encoding: 'utf8',
                    }
                );
                if (
                    scan.status !== null &&
                    fs.existsSync(path.join(path.dirname(xdftool), 'xdfscan'))
                ) {
                    assert.match(scan.stdout, /\bok\b/, scan.stdout + scan.stderr);
                }
            });
        }

        it('we read an image xdftool wrote exactly as amitools does, and can add to it', () => {
            const image = path.join(dir, 'theirs.hdf');
            const src = path.join(dir, 'src');
            fs.mkdirSync(src);
            fs.writeFileSync(path.join(src, 'big'), bytes(100000));
            fs.writeFileSync(path.join(src, 'small'), 'small');
            fs.writeFileSync(path.join(src, 'empty'), '');
            //  (no comment: amitools' "comment" command fails on 0.8)
            const script =
                'create size=2M + format Theirs ffs + makedir Dir + makedir Dir/Sub' +
                ' + write BIG Dir/big + write SMALL Dir/Sub/small + write EMPTY empty' +
                ' + protect Dir/big r';
            const args = script
                .split(' ')
                .map(a =>
                    ['BIG', 'SMALL', 'EMPTY'].includes(a)
                        ? path.join(src, a.toLowerCase())
                        : a
                );
            const r = spawnSync(xdftool, [image, ...args], { encoding: 'utf8' });
            assert.equal(r.status, 0, r.stderr);
            assert.deepEqual(ours(image), oracle(image));
            assert.deepEqual(ourList(image), xdftoolList(image));

            const vol = AmigaVolume.openFile(image);
            vol.writeFile('Dir/Sub/added', bytes(3000));
            vol.delete('empty');
            vol.save();
            assert.deepEqual(oracle(image), ours(image));
        });

        it('an OFS floppy written by xdftool reads the same', () => {
            const image = path.join(dir, 'theirs.adf');
            const src = path.join(dir, 'ofs-src');
            fs.writeFileSync(src, bytes(40000));
            const r = spawnSync(
                xdftool,
                [
                    image,
                    'create',
                    '+',
                    'format',
                    'Floppy',
                    'ofs',
                    '+',
                    'write',
                    src,
                    'file',
                ],
                { encoding: 'utf8' }
            );
            assert.equal(r.status, 0, r.stderr);
            assert.deepEqual(ours(image), oracle(image));
        });
    });
});
