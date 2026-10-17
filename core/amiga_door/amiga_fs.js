/* jslint node: true */
'use strict';

//
//  amiga_fs.js: read and write AmigaDOS OFS/FFS volumes in memory.
//
//  Copyright (c) 2026 Bryan Ashby
//  SPDX-License-Identifier: BSD-2-Clause
//
//  Works on a plain partition with 512-byte blocks: an ADF floppy image or an
//  HDF hard-disk image without a Rigid Disk Block, which is what an ENiGMA
//  Amiga door image is. Reads OFS and FFS (DOS\0 to DOS\5: international
//  mode and directory-cache volumes too); writes OFS and FFS, with or without
//  international mode. Directory-cache volumes are read-only here, and long
//  file name volumes (DOS\6, DOS\7), RDB images and other file systems (PFS,
//  SFS) are refused.
//
//  Layouts follow Laurent Clevy's "The .ADF (Amiga Disk File) format FAQ"
//  (http://lclevy.free.fr/adflib/adf_info.html):
//
//    block 0-1   bootblock: 'DOS' + flags, checksum, root block pointer
//    root        at (2 + highKey) / 2: hash table, bitmap pointers, dates, name
//    bitmap      one bit per block from block 2, set = free
//    headers     file header / user directory / link blocks, chained per hash slot
//    data        FFS: 512 raw bytes; OFS: a 24-byte header and 488 bytes
//
//  Everything is synchronous and works on one Buffer holding the whole image;
//  openFile() / save() move it to and from disk.
//
//  Dates are AmigaDOS wall-clock dates (days since 1978-01-01, minutes, ticks
//  of 1/50 s). They have no time zone: by default they are read and written in
//  the host's local time, which is what the emulated Amiga's clock shows; pass
//  { utc: true } to treat them as UTC instead.
//

const fs = require('fs');

const BSIZE = 512;
const HT_SIZE = BSIZE / 4 - 56; // 72 hash slots, and 72 data pointers per header
const BM_LONGS = BSIZE / 4 - 1; // 127 map longs per bitmap block
const BM_BITS = BM_LONGS * 32; // 4064 blocks per bitmap block
const BM_PAGES = 25; // bitmap pointers in the root block
const BM_EXT_PTRS = BSIZE / 4 - 1; // 127 bitmap pointers per extension block
const RESERVED = 2; // bootblock
const OFS_PAYLOAD = BSIZE - 24; // 488
const MAX_NAME = 30;
const MAX_COMMENT = 79;

const T_HEADER = 2;
const T_DATA = 8;
const T_LIST = 16;

const ST_ROOT = 1;
const ST_USERDIR = 2;
const ST_SOFTLINK = 3;
const ST_LINKDIR = 4;
const ST_FILE = -3;
const ST_LINKFILE = -4;

//  byte offsets in a 512-byte header block
const OFF = {
    type: 0,
    headerKey: 4,
    highSeq: 8,
    dataSize: 12,
    firstData: 16,
    checksum: 20,
    table: 24, // hash table (root, dir) or data block pointers (file, ext)
    bmFlag: BSIZE - 200,
    bmPages: BSIZE - 196,
    protect: BSIZE - 192,
    byteSize: BSIZE - 188,
    comment: BSIZE - 184,
    bmExt: BSIZE - 96,
    date: BSIZE - 92, // root: r_days (last root directory change)
    name: BSIZE - 80,
    realEntry: BSIZE - 44,
    nextLink: BSIZE - 40,
    volDate: BSIZE - 40, // root: v_days (last change anywhere on the volume)
    createDate: BSIZE - 28, // root: c_days (format date)
    hashChain: BSIZE - 16,
    parent: BSIZE - 12,
    extension: BSIZE - 8,
    secType: BSIZE - 4,
};

//  protection bits; HSPA mean what they say when set, RWED forbid when set
const PROT_LETTERS = 'hsparwed';

const DAY_MS = 86400000;
const EPOCH_1978 = Date.UTC(1978, 0, 1);

class AmigaFsError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'AmigaFsError';
        this.code = code;
    }
}

function fail(code, message) {
    throw new AmigaFsError(code, message);
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function toUpper(c, intl) {
    if (c >= 0x61 && c <= 0x7a) return c - 0x20;
    if (intl && c >= 0xe0 && c <= 0xfe && c !== 0xf7) return c - 0x20;
    return c;
}

function hashName(nameBuf, intl) {
    let h = nameBuf.length;
    for (const c of nameBuf) {
        h = (h * 13 + toUpper(c, intl)) & 0x7ff;
    }
    return h % HT_SIZE;
}

function namesEqual(a, b, intl) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (toUpper(a[i], intl) !== toUpper(b[i], intl)) return false;
    }
    return true;
}

//  Directory listing order: by the names as AmigaDOS upper-cases them
function compareNames(a, b, intl) {
    const ua = Buffer.from(a, 'latin1').map(c => toUpper(c, intl));
    const ub = Buffer.from(b, 'latin1').map(c => toUpper(c, intl));
    return Buffer.compare(ua, ub);
}

//  A file, directory or volume name: 1 to 30 Latin-1 characters, no ':' or '/'
function encodeName(name, what = 'name') {
    if (typeof name !== 'string' || name.length === 0) {
        fail('EINVAL', `empty ${what}`);
    }
    if (name.length > MAX_NAME) {
        fail('EINVAL', `${what} longer than ${MAX_NAME} characters: ${name}`);
    }
    for (let i = 0; i < name.length; i++) {
        const c = name.charCodeAt(i);
        if (c > 0xff) fail('EINVAL', `${what} is not Latin-1: ${name}`);
        if (c < 0x20 || c === 0x3a || c === 0x2f) {
            fail(
                'EINVAL',
                `${what} may not contain ':', '/' or control characters: ${name}`
            );
        }
    }
    return Buffer.from(name, 'latin1');
}

function encodeComment(comment) {
    if (comment === undefined || comment === null) return Buffer.alloc(0);
    if (comment.length > MAX_COMMENT) {
        fail('EINVAL', `comment longer than ${MAX_COMMENT} characters`);
    }
    for (let i = 0; i < comment.length; i++) {
        if (comment.charCodeAt(i) > 0xff) fail('EINVAL', 'comment is not Latin-1');
    }
    return Buffer.from(comment, 'latin1');
}

//  "a/b/c", "/a/b", "BBS:a/b" or ":a/b" -> ['a', 'b', ...]
function splitPath(p) {
    if (p === undefined || p === null) return [];
    let s = String(p).replace(/\\/g, '/');
    const colon = s.indexOf(':');
    if (colon >= 0) s = s.slice(colon + 1);
    return s.split('/').filter(c => c.length > 0);
}

function protectionToString(prot) {
    let s = '';
    for (let i = 0; i < 8; i++) {
        const bit = 7 - i;
        const set = (prot >>> bit) & 1;
        //  hspa: shown when set; rwed: shown when clear (set forbids)
        s += (bit >= 4 ? set : !set) ? PROT_LETTERS[i] : '-';
    }
    return s;
}

//  'rwed', '----rwed', 'srwed', or a number (the raw protection long)
function parseProtection(value) {
    if (typeof value === 'number') return value >>> 0;
    if (typeof value !== 'string' || !/^[hsparwed-]*$/i.test(value)) {
        fail('EINVAL', `bad protection: ${value} (letters from "hsparwed")`);
    }
    const letters = value.toLowerCase();
    let prot = 0;
    for (let bit = 7; bit >= 0; bit--) {
        const letter = PROT_LETTERS[7 - bit];
        const has = letters.includes(letter);
        if (bit >= 4 ? has : !has) prot |= 1 << bit;
    }
    return prot >>> 0;
}

function dateToAmiga(date, utc) {
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime())) fail('EINVAL', `bad date: ${date}`);
    //  the wall-clock time, as if it were UTC
    const wall = utc
        ? d.getTime()
        : Date.UTC(
              d.getFullYear(),
              d.getMonth(),
              d.getDate(),
              d.getHours(),
              d.getMinutes(),
              d.getSeconds(),
              d.getMilliseconds()
          );
    const ms = Math.max(0, wall - EPOCH_1978);
    const days = Math.floor(ms / DAY_MS);
    const inDay = ms - days * DAY_MS;
    const mins = Math.floor(inDay / 60000);
    const ticks = Math.floor((inDay - mins * 60000) / 20);
    return { days, mins, ticks };
}

function amigaToDate({ days, mins, ticks }, utc) {
    const wall = EPOCH_1978 + days * DAY_MS + mins * 60000 + ticks * 20;
    if (utc) return new Date(wall);
    const w = new Date(wall);
    return new Date(
        w.getUTCFullYear(),
        w.getUTCMonth(),
        w.getUTCDate(),
        w.getUTCHours(),
        w.getUTCMinutes(),
        w.getUTCSeconds(),
        w.getUTCMilliseconds()
    );
}

//  The root block's position for a partition of numBlocks blocks
function rootBlockFor(numBlocks) {
    return Math.floor((RESERVED + numBlocks - 1) / 2);
}

function blocksNeededForFile(size, ffs) {
    const data = Math.ceil(size / (ffs ? BSIZE : OFS_PAYLOAD));
    const ext = data > HT_SIZE ? Math.ceil((data - HT_SIZE) / HT_SIZE) : 0;
    return { data, ext, total: 1 + ext + data };
}

// ─── the volume ──────────────────────────────────────────────────────────────

class AmigaVolume {
    //  Use AmigaVolume.open() / openFile() / format() / create().
    constructor(buffer, options = {}) {
        this.buf = buffer;
        this.utc = !!options.utc;
        this.now = typeof options.now === 'function' ? options.now : () => new Date();
        this.readOnly = !!options.readOnly;
        this.dirty = false;
        this.dirtyPages = new Set(); // bitmap blocks to rewrite
    }

    // ── construction ──

    //  Wrap an existing image (Buffer). Finds the root block, checks the
    //  bootblock and, when the bitmap is marked invalid, rebuilds it from the
    //  directory tree as the AmigaDOS validator would.
    static open(buffer, options = {}) {
        if (!Buffer.isBuffer(buffer)) fail('EINVAL', 'image must be a Buffer');
        if (buffer.length < BSIZE * 4 || buffer.length % BSIZE !== 0) {
            fail('EINVAL', `not an AmigaDOS image: ${buffer.length} bytes`);
        }
        const vol = new AmigaVolume(buffer, options);
        vol._load();
        return vol;
    }

    static openFile(path, options = {}) {
        const vol = AmigaVolume.open(fs.readFileSync(path), options);
        vol.path = path;
        return vol;
    }

    //  A new blank image of `size` bytes (a whole number of 512-byte blocks),
    //  formatted; see format() for the options.
    static create(size, options = {}) {
        if (!Number.isInteger(size) || size <= 0 || size % BSIZE !== 0) {
            fail('EINVAL', `image size must be a whole number of ${BSIZE}-byte blocks`);
        }
        return AmigaVolume.format(Buffer.alloc(size), options);
    }

    //  Format `buffer` in place.
    //    name      volume name (default 'BBS')
    //    ffs       true (DOS\1, default) or false (OFS, DOS\0)
    //    intl      international mode (DOS\2 / DOS\3)
    //    date      creation date (default: now)
    //    bootCode  optional Buffer of up to 1012 bytes of bootblock code; the
    //              bootblock then gets a valid checksum. Without it the
    //              bootblock carries the DOS type and root pointer only, as
    //              xdftool writes it: a hard-disk partition boots through its
    //              file system, not its bootblock.
    static format(buffer, options = {}) {
        const numBlocks = buffer.length / BSIZE;
        if (!Number.isInteger(numBlocks) || numBlocks < 4) {
            fail(
                'EINVAL',
                `image too small: ${buffer.length} bytes (at least ${
                    4 * BSIZE
                } bytes, whole ${BSIZE}-byte blocks)`
            );
        }
        if (numBlocks > 0xffffffff) fail('EINVAL', 'image too large');
        const name = encodeName(
            options.name === undefined ? 'BBS' : options.name,
            'volume name'
        );
        const ffs = options.ffs !== false;
        const intl = !!options.intl;

        buffer.fill(0);
        const vol = new AmigaVolume(buffer, options);
        vol.numBlocks = numBlocks;
        vol.rootBlock = rootBlockFor(numBlocks);
        vol.flags = (ffs ? 1 : 0) | (intl ? 2 : 0);
        vol._setFlags();

        //  bootblock
        buffer.write('DOS', 0, 'latin1');
        buffer[3] = vol.flags;
        if (options.bootCode) {
            const code = options.bootCode;
            if (code.length > 2 * BSIZE - 12)
                fail('EINVAL', 'boot code longer than 1012 bytes');
            code.copy(buffer, 12);
        }
        buffer.writeUInt32BE(vol.rootBlock, 8);
        if (options.bootCode) {
            buffer.writeUInt32BE(bootChecksum(buffer), 4);
        }

        //  every block free, then the root and the bitmap blocks it needs
        vol.free = new Uint8Array(numBlocks).fill(1);
        vol.free[0] = vol.free[1] = 0;
        vol.free[vol.rootBlock] = 0;
        vol.allocHint = vol.rootBlock + 1;

        const nBitmap = Math.ceil((numBlocks - RESERVED) / BM_BITS);
        const nExt =
            nBitmap > BM_PAGES ? Math.ceil((nBitmap - BM_PAGES) / BM_EXT_PTRS) : 0;
        if (nBitmap + nExt + 1 > numBlocks - RESERVED) fail('EINVAL', 'image too small');
        vol.bitmapBlocks = vol._alloc(nBitmap);
        vol.bitmapExtBlocks = vol._alloc(nExt);

        const date = dateToAmiga(options.date || vol.now(), vol.utc);
        const r = vol.rootBlock;
        vol._u32(r, OFF.type, T_HEADER);
        vol._u32(r, 12, HT_SIZE);
        vol._u32(r, OFF.bmFlag, 0xffffffff);
        vol._writeBitmapPointers();
        vol._setDate(r, OFF.date, date);
        vol._setDate(r, OFF.volDate, date);
        vol._setDate(r, OFF.createDate, date);
        vol._setName(r, name);
        vol._s32(r, OFF.secType, ST_ROOT);
        vol._writeBitmap(true);
        vol._checksum(r);
        return vol;
    }

    _setFlags() {
        this.ffs = (this.flags & 1) === 1;
        this.dirCache = (this.flags & 4) === 4;
        this.intl = (this.flags & 2) === 2 || this.dirCache;
    }

    _load() {
        const buf = this.buf;
        const fileBlocks = buf.length / BSIZE;

        for (let i = 0; i < 16 && i < fileBlocks; i++) {
            if (buf.toString('latin1', i * BSIZE, i * BSIZE + 4) === 'RDSK') {
                fail(
                    'EUNSUPPORTED',
                    'image has a Rigid Disk Block (partitioned hard disk); only plain partitions are supported'
                );
            }
        }
        const magic = buf.toString('latin1', 0, 3);
        if (magic !== 'DOS') {
            const what = buf.toString('latin1', 0, 4).replace(/[^\x20-\x7e]/g, '.');
            fail(
                'EUNSUPPORTED',
                `not an AmigaDOS OFS/FFS volume (bootblock says "${what}")`
            );
        }
        this.flags = buf[3];
        if (this.flags > 5) {
            fail(
                'EUNSUPPORTED',
                `DOS\\${this.flags} volumes (long file names) are not supported`
            );
        }
        this._setFlags();

        //  The root sits in the middle of the partition. The image may be the
        //  partition exactly (the usual case), or the bootblock may say where
        //  the root is (xdftool and AmigaDOS both write it, AmigaDOS as 880).
        const candidates = [
            [fileBlocks, rootBlockFor(fileBlocks)],
            [
                32 * Math.floor(fileBlocks / 32),
                rootBlockFor(32 * Math.floor(fileBlocks / 32)),
            ],
        ];
        const fromBoot = buf.readUInt32BE(8);
        if (fromBoot > RESERVED && fromBoot < fileBlocks) {
            candidates.push([Math.min(fileBlocks, 2 * fromBoot), fromBoot]);
        }
        const found = candidates.find(
            ([n, r]) => n >= 4 && r < fileBlocks && this._isRoot(r)
        );
        if (!found)
            fail('ECORRUPT', 'no root block found: not an AmigaDOS volume, or damaged');
        [this.numBlocks, this.rootBlock] = found;

        //  bitmap block pointers
        const r = this.rootBlock;
        this.bitmapBlocks = [];
        this.bitmapExtBlocks = [];
        const nBitmap = Math.ceil((this.numBlocks - RESERVED) / BM_BITS);
        for (let i = 0; i < BM_PAGES && this.bitmapBlocks.length < nBitmap; i++) {
            const b = this._u32(r, OFF.bmPages + 4 * i);
            if (b === 0) break;
            this.bitmapBlocks.push(b);
        }
        let ext = this._u32(r, OFF.bmExt);
        const seen = new Set();
        while (ext !== 0 && this.bitmapBlocks.length < nBitmap) {
            this._checkBlockNum(ext, 'bitmap extension block');
            if (seen.has(ext)) fail('ECORRUPT', 'bitmap extension chain loops');
            seen.add(ext);
            this.bitmapExtBlocks.push(ext);
            for (let i = 0; i < BM_EXT_PTRS && this.bitmapBlocks.length < nBitmap; i++) {
                const b = this._u32(ext, 4 * i);
                if (b === 0) break;
                this.bitmapBlocks.push(b);
            }
            ext = this._u32(ext, BSIZE - 4);
        }
        this.bitmapBlocks.forEach(b => this._checkBlockNum(b, 'bitmap block'));

        const valid =
            this._u32(r, OFF.bmFlag) === 0xffffffff &&
            this.bitmapBlocks.length === nBitmap &&
            this.bitmapBlocks.every(b => this._sum(b, 0) === 0);
        if (valid) {
            this.free = new Uint8Array(this.numBlocks);
            for (let blk = RESERVED; blk < this.numBlocks; blk++) {
                const i = blk - RESERVED;
                const bmBlock = this.bitmapBlocks[Math.floor(i / BM_BITS)];
                const bit = i % BM_BITS;
                const word = this._u32(bmBlock, 4 + 4 * Math.floor(bit / 32));
                this.free[blk] = (word >>> (bit % 32)) & 1;
            }
            this.bitmapRebuilt = false;
        } else {
            //  AmigaDOS marks the bitmap invalid while it has writes pending;
            //  work out which blocks are in use from the tree instead
            this.free = this._usedFromTree().map(u => (u ? 0 : 1));
            this.free[0] = this.free[1] = 0;
            this.bitmapRebuilt = true;
            if (this.bitmapBlocks.length !== nBitmap) {
                //  cannot write a bitmap we cannot place
                this.readOnly = true;
            }
        }
        this.allocHint = this.rootBlock + 1;
    }

    _isRoot(blk) {
        return (
            this._u32(blk, OFF.type) === T_HEADER &&
            this._s32(blk, OFF.secType) === ST_ROOT &&
            this._sum(blk, OFF.checksum) === 0
        );
    }

    // ── raw block access ──

    _off(blk, off) {
        return blk * BSIZE + off;
    }

    _u32(blk, off, value) {
        if (value === undefined) return this.buf.readUInt32BE(this._off(blk, off));
        this.buf.writeUInt32BE(value >>> 0, this._off(blk, off));
    }

    _s32(blk, off, value) {
        if (value === undefined) return this.buf.readInt32BE(this._off(blk, off));
        this.buf.writeInt32BE(value, this._off(blk, off));
    }

    _block(blk) {
        return this.buf.subarray(blk * BSIZE, (blk + 1) * BSIZE);
    }

    //  sum of the block's longs (mod 2^32); 0 for a block with a good checksum
    _sum(blk) {
        let sum = 0;
        const base = blk * BSIZE;
        for (let i = 0; i < BSIZE; i += 4) {
            sum = (sum + this.buf.readUInt32BE(base + i)) >>> 0;
        }
        return sum;
    }

    _checksum(blk, at = OFF.checksum) {
        this._u32(blk, at, 0);
        this._u32(blk, at, (0x100000000 - this._sum(blk)) >>> 0);
    }

    _checkBlockNum(blk, what) {
        if (!Number.isInteger(blk) || blk < RESERVED || blk >= this.numBlocks) {
            fail('ECORRUPT', `${what} points outside the volume (block ${blk})`);
        }
    }

    _header(blk, what = 'header block') {
        this._checkBlockNum(blk, what);
        if (this._u32(blk, OFF.type) !== T_HEADER || this._sum(blk) !== 0) {
            fail('ECORRUPT', `block ${blk} is not a valid ${what}`);
        }
        return blk;
    }

    _getDate(blk, off) {
        return {
            days: this._u32(blk, off),
            mins: this._u32(blk, off + 4),
            ticks: this._u32(blk, off + 8),
        };
    }

    _setDate(blk, off, d) {
        this._u32(blk, off, d.days);
        this._u32(blk, off + 4, d.mins);
        this._u32(blk, off + 8, d.ticks);
    }

    _getNameBuf(blk) {
        const len = Math.min(this.buf[this._off(blk, OFF.name)], MAX_NAME);
        const start = this._off(blk, OFF.name + 1);
        return this.buf.subarray(start, start + len);
    }

    _setName(blk, nameBuf) {
        const off = this._off(blk, OFF.name);
        this.buf.fill(0, off, off + 1 + MAX_NAME);
        this.buf[off] = nameBuf.length;
        nameBuf.copy(this.buf, off + 1);
    }

    _getComment(blk) {
        const len = Math.min(this.buf[this._off(blk, OFF.comment)], MAX_COMMENT);
        const start = this._off(blk, OFF.comment + 1);
        return this.buf.toString('latin1', start, start + len);
    }

    _setComment(blk, commentBuf) {
        const off = this._off(blk, OFF.comment);
        this.buf.fill(0, off, off + 1 + MAX_COMMENT);
        this.buf[off] = commentBuf.length;
        commentBuf.copy(this.buf, off + 1);
    }

    // ── bitmap ──

    _alloc(count) {
        const out = [];
        if (count === 0) return out;
        const n = this.numBlocks;
        let blk = this.allocHint < n ? this.allocHint : RESERVED;
        for (let scanned = 0; scanned < n && out.length < count; scanned++) {
            if (this.free[blk]) {
                this._setFree(blk, 0);
                out.push(blk);
            }
            blk = blk + 1 < n ? blk + 1 : RESERVED;
        }
        if (out.length < count) {
            out.forEach(b => this._setFree(b, 1));
            fail('ENOSPC', 'volume full');
        }
        this.allocHint = blk;
        return out;
    }

    _setFree(blk, free) {
        this.free[blk] = free;
        this.dirtyPages.add(Math.floor((blk - RESERVED) / BM_BITS));
    }

    _release(blocks) {
        for (const b of blocks) {
            this.buf.fill(0, b * BSIZE, (b + 1) * BSIZE);
            this._setFree(b, 1);
        }
    }

    freeBlocks() {
        let n = 0;
        for (let b = RESERVED; b < this.numBlocks; b++) n += this.free[b];
        return n;
    }

    _writeBitmapPointers() {
        const r = this.rootBlock;
        for (let i = 0; i < BM_PAGES; i++) {
            this._u32(r, OFF.bmPages + 4 * i, this.bitmapBlocks[i] || 0);
        }
        this._u32(r, OFF.bmExt, this.bitmapExtBlocks[0] || 0);
        let next = BM_PAGES;
        this.bitmapExtBlocks.forEach((ext, i) => {
            this.buf.fill(0, ext * BSIZE, (ext + 1) * BSIZE);
            for (let j = 0; j < BM_EXT_PTRS && next < this.bitmapBlocks.length; j++) {
                this._u32(ext, 4 * j, this.bitmapBlocks[next++]);
            }
            this._u32(ext, BSIZE - 4, this.bitmapExtBlocks[i + 1] || 0);
        });
    }

    _writeBitmap(all = false) {
        //  bits past the last block stay clear (in use), as ADFlib leaves them
        this.bitmapBlocks.forEach((bm, page) => {
            if (!all && !this.dirtyPages.has(page)) return;
            this.buf.fill(0, bm * BSIZE, (bm + 1) * BSIZE);
            const first = RESERVED + page * BM_BITS;
            const last = Math.min(first + BM_BITS, this.numBlocks);
            for (let blk = first; blk < last; blk += 32) {
                let word = 0;
                for (let b = 0; b < 32 && blk + b < last; b++) {
                    if (this.free[blk + b]) word |= 1 << b;
                }
                this._u32(bm, 4 + 4 * ((blk - first) / 32), word);
            }
            this._checksum(bm, 0);
        });
        this.dirtyPages.clear();
    }

    //  Blocks reachable from the root: the structure, as the validator sees it.
    //  Returns a Uint8Array, 1 = in use.
    _usedFromTree() {
        const used = new Uint8Array(this.numBlocks);
        used[0] = used[1] = 1;
        const mark = (blk, what) => {
            this._checkBlockNum(blk, what);
            if (used[blk]) fail('ECORRUPT', `block ${blk} (${what}) is used twice`);
            used[blk] = 1;
        };
        mark(this.rootBlock, 'root block');
        this.bitmapBlocks.forEach(b => mark(b, 'bitmap block'));
        this.bitmapExtBlocks.forEach(b => mark(b, 'bitmap extension block'));

        const walkDir = dirBlk => {
            if (this.dirCache) {
                //  directory cache blocks: chained through next_dirc (offset 16)
                let dc = this._u32(dirBlk, OFF.extension);
                while (dc !== 0) {
                    mark(dc, 'directory cache block');
                    dc = this._u32(dc, OFF.firstData);
                }
            }
            for (const blk of this._dirBlocks(dirBlk)) {
                mark(blk, 'header block');
                const sec = this._s32(blk, OFF.secType);
                if (sec === ST_USERDIR) {
                    walkDir(blk);
                } else if (sec === ST_FILE) {
                    const { data, ext } = this._fileBlocks(blk);
                    ext.forEach(b => mark(b, 'file extension block'));
                    data.forEach(b => mark(b, 'data block'));
                }
            }
        };
        walkDir(this.rootBlock);
        return used;
    }

    // ── directories ──

    //  Header blocks in a directory, in hash-table order
    _dirBlocks(dirBlk) {
        const out = [];
        const seen = new Set();
        for (let i = 0; i < HT_SIZE; i++) {
            let blk = this._u32(dirBlk, OFF.table + 4 * i);
            while (blk !== 0) {
                if (seen.has(blk))
                    fail('ECORRUPT', `hash chain loops in directory block ${dirBlk}`);
                seen.add(blk);
                this._header(blk);
                out.push(blk);
                blk = this._u32(blk, OFF.hashChain);
            }
        }
        return out;
    }

    //  The entry named nameBuf in dirBlk: { blk, prev } (prev 0 = hash slot) or null
    _findInDir(dirBlk, nameBuf) {
        const slot = hashName(nameBuf, this.intl);
        let prev = 0;
        let blk = this._u32(dirBlk, OFF.table + 4 * slot);
        let guard = 0;
        while (blk !== 0) {
            this._header(blk);
            if (namesEqual(this._getNameBuf(blk), nameBuf, this.intl)) {
                return { blk, prev, slot };
            }
            if (++guard > this.numBlocks) fail('ECORRUPT', 'hash chain loops');
            prev = blk;
            blk = this._u32(blk, OFF.hashChain);
        }
        return null;
    }

    _isDirBlock(blk) {
        const sec = this._s32(blk, OFF.secType);
        return sec === ST_ROOT || sec === ST_USERDIR;
    }

    //  A hard link's real entry; anything else is itself
    _resolve(blk) {
        const sec = this._s32(blk, OFF.secType);
        if (sec === ST_LINKFILE || sec === ST_LINKDIR) {
            return this._header(this._u32(blk, OFF.realEntry), 'hard link target');
        }
        return blk;
    }

    //  path -> header block (links resolved for the directories on the way)
    _lookup(p, { resolveLast = true } = {}) {
        let blk = this.rootBlock;
        const parts = splitPath(p);
        parts.forEach((part, i) => {
            if (!this._isDirBlock(blk)) {
                fail('ENOTDIR', `not a directory: ${parts.slice(0, i).join('/')}`);
            }
            const found = this._findInDir(blk, Buffer.from(part, 'latin1'));
            if (!found)
                fail(
                    'ENOENT',
                    `no such file or directory: ${parts.slice(0, i + 1).join('/')}`
                );
            blk =
                i < parts.length - 1 || resolveLast
                    ? this._resolve(found.blk)
                    : found.blk;
        });
        return blk;
    }

    _linkIntoDir(dirBlk, blk, nameBuf) {
        //  FFS keeps each hash chain sorted by block number; AmigaDOS reads
        //  any order, so do the same for OFS
        const slot = hashName(nameBuf, this.intl);
        const slotOff = OFF.table + 4 * slot;
        let next = this._u32(dirBlk, slotOff);
        if (next === 0 || next > blk) {
            this._u32(blk, OFF.hashChain, next);
            this._u32(dirBlk, slotOff, blk);
        } else {
            let prev = next;
            while ((next = this._u32(prev, OFF.hashChain)) !== 0 && next < blk)
                prev = next;
            this._u32(blk, OFF.hashChain, next);
            this._u32(prev, OFF.hashChain, blk);
            this._checksum(prev);
        }
        this._checksum(blk);
        this._touchDir(dirBlk);
    }

    _unlinkFromDir(dirBlk, found) {
        const next = this._u32(found.blk, OFF.hashChain);
        if (found.prev === 0) {
            this._u32(dirBlk, OFF.table + 4 * found.slot, next);
        } else {
            this._u32(found.prev, OFF.hashChain, next);
            this._checksum(found.prev);
        }
        this._touchDir(dirBlk);
    }

    _touchDir(dirBlk) {
        this._setDate(dirBlk, OFF.date, dateToAmiga(this.now(), this.utc));
        this._checksum(dirBlk);
    }

    // ── files ──

    //  data and extension block numbers of a file header, in order
    _fileBlocks(hdr) {
        const data = [];
        const ext = [];
        const seen = new Set();
        const take = (blk, what) => {
            const count = Math.min(this._u32(blk, OFF.highSeq), HT_SIZE);
            for (let i = 0; i < count; i++) {
                const d = this._u32(blk, OFF.table + 4 * (HT_SIZE - 1 - i));
                this._checkBlockNum(d, `data block pointer in ${what} ${blk}`);
                data.push(d);
            }
        };
        take(hdr, 'file header');
        let e = this._u32(hdr, OFF.extension);
        while (e !== 0) {
            this._checkBlockNum(e, 'file extension block');
            if (seen.has(e)) fail('ECORRUPT', `extension chain of block ${hdr} loops`);
            seen.add(e);
            if (this._u32(e, OFF.type) !== T_LIST || this._sum(e) !== 0) {
                fail('ECORRUPT', `block ${e} is not a valid file extension block`);
            }
            ext.push(e);
            take(e, 'extension block');
            e = this._u32(e, OFF.extension);
        }
        return { data, ext };
    }

    _readFileBlock(hdr) {
        const size = this._u32(hdr, OFF.byteSize);
        const { data } = this._fileBlocks(hdr);
        const out = Buffer.alloc(size);
        let pos = 0;
        for (const blk of data) {
            if (pos >= size) break;
            if (this.ffs) {
                const n = Math.min(BSIZE, size - pos);
                this.buf.copy(out, pos, blk * BSIZE, blk * BSIZE + n);
                pos += n;
            } else {
                if (this._u32(blk, OFF.type) !== T_DATA || this._sum(blk) !== 0) {
                    fail('ECORRUPT', `block ${blk} is not a valid OFS data block`);
                }
                const n = Math.min(this._u32(blk, OFF.dataSize), OFS_PAYLOAD, size - pos);
                this.buf.copy(out, pos, blk * BSIZE + 24, blk * BSIZE + 24 + n);
                pos += n;
            }
        }
        if (pos < size) fail('ECORRUPT', `file at block ${hdr} is shorter than its size`);
        return out;
    }

    _writeFileBlocks(hdr, data, blocks, counts) {
        //  blocks: [ext..., data...] after the header
        const extBlocks = blocks.slice(0, counts.ext);
        const dataBlocks = blocks.slice(counts.ext);
        const per = this.ffs ? BSIZE : OFS_PAYLOAD;

        dataBlocks.forEach((blk, i) => {
            const start = i * per;
            const chunk = data.subarray(start, Math.min(start + per, data.length));
            this.buf.fill(0, blk * BSIZE, (blk + 1) * BSIZE);
            if (this.ffs) {
                chunk.copy(this.buf, blk * BSIZE);
            } else {
                this._u32(blk, OFF.type, T_DATA);
                this._u32(blk, OFF.headerKey, hdr);
                this._u32(blk, OFF.highSeq, i + 1); // seq_num
                this._u32(blk, OFF.dataSize, chunk.length);
                this._u32(blk, OFF.firstData, dataBlocks[i + 1] || 0); // next_data
                chunk.copy(this.buf, blk * BSIZE + 24);
                this._checksum(blk);
            }
        });

        //  pointer tables: header gets the first 72, each extension block 72 more
        const tables = [hdr, ...extBlocks];
        tables.forEach((tbl, t) => {
            const ptrs = dataBlocks.slice(t * HT_SIZE, (t + 1) * HT_SIZE);
            for (let i = 0; i < HT_SIZE; i++) {
                this._u32(tbl, OFF.table + 4 * (HT_SIZE - 1 - i), ptrs[i] || 0);
            }
            this._u32(tbl, OFF.highSeq, ptrs.length);
            if (t > 0) {
                this._u32(tbl, OFF.type, T_LIST);
                this._u32(tbl, OFF.headerKey, tbl);
                this._u32(tbl, OFF.parent, hdr);
                this._u32(tbl, OFF.extension, extBlocks[t] || 0);
                this._s32(tbl, OFF.secType, ST_FILE);
                this._checksum(tbl);
            }
        });
        this._u32(hdr, OFF.firstData, dataBlocks[0] || 0);
        this._u32(hdr, OFF.extension, extBlocks[0] || 0);
        this._u32(hdr, OFF.byteSize, data.length);
    }

    // ── mutation bookkeeping ──

    _writable() {
        if (this.readOnly) fail('EROFS', 'volume is read-only');
        if (this.dirCache) {
            fail('EROFS', 'directory-cache (DOS\\4, DOS\\5) volumes are read-only here');
        }
    }

    //  Write the bitmap and the root's volume date after a change
    _commit() {
        const r = this.rootBlock;
        this._writeBitmap(this.bitmapRebuilt);
        this._u32(r, OFF.bmFlag, 0xffffffff);
        this._setDate(r, OFF.volDate, dateToAmiga(this.now(), this.utc));
        this._checksum(r);
        this.bitmapRebuilt = false;
        this.dirty = true;
    }

    _newHeader(blk, parentBlk, nameBuf, secType, options) {
        this.buf.fill(0, blk * BSIZE, (blk + 1) * BSIZE);
        this._u32(blk, OFF.type, T_HEADER);
        this._u32(blk, OFF.headerKey, blk);
        this._u32(
            blk,
            OFF.protect,
            options.protection === undefined ? 0 : parseProtection(options.protection)
        );
        this._setComment(blk, encodeComment(options.comment));
        this._setDate(blk, OFF.date, dateToAmiga(options.date || this.now(), this.utc));
        this._setName(blk, nameBuf);
        this._u32(blk, OFF.parent, parentBlk);
        this._s32(blk, OFF.secType, secType);
    }

    //  mkdir -p: returns the directory's block
    _mkdirs(parts, options = {}) {
        let blk = this.rootBlock;
        parts.forEach((part, i) => {
            const nameBuf = encodeName(part);
            const found = this._findInDir(blk, nameBuf);
            if (found) {
                const real = this._resolve(found.blk);
                if (!this._isDirBlock(real)) {
                    fail(
                        'ENOTDIR',
                        `not a directory: ${parts.slice(0, i + 1).join('/')}`
                    );
                }
                blk = real;
                return;
            }
            const [dirBlk] = this._alloc(1);
            this._newHeader(
                dirBlk,
                blk,
                nameBuf,
                ST_USERDIR,
                i === parts.length - 1 ? options : {}
            );
            this._linkIntoDir(blk, dirBlk, nameBuf);
            blk = dirBlk;
        });
        return blk;
    }

    _entry(blk, parentPath) {
        const name = this._getNameBuf(blk).toString('latin1');
        const sec = this._s32(blk, OFF.secType);
        const path = parentPath ? `${parentPath}/${name}` : name;
        const e = {
            name,
            path,
            type: 'file',
            size: 0,
            protection: this._u32(blk, OFF.protect),
            protectionString: protectionToString(this._u32(blk, OFF.protect)),
            amigaDate: this._getDate(blk, OFF.date),
            comment: this._getComment(blk),
            block: blk,
        };
        e.date = amigaToDate(e.amigaDate, this.utc);
        if (sec === ST_USERDIR) {
            e.type = 'dir';
        } else if (sec === ST_FILE) {
            e.size = this._u32(blk, OFF.byteSize);
        } else if (sec === ST_SOFTLINK) {
            e.type = 'softlink';
            const start = this._off(blk, OFF.table);
            const end = this.buf.indexOf(0, start);
            e.target = this.buf.toString(
                'latin1',
                start,
                Math.min(end < 0 ? start : end, start + BSIZE - 224)
            );
        } else if (sec === ST_LINKFILE || sec === ST_LINKDIR) {
            const real = this._resolve(blk);
            e.type = sec === ST_LINKDIR ? 'dir' : 'file';
            e.hardLink = true;
            e.size = sec === ST_LINKFILE ? this._u32(real, OFF.byteSize) : 0;
            e.realBlock = real;
        } else {
            fail('ECORRUPT', `block ${blk} has an unknown secondary type ${sec}`);
        }
        return e;
    }

    // ── public API: reading ──

    get name() {
        return this._getNameBuf(this.rootBlock).toString('latin1');
    }

    get dosType() {
        return `DOS${this.flags}`;
    }

    get size() {
        return this.numBlocks * BSIZE;
    }

    info() {
        const r = this.rootBlock;
        const free = this.freeBlocks();
        const bootSum = this.buf.readUInt32BE(4);
        return {
            name: this.name,
            dosType: this.dosType,
            fileSystem: this.ffs ? 'FFS' : 'OFS',
            international: this.intl,
            dirCache: this.dirCache,
            blockSize: BSIZE,
            blocks: this.numBlocks,
            bytes: this.numBlocks * BSIZE,
            rootBlock: r,
            usedBlocks: this.numBlocks - free,
            freeBlocks: free,
            freeBytes: free * (this.ffs ? BSIZE : OFS_PAYLOAD),
            bootBlockChecksum: bootSum !== 0 && bootSum === bootChecksum(this.buf),
            bitmapRebuilt: !!this.bitmapRebuilt,
            created: amigaToDate(this._getDate(r, OFF.createDate), this.utc),
            modified: amigaToDate(this._getDate(r, OFF.volDate), this.utc),
            rootModified: amigaToDate(this._getDate(r, OFF.date), this.utc),
        };
    }

    exists(p) {
        try {
            this._lookup(p);
            return true;
        } catch (e) {
            if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false;
            throw e;
        }
    }

    stat(p) {
        const parts = splitPath(p);
        if (parts.length === 0) {
            const r = this.rootBlock;
            const amigaDate = this._getDate(r, OFF.date);
            return {
                name: this.name,
                path: '',
                type: 'dir',
                size: 0,
                protection: 0,
                protectionString: protectionToString(0),
                amigaDate,
                date: amigaToDate(amigaDate, this.utc),
                comment: '',
                block: r,
                volume: true,
            };
        }
        const blk = this._lookup(p, { resolveLast: false });
        return this._entry(blk, parts.slice(0, -1).join('/'));
    }

    //  Entries of a directory, sorted by name (case-insensitive); with
    //  { recursive: true } each directory is followed by its contents.
    list(p = '', options = {}) {
        const dirBlk = this._lookup(p);
        if (!this._isDirBlock(dirBlk)) fail('ENOTDIR', `not a directory: ${p}`);
        const base = splitPath(p).join('/');
        const out = [];
        const walk = (blk, prefix, depth) => {
            const entries = this._dirBlocks(blk).map(b => this._entry(b, prefix));
            entries.sort((a, b) => compareNames(a.name, b.name, this.intl));
            for (const e of entries) {
                out.push(e);
                if (options.recursive && e.type === 'dir' && !e.hardLink && depth < 64) {
                    walk(e.block, e.path, depth + 1);
                }
            }
        };
        walk(dirBlk, base, 0);
        return out;
    }

    readFile(p) {
        const blk = this._lookup(p);
        const sec = this._s32(blk, OFF.secType);
        if (sec === ST_USERDIR || sec === ST_ROOT) fail('EISDIR', `is a directory: ${p}`);
        if (sec !== ST_FILE) fail('EINVAL', `not a file: ${p}`);
        return this._readFileBlock(blk);
    }

    //  Check the volume's structure: every reachable block in range and used
    //  once, the bitmap agreeing with the tree. Returns a list of problems.
    check() {
        const problems = [];
        let used;
        try {
            used = this._usedFromTree();
        } catch (e) {
            return [e.message];
        }
        for (let b = RESERVED; b < this.numBlocks; b++) {
            if (used[b] && this.free[b])
                problems.push(`block ${b} is in use but marked free`);
            if (!used[b] && !this.free[b])
                problems.push(`block ${b} is marked used but unused`);
        }
        return problems;
    }

    // ── public API: writing ──

    //  mkdir -p. Options: date, protection, comment (for the last component).
    mkdir(p, options = {}) {
        this._writable();
        const parts = splitPath(p);
        if (parts.length === 0) return this;
        this._mkdirs(parts, options);
        this._commit();
        return this;
    }

    //  Write (or replace) a file; missing parent directories are made.
    //  Options: date (default now), protection (default 0, '----rwed'), comment.
    writeFile(p, data, options = {}) {
        this._writable();
        if (typeof data === 'string') data = Buffer.from(data, 'latin1');
        if (!Buffer.isBuffer(data)) data = Buffer.from(data);
        const parts = splitPath(p);
        if (parts.length === 0) fail('EISDIR', 'cannot write to the root directory');
        const nameBuf = encodeName(parts[parts.length - 1]);
        encodeComment(options.comment);
        if (options.protection !== undefined) parseProtection(options.protection);

        //  space check first so that a full volume changes nothing
        const counts = blocksNeededForFile(data.length, this.ffs);
        let existing = null;
        let dirBlk = this.rootBlock;
        let missingDirs = 0;
        try {
            dirBlk = this._lookup(parts.slice(0, -1).join('/'));
            if (!this._isDirBlock(dirBlk))
                fail('ENOTDIR', `not a directory: ${parts.slice(0, -1).join('/')}`);
            existing = this._findInDir(dirBlk, nameBuf);
        } catch (e) {
            if (e.code !== 'ENOENT') throw e;
            //  count the directories mkdir -p would add
            let blk = this.rootBlock;
            for (let i = 0; i < parts.length - 1; i++) {
                const f = this._findInDir(blk, encodeName(parts[i]));
                if (!f) {
                    missingDirs = parts.length - 1 - i;
                    break;
                }
                blk = this._resolve(f.blk);
            }
        }
        let reclaim = 0;
        if (existing) {
            const sec = this._s32(existing.blk, OFF.secType);
            if (sec !== ST_FILE) {
                fail(
                    sec === ST_USERDIR ? 'EISDIR' : 'EEXIST',
                    `exists and is not a plain file: ${p}`
                );
            }
            if (options.overwrite === false) fail('EEXIST', `file exists: ${p}`);
            const old = this._fileBlocks(existing.blk);
            reclaim = 1 + old.data.length + old.ext.length;
        }
        if (counts.total + missingDirs > this.freeBlocks() + reclaim) {
            fail(
                'ENOSPC',
                `volume full: ${p} needs ${counts.total} blocks, ${this.freeBlocks() + reclaim} free`
            );
        }

        if (existing) this._deleteEntry(dirBlk, existing);
        if (missingDirs) dirBlk = this._mkdirs(parts.slice(0, -1));

        const [hdr, ...rest] = this._alloc(counts.total);
        this._newHeader(hdr, dirBlk, nameBuf, ST_FILE, options);
        this._writeFileBlocks(hdr, data, rest, counts);
        this._linkIntoDir(dirBlk, hdr, nameBuf);
        this._commit();
        return this;
    }

    setProtection(p, protection) {
        return this._modifyHeader(p, blk =>
            this._u32(blk, OFF.protect, parseProtection(protection))
        );
    }

    setDate(p, date) {
        const d = dateToAmiga(date, this.utc);
        return this._modifyHeader(p, blk => this._setDate(blk, OFF.date, d));
    }

    setComment(p, comment) {
        const c = encodeComment(comment);
        return this._modifyHeader(p, blk => this._setComment(blk, c));
    }

    setVolumeName(name) {
        this._writable();
        this._setName(this.rootBlock, encodeName(name, 'volume name'));
        this._commit();
        return this;
    }

    _modifyHeader(p, fn) {
        this._writable();
        if (splitPath(p).length === 0) fail('EINVAL', 'not for the root directory');
        const blk = this._lookup(p, { resolveLast: false });
        fn(blk);
        this._checksum(blk);
        this._commit();
        return this;
    }

    //  Delete a file, link or empty directory; { recursive: true } for a tree.
    delete(p, options = {}) {
        this._writable();
        const parts = splitPath(p);
        if (parts.length === 0) fail('EINVAL', 'cannot delete the root directory');
        const dirBlk = this._lookup(parts.slice(0, -1).join('/'));
        if (!this._isDirBlock(dirBlk))
            fail('ENOTDIR', `not a directory: ${parts.slice(0, -1).join('/')}`);
        const found = this._findInDir(
            dirBlk,
            Buffer.from(parts[parts.length - 1], 'latin1')
        );
        if (!found) fail('ENOENT', `no such file or directory: ${parts.join('/')}`);
        if (this._s32(found.blk, OFF.secType) === ST_USERDIR && !options.recursive) {
            if (this._dirBlocks(found.blk).length > 0) {
                fail('ENOTEMPTY', `directory not empty: ${parts.join('/')}`);
            }
        }
        this._deleteEntry(dirBlk, found);
        this._commit();
        return this;
    }

    _deleteEntry(dirBlk, found) {
        const blk = found.blk;
        const sec = this._s32(blk, OFF.secType);
        if (
            (sec === ST_FILE || sec === ST_USERDIR) &&
            this._u32(blk, OFF.nextLink) !== 0
        ) {
            fail(
                'EUNSUPPORTED',
                `${this._getNameBuf(blk).toString('latin1')} has hard links; delete them first`
            );
        }
        if (sec === ST_USERDIR) {
            for (const child of this._dirBlocks(blk)) {
                this._deleteEntry(blk, this._findInDir(blk, this._getNameBuf(child)));
            }
        }
        if (sec === ST_LINKFILE || sec === ST_LINKDIR) {
            //  take it out of its real entry's chain of links
            let prev = this._u32(blk, OFF.realEntry);
            let guard = 0;
            while (this._u32(prev, OFF.nextLink) !== blk) {
                prev = this._u32(prev, OFF.nextLink);
                if (prev === 0 || ++guard > this.numBlocks)
                    fail('ECORRUPT', 'hard link chain is broken');
            }
            this._u32(prev, OFF.nextLink, this._u32(blk, OFF.nextLink));
            this._checksum(prev);
        }
        this._unlinkFromDir(dirBlk, found);
        const release = [blk];
        if (sec === ST_FILE) {
            const { data, ext } = this._fileBlocks(blk);
            for (const b of data) release.push(b);
            for (const b of ext) release.push(b);
        }
        this._release(release);
    }

    // ── output ──

    toBuffer() {
        return this.buf;
    }

    //  Write the image to `path` (default: the file it was opened from)
    save(path = this.path) {
        if (!path) fail('EINVAL', 'no path to save to');
        fs.writeFileSync(path, this.buf);
        this.dirty = false;
        return this;
    }
}

//  Bootblock checksum: a sum with end-around carry over the first 1024 bytes,
//  inverted (ADF FAQ 5.2)
function bootChecksum(buf) {
    let sum = 0;
    for (let i = 0; i < 2 * BSIZE; i += 4) {
        if (i === 4) continue;
        sum += buf.readUInt32BE(i);
        if (sum > 0xffffffff) sum -= 0xffffffff;
    }
    return ~sum >>> 0;
}

module.exports = {
    AmigaVolume,
    AmigaFsError,
    BSIZE,
    hashName: (name, intl = false) => hashName(Buffer.from(name, 'latin1'), intl),
    rootBlockFor,
    protectionToString,
    parseProtection,
    dateToAmiga,
    amigaToDate,
    splitPath,
    bootChecksum,
};
